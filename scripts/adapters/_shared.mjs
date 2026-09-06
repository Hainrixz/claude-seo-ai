// Shared plumbing for the API write adapters (wordpress-rest, wordpress-wpcli, page-api + its five
// providers). Not an adapter itself — it exports no `main`, and nothing here talks to the network
// on its own.
//
// What lives here is the part every remote adapter would otherwise reimplement eight times:
//   * which SEO field a finding is about, and what value the report actually carries for it
//     (`fix_preview` or a `--answers` entry — never a value this module invents);
//   * grouping findings by the page they belong to;
//   * a readable, redacted preview body for a request or a shell command;
//   * the public-URL re-check with a cache-buster that turns "the API says yes, the HTML says no"
//     into `pending_cache` instead of a false pass.

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  canTransition as canTransitionSafe,
  ensureConfirmed as ensureConfirmedChange,
  redactCommand,
  transition as transitionChange,
} from '../lib/adapter.mjs';
import { decodeEntities } from '../lib/entities.mjs';
import { makeHttp } from '../lib/http.mjs';
import { redact, redactObject } from '../lib/credentials.mjs';
import { readJson, writeJson, writeText } from '../lib/store.mjs';

/**
 * Is `name` an executable file on PATH? A filesystem probe, so a `capabilities` op can report a
 * tool honestly without spawning it — a hard-coded `true` there is a fabricated capability claim.
 * @returns {string|null} the full path, or null when the binary is not on PATH
 */
export function whichOnPath(name, env = process.env) {
  const path = env && typeof env.PATH === 'string' ? env.PATH : '';
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of path.split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try { if (statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
    }
  }
  return null;
}

/** The SEO fields these adapters know how to carry from a finding to a platform field. */
export const SEO_FIELDS = Object.freeze([
  'title', 'description', 'og_title', 'og_description', 'og_image',
  'twitter_title', 'twitter_description', 'canonical', 'robots', 'alt', 'excerpt', 'slug', 'jsonld',
]);

/** Query parameter appended when re-reading a public URL, so a CDN cannot answer from its cache. */
export const CACHE_BUSTER = 'claude_seo_ai_cb';

const META_FIELDS = Object.freeze({
  description: 'description',
  'og:title': 'og_title',
  'og:description': 'og_description',
  'og:image': 'og_image',
  'twitter:title': 'twitter_title',
  'twitter:description': 'twitter_description',
  robots: 'robots',
});

/** Read one attribute out of a single tag, quoted or not (apostrophes inside values survive). */
export function attrOf(tag, name) {
  const re = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i');
  const m = re.exec(String(tag || ''));
  if (!m) return null;
  const raw = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
  return decodeEntities(String(raw));
}

/**
 * Which SEO field a finding is about, from its id and title. `null` when the finding is not a
 * field-level fix (a redirect, a sitemap, a crawl-control rule) — those belong to other adapters.
 */
export function fieldForFinding(finding) {
  const id = String((finding && finding.id) || '').toLowerCase();
  const hay = id + ' ' + String((finding && finding.title) || '').toLowerCase();
  if (/og[_.:]image|twitter[_.:]image|image[_.:]?card/.test(hay)) return 'og_image';
  if (/og[_.:]title/.test(hay)) return 'og_title';
  if (/og[_.:]desc/.test(hay)) return 'og_description';
  if (/twitter[_.:]title/.test(hay)) return 'twitter_title';
  if (/twitter[_.:]desc/.test(hay)) return 'twitter_description';
  if (/\balt(_text)?\b|alt text|texto alternativo/.test(hay) || /^m9\./.test(id)) return 'alt';
  if (/json-?ld|structured[_ ]data|schema/.test(hay) || /^m5\./.test(id)) return 'jsonld';
  if (/canonical/.test(hay)) return 'canonical';
  if (/excerpt/.test(hay)) return 'excerpt';
  if (/\bslug\b/.test(hay)) return 'slug';
  if (/description|snippet|meta[_ ]desc/.test(hay)) return 'description';
  if (/\btitle\b|titulo|título/.test(hay)) return 'title';
  if (/noindex|robots/.test(hay)) return 'robots';
  return null;
}

/**
 * Pull SEO field values out of a snippet (what a finding's `fix_preview` holds).
 * A snippet with no markup comes back as `{ _raw }` so the caller can assign it to the field the
 * finding is about. Nothing is guessed: a value is returned only when it is written in the text.
 */
export function parseSeoPreview(text) {
  const s = String(text == null ? '' : text);
  const out = {};
  if (!s.trim()) return out;

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s);
  if (title) out.title = decodeEntities(title[1].trim());

  for (const m of s.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = String(attrOf(tag, 'name') || attrOf(tag, 'property') || '').toLowerCase();
    const field = META_FIELDS[key];
    if (!field) continue;
    const content = attrOf(tag, 'content');
    if (content !== null) out[field] = content;
  }

  for (const m of s.matchAll(/<link\b[^>]*>/gi)) {
    const rel = String(attrOf(m[0], 'rel') || '').toLowerCase();
    if (rel.split(/\s+/).includes('canonical')) {
      const href = attrOf(m[0], 'href');
      if (href !== null) out.canonical = href;
    }
  }

  const ld = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json[^>]*>([\s\S]*?)<\/script>/i.exec(s);
  if (ld) out.jsonld = ld[1].trim();

  for (const m of s.matchAll(/<img\b[^>]*>/gi)) {
    const alt = attrOf(m[0], 'alt');
    if (alt !== null && alt !== '') { out.alt = alt; break; }
  }

  if (!Object.keys(out).length && !s.includes('<')) out._raw = s.trim();
  return out;
}

/**
 * The values a finding actually carries, from `--answers` first and `fix_preview` second.
 * @returns {{field: string|null, values: object, source: 'answers'|'fix_preview'|null}}
 */
export function valuesForFinding(finding, answers = {}) {
  const field = fieldForFinding(finding);
  const answer = answers ? answers[finding.id] : undefined;

  if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
    const picked = {};
    for (const key of SEO_FIELDS) if (typeof answer[key] === 'string' && answer[key].trim()) picked[key] = answer[key];
    if (Object.keys(picked).length) return { field, values: picked, source: 'answers' };
  }

  const answerText = typeof answer === 'string' ? answer
    : (answer && typeof answer === 'object' && typeof answer.value === 'string' ? answer.value : null);
  const source = answerText !== null ? 'answers'
    : (typeof finding.fix_preview === 'string' && finding.fix_preview.trim() ? 'fix_preview' : null);
  if (!source) return { field, values: {}, source: null };

  const parsed = parseSeoPreview(answerText !== null ? answerText : finding.fix_preview);
  if (parsed._raw !== undefined) {
    return field ? { field, values: { [field]: parsed._raw }, source } : { field, values: {}, source };
  }
  delete parsed._raw;
  return { field, values: parsed, source };
}

/** Does this finding match the requested `--category` (module id, axis, fixable class or scope)? */
export function matchesCategory(finding, category) {
  if (!category) return true;
  const wanted = (Array.isArray(category) ? category : [category]).map((c) => String(c).toLowerCase().trim()).filter(Boolean);
  if (!wanted.length) return true;
  const axis = finding.expected_impact && finding.expected_impact.axis ? String(finding.expected_impact.axis) : '';
  const values = new Set([
    String(finding.module || '').toLowerCase(),
    String(finding.id || '').split('.')[0].toLowerCase(),
    axis.toLowerCase(),
    String(finding.fixable || '').toLowerCase(),
    String(finding.scope || '').toLowerCase(),
  ]);
  if (axis === 'both') { values.add('search'); values.add('ai'); }
  return wanted.some((w) => values.has(w));
}

/**
 * The note an adapter owes the user when `--include-proposed` was not passed: which findings it
 * never even looked at, and how to get them planned. Without this the drop is silent, and a plan
 * that says "2 changes" over a report of thirty findings reads as if the rest were fine.
 * @returns {string|null} null when nothing was held back
 */
export function withheldProposedNote(findings, { includeProposed = false, category = null } = {}) {
  if (includeProposed !== false) return null;
  const held = (Array.isArray(findings) ? findings : []).filter(
    (f) => f && (f.status === 'fail' || f.status === 'warn') && f.fixable === 'proposed' && matchesCategory(f, category),
  );
  if (!held.length) return null;
  return held.length + ' finding(s) are classed "proposed" — their wording needs a human to approve it — so they were left out: '
    + held.map((f) => f.id).join(', ') + '. Re-run with --include-proposed to plan them.';
}

/** Findings a remote write adapter may act on at all (advisory ones never reach an API). */
export function writableFindings(findings, { includeProposed = true, category = null } = {}) {
  return (Array.isArray(findings) ? findings : []).filter((f) => {
    if (!f || typeof f !== 'object') return false;
    if (f.status !== 'fail' && f.status !== 'warn') return false;
    if (f.fixable !== 'auto' && !(includeProposed !== false && f.fixable === 'proposed')) return false;
    return matchesCategory(f, category);
  });
}

/** Absolute URL of the page a finding is about (falls back to the report's own target). */
export function urlOf(finding, report) {
  if (finding && finding.location && finding.location.url) return String(finding.location.url);
  if (report && report.target && report.target.kind === 'url') return String(report.target.value);
  return null;
}

/** Path part of a URL, lower-cased, without a trailing slash ('' becomes '/'). */
export function pathOf(url) {
  const raw = String(url || '').trim();
  if (!raw) return '/';
  let path = raw;
  try { path = new URL(raw).pathname; }
  catch { path = raw.split('#')[0].split('?')[0]; }
  path = path.toLowerCase();
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path || '/';
}

/** Last path segment of a URL — the slug most CMS APIs look pages up by. */
export function slugOf(url) {
  const path = pathOf(url);
  const parts = path.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * Group findings by the page they belong to, collecting the field values each one carries.
 * @returns {{pages, skipped, notes}} pages: [{url, path, slug, fields:{field:{value, finding}}, finding_ids, findings}]
 */
export function groupByPage(findings, { report = null, answers = {}, includeProposed = true, category = null } = {}) {
  const pages = new Map();
  const skipped = [];
  const notes = [];
  const withheld = withheldProposedNote(findings, { includeProposed, category });
  if (withheld) notes.push(withheld);
  for (const finding of writableFindings(findings, { includeProposed, category })) {
    const url = urlOf(finding, report);
    if (!url) { skipped.push({ finding: finding.id, reason: 'no URL on the finding and no URL target in the report' }); continue; }
    const { field, values, source } = valuesForFinding(finding, answers);
    if (!source || !Object.keys(values).length) {
      skipped.push({
        finding: finding.id,
        reason: field
          ? 'no value to write: the report carries no fix_preview for this finding (supply one with --answers)'
          : 'not a field-level fix for this adapter (' + finding.id + ')',
      });
      continue;
    }
    const key = pathOf(url);
    if (!pages.has(key)) pages.set(key, { url, path: key, slug: slugOf(url), fields: {}, finding_ids: [], findings: [] });
    const page = pages.get(key);
    for (const [name, value] of Object.entries(values)) {
      if (page.fields[name]) continue; // first finding wins; a later one never silently overwrites it
      page.fields[name] = { value, finding: finding.id, source };
    }
    page.finding_ids.push(finding.id);
    page.findings.push(finding);
  }
  return { pages: [...pages.values()], skipped, notes };
}

/** Plain `{field: value}` view of a grouped page. */
export function fieldValues(page) {
  const out = {};
  for (const [name, entry] of Object.entries(page.fields || {})) out[name] = entry.value;
  return out;
}

/**
 * `--answers` as JSON or a path to a JSON file: `{ "<finding id>": "<snippet>" }`,
 * `{ "<finding id>": { "fix_preview" | "value": "…" } }`, `{ "<finding id>": { "title": "…" } }`,
 * plus an optional `resources` map ({ "<url>": { "type": "posts", "id": 12 } }) for the platform ids
 * a report cannot know. Everything here comes from the user; nothing is derived.
 */
export function normalizeAnswers(answers) {
  if (!answers || answers === true) return { values: {}, resources: {} };
  let raw = answers;
  if (typeof raw === 'string') {
    const asFile = existsSync(raw) ? readJson(raw, null) : null;
    if (asFile) raw = asFile;
    else { try { raw = JSON.parse(answers); } catch { return { values: {}, resources: {} }; } }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { values: {}, resources: {} };
  const values = {};
  const resources = {};
  for (const [id, value] of Object.entries(raw)) {
    if (id === 'resources' && value && typeof value === 'object') {
      for (const [url, res] of Object.entries(value)) {
        if (res && typeof res === 'object') resources[pathOf(url)] = { ...res };
      }
      continue;
    }
    if (typeof value === 'string') values[id] = value;
    else if (value && typeof value === 'object') {
      if (typeof value.fix_preview === 'string') values[id] = value.fix_preview;
      else values[id] = value;
    }
  }
  return { values, resources };
}

/** The http bundle an adapter op uses: injectable fetch, offline-aware, never retried into a write storm. */
export function httpFor(ctx = {}, opts = {}) {
  return makeHttp({
    fetchImpl: ctx.fetchImpl,
    env: ctx.env || process.env,
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
    sleep: ctx.sleep,
  });
}

/**
 * A readable preview of an API call: method, URL, header *names*, and the JSON body with every
 * secret-looking value blanked. This is what a user reads before confirming a live write.
 */
export function renderRequestPreview({ method, url, headers = {}, body = null, before = null, notes = [], env = process.env }) {
  const lines = [];
  lines.push(String(method || 'GET').toUpperCase() + ' ' + redact(String(url || ''), { env }));
  const names = Object.keys(headers || {}).map((h) => h.toLowerCase()).sort();
  if (names.length) lines.push('headers: ' + names.join(', ') + ' (values withheld)');
  if (before && Object.keys(before).length) {
    lines.push('');
    lines.push('before:');
    lines.push(JSON.stringify(redactObject(before, { env }), null, 2));
  }
  if (body !== null && body !== undefined) {
    lines.push('');
    lines.push('body:');
    lines.push(typeof body === 'string' ? redact(body, { env }) : JSON.stringify(redactObject(body, { env }), null, 2));
  }
  for (const note of notes.filter(Boolean)) { lines.push(''); lines.push(note); }
  return lines.join('\n');
}

/**
 * A readable preview of a shell command plus what it reads back afterwards.
 * The command line goes through `redactCommand`, not the env-value-only `redact`: a preview is
 * written to disk and read aloud in the transcript, so a `-u user:pass` or `--token=…` that never
 * came from the environment must still be masked.
 */
export function renderCommandPreview({ command, before = null, notes = [], env = process.env }) {
  const lines = ['$ ' + redactCommand(String(command || ''), { env })];
  if (before && Object.keys(before).length) {
    lines.push('');
    lines.push('before:');
    lines.push(JSON.stringify(redactObject(before, { env }), null, 2));
  }
  for (const note of notes.filter(Boolean)) { lines.push(''); lines.push(note); }
  return lines.join('\n');
}

/**
 * The URL the public re-check should look at: the page itself, or the same path on `--dev-url`
 * when the fix is being verified against a staging host.
 */
export function publicUrlFor(change, ctx = {}) {
  const target = (change && change.target && change.target.url) || null;
  const devUrl = ctx.devUrl || null;
  if (!devUrl) return target;
  const path = target ? pathOf(target) : '/';
  try { return new URL(path, String(devUrl).replace(/\/+$/, '') + '/').href; }
  catch { return target; }
}

/** Append a cache-busting parameter so a re-read cannot be answered from a CDN cache. */
export function bustCache(url, stamp = Date.now()) {
  try {
    const u = new URL(String(url));
    u.searchParams.set(CACHE_BUSTER, String(stamp));
    return u.href;
  } catch { return String(url); }
}

const squash = (s) => String(s).replace(/\s+/g, ' ').trim();

/** Substring match that ignores how the HTML happens to be wrapped. */
export function containsNormalized(haystack, needle) {
  const n = String(needle || '').trim();
  if (!n) return false;
  if (String(haystack).includes(n)) return true;
  return squash(haystack).includes(squash(n));
}

/**
 * Fetch the public URL (cache-busted) and report which of `needles` are visible in the HTML.
 * A fetch that fails is `ok: null` — "we could not look", never "it is wrong".
 * @returns {Promise<{ok: boolean|null, status: number, url: string, missing: string[], error: string|null}>}
 */
export async function checkPublicUrl(url, needles, ctx = {}, { now = Date.now } = {}) {
  const target = bustCache(url, typeof now === 'function' ? now() : now);
  const wanted = (Array.isArray(needles) ? needles : [needles]).map((n) => String(n || '')).filter(Boolean);
  const http = httpFor(ctx, { retries: 0 });
  let res;
  try {
    res = await http.json(target, {
      method: 'GET',
      headers: { accept: 'text/html,*/*', 'cache-control': 'no-cache', pragma: 'no-cache' },
    });
  } catch (e) {
    // offline mode throws rather than pretending: that is "could not look", not "wrong"
    return { ok: null, status: 0, url: target, missing: wanted, error: String((e && e.message) || e) };
  }
  if (!res.ok) {
    return { ok: null, status: res.status, url: target, missing: wanted, error: res.error ? res.error.message || String(res.error.type) : 'HTTP ' + res.status };
  }
  const html = res.text || '';
  const missing = wanted.filter((n) => !containsNormalized(html, n));
  return { ok: wanted.length ? missing.length === 0 : null, status: res.status, url: target, missing, error: null };
}

/**
 * Truncate at a word boundary when a platform enforces a field length (BigCommerce's 70/160).
 * @returns {{value: string, truncated: boolean, limit: number}}
 */
export function truncateAtWord(value, limit) {
  const s = String(value == null ? '' : value);
  const max = Number(limit);
  if (!Number.isFinite(max) || max <= 0 || s.length <= max) return { value: s, truncated: false, limit: max };
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  const out = (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, '');
  return { value: out, truncated: true, limit: max };
}

/** Shallow "did the write land" comparison: every expected field equals what came back. */
export function fieldsMatch(expected, actual) {
  const mismatches = [];
  for (const [key, want] of Object.entries(expected || {})) {
    const got = actual ? actual[key] : undefined;
    if (typeof want === 'string' && typeof got === 'string') {
      if (squash(got) !== squash(want)) mismatches.push({ field: key, expected: want, observed: got });
    } else if (JSON.stringify(got) !== JSON.stringify(want)) {
      mismatches.push({ field: key, expected: want, observed: got === undefined ? null : got });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * The one shape every adapter CLI uses when an op throws where it was not expected.
 *
 * A throw that escapes preview/apply/verify/rollback means the op stopped somewhere it does not
 * describe, so the change is not "still pending": it is marked `failed` and the reason travels
 * with it, on the change (`change.error`, which is what gets persisted back into plan.json) as
 * well as on the result row. When `failed` is unreachable from the current status — the change is
 * already terminal — the status is left alone and the message is still reported, because a
 * manifest that swallowed the reason is worse than one that repeats a terminal status.
 *
 * @param {object} change the change the op was running on
 * @param {any}    error  the thrown value
 * @returns {{change: object, ok: false, error: string}}
 */
export function opThrew(change, error) {
  const message = String((error && error.message) || error);
  if (!change || typeof change !== 'object') return { change, ok: false, error: message };
  if (!canTransitionSafe(change.status, 'failed')) {
    return { change: { ...change, error: message }, ok: false, error: message };
  }
  return { change: transitionChange(change, 'failed', { error: message }), ok: false, error: message };
}

/**
 * Log the audit-trail event for one CLI op run.
 *
 * The distinction that matters: an `apply` in which every change was refused for lack of a
 * confirmation ticket wrote nothing, so logging it as `apply` would put a write in the audit log
 * that never happened. Those runs are logged as `refused`, with the reason and the op that was
 * asked for; a partial refusal keeps the op name and carries a `refused` count.
 *
 * @param {object|null} run     fix-run handle (null is a no-op)
 * @param {object} info { op, adapter, results: [{refused?}], extra }
 */
export function logOpEvent(run, { op, adapter = null, results = [], extra = {} } = {}) {
  if (!run || typeof run.log !== 'function') return null;
  const rows = Array.isArray(results) ? results : [];
  const refused = rows.filter((r) => r && r.refused);
  const base = { adapter, changes: rows.length, ...extra };
  if (rows.length && refused.length === rows.length) {
    return run.log({ event: 'refused', op, reason: refused[0].refused, ...base });
  }
  return run.log({ event: op, ...base, ...(refused.length ? { refused: refused.length } : {}) });
}

/** One-line summary of an http.mjs failure, safe to put in a change's `error`. */
export function describeFailure(res, env = process.env) {
  if (!res) return 'no response';
  const err = res.error;
  const base = 'HTTP ' + (res.status || 0);
  if (!err) return base;
  const detail = err.message || err.type || '';
  return redact(base + (detail ? ' — ' + detail : ''), { env });
}

// ---------------------------------------------------------------------------
// Generic ops for a payload-shaped remote change
//
// Every page-api provider does the same four things with different request shapes, so the shape
// lives here once: `preview` re-prints what was planned, `apply` sends `payload.body` to
// `payload.url`, `verify` reads it back and then looks at the public page, `rollback` sends the
// captured `before` request. A provider supplies a small driver instead of repeating the plumbing.

/**
 * @param {object} driver
 *   provider     — id used in logs and results
 *   headers(ctx) — auth headers, or null when a credential is missing
 *   beforeApply({change, ctx, headers, body}) — optional; returns a body (Ghost re-reads updated_at)
 *   readback({change, ctx, headers})          — optional; returns {ok, values, error}
 *   staged(change)                            — optional; true when a write is not public yet
 *   stagedNote(change)                        — optional; what the user must still do
 * @returns {{preview, apply, verify, rollback}}
 */
export function makeRemoteOps(driver) {
  const providerId = driver.provider;

  async function preview(change, ctx = {}) {
    const body = (change.preview && change.preview.body) || '';
    if (ctx.run) writeRunPreview(ctx.run, change, body);
    if (change.status === 'skipped_unready') {
      return { change, ok: null, body, reason: change.error || 'not writable through this API yet' };
    }
    return { change: canTransitionSafe(change.status, 'previewed') ? transitionChange(change, 'previewed') : change, ok: true, body };
  }

  async function apply(change, ctx = {}) {
    const env = ctx.env || process.env;
    if (change.status === 'skipped_unready') {
      return { change, ok: false, reason: 'skipped_unready', error: change.error || 'this change is not writable through the API' };
    }
    const payload = change.payload || {};
    const headers = driver.headers(ctx);
    if (!headers) {
      return { change: transitionChange(change, 'failed', { error: 'missing credentials for ' + providerId + ': ' + (change.requires && change.requires.credentials ? change.requires.credentials.join(', ') : '') }), ok: false };
    }
    let confirmed;
    try { confirmed = ensureConfirmedChange(change); }
    catch (e) { return { change, ok: false, error: String((e && e.message) || e) }; }

    let body = payload.body;
    if (typeof driver.beforeApply === 'function') {
      const prepared = await driver.beforeApply({ change: confirmed, ctx, headers, body });
      if (prepared && prepared.error) return { change: transitionChange(confirmed, 'failed', { error: prepared.error }), ok: false };
      if (prepared && prepared.body !== undefined) body = prepared.body;
    }

    const http = httpFor(ctx);
    let res;
    try { res = await http.json(payload.url, { method: payload.method, headers, body }); }
    catch (e) { return { change: transitionChange(confirmed, 'failed', { error: String((e && e.message) || e) }), ok: false }; }
    if (!res.ok) return { change: transitionChange(confirmed, 'failed', { error: describeFailure(res, env) }), ok: false, status: res.status };

    if (ctx.run) {
      writeRunAfter(ctx.run, confirmed, {
        change: confirmed.id, provider: providerId, method: payload.method, url: payload.url,
        status: res.status, live_impact: confirmed.live_impact, applied_at: new Date().toISOString(),
      });
      ctx.run.log({ event: 'apply', adapter: 'page-api', provider: providerId, change: confirmed.id, method: payload.method, status: res.status });
    }
    return { change: transitionChange(confirmed, 'applied'), ok: true, status: res.status, response: res.json };
  }

  async function verify(change, ctx = {}) {
    const env = ctx.env || process.env;
    const payload = change.payload || {};
    const checks = [];
    const expected = payload.expect && typeof payload.expect === 'object' ? payload.expect : {};

    let apiOk = null;
    if (typeof driver.readback === 'function') {
      const headers = driver.headers(ctx);
      if (!headers) checks.push({ name: 'api', ok: null, detail: 'no credentials: cannot re-read the resource' });
      else {
        let read;
        try { read = await driver.readback({ change, ctx, headers }); }
        catch (e) { read = { ok: false, error: String((e && e.message) || e) }; }
        if (!read || read.ok === false) {
          checks.push({ name: 'api', ok: null, detail: 'could not re-read: ' + redact(String((read && read.error) || 'unknown error'), { env }) });
        } else {
          const cmp = fieldsMatch(expected, read.values || {});
          apiOk = cmp.ok;
          checks.push({
            name: 'api', ok: cmp.ok,
            detail: cmp.ok ? 'the API reports the values that were written'
              : cmp.mismatches.map((m) => m.field + ' still reads ' + JSON.stringify(m.observed)).join('; '),
          });
        }
      }
    }

    const staged = typeof driver.staged === 'function' ? !!driver.staged(change) : false;
    if (staged) {
      return {
        change, ok: apiOk === false ? false : null, checks,
        note: (typeof driver.stagedNote === 'function' ? driver.stagedNote(change) : null)
          || 'saved, but not published: the public page will not change until you publish. That is "staged", not "fixed".',
      };
    }

    const url = publicUrlFor(change, ctx);
    const needles = Object.values(expected).filter((v) => typeof v === 'string' && v.trim());
    let publicCheck = null;
    if (url && needles.length) {
      publicCheck = await checkPublicUrl(url, needles, ctx);
      checks.push({
        name: 'public', ok: publicCheck.ok,
        detail: publicCheck.error ? 'could not fetch ' + publicCheck.url + ': ' + publicCheck.error
          : (publicCheck.ok ? 'the public page serves the new values' : 'the public page still serves the old values'),
      });
    }

    if (apiOk === false) {
      return { change: canTransitionSafe(change.status, 'failed') ? transitionChange(change, 'failed', { error: checks.find((c) => c.name === 'api').detail }) : change, ok: false, checks };
    }
    if (publicCheck && publicCheck.ok === false) {
      const next = canTransitionSafe(change.status, 'pending_cache') ? transitionChange(change, 'pending_cache') : change;
      return { change: next, ok: null, checks, note: 'the API accepted the change but the CDN is still serving the old page — purge the cache and re-verify.' };
    }
    if (apiOk !== true && (!publicCheck || publicCheck.ok !== true)) {
      return { change, ok: null, checks, note: 'not verifiable from here — treat this as unconfirmed, not as done' };
    }
    if (!canTransitionSafe(change.status, 'verified')) return { change, ok: true, checks, note: 'checks passed; status left at "' + change.status + '"' };
    return { change: transitionChange(change, 'verified'), ok: true, checks };
  }

  async function rollback(change, ctx = {}) {
    const env = ctx.env || process.env;
    const data = (change.rollback && change.rollback.data) || null;
    if (!data || !data.url || !data.body) {
      return { change, ok: false, reason: 'no-before', note: 'the values before the write were never captured, so there is nothing to restore' };
    }
    const headers = driver.headers(ctx);
    if (!headers) return { change, ok: false, error: 'missing credentials for ' + providerId };
    let body = data.body;
    if (typeof driver.beforeApply === 'function') {
      const prepared = await driver.beforeApply({ change, ctx, headers, body, rollback: true });
      if (prepared && prepared.error) return { change, ok: false, error: prepared.error };
      if (prepared && prepared.body !== undefined) body = prepared.body;
    }
    const http = httpFor(ctx);
    let res;
    try { res = await http.json(data.url, { method: data.method, headers, body }); }
    catch (e) { return { change, ok: false, error: String((e && e.message) || e) }; }
    if (!res.ok) return { change, ok: false, error: describeFailure(res, env) };
    if (ctx.run) ctx.run.log({ event: 'rollback', adapter: 'page-api', provider: providerId, change: change.id, status: res.status });
    return { change: canTransitionSafe(change.status, 'rolled_back') ? transitionChange(change, 'rolled_back') : change, ok: true, status: res.status };
  }

  return { preview, apply, verify, rollback };
}

function writeRunPreview(run, change, body) {
  try { writeText(run.previewPath(change.id, '.json.txt'), body); } catch { /* preview is best effort */ }
}

function writeRunAfter(run, change, record) {
  try { writeJson(run.afterPath(change.id), record); } catch { /* best effort */ }
}

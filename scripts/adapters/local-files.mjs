#!/usr/bin/env node
// local-files adapter — edits the source of a site you have on disk (any framework, or plain HTML).
//
//   node scripts/adapters/local-files.mjs <op> --run <fix-run-dir> [--change <id>] [--ticket <t>] [--json]
//   ops: capabilities | plan | preview | apply | verify | rollback
//
// WHO ACTUALLY WRITES THE FILE
// Inside Claude Code the *writer agent* applies local diffs with Edit/Write, not this `apply` op.
// That is deliberate: Edit/Write raise Claude Code's own diff prompt, run the `guard-write` hook and
// show the user the change in the interface they already trust. This adapter's `apply` exists for
// `--yes` / CI runs where no human is at a keyboard — it takes a ticket, backs the file up to
// <DATA>/backups/<run>/<relpath> first, and refuses any path that escapes --project.
//
// WHAT IT CAN AND CANNOT COMPUTE
// A change is only planned when its after-text can be produced deterministically from the finding's
// own `fix_preview` plus an exact anchor: an html-head insertion, a front-matter merge, a config or
// text file. Every JSX/TS strategy (metadata-object, next-head-jsx, use-seo-meta, svelte-head,
// meta-export-array, gatsby-head-export) is planned as a `proposed` change carrying the snippet and
// the exact location, and is left for the writer's Edit — this module never regex-rewrites JSX.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { EXIT, isMain, runCli } from '../lib/util.mjs';
import {
  canTransition, ensureConfirmed, loadFixRun, makeChange, openFixRun, requireTicket, resolveDataDir, transition,
  updateManifest,
} from '../lib/adapter.mjs';
import { AUTO_STRATEGIES, classFor, normalizePath, resolveRoute, scanProject } from '../lib/route-map.mjs';
import { DEFAULT_MARKER, applyInsertAt, hasMarker, insertInHead, unifiedDiff } from '../lib/diff.mjs';
import { mergeFrontmatter, parseFrontmatter } from '../lib/frontmatter.mjs';
import { readJson, writeJson, writeText } from '../lib/store.mjs';
import { resolveFetch } from '../lib/http.mjs';
import { reproduceCommand } from '../lib/finding.mjs';
import { logOpEvent, matchesCategory, opThrew, withheldProposedNote } from './_shared.mjs';

export const ADAPTER = 'local-files';
const OPS = ['capabilities', 'plan', 'preview', 'apply', 'verify', 'rollback'];

const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');
const toPosix = (p) => String(p).split(sep).join('/');

/**
 * Resolve a repo-relative (or absolute) path inside `projectRoot`, refusing anything that escapes.
 * Symlinks are resolved on the parent directory, so a link pointing outside the project is caught.
 * @returns {{ok, abs, rel, reason}}
 */
export function containedPath(projectRoot, target) {
  const raw = String(target == null ? '' : target).trim();
  if (!raw) return { ok: false, abs: null, rel: null, reason: 'empty path' };
  if (raw.includes('\0')) return { ok: false, abs: null, rel: null, reason: 'path contains a NUL byte' };
  const realRoot = realish(resolve(projectRoot || '.'));
  const abs = realish(isAbsolute(raw) ? resolve(raw) : resolve(realRoot, raw));
  const rel = relative(realRoot, abs);
  const escapes = rel === '' || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel);
  if (escapes) return { ok: false, abs, rel: null, reason: 'path escapes the project root: ' + raw };
  return { ok: true, abs, rel: toPosix(rel), reason: null };
}

/**
 * Absolute path with every existing symlink on it resolved (a temp dir on macOS is /var -> /private/var,
 * and a symlink inside the project is how a "contained" path would otherwise point outside it).
 * The part that does not exist yet is appended unchanged.
 */
function realish(absPath) {
  let head = resolve(absPath);
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try { return join(realpathSync(head), ...tail); }
    catch {
      const parent = dirname(head);
      if (parent === head) return resolve(absPath);
      tail.unshift(head.slice(parent.length + 1));
      head = parent;
    }
  }
  return resolve(absPath);
}

/**
 * Read a finding's `fix_preview` (schema: "unified diff or new-file content").
 * @returns {{kind: 'diff'|'front-matter'|'fields'|'snippet'|'none', snippet: string, updates: object|null}}
 */
export function parseFixPreview(fixPreview) {
  const text = typeof fixPreview === 'string' ? fixPreview : '';
  if (!text.trim()) return { kind: 'none', snippet: '', updates: null };
  // `--- a/file` (a diff header, space-separated) vs `---\n` (a YAML front-matter fence)
  const isDiff = /^---[ \t]+\S/.test(text) || /\n@@ /.test(text) || /^@@ /.test(text);
  if (isDiff) {
    const added = text.split(/\r?\n/).filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
    return { kind: 'diff', snippet: added.join('\n').trim(), updates: null };
  }
  const fm = parseFrontmatter(text);
  if (fm.present && fm.format === 'yaml' && Object.keys(fm.data).length) {
    return { kind: 'front-matter', snippet: text.trim(), updates: fm.data };
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const kv = lines.every((l) => /^[A-Za-z0-9_.$-]+\s*:\s*\S/.test(l));
  if (kv && lines.length) {
    const wrapped = parseFrontmatter('---\n' + lines.join('\n') + '\n---\n');
    if (wrapped.present && Object.keys(wrapped.data).length) return { kind: 'fields', snippet: text.trim(), updates: wrapped.data };
  }
  return { kind: 'snippet', snippet: text.trim(), updates: null };
}

/** Strategy implied by a file extension, or null when the route's own strategy should decide. */
export function strategyForFile(relPath) {
  const p = String(relPath || '').toLowerCase();
  if (/\.(md|markdown|mdx)$/.test(p)) return 'front-matter';
  if (/\.(html?|liquid|njk|hbs|handlebars|ejs|astro)$/.test(p)) return 'html-head';
  if (/(^|\/)robots\.txt$/.test(p) || /\.(txt|xml)$/.test(p)) return 'config-file';
  if (/(^|\/)(_config\.ya?ml|hugo\.(toml|ya?ml)|config\.(toml|ya?ml)|astro\.config\.[a-z]+|next\.config\.[a-z]+|nuxt\.config\.[a-z]+|svelte\.config\.[a-z]+|gatsby-config\.[a-z]+|\.eleventy\.js|eleventy\.config\.[a-z]+)$/.test(p)) return 'config-file';
  return null;
}

const ROBOTS_RE = /robots/i;
const SITEMAP_RE = /sitemap/i;

// One home for the `--category` predicate: it lives in _shared.mjs (the adapters' shared plumbing)
// and is re-exported here because every file adapter already imports its finding helpers from this
// module. Two copies of it drifting apart would mean `--category M7` selecting different findings
// depending on which adapter ran.
export { matchesCategory };

/** Findings a file-writing adapter may act on at all. */
export function fixableFindings(findings, { includeProposed = false, category = null } = {}) {
  return (Array.isArray(findings) ? findings : []).filter((f) => {
    if (!f || typeof f !== 'object') return false;
    if (f.status !== 'fail' && f.status !== 'warn') return false;
    if (f.fixable !== 'auto' && !(includeProposed && f.fixable === 'proposed')) return false;
    return matchesCategory(f, category);
  });
}

/**
 * Values the user supplied in chat for findings the audit could not fill in (a locale map, a
 * `sameAs` list, a redirect target). Accepted as a path to a JSON file or as inline JSON, shaped
 * `{ "<finding id>": "<snippet>" }` or `{ "<finding id>": { "fix_preview": "<snippet>" } }`.
 * Nothing is invented here: an answer only ever comes from the user.
 */
export function normalizeAnswers(answers) {
  if (!answers || answers === true) return {};
  let raw = answers;
  if (typeof raw === 'string') {
    const asFile = existsSync(raw) ? readJson(raw, null) : null;
    if (asFile) raw = asFile;
    else { try { raw = JSON.parse(answers); } catch { return {}; } }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    if (typeof value === 'string') out[id] = value;
    else if (value && typeof value === 'object' && typeof value.fix_preview === 'string') out[id] = value.fix_preview;
  }
  return out;
}

function urlOf(finding, report) {
  if (finding.location && finding.location.url) return String(finding.location.url);
  if (report && report.target && report.target.kind === 'url') return String(report.target.value);
  return null;
}

/**
 * Decide which file a finding edits and how.
 * @returns {{rel, strategy, op, note, route}|null}
 */
export function targetForFinding(finding, { project, profile, files, report, routeCache = new Map() }) {
  const loc = finding.location || {};
  const url = urlOf(finding, report);
  const routeFor = (u) => {
    const key = u || '/';
    if (!routeCache.has(key)) routeCache.set(key, resolveRoute(project, key, profile, { files }));
    return routeCache.get(key);
  };

  if (loc.file) {
    const rel = toPosix(loc.file).replace(/^\.\//, '');
    const route = url ? routeFor(url) : null;
    const sameAsRoute = route && route.file === rel;
    const strategy = sameAsRoute ? route.strategy : (strategyForFile(rel) || (route ? route.strategy : 'manual'));
    return { rel, strategy, op: existsSync(join(project, rel.split('/').join(sep))) ? 'insert' : 'create', note: 'file named by the finding', route };
  }

  const route = routeFor(url || '/');
  const site = route.site_wide || {};
  const id = String(finding.id || '');
  if (ROBOTS_RE.test(id) && site.robots) {
    return { rel: site.robots.path, strategy: 'config-file', op: site.robots.exists ? 'insert' : 'create', note: 'site-wide robots file', route };
  }
  if (SITEMAP_RE.test(id) && site.sitemap) {
    return { rel: site.sitemap.path, strategy: 'config-file', op: site.sitemap.exists ? 'insert' : 'create', note: 'site-wide sitemap file', route };
  }
  if (!route.file) return null;
  return { rel: route.file, strategy: route.strategy, op: 'insert', note: 'resolved from the URL by route-map', route };
}

/**
 * Apply a change's payload to the current file text.
 * @returns {{ok, text, changed, reason}} reason 'manual-edit-required' means a human/agent editor
 *          has to merge it (JSX and TS-object strategies) — never a silent no-op.
 */
export function computeEdit(currentText, change) {
  const payload = change.payload || {};
  const strategy = change.strategy || payload.strategy || 'manual';
  const marker = payload.marker || DEFAULT_MARKER;
  const text = currentText == null ? '' : String(currentText);

  if (change.op === 'create') {
    if (text) {
      if (text.includes(String(payload.snippet || '').trim())) return { ok: true, text, changed: false, reason: 'already-present' };
      return { ok: false, text, changed: false, reason: 'file-exists' };
    }
    return { ok: true, text: String(payload.snippet || ''), changed: true, reason: 'created' };
  }
  if (strategy === 'html-head') {
    const r = insertInHead(text, payload.snippet, { marker });
    return { ok: r.ok, text: r.text, changed: r.changed, reason: r.reason };
  }
  if (strategy === 'front-matter') {
    if (!payload.updates || !Object.keys(payload.updates).length) return { ok: false, text, changed: false, reason: 'no-front-matter-updates' };
    const r = mergeFrontmatter(text, payload.updates, { overwrite: payload.overwrite === true });
    return { ok: r.ok, text: r.text, changed: r.changed, reason: r.reason };
  }
  if (strategy === 'config-file') {
    if (payload.anchor) {
      const r = applyInsertAt(text, { anchor: payload.anchor, position: payload.position || 'after', insert: payload.snippet, marker });
      return { ok: r.ok, text: r.text, changed: r.changed, reason: r.reason };
    }
    const snippet = String(payload.snippet || '');
    if (!snippet.trim()) return { ok: false, text, changed: false, reason: 'empty-snippet' };
    if (text.includes(snippet.trim())) return { ok: true, text, changed: false, reason: 'already-present' };
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const next = text && !text.endsWith('\n') ? text + eol + snippet + eol : text + snippet + eol;
    return { ok: true, text: next, changed: true, reason: 'appended' };
  }
  return { ok: false, text, changed: false, reason: 'manual-edit-required' };
}

function readFileIfExists(abs) {
  try { return existsSync(abs) ? readFileSync(abs, 'utf8') : null; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Adapter ops

/** capabilities: local edits need no credentials — only a readable project directory. */
export async function capabilities(ctx = {}) {
  const project = ctx.project ? resolve(ctx.project) : null;
  const exists = !!(project && existsSync(project) && statSync(project).isDirectory());
  return {
    adapter: ADAPTER,
    ready: exists,
    needs: exists ? [] : ['--project <dir>'],
    tools: {},
    notes: exists ? ['writes only inside ' + project] : ['pass --project pointing at the repository root'],
    writes: 'local files (backed up to <DATA>/backups/<run>/ before any write)',
  };
}

/**
 * plan: turn findings into Changes.
 * @param {object} options { report, profile, project, category, includeProposed, findings }
 * @param {object} ctx     { run, dataDir, now }
 */
export async function plan(options = {}, ctx = {}) {
  const project = resolve(options.project || ctx.project || '.');
  if (!existsSync(project) || !statSync(project).isDirectory()) {
    return { changes: [], skipped: [], notes: ['project root not found: ' + project], ready: false };
  }
  const report = options.report && typeof options.report === 'object' ? options.report
    : (options.report ? readJson(options.report, null) : null);
  const findings = Array.isArray(options.findings) ? options.findings : (report && Array.isArray(report.findings) ? report.findings : []);
  const profile = options.profile && typeof options.profile === 'object' ? options.profile
    : (options.profile ? readJson(options.profile, null) : (report && report.platform) || null);

  const files = scanProject(project);
  const routeCache = new Map();
  const changes = [];
  const skipped = [];
  const notes = [];

  const answers = normalizeAnswers(options.answers);
  const withheld = withheldProposedNote(findings, { includeProposed: options.includeProposed === true, category: options.category });
  if (withheld) notes.push(withheld);
  for (const finding of fixableFindings(findings, { includeProposed: options.includeProposed, category: options.category })) {
    const answer = answers[finding.id];
    const preview = parseFixPreview(finding.fix_preview || answer || '');
    if (preview.kind === 'none') {
      skipped.push({ finding: finding.id, reason: 'no fix_preview to apply — handled by the instructions adapter' });
      continue;
    }
    const target = targetForFinding(finding, { project, profile, files, report, routeCache });
    if (!target) {
      skipped.push({ finding: finding.id, reason: 'no source file maps to ' + (urlOf(finding, report) || 'this finding') });
      continue;
    }
    const contained = containedPath(project, target.rel);
    if (!contained.ok) {
      skipped.push({ finding: finding.id, reason: contained.reason });
      continue;
    }
    const current = readFileIfExists(contained.abs);
    const op = current === null ? 'create' : (target.strategy === 'front-matter' ? 'update-fields' : target.op);
    const manual = !AUTO_STRATEGIES.includes(target.strategy) && op !== 'create';
    const payload = {
      strategy: target.strategy,
      snippet: preview.snippet,
      updates: preview.updates || undefined,
      marker: DEFAULT_MARKER,
      source: preview.kind,
    };
    const cls = finding.fixable === 'auto' && classFor(target.strategy) === 'auto' && !manual ? 'auto' : 'proposed';
    const url = urlOf(finding, report);

    const draft = {
      finding_ids: [finding.id],
      adapter: ADAPTER,
      class: cls,
      target: { kind: 'file', locator: contained.rel, project_root: project, url: url || undefined },
      op,
      strategy: target.strategy,
      payload,
      requires: { credentials: [], tools: [] },
      live_impact: 'none',
      rollback: { kind: 'restore-file', data: { path: contained.rel } },
      status: 'planned',
    };
    // The id is computed before the after-text exists: it identifies the *edit* (adapter, op,
    // target, findings, snippet), not its result, so re-planning the same fix yields the same id.
    const id = makeChange(draft, { mode: 'return', phase: 'plan' }).change.id;

    let body;
    let kind;
    if (manual) {
      kind = 'text';
      body = manualPreviewText({ finding, target, snippet: preview.snippet, project });
    } else {
      const edit = computeEdit(current, { ...draft, id });
      if (!edit.ok) {
        skipped.push({ finding: finding.id, reason: edit.reason + ' (' + contained.rel + ')' });
        continue;
      }
      if (!edit.changed) {
        skipped.push({ finding: finding.id, reason: 'already applied in ' + contained.rel + ' (' + edit.reason + ')', status: 'skipped_idempotent' });
        continue;
      }
      kind = 'diff';
      body = unifiedDiff(current || '', edit.text, { fromFile: 'a/' + contained.rel, toFile: 'b/' + contained.rel });
      payload.after_sha1 = sha1(edit.text);
    }

    const verifyCommand = reproduceCommand('adapters/local-files.mjs', ['verify', '--run', ctx.run ? ctx.run.dir : '<run>', '--change', id, '--project', project]);
    const built = makeChange({
      ...draft,
      id,
      preview: { kind, body, lang: kind === 'diff' ? 'diff' : undefined },
      before: { path: contained.rel, exists: current !== null, sha1: current === null ? null : sha1(current), bytes: current === null ? 0 : Buffer.byteLength(current) },
      verify: {
        method: manual ? 'manual_review' : 'dom_assert',
        command: verifyCommand,
        assertion: manual
          ? 'a human or the writer agent merged the snippet into ' + contained.rel
          : contained.rel + ' contains the inserted block (marker ' + DEFAULT_MARKER + ')',
        url: url || undefined,
      },
    }, { mode: 'return', phase: 'preview' });
    if (built.errors.length) {
      skipped.push({ finding: finding.id, reason: 'invalid change: ' + built.errors.join('; ') });
      continue;
    }
    changes.push(built.change);
  }

  if (!changes.length && !skipped.length) notes.push('no fixable findings for this adapter');
  return { adapter: ADAPTER, ready: true, project, changes, skipped, notes };
}

function manualPreviewText({ finding, target, snippet, project }) {
  return [
    'Manual merge required (strategy: ' + target.strategy + ', class: proposed)',
    'File:    ' + target.rel + '  (in ' + project + ')',
    finding.location && finding.location.url ? 'URL:     ' + finding.location.url : null,
    'Finding: ' + finding.id + ' — ' + finding.title,
    '',
    'Add this, keeping the file\'s own conventions:',
    snippet,
    '',
    'This strategy is not an exact-anchor text edit, so the tool never rewrites it automatically:',
    'the writer applies it with Edit and you see the diff prompt.',
  ].filter((l) => l !== null).join('\n');
}

/** preview: recompute the diff against what is on disk right now (a stale plan is detected here). */
export async function preview(change, ctx = {}) {
  const project = resolve((change.target && change.target.project_root) || ctx.project || '.');
  const contained = containedPath(project, change.target.locator);
  if (!contained.ok) return { change: transition(change, 'failed', { error: contained.reason }), ok: false, body: null };
  const current = readFileIfExists(contained.abs);
  if (change.verify && change.verify.method === 'manual_review') {
    if (ctx.run) writeText(ctx.run.previewPath(change.id, '.txt'), change.preview.body);
    return { change: transition(change, 'previewed'), ok: true, body: change.preview.body, drifted: false };
  }
  const beforeSha = change.before && change.before.sha1;
  const drifted = !!(beforeSha && current !== null && sha1(current) !== beforeSha);
  const edit = computeEdit(current, change);
  if (!edit.ok) return { change: transition(change, 'failed', { error: 'cannot render preview: ' + edit.reason }), ok: false, body: null, drifted };
  if (!edit.changed) {
    return { change: transition(change, 'skipped_idempotent'), ok: true, body: '', drifted, reason: edit.reason };
  }
  const body = unifiedDiff(current || '', edit.text, { fromFile: 'a/' + contained.rel, toFile: 'b/' + contained.rel });
  if (ctx.run) writeText(ctx.run.previewPath(change.id, '.diff'), body);
  const next = transition({ ...change, preview: { kind: 'diff', body, lang: 'diff' } }, 'previewed');
  return { change: next, ok: true, body, drifted };
}

/**
 * apply: write the file (CI / --yes path). Backs up first, refuses to leave the project, and never
 * touches a JSX strategy — those come back as `skipped_unready` for the writer agent's Edit.
 */
export async function apply(change, ctx = {}) {
  const project = resolve((change.target && change.target.project_root) || ctx.project || '.');
  const contained = containedPath(project, change.target.locator);
  if (!contained.ok) return { change: transition(change, 'failed', { error: contained.reason }), ok: false };
  if (change.verify && change.verify.method === 'manual_review') {
    return {
      change: transition(change, 'skipped_unready', { error: 'manual merge: apply this one with Edit/Write in Claude Code' }),
      ok: false, reason: 'manual-edit-required',
    };
  }
  let confirmed;
  try { confirmed = ensureConfirmed(change); }
  catch (e) { return { change, ok: false, error: String(e && e.message || e) }; }
  const current = readFileIfExists(contained.abs);
  const edit = computeEdit(current, confirmed);
  if (!edit.ok) return { change: transition(confirmed, 'failed', { error: edit.reason }), ok: false };
  if (!edit.changed) return { change: transition(confirmed, 'skipped_idempotent'), ok: true, reason: edit.reason };

  let backup = null;
  if (ctx.run && current !== null) {
    backup = ctx.run.backupPath(contained.rel);
    mkdirSync(dirname(backup), { recursive: true });
    copyFileSync(contained.abs, backup);
  }
  mkdirSync(dirname(contained.abs), { recursive: true });
  writeFileSync(contained.abs, edit.text);
  if (ctx.run) {
    writeJson(ctx.run.afterPath(confirmed.id), {
      change: confirmed.id, file: contained.rel, backup: backup ? toPosix(relative(ctx.run.data_dir, backup)) : null,
      sha1_before: current === null ? null : sha1(current), sha1_after: sha1(edit.text),
      bytes_before: current === null ? 0 : Buffer.byteLength(current), bytes_after: Buffer.byteLength(edit.text),
      applied_at: new Date().toISOString(),
    });
    ctx.run.log({ event: 'apply', adapter: ADAPTER, change: change.id, file: contained.rel, backup: !!backup });
  }
  const next = transition({ ...confirmed, rollback: { kind: 'restore-file', data: { path: contained.rel, backup: backup || null } } }, 'applied');
  return { change: next, ok: true, backup, file: contained.abs };
}

/**
 * verify: a source-level assertion, plus an optional fetch of `--dev-url` for the running site.
 * A dev server that has not rebuilt yet is `pending_cache`, never a pass.
 */
export async function verify(change, ctx = {}) {
  const project = resolve((change.target && change.target.project_root) || ctx.project || '.');
  const contained = containedPath(project, change.target.locator);
  if (!contained.ok) return { change: transition(change, 'failed', { error: contained.reason }), ok: false };
  const current = readFileIfExists(contained.abs);
  if (current === null) return { change: transition(change, 'failed', { error: 'file not found: ' + contained.rel }), ok: false };

  const payload = change.payload || {};
  const needle = String(payload.snippet || '').trim();
  const sourceOk = payload.after_sha1
    ? sha1(current) === payload.after_sha1 || presentInSource(current, change)
    : presentInSource(current, change);

  const checks = [{ name: 'source', ok: sourceOk, detail: sourceOk ? 'change present in ' + contained.rel : 'not found in ' + contained.rel }];

  const devUrl = ctx.devUrl || null;
  if (devUrl && sourceOk) {
    const url = joinDevUrl(devUrl, (change.target && change.target.url) || '/');
    const fetched = await fetchHtml(url, ctx);
    if (!fetched.ok) checks.push({ name: 'dev-url', ok: null, detail: 'could not fetch ' + url + ': ' + fetched.error });
    else {
      const visible = needle ? containsNormalized(fetched.text, needle) : false;
      checks.push({ name: 'dev-url', ok: visible, detail: visible ? 'served by ' + url : 'not in the HTML served by ' + url + ' yet' });
      if (!visible) {
        const pending = canTransition(change.status, 'pending_cache') ? transition(change, 'pending_cache', {}) : change;
        return { change: pending, ok: null, checks, note: 'source is correct; the dev server has not served it yet (rebuild, then re-verify)' };
      }
    }
  }
  if (!sourceOk) {
    const failed = canTransition(change.status, 'failed') ? transition(change, 'failed', { error: 'verification failed: ' + checks[0].detail }) : change;
    return { change: failed, ok: false, checks };
  }
  if (!canTransition(change.status, 'verified')) {
    return { change, ok: true, checks, note: 'source check passed; the change is still "' + change.status + '", so its status was left alone' };
  }
  return { change: transition(change, 'verified'), ok: true, checks };
}

function presentInSource(text, change) {
  const payload = change.payload || {};
  if (payload.marker && hasMarker(text, payload.marker)) return true;
  if (payload.updates && Object.keys(payload.updates).length) {
    const fm = parseFrontmatter(text);
    return Object.entries(payload.updates).every(([k, v]) => JSON.stringify(fm.data[k]) === JSON.stringify(v));
  }
  const needle = String(payload.snippet || '').trim();
  return !!needle && containsNormalized(text, needle);
}

const squash = (s) => String(s).replace(/\s+/g, ' ').trim();
function containsNormalized(haystack, needle) {
  if (String(haystack).includes(needle)) return true;
  return squash(haystack).includes(squash(needle));
}

function joinDevUrl(devUrl, target) {
  const path = /^https?:\/\//i.test(String(target)) ? normalizePath(target) : normalizePath(target || '/');
  try { return new URL(path, String(devUrl).replace(/\/$/, '') + '/').href; } catch { return String(devUrl); }
}

async function fetchHtml(url, ctx = {}) {
  try {
    const doFetch = resolveFetch(ctx.fetchImpl, ctx.env || process.env);
    const res = await doFetch(url, { headers: { accept: 'text/html,*/*' }, redirect: 'follow' });
    const text = typeof res.text === 'function' ? await res.text() : '';
    return { ok: !!(res && res.status >= 200 && res.status < 400), status: res.status, text, error: null };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: String(e && e.message || e) };
  }
}

/** rollback: restore the file from the backup this run made. No backup means no claim of a rollback. */
export async function rollback(change, ctx = {}) {
  const project = resolve((change.target && change.target.project_root) || ctx.project || '.');
  const contained = containedPath(project, change.target.locator);
  if (!contained.ok) return { change: transition(change, 'failed', { error: contained.reason }), ok: false };
  const data = (change.rollback && change.rollback.data) || {};
  let backup = data.backup || null;
  if (!backup && ctx.run) backup = ctx.run.backupPath(contained.rel);
  if (!backup || !existsSync(backup)) {
    return { change: transition(change, 'failed', { error: 'no backup for ' + contained.rel + ' — restore it from version control' }), ok: false };
  }
  copyFileSync(backup, contained.abs);
  if (ctx.run) ctx.run.log({ event: 'rollback', adapter: ADAPTER, change: change.id, file: contained.rel });
  return { change: transition(change, 'rolled_back'), ok: true, file: contained.abs, backup };
}

// ---------------------------------------------------------------------------
// CLI

function loadRun(args, dataDir) {
  if (args.run && args.run !== true) return loadFixRun(String(args.run), { dataDir });
  return null;
}

function pickChanges(run, args) {
  const plan = run ? run.readPlan() : null;
  const all = plan && Array.isArray(plan.changes) ? plan.changes : [];
  const mine = all.filter((c) => c.adapter === ADAPTER);
  if (args.change && args.change !== true) {
    const wanted = new Set((Array.isArray(args.change) ? args.change : [args.change]).map(String));
    return mine.filter((c) => wanted.has(c.id));
  }
  return mine;
}

function persist(run, updated) {
  if (!run) return;
  const plan = run.readPlan();
  if (!plan || !Array.isArray(plan.changes)) return;
  const byId = new Map(updated.map((c) => [c.id, c]));
  plan.changes = plan.changes.map((c) => (byId.has(c.id) ? byId.get(c.id) : c));
  run.setChanges(plan.changes);
}

export async function main(args = {}) {
  const op = String((args._ && args._[0]) || '').trim();
  if (!OPS.includes(op)) return { result: { error: 'usage: local-files <' + OPS.join('|') + '> --run <dir> [--change <id>] [--ticket <t>]' }, code: EXIT.USAGE };
  const dataDir = resolveDataDir(args);
  const project = args.project && args.project !== true ? resolve(String(args.project)) : null;
  const ctx = {
    dataDir, project, env: process.env, now: () => new Date(),
    devUrl: args['dev-url'] && args['dev-url'] !== true ? String(args['dev-url']) : null,
  };

  if (op === 'capabilities') return { result: await capabilities(ctx), code: EXIT.OK };

  if (op === 'plan') {
    if (!args.report || args.report === true) return { result: { error: 'plan needs --report <report.json>' }, code: EXIT.USAGE };
    const report = readJson(String(args.report), null);
    if (!report) return { result: { error: 'cannot read report: ' + args.report }, code: EXIT.USAGE };
    const run = loadRun(args, dataDir) || openFixRun(dataDir, { report: String(args.report), profile: args.profile && args.profile !== true ? String(args.profile) : null, target: report.target || null, adapters: [ADAPTER] });
    ctx.run = run;
    const out = await plan({
      report, profile: args.profile && args.profile !== true ? String(args.profile) : null,
      project: project || (report.target && report.target.kind === 'path' ? report.target.value : null),
      category: args.category === true ? null : args.category,
      includeProposed: args['include-proposed'] === true,
      answers: args.answers,
    }, ctx);
    if (out.changes.length) {
      const planFile = run.readPlan() || { changes: [] };
      const others = (planFile.changes || []).filter((c) => c.adapter !== ADAPTER);
      run.setChanges([...others, ...out.changes]);
      for (const c of out.changes) {
        if (c.preview && c.preview.body) writeText(run.previewPath(c.id, c.preview.kind === 'diff' ? '.diff' : '.txt'), c.preview.body);
      }
    }
    run.log({ event: 'plan', adapter: ADAPTER, changes: out.changes.length, skipped: out.skipped.length });
    return { result: { ...out, run: run.id, run_dir: run.dir }, code: out.ready ? EXIT.OK : EXIT.USAGE };
  }

  const run = loadRun(args, dataDir);
  if (!run) return { result: { error: op + ' needs --run <fix-run-dir>' }, code: EXIT.USAGE };
  ctx.run = run;
  const changes = pickChanges(run, args);
  if (!changes.length) return { result: { error: 'no ' + ADAPTER + ' changes in ' + run.dir + (args.change ? ' matching --change ' + args.change : '') }, code: EXIT.USAGE };

  const results = [];
  const updated = [];
  for (const change of changes) {
    if (op === 'apply') {
      const gate = requireTicket(dataDir, { ticket: args.ticket, run: run.id, change: change.id });
      if (!gate.ok) {
        results.push({ change: change.id, ok: false, refused: gate.reason, error: 'apply needs a valid confirmation ticket (' + gate.reason + ')' });
        continue;
      }
    }
    const fn = { preview, apply, verify, rollback }[op];
    let out;
    try { out = await fn(change, ctx); }
    catch (e) { out = opThrew(change, e); }
    if (out.change) updated.push(out.change);
    results.push({ change: change.id, status: out.change ? out.change.status : change.status, ok: out.ok, ...(out.error ? { error: out.error } : {}), ...(out.checks ? { checks: out.checks } : {}), ...(out.reason ? { reason: out.reason } : {}), ...(out.note ? { note: out.note } : {}), ...(out.drifted ? { drifted: true } : {}) });
  }
  persist(run, updated);
  logOpEvent(run, { op, adapter: ADAPTER, results });
  updateManifest(run, { op, adapter: ADAPTER, changes: updated });
  const failed = results.some((r) => r.ok === false);
  return { result: { adapter: ADAPTER, op, run: run.id, run_dir: run.dir, results }, code: failed ? EXIT.RUNTIME : EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);

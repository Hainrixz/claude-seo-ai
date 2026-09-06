#!/usr/bin/env node
// Compare audit runs: a baseline against a re-run, staging against production, a small set of
// competitors, or a content-gap matrix against the pages a search engine returned for a query.
//
// Usage:
//   node compare.mjs --baseline <ref> --against <ref> [--mode auto|baseline|staging|competitor|gap]
//        [--map staging.example.com=example.com] [--no-host-normalize] [--out <runs root>]
//        [--data] [--format json|md] [--fail-on-regression] [--set-baseline]
//   node compare.mjs <refA> <refB> [<refC> …]              (2-5 refs; 3+ is the competitor matrix)
//   node compare.mjs --prod <ref> --staging <ref>          (staging alias of the pairwise form)
//   node compare.mjs --subject <ref> --set <ref,…> --query "<q>" --mode gap
//
// <ref> = a run directory | a report.json | `latest[:<host>]` | `baseline[:<host>]` | a URL.
// A URL with no run is audited first (audit.mjs, deterministic checks, --pages 3 --render static),
// so `compare` never invents data it did not measure.
//
// Mode `auto`: same host on both sides → baseline; two hosts joined by --map or by a staging-looking
// hostname (staging.*, *preview*, *.vercel.app, *.myshopify.com) → staging; anything else →
// competitor. Competitor and gap modes never diff findings: two different sites do not share a
// finding identity, and pretending they do would fabricate "fixed"/"regressed" rows.
//
// Writes <root>/compare/<a>__<b>/compare.json (and compare.md with --format md). Stdout is a compact
// summary; --data prints the whole document.
//
// Exit codes: 0 ok · 1 usage · 2 runtime (a ref could not be acquired) · 3 --fail-on-regression
// tripped (a finding got worse, or an axis lost more than 2 points).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { EXIT, isMain, runCli } from './lib/util.mjs';
import {
  isHttpUrl, looksLikeHost, pluginVersion, readJson, resolveRootInfo, resolveRunRef, setBaseline,
  sha1, writeJson, writeText,
} from './lib/store.mjs';
import { normalizeUrl } from './lib/urlnorm.mjs';
import { isSoftHtml404 } from './lib/site.mjs';
import { band } from './lib/bands.mjs';
import { tokenize } from './lib/html.mjs';
import { classifyNumbers, contentMask, passages, wordCount } from './lib/passages.mjs';
import { detectLang, hostnameOf, isAuthorityHost } from './lib/lang.mjs';
import { analyzeAnswerBlocks } from './check-answerblocks.mjs';
import { main as auditMain } from './audit.mjs';

/** Schema version of compare.json. */
export const COMPARE_VERSION = 1;
export const MODES = Object.freeze(['auto', 'baseline', 'staging', 'competitor', 'gap']);
export const FORMATS = Object.freeze(['json', 'md']);
/** Refs accepted by the competitor matrix (the subject plus four rivals). */
export const MAX_REFS = 5;
/** Page JSONs read per run for the gap metrics (all of them are cheap; the HTML pass is not). */
export const MAX_PAGES_READ = 100;
/** Pages whose HTML is re-analysed per run (answer blocks, numeric facts, capitalized terms). */
export const GAP_PAGE_LIMIT = 8;
/** Biggest page body the HTML pass will read. */
export const MAX_HTML_BYTES = 2 * 1024 * 1024;
/** Axis keys in report.json paired with their short name. */
export const AXES = Object.freeze([['search_seo', 'search'], ['ai_visibility', 'ai']]);
/** An axis that drops more than this many points is a regression for --fail-on-regression. */
export const REGRESSION_DELTA = -2;
/** Hostnames that read as a non-production deployment of another host. */
export const STAGING_HOST_PATTERNS = Object.freeze([/^staging[.-]/i, /(^|[.-])preview([.-]|$)/i, /\.vercel\.app$/i, /\.myshopify\.com$/i]);
/** Ordering of finding statuses by how bad they are. Gated statuses are deliberately absent. */
export const STATUS_RANK = Object.freeze({ fail: 3, warn: 2, pass: 1, not_applicable: 0 });
/** Statuses that mean "not measured": they are reported as coverage changes, never as fixed/regressed. */
export const GATED_STATUSES = Object.freeze(['needs_api', 'manual_review']);
/** Pages the audit acquires when a bare URL is passed as a ref. */
export const URL_AUDIT_PAGES = 3;

const USAGE = 'node compare.mjs --baseline <ref> --against <ref> [--mode auto|baseline|staging|competitor|gap] [--map a=b] [--format json|md] [--fail-on-regression] [--set-baseline] · node compare.mjs <refA> <refB> [<refC>…] · node compare.mjs --subject <ref> --set <ref,…> --query "<q>" --mode gap';

class UsageError extends Error {}
const msg = (e) => String((e && e.message) || e);
const usageResult = (error) => ({ result: { error, usage: USAGE }, code: EXIT.USAGE });
const uniq = (list) => [...new Set(list)];
const round1 = (n) => (n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 10) / 10);
const round2 = (n) => (n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 100) / 100);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Median of a numeric list (null for an empty list). */
export function median(list) {
  const xs = (list || []).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : round2((xs[mid - 1] + xs[mid]) / 2);
}

function delta(a, b) {
  const x = num(a); const y = num(b);
  return x === null || y === null ? null : round1(y - x);
}

/* ------------------------------------------------------------------ options */

/** Parse repeated `--map from=to` flags into a lower-cased { fromHost: toHost } rewrite table. */
export function parseMap(value) {
  const out = {};
  if (value === undefined || value === false) return out;
  if (value === true) throw new UsageError('--map needs a pair, e.g. --map staging.example.com=example.com');
  for (const raw of [].concat(value)) {
    for (const part of String(raw).split(',')) {
      const bit = part.trim();
      if (!bit) continue;
      const eq = bit.indexOf('=');
      if (eq < 1 || eq === bit.length - 1) throw new UsageError('--map expects <from-host>=<to-host>, got "' + bit + '"');
      const from = bit.slice(0, eq).trim().toLowerCase();
      const to = bit.slice(eq + 1).trim().toLowerCase();
      if (!from || !to) throw new UsageError('--map expects <from-host>=<to-host>, got "' + bit + '"');
      out[from] = to;
    }
  }
  return out;
}

/** Split a repeated / comma-separated `--set` flag into refs. */
export function splitRefs(value) {
  const out = [];
  if (value === undefined || value === false) return out;
  if (value === true) throw new UsageError('--set needs at least one reference');
  for (const raw of [].concat(value)) for (const part of String(raw).split(',')) { const s = part.trim(); if (s) out.push(s); }
  return out;
}

export function readOptions(args = {}) {
  const str = (k) => (typeof args[k] === 'string' && args[k].trim() ? args[k].trim() : undefined);
  const oneOf = (k, list, def) => {
    const v = args[k];
    if (v === undefined || v === true) return def;
    const s = String(v).toLowerCase();
    if (!list.includes(s)) throw new UsageError('--' + k + ' must be one of ' + list.join('|'));
    return s;
  };
  const gapQuery = args.gap !== undefined && args.gap !== true && args.gap !== false ? String(args.gap).trim() : undefined;
  const mode = oneOf('mode', MODES, gapQuery ? 'gap' : 'auto');
  return {
    mode,
    query: str('query') || gapQuery || null,
    map: parseMap(args.map),
    hostNormalize: args['host-normalize'] !== false,
    out: str('out'),
    data: args.data === true,
    format: oneOf('format', FORMATS, 'json'),
    failOnRegression: args['fail-on-regression'] === true || args['fail-on-regression'] === 'true',
    setBaseline: args['set-baseline'] === true || args['set-baseline'] === 'true',
    lang: oneOf('lang', ['en', 'es'], 'en'),
    pages: URL_AUDIT_PAGES,
    quiet: args.quiet === true,
  };
}

/**
 * Collect the references to compare from every accepted flag shape.
 * @returns {{refs: string[], subject: string|null, set: string[], shape: 'pairwise'|'list'|'gap'}}
 */
export function collectRefs(args = {}, o = {}) {
  const positional = (Array.isArray(args._) ? args._ : []).map((x) => String(x).trim()).filter(Boolean);
  const subject = typeof args.subject === 'string' && args.subject.trim() ? args.subject.trim() : null;
  const set = splitRefs(args.set);
  if (subject || set.length || o.mode === 'gap') {
    const subj = subject || positional[0] || null;
    const rivals = set.length ? set : positional.slice(subject ? 0 : 1);
    if (!subj) throw new UsageError('gap mode needs --subject <ref>');
    if (!rivals.length) throw new UsageError('gap mode needs --set <ref,…> (the comparison pages for the query)');
    return { refs: [subj, ...rivals], subject: subj, set: rivals, shape: 'gap' };
  }
  const baseline = typeof args.baseline === 'string' && args.baseline.trim() ? args.baseline.trim() : null;
  const against = typeof args.against === 'string' && args.against.trim() ? args.against.trim() : null;
  const prod = typeof args.prod === 'string' && args.prod.trim() ? args.prod.trim() : null;
  const staging = typeof args.staging === 'string' && args.staging.trim() ? args.staging.trim() : null;
  if (baseline || against) {
    if (!baseline || !against) throw new UsageError('--baseline and --against are used together (--baseline latest --against <url|run>)');
    return { refs: [baseline, against], subject: null, set: [], shape: 'pairwise' };
  }
  if (prod || staging) {
    if (!prod || !staging) throw new UsageError('--prod and --staging are used together (--prod <url|run> --staging <url|run>)');
    return { refs: [prod, staging], subject: null, set: [], shape: 'pairwise' };
  }
  if (positional.length < 2) throw new UsageError('give two references to compare (run dir, report.json, latest[:host], baseline[:host] or a URL)');
  if (positional.length > MAX_REFS) throw new UsageError('at most ' + MAX_REFS + ' references can be compared at once (got ' + positional.length + ')');
  return { refs: positional, subject: null, set: [], shape: 'list' };
}

/* ------------------------------------------------------------------ references */

/** Does this ref look like something we should audit rather than read from disk? */
export function looksLikeUrlRef(ref) {
  const s = String(ref || '').trim();
  if (!s) return false;
  if (/^(latest|baseline)(:|$)/i.test(s)) return false;
  if (isHttpUrl(s)) return true;
  if (existsSync(resolve(s))) return false;
  return looksLikeHost(s);
}

/**
 * Resolve one reference to a run on disk, auditing a URL first when it has no run yet.
 * @returns {Promise<{ok, resolved?, audited?, error?, code?}>}
 */
export async function resolveRef(ref, root, o = {}, deps = {}) {
  const audit = deps.auditMain || auditMain;
  const direct = resolveRunRef(ref, root);
  // A path can resolve to something that is not a run (a host directory, a content folder): only a
  // directory that actually holds a run is accepted, so a bare hostname still reaches the audit path.
  const runLike = !!direct && (isFile(join(direct.dir, 'report.json')) || direct.pages_count > 0 || isFile(join(direct.dir, 'crawl.json')));
  if (runLike) return { ok: true, resolved: direct, audited: false };
  if (!looksLikeUrlRef(ref)) {
    const pointer = /^(latest|baseline)(:|$)/i.exec(String(ref).trim());
    let error;
    if (direct) error = '"' + ref + '" resolved to ' + direct.dir + ', which holds no report.json, crawl.json or page snapshot — it is not an audit run';
    else if (pointer) error = 'no ' + pointer[1].toLowerCase() + ' run is recorded under ' + root + ' — run audit.mjs on the site first' + (pointer[1].toLowerCase() === 'baseline' ? ', then compare with --set-baseline' : '');
    else error = 'cannot resolve "' + ref + '": expected a run directory, a report.json, latest[:<host>], baseline[:<host>] or a URL';
    return { ok: false, code: EXIT.USAGE, error };
  }
  const url = isHttpUrl(ref) ? ref : 'https://' + String(ref).replace(/^\/+/, '');
  const r = await audit({ _: [url], out: root, pages: o.pages || URL_AUDIT_PAGES, render: 'static', checks: 'deterministic', lang: o.lang || 'en', quiet: true });
  const runDir = r && r.result && r.result.run_dir ? r.result.run_dir : null;
  if (!runDir || (r.code !== EXIT.OK && r.code !== EXIT.THRESHOLD)) {
    return { ok: false, code: EXIT.RUNTIME, error: 'could not audit ' + url + ': ' + ((r && r.result && r.result.error) || 'audit failed'), detail: r && r.result ? r.result.detail : null };
  }
  const resolved = resolveRunRef(runDir, root);
  if (!resolved) return { ok: false, code: EXIT.RUNTIME, error: 'audit of ' + url + ' produced no readable run directory (' + runDir + ')' };
  return { ok: true, resolved, audited: true, audit_summary: { url, run_dir: runDir, pages: o.pages || URL_AUDIT_PAGES, checks: 'deterministic' } };
}

/* ------------------------------------------------------------------ loading a side */

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const posix = (p) => String(p || '').split('\\').join('/');

/** Longest shared directory prefix of a list of paths (used to align two local runs). */
export function commonPathPrefix(paths) {
  const lists = (paths || []).filter(Boolean).map((p) => posix(p).split('/'));
  if (lists.length < 2) return lists.length === 1 ? lists[0].slice(0, -1).join('/') : '';
  let i = 0;
  for (; i < lists[0].length - 1; i++) {
    const seg = lists[0][i];
    if (!lists.every((l) => l.length > i + 1 && l[i] === seg)) break;
  }
  return lists[0].slice(0, i).join('/');
}

/** Page snapshots of a run, homepage/target first, ignoring the `--ua` variants. */
function listPageSnapshots(runDir, crawl) {
  const seen = new Set();
  const out = [];
  const push = (file, entry) => {
    const abs = resolve(runDir, file);
    if (seen.has(abs) || !isFile(abs)) return;
    seen.add(abs);
    const snap = readJson(abs, null);
    if (!snap || !Number.isInteger(snap.snapshot_version)) return;
    out.push({ path: abs, snapshot: snap, entry: entry || null });
  };
  const rank = { homepage: 0, target: 1, sample: 2 };
  const pages = crawl && Array.isArray(crawl.pages) ? [...crawl.pages] : [];
  pages.sort((a, b) => (rank[a.role] === undefined ? 3 : rank[a.role]) - (rank[b.role] === undefined ? 3 : rank[b.role]));
  for (const p of pages) if (p && p.snapshot) push(join(runDir, p.snapshot), p);
  const dir = join(runDir, 'pages');
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json') && !/\.ua-/.test(n)).sort(); } catch { names = []; }
  for (const n of names) { if (out.length >= MAX_PAGES_READ) break; push(join(dir, n), null); }
  return out.slice(0, MAX_PAGES_READ);
}

function snapshotHtml(runDir, snap) {
  if (snap && snap.html_inline && typeof snap.html_inline.raw === 'string') return snap.html_inline.raw;
  if (snap && snap.raw_html_path) {
    const abs = resolve(runDir, snap.raw_html_path);
    try { if (statSync(abs).size > MAX_HTML_BYTES) return null; return readFileSync(abs, 'utf8'); } catch { return null; }
  }
  return null;
}

const stripWords = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'your', 'our', 'you', 'are', 'was', 'not', 'los', 'las', 'una', 'unos', 'unas', 'con', 'para', 'que', 'del', 'por']);

/**
 * Capitalized one-to-three-word terms of the page text — a proper-noun proxy, never a claim about
 * entities. A single capitalized word that opens a sentence is ordinary sentence case, so it is
 * skipped; two capitalized words in a row are kept wherever they sit.
 */
export function capitalizedTerms(text, { limit = 200 } = {}) {
  const counts = new Map();
  const s = String(text || '');
  const re = /[A-ZÁÉÍÓÚÑÜ][\p{Ll}]{2,}(?:\s+[A-ZÁÉÍÓÚÑÜ][\p{Ll}]{2,}){0,2}/gu;
  let m;
  while ((m = re.exec(s)) && counts.size < limit * 4) {
    const term = m[0];
    const words = term.split(/\s+/);
    const prev = s.slice(0, m.index).replace(/\s+$/, '');
    const sentenceInitial = prev === '' || /[.!?¿¡:;]$/.test(prev);
    if (sentenceInitial && words.length < 2) continue;
    if (stripWords.has(words[0].toLowerCase())) continue;
    const key = term.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/** Normalized heading text used as a "topic" key (lower-cased, punctuation-free, collapsed). */
export function topicKey(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Aggregate the deterministic, comparable facts of one run's pages.
 *
 * Everything read from the parsed snapshot (schema types, heading topics, word counts, hreflang,
 * render mode, outbound hosts) covers every page of the run. The language-dependent counts
 * (answer blocks, numeric facts, capitalized terms) need the page body, which is only re-read for
 * the first GAP_PAGE_LIMIT pages — so those sections carry their own `pages` count and must be
 * reported against it, never against the run's page total.
 */
export function sideMetrics(pageData) {
  const schema = new Map();
  const topics = new Map();
  const words = [];
  const langs = new Set();
  let hreflangPages = 0;
  const renderUsed = {};
  let renderNeeded = 0;
  const authority = new Set();
  const external = new Set();
  const terms = new Map();
  const answer = { pages: 0, question_headings: 0, direct_answers: 0, tldr_pages: 0, evaluated_pages: 0, unsupported_language_pages: 0 };
  const numeric = { pages: 0, densities: [], substantive: 0, content_words: 0 };

  for (const p of pageData || []) {
    const parsed = p.parsed || {};
    for (const block of parsed.jsonld || []) for (const t of [].concat(block && block.type ? block.type : [])) if (t) schema.set(String(t), (schema.get(String(t)) || 0) + 1);
    for (const h of parsed.headings || []) {
      if (!h || h.level < 2 || h.level > 4 || h.aria) continue;
      const key = topicKey(h.text);
      if (key.length < 4) continue;
      if (!topics.has(key)) topics.set(key, { topic: key, text: String(h.text || '').slice(0, 120), pages: 0 });
      topics.get(key).pages++;
    }
    if (Number.isFinite(parsed.word_count)) words.push(parsed.word_count);
    const alternates = (parsed.hreflang || []).concat(((p.snapshot && p.snapshot.header_links && p.snapshot.header_links.alternates) || []));
    if (alternates.length) hreflangPages++;
    for (const a of alternates) if (a && a.hreflang) langs.add(String(a.hreflang).toLowerCase());
    const used = (p.snapshot && p.snapshot.render && p.snapshot.render.used) || 'none';
    renderUsed[used] = (renderUsed[used] || 0) + 1;
    if (p.snapshot && p.snapshot.render && p.snapshot.render.needed) renderNeeded++;
    const pageHost = hostnameOf(p.url || '');
    for (const a of parsed.anchors || []) {
      if (!a || a.scheme !== 'http' || !a.abs) continue;
      const host = hostnameOf(a.abs);
      if (!host || (pageHost && host === pageHost)) continue;
      external.add(host);
      if (isAuthorityHost(host)) authority.add(host);
    }
    if (p.text_metrics) {
      const t = p.text_metrics;
      answer.pages++;
      if (t.answer) {
        if (t.answer.question_headings === null) answer.unsupported_language_pages++;
        else {
          answer.evaluated_pages++;
          answer.question_headings += t.answer.question_headings;
          answer.direct_answers += t.answer.question_headings - t.answer.question_headings_without_direct_answer;
          if (t.answer.has_tldr_or_summary === true) answer.tldr_pages++;
        }
      }
      if (t.numbers) {
        numeric.pages++;
        numeric.substantive += t.numbers.substantive;
        numeric.content_words += t.numbers.content_words;
        if (t.numbers.content_words > 0) numeric.densities.push(round2(100 * t.numbers.substantive / t.numbers.content_words));
      }
      for (const [term, n] of t.terms || []) terms.set(term, (terms.get(term) || 0) + n);
    }
  }

  return {
    pages: (pageData || []).length,
    schema_types: [...schema.keys()].sort(),
    schema_counts: Object.fromEntries([...schema.entries()].sort()),
    heading_topics: [...topics.values()].sort((a, b) => b.pages - a.pages || (a.topic < b.topic ? -1 : 1)),
    word_count: { median: median(words), mean: words.length ? round1(words.reduce((s, n) => s + n, 0) / words.length) : null, pages: words.length },
    hreflang: { pages_with_hreflang: hreflangPages, langs: [...langs].sort() },
    render: { used: renderUsed, needed_pages: renderNeeded, pages: (pageData || []).length },
    entity_links: { authority_hosts: [...authority].sort(), external_hosts: external.size },
    answer_blocks: answer,
    numeric_facts: {
      pages: numeric.pages,
      substantive_numbers: numeric.substantive,
      content_words: numeric.content_words,
      per_100w: numeric.content_words ? round2(100 * numeric.substantive / numeric.content_words) : null,
      median_per_100w: median(numeric.densities),
    },
    terms,
  };
}

/**
 * Read everything `compare` needs from one resolved reference.
 *
 * `report.json` is required whenever scores are compared; gap analysis runs on snapshot-only runs
 * (`snapshot.mjs --run gap-<slug>`), so `requireReport: false` accepts a run with pages and no report.
 * @returns {{ok, side?, error?, code?}}
 */
export function loadSide(resolved, o = {}) {
  if (!resolved || !resolved.dir) return { ok: false, code: EXIT.USAGE, error: 'unresolved reference' };
  const runDir = resolved.dir;
  // The run directory itself is authoritative: lib/store describeRun() files both report.json and
  // report.md under the same key, so `resolved.report_json` can name the markdown.
  const onDisk = join(runDir, 'report.json');
  const fromRef = typeof resolved.report_json === 'string' && /\.json$/i.test(resolved.report_json) ? resolved.report_json : null;
  const reportPath = isFile(onDisk) ? onDisk : (fromRef && isFile(fromRef) ? fromRef : null);
  const report = reportPath ? readJson(reportPath, null) : null;
  const requireReport = o.requireReport !== false;
  if (!report && requireReport) {
    return { ok: false, code: EXIT.USAGE, error: 'no readable report.json in ' + runDir + ' — run `audit.mjs "' + runDir + '"` first so there is something to compare' };
  }
  const warnings = [];
  if (!report) warnings.push('no report.json in ' + runDir + ': this reference contributes page structure only, no scores or findings');
  const crawl = readJson(join(runDir, 'crawl.json'), null);
  const site = {
    robots: readJson(join(runDir, 'site', 'robots.json'), null),
    sitemaps: readJson(join(runDir, 'site', 'sitemaps.json'), null),
    discovery: readJson(join(runDir, 'site', 'discovery.json'), null),
  };

  const snapshots = listPageSnapshots(runDir, crawl);
  const dataAvailable = snapshots.length > 0;
  if (!dataAvailable) warnings.push('no page snapshots under ' + runDir + '/pages: the structural gap sections are unavailable for this side');

  const pageData = snapshots.map((s) => {
    const t = s.snapshot.target || {};
    return {
      url: t.final_url || t.requested_url || t.value || null,
      slug: t.slug || null,
      role: s.entry ? s.entry.role : null,
      template: s.entry ? s.entry.template : null,
      parsed: s.snapshot.parsed || {},
      snapshot: s.snapshot,
      snapshot_path: s.path,
      text_metrics: null,
    };
  });

  const limit = o.htmlLimit === undefined ? GAP_PAGE_LIMIT : o.htmlLimit;
  for (const p of pageData.slice(0, Math.max(0, limit))) {
    const html = snapshotHtml(runDir, p.snapshot);
    if (html == null) continue;
    try { p.text_metrics = textMetrics(html, p.url, p.parsed); }
    catch (e) { warnings.push('could not analyse ' + (p.url || p.slug) + ': ' + msg(e)); }
  }

  const paths = pageData.map((p) => p.url).filter((u) => u && u.startsWith('file:'));
  const filePrefix = paths.length ? commonPathPrefix(paths.map((u) => u.replace(/^file:\/\//, ''))) : '';

  const target = report && report.target ? report.target : deriveTarget(crawl, pageData);
  const host = target.host || hostOf(target.value) || null;
  const side = {
    ref: resolved.ref,
    kind: resolved.kind,
    run_dir: runDir,
    run_id: (report && report.run_id) || (crawl && crawl.run_id) || resolved.run_id || basename(runDir),
    host_key: resolved.host_key || null,
    host,
    label: host || basename(String(target.value || runDir)) || basename(runDir),
    target: target.value || null,
    target_kind: target.kind || null,
    generated_at: (report && report.generated_at) || (crawl && crawl.generated_at) || null,
    coverage: (report && report.coverage && report.coverage.mode) || null,
    plugin_version: (report && report.plugin_version) || null,
    tier: report && report.tier !== undefined ? report.tier : null,
    scores: (report && report.scores) || {},
    pages_scored: report && Array.isArray(report.pages) ? report.pages : [],
    findings: report && Array.isArray(report.findings) ? report.findings : [],
    report_json: report ? reportPath : null,
    report: report || null,
    crawl,
    site,
    page_data: pageData,
    data_available: dataAvailable,
    file_prefix: filePrefix,
    warnings,
  };
  side.metrics = sideMetrics(pageData);
  return { ok: true, side };
}

/** Language-aware text facts of one page (answer blocks, numbers, capitalized terms). */
export function textMetrics(html, url, parsed) {
  const tokens = tokenize(html);
  const mask = contentMask(tokens);
  const text = passages(tokens, { mask }).map((p) => p.text).join(' ');
  const det = detectLang(tokens, { doc: parsed && parsed.lang !== undefined ? parsed : undefined });
  const lang = det.supported ? det.lang : null;
  const numbers = classifyNumbers(text, { lang });
  let answer = null;
  try { answer = analyzeAnswerBlocks(html, { url: url || null }); }
  catch { answer = null; }
  return {
    lang: det.tag || null,
    numbers: { substantive: numbers.substantive, all: numbers.all, content_words: wordCount(text) },
    answer: answer ? {
      question_headings: answer.question_headings,
      question_headings_without_direct_answer: answer.question_headings_without_direct_answer || 0,
      has_tldr_or_summary: answer.has_tldr_or_summary,
    } : null,
    terms: [...capitalizedTerms(text).entries()],
  };
}

function hostOf(value) {
  const s = String(value || '');
  if (!isHttpUrl(s)) return null;
  try { return new URL(s).hostname.toLowerCase(); } catch { return null; }
}

/** Target of a run that has no report.json (a snapshot-only gap run): crawl manifest, else page 1. */
function deriveTarget(crawl, pageData) {
  if (crawl && crawl.target) return { kind: isHttpUrl(crawl.target) ? 'url' : 'path', value: crawl.target, host: crawl.host || hostOf(crawl.target) || undefined };
  const first = (pageData || [])[0];
  const value = first ? first.url : null;
  return { kind: value && isHttpUrl(value) ? 'url' : 'path', value, host: hostOf(value) || undefined };
}

/* ------------------------------------------------------------------ mode */

/** Does this hostname read as a non-production deployment? */
export function looksLikeStagingHost(host) {
  const h = String(host || '').toLowerCase();
  return !!h && STAGING_HOST_PATTERNS.some((re) => re.test(h));
}

/**
 * Decide the comparison mode and the host rewrite table that goes with it.
 * Same host → baseline. Two hosts joined by --map, or one that looks like a staging deployment of
 * the other → staging (the staging host is rewritten onto the production one so locations line up).
 * Anything else → competitor.
 */
export function resolveMode(sides, o = {}) {
  const explicit = o.mode && o.mode !== 'auto' ? o.mode : null;
  const map = { ...(o.map || {}) };
  if (sides.length > 2) {
    const mode = explicit === 'gap' ? 'gap' : 'competitor';
    const overridden = explicit && explicit !== mode ? ' (--mode ' + explicit + ' does not apply to more than two references)' : '';
    return { mode, map, reason: sides.length + ' references: competitor matrix' + overridden };
  }
  const [a, b] = sides;
  const hostA = (a && a.host) || null;
  const hostB = (b && b.host) || null;
  const bare = (h) => String(h || '').replace(/^www\./, '');
  const mappedA = map[String(hostA || '').toLowerCase()] || hostA;
  const mappedB = map[String(hostB || '').toLowerCase()] || hostB;
  const sameTarget = !hostA && !hostB && a && b && a.target && b.target && a.target === b.target;
  // The raw hosts decide "same site": a --map is the user saying two *different* hosts serve the
  // same pages, which is the definition of a staging comparison, not of a baseline one.
  const sameHost = (hostA && hostB && bare(hostA) === bare(hostB)) || sameTarget;

  let mode = explicit;
  let reason;
  if (!mode) {
    if (sameHost) { mode = 'baseline'; reason = sameTarget ? 'both runs target the same path' : 'both runs target ' + bare(mappedA); }
    else if (Object.keys(map).length) { mode = 'staging'; reason = 'two hosts joined by --map'; }
    else if (looksLikeStagingHost(hostA) || looksLikeStagingHost(hostB)) { mode = 'staging'; reason = 'one host looks like a non-production deployment'; }
    else { mode = 'competitor'; reason = 'two different hosts and no --map: compared as separate sites'; }
  } else reason = 'set with --mode ' + mode;

  if (mode === 'staging' && hostA && hostB && bare(mappedA) !== bare(mappedB)) {
    // Rewrite the staging host onto the production one so the same page has the same location key.
    const stagingSide = looksLikeStagingHost(hostB) || !looksLikeStagingHost(hostA) ? hostB : hostA;
    const prodSide = stagingSide === hostB ? hostA : hostB;
    if (!map[String(stagingSide).toLowerCase()]) map[String(stagingSide).toLowerCase()] = String(prodSide).toLowerCase();
  }
  return { mode, map, reason };
}

/* ------------------------------------------------------------------ locations */

/** Location key used to match findings across runs: normalized URL/file plus the selector. */
export function normalizeLocation(location, opts = {}) {
  const { map = {}, hostNormalize = true, stripPrefix = '' } = opts;
  const loc = location && typeof location === 'object' ? location : {};
  const parts = [];
  const rewriteHost = (host) => {
    const h = String(host || '').toLowerCase();
    return map[h] || map[h.replace(/^www\./, '')] || h;
  };
  if (loc.url) {
    const raw = String(loc.url);
    const norm = normalizeUrl(raw, { stripTrailingSlash: true, stripWww: hostNormalize, dropIndex: true });
    if (norm) {
      try {
        const u = new URL(norm);
        u.hostname = rewriteHost(u.hostname);
        if (hostNormalize) u.hostname = u.hostname.replace(/^www\./, '');
        parts.push('url:' + u.host + u.pathname + u.search);
      } catch { parts.push('url:' + raw.toLowerCase()); }
    } else {
      parts.push('url:' + stripLocalPrefix(raw.replace(/^file:\/\//i, ''), stripPrefix));
    }
  } else if (loc.file) {
    parts.push('file:' + stripLocalPrefix(posix(loc.file), stripPrefix));
  } else if (loc.resource) {
    parts.push('resource:' + String(loc.resource));
  } else {
    parts.push('site');
  }
  if (loc.selector) parts.push('sel:' + String(loc.selector));
  return parts.join('|');
}

function stripLocalPrefix(path, prefix) {
  const p = posix(decodeURIComponentSafe(path));
  if (prefix && p.startsWith(prefix)) return p.slice(prefix.length).replace(/^\/+/, '');
  return p.replace(/^\/+/, '');
}
function decodeURIComponentSafe(s) { try { return decodeURIComponent(String(s)); } catch { return String(s); } }

/** Comparable page path of a scored page (host dropped, local runs aligned on their shared prefix). */
export function pagePath(url, opts = {}) {
  const { stripPrefix = '' } = opts;
  const raw = String(url || '');
  if (!raw) return null;
  if (isHttpUrl(raw)) {
    const norm = normalizeUrl(raw, { stripTrailingSlash: true, stripWww: true, dropIndex: true });
    try { const u = new URL(norm || raw); return (u.pathname || '/') + (u.search || ''); } catch { return raw; }
  }
  return '/' + stripLocalPrefix(raw.replace(/^file:\/\//i, ''), stripPrefix);
}

/* ------------------------------------------------------------------ findings diff */

const isGated = (status) => GATED_STATUSES.includes(status);
const rankOf = (status) => (Object.prototype.hasOwnProperty.call(STATUS_RANK, status) ? STATUS_RANK[status] : null);

function indexFindings(findings, opts) {
  const byKey = new Map();
  const locations = new Set();
  for (const f of findings || []) {
    if (!f || !f.id) continue;
    const loc = normalizeLocation(f.location, opts);
    locations.add(loc);
    const key = f.id + '|' + loc;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, f); continue; }
    const a = rankOf(prev.status); const b = rankOf(f.status);
    if ((b === null ? -1 : b) > (a === null ? -1 : a) || ((a === b) && (Number(f.severity) || 0) > (Number(prev.severity) || 0))) byKey.set(key, f);
  }
  return { byKey, locations };
}

const entryOf = (f, loc) => ({
  id: f.id,
  module: f.module || null,
  title: f.title || null,
  location: loc,
  severity: Number(f.severity) || 0,
  axis: (f.expected_impact && f.expected_impact.axis) || null,
  confidence: (f.expected_impact && f.expected_impact.confidence) || null,
});

/**
 * Diff two finding sets, keyed by `id` + normalized location.
 *
 * Buckets: `fixed` (a problem is gone or now passes), `new` (a problem appeared where the other run
 * saw none), `regressed` (a problem got worse, e.g. warn → fail), `improved` (a problem got milder),
 * `unchanged` (same status). Any transition that involves `needs_api` / `manual_review`, and any
 * finding whose location the other run never visited, lands in `coverage_changes`: not measured is
 * not the same as fixed, and this tool never reports it as one.
 */
export function diffFindings(findingsA, findingsB, opts = {}) {
  const optsA = { map: opts.map, hostNormalize: opts.hostNormalize !== false, stripPrefix: opts.stripPrefixA || '' };
  const optsB = { map: opts.map, hostNormalize: opts.hostNormalize !== false, stripPrefix: opts.stripPrefixB || '' };
  const A = indexFindings(findingsA, optsA);
  const B = indexFindings(findingsB, optsB);
  const out = { fixed: [], new: [], regressed: [], improved: [], unchanged: 0, coverage_changes: [] };

  for (const [key, fa] of A.byKey) {
    const loc = key.slice(fa.id.length + 1);
    const fb = B.byKey.get(key);
    if (!fb) {
      const covered = B.locations.has(loc);
      const ra = rankOf(fa.status);
      if (isGated(fa.status) || !covered) {
        out.coverage_changes.push({ ...entryOf(fa, loc), from: fa.status, to: null, kind: covered ? 'gated_only_in_a' : 'only_in_a', note: covered ? 'not re-checked in the second run' : 'the second run never visited this location' });
      } else if (ra !== null && ra >= STATUS_RANK.warn) {
        out.fixed.push({ ...entryOf(fa, loc), from: fa.status, to: 'absent', note: 'the check no longer reports this problem at a location the second run did visit' });
      } else {
        out.unchanged++;
      }
      continue;
    }
    const ra = rankOf(fa.status);
    const rb = rankOf(fb.status);
    if (ra === null || rb === null) {
      if (fa.status !== fb.status) {
        out.coverage_changes.push({ ...entryOf(fb, loc), from: fa.status, to: fb.status, kind: 'gated_transition', note: 'a gated status on one side: this check was not measured there' });
      } else out.unchanged++;
      continue;
    }
    if (ra === rb) { out.unchanged++; continue; }
    const entry = { ...entryOf(fb, loc), from: fa.status, to: fb.status, severity_from: Number(fa.severity) || 0, severity_to: Number(fb.severity) || 0 };
    if (rb < ra) {
      if (rb <= STATUS_RANK.pass && ra >= STATUS_RANK.warn) out.fixed.push(entry);
      else out.improved.push(entry);
    } else if (ra <= STATUS_RANK.pass && rb >= STATUS_RANK.warn) out.new.push(entry);
    else out.regressed.push(entry);
  }

  for (const [key, fb] of B.byKey) {
    if (A.byKey.has(key)) continue;
    const loc = key.slice(fb.id.length + 1);
    const covered = A.locations.has(loc);
    const rb = rankOf(fb.status);
    if (isGated(fb.status) || !covered) {
      out.coverage_changes.push({ ...entryOf(fb, loc), from: null, to: fb.status, kind: covered ? 'gated_only_in_b' : 'only_in_b', note: covered ? 'not checked in the first run' : 'the first run never visited this location' });
    } else if (rb !== null && rb >= STATUS_RANK.warn) {
      out.new.push({ ...entryOf(fb, loc), from: 'absent', to: fb.status, note: 'a problem the first run did not report at a location it did visit' });
    } else {
      out.unchanged++;
    }
  }

  const bySeverity = (x, y) => (y.severity - x.severity) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  for (const k of ['fixed', 'new', 'regressed', 'improved']) out[k].sort(bySeverity);
  out.coverage_changes.sort(bySeverity);
  return out;
}

/* ------------------------------------------------------------------ scores, categories, pages */

function axisScores(a, b) {
  const out = {};
  for (const [key] of AXES) {
    const sa = (a.scores && a.scores[key]) || {};
    const sb = (b.scores && b.scores[key]) || {};
    out[key] = {
      a: num(sa.value), b: num(sb.value), delta: delta(sa.value, sb.value),
      band_a: sa.band || band(num(sa.value)), band_b: sb.band || band(num(sb.value)),
      state_a: sa.state || null, state_b: sb.state || null,
      provisional_a: sa.provisional === true, provisional_b: sb.provisional === true,
      capped_a: sa.capped === true, capped_b: sb.capped === true,
    };
  }
  return out;
}

/** Per-category deltas. An inactive category scores 0 by construction, so it is reported as null. */
export function categoryDeltas(a, b) {
  const rows = [];
  for (const [key, shortName] of AXES) {
    const ca = ((a.scores && a.scores[key] && a.scores[key].categories) || []);
    const cb = ((b.scores && b.scores[key] && b.scores[key].categories) || []);
    const names = uniq([...ca.map((c) => c.name), ...cb.map((c) => c.name)]);
    for (const name of names) {
      const x = ca.find((c) => c.name === name) || null;
      const y = cb.find((c) => c.name === name) || null;
      const va = x && x.active ? num(x.value) : null;
      const vb = y && y.active ? num(y.value) : null;
      rows.push({
        axis: shortName, name,
        a: va, b: vb, delta: delta(va, vb),
        weight: (x && x.weight) ?? (y && y.weight) ?? null,
        active_a: !!(x && x.active), active_b: !!(y && y.active),
        modules: (x && x.modules) || (y && y.modules) || [],
      });
    }
  }
  rows.sort((p, q) => Math.abs(q.delta || 0) - Math.abs(p.delta || 0) || (p.axis < q.axis ? -1 : p.axis > q.axis ? 1 : p.name < q.name ? -1 : 1));
  return rows;
}

/**
 * Was this page scored in its run? report.json marks a sampled URL that did not answer 2xx with
 * `scorable: false` (scripts/score.mjs isScorablePage); an older report has no such field, so a
 * page with no score value counts as unscored too.
 */
function pageScored(p) {
  if (!p) return false;
  if (p.scorable === false) return false;
  return num(p.search && p.search.value) !== null || num(p.ai && p.ai.value) !== null;
}

const httpStatusOf = (p) => (p && Number.isFinite(Number(p.status)) ? Number(p.status) : null);

/**
 * Per-page score deltas, matched on the normalized path. A page that was scored on one side and
 * unscored on the other (a 200 that came back 429, say) is a COVERAGE change, not a score move:
 * its delta stays null and `coverage_change` says why, so a rate-limited re-crawl can never read
 * as an improvement.
 */
export function pageDeltas(a, b) {
  const keyA = (p) => pagePath(p.url, { stripPrefix: a.file_prefix });
  const keyB = (p) => pagePath(p.url, { stripPrefix: b.file_prefix });
  const mapA = new Map(); for (const p of a.pages_scored) { const k = keyA(p); if (k && !mapA.has(k)) mapA.set(k, p); }
  const mapB = new Map(); for (const p of b.pages_scored) { const k = keyB(p); if (k && !mapB.has(k)) mapB.set(k, p); }
  const sideOf = (p) => ({ url: p.url, search: num(p.search && p.search.value), ai: num(p.ai && p.ai.value), http_status: httpStatusOf(p), scored: pageScored(p) });
  const rows = [];
  for (const [k, pa] of mapA) {
    const pb = mapB.get(k);
    const comparable = !pb || (pageScored(pa) && pageScored(pb));
    const row = {
      path: k, status: pb ? 'matched' : 'only_a',
      role: pa.role || (pb && pb.role) || null,
      a: sideOf(pa),
      b: pb ? sideOf(pb) : null,
      delta: pb && comparable
        ? { search: delta(pa.search && pa.search.value, pb.search && pb.search.value), ai: delta(pa.ai && pa.ai.value, pb.ai && pb.ai.value) }
        : { search: null, ai: null },
    };
    if (pb && !comparable) {
      row.coverage_change = true;
      const from = pageScored(pa) ? 'scored' : 'unscored (' + (httpStatusOf(pa) === null ? 'no status' : 'HTTP ' + httpStatusOf(pa)) + ')';
      const to = pageScored(pb) ? 'scored' : 'unscored (' + (httpStatusOf(pb) === null ? 'no status' : 'HTTP ' + httpStatusOf(pb)) + ')';
      row.coverage_note = from + ' → ' + to + ': the two runs did not measure the same page, so there is no score delta';
    }
    rows.push(row);
  }
  for (const [k, pb] of mapB) {
    if (mapA.has(k)) continue;
    rows.push({
      path: k, status: 'only_b', role: pb.role || null,
      a: null, b: sideOf(pb),
      delta: { search: null, ai: null },
    });
  }
  rows.sort((p, q) => {
    const dp = Math.min(p.delta.search === null ? 0 : p.delta.search, p.delta.ai === null ? 0 : p.delta.ai);
    const dq = Math.min(q.delta.search === null ? 0 : q.delta.search, q.delta.ai === null ? 0 : q.delta.ai);
    return dp - dq || (p.path < q.path ? -1 : 1);
  });
  return rows;
}

/* ------------------------------------------------------------------ gaps */

const UNAVAILABLE = 'unavailable';

/**
 * The discovery endpoints a side actually publishes. `summary.found` already excludes an endpoint
 * that answered 200 with an HTML app shell, but a run captured before that rule existed does not —
 * so the probes are re-checked here too, and a soft 404 never reaches the presence matrix.
 */
function endpointsOf(side) {
  const d = side.site && side.site.discovery;
  if (!d || !d.summary) return null;
  const probes = d.probes && typeof d.probes === 'object' ? d.probes : null;
  const found = (d.summary.found || []).map(String).filter((path) => !(probes && isSoftHtml404(probes[path])));
  return uniq(found).sort();
}

function postureOf(side) {
  const r = side.site && side.site.robots;
  if (!r || !r.ai_posture) return null;
  const out = {};
  for (const [cls, bots] of Object.entries(r.ai_posture)) {
    for (const [name, v] of Object.entries(bots || {})) out[name] = { class: cls, root_allowed: v ? v.root_allowed : null };
  }
  return out;
}

/** Structural differences between two runs, read from the persisted run directories. */
export function structuralGaps(a, b) {
  if (!a.data_available || !b.data_available) {
    const reason = 'one side has no page snapshots (a report.json on its own carries scores and findings, not the page structure)';
    return {
      available: false, reason,
      schema_types: UNAVAILABLE, agentic_endpoints: UNAVAILABLE, ai_crawler_posture: UNAVAILABLE, headings: UNAVAILABLE,
      answer_blocks: UNAVAILABLE, entity_links: UNAVAILABLE, word_count: UNAVAILABLE, render: UNAVAILABLE, hreflang: UNAVAILABLE,
    };
  }
  const ma = a.metrics; const mb = b.metrics;
  const onlyIn = (x, y) => x.filter((v) => !y.includes(v));

  const topicsA = new Set(ma.heading_topics.map((t) => t.topic));
  const topicsB = new Set(mb.heading_topics.map((t) => t.topic));
  const inter = [...topicsA].filter((t) => topicsB.has(t)).length;
  const union = new Set([...topicsA, ...topicsB]).size;

  const ea = endpointsOf(a); const eb = endpointsOf(b);
  const pa = postureOf(a); const pb = postureOf(b);
  let posture = UNAVAILABLE;
  if (pa && pb) {
    const bots = uniq([...Object.keys(pa), ...Object.keys(pb)]).sort();
    const rows = bots.map((name) => ({ bot: name, class: (pa[name] || pb[name]).class, a: pa[name] ? pa[name].root_allowed : null, b: pb[name] ? pb[name].root_allowed : null }));
    posture = {
      bots: rows,
      blocked_only_a: rows.filter((r) => r.a === false && r.b === true).map((r) => r.bot),
      blocked_only_b: rows.filter((r) => r.b === false && r.a === true).map((r) => r.bot),
    };
  }

  return {
    available: true,
    reason: null,
    schema_types: { a: ma.schema_types, b: mb.schema_types, only_a: onlyIn(ma.schema_types, mb.schema_types), only_b: onlyIn(mb.schema_types, ma.schema_types), both: ma.schema_types.filter((t) => mb.schema_types.includes(t)) },
    agentic_endpoints: ea && eb ? { a: ea, b: eb, only_a: onlyIn(ea, eb), only_b: onlyIn(eb, ea) } : UNAVAILABLE,
    ai_crawler_posture: posture,
    headings: {
      overlap_jaccard: union ? round2(inter / union) : null,
      topics_a: topicsA.size, topics_b: topicsB.size,
      only_b_topics: mb.heading_topics.filter((t) => !topicsA.has(t.topic)).slice(0, 25).map((t) => ({ topic: t.topic, text: t.text, pages: t.pages })),
      only_a_topics: ma.heading_topics.filter((t) => !topicsB.has(t.topic)).slice(0, 25).map((t) => ({ topic: t.topic, text: t.text, pages: t.pages })),
    },
    answer_blocks: { a: ma.answer_blocks, b: mb.answer_blocks, delta: { question_headings: ma.answer_blocks.question_headings === null ? null : mb.answer_blocks.question_headings - ma.answer_blocks.question_headings, direct_answers: mb.answer_blocks.direct_answers - ma.answer_blocks.direct_answers } },
    entity_links: { a: ma.entity_links, b: mb.entity_links, only_a: onlyIn(ma.entity_links.authority_hosts, mb.entity_links.authority_hosts), only_b: onlyIn(mb.entity_links.authority_hosts, ma.entity_links.authority_hosts) },
    word_count: { a: ma.word_count, b: mb.word_count, delta_median: delta(ma.word_count.median, mb.word_count.median) },
    render: { a: ma.render, b: mb.render },
    hreflang: { a: ma.hreflang, b: mb.hreflang, only_a_langs: onlyIn(ma.hreflang.langs, mb.hreflang.langs), only_b_langs: onlyIn(mb.hreflang.langs, ma.hreflang.langs) },
  };
}

/* ------------------------------------------------------------------ pairwise compare */

function sideSummary(side) {
  return {
    ref: side.ref, run_id: side.run_id, run_dir: side.run_dir, report_json: side.report_json,
    target: side.target, host: side.host, label: side.label,
    generated_at: side.generated_at, coverage: side.coverage, tier: side.tier,
    pages_scored: side.pages_scored.length, findings: side.findings.length,
    data_available: side.data_available,
  };
}

/**
 * Did the two runs score the same pages? The site score is a weighted mean over the pages that were
 * scored, so a page that dropped out (a 429 interstitial, a URL the second crawl never sampled)
 * moves the axis on its own. Every such page is listed here and the axis delta is marked as not
 * like-for-like — never reported as the site getting better or worse.
 */
export function pageCoverageChanges(rows) {
  const listed = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const aScored = !!(r.a && r.a.scored);
    const bScored = !!(r.b && r.b.scored);
    if (r.status === 'matched') {
      if (aScored === bScored) continue;
      listed.push({ path: r.path, kind: aScored ? 'dropped_from_scoring' : 'added_to_scoring', status_a: r.a.http_status, status_b: r.b.http_status, note: r.coverage_note || null });
    } else if (r.status === 'only_a' && aScored) {
      listed.push({ path: r.path, kind: 'only_a', status_a: r.a.http_status, status_b: null, note: 'scored in the first run only; the second run never sampled it' });
    } else if (r.status === 'only_b' && bScored) {
      listed.push({ path: r.path, kind: 'only_b', status_a: null, status_b: r.b.http_status, note: 'scored in the second run only; the first run never sampled it' });
    }
  }
  const scored_a = (rows || []).filter((r) => r.a && r.a.scored).length;
  const scored_b = (rows || []).filter((r) => r.b && r.b.scored).length;
  return { same_pages: listed.length === 0, scored_a, scored_b, changes: listed };
}

/**
 * Verdict of a pairwise comparison: improved / regressed / mixed / unchanged.
 * With `opts.samePages === false` the axis deltas are left out: the two rollups averaged different
 * page sets, so the movement says something about the sample, not about the site. The findings diff
 * still decides — it is matched location by location and survives a changed sample.
 */
export function verdictOf(scores, findings, opts = {}) {
  let positive = findings.fixed.length + findings.improved.length;
  let negative = findings.new.length + findings.regressed.length;
  const axesComparable = opts.samePages !== false;
  for (const [key] of AXES) {
    const d = axesComparable && scores[key] ? scores[key].delta : null;
    if (d === null) continue;
    if (d > 1) positive++;
    else if (d < -1) negative++;
  }
  if (!positive && !negative) return 'unchanged';
  if (!negative) return 'improved';
  if (!positive) return 'regressed';
  return 'mixed';
}

/**
 * Compare two loaded runs. Pure: everything it reports comes from the two `side` objects.
 * @param {object} a  the reference run (baseline / production)
 * @param {object} b  the run under test (the re-run / staging deploy)
 */
export function compareRuns(a, b, opts = {}) {
  const mode = opts.mode || 'baseline';
  const map = opts.map || {};
  const hostNormalize = opts.hostNormalize !== false;
  const warnings = [...(a.warnings || []), ...(b.warnings || [])];

  const scores = axisScores(a, b);
  const categories = categoryDeltas(a, b);
  const findings = diffFindings(a.findings, b.findings, { map, hostNormalize, stripPrefixA: a.file_prefix, stripPrefixB: b.file_prefix });
  const gaps = structuralGaps(a, b);
  const pages = pageDeltas(a, b);
  const pageCoverage = pageCoverageChanges(pages);

  let coverageWarning = null;
  if (a.coverage && b.coverage && a.coverage !== b.coverage) {
    coverageWarning = 'coverage modes differ (a: ' + a.coverage + ', b: ' + b.coverage + '): the model-judged modules were evaluated on one side only, so their categories and findings are not comparable.';
  } else if (!a.coverage || !b.coverage) {
    coverageWarning = 'one side does not declare a coverage mode; treat category deltas as indicative.';
  }
  for (const [key, shortName] of AXES) {
    const s = scores[key];
    if (s.provisional_a || s.provisional_b) warnings.push('the ' + shortName + ' axis is provisional on ' + (s.provisional_a && s.provisional_b ? 'both runs' : s.provisional_a ? 'the first run' : 'the second run') + ': its band rests on partial coverage, so the delta is indicative.');
  }
  if (mode === 'staging' && !Object.keys(map).length) warnings.push('staging mode without a host map: locations only match when both runs share a hostname.');
  if (!pageCoverage.same_pages) {
    const flips = pageCoverage.changes.filter((c) => c.kind === 'dropped_from_scoring' || c.kind === 'added_to_scoring');
    warnings.push('the two runs did not score the same pages (' + pageCoverage.scored_a + ' vs ' + pageCoverage.scored_b + ' scored: '
      + pageCoverage.changes.slice(0, 5).map((c) => c.path + ' ' + c.kind).join(', ') + (pageCoverage.changes.length > 5 ? ' and ' + (pageCoverage.changes.length - 5) + ' more' : '')
      + '): the site scores average different page sets, so the axis deltas are a coverage change, not a site change — they do not count towards the verdict.'
      + (flips.length ? ' A page that stopped answering 2xx is reported in `page_coverage`, never as a score move.' : ''));
  }

  return {
    compare_version: COMPARE_VERSION,
    generated_at: new Date().toISOString(),
    plugin_version: pluginVersion(),
    mode,
    host_map: map,
    host_normalize: hostNormalize,
    a: sideSummary(a),
    b: sideSummary(b),
    coverage_warning: coverageWarning,
    scores,
    categories,
    findings,
    gaps,
    pages,
    page_coverage: pageCoverage,
    verdict: verdictOf(scores, findings, { samePages: pageCoverage.same_pages }),
    warnings: uniq(warnings),
  };
}

/* ------------------------------------------------------------------ competitor matrix */

/** Features the presence matrix reports for every site in the set. */
export function presenceMatrix(sides) {
  const schemaTypes = uniq(sides.flatMap((s) => s.metrics.schema_types)).sort();
  const endpoints = uniq(sides.flatMap((s) => endpointsOf(s) || [])).sort();
  const rows = [];
  for (const t of schemaTypes) rows.push({ feature: 'schema:' + t, kind: 'schema_type', values: sides.map((s) => (s.data_available ? s.metrics.schema_types.includes(t) : null)) });
  for (const e of endpoints) rows.push({ feature: 'endpoint:' + e, kind: 'agentic_endpoint', values: sides.map((s) => { const list = endpointsOf(s); return list ? list.includes(e) : null; }) });
  rows.push({ feature: 'hreflang', kind: 'signal', values: sides.map((s) => (s.data_available ? s.metrics.hreflang.pages_with_hreflang > 0 : null)) });
  rows.push({ feature: 'sitemap', kind: 'signal', values: sides.map((s) => (s.site.sitemaps ? (s.site.sitemaps.found || 0) > 0 || (s.site.sitemaps.url_count || 0) > 0 : null)) });
  rows.push({ feature: 'robots.txt', kind: 'signal', values: sides.map((s) => (s.site.robots ? s.site.robots.status === 200 : null)) });
  rows.push({ feature: 'answer blocks (question headings)', kind: 'signal', values: sides.map((s) => (s.metrics.answer_blocks.evaluated_pages ? s.metrics.answer_blocks.question_headings > 0 : null)) });
  return rows;
}

/** Score, category and presence tables for 2-5 sites, plus what the subject lacks against the set. */
export function competitorMatrix(sides, opts = {}) {
  const subject = sides[0];
  const rivals = sides.slice(1);
  const labels = sides.map((s) => s.label);

  const scoreRows = [];
  for (const [key, shortName] of AXES) {
    scoreRows.push({
      axis: shortName,
      values: sides.map((s) => {
        const sc = (s.scores && s.scores[key]) || {};
        return { label: s.label, value: num(sc.value), band: sc.band || band(num(sc.value)), state: sc.state || null, provisional: sc.provisional === true };
      }),
    });
  }
  const categoryNames = [];
  for (const [key, shortName] of AXES) {
    for (const s of sides) for (const c of ((s.scores && s.scores[key] && s.scores[key].categories) || [])) {
      if (!categoryNames.some((x) => x.axis === shortName && x.name === c.name)) categoryNames.push({ axis: shortName, name: c.name, key });
    }
  }
  const categoryRows = categoryNames.map(({ axis, name, key }) => ({
    axis, name,
    values: sides.map((s) => {
      const c = ((s.scores && s.scores[key] && s.scores[key].categories) || []).find((x) => x.name === name);
      return c && c.active ? num(c.value) : null;
    }),
  }));

  const best = {};
  for (const [key, shortName] of AXES) {
    let bestSide = null;
    for (const s of sides) {
      const v = num(s.scores && s.scores[key] && s.scores[key].value);
      if (v === null) continue;
      if (!bestSide || v > bestSide.value) bestSide = { label: s.label, value: v };
    }
    best[shortName] = bestSide;
  }

  const setSchema = uniq(rivals.flatMap((s) => s.metrics.schema_types));
  const setEndpoints = uniq(rivals.flatMap((s) => endpointsOf(s) || []));
  const subjectSchema = subject.metrics.schema_types;
  const subjectEndpoints = endpointsOf(subject) || [];
  const subjectTopics = new Set(subject.metrics.heading_topics.map((t) => t.topic));
  const topicCounts = new Map();
  for (const s of rivals) for (const t of s.metrics.heading_topics) {
    if (subjectTopics.has(t.topic)) continue;
    if (!topicCounts.has(t.topic)) topicCounts.set(t.topic, { topic: t.topic, text: t.text, competitors: 0 });
    topicCounts.get(t.topic).competitors++;
  }

  const gaps = {
    best_in_set: best,
    schema_types: { subject: subjectSchema, missing_vs_set: setSchema.filter((t) => !subjectSchema.includes(t)).map((t) => ({ type: t, present_in: rivals.filter((s) => s.metrics.schema_types.includes(t)).map((s) => s.label) })) },
    agentic_endpoints: { subject: subjectEndpoints, missing_vs_set: setEndpoints.filter((e) => !subjectEndpoints.includes(e)).map((e) => ({ path: e, present_in: rivals.filter((s) => (endpointsOf(s) || []).includes(e)).map((s) => s.label) })) },
    headings: { topics_missing: [...topicCounts.values()].sort((x, y) => y.competitors - x.competitors || (x.topic < y.topic ? -1 : 1)).slice(0, 25) },
    word_count: { subject_median: subject.metrics.word_count.median, set_median: median(rivals.map((s) => s.metrics.word_count.median)), delta: delta(subject.metrics.word_count.median, median(rivals.map((s) => s.metrics.word_count.median))) },
    answer_blocks: { subject: subject.metrics.answer_blocks, set: rivals.map((s) => ({ label: s.label, ...s.metrics.answer_blocks })) },
    entity_links: { subject: subject.metrics.entity_links, missing_authority_hosts: uniq(rivals.flatMap((s) => s.metrics.entity_links.authority_hosts)).filter((h) => !subject.metrics.entity_links.authority_hosts.includes(h)) },
    ai_crawler_posture: sides.map((s) => { const p = postureOf(s); return { label: s.label, blocked: p ? Object.entries(p).filter(([, v]) => v.root_allowed === false).map(([n]) => n) : null }; }),
  };

  const warnings = uniq(sides.flatMap((s) => s.warnings || []));
  const coverages = uniq(sides.map((s) => s.coverage || 'unknown'));
  const coverageWarning = coverages.length > 1 ? 'the runs do not share one coverage mode (' + coverages.join(', ') + '): the scores describe different amounts of evidence.' : null;

  return {
    compare_version: COMPARE_VERSION,
    generated_at: new Date().toISOString(),
    plugin_version: pluginVersion(),
    mode: 'competitor',
    subject: sideSummary(subject),
    refs: sides.map(sideSummary),
    labels,
    coverage_warning: coverageWarning,
    table: { scores: scoreRows, categories: categoryRows },
    presence_matrix: presenceMatrix(sides),
    gaps,
    findings: null,
    findings_note: 'No findings diff across different sites: a finding id at a location on one site is not the same fact as on another. Only scores, categories and structural presence are comparable.',
    verdict: null,
    warnings,
    honesty: [
      'These scores describe the structure of the pages that were crawled, not their rankings.',
      'A higher score is not a prediction that a site outranks another.',
      ...(opts.deterministicOnly ? ['Deterministic checks only: the model-judged modules were not evaluated on any side.'] : []),
    ],
  };
}

/* ------------------------------------------------------------------ gap matrix */

/**
 * Deterministic content-gap matrix: what the comparison pages for a query have and the subject
 * does not. Everything here is a structural count, so every row is `directional` —
 * it never claims that adding the row would change a ranking.
 */
export function gapMatrix(subject, competitors, opts = {}) {
  const query = opts.query || null;
  const rivals = competitors || [];
  const threshold = Math.min(2, Math.max(1, rivals.length));
  const subjectTopics = new Set(subject.metrics.heading_topics.map((t) => t.topic));
  const subjectSchema = new Set(subject.metrics.schema_types);
  const subjectEndpoints = new Set(endpointsOf(subject) || []);
  const subjectTerms = subject.metrics.terms || new Map();

  const countAcross = (pick) => {
    const counts = new Map();
    for (const s of rivals) {
      for (const value of pick(s)) {
        const key = typeof value === 'string' ? value : value.key;
        if (!counts.has(key)) counts.set(key, { key, competitors: 0, present_in: [], sample: typeof value === 'string' ? null : value.sample || null });
        const row = counts.get(key);
        if (!row.present_in.includes(s.label)) { row.competitors++; row.present_in.push(s.label); }
      }
    }
    return counts;
  };

  const topicCounts = countAcross((s) => s.metrics.heading_topics.map((t) => ({ key: t.topic, sample: t.text })));
  const schemaCounts = countAcross((s) => s.metrics.schema_types);
  const endpointCounts = countAcross((s) => endpointsOf(s) || []);
  const termCounts = countAcross((s) => [...(s.metrics.terms || new Map()).keys()]);

  const heading_topics = [...topicCounts.values()]
    .filter((r) => r.competitors >= threshold && !subjectTopics.has(r.key))
    .sort((a, b) => b.competitors - a.competitors || (a.key < b.key ? -1 : 1))
    .slice(0, 30)
    .map((r) => ({ topic: r.key, example: r.sample, competitors: r.competitors, present_in: r.present_in, in_subject: false }));

  const schema_types = [...schemaCounts.values()]
    .filter((r) => r.competitors >= threshold && !subjectSchema.has(r.key))
    .sort((a, b) => b.competitors - a.competitors || (a.key < b.key ? -1 : 1))
    .map((r) => ({ type: r.key, competitors: r.competitors, present_in: r.present_in }));

  const agentic_endpoints = [...endpointCounts.values()]
    .filter((r) => r.competitors >= threshold && !subjectEndpoints.has(r.key))
    .sort((a, b) => b.competitors - a.competitors || (a.key < b.key ? -1 : 1))
    .map((r) => ({ path: r.key, competitors: r.competitors, present_in: r.present_in }));

  const terms = [...termCounts.values()]
    .filter((r) => r.competitors >= threshold && !subjectTerms.has(r.key))
    .sort((a, b) => b.competitors - a.competitors || (a.key < b.key ? -1 : 1))
    .slice(0, 30)
    .map((r) => ({ term: r.key, competitors: r.competitors, present_in: r.present_in }));

  const setDensity = median(rivals.map((s) => s.metrics.numeric_facts.per_100w));
  const setWords = median(rivals.map((s) => s.metrics.word_count.median));
  const setQuestions = median(rivals.map((s) => s.metrics.answer_blocks.question_headings));
  const setAnswers = median(rivals.map((s) => s.metrics.answer_blocks.direct_answers));

  const notes = [];
  if (rivals.length < 2) notes.push('only one comparison page: a signal it carries is one site\'s choice, not a pattern.');
  if (threshold < 2) notes.push('the "present in >= 2 competitors" rule was relaxed to >= 1 because the set is that small.');
  const unsupported = [subject, ...rivals].filter((s) => s.metrics.answer_blocks.unsupported_language_pages > 0).map((s) => s.label);
  if (unsupported.length) notes.push('answer-block counts are null on pages whose language is outside the EN/ES lexicons (' + unsupported.join(', ') + ').');
  if (!subject.data_available || rivals.some((s) => !s.data_available)) notes.push('at least one reference has no page snapshots: its structural rows are missing, not zero.');

  return {
    compare_version: COMPARE_VERSION,
    generated_at: new Date().toISOString(),
    plugin_version: pluginVersion(),
    mode: 'gap',
    query,
    threshold,
    subject: sideSummary(subject),
    set: rivals.map(sideSummary),
    matrix: {
      heading_topics,
      schema_types,
      terms,
      agentic_endpoints,
      numeric_facts: { subject_per_100w: subject.metrics.numeric_facts.per_100w, set_median_per_100w: setDensity, delta: delta(subject.metrics.numeric_facts.per_100w, setDensity) },
      word_count: { subject_median: subject.metrics.word_count.median, set_median: setWords, delta: delta(subject.metrics.word_count.median, setWords) },
      answer_blocks: {
        subject: subject.metrics.answer_blocks,
        set_median: { question_headings: setQuestions, direct_answers: setAnswers },
        set: rivals.map((s) => ({ label: s.label, ...s.metrics.answer_blocks })),
      },
    },
    confidence: 'directional',
    notes,
    honesty: [
      'Every row is a structural difference between pages, not a ranking factor: `directional` confidence throughout.',
      'The comparison set is whatever pages were passed in — one engine at one moment, not a ranking sample.',
      'Terms are capitalized-word counts (a proper-noun proxy), not extracted entities.',
    ],
    warnings: uniq([subject, ...rivals].flatMap((s) => s.warnings || [])),
  };
}

/* ------------------------------------------------------------------ output */

function slugOf(text, maxLen = 48) {
  const s = String(text || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (s || 'run').slice(0, maxLen).replace(/-+$/, '') || 'run';
}

/** Directory name of a comparison: `<a>__<b>` (hashed when the labels run long). */
export function compareDirName(sides) {
  const parts = sides.map((s) => slugOf((s.label || 'run') + '-' + (s.run_id || '')));
  const name = parts.join('__');
  if (name.length <= 120) return name;
  return name.slice(0, 110).replace(/-+$/, '') + '-' + sha1(name).slice(0, 8);
}

const fmt = (v) => (v === null || v === undefined ? '—' : typeof v === 'number' ? String(v) : String(v));
const signed = (v) => (v === null || v === undefined ? '—' : (v > 0 ? '+' : '') + v);

function mdTable(headers, rows) {
  const out = ['| ' + headers.join(' | ') + ' |', '| ' + headers.map(() => '---').join(' | ') + ' |'];
  for (const r of rows) out.push('| ' + r.map((c) => String(c === null || c === undefined ? '—' : c).replace(/\|/g, '\\|')) .join(' | ') + ' |');
  return out.join('\n');
}

/** Human-readable rendering of any compare document. */
export function renderMarkdown(doc) {
  const out = [];
  if (doc.mode === 'gap') {
    out.push('# Content gap' + (doc.query ? ': "' + doc.query + '"' : ''), '');
    out.push('Subject: `' + (doc.subject.target || doc.subject.label) + '` — comparison set: ' + doc.set.map((s) => '`' + (s.target || s.label) + '`').join(', '), '');
    out.push('Every row below is a structural difference (confidence: **directional**), not a ranking factor.', '');
    if (doc.matrix.heading_topics.length) {
      out.push('## Topics covered by the set and missing here', '');
      out.push(mdTable(['Topic', 'Example heading', 'Competitors'], doc.matrix.heading_topics.map((t) => [t.topic, t.example || '', t.competitors])), '');
    }
    if (doc.matrix.schema_types.length) {
      out.push('## Schema types the set declares and this page does not', '');
      out.push(mdTable(['Type', 'Competitors'], doc.matrix.schema_types.map((t) => [t.type, t.competitors])), '');
    }
    if (doc.matrix.terms.length) {
      out.push('## Capitalized terms common in the set, absent here (proper-noun proxy)', '');
      out.push(mdTable(['Term', 'Competitors'], doc.matrix.terms.map((t) => [t.term, t.competitors])), '');
    }
    if (doc.matrix.agentic_endpoints.length) {
      out.push('## Agentic / discovery endpoints the set serves', '');
      out.push(mdTable(['Path', 'Competitors'], doc.matrix.agentic_endpoints.map((t) => [t.path, t.competitors])), '');
    }
    out.push('## Volume and fact density', '');
    out.push(mdTable(['Measure', 'Subject', 'Set median', 'Delta'], [
      ['Words per page (median)', fmt(doc.matrix.word_count.subject_median), fmt(doc.matrix.word_count.set_median), signed(doc.matrix.word_count.delta)],
      ['Substantive numbers / 100 words', fmt(doc.matrix.numeric_facts.subject_per_100w), fmt(doc.matrix.numeric_facts.set_median_per_100w), signed(doc.matrix.numeric_facts.delta)],
      ['Question headings', fmt(doc.matrix.answer_blocks.subject.question_headings), fmt(doc.matrix.answer_blocks.set_median.question_headings), '—'],
      ['…with a direct answer', fmt(doc.matrix.answer_blocks.subject.direct_answers), fmt(doc.matrix.answer_blocks.set_median.direct_answers), '—'],
    ]), '');
    if (doc.notes.length) out.push('## Notes', '', ...doc.notes.map((n) => '- ' + n), '');
    out.push('## Honesty', '', ...doc.honesty.map((h) => '- ' + h), '');
    return out.join('\n') + '\n';
  }

  if (doc.mode === 'competitor') {
    out.push('# Competitor comparison', '');
    out.push(mdTable(['Site', 'Run', 'Coverage', 'Pages'], doc.refs.map((r) => ['`' + (r.target || r.label) + '`', r.run_id, r.coverage || '—', r.pages_scored])), '');
    out.push('## Scores', '');
    out.push(mdTable(['Axis', ...doc.labels], doc.table.scores.map((row) => [row.axis, ...row.values.map((v) => (v.value === null ? '—' : v.value + ' (' + v.band + ')' + (v.provisional ? '*' : '')))])), '');
    out.push('_A `*` marks a provisional band (partial coverage)._', '');
    out.push('## Categories', '');
    out.push(mdTable(['Axis', 'Category', ...doc.labels], doc.table.categories.map((row) => [row.axis, row.name, ...row.values.map(fmt)])), '');
    out.push('## Presence', '');
    out.push(mdTable(['Feature', ...doc.labels], doc.presence_matrix.map((row) => [row.feature, ...row.values.map((v) => (v === null ? '—' : v ? 'yes' : 'no'))])), '');
    out.push('## ' + doc.subject.label + ' vs the best in the set', '');
    const g = doc.gaps;
    if (g.schema_types.missing_vs_set.length) out.push('- Schema types the set declares and the subject does not: ' + g.schema_types.missing_vs_set.map((x) => x.type).join(', '));
    if (g.agentic_endpoints.missing_vs_set.length) out.push('- Discovery endpoints the set serves: ' + g.agentic_endpoints.missing_vs_set.map((x) => x.path).join(', '));
    if (g.headings.topics_missing.length) out.push('- Topics the set covers: ' + g.headings.topics_missing.slice(0, 10).map((x) => x.topic).join('; '));
    out.push('- Words per page (median): subject ' + fmt(g.word_count.subject_median) + ' vs set ' + fmt(g.word_count.set_median));
    out.push('', '## Honesty', '', ...doc.honesty.map((h) => '- ' + h), '');
    out.push('- ' + doc.findings_note, '');
    return out.join('\n') + '\n';
  }

  out.push('# Comparison (' + doc.mode + '): ' + doc.verdict, '');
  out.push(mdTable(['Side', 'Target', 'Run', 'Generated', 'Coverage'], [
    ['a', '`' + (doc.a.target || doc.a.label) + '`', doc.a.run_id, doc.a.generated_at || '—', doc.a.coverage || '—'],
    ['b', '`' + (doc.b.target || doc.b.label) + '`', doc.b.run_id, doc.b.generated_at || '—', doc.b.coverage || '—'],
  ]), '');
  out.push('## Scores', '');
  out.push(mdTable(['Axis', 'a', 'b', 'Delta'], AXES.map(([key, name]) => {
    const s = doc.scores[key];
    return [name, s.a === null ? '—' : s.a + ' (' + s.band_a + ')', s.b === null ? '—' : s.b + ' (' + s.band_b + ')', signed(s.delta)];
  })), '');
  const moved = doc.categories.filter((c) => c.delta !== null && c.delta !== 0);
  if (moved.length) {
    out.push('## Categories that moved', '');
    out.push(mdTable(['Axis', 'Category', 'a', 'b', 'Delta'], moved.slice(0, 20).map((c) => [c.axis, c.name, fmt(c.a), fmt(c.b), signed(c.delta)])), '');
  }
  out.push('## Findings', '');
  out.push(mdTable(['Bucket', 'Count'], [
    ['fixed', doc.findings.fixed.length], ['new', doc.findings.new.length], ['regressed', doc.findings.regressed.length],
    ['improved', doc.findings.improved.length], ['unchanged', doc.findings.unchanged], ['coverage changes', doc.findings.coverage_changes.length],
  ]), '');
  for (const bucket of ['regressed', 'new', 'fixed', 'improved']) {
    const rows = doc.findings[bucket];
    if (!rows.length) continue;
    out.push('### ' + bucket, '');
    out.push(mdTable(['Id', 'Severity', 'From', 'To', 'Location'], rows.slice(0, 20).map((f) => [f.id, f.severity, f.from || '—', f.to || '—', '`' + f.location + '`'])), '');
  }
  if (doc.findings.coverage_changes.length) {
    out.push('### coverage changes (never counted as fixed or regressed)', '');
    out.push(mdTable(['Id', 'From', 'To', 'Why'], doc.findings.coverage_changes.slice(0, 20).map((f) => [f.id, f.from || '—', f.to || '—', f.note])), '');
  }
  if (doc.gaps.available) {
    out.push('## Structural differences', '');
    const rows = [
      ['Schema types only in a', doc.gaps.schema_types.only_a.join(', ') || '—'],
      ['Schema types only in b', doc.gaps.schema_types.only_b.join(', ') || '—'],
      ['Heading-topic overlap (Jaccard)', fmt(doc.gaps.headings.overlap_jaccard)],
      ['Words per page (median) a → b', fmt(doc.gaps.word_count.a.median) + ' → ' + fmt(doc.gaps.word_count.b.median)],
      ['Question headings a → b', fmt(doc.gaps.answer_blocks.a.question_headings) + ' → ' + fmt(doc.gaps.answer_blocks.b.question_headings)],
      ['hreflang languages a → b', (doc.gaps.hreflang.a.langs.join(', ') || '—') + ' → ' + (doc.gaps.hreflang.b.langs.join(', ') || '—')],
    ];
    if (doc.gaps.agentic_endpoints !== UNAVAILABLE) rows.push(['Discovery endpoints only in b', doc.gaps.agentic_endpoints.only_b.join(', ') || '—']);
    if (doc.gaps.ai_crawler_posture !== UNAVAILABLE) rows.push(['AI bots newly blocked in b', doc.gaps.ai_crawler_posture.blocked_only_b.join(', ') || '—']);
    out.push(mdTable(['Measure', 'Value'], rows), '');
  } else {
    out.push('## Structural differences', '', '_' + doc.gaps.reason + '_', '');
  }
  const movedPages = doc.pages.filter((p) => p.status === 'matched' && !p.coverage_change && ((p.delta.search !== null && p.delta.search !== 0) || (p.delta.ai !== null && p.delta.ai !== 0)));
  if (movedPages.length) {
    out.push('## Pages that moved', '');
    out.push(mdTable(['Path', 'Search a→b', 'AI a→b'], movedPages.slice(0, 20).map((p) => [p.path, fmt(p.a.search) + ' → ' + fmt(p.b.search) + ' (' + signed(p.delta.search) + ')', fmt(p.a.ai) + ' → ' + fmt(p.b.ai) + ' (' + signed(p.delta.ai) + ')'])), '');
  }
  const pageCov = doc.page_coverage;
  if (pageCov && pageCov.changes && pageCov.changes.length) {
    out.push('## Pages that changed coverage (never counted as a score move)', '');
    out.push(mdTable(['Path', 'Change', 'HTTP a', 'HTTP b'], pageCov.changes.slice(0, 20).map((c) => [c.path, c.kind, c.status_a === null ? '—' : c.status_a, c.status_b === null ? '—' : c.status_b])), '');
    out.push('_' + pageCov.scored_a + ' page(s) scored in a, ' + pageCov.scored_b + ' in b — the axis deltas above average different page sets._', '');
  }
  if (doc.coverage_warning) out.push('## Coverage', '', doc.coverage_warning, '');
  if (doc.warnings.length) out.push('## Warnings', '', ...doc.warnings.map((w) => '- ' + w), '');
  return out.join('\n') + '\n';
}

/* ------------------------------------------------------------------ gate */

/**
 * `--fail-on-regression`: exit 3 when something got worse. Both regression buckets count — a
 * `warn → fail` (regressed) and a `pass → fail` or newly reported problem (new) are the same event
 * for a gate — as does an axis that lost more than REGRESSION_DELTA points. Coverage changes never
 * trip it: a check that was not run is not a regression.
 */
export function regressionGate(doc) {
  if (!doc || doc.mode === 'competitor' || doc.mode === 'gap' || !doc.findings) return { tripped: false, reasons: [], applicable: false };
  const reasons = [];
  const worse = doc.findings.regressed.length + doc.findings.new.length;
  if (worse) reasons.push({ gate: 'findings', regressed: doc.findings.regressed.length, new: doc.findings.new.length, ids: uniq([...doc.findings.regressed, ...doc.findings.new].map((f) => f.id)).slice(0, 10) });
  const samePages = !doc.page_coverage || doc.page_coverage.same_pages !== false;
  for (const [key, name] of AXES) {
    const d = doc.scores[key] ? doc.scores[key].delta : null;
    if (d === null || d >= REGRESSION_DELTA) continue;
    // The gate still trips (a drop nobody can explain is exactly what it is for), but it says so
    // when the two runs did not score the same pages: the number may be the sample, not the site.
    const reason = { gate: 'axis', axis: name, delta: d, threshold: REGRESSION_DELTA };
    if (!samePages) {
      reason.same_pages = false;
      reason.note = 'the two runs did not score the same pages (see page_coverage): this delta may be a coverage change rather than a regression';
    }
    reasons.push(reason);
  }
  return { tripped: reasons.length > 0, reasons, applicable: true };
}

/* ------------------------------------------------------------------ run */

function summarize(doc, paths, extra = {}) {
  const base = { ok: true, mode: doc.mode, compare_json: paths.json, ...(paths.md ? { compare_md: paths.md } : {}) };
  if (doc.mode === 'competitor') {
    return {
      ...base,
      refs: doc.refs.map((r) => ({ label: r.label, target: r.target, run_id: r.run_id, coverage: r.coverage })),
      scores: Object.fromEntries(doc.table.scores.map((row) => [row.axis, row.values.map((v) => ({ label: v.label, value: v.value, band: v.band }))])),
      presence_features: doc.presence_matrix.length,
      gaps: { schema_types_missing: doc.gaps.schema_types.missing_vs_set.length, endpoints_missing: doc.gaps.agentic_endpoints.missing_vs_set.length, topics_missing: doc.gaps.headings.topics_missing.length },
      coverage_warning: doc.coverage_warning,
      warnings: doc.warnings,
      ...extra,
    };
  }
  if (doc.mode === 'gap') {
    return {
      ...base,
      query: doc.query,
      subject: { label: doc.subject.label, target: doc.subject.target, run_id: doc.subject.run_id },
      set: doc.set.map((s) => ({ label: s.label, target: s.target, run_id: s.run_id })),
      matrix: {
        heading_topics: doc.matrix.heading_topics.length, schema_types: doc.matrix.schema_types.length,
        terms: doc.matrix.terms.length, agentic_endpoints: doc.matrix.agentic_endpoints.length,
        word_count_delta: doc.matrix.word_count.delta, numeric_facts_delta: doc.matrix.numeric_facts.delta,
      },
      confidence: doc.confidence,
      notes: doc.notes,
      warnings: doc.warnings,
      ...extra,
    };
  }
  return {
    ...base,
    verdict: doc.verdict,
    a: { label: doc.a.label, target: doc.a.target, run_id: doc.a.run_id, coverage: doc.a.coverage },
    b: { label: doc.b.label, target: doc.b.target, run_id: doc.b.run_id, coverage: doc.b.coverage },
    scores: Object.fromEntries(AXES.map(([key, name]) => [name, { a: doc.scores[key].a, b: doc.scores[key].b, delta: doc.scores[key].delta, band_a: doc.scores[key].band_a, band_b: doc.scores[key].band_b }])),
    findings: {
      fixed: doc.findings.fixed.length, new: doc.findings.new.length, regressed: doc.findings.regressed.length,
      improved: doc.findings.improved.length, unchanged: doc.findings.unchanged, coverage_changes: doc.findings.coverage_changes.length,
    },
    categories_moved: doc.categories.filter((c) => c.delta !== null && c.delta !== 0).length,
    pages_matched: doc.pages.filter((p) => p.status === 'matched').length,
    page_coverage: doc.page_coverage
      ? { same_pages: doc.page_coverage.same_pages, scored_a: doc.page_coverage.scored_a, scored_b: doc.page_coverage.scored_b, changes: doc.page_coverage.changes.length }
      : null,
    gaps: doc.gaps.available ? 'available' : UNAVAILABLE,
    coverage_warning: doc.coverage_warning,
    warnings: doc.warnings,
    ...extra,
  };
}

/**
 * The whole command: resolve refs, load runs, compare, persist. Exposed so tests and callers can
 * work with the objects instead of the CLI text.
 */
export async function runCompare(args = {}, deps = {}) {
  const o = readOptions(args);
  const picked = collectRefs(args, o);
  if (picked.shape !== 'gap' && picked.refs.length > MAX_REFS) throw new UsageError('at most ' + MAX_REFS + ' references can be compared at once');
  const rootInfo = resolveRootInfo(args);
  const root = rootInfo.root;

  const sides = [];
  const audited = [];
  for (const ref of picked.refs) {
    const r = await resolveRef(ref, root, o, deps);
    if (!r.ok) return { ok: false, code: r.code || EXIT.RUNTIME, summary: { error: r.error, detail: r.detail || null, ref } };
    if (r.audited) audited.push(r.audit_summary);
    const loaded = loadSide(r.resolved, { ...o, requireReport: picked.shape !== 'gap' });
    if (!loaded.ok) return { ok: false, code: loaded.code || EXIT.USAGE, summary: { error: loaded.error, ref } };
    sides.push(loaded.side);
  }
  // Labels are what every table is keyed by: make them unique before anything renders.
  const seen = new Map();
  for (const s of sides) {
    const base = s.label || 'run';
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    if (n > 1) s.label = base + ' #' + n;
  }

  const modeInfo = picked.shape === 'gap' ? { mode: 'gap', map: o.map, reason: 'gap analysis' } : resolveMode(sides, o);
  const deterministicOnly = sides.every((s) => s.coverage === 'deterministic');

  let doc;
  if (modeInfo.mode === 'gap') doc = gapMatrix(sides[0], sides.slice(1), { query: o.query });
  else if (modeInfo.mode === 'competitor' || sides.length > 2) doc = competitorMatrix(sides, { deterministicOnly });
  else doc = compareRuns(sides[0], sides[1], { mode: modeInfo.mode, map: modeInfo.map, hostNormalize: o.hostNormalize });
  doc.mode_reason = modeInfo.reason;
  if (audited.length) doc.audited = audited;

  // The gate runs before the document is written so what lands on disk is what the exit code says.
  const extra = {};
  let code = EXIT.OK;
  if (o.failOnRegression) {
    const gate = regressionGate(doc);
    extra.gate = gate;
    if (!gate.applicable) doc.warnings.push('--fail-on-regression does not apply in ' + doc.mode + ' mode: there is no findings diff across different sites.');
    else if (gate.tripped) code = EXIT.THRESHOLD;
  }
  if (o.setBaseline) {
    // The last reference is the newest state of the site, which is what a later run compares against.
    const target = modeInfo.mode === 'gap' ? null : sides[sides.length - 1];
    if (modeInfo.mode === 'gap') extra.set_baseline = { ok: false, error: '--set-baseline does not apply to a gap analysis: a competitor page is not your baseline' };
    else if (!target || !existsSync(target.run_dir)) extra.set_baseline = { ok: false, error: 'no run directory to mark as the baseline' };
    else {
      try {
        const res = setBaseline(dirname(target.run_dir), basename(target.run_dir), { set_by: 'compare', mode: doc.mode, target: target.target });
        extra.set_baseline = { ok: true, run: res.run, path: res.path, baseline_json: res.baseline_json };
      } catch (e) { extra.set_baseline = { ok: false, error: msg(e) }; }
    }
    doc.set_baseline = extra.set_baseline;
  }

  const dir = join(root, 'compare', compareDirName(sides));
  const paths = {};
  try {
    paths.json = writeJson(join(dir, 'compare.json'), doc);
    if (o.format === 'md') paths.md = writeText(join(dir, 'compare.md'), renderMarkdown(doc));
  } catch (e) {
    return { ok: false, code: EXIT.RUNTIME, summary: { error: 'could not write the comparison to ' + dir + ': ' + msg(e) } };
  }

  const summary = summarize(doc, paths, extra);
  summary.ok = code === EXIT.OK;
  summary.exit_code = code;
  return { ok: code === EXIT.OK, code, doc, summary, paths, options: o, sides };
}

export async function main(args) {
  let run;
  try {
    run = await runCompare(args);
  } catch (e) {
    if (e instanceof UsageError) return usageResult(e.message);
    return { result: { error: msg(e) }, code: EXIT.RUNTIME };
  }
  if (!run.ok && run.summary && run.summary.error) return { result: run.summary, code: run.code };
  if (run.options.format === 'md') {
    const md = renderMarkdown(run.doc);
    process.stdout.write(md.endsWith('\n') ? md : md + '\n');
    return { result: { compare_json: run.paths.json, ...(run.paths.md ? { compare_md: run.paths.md } : {}), exit_code: run.code }, code: run.code };
  }
  if (run.options.data) return { result: { ...run.doc, compare_json: run.paths.json, exit_code: run.code }, code: run.code };
  return { result: run.summary, code: run.code };
}

if (isMain(import.meta.url)) runCli(main);

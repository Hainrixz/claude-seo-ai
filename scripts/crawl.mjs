#!/usr/bin/env node
// Crawl a site into one run directory: a handful of representative pages as PageSnapshot v2 files
// plus `crawl.json`, the manifest every later stage reads (checks registry, score rollup, report).
//
// Usage:
//   node crawl.mjs <url> [--out <runs-root>] [--run <id>] [--pages 12] [--max 40] [--per-template 2]
//                  [--depth 3] [--concurrency 4] [--delay <ms>] [--no-robots] [--ua googlebot|<literal>]
//                  [--render auto|static|js] [--renderer auto|chrome|playwright|none]
//                  [--include <regex>] [--exclude <regex>] [--seeds <file|a,b>]
//                  [--sitemap-sample 30] [--no-sitemaps] [--link-status 60] [--json] [--quiet]
//                  [--artifacts all|none|robots,sitemaps,discovery]   (site artifacts, as in snapshot.mjs)
//
// What it does, in order:
//   1. site artifacts once per run (robots.txt, sitemap discovery, AI-discovery probes) — shared by
//      every page, so a 12-page crawl still fetches robots.txt exactly once;
//   2. seeds: the origin `/`, the requested URL, a sitemap sample spread round-robin across distinct
//      URL patterns, then breadth-first over internal anchors down to --depth;
//   3. sampling: homepage and target always, then at most --per-template pages per template, then a
//      round-robin fill of what was deferred until --pages is reached. Every skip is logged with its
//      reason (robots, filter, depth, cap, per-template, budget) — an audit that silently drops URLs
//      is an audit nobody can check;
//   4. link-status probes (HEAD, ranged GET fallback, manual redirect chain) for internal URLs that
//      were discovered but not sampled, within the --link-status budget.
//
// Robots is obeyed for the `claude-seo-ai` group (Googlebot/Bingbot verdicts are recorded, never
// acted on); Crawl-delay is honoured up to 10 s and forces concurrency 1. A robots.txt that returns
// 5xx means "crawl nothing" per Google's REP, so the crawl falls back to the requested URL alone and
// says so in `warnings`. `--no-robots` overrides all of it and is recorded in `options`.
//
// Exit codes: 0 crawl written (4xx/5xx pages and redirect loops are findings, not failures) ·
// 1 usage · 2 the target could not be fetched at all (network failure) — nothing to crawl.
//
// Stdout is a compact summary (paths, sampling table, templates); `--json` prints the whole manifest.

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT, isMain, runCli } from './lib/util.mjs';
import { fetchRaw, resolveUa, DEFAULT_ACCEPT_LANGUAGE } from './lib/fetch.mjs';
import {
  resolveRootInfo, openRun, writeJson, readJson, relPath, pluginVersion, setLatest, prune, keepFor, isHttpUrl, looksLikeHost,
} from './lib/store.mjs';
import { fetchSiteArtifacts, normalizeArtifacts, isHtmlDocument, mediaTypeOf } from './lib/site.mjs';
import { isAllowed, selectGroup } from './lib/robots.mjs';
import { normalizeUrl, isInternal } from './lib/urlnorm.mjs';
import { runPool } from './lib/pool.mjs';
import { snapshotUrl, RENDER_MODES, RENDERERS } from './snapshot.mjs';
import { templateKey, explain as explainTemplate, groupTemplates, pathPattern } from './lib/templates.mjs';

export const CRAWL_VERSION = 1;
/** The robots.txt group this crawler obeys (its own product token, per the REP). */
export const CRAWL_UA_TOKEN = 'claude-seo-ai';
/** Bots whose verdict for every crawled URL is recorded but never acted on. */
export const RECORDED_UAS = Object.freeze(['Googlebot', 'Bingbot']);
export const MAX_GRAPH_EDGES = 20000;
/** Crawl-delay is honoured up to this many seconds; anything higher is clamped and warned about. */
export const MAX_CRAWL_DELAY_S = 10;
/** Per-reason skip lists are capped in the manifest (counts are always exact). */
export const MAX_SKIP_LOG = 50;
export const DEFAULTS = Object.freeze({ pages: 12, max: 40, perTemplate: 2, depth: 3, concurrency: 4, sitemapSample: 30, linkStatus: 60 });
/** Page weights for the site rollup — mirrors ROLE_WEIGHTS in score.mjs. */
export const ROLE_WEIGHTS = Object.freeze({ homepage: 3, target: 2, 'template-sample': 2, 'long-tail': 1 });
const BODY_HEAD_BYTES = 262144; // enough of a saved page to find <body class>
const PROBE_REDIRECT_HOPS = 5;

class UsageError extends Error { constructor(message, hint) { super(message); this.hint = hint || null; } }
const USAGE_HINT = 'node crawl.mjs <url> [--pages 12] [--per-template 2] [--depth 3] [--out <dir>] [--json]';
const usage = (e) => ({ result: { error: e.message, ...(e.hint ? { hint: e.hint } : {}) }, code: EXIT.USAGE });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Options

function toList(v) {
  if (v === undefined || v === null || v === true || v === false) return [];
  return (Array.isArray(v) ? v : [v]).map((s) => String(s)).filter((s) => s.trim() !== '');
}

function compileFilters(v, flag) {
  const out = [];
  for (const raw of toList(v)) {
    try { out.push(new RegExp(raw)); }
    catch (e) { throw new UsageError(`--${flag} is not a valid regular expression: ${raw} (${e.message})`, USAGE_HINT); }
  }
  return out;
}

/** `--seeds a,b` or `--seeds seeds.txt` (one URL per line, `#` comments allowed). */
function readSeeds(v) {
  const out = [];
  for (const item of toList(v)) {
    if (existsSync(item) && statSync(item).isFile()) {
      for (const line of readFileSync(item, 'utf8').split(/\r?\n/)) {
        const s = line.split('#')[0].trim();
        if (s) out.push(s);
      }
    } else {
      for (const s of item.split(',')) if (s.trim()) out.push(s.trim());
    }
  }
  return out;
}

export function readOptions(args = {}) {
  const str = (k) => (typeof args[k] === 'string' && args[k].trim() ? args[k].trim() : undefined);
  const int = (k, def, min, max) => {
    const v = args[k];
    if (v === undefined || v === true) return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || (max != null && n > max)) {
      throw new UsageError(`--${k} must be an integer >= ${min}` + (max != null ? ` and <= ${max}` : ''), USAGE_HINT);
    }
    return n;
  };
  const oneOf = (k, list, def) => {
    const v = args[k];
    if (v === undefined || v === true) return def;
    const s = String(v).toLowerCase();
    if (!list.includes(s)) throw new UsageError(`--${k} must be one of ${list.join('|')}`, USAGE_HINT);
    return s;
  };
  const ua = resolveUa({ ua: str('ua') });
  let artifacts;
  if (args.artifacts !== undefined) {
    try { normalizeArtifacts(args.artifacts); artifacts = args.artifacts; }
    catch (e) { throw new UsageError('--artifacts: ' + e.message, USAGE_HINT); }
  }
  const lang = str('lang');
  const pages = int('pages', DEFAULTS.pages, 1);
  const max = int('max', Math.max(DEFAULTS.max, pages), pages);
  return {
    out: str('out'), runId: str('run'), artifacts,
    pages, max, perTemplate: int('per-template', DEFAULTS.perTemplate, 1), depth: int('depth', DEFAULTS.depth, 0),
    concurrency: int('concurrency', DEFAULTS.concurrency, 1, 16), delayMs: int('delay', 0, 0),
    respectRobots: args.robots !== false,
    ua: ua.ua, uaPreset: ua.preset, lang: lang || null,
    acceptLanguage: lang ? (/[,;]/.test(lang) ? lang : (lang.split('-')[0] !== lang ? `${lang},${lang.split('-')[0]};q=0.9` : lang)) : DEFAULT_ACCEPT_LANGUAGE,
    // A crawl never launches a browser unless asked: `--render` alone means "auto".
    render: args.render === true ? 'auto' : oneOf('render', RENDER_MODES, 'static'),
    renderer: oneOf('renderer', RENDERERS, 'auto'),
    include: compileFilters(args.include, 'include'), exclude: compileFilters(args.exclude, 'exclude'),
    seeds: readSeeds(args.seeds),
    useSitemaps: args.sitemaps !== false, sitemapSample: int('sitemap-sample', DEFAULTS.sitemapSample, 0),
    linkStatus: int('link-status', DEFAULTS.linkStatus, 0),
    timeoutMs: int('timeout', 20000, 1), maxHops: int('max-hops', 10, 0), maxBytes: int('max-bytes', 5_000_000, 1024),
    sitemapMax: int('sitemap-max', 50, 1), sitemapUrlsMax: int('sitemap-urls-max', 100000, 1),
    keep: args.keep === undefined || args.keep === true ? null : int('keep', null, 0), prune: args.prune !== false,
    json: !!args.json, quiet: !!args.quiet,
  };
}

function withDefaults(opts) {
  const base = readOptions({});
  const o = { ...base, ...(opts || {}) };
  if (opts && opts.ua !== undefined && opts.uaPreset === undefined) { const u = resolveUa({ ua: opts.ua }); o.ua = u.ua; o.uaPreset = u.preset; }
  if (opts && typeof opts.include === 'string') o.include = compileFilters(opts.include, 'include');
  if (opts && typeof opts.exclude === 'string') o.exclude = compileFilters(opts.exclude, 'exclude');
  return o;
}

/** `<url>` | `--url <u>` | a bare host (`example.com` → `https://example.com/`). */
export function classifyTarget(args) {
  const pos = Array.isArray(args._) && typeof args._[0] === 'string' ? args._[0].trim() : '';
  const raw = pos || (typeof args.url === 'string' ? args.url.trim() : '');
  if (!raw) throw new UsageError('provide a target URL: node crawl.mjs <url>', USAGE_HINT);
  if (isHttpUrl(raw)) {
    try { return new URL(raw).href; } catch { throw new UsageError('invalid URL: ' + raw, USAGE_HINT); }
  }
  if (looksLikeHost(raw)) return 'https://' + raw + (raw.includes('/') ? '' : '/');
  throw new UsageError('not a URL: ' + raw + ' (crawl needs an http(s) URL; use snapshot.mjs for local files)', USAGE_HINT);
}

// ---------------------------------------------------------------------------
// Small helpers

/** Stable de-duplication key: www-insensitive, no fragment/tracking, no trailing slash, no /index.html. */
export function dedupeKey(url) {
  return normalizeUrl(url, { stripWww: true, stripTrailingSlash: true, dropIndex: true }) || String(url || '');
}

/** First bytes of a saved page — enough to find `<body class>` without reading a 5 MB file. */
function readHead(path, bytes = BODY_HEAD_BYTES) {
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, n).toString('utf8');
  } catch { return ''; }
  finally { if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } } }
}

function pacer(delayMs) {
  let last = 0;
  return async () => {
    if (!delayMs) return;
    const wait = last + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
  };
}

function firstH1(parsed) {
  const hs = parsed && Array.isArray(parsed.headings) ? parsed.headings : [];
  const h = hs.find((x) => x.level === 1 && !x.aria);
  return h ? h.text : null;
}

function canonicalOf(snap) {
  const p = snap.parsed || {};
  if (Array.isArray(p.canonicals) && p.canonicals.length) return p.canonicals[0].abs || p.canonicals[0].href || null;
  return (snap.header_links && snap.header_links.canonical) || null;
}

function hreflangCount(snap) {
  const p = snap.parsed || {};
  const inHead = Array.isArray(p.hreflang) ? p.hreflang.length : 0;
  const inHeader = snap.header_links && Array.isArray(snap.header_links.alternates) ? snap.header_links.alternates.length : 0;
  return inHead + inHeader;
}

/** Internal anchors of a parsed document, absolute + de-duplicated, in document order. */
export function internalLinks(parsed, baseUrl) {
  const out = [];
  const seen = new Set();
  for (const a of (parsed && Array.isArray(parsed.anchors) ? parsed.anchors : [])) {
    if (a.scheme !== 'http' || a.fragment_only) continue;
    const abs = a.abs || (a.href ? normalizeUrl(a.href, { base: baseUrl }) : null);
    if (!abs || !isInternal(abs, baseUrl)) continue;
    const norm = normalizeUrl(abs);
    if (!norm) continue;
    const key = dedupeKey(norm);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Link-status probes

/**
 * Probe one URL without downloading it: HEAD first, a ranged GET when HEAD is refused, redirects
 * followed by hand so the whole chain is recorded.
 * @returns {Promise<{url, method, status, ok, broken, redirect, hops, final_url, chain, error}>}
 */
export async function probeLinkStatus(url, { fetchImpl = fetchRaw, ua, acceptLanguage, timeoutMs = 20000, maxHops = PROBE_REDIRECT_HOPS, before = null } = {}) {
  const chain = [];
  const common = { ua, acceptLanguage, timeoutMs, retries: 0, follow: false, maxBytes: 4096 };
  let method = 'HEAD';
  let current = url;
  let res = null;
  for (let i = 0; i <= maxHops; i++) {
    if (before) await before();
    res = await fetchImpl(current, { ...common, method, ...(method === 'GET' ? { headers: { range: 'bytes=0-0' } } : {}) });
    // A server that refuses HEAD (405/501) or answers oddly gets one ranged GET at the same URL.
    if (method === 'HEAD' && (res.status === 405 || res.status === 501 || res.status === 403 || res.status === 0)) {
      method = 'GET';
      if (before) await before();
      res = await fetchImpl(current, { ...common, method, headers: { range: 'bytes=0-0' } });
    }
    const location = res.headers ? res.headers.location : null;
    if (res.status >= 300 && res.status < 400 && location && i < maxHops) {
      chain.push({ url: current, status: res.status, location });
      let next;
      try { next = new URL(location, current).href; } catch { break; }
      if (chain.some((c) => c.url === next) || next === current) { chain.push({ url: next, status: null, location: null, loop: true }); break; }
      current = next;
      continue;
    }
    break;
  }
  const status = res ? res.status : 0;
  const loop = chain.some((c) => c.loop);
  return {
    url, method, status, ok: status >= 200 && status < 300, broken: status === 0 || status >= 400 || loop,
    redirect: chain.length > 0, hops: chain.length, final_url: current, chain, loop,
    error: res && res.error ? res.error : (status === 0 ? 'no response' : null),
  };
}

// ---------------------------------------------------------------------------
// Manifest from a single-page run (no crawl)

/**
 * Synthesize the minimal `crawl.json` a snapshot-only run would have produced, so the checks
 * registry and the score rollup have one shape to read. Reads `<runDir>/pages/*.json` (UA-variant
 * files are ignored) and clusters them with the same templateKey() the crawler uses.
 *
 * @param {string} runDir
 * @param {{target?:string, write?:boolean}} [opts] `write: true` also saves `<runDir>/crawl.json`
 * @returns {object|null} the manifest, or null when the run has no page snapshots
 */
export function manifestFromSinglePage(runDir, opts = {}) {
  const dir = resolve(runDir);
  const pagesDir = join(dir, 'pages');
  if (!existsSync(pagesDir)) return null;
  const files = readdirSync(pagesDir).filter((f) => f.endsWith('.json') && !/\.ua-[^.]+\.json$/.test(f)).sort();
  const snaps = [];
  for (const f of files) {
    const s = readJson(join(pagesDir, f));
    if (s && Number.isInteger(s.snapshot_version)) snaps.push({ file: 'pages/' + f, snap: s });
  }
  if (!snaps.length) return null;

  const target = opts.target || (snaps[0].snap.target && (snaps[0].snap.target.requested_url || snaps[0].snap.target.final_url)) || null;
  const targetKey = target ? dedupeKey(target) : null;
  let origin = null, host = null;
  for (const { snap } of snaps) {
    if (snap.target && snap.target.origin) { origin = snap.target.origin; host = snap.target.host; break; }
  }

  const entries = [];
  const seenTemplates = new Set();
  const pages = snaps.map(({ file, snap }, i) => {
    const url = (snap.target && (snap.target.final_url || snap.target.value)) || file;
    const parsed = snap.parsed_rendered || snap.parsed || {};
    const html = snap.raw_html_path ? readHead(join(dir, snap.raw_html_path)) : ((snap.html_inline && snap.html_inline.raw) || '');
    const info = explainTemplate(url, parsed, { html });
    const isHome = (() => { try { return new URL(url).pathname === '/'; } catch { return false; } })();
    const role = isHome ? 'homepage' : (targetKey && dedupeKey(url) === targetKey ? 'target' : 'sample');
    entries.push({ url, key: info.key, sampled: true, evidence: info.evidence });
    const weight = role === 'homepage' ? ROLE_WEIGHTS.homepage : role === 'target' ? ROLE_WEIGHTS.target
      : (seenTemplates.has(info.key) ? ROLE_WEIGHTS['long-tail'] : ROLE_WEIGHTS['template-sample']);
    if (role === 'sample') seenTemplates.add(info.key);
    return {
      url, slug: (snap.target && snap.target.slug) || null, snapshot: file, role, template: info.key,
      depth: 0, discovered_via: i === 0 ? 'target' : 'snapshot', status: snap.status,
      hops: snap.redirects ? snap.redirects.hops : 0, title: parsed.title ? parsed.title.value : null, h1: firstH1(parsed),
      canonical: canonicalOf(snap), noindex: !!(snap.robots_directives && snap.robots_directives.effective && snap.robots_directives.effective.noindex),
      hreflang_count: hreflangCount(snap), in_sitemap: null, inlinks: null, outlinks_internal: internalLinks(parsed, url).length,
      render: snap.render ? { needed: snap.render.needed, used: snap.render.used, confidence: snap.render.confidence } : null,
      ms: snap.timing ? snap.timing.total_ms : null, weight,
    };
  });

  const robotsJson = readJson(join(dir, 'site', 'robots.json'));
  const sitemapsJson = readJson(join(dir, 'site', 'sitemaps.json'));
  const generated = snaps[0].snap.generated_at || new Date().toISOString();
  const manifest = {
    crawl_version: CRAWL_VERSION, plugin_version: pluginVersion(), generated_at: new Date().toISOString(),
    run_id: snaps[0].snap.run_id || null, run_dir: dir, origin, host, target,
    started_at: generated, finished_at: generated,
    options: { source: 'snapshot', pages: pages.length, crawled: false },
    robots: robotsJson ? {
      status: robotsJson.status, path: 'site/robots.json', mode: robotsJson.mode,
      crawl_delay_s: robotsJson.crawl_delay ? robotsJson.crawl_delay['*'] : null,
      crawl_delay_declared_s: robotsJson.crawl_delay ? robotsJson.crawl_delay['*'] : null,
      root_allowed: robotsJson.verdicts && robotsJson.verdicts[CRAWL_UA_TOKEN] ? robotsJson.verdicts[CRAWL_UA_TOKEN].allowed : null,
      respected: null, ua_token: CRAWL_UA_TOKEN, verdicts: robotsJson.verdicts || null, recorded_uas: RECORDED_UAS.slice(),
    } : null,
    sitemaps: sitemapsJson ? {
      path: 'site/sitemaps.json', files: (sitemapsJson.files || []).length, urls: sitemapsJson.url_count || 0, sampled: 0,
      probe_hits: (sitemapsJson.files || []).filter((f) => f.source === 'well-known' && f.kind && f.kind !== 'invalid' && !f.alias_of).length,
      declared: (sitemapsJson.declared || []).length, truncated: !!sitemapsJson.truncated,
    } : null,
    pages, templates: groupTemplates(entries),
    graph: { nodes: pages.map((p) => p.url), edges: [], edge_count: 0, truncated: false, limit: MAX_GRAPH_EDGES, note: 'no crawl: link graph not built' },
    link_status: { budget: 0, checked: 0, ok: 0, broken: 0, redirects: 0, skipped: 0, results: [] },
    sampling: {
      mode: 'single-page', requested_pages: pages.length, sampled: pages.length, discovered: pages.length,
      seeds: { origin: 0, target: 1, sitemap: 0, extra: 0 },
      skipped_by_robots: skipLog(), skipped_by_filter: skipLog(), skipped_by_depth: skipLog(),
      skipped_by_cap: skipLog(), skipped_by_template: skipLog(), skipped_by_budget: skipLog(),
      redirect_aliases: [], errors: [],
      template_weight: 'share of discovered URLs', per_template: null, depth: null,
    },
    budget: { pages: pages.length, max: pages.length, requests: 0, elapsed_ms: 0, delay_ms: 0, concurrency: 1, link_status: 0, max_reached: false, pages_exhausted: false },
    warnings: ['synthesized from ' + pages.length + ' page snapshot(s); no crawl was run, so inlinks, in_sitemap and the link graph are unknown (null)'],
  };
  if (opts.write) writeJson(join(dir, 'crawl.json'), manifest);
  return manifest;
}

// ---------------------------------------------------------------------------
// The crawl

/**
 * A skip bucket counts DISTINCT URLs. The same URL is discovered from many pages, so counting every
 * discovery would report "cap 97" for a few dozen real URLs and the listed urls[] would repeat.
 * `_seen` is non-enumerable, so it never reaches crawl.json.
 */
function skipLog() {
  const bucket = { count: 0, urls: [], truncated: false };
  Object.defineProperty(bucket, '_seen', { value: new Set(), enumerable: false, writable: false });
  return bucket;
}
/**
 * A skip is identified by its URL and its reason: /blog/a excluded as a link and again after a
 * redirect are two different facts; the same URL hitting the frontier cap ten times is one.
 */
const skipKey = (entry) => [entry.url, entry.filter || entry.rule || entry.reason || '', entry.via || ''].join('|');
function logSkip(bucket, entry) {
  const key = entry && entry.url ? skipKey(entry) : null;
  if (key && bucket._seen) {
    if (bucket._seen.has(key)) return;
    bucket._seen.add(key);
  }
  bucket.count++;
  if (bucket.urls.length < MAX_SKIP_LOG) bucket.urls.push(entry);
  else bucket.truncated = true;
}

/**
 * Crawl `target` into a run directory. Programmatic entry point used by audit.mjs.
 * Options: everything readOptions() yields, plus `fetchImpl`, `run` (an openRun() result to write
 * into), `site` (a fetchSiteArtifacts() result to reuse), `finalize` (default true), `env`.
 * @returns {Promise<{ok, code, manifest?, path?, run?, site?, summary?, error?, detail?}>}
 */
export async function crawlSite(target, options = {}) {
  const o = withDefaults(options);
  const fetchImpl = o.fetchImpl || fetchRaw;
  const started = Date.now();
  const started_at = new Date().toISOString();
  const warnings = [];
  const targetUrl = normalizeUrl(target) || target;
  let origin, host;
  try { const u = new URL(targetUrl); origin = u.origin; host = u.host; }
  catch { return { ok: false, code: EXIT.USAGE, error: 'invalid URL: ' + target }; }
  const homeUrl = origin + '/';

  const rootInfo = resolveRootInfo({ out: o.out }, o.env || process.env);
  const run = o.run || openRun({ root: rootInfo.root, target: targetUrl, runId: o.runId });

  // --- site artifacts once, shared by every page snapshot -------------------
  // `artifacts` is programmatic (audit.mjs and the tests pass it); the CLI only exposes --no-sitemaps.
  const artifacts = normalizeArtifacts(o.artifacts !== undefined ? o.artifacts : (o.useSitemaps ? 'all' : 'robots,discovery'));
  const site = o.site || await fetchSiteArtifacts(origin, {
    fetchImpl, siteDir: run.site_dir, ua: o.ua, acceptLanguage: o.acceptLanguage, timeoutMs: o.timeoutMs,
    artifacts, sitemapMax: o.sitemapMax, sitemapUrlsMax: o.sitemapUrlsMax, targetUrl, reuse: true,
  });
  if (site && Array.isArray(site.warnings)) warnings.push(...site.warnings);

  // --- robots ---------------------------------------------------------------
  const robotsArtifact = site && site.robots ? site.robots : null;
  const rf = robotsArtifact ? { mode: robotsArtifact.mode, robots: robotsArtifact.parsed, reason: robotsArtifact.reason } : { mode: 'allow-all', robots: null, reason: 'no robots artifact' };
  const robotsBlocked = o.respectRobots && rf.mode === 'disallow-all';
  if (!o.respectRobots) warnings.push('--no-robots: robots.txt rules were ignored for this crawl (verdicts are still recorded)');
  if (robotsBlocked) {
    warnings.push('robots.txt is unavailable (' + (robotsArtifact ? 'status ' + robotsArtifact.status : 'no response') + ') — Google treats that as "crawl nothing", so only the requested URL was fetched');
  }
  const verdictFor = (url) => (o.respectRobots ? isAllowed(rf, CRAWL_UA_TOKEN, url) : { allowed: true, via: 'no-robots-flag', rule: null, path: null, token: CRAWL_UA_TOKEN });
  let declaredDelay = null;
  if (rf.mode === 'parsed' && rf.robots) {
    const sel = selectGroup(rf.robots, CRAWL_UA_TOKEN);
    declaredDelay = sel.group && sel.group.crawlDelay != null ? sel.group.crawlDelay : null;
  }
  let crawlDelayS = declaredDelay;
  if (o.respectRobots && crawlDelayS != null && crawlDelayS > MAX_CRAWL_DELAY_S) {
    warnings.push('robots.txt declares Crawl-delay ' + crawlDelayS + 's; clamped to ' + MAX_CRAWL_DELAY_S + 's');
    crawlDelayS = MAX_CRAWL_DELAY_S;
  }
  const robotsDelayMs = o.respectRobots && crawlDelayS != null ? Math.round(crawlDelayS * 1000) : 0;
  const delayMs = Math.max(o.delayMs || 0, robotsDelayMs);
  const lanes = delayMs > 0 ? 1 : Math.max(1, o.concurrency);
  if (robotsDelayMs > 0) warnings.push('Crawl-delay ' + crawlDelayS + 's honoured: one request at a time');
  const pace = pacer(delayMs);
  let requests = 0;

  // --- sitemap seeds --------------------------------------------------------
  const sitemapUrls = [];
  const inSitemap = new Set();
  let sitemapSampled = [];
  if (o.useSitemaps && site && site.sitemaps) {
    const urlsFile = site.files && site.files.sitemap_urls;
    if (urlsFile && existsSync(urlsFile)) {
      for (const line of readFileSync(urlsFile, 'utf8').split(/\r?\n/)) { const s = line.trim(); if (s) sitemapUrls.push(s); }
    } else {
      for (const e of site.sitemaps.sample || []) if (e && e.loc) sitemapUrls.push(e.loc);
    }
    for (const u of sitemapUrls) { const n = normalizeUrl(u); if (n) inSitemap.add(dedupeKey(n)); }
    sitemapSampled = sampleByPattern(sitemapUrls.filter((u) => isInternal(u, origin)), o.sitemapSample);
    if (site.sitemaps.truncated) warnings.push('sitemap discovery was truncated (--sitemap-max/--sitemap-urls-max); the URL set is partial');
  }

  // --- frontier -------------------------------------------------------------
  const nodes = new Map(); // dedupe key -> node
  const order = [];
  const sampling = {
    mode: 'crawl', requested_pages: o.pages, sampled: 0, discovered: 0,
    seeds: { origin: 0, target: 0, sitemap: 0, extra: 0 },
    skipped_by_robots: skipLog(), skipped_by_filter: skipLog(), skipped_by_depth: skipLog(),
    skipped_by_cap: skipLog(), skipped_by_template: skipLog(), skipped_by_budget: skipLog(),
    redirect_aliases: [], errors: [],
    template_weight: 'share of discovered URLs',
    per_template: o.perTemplate, depth: o.depth,
  };
  let maxReached = false;

  const passesFilters = (url) => {
    if (o.include.length && !o.include.some((re) => re.test(url))) return { ok: false, why: 'include' };
    if (o.exclude.length && o.exclude.some((re) => re.test(url))) return { ok: false, why: 'exclude' };
    return { ok: true };
  };

  /** Add a URL to the frontier. `forced` seeds bypass the filters and the per-template cap. */
  function addNode(url, { depth = 0, via = 'link', forced = false, exempt = false, from = null } = {}) {
    const norm = normalizeUrl(url);
    if (!norm || !isInternal(norm, origin)) return null;
    const key = dedupeKey(norm);
    const existing = nodes.get(key);
    if (existing) {
      if (from && !existing.inlink_sources.has(from)) existing.inlink_sources.add(from);
      return existing;
    }
    if (!forced) {
      if (depth > o.depth) { logSkip(sampling.skipped_by_depth, { url: norm, depth }); return null; }
      const f = passesFilters(norm);
      if (!f.ok) { logSkip(sampling.skipped_by_filter, { url: norm, filter: f.why }); return null; }
      if (nodes.size >= o.max) { maxReached = true; logSkip(sampling.skipped_by_cap, { url: norm, max: o.max }); return null; }
    }
    const verdict = verdictFor(norm);
    const allowed = verdict.allowed || exempt;
    const node = {
      url: norm, key, depth, discovered_via: via, forced, index: order.length,
      in_sitemap: inSitemap.has(key), inlink_sources: new Set(from ? [from] : []),
      allowed, robots_exempt: allowed && !verdict.allowed, verdict, queued: false, sampled: false, page: null,
      url_template: templateKey(norm),
    };
    nodes.set(key, node);
    order.push(node);
    if (!allowed) logSkip(sampling.skipped_by_robots, { url: norm, rule: verdict.rule, via: verdict.via });
    return node;
  }

  const queue = [];
  const enqueue = (node) => { if (node && node.allowed && !node.queued && !node.sampled) { node.queued = true; queue.push(node); } };

  const targetIsHome = dedupeKey(targetUrl) === dedupeKey(homeUrl);
  let targetNode = null;
  if (robotsBlocked) {
    // Google's REP reads an unreachable robots.txt as "crawl nothing"; the URL the user asked for
    // is fetched anyway (they asked, and snapshot.mjs would fetch it too) and nothing else is.
    targetNode = addNode(targetUrl, { depth: 0, via: 'target', forced: true, exempt: true });
    if (targetNode) { targetNode.role = targetIsHome ? 'homepage' : 'target'; sampling.seeds.target = 1; enqueue(targetNode); }
  } else {
    const homeNode = addNode(homeUrl, { depth: 0, via: 'origin', forced: true });
    if (homeNode) { homeNode.role = 'homepage'; sampling.seeds.origin = 1; enqueue(homeNode); }
    targetNode = addNode(targetUrl, { depth: 0, via: 'target', forced: true });
    if (targetNode) {
      if (!targetNode.role) targetNode.role = 'target';
      sampling.seeds.target = 1;
      enqueue(targetNode);
    }
    if (targetNode && !targetNode.allowed) {
      warnings.push('the requested URL is disallowed by robots.txt for ' + CRAWL_UA_TOKEN + ' \u2014 it was not fetched; pass --no-robots to override');
    }
    for (const s of o.seeds) { const n = addNode(s, { depth: 0, via: 'seeds', forced: true }); if (n) { sampling.seeds.extra++; enqueue(n); } }
    for (const s of sitemapSampled) {
      const fresh = !nodes.has(dedupeKey(s));
      const n = addNode(s, { depth: 0, via: 'sitemap' });
      if (n) { if (fresh) sampling.seeds.sitemap++; enqueue(n); }
    }
  }

  // --- sampling loop --------------------------------------------------------
  const pages = [];
  const sampledByTemplate = new Map();
  const deferred = [];
  const edges = [];
  let edgesTruncated = false;
  let firstError = null;

  const reserve = (node) => sampledByTemplate.set(node.url_template, (sampledByTemplate.get(node.url_template) || 0) + 1);
  const reserved = (node) => sampledByTemplate.get(node.url_template) || 0;

  async function fetchNode(node) {
    await pace();
    requests++;
    const res = await snapshotUrl(node.url, {
      out: o.out, ua: o.ua, uaPreset: o.uaPreset, lang: o.lang, acceptLanguage: o.acceptLanguage,
      timeoutMs: o.timeoutMs, maxHops: o.maxHops, maxBytes: o.maxBytes, render: o.render, renderer: o.renderer,
      artifacts, run, site, finalize: false, fetchImpl, env: o.env,
    });
    if (!res.ok) {
      if (!firstError) firstError = { url: node.url, error: res.error, detail: res.detail };
      sampling.errors.push({ url: node.url, error: res.error || 'fetch failed', detail: res.detail || null });
      return null;
    }
    const snap = res.snapshot;
    const finalUrl = (snap.target && snap.target.final_url) || node.url;
    const finalKey = dedupeKey(finalUrl);
    if (finalKey !== node.key) {
      // A redirect can land somewhere the filters or robots.txt exclude. The request already went out
      // (the redirect was followed inside one fetch), so the honest move is to drop the page from the
      // manifest and log why — never to smuggle an excluded URL in through a redirect.
      if (!node.forced) {
        const f = passesFilters(finalUrl);
        if (!f.ok) {
          logSkip(sampling.skipped_by_filter, { url: finalUrl, filter: f.why + '-after-redirect', from: node.url });
          node.sampled = true; node.dropped_after_redirect = true;
          return null;
        }
        const v = verdictFor(finalUrl);
        if (!v.allowed) {
          logSkip(sampling.skipped_by_robots, { url: finalUrl, rule: v.rule, via: v.via, from: node.url, note: 'reached by redirect; the page was fetched before the rule could apply' });
          node.sampled = true; node.dropped_after_redirect = true;
          return null;
        }
      }
      const other = nodes.get(finalKey);
      if (other && other.sampled) {
        sampling.redirect_aliases.push({ from: node.url, to: finalUrl, status: snap.status, hops: snap.redirects ? snap.redirects.hops : 0 });
        node.sampled = true; node.alias_of = finalUrl;
        return null;
      }
    }
    const parsed = snap.parsed_rendered || snap.parsed || {};
    const html = snap.raw_html_path ? readHead(join(run.dir, snap.raw_html_path)) : '';
    // A 200 that is not an HTML document (/agents.md, llms.txt, a JSON endpoint, a feed) is not a
    // page: the on-page checks would score it as a broken web page and it would carry page weight
    // in the rollup. The snapshot stays on disk as evidence; the manifest drops it. A forced seed
    // (the audited target, --seed) is kept — the user asked for that URL explicitly.
    if (!node.forced && !isHtmlDocument(snap.headers, html)) {
      logSkip(sampling.skipped_by_filter, { url: finalUrl, filter: 'non-html-response', content_type: mediaTypeOf(snap.headers) || null, from: node.url });
      node.sampled = true;
      node.non_html = true;
      return null;
    }
    const info = explainTemplate(finalUrl, parsed, { html });
    const links = internalLinks(parsed, finalUrl);
    node.sampled = true;
    node.template = info.key;
    node.template_info = info;
    node.snapshot = res.paths ? relPath(run.dir, res.paths.json) : null;
    node.final_url = finalUrl;
    node.links = links;
    node.snap = snap;
    if (finalKey !== node.key && !nodes.has(finalKey)) nodes.set(finalKey, node); // the redirect target resolves here too
    if (node.forced && !isInternal(finalUrl, origin)) {
      warnings.push(node.url + ' redirects to another host (' + finalUrl + '); links found there are outside the crawled origin ' + origin);
    }
    return node;
  }

  function recordPage(node) {
    const snap = node.snap;
    const parsed = snap.parsed_rendered || snap.parsed || {};
    const role = node.role || 'sample';
    const page = {
      url: node.final_url, slug: (snap.target && snap.target.slug) || null, snapshot: node.snapshot, role,
      template: node.template, depth: node.depth, discovered_via: node.discovered_via,
      status: snap.status, hops: snap.redirects ? snap.redirects.hops : 0,
      title: parsed.title ? parsed.title.value : null, h1: firstH1(parsed),
      canonical: canonicalOf(snap), noindex: !!(snap.robots_directives && snap.robots_directives.effective && snap.robots_directives.effective.noindex),
      hreflang_count: hreflangCount(snap), in_sitemap: node.in_sitemap || inSitemap.has(dedupeKey(node.final_url)),
      inlinks: 0, outlinks_internal: node.links.length,
      render: snap.render ? { needed: snap.render.needed, used: snap.render.used, confidence: snap.render.confidence } : null,
      ms: snap.timing ? snap.timing.total_ms : null, weight: ROLE_WEIGHTS['long-tail'],
    };
    node.page = page;
    pages.push(page);
    sampling.sampled = pages.length;
    return page;
  }

  function expand(node) {
    for (const link of node.links) {
      const child = addNode(link, { depth: node.depth + 1, via: 'link', from: node.key });
      if (!child) continue;
      if (edges.length < MAX_GRAPH_EDGES) edges.push([node.index, child.index]);
      else edgesTruncated = true;
      enqueue(child);
    }
  }

  while (pages.length < o.pages && (queue.length || deferred.length)) {
    const batch = [];
    while (queue.length && batch.length < lanes && pages.length + batch.length < o.pages) {
      const node = queue.shift();
      node.queued = false;
      if (node.sampled || !node.allowed) continue;
      if (!node.forced && reserved(node) >= o.perTemplate) { deferred.push(node); continue; }
      reserve(node);
      batch.push(node);
    }
    if (!batch.length) break;
    const done = await runPool(batch, (node) => fetchNode(node), lanes);
    for (const node of done) {
      if (!node) continue;
      recordPage(node);
      expand(node);
    }
  }

  // Round-robin fill across templates from what the per-template cap deferred.
  const deferredKeys = new Set(deferred.map((n) => n.key));
  // A node can be deferred more than once (a second page links to it); fill it at most once.
  const pending = [...new Map(deferred.filter((n) => !n.sampled && n.allowed).map((n) => [n.key, n])).values()];
  if (pages.length < o.pages && pending.length) {
    const byTemplate = new Map();
    for (const n of pending) {
      if (!byTemplate.has(n.url_template)) byTemplate.set(n.url_template, []);
      byTemplate.get(n.url_template).push(n);
    }
    const lists = [...byTemplate.values()];
    const fill = [];
    for (let i = 0; fill.length < o.pages - pages.length; i++) {
      let added = false;
      for (const list of lists) { if (i < list.length) { fill.push(list[i]); added = true; if (fill.length >= o.pages - pages.length) break; } }
      if (!added) break;
    }
    for (let i = 0; i < fill.length; i += lanes) {
      const batch = fill.slice(i, i + lanes).filter((n) => !n.sampled);
      if (!batch.length) continue;
      const done = await runPool(batch, (node) => fetchNode(node), lanes);
      for (const node of done) { if (!node) continue; recordPage(node); expand(node); }
      if (pages.length >= o.pages) break;
    }
  }
  const leftover = order.filter((n) => n.allowed && !n.sampled);
  for (const n of leftover) {
    if (deferredKeys.has(n.key)) logSkip(sampling.skipped_by_template, { url: n.url, template: n.url_template, per_template: o.perTemplate });
    else logSkip(sampling.skipped_by_budget, { url: n.url, reason: 'page budget ' + o.pages + ' reached' });
  }
  if (leftover.length) warnings.push(leftover.length + ' allowed URL(s) were discovered but not sampled (--pages ' + o.pages + ', --per-template ' + o.perTemplate + '); see sampling.skipped_by_template and sampling.skipped_by_budget');
  if (maxReached) warnings.push('the frontier hit --max ' + o.max + ': URLs discovered after the cap were not considered (sampling.skipped_by_cap)');

  // --- inlinks + weights ----------------------------------------------------
  for (const node of nodes.values()) {
    if (node.page) node.page.inlinks = node.inlink_sources.size;
  }
  const seenTemplates = new Set();
  for (const page of pages) {
    if (page.role === 'homepage') page.weight = ROLE_WEIGHTS.homepage;
    else if (page.role === 'target') page.weight = ROLE_WEIGHTS.target;
    else if (page.template && !seenTemplates.has(page.template)) page.weight = ROLE_WEIGHTS['template-sample'];
    else page.weight = ROLE_WEIGHTS['long-tail'];
    if (page.template) seenTemplates.add(page.template);
  }
  sampling.discovered = order.length;

  // --- templates ------------------------------------------------------------
  // A URL that answered with something other than an HTML document (/agents.md, llms.txt, a feed)
  // was never a candidate page: it is logged under sampling.skipped_by_filter with its content type
  // and must not appear as a page template whose "Discovered 1 / Sampled 0" reads like a miss.
  const templateEntries = order.filter((n) => !n.non_html).map((n) => ({
    url: n.final_url || n.url, key: n.template || n.url_template, sampled: !!n.page,
    evidence: n.template_info ? n.template_info.evidence : null,
  }));
  const templates = groupTemplates(templateEntries);

  // --- link-status probes ---------------------------------------------------
  const linkStatus = { budget: o.linkStatus, checked: 0, ok: 0, broken: 0, redirects: 0, skipped: 0, results: [] };
  if (o.linkStatus > 0) {
    const candidates = order
      .filter((n) => !n.page && n.allowed)
      .sort((a, b) => (b.inlink_sources.size - a.inlink_sources.size) || (a.index - b.index));
    // Sitemap URLs nobody linked to are worth a probe too (a 404 in the sitemap is a real finding).
    for (const u of sitemapSampled) {
      const key = dedupeKey(u);
      if (!nodes.has(key)) {
        const norm = normalizeUrl(u);
        if (!norm) continue;
        const verdict = verdictFor(norm);
        if (!verdict.allowed) continue;
        candidates.push({ url: norm, in_sitemap: true, inlink_sources: new Set(), index: order.length + candidates.length });
      }
    }
    const take = candidates.slice(0, o.linkStatus);
    linkStatus.skipped = Math.max(0, candidates.length - take.length);
    if (linkStatus.skipped) warnings.push(linkStatus.skipped + ' internal URL(s) were not probed (--link-status ' + o.linkStatus + ')');
    const countedPace = async () => { requests++; await pace(); };
    const probed = await runPool(take, (n) => probeLinkStatus(n.url, {
      fetchImpl, ua: o.ua, acceptLanguage: o.acceptLanguage, timeoutMs: o.timeoutMs, before: countedPace,
    }), lanes);
    for (let i = 0; i < probed.length; i++) {
      const r = probed[i];
      const n = take[i];
      const entry = { ...r, in_sitemap: !!n.in_sitemap, inlinks: n.inlink_sources ? n.inlink_sources.size : 0 };
      linkStatus.results.push(entry);
      linkStatus.checked++;
      if (r.ok) linkStatus.ok++;
      if (r.broken) linkStatus.broken++;
      if (r.redirect) linkStatus.redirects++;
    }
  }

  // --- manifest -------------------------------------------------------------
  const finished = Date.now();
  const manifest = {
    crawl_version: CRAWL_VERSION, plugin_version: pluginVersion(), generated_at: new Date().toISOString(),
    run_id: run.run_id, run_dir: run.dir, origin, host, target: targetUrl,
    started_at, finished_at: new Date(finished).toISOString(),
    options: {
      pages: o.pages, max: o.max, per_template: o.perTemplate, depth: o.depth, concurrency: lanes, delay_ms: delayMs,
      respect_robots: o.respectRobots, ua: o.ua, ua_preset: o.uaPreset, lang: o.lang, render: o.render, renderer: o.renderer,
      include: o.include.map(String), exclude: o.exclude.map(String), seeds: o.seeds,
      sitemaps: o.useSitemaps, sitemap_sample: o.sitemapSample, link_status: o.linkStatus,
      artifacts: { robots: artifacts.robots, sitemaps: artifacts.sitemaps, discovery: artifacts.discovery },
    },
    robots: {
      status: robotsArtifact ? robotsArtifact.status : null, path: robotsArtifact ? 'site/robots.json' : null,
      mode: rf.mode, crawl_delay_s: crawlDelayS, crawl_delay_declared_s: declaredDelay,
      root_allowed: robotsArtifact && robotsArtifact.verdicts && robotsArtifact.verdicts[CRAWL_UA_TOKEN] ? robotsArtifact.verdicts[CRAWL_UA_TOKEN].allowed : null,
      respected: o.respectRobots, ua_token: CRAWL_UA_TOKEN,
      verdicts: robotsArtifact ? robotsArtifact.verdicts : null,
      recorded_uas: RECORDED_UAS.slice(),
    },
    sitemaps: site && site.sitemaps ? {
      path: 'site/sitemaps.json', files: (site.sitemaps.files || []).length, urls: site.sitemaps.url_count || 0,
      sampled: sitemapSampled.length,
      // An alias is a second NAME for a sitemap this run already has (a legacy path that redirects
      // onto the declared one): guessing it found nothing new, so it is not a probe hit.
      probe_hits: (site.sitemaps.files || []).filter((f) => f.source === 'well-known' && f.kind && f.kind !== 'invalid' && !f.alias_of).length,
      declared: (site.sitemaps.declared || []).length, truncated: !!site.sitemaps.truncated,
    } : { path: null, files: 0, urls: 0, sampled: 0, probe_hits: 0, declared: 0, truncated: false, skipped: !o.useSitemaps },
    pages, templates,
    graph: { nodes: order.map((n) => n.final_url || n.url), edges, edge_count: edges.length, truncated: edgesTruncated, limit: MAX_GRAPH_EDGES },
    link_status: linkStatus,
    sampling,
    budget: {
      pages: o.pages, max: o.max, requests, elapsed_ms: finished - started, delay_ms: delayMs, concurrency: lanes,
      link_status: o.linkStatus, max_reached: maxReached, pages_exhausted: pages.length >= o.pages,
    },
    warnings,
  };

  if (!pages.length && firstError) {
    manifest.warnings.push('no page could be fetched: ' + (firstError.detail || firstError.error));
    const failPath = writeJson(join(run.dir, 'crawl.json'), manifest);
    return {
      ok: false, code: EXIT.RUNTIME, manifest, path: failPath, run, site,
      error: 'fetch failed', detail: firstError.detail || firstError.error,
      target: targetUrl, status: 0, summary: summarize(manifest, failPath, run, rootInfo),
    };
  }
  if (!pages.length) manifest.warnings.push('no page was crawled: every seed was disallowed by robots.txt or filtered out (this is a finding, not a failure)');

  const path = writeJson(join(run.dir, 'crawl.json'), manifest);
  let finalized = null;
  if (o.finalize !== false) {
    const latest = setLatest(run.host_dir, run.run_id);
    const pruned = o.prune ? prune(run.host_dir, o.keep != null ? o.keep : keepFor(run.host_key), [run.run_id]) : null;
    finalized = { latest, pruned };
  }
  return { ok: true, code: EXIT.OK, manifest, path, run, site, finalized, summary: summarize(manifest, path, run, rootInfo) };
}

/** Spread a URL list round-robin across distinct path patterns, so a sample is never all one template. */
export function sampleByPattern(urls, limit) {
  const groups = new Map();
  for (const u of urls || []) {
    const p = pathPattern(u);
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(u);
  }
  const lists = [...groups.values()];
  const out = [];
  for (let i = 0; out.length < limit; i++) {
    let added = false;
    for (const list of lists) {
      if (i >= list.length) continue;
      out.push(list[i]);
      added = true;
      if (out.length >= limit) break;
    }
    if (!added) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Output

function summarize(m, path, run, rootInfo) {
  return {
    crawl: path, run_dir: run.dir, run_id: run.run_id, host_key: run.host_key,
    root: rootInfo ? rootInfo.root : null, root_source: rootInfo ? rootInfo.source : null,
    target: m.target, origin: m.origin,
    pages: m.pages.length, discovered: m.sampling.discovered, templates: m.templates.length,
    robots: { status: m.robots.status, mode: m.robots.mode, crawl_delay_s: m.robots.crawl_delay_s, root_allowed: m.robots.root_allowed, respected: m.robots.respected },
    sitemaps: { files: m.sitemaps.files, urls: m.sitemaps.urls, sampled: m.sitemaps.sampled, probe_hits: m.sitemaps.probe_hits },
    sample: m.pages.map((p) => ({ role: p.role, template: p.template, url: p.url, status: p.status, title: p.title, inlinks: p.inlinks, ms: p.ms })),
    template_table: m.templates.map((t) => ({ key: t.key, discovered: t.discovered, sampled: t.sampled, weight: t.weight })),
    skipped: {
      robots: m.sampling.skipped_by_robots.count, filter: m.sampling.skipped_by_filter.count, depth: m.sampling.skipped_by_depth.count,
      cap: m.sampling.skipped_by_cap.count, per_template: m.sampling.skipped_by_template.count, budget: m.sampling.skipped_by_budget.count,
    },
    link_status: { budget: m.link_status.budget, checked: m.link_status.checked, ok: m.link_status.ok, broken: m.link_status.broken, redirects: m.link_status.redirects },
    budget: m.budget, errors: m.sampling.errors, warnings: m.warnings,
  };
}

export async function main(args) {
  let o, target;
  try { o = readOptions(args); target = classifyTarget(args); }
  catch (e) { if (e instanceof UsageError) return usage(e); throw e; }

  const res = await crawlSite(target, o);
  if (!res.ok) {
    return { result: { error: res.error, detail: res.detail, target: res.target, status: res.status || 0, crawl: res.path || null }, code: res.code };
  }
  if (o.json) return { result: res.manifest, code: EXIT.OK };
  if (o.quiet) return { result: { crawl: res.path, run_dir: res.run.dir, pages: res.manifest.pages.length }, code: EXIT.OK };
  return { result: res.summary, code: EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);

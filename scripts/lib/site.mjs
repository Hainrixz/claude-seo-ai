// Site-level artifacts fetched once per run (zero dependencies): robots.txt (parsed, with per-bot
// verdicts for the audited URL), sitemap discovery (robots `Sitemap:` ∪ well-known paths, recursive,
// gzip-aware) and the AI-discovery probes (/llms.txt, /agents.md, /.well-known/ucp, …) plus an
// HTTPS-enforcement check of http://<host>/. Everything is written under <run>/site/ when `siteDir`
// is given and returned in memory either way. Probe bodies are stored only when small (≤ 256 KB) and
// successful; a text/html body on a text endpoint is flagged (soft 404), never trusted.
//
// Local directory mode (localSiteArtifacts) builds the same three documents from files on disk, with
// status 200/404 meaning "file present/absent" and `source: 'local'` so nobody mistakes it for HTTP.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fetchRaw } from './fetch.mjs';
import { robotsFromFetch, isAllowed, selectGroup, aiPosture, targetPath } from './robots.mjs';
import { discoverSitemaps, parseSitemap, maybeGunzip } from './sitemaps.mjs';
import { runPool } from './pool.mjs';
import { writeJson, writeText, readJson } from './store.mjs';

export const SITE_FILES = Object.freeze({
  robots_txt: 'robots.txt', robots_json: 'robots.json', sitemaps_json: 'sitemaps.json', sitemap_urls: 'sitemap-urls.txt', discovery_json: 'discovery.json',
});
export const DISCOVERY_PROBES = Object.freeze([
  { path: '/llms.txt', saved_as: 'llms.txt', kind: 'text' },
  { path: '/llms-full.txt', saved_as: 'llms-full.txt', kind: 'text' },
  { path: '/agents.md', saved_as: 'agents.md', kind: 'text' },
  { path: '/.well-known/ucp', saved_as: 'ucp.json', kind: 'json' },
  { path: '/.well-known/ai-catalog.json', saved_as: 'ai-catalog.json', kind: 'json' },
  { path: '/sitemap_agentic_discovery.xml', saved_as: 'sitemap_agentic_discovery.xml', kind: 'xml' },
  { path: '/api/ucp/mcp', saved_as: 'ucp-mcp.txt', kind: 'any' },
]);
export const PROBE_LIMITS = Object.freeze({ maxBytes: 512 * 1024, timeoutMs: 8000, saveMaxBytes: 256 * 1024, textHead: 4096, concurrency: 4 });
export const VERDICT_UAS = Object.freeze(['Googlebot', 'Bingbot', 'claude-seo-ai']);
const SITEMAP_FETCH_MAX_BYTES = 52428800 + 4096; // one byte over the 50 MB limit still lets over_50mb be reported

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const HTML_SNIFF_BYTES = 8192;

/**
 * Does this body start an HTML document? Leading whitespace, a UTF-8 BOM and HTML comments are
 * skipped first: a soft 404 whose markup opens with a licence banner ("<!-- BRAND -->\n<!doctype html>")
 * is still HTML, and mistaking it for a text endpoint loses the "HTML instead of the endpoint" hint.
 * Only the first 8 KB is examined; a comment that does not close inside it counts as "not HTML".
 */
export function looksLikeHtml(body) {
  let t = String(body || '').slice(0, HTML_SNIFF_BYTES).replace(/^\uFEFF/, '');
  for (let guard = 0; guard < 16; guard++) {
    const before = t;
    t = t.replace(/^\s+/, '');
    if (t.startsWith('<!--')) {
      const end = t.indexOf('-->');
      if (end === -1) return false; // comment does not close inside the sniff window
      t = t.slice(end + 3);
    }
    if (t === before) break;
  }
  return /^(<!doctype\s+html|<html[\s>])/i.test(t);
}
const looksHtml = looksLikeHtml;

/**
 * A discovery probe that answered 200 with an HTML page is a soft 404: none of these endpoints is
 * an HTML document, so a catch-all app shell at /llms.txt means the file is NOT published. The
 * status alone would say "found" and put a factually false row in the report and in the competitor
 * matrix, so `summary.found` uses this and `summary.soft_404` lists what it dropped — exactly the
 * conclusion ai-discovery.mjs's validators already reach from the same two fields.
 * @param {{ok?: boolean, looks_like_html?: boolean, content_type?: string|null}} probe
 */
export function isSoftHtml404(probe) {
  if (!probe || probe.ok !== true) return false;
  if (probe.looks_like_html === true) return true;
  return typeof probe.content_type === 'string' && /\btext\/html\b/i.test(probe.content_type);
}

/** Media types a fetched URL must declare to count as an HTML page. */
export const HTML_MEDIA_TYPES = Object.freeze(new Set(['text/html', 'application/xhtml+xml']));

/** A response's declared media type, lowercased and without parameters ('' when undeclared). */
export function mediaTypeOf(headers) {
  const h = headers || {};
  for (const name of Object.keys(h)) {
    if (name.toLowerCase() !== 'content-type') continue;
    return String(h[name] == null ? '' : h[name]).split(';')[0].trim().toLowerCase();
  }
  return '';
}

/**
 * True when a response is an HTML document. An undeclared type (a local file, or a server that
 * sends no content-type) is accepted as HTML, as it always was; a declared non-HTML type is
 * believed unless the body itself parses as HTML, so a mislabelled page is still audited while
 * /agents.md, a JSON endpoint or a feed is not. The crawler (which pages to sample) and the checks
 * (which pages to audit) both decide it here, so the two can never disagree.
 */
export function isHtmlDocument(headers, body) {
  const type = mediaTypeOf(headers);
  if (!type) return true;
  if (HTML_MEDIA_TYPES.has(type)) return true;
  return looksLikeHtml(body);
}

/** Normalize the --artifacts flag: 'all' | 'none' | 'robots,sitemaps' | array | object → { robots, sitemaps, discovery, any }. */
export function normalizeArtifacts(value) {
  const all = { robots: true, sitemaps: true, discovery: true };
  let out;
  if (value == null || value === true || value === 'all') out = { ...all };
  else if (value === false || value === 'none') out = { robots: false, sitemaps: false, discovery: false };
  else if (Array.isArray(value) || typeof value === 'string') {
    const list = (Array.isArray(value) ? value : String(value).split(',')).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    if (list.includes('all')) out = { ...all };
    else if (list.includes('none')) out = { robots: false, sitemaps: false, discovery: false };
    else {
      const unknown = list.filter((k) => !(k in all));
      if (unknown.length) throw new Error('unknown artifact(s): ' + unknown.join(', ') + ' (use all|none|robots,sitemaps,discovery)');
      out = { robots: list.includes('robots'), sitemaps: list.includes('sitemaps'), discovery: list.includes('discovery') };
    }
  } else if (typeof value === 'object') out = { robots: !!value.robots, sitemaps: !!value.sitemaps, discovery: !!value.discovery };
  else out = { ...all };
  out.any = out.robots || out.sitemaps || out.discovery;
  return out;
}

// ---------------------------------------------------------------------------
// robots

function crawlDelayFor(rf, ua) {
  if (!rf || rf.mode !== 'parsed') return null;
  const sel = selectGroup(rf.robots, ua);
  return sel.group && sel.group.crawlDelay != null ? sel.group.crawlDelay : null;
}

/** The site/robots.json document. `fetched` is a fetchRaw() result (or a local stand-in), `rf` a robotsFromFetch() result. */
export function buildRobotsArtifact(url, fetched, rf, targetUrl = null, extra = {}) {
  const robots = rf.robots;
  const path = targetUrl ? targetPath(targetUrl) : '/';
  const verdicts = {};
  for (const ua of VERDICT_UAS) verdicts[ua] = isAllowed(rf, ua, path);
  const declared = (robots.groups || []).filter((g) => g.crawlDelay != null).map((g) => ({ agents: g.agents, crawl_delay: g.crawlDelay, line: g.line }));
  return {
    url, status: fetched ? fetched.status : null, final_url: fetched && fetched.final_url ? fetched.final_url : url, ok: !!(fetched && fetched.ok),
    mode: rf.mode, reason: rf.reason, error: fetched && fetched.error ? fetched.error : null,
    redirects: fetched && fetched.redirects ? fetched.redirects : null,
    bytes: fetched && fetched.body ? fetched.body.bytes : null, sha256: fetched && fetched.body ? fetched.body.sha256 : null,
    fetched_at: new Date().toISOString(), source: extra.source || 'http',
    path, verdicts,
    crawl_delay: { Googlebot: crawlDelayFor(rf, 'Googlebot'), '*': crawlDelayFor(rf, '*'), declared },
    content_signals: robots.contentSignals || null,
    sitemaps_declared: robots.sitemaps || [],
    ai_posture: aiPosture(rf, targetUrl || undefined),
    parsed: robots,
  };
}

// ---------------------------------------------------------------------------
// sitemaps

/**
 * A well-known sitemap path (`/sitemap_index.xml`, `/wp-sitemap.xml`, …) that answers 404/410 is the
 * probe working, not a site error: those four paths are guesses, not declarations. They are counted
 * in `probe_misses` and kept out of `errors_total`, so this file and parse-robots-sitemap.mjs agree.
 */
export function isExpectedProbeMiss(f) {
  return !!f && f.source === 'well-known' && (f.status === 404 || f.status === 410);
}

/** Compact site/sitemaps.json: files + counts + a sample; the full URL list goes to sitemap-urls.txt. */
export function summarizeSitemaps(disc, { sample = 50 } = {}) {
  const urls = Array.isArray(disc.urls) ? disc.urls : [];
  const withDate = urls.filter((u) => u.lastmod).map((u) => u.lastmod).sort();
  const files = Array.isArray(disc.files) ? disc.files : [];
  return {
    origin: disc.origin, declared: disc.declared || [], found: disc.found || 0, error: disc.error || null,
    files, url_count: urls.length, urls_file: SITE_FILES.sitemap_urls, sample: urls.slice(0, sample),
    lastmod: { count: withDate.length, min: withDate[0] || null, max: withDate[withDate.length - 1] || null },
    over_50k_any: files.some((f) => f.over_50k), over_50mb_any: files.some((f) => f.over_50mb),
    errors_total: files.reduce((n, f) => n + (Array.isArray(f.errors) ? f.errors.length : 0) + (f.error && !isExpectedProbeMiss(f) ? 1 : 0), 0),
    probe_misses: files.filter(isExpectedProbeMiss).length,
    well_known_only: (disc.declared || []).length === 0 && (disc.found || 0) > 0,
    truncated: !!disc.truncated, truncated_files: !!disc.truncated_files, truncated_urls: !!disc.truncated_urls,
  };
}

// ---------------------------------------------------------------------------
// discovery probes

async function probeDiscovery(base, { fetchImpl, common, siteDir }) {
  const probes = {};
  await runPool(DISCOVERY_PROBES, async (p) => {
    const url = base + p.path;
    let r;
    try { r = await fetchImpl(url, { ...common, timeoutMs: PROBE_LIMITS.timeoutMs, maxBytes: PROBE_LIMITS.maxBytes, retries: 0 }); }
    catch (e) { r = { status: 0, ok: false, final_url: url, redirects: { hops: 0 }, headers: {}, body: { text: '', bytes: 0, truncated: false, sha256: null }, error: String(e && e.message || e) }; }
    const text = (r.body && r.body.text) || '';
    const entry = {
      url, status: r.status, ok: !!r.ok, final_url: r.final_url || url, redirected: !!(r.redirects && r.redirects.hops > 0),
      content_type: (r.headers && r.headers['content-type']) || null, bytes: r.body ? r.body.bytes : 0, truncated: !!(r.body && r.body.truncated),
      sha256: r.body ? r.body.sha256 : null, text_head: text.slice(0, PROBE_LIMITS.textHead), looks_like_html: looksHtml(text),
      json_valid: null, parsed_keys: null, saved_as: null, error: r.error || null,
    };
    if (r.ok && (p.kind === 'json' || /json/i.test(entry.content_type || ''))) {
      try { const j = JSON.parse(text); entry.json_valid = true; entry.parsed_keys = Array.isArray(j) ? ['[array:' + j.length + ']'] : Object.keys(j).slice(0, 50); }
      catch { entry.json_valid = false; }
    }
    if (r.ok && siteDir && entry.bytes > 0 && entry.bytes <= PROBE_LIMITS.saveMaxBytes && !entry.truncated) {
      writeText(join(siteDir, p.saved_as), text);
      entry.saved_as = p.saved_as;
    }
    probes[p.path] = entry;
  }, PROBE_LIMITS.concurrency);

  let https_enforcement;
  const u = new URL(base);
  if (u.protocol === 'https:') {
    const httpUrl = 'http://' + u.host + '/';
    let r;
    try { r = await fetchImpl(httpUrl, { ...common, timeoutMs: PROBE_LIMITS.timeoutMs, maxBytes: 65536, retries: 0 }); }
    catch (e) { r = { status: 0, final_url: httpUrl, status_chain: [], redirects: { hops: 0, http_to_https: false }, error: String(e && e.message || e) }; }
    https_enforcement = {
      applicable: true, url: httpUrl, status: r.status, first_status: r.status_chain && r.status_chain.length ? r.status_chain[0].status : null,
      final_url: r.final_url, hops: r.redirects ? r.redirects.hops : 0,
      redirects_to_https: !!(r.redirects && r.redirects.http_to_https && /^https:/i.test(r.final_url || '')), error: r.error || null,
    };
  } else https_enforcement = { applicable: false, url: null, reason: 'origin is not https' };

  const statuses = {};
  for (const [k, v] of Object.entries(probes)) statuses[k] = v.status;
  return {
    origin: base, fetched_at: new Date().toISOString(), source: 'http', probes, https_enforcement,
    summary: {
      statuses,
      found: Object.keys(probes).filter((k) => probes[k].ok && !isSoftHtml404(probes[k])),
      soft_404: Object.keys(probes).filter((k) => isSoftHtml404(probes[k])),
    },
  };
}

// ---------------------------------------------------------------------------
// public entry points

function readBackSite(siteDir, want) {
  const files = {};
  const out = { robots: null, sitemaps: null, discovery: null };
  if (want.robots || want.sitemaps) { out.robots = readJson(join(siteDir, SITE_FILES.robots_json)); if (out.robots) files.robots_json = join(siteDir, SITE_FILES.robots_json); }
  if (want.sitemaps) { out.sitemaps = readJson(join(siteDir, SITE_FILES.sitemaps_json)); if (out.sitemaps) { files.sitemaps_json = join(siteDir, SITE_FILES.sitemaps_json); if (existsSync(join(siteDir, SITE_FILES.sitemap_urls))) files.sitemap_urls = join(siteDir, SITE_FILES.sitemap_urls); } }
  if (want.discovery) { out.discovery = readJson(join(siteDir, SITE_FILES.discovery_json)); if (out.discovery) files.discovery_json = join(siteDir, SITE_FILES.discovery_json); }
  if (existsSync(join(siteDir, SITE_FILES.robots_txt))) files.robots_txt = join(siteDir, SITE_FILES.robots_txt);
  const complete = (!want.robots || out.robots) && (!want.sitemaps || out.sitemaps) && (!want.discovery || out.discovery);
  return complete ? { ...out, files } : null;
}

/**
 * Fetch robots / sitemaps / discovery for an origin (once per run).
 * @param {string} origin  any URL on the site; its origin is used
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl=fetchRaw]
 * @param {string|null} [opts.siteDir]          write files here when given
 * @param {string} [opts.ua] [opts.uaPreset] [opts.acceptLanguage] [opts.timeoutMs=20000]
 * @param {*} [opts.artifacts='all']            see normalizeArtifacts
 * @param {number} [opts.sitemapMax=50] [opts.sitemapUrlsMax=100000]
 * @param {string|null} [opts.targetUrl]        audited URL for the robots verdicts
 * @param {boolean} [opts.reuse=true]           read back existing files in siteDir instead of refetching
 * @returns {Promise<{origin, fetched_at, reused, robots, sitemaps, discovery, files, warnings}>}
 */
export async function fetchSiteArtifacts(origin, opts = {}) {
  const {
    fetchImpl = fetchRaw, siteDir = null, ua, uaPreset, acceptLanguage, timeoutMs = 20000, artifacts = 'all',
    sitemapMax = 50, sitemapUrlsMax = 100000, targetUrl = null, reuse = true, fetchOpts = {},
  } = opts;
  const warnings = [];
  let base;
  try { base = new URL(origin).origin; } catch { return { origin: String(origin), fetched_at: new Date().toISOString(), reused: false, robots: null, sitemaps: null, discovery: null, files: {}, warnings: ['invalid origin: ' + origin] }; }
  const want = normalizeArtifacts(artifacts);
  const out = { origin: base, fetched_at: new Date().toISOString(), reused: false, robots: null, sitemaps: null, discovery: null, files: {}, warnings };
  if (!want.any) return out;
  if (reuse && siteDir) {
    const back = readBackSite(siteDir, want);
    if (back) return { ...out, ...back, reused: true };
  }
  const common = { ua, uaPreset, acceptLanguage, timeoutMs, ...fetchOpts };
  let robotsFetch = null, rf = null;
  if (want.robots || want.sitemaps) {
    const robotsUrl = base + '/robots.txt';
    try { robotsFetch = await fetchImpl(robotsUrl, { ...common, maxBytes: 1024 * 1024 }); }
    catch (e) { robotsFetch = { status: 0, ok: false, final_url: robotsUrl, error: String(e && e.message || e), body: { text: '', bytes: 0, sha256: null }, redirects: null }; }
    rf = robotsFromFetch(robotsFetch);
    out.robots = buildRobotsArtifact(robotsUrl, robotsFetch, rf, targetUrl);
    if (rf.mode === 'disallow-all') warnings.push('robots.txt unreachable or 5xx: treated as disallow-all (' + (rf.reason || 'no response') + ')');
    if (siteDir && want.robots) {
      if (robotsFetch.ok) out.files.robots_txt = writeText(join(siteDir, SITE_FILES.robots_txt), robotsFetch.body.text);
      out.files.robots_json = writeJson(join(siteDir, SITE_FILES.robots_json), out.robots);
    }
  }
  if (want.sitemaps) {
    const disc = await discoverSitemaps(base, rf, fetchImpl, { maxFiles: sitemapMax, maxUrls: sitemapUrlsMax, fetchOpts: { ...common, maxBytes: SITEMAP_FETCH_MAX_BYTES } });
    out.sitemaps = summarizeSitemaps(disc);
    if (disc.truncated) warnings.push('sitemap discovery truncated (' + (disc.truncated_files ? 'files' : 'urls') + ' cap reached)');
    if (siteDir) {
      out.files.sitemaps_json = writeJson(join(siteDir, SITE_FILES.sitemaps_json), out.sitemaps);
      out.files.sitemap_urls = writeText(join(siteDir, SITE_FILES.sitemap_urls), disc.urls.map((u) => u.loc).join('\n') + (disc.urls.length ? '\n' : ''));
    }
  }
  if (want.discovery) {
    out.discovery = await probeDiscovery(base, { fetchImpl, common, siteDir });
    if (siteDir) out.files.discovery_json = writeJson(join(siteDir, SITE_FILES.discovery_json), out.discovery);
  }
  return out;
}

/**
 * Same three documents for a local directory (a built site on disk). status 200 = file present, 404 = absent;
 * `source: 'local'` everywhere so consumers never read these as HTTP observations.
 */
export function localSiteArtifacts(dir, opts = {}) {
  const { siteDir = null, artifacts = 'all', targetPath: tp = '/' } = opts;
  const want = normalizeArtifacts(artifacts);
  const warnings = [];
  const out = { origin: null, fetched_at: new Date().toISOString(), reused: false, source: 'local', dir, robots: null, sitemaps: null, discovery: null, files: {}, warnings };
  if (!want.any) return out;
  const readLocal = (rel) => {
    const p = join(dir, ...rel.split('/'));
    try { if (statSync(p).isFile()) return readFileSync(p); } catch { /* absent */ }
    return null;
  };
  if (want.robots || want.sitemaps) {
    const buf = readLocal('robots.txt');
    const fetched = buf
      ? { status: 200, ok: true, final_url: 'robots.txt', error: null, body: { text: buf.toString('utf8'), bytes: buf.length, sha256: sha256(buf) }, redirects: null }
      : { status: 404, ok: false, final_url: 'robots.txt', error: null, body: { text: '', bytes: 0, sha256: null }, redirects: null };
    const rf = robotsFromFetch(fetched);
    out.robots = buildRobotsArtifact('robots.txt', fetched, rf, tp, { source: 'local' });
    if (!buf) warnings.push('no robots.txt in ' + dir + ' (a deployed site may still serve a virtual one)');
    if (siteDir && want.robots) {
      if (buf) out.files.robots_txt = writeText(join(siteDir, SITE_FILES.robots_txt), buf);
      out.files.robots_json = writeJson(join(siteDir, SITE_FILES.robots_json), out.robots);
    }
  }
  if (want.sitemaps) {
    let names = [];
    try { names = readdirSync(dir).filter((n) => /^sitemap[^/]*\.xml(\.gz)?$/i.test(n)).sort(); } catch { /* unreadable */ }
    const files = [], urls = [];
    for (const n of names) {
      const raw = readLocal(n);
      const inflated = maybeGunzip(raw);
      const sm = parseSitemap(inflated.buf.toString('utf8'));
      files.push({ url: n, source: 'local', parent: null, depth: 0, status: 200, bytes: inflated.buf.length, gz: inflated.gz, kind: sm.kind, url_count: sm.url_count, over_50k: sm.url_count > 50000, over_50mb: inflated.buf.length > 52428800, errors: sm.errors, lastmod: sm.lastmod, namespaces: sm.namespaces, error: inflated.error || null });
      if (sm.kind === 'urlset') for (const e of sm.entries) if (e.loc) urls.push({ loc: e.loc, lastmod: e.lastmod_iso || e.lastmod || null, sitemap: n });
    }
    const declared = out.robots ? out.robots.sitemaps_declared : [];
    out.sitemaps = summarizeSitemaps({ origin: null, declared, files, urls, found: files.filter((f) => f.kind && f.kind !== 'invalid').length, truncated: false, truncated_files: false, truncated_urls: false });
    out.sitemaps.source = 'local';
    if (siteDir) {
      out.files.sitemaps_json = writeJson(join(siteDir, SITE_FILES.sitemaps_json), out.sitemaps);
      out.files.sitemap_urls = writeText(join(siteDir, SITE_FILES.sitemap_urls), urls.map((u) => u.loc).join('\n') + (urls.length ? '\n' : ''));
    }
  }
  if (want.discovery) {
    const probes = {};
    for (const p of DISCOVERY_PROBES) {
      const rel = p.path.replace(/^\//, '');
      const buf = readLocal(rel);
      const text = buf ? buf.toString('utf8') : '';
      const entry = { url: rel, status: buf ? 200 : 404, ok: !!buf, final_url: rel, redirected: false, content_type: null, bytes: buf ? buf.length : 0, truncated: false, sha256: buf ? sha256(buf) : null, text_head: text.slice(0, PROBE_LIMITS.textHead), looks_like_html: looksHtml(text), json_valid: null, parsed_keys: null, saved_as: null, error: null };
      if (buf && p.kind === 'json') { try { const j = JSON.parse(text); entry.json_valid = true; entry.parsed_keys = Array.isArray(j) ? ['[array:' + j.length + ']'] : Object.keys(j).slice(0, 50); } catch { entry.json_valid = false; } }
      if (buf && siteDir && buf.length <= PROBE_LIMITS.saveMaxBytes) { writeText(join(siteDir, p.saved_as), buf); entry.saved_as = p.saved_as; }
      probes[p.path] = entry;
    }
    const statuses = {};
    for (const [k, v] of Object.entries(probes)) statuses[k] = v.status;
    out.discovery = {
      origin: null, fetched_at: new Date().toISOString(), source: 'local', probes,
      https_enforcement: { applicable: false, url: null, reason: 'local directory' },
      summary: {
        statuses,
        found: Object.keys(probes).filter((k) => probes[k].ok && !isSoftHtml404(probes[k])),
        soft_404: Object.keys(probes).filter((k) => isSoftHtml404(probes[k])),
      },
    };
    if (siteDir) out.files.discovery_json = writeJson(join(siteDir, SITE_FILES.discovery_json), out.discovery);
  }
  return out;
}

#!/usr/bin/env node
// Acquire one page (or a built site on disk) into a persisted PageSnapshot v2 that every other script
// can read back with `--snapshot <pages/<slug>.json>`.
//
// Usage:
//   node snapshot.mjs <url|path> [--out <runs-root>] [--run <id>] [--no-persist] [--ua default|googlebot|bingbot|gptbot|<literal>]
//                     [--lang es] [--timeout 20000] [--max-hops 10] [--max-bytes 5000000]
//                     [--render auto|static|js] [--renderer auto|chrome|playwright|none] [--rendered-file <dom.html>]
//                     [--artifacts all|none|robots,sitemaps,discovery] [--sitemap-max 50] [--sitemap-urls-max 100000]
//                     [--keep 20] [--no-prune] [--json] [--quiet]
//   node snapshot.mjs --url <u>            same as the positional form
//   node snapshot.mjs --file <index.html> [--url <page url>]   local file (status null, headers {})
//   node snapshot.mjs ./dist                directory: index.html as homepage + *.html pages (≤ 50), local robots/sitemap/llms.txt
//
// Exit codes: 0 snapshot written (also for 4xx/5xx pages, redirect loops and a missing renderer — those are
// findings, not failures) · 1 usage (no/invalid target or flag) · 2 runtime (network failure, or a framework
// source directory with no built HTML: "build first or give the deployed URL").
//
// Stdout is a compact summary (paths + counts) — never HTML. `--json` prints the full snapshot instead.
// Persisted layout: <root>/<hostkey>/<run-id>/pages/<slug>.json + .html [+ .rendered.html]; a non-default
// --ua writes pages/<slug>.ua-<preset>.json/.html. Site artifacts (once per run) go to <run>/site/.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXIT, isMain, runCli } from './lib/util.mjs';
import { parseDocument } from './lib/html.mjs';
import { fetchRaw, resolveUa, parseLinkHeader, DEFAULT_ACCEPT_LANGUAGE, UA_PRESETS } from './lib/fetch.mjs';
import {
  resolveRootInfo, hostKey, pageSlug, openRun, writeJson, writeText, setLatest, prune, keepFor, pluginVersion, relPath, isHttpUrl, looksLikeHost, sha1,
} from './lib/store.mjs';
import { needsRender, findChrome, renderWithChrome, renderWithPlaywright, playwrightAvailable, renderDelta, PLAYWRIGHT_HINT, CHROME_HINT } from './lib/renderers.mjs';
import { fetchSiteArtifacts, localSiteArtifacts, normalizeArtifacts } from './lib/site.mjs';

export const SNAPSHOT_VERSION = 2;
export const RENDER_MODES = Object.freeze(['auto', 'static', 'js']);
export const RENDERERS = Object.freeze(['auto', 'chrome', 'playwright', 'none']);
export const MAX_LOCAL_PAGES = 50;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.nuxt', '.svelte-kit', '.cache', '.turbo', '.vercel', '.netlify', '.parcel-cache', '.output']);
const FRAMEWORK_FILES = ['next.config.js', 'next.config.mjs', 'next.config.ts', 'nuxt.config.ts', 'nuxt.config.js', 'astro.config.mjs', 'astro.config.ts', 'astro.config.js',
  'svelte.config.js', 'remix.config.js', 'react-router.config.ts', 'gatsby-config.js', 'gatsby-config.ts', 'angular.json', 'vite.config.ts', 'vite.config.js', 'vite.config.mjs'];
const FRAMEWORK_DIRS = ['app', 'pages', 'src'];
const ROBOTS_DIRECTIVES = new Set(['all', 'none', 'noindex', 'nofollow', 'noarchive', 'nosnippet', 'noimageindex', 'notranslate', 'indexifembedded',
  'nositelinkssearchbox', 'noodp', 'noydir', 'max-snippet', 'max-image-preview', 'max-video-preview', 'unavailable_after']);

class UsageError extends Error { constructor(message, hint) { super(message); this.hint = hint || null; } }
const usage = (e) => ({ result: { error: e.message, ...(e.hint ? { hint: e.hint } : {}) }, code: EXIT.USAGE });
const USAGE_HINT = 'node snapshot.mjs <url|path> [--out <dir>] [--render auto|static|js] [--ua googlebot] [--json]';

// ---------------------------------------------------------------------------
// Options

function acceptLanguageFor(lang) {
  if (!lang) return DEFAULT_ACCEPT_LANGUAGE;
  const s = String(lang).trim();
  if (/[,;]/.test(s)) return s;
  const primary = s.split('-')[0];
  return primary !== s ? `${s},${primary};q=0.9` : s;
}

export function readOptions(args = {}) {
  const str = (k) => (typeof args[k] === 'string' && args[k].trim() ? args[k].trim() : undefined);
  const int = (k, def, min) => {
    const v = args[k];
    if (v === undefined || v === true) return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) throw new UsageError(`--${k} must be an integer >= ${min}`, USAGE_HINT);
    return n;
  };
  const oneOf = (k, list, def) => {
    const v = args[k];
    if (v === undefined || v === true) return def;
    const s = String(v).toLowerCase();
    if (!list.includes(s)) throw new UsageError(`--${k} must be one of ${list.join('|')}`, USAGE_HINT);
    return s;
  };
  let artifacts;
  try { artifacts = normalizeArtifacts(args.artifacts === undefined ? 'all' : args.artifacts); }
  catch (e) { throw new UsageError('--artifacts: ' + e.message, USAGE_HINT); }
  const uaRes = resolveUa({ ua: str('ua') });
  const renderedFile = str('rendered-file');
  if (renderedFile && !existsSync(renderedFile)) throw new UsageError('--rendered-file not found: ' + renderedFile);
  return {
    out: str('out'), runId: str('run'), persist: args.persist !== false, prune: args.prune !== false, keep: args.keep === undefined || args.keep === true ? null : int('keep', null, 0),
    ua: uaRes.ua, uaPreset: uaRes.preset, lang: str('lang') || null, acceptLanguage: acceptLanguageFor(str('lang')),
    timeoutMs: int('timeout', 20000, 1), maxHops: int('max-hops', 10, 0), maxBytes: int('max-bytes', 5_000_000, 1024),
    render: oneOf('render', RENDER_MODES, 'auto'), renderer: oneOf('renderer', RENDERERS, 'auto'), renderedFile: renderedFile || null,
    artifacts, sitemapMax: int('sitemap-max', 50, 1), sitemapUrlsMax: int('sitemap-urls-max', 100000, 1),
    json: !!args.json, quiet: !!args.quiet, pageUrl: str('url') || null,
  };
}

function classifyTarget(args) {
  const pos = Array.isArray(args._) && typeof args._[0] === 'string' ? args._[0].trim() : '';
  const file = typeof args.file === 'string' ? args.file.trim() : '';
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  const raw = pos || file || url;
  if (!raw) throw new UsageError('provide a target: <url|path>, --url <u> or --file <path>', USAGE_HINT);
  if (isHttpUrl(raw)) {
    let href;
    try { href = new URL(raw).href; } catch { throw new UsageError('invalid URL: ' + raw, USAGE_HINT); }
    return { kind: 'url', url: href, value: raw };
  }
  let local = raw;
  if (/^file:\/\//i.test(raw)) { try { local = decodeURIComponent(new URL(raw).pathname); } catch { local = raw.replace(/^file:\/\//i, ''); } }
  if (existsSync(local)) {
    const st = statSync(local);
    return { kind: st.isDirectory() ? 'dir' : 'file', value: resolve(local) };
  }
  if (!file && looksLikeHost(raw)) return { kind: 'url', url: 'https://' + raw + (raw.includes('/') ? '' : '/'), value: raw };
  throw new UsageError('target not found: ' + raw + ' (not a URL and no such file or directory)', USAGE_HINT);
}

// ---------------------------------------------------------------------------
// Robots directives (X-Robots-Tag + meta robots/googlebot/bingbot)

/**
 * Parse an X-Robots-Tag / meta robots value into [{ agent, name, value, raw }]. A leading bot token
 * ("googlebot: noindex, nofollow") scopes every directive that follows it in the same value, as Google
 * documents for X-Robots-Tag; `agent` is the default scope (null = all crawlers).
 */
export function parseRobotsDirectives(value, agent = null) {
  const out = [];
  let scope = agent;
  for (const piece of String(value == null ? '' : value).split(',')) {
    let tok = piece.trim();
    if (!tok) continue;
    let name = tok.toLowerCase(), val = null;
    const colon = tok.indexOf(':');
    if (colon !== -1) {
      let left = tok.slice(0, colon).trim().toLowerCase();
      let right = tok.slice(colon + 1).trim();
      if (!ROBOTS_DIRECTIVES.has(left) && /^[a-z0-9_.-]+$/i.test(left) && right) {
        scope = left; // bot-scoped: the remainder of this value belongs to that bot
        tok = right;
        const c2 = tok.indexOf(':');
        if (c2 === -1) { out.push({ agent: scope, name: tok.toLowerCase(), value: null, raw: tok }); continue; }
        left = tok.slice(0, c2).trim().toLowerCase(); right = tok.slice(c2 + 1).trim();
      }
      name = left; val = right || null;
    }
    out.push({ agent: scope, name, value: val, raw: tok });
  }
  return out;
}

const GOOGLE_AGENTS = new Set([null, 'robots', '*', 'googlebot']);

export function effectiveRobots(directives) {
  const list = directives.filter((d) => GOOGLE_AGENTS.has(d.agent));
  const names = new Set(list.map((d) => d.name));
  const nums = (n) => list.filter((d) => d.name === n).map((d) => Number(d.value)).filter(Number.isFinite);
  const firstVal = (n) => { const d = list.find((x) => x.name === n); return d ? d.value : null; };
  const maxSnippet = nums('max-snippet'), maxVideo = nums('max-video-preview');
  const eff = {
    noindex: names.has('noindex') || names.has('none'),
    nofollow: names.has('nofollow') || names.has('none'),
    nosnippet: names.has('nosnippet'), noarchive: names.has('noarchive'), noimageindex: names.has('noimageindex'),
    notranslate: names.has('notranslate'), indexifembedded: names.has('indexifembedded'),
    max_snippet: maxSnippet.length ? Math.min(...maxSnippet) : null,
    max_image_preview: firstVal('max-image-preview'), max_video_preview: maxVideo.length ? Math.min(...maxVideo) : null,
    unavailable_after: firstVal('unavailable_after'),
    directives: [...names].sort(), agents_seen: [...new Set(directives.map((d) => d.agent || 'all'))].sort(),
  };
  eff.indexable = !eff.noindex;
  eff.snippet_eligible = !eff.nosnippet && eff.max_snippet !== 0;
  return eff;
}

export function robotsDirectives(headers, parsed) {
  const raw = headers && headers['x-robots-tag'] != null ? String(headers['x-robots-tag']) : null;
  const headerDirectives = raw ? parseRobotsDirectives(raw) : [];
  const meta = (parsed && Array.isArray(parsed.robots_meta) ? parsed.robots_meta : []).map((m) => ({
    name: m.name, content: m.content, directives: parseRobotsDirectives(m.content, m.name === 'robots' ? null : m.name),
  }));
  const all = [...headerDirectives.map((d) => ({ ...d, source: 'header' })), ...meta.flatMap((m) => m.directives.map((d) => ({ ...d, source: 'meta' })))];
  const sources = [];
  if (headerDirectives.length) sources.push('header');
  if (meta.length) sources.push('meta');
  return { header: { raw, directives: headerDirectives }, meta, effective: effectiveRobots(all), sources };
}

function headerLinks(headers, base) {
  const all = parseLinkHeader(headers && headers.link, base);
  const rels = (l) => String(l.rel || '').split(/\s+/).filter(Boolean);
  const canonical = all.find((l) => rels(l).includes('canonical'));
  return {
    all,
    canonical: canonical ? canonical.url : null,
    alternates: all.filter((l) => rels(l).includes('alternate') && l.hreflang).map((l) => ({ hreflang: l.hreflang, url: l.url })),
  };
}

// ---------------------------------------------------------------------------
// Rendering

function pickRenderer(pref) {
  if (pref === 'none') return { kind: 'none', bin: null, source: null, hint: 'rendering disabled with --renderer none' };
  if (pref === 'chrome' || pref === 'auto') {
    const c = findChrome();
    if (c) return { kind: 'chrome', bin: c.path, source: c.source, hint: null };
    if (pref === 'chrome') return { kind: 'none', bin: null, source: null, hint: CHROME_HINT };
  }
  if (pref === 'playwright' || pref === 'auto') {
    const p = playwrightAvailable();
    if (p.available) return { kind: 'playwright', bin: p.path, source: 'node_modules', hint: null };
    if (pref === 'playwright') return { kind: 'none', bin: null, source: null, hint: PLAYWRIGHT_HINT };
  }
  return { kind: 'none', bin: null, source: null, hint: 'No renderer available. ' + CHROME_HINT + ' ' + PLAYWRIGHT_HINT };
}

async function performRender({ parsed, html, renderUrl, o, warnings }) {
  const need = html && html.trim() ? needsRender(parsed) : { needed: false, signals: [], markers: [], word_count: 0 };
  const render = {
    needed: need.needed, signals: need.signals, markers: need.markers, mode: o.render, renderer: o.renderer,
    used: 'none', renderer_path: null, confidence: need.needed ? 'reduced' : 'static', available: null, hint: null, ms: null, error: null, delta: null,
  };
  if (!html || !html.trim()) { render.confidence = 'not_applicable'; return { render, renderedHtml: null, parsedRendered: null }; }
  let renderedHtml = null;
  if (o.renderedFile) {
    renderedHtml = readFileSync(o.renderedFile, 'utf8');
    render.used = 'external'; render.renderer_path = resolve(o.renderedFile); render.available = true; render.confidence = 'full';
  } else if (o.render === 'static') {
    if (need.needed) {
      render.hint = 'static HTML looks JS-dependent (' + need.signals.join(', ') + '); re-run with --render auto or --render js, or pass --rendered-file <dom.html>';
      warnings.push('render skipped by --render static although the page looks JS-dependent');
    }
  } else if (o.render === 'js' || need.needed) {
    const choice = pickRenderer(o.renderer);
    render.available = choice.kind !== 'none';
    render.renderer_path = choice.bin;
    if (choice.kind === 'none') {
      render.hint = choice.hint;
      render.confidence = 'reduced';
      warnings.push('renderer unavailable: ' + choice.hint);
    } else {
      const renderTimeoutMs = Math.max(30000, o.timeoutMs * 2);
      const res = choice.kind === 'chrome'
        ? await renderWithChrome(choice.bin, renderUrl, { ua: o.ua, lang: o.acceptLanguage, timeoutMs: renderTimeoutMs })
        : await renderWithPlaywright(renderUrl, { ua: o.ua, lang: o.acceptLanguage, timeoutMs: renderTimeoutMs });
      render.ms = res.ms;
      if (res.ok && res.html && res.html.trim()) {
        renderedHtml = res.html; render.used = choice.kind; render.confidence = 'full';
        if (choice.kind === 'chrome' && res.exit) render.chrome_exit = res.exit;
      } else {
        render.error = res.error || 'render produced no DOM';
        render.confidence = 'reduced';
        render.hint = choice.kind + ' failed: ' + render.error + '. Pass --rendered-file <dom.html> to supply a DOM captured elsewhere.';
        warnings.push('render failed (' + choice.kind + '): ' + render.error);
      }
    }
  }
  let parsedRendered = null;
  if (renderedHtml != null) {
    parsedRendered = parseDocument(renderedHtml, parsed && parsed.effective_base ? parsed.effective_base : (renderUrl && !renderUrl.startsWith('file:') ? renderUrl : null));
    render.delta = renderDelta(parsed, parsedRendered);
  }
  return { render, renderedHtml, parsedRendered };
}

// ---------------------------------------------------------------------------
// Snapshot assembly

function uaSuffix(o) {
  if (!o.uaPreset) return '.ua-custom-' + sha1(o.ua).slice(0, 6);
  return o.uaPreset === 'default' ? '' : '.ua-' + o.uaPreset;
}

function sitePaths(run, site) {
  if (!site) return { robots: null, sitemaps: null, sitemap_urls: null, discovery: null, robots_txt: null };
  const f = site.files || {};
  const rel = (p) => (p && run ? relPath(run.dir, p) : null);
  return { robots: rel(f.robots_json), sitemaps: rel(f.sitemaps_json), sitemap_urls: rel(f.sitemap_urls), discovery: rel(f.discovery_json), robots_txt: rel(f.robots_txt) };
}

function buildSnapshot(ctx) {
  const { target, request, fetch: r, html, parsed, renderRes, run, site, warnings, error } = ctx;
  const headers = { ...(r.headers || {}) };
  const cookieNames = Array.isArray(headers.cookie_names) ? headers.cookie_names : [];
  delete headers.cookie_names;
  const body = r.body ? {
    bytes: r.body.bytes, truncated: !!r.body.truncated, charset: r.body.charset || null, charset_source: r.body.charset_source || null,
    content_encoding: r.body.content_encoding || null, gunzipped: !!r.body.gunzipped, sha256: r.body.sha256 || null,
  } : { bytes: 0, truncated: false, charset: null, charset_source: null, content_encoding: null, gunzipped: false, sha256: null };
  const snap = {
    snapshot_version: SNAPSHOT_VERSION, plugin_version: pluginVersion(), generated_at: new Date().toISOString(), run_id: run ? run.run_id : null,
    target, request,
    status_chain: r.status_chain || [], status: r.status, ok: !!r.ok, redirects: r.redirects,
    headers, cookie_names: cookieNames,
    header_links: headerLinks(headers, target.final_url && !target.final_url.startsWith('file:') ? target.final_url : null),
    robots_directives: robotsDirectives(headers, parsed),
    body, timing: r.timing || { ttfb_ms: null, download_ms: null, total_ms: null },
    raw_html_path: null, rendered_html_path: null,
    render: renderRes.render, parsed, parsed_rendered: renderRes.parsedRendered,
    site: sitePaths(run, site),
    warnings, tier: renderRes.render.used === 'none' ? 0 : 1, error: error || null,
  };
  if (!run) snap.html_inline = { raw: html, rendered: renderRes.renderedHtml };
  return snap;
}

function persistPage(run, snap, html, renderedHtml, slug, suffix) {
  const base = slug + suffix;
  const htmlAbs = writeText(join(run.pages_dir, base + '.html'), html);
  snap.raw_html_path = 'pages/' + base + '.html';
  let renderedAbs = null;
  if (renderedHtml != null) {
    renderedAbs = writeText(join(run.pages_dir, base + '.rendered.html'), renderedHtml);
    snap.rendered_html_path = 'pages/' + base + '.rendered.html';
  }
  const jsonAbs = writeJson(join(run.pages_dir, base + '.json'), snap);
  return { json: jsonAbs, html: htmlAbs, rendered_html: renderedAbs };
}

function finalizeRun(run, o) {
  const latest = setLatest(run.host_dir, run.run_id);
  let pruned = null;
  if (o.prune) pruned = prune(run.host_dir, o.keep != null ? o.keep : keepFor(run.host_key), [run.run_id]);
  return { latest, pruned };
}

function counts(snap) {
  const p = snap.parsed || {};
  const anchors = Array.isArray(p.anchors) ? p.anchors : [];
  const hl = snap.header_links || { canonical: null, alternates: [] };
  return {
    title: p.title ? p.title.value : null,
    headings: Array.isArray(p.headings) ? p.headings.length : 0,
    h1: Array.isArray(p.headings) ? p.headings.filter((h) => h.level === 1 && !h.aria).length : 0,
    links_total: anchors.length, links_internal: anchors.filter((a) => a.internal === true).length,
    images: Array.isArray(p.images) ? p.images.length : 0,
    jsonld_blocks: Array.isArray(p.jsonld) ? p.jsonld.length : 0, jsonld_invalid: Array.isArray(p.jsonld) ? p.jsonld.filter((j) => !j.ok).length : 0,
    canonicals: (Array.isArray(p.canonicals) ? p.canonicals.length : 0) + (hl.canonical ? 1 : 0),
    hreflang: (Array.isArray(p.hreflang) ? p.hreflang.length : 0) + (hl.alternates ? hl.alternates.length : 0),
    word_count: p.word_count || 0,
  };
}

function siteSummary(site) {
  if (!site) return null;
  const r = site.robots, s = site.sitemaps, d = site.discovery;
  return {
    reused: !!site.reused,
    robots: r ? { status: r.status, mode: r.mode, googlebot_allowed: r.verdicts && r.verdicts.Googlebot ? r.verdicts.Googlebot.allowed : null, sitemaps_declared: (r.sitemaps_declared || []).length, content_signals: !!(r.content_signals && r.content_signals.present) } : null,
    sitemaps_files: s ? s.files.length : null, sitemaps_found: s ? s.found : null, sitemap_urls: s ? s.url_count : null,
    discovery: d ? d.summary.statuses : null,
    https_enforced: d && d.https_enforcement ? (d.https_enforcement.applicable ? d.https_enforcement.redirects_to_https : null) : null,
  };
}

function summarize(snap, paths, run, site, rootInfo) {
  const rd = snap.redirects || {};
  return {
    snapshot: paths ? paths.json : null, run_dir: run ? run.dir : null, run_id: run ? run.run_id : null, host_key: run ? run.host_key : null,
    root: rootInfo ? rootInfo.root : null, root_source: rootInfo ? rootInfo.source : null,
    target: snap.target.requested_url || snap.target.value, final_url: snap.target.final_url, status: snap.status, ok: snap.ok,
    hops: rd.hops || 0, redirects: { loop: !!rd.loop, truncated: !!rd.truncated, http_to_https: !!rd.http_to_https, host_changed: !!rd.host_changed, www_normalized: !!rd.www_normalized },
    render: { needed: snap.render.needed, used: snap.render.used, confidence: snap.render.confidence, signals: snap.render.signals, hint: snap.render.hint,
      delta: snap.render.delta ? { headings: snap.render.delta.headings, anchors: snap.render.delta.anchors, jsonld_blocks: snap.render.delta.jsonld_blocks, words: snap.render.delta.words } : null },
    counts: counts(snap),
    robots: { noindex: snap.robots_directives.effective.noindex, nosnippet: snap.robots_directives.effective.nosnippet, max_snippet: snap.robots_directives.effective.max_snippet, sources: snap.robots_directives.sources },
    site: siteSummary(site),
    tier: snap.tier, warnings: snap.warnings, error: snap.error,
  };
}

/** Preset name whose header value equals `ua` (so a literal preset string is not filed as "custom"). */
function presetForUa(ua) {
  for (const [name, value] of Object.entries(UA_PRESETS)) if (value === ua) return name;
  return null;
}

function withDefaults(opts) {
  const base = readOptions({});
  const o = { ...base, ...(opts || {}) };
  if (opts && opts.artifacts !== undefined) o.artifacts = normalizeArtifacts(opts.artifacts);
  if (opts && opts.ua !== undefined && opts.uaPreset === undefined) {
    const u = resolveUa({ ua: opts.ua });
    o.ua = u.ua; o.uaPreset = u.preset || presetForUa(u.ua);
  }
  if (opts && opts.lang !== undefined && opts.acceptLanguage === undefined) o.acceptLanguage = acceptLanguageFor(opts.lang);
  return o;
}

// ---------------------------------------------------------------------------
// URL mode (also the programmatic entry point for the crawler)

/**
 * Snapshot one URL. Options: everything readOptions() yields (out, runId, persist, prune, keep, ua, lang, timeoutMs,
 * maxHops, maxBytes, render, renderer, renderedFile, artifacts, sitemapMax, sitemapUrlsMax) plus
 * `run` (an openRun() result to write into), `site` (a fetchSiteArtifacts() result to reuse), `fetchImpl`,
 * `finalize` (default true: update latest + prune), `env`.
 * @returns {Promise<{ok:boolean, code:number, snapshot?:object, paths?:object|null, run?:object|null, site?:object|null, summary?:object, error?:string, detail?:string}>}
 */
export async function snapshotUrl(url, opts = {}) {
  const o = withDefaults(opts);
  const fetchImpl = o.fetchImpl || fetchRaw;
  const warnings = [];
  const r = await fetchImpl(url, { ua: o.ua, acceptLanguage: o.acceptLanguage, timeoutMs: o.timeoutMs, maxHops: o.maxHops, maxBytes: o.maxBytes });
  if (r.status === 0 && !(r.status_chain && r.status_chain.length)) {
    return { ok: false, code: EXIT.RUNTIME, error: 'fetch failed', detail: r.error || 'no response', target: url, status: 0, attempts: r.attempts };
  }
  const finalUrl = r.final_url || url;
  const html = (r.body && r.body.text) || '';
  if (r.error) warnings.push(r.error);
  if (r.body && r.body.truncated) warnings.push('body truncated at --max-bytes ' + o.maxBytes + ' — parsed data is partial');
  if (r.body && r.body.charset_fallback) warnings.push('declared charset ' + r.body.charset + ' unsupported; decoded as utf-8');
  const parsed = parseDocument(html, finalUrl);

  const rootInfo = o.persist ? resolveRootInfo({ out: o.out }, o.env || process.env) : null;
  const run = o.persist ? (o.run || openRun({ root: rootInfo.root, target: url, runId: o.runId })) : null;
  let site = null;
  if (o.artifacts.any) {
    let origin = null;
    try { origin = new URL(finalUrl).origin; } catch { origin = null; }
    if (origin) {
      site = o.site || await fetchSiteArtifacts(origin, {
        fetchImpl, siteDir: run ? run.site_dir : null, ua: o.ua, acceptLanguage: o.acceptLanguage, timeoutMs: o.timeoutMs,
        artifacts: o.artifacts, sitemapMax: o.sitemapMax, sitemapUrlsMax: o.sitemapUrlsMax, targetUrl: finalUrl, reuse: true,
      });
      if (site && Array.isArray(site.warnings)) warnings.push(...site.warnings);
    }
  }
  const renderRes = await performRender({ parsed, html, renderUrl: finalUrl, o, warnings });

  let host = null; try { host = new URL(finalUrl).host; } catch { /* keep null */ }
  let origin = null; try { origin = new URL(finalUrl).origin; } catch { /* keep null */ }
  const slug = pageSlug(finalUrl);
  const target = { kind: 'url', value: url, requested_url: url, final_url: finalUrl, host, origin, slug, path: null };
  const request = { ua_preset: o.uaPreset || 'custom', user_agent: o.ua, accept_language: o.acceptLanguage, timeout_ms: o.timeoutMs, max_hops: o.maxHops, max_bytes: o.maxBytes, attempts: r.attempts || null };
  const snap = buildSnapshot({ target, request, fetch: r, html, parsed, renderRes, run, site, warnings, error: r.error || null });
  let paths = null, finalized = null;
  if (run) {
    paths = persistPage(run, snap, html, renderRes.renderedHtml, slug, uaSuffix(o));
    if (o.finalize !== false) finalized = finalizeRun(run, o);
  }
  if (!run) snap.html_inline = { raw: html, rendered: renderRes.renderedHtml };
  return { ok: true, code: EXIT.OK, snapshot: snap, paths, run, site, finalized, summary: summarize(snap, paths, run, site, rootInfo) };
}

// ---------------------------------------------------------------------------
// Local modes

function localFetchLike(buf, parsed) {
  const charset = parsed && parsed.charset && parsed.charset.value ? String(parsed.charset.value).toLowerCase() : null;
  return {
    status: null, ok: false, final_url: null, status_chain: [], attempts: null,
    redirects: { hops: 0, loop: false, truncated: false, http_to_https: false, host_changed: false, www_normalized: false, trailing_slash_changed: false },
    headers: {}, body: { bytes: buf.length, truncated: false, charset: charset || 'utf-8', charset_source: charset ? 'meta' : 'fallback', content_encoding: null, gunzipped: false, sha256: createHash('sha256').update(buf).digest('hex') },
    timing: { ttfb_ms: null, download_ms: null, total_ms: null }, error: null,
  };
}

async function snapshotLocalPage({ abs, rel, pageUrl, kind, o, run, site, rootInfo, extraWarnings = [] }) {
  const buf = readFileSync(abs);
  const html = buf.toString('utf8');
  const fileUrl = pathToFileURL(abs).href;
  const baseUrl = pageUrl || null;
  const parsed = parseDocument(html, baseUrl);
  const warnings = ['local file: no HTTP response — status null, headers empty', ...extraWarnings];
  const r = localFetchLike(buf, parsed);
  const renderRes = await performRender({ parsed, html, renderUrl: fileUrl, o, warnings });
  const slug = pageSlug(rel);
  let host = null; let origin = null;
  if (pageUrl) { try { const u = new URL(pageUrl); host = u.host; origin = u.origin; } catch { /* keep null */ } }
  const target = { kind, value: abs, requested_url: pageUrl, final_url: pageUrl || fileUrl, host, origin, slug, path: abs, relative_path: rel };
  const request = { ua_preset: null, user_agent: null, accept_language: null, timeout_ms: null, max_hops: null, max_bytes: null, attempts: null };
  const snap = buildSnapshot({ target, request, fetch: r, html, parsed, renderRes, run, site, warnings, error: null });
  let paths = null;
  if (run) paths = persistPage(run, snap, html, renderRes.renderedHtml, slug, '');
  else snap.html_inline = { raw: html, rendered: renderRes.renderedHtml };
  return { snapshot: snap, paths, summary: summarize(snap, paths, run, site, rootInfo) };
}

/** Snapshot a single HTML file (status null, headers {}). `opts.pageUrl` supplies the page URL for absolute resolution. */
export async function snapshotFile(file, opts = {}) {
  const o = withDefaults(opts);
  const abs = resolve(file);
  if (!existsSync(abs) || !statSync(abs).isFile()) return { ok: false, code: EXIT.USAGE, error: 'file not found: ' + file };
  const rootInfo = o.persist ? resolveRootInfo({ out: o.out }, o.env || process.env) : null;
  const run = o.persist ? (o.run || openRun({ root: rootInfo.root, target: abs, runId: o.runId })) : null;
  const page = await snapshotLocalPage({ abs, rel: basename(abs), pageUrl: o.pageUrl || null, kind: 'file', o, run, site: null, rootInfo, extraWarnings: ['single file: no site artifacts (robots/sitemaps/discovery need a directory or a URL)'] });
  let finalized = null;
  if (run && o.finalize !== false) finalized = finalizeRun(run, o);
  return { ok: true, code: EXIT.OK, snapshot: page.snapshot, paths: page.paths, run, site: null, finalized, summary: page.summary };
}

function collectHtml(dir, cap) {
  const out = [];
  const queue = [''];
  while (queue.length && out.length < cap) {
    const relDir = queue.shift();
    let entries = [];
    try { entries = readdirSync(join(dir, relDir), { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = relDir ? relDir + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) queue.push(rel); continue; }
      if (e.isFile() && /\.x?html?$/i.test(e.name)) out.push(rel);
    }
  }
  const idx = out.findIndex((r) => /^index\.x?html?$/i.test(r));
  if (idx > 0) out.unshift(...out.splice(idx, 1));
  const truncated = out.length > cap;
  return { files: out.slice(0, cap), truncated, total: out.length };
}

function frameworkMarkers(dir) {
  const found = [];
  for (const f of FRAMEWORK_FILES) if (existsSync(join(dir, f))) found.push(f);
  for (const d of FRAMEWORK_DIRS) { try { if (statSync(join(dir, d)).isDirectory()) found.push(d + '/'); } catch { /* absent */ } }
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const k of ['next', 'nuxt', 'astro', '@sveltejs/kit', 'gatsby', '@remix-run/react', 'react-router', 'vite', '@angular/core', '@shopify/hydrogen']) if (deps[k]) found.push('package.json:' + k);
  } catch { /* no package.json */ }
  return found;
}

function localPageUrl(base, rel) {
  if (!base) return null;
  let path = '/' + rel.split(sep).join('/');
  path = path.replace(/\/index\.x?html?$/i, '/');
  try { return new URL(path, base).href; } catch { return null; }
}

/** Snapshot a directory of built HTML: index.html (homepage) + up to MAX_LOCAL_PAGES pages, local site artifacts. */
export async function snapshotDir(dir, opts = {}) {
  const o = withDefaults(opts);
  const abs = resolve(dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return { ok: false, code: EXIT.USAGE, error: 'directory not found: ' + dir };
  const { files, truncated, total } = collectHtml(abs, MAX_LOCAL_PAGES);
  if (!files.length) {
    const markers = frameworkMarkers(abs);
    if (markers.length) {
      return { ok: false, code: EXIT.RUNTIME, error: 'no built HTML found in ' + abs, hint: 'this looks like a framework source directory (' + markers.slice(0, 4).join(', ') + '): build first or give the deployed URL', framework_markers: markers };
    }
    return { ok: false, code: EXIT.USAGE, error: 'no .html files found under ' + abs, hint: 'point snapshot.mjs at a built site directory (with index.html) or at a URL' };
  }
  const rootInfo = o.persist ? resolveRootInfo({ out: o.out }, o.env || process.env) : null;
  const run = o.persist ? (o.run || openRun({ root: rootInfo.root, target: abs, runId: o.runId })) : null;
  const site = o.artifacts.any ? localSiteArtifacts(abs, { siteDir: run ? run.site_dir : null, artifacts: o.artifacts, targetPath: '/' }) : null;
  const warnings = [];
  if (site && Array.isArray(site.warnings)) warnings.push(...site.warnings);
  if (truncated) warnings.push('directory holds ' + total + ' HTML files; only the first ' + MAX_LOCAL_PAGES + ' (breadth-first, index.html first) were snapshotted');
  const pages = [];
  for (const rel of files) {
    const page = await snapshotLocalPage({ abs: join(abs, ...rel.split('/')), rel, pageUrl: localPageUrl(o.pageUrl, rel), kind: 'dir-page', o, run, site, rootInfo });
    pages.push(page);
  }
  let finalized = null;
  if (run && o.finalize !== false) finalized = finalizeRun(run, o);
  const homepage = pages[0];
  const summary = {
    run_dir: run ? run.dir : null, run_id: run ? run.run_id : null, host_key: run ? run.host_key : null, root: rootInfo ? rootInfo.root : null, root_source: rootInfo ? rootInfo.source : null,
    target: abs, kind: 'dir', pages_count: pages.length, html_files_total: total, truncated,
    homepage: homepage ? { slug: homepage.snapshot.target.slug, file: homepage.snapshot.target.relative_path, snapshot: homepage.paths ? homepage.paths.json : null } : null,
    pages: pages.map((p) => ({ slug: p.snapshot.target.slug, file: p.snapshot.target.relative_path, snapshot: p.paths ? p.paths.json : null, title: p.summary.counts.title, word_count: p.summary.counts.word_count, render: p.snapshot.render.used })),
    site: siteSummary(site), warnings,
  };
  return { ok: true, code: EXIT.OK, pages, run, site, finalized, summary };
}

// ---------------------------------------------------------------------------
// CLI

export async function main(args) {
  let o, target;
  try { o = readOptions(args); target = classifyTarget(args); }
  catch (e) { if (e instanceof UsageError) return usage(e); throw e; }

  if (target.kind === 'url') {
    const res = await snapshotUrl(target.url, o);
    if (!res.ok) return { result: { error: res.error, detail: res.detail, target: res.target, status: res.status }, code: res.code };
    return { result: shapeOutput(res, o), code: EXIT.OK };
  }
  if (target.kind === 'file') {
    const res = await snapshotFile(target.value, o);
    if (!res.ok) return { result: { error: res.error, ...(res.hint ? { hint: res.hint } : {}) }, code: res.code };
    return { result: shapeOutput(res, o), code: EXIT.OK };
  }
  const res = await snapshotDir(target.value, o);
  if (!res.ok) return { result: { error: res.error, ...(res.hint ? { hint: res.hint } : {}), ...(res.framework_markers ? { framework_markers: res.framework_markers } : {}) }, code: res.code };
  if (o.json) return { result: { ...res.summary, pages: res.pages.map((p) => ({ ...p.snapshot, snapshot_path: p.paths ? p.paths.json : null })) }, code: EXIT.OK };
  if (o.quiet) return { result: { run_dir: res.summary.run_dir, pages: res.summary.pages.map((p) => p.snapshot) }, code: EXIT.OK };
  return { result: res.summary, code: EXIT.OK };
}

function shapeOutput(res, o) {
  if (o.json || !o.persist) return { ...res.snapshot, snapshot_path: res.paths ? res.paths.json : null, run_dir: res.run ? res.run.dir : null };
  if (o.quiet) return { snapshot: res.paths ? res.paths.json : null, run_dir: res.run ? res.run.dir : null, status: res.snapshot.status, render: res.snapshot.render.used };
  return res.summary;
}

if (isMain(import.meta.url)) runCli(main);

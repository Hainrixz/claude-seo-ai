#!/usr/bin/env node
// Parse robots.txt (Google REP matcher, AI-crawler posture, Content-Signal) and walk every
// sitemap of a site. Backs M1 (crawlability), M14 (AI crawlers), M17 (sitemaps).
//
// Usage: node parse-robots-sitemap.mjs --url https://example.com/some/page   (robots + verdicts for that path + all sitemaps)
//        node parse-robots-sitemap.mjs --url https://example.com --path /pricing   (override the audited path)
//        node parse-robots-sitemap.mjs --robots https://example.com/robots.txt
//        node parse-robots-sitemap.mjs --sitemap https://example.com/sitemap.xml
//        node parse-robots-sitemap.mjs --file ./robots.txt [--path /x]
//   Flags: --ua <preset|string> · --no-sitemaps (skip discovery) · --no-well-known (only declared sitemaps)
//          --max-sitemaps 50 · --max-urls 100000 · --timeout 20000
// Exit codes: 0 ok (a 4xx robots.txt = "no robots.txt"; a 5xx robots.txt = mode "disallow-all" — both are
//             findings, not crashes) · 1 usage (no/invalid target, unreadable file) · 2 runtime (network failure)

import { readFileSync } from 'node:fs';
import { EXIT, isMain, runCli } from './lib/util.mjs';
import { fetchRaw } from './lib/fetch.mjs';
import { parseRobots, robotsFromFetch, isAllowed, selectGroup, aiPosture as aiPostureFull, signalsFor, targetPath } from './lib/robots.mjs';
import { AI_BOTS, BOTS, UA_TABLE_VERSION } from './lib/bots.mjs';
import { parseSitemap, discoverSitemaps, SITEMAP_LIMITS } from './lib/sitemaps.mjs';

// Legacy named exports kept for callers of v0.1.0 (now backed by lib/robots, lib/bots, lib/sitemaps).
export { AI_BOTS, parseRobots, parseSitemap };

/** Verdict user-agents: the two classic engines plus this tool's own product token. */
export const VERDICT_UAS = Object.freeze(['Googlebot', 'Bingbot', 'claude-seo-ai']);
const ASSET_RULE = /\.(css|js)(\b|\/|$)|\/(assets|static|_next|js|css)\b/i;

/**
 * Legacy shape: { class: { Bot: 'blocked' | 'allowed' } } — "blocked" means the bot may not fetch `/`.
 * Accepts a parsed robots object or a robotsFromFetch() result. The rich form lives in lib/robots aiPosture().
 */
export function aiPosture(robots, url) {
  const full = aiPostureFull(robots, url);
  const out = {};
  for (const [cls, bots] of Object.entries(full)) {
    out[cls] = {};
    for (const [name, v] of Object.entries(bots)) out[cls][name] = v.root_allowed ? 'allowed' : 'blocked';
  }
  return out;
}

/** Per-bot effective access for the audited path: { Bot: { class, fetch, url_allowed, via, rule, signals, doc_url, robots_reliability } }. */
export function effectiveAccess(robots, path) {
  const out = {};
  for (const b of BOTS) {
    const root = isAllowed(robots, b.name, '/');
    const page = isAllowed(robots, b.name, path);
    out[b.name] = {
      class: b.class, fetch: root.allowed ? 'allowed' : 'blocked', url_allowed: page.allowed, via: page.via, rule: page.rule,
      signals: signalsFor(robots, b.name), doc_url: b.doc_url, robots_reliability: b.robots_reliability,
    };
  }
  return out;
}

/** Legacy per-file summary (v0.1.0 keys first) plus the richer parse results. */
export function sitemapSummary(parsed) {
  const locs = parsed.entries.map((e) => e.loc).filter(Boolean);
  return {
    kind: parsed.kind,
    url_count: parsed.url_count,
    lastmod_count: parsed.lastmod.count,
    has_image_ext: parsed.entries.some((e) => e.images > 0),
    has_video_ext: parsed.entries.some((e) => e.videos > 0),
    over_url_limit: parsed.url_count > SITEMAP_LIMITS.urls,
    sample: locs.slice(0, 5),
    lastmod: parsed.lastmod,
    lastmod_all_identical: parsed.lastmod.count > 1 && parsed.lastmod.distinct === 1,
    alternates_count: parsed.entries.reduce((n, e) => n + e.alternates.length, 0),
    news_count: parsed.entries.reduce((n, e) => n + e.news, 0),
    namespaces: parsed.namespaces.map((n) => (n.prefix ? n.prefix + '=' : '') + n.uri),
    errors: parsed.errors,
    children: parsed.kind === 'sitemapindex' ? locs.slice(0, 50) : undefined,
  };
}

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const usage = (error, extra = {}) => ({ result: { error, ...extra }, code: EXIT.USAGE });

function absoluteHttp(u) {
  if (typeof u !== 'string') return null;
  try { const url = new URL(u); return /^https?:$/.test(url.protocol) ? url : null; } catch { return null; }
}

export async function main(args) {
  const fetchOpts = { ua: typeof args.ua === 'string' ? args.ua : undefined, timeoutMs: num(args.timeout, 20000) };
  const fetcher = (u, extra = {}) => fetchRaw(u, { ...fetchOpts, ...extra });

  // --- single sitemap mode ---
  if (args.sitemap) {
    const target = absoluteHttp(args.sitemap);
    if (!target) return usage('--sitemap needs an absolute http(s) URL: ' + args.sitemap);
    const r = await fetcher(target.href, { returnBuffer: true });
    if (r.status === 0) return { result: { target: target.href, error: 'sitemap fetch failed', status: 0, detail: r.error }, code: EXIT.RUNTIME };
    if (!r.ok) return { result: { target: target.href, exists: false, status: r.status, final_url: r.final_url, error: 'sitemap fetch failed', detail: r.error || ('HTTP ' + r.status) }, code: EXIT.OK };
    const parsed = parseSitemap(r.body.buffer);
    return {
      result: { target: target.href, exists: true, status: r.status, final_url: r.final_url, bytes: r.body.bytes, gz: !!r.body.gunzipped, over_size_limit: r.body.bytes > SITEMAP_LIMITS.bytes, sitemap: sitemapSummary(parsed) },
      code: EXIT.OK,
    };
  }

  // --- robots acquisition ---
  let robotsUrl = null, origin = null, fetched = null, robotsText = null, auditPath = null;
  if (args.file) {
    try { robotsText = readFileSync(args.file, 'utf8'); }
    catch (e) { return usage(String(e && e.message || e)); }
  } else {
    if (args.robots) {
      const u = absoluteHttp(args.robots);
      if (!u) return usage('invalid --robots (need an absolute http(s) URL): ' + args.robots);
      robotsUrl = u.href; origin = u.origin;
    } else if (args.url) {
      const u = absoluteHttp(args.url);
      if (!u) return usage('invalid --url (need an absolute http(s) URL): ' + args.url, { hint: 'did you mean https://' + String(args.url).replace(/^\/+/, '') + ' ?' });
      origin = u.origin; robotsUrl = origin + '/robots.txt'; auditPath = u.pathname + u.search;
    }
    if (!robotsUrl) return usage('provide --url, --robots, --sitemap, or --file');
    fetched = await fetcher(robotsUrl);
    if (fetched.status === 0) return { result: { robots_url: robotsUrl, error: 'fetch failed', status: 0, detail: fetched.error }, code: EXIT.RUNTIME };
  }
  if (typeof args.path === 'string' && args.path) auditPath = targetPath(args.path);
  if (!auditPath) auditPath = '/';

  const rf = args.file
    ? { mode: 'parsed', robots: parseRobots(robotsText), status: null, reason: null }
    : robotsFromFetch({ status: fetched.status, text: fetched.body.text, error: fetched.error });
  const robots = rf.robots;
  const status = fetched ? fetched.status : null;
  const exists = args.file ? true : (status >= 200 && status < 300) || status >= 500 || status === 429;

  const result = { robots_url: robotsUrl, exists, status, mode: rf.mode };
  if (rf.mode === 'allow-all') result.note = 'no robots.txt (all crawlable by default)';
  if (rf.mode === 'disallow-all') result.note = rf.reason;
  if (fetched && fetched.status_chain.length > 1) result.redirected_to = fetched.final_url;

  const googlebot = selectGroup(robots, 'Googlebot');
  result.groups = robots.groups.length;
  result.sitemaps_declared = robots.sitemaps;
  result.ai_posture = aiPosture(rf, origin ? origin + auditPath : null);
  result.wildcard_disallow_all = rf.mode === 'disallow-all'
    || robots.groups.some((g) => g.agents.some((a) => a.trim()[0] === '*') && g.rules.some((r) => r.type === 'disallow' && r.path === '/'));
  // Only Googlebot's effective group matters for rendering: a Disallow in another bot's group cannot break Google's render.
  result.may_block_render_assets = rf.mode === 'disallow-all'
    || !!(googlebot.group && googlebot.group.rules.some((r) => r.type === 'disallow' && r.path && ASSET_RULE.test(r.path)));

  result.path = auditPath;
  result.verdicts = {};
  for (const ua of VERDICT_UAS) {
    const v = isAllowed(rf, ua, auditPath);
    result.verdicts[ua] = { allowed: v.allowed, via: v.via, rule: v.rule };
  }
  const star = selectGroup(robots, '*');
  result.crawl_delay = {
    Googlebot: googlebot.group ? googlebot.group.crawlDelay : null,
    '*': star.group ? star.group.crawlDelay : null,
    declared: robots.groups.filter((g) => g.crawlDelay != null).map((g) => ({ agents: g.agents, seconds: g.crawlDelay })),
    note: 'Googlebot ignores Crawl-delay; Bing and Yandex honor it.',
  };
  result.content_signals = robots.contentSignals;
  result.effective_access = effectiveAccess(rf, auditPath);
  result.syntax = {
    unknown_directives: robots.unknownDirectives, invalid_lines: robots.invalidLines, has_bom: robots.hasBom, lines: robots.lines,
    host: robots.host, clean_param: robots.cleanParam,
  };
  result.ua_table_version = UA_TABLE_VERSION;

  // --- sitemaps (network modes only) ---
  if (origin && args.sitemaps !== false) {
    const firstDeclared = robots.sitemaps.length ? (() => { try { return new URL(robots.sitemaps[0], origin + '/').href; } catch { return null; } })() : null;
    let firstParsed = null;
    const disc = await discoverSitemaps(origin, robots, fetcher, {
      maxFiles: num(args['max-sitemaps'], 50), maxUrls: num(args['max-urls'], 100000), wellKnown: args['well-known'] !== false,
      onParsed: (file, parsed) => { if (firstDeclared && file.url === firstDeclared) firstParsed = parsed; },
    });
    if (firstParsed) result.first_sitemap = { url: firstDeclared, ...sitemapSummary(firstParsed) };
    const valid = disc.files.filter((f) => f.kind && f.kind !== 'invalid');
    // Freshness is aggregated over URL sets only: an index's <lastmod> describes child sitemaps, not pages.
    const lastmods = valid.filter((f) => f.kind === 'urlset').map((f) => f.lastmod).filter(Boolean);
    const mins = lastmods.map((l) => l.min).filter(Boolean).sort();
    const maxs = lastmods.map((l) => l.max).filter(Boolean).sort();
    result.sitemaps_all = {
      declared: disc.declared,
      found: disc.found,
      files: disc.files.map(({ namespaces, ...f }) => f),
      url_count: disc.urls.length,
      sample: disc.urls.slice(0, 5).map((u) => u.loc),
      lastmod: { count: lastmods.reduce((n, l) => n + l.count, 0), min: mins[0] || null, max: maxs[maxs.length - 1] || null },
      over_50k_any: valid.some((f) => f.over_50k),
      over_50mb_any: valid.some((f) => f.over_50mb),
      errors_total: valid.reduce((n, f) => n + f.errors.length, 0),
      well_known_only: disc.declared.length === 0 && disc.found > 0,
      truncated: disc.truncated,
    };
  }

  return { result, code: EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);

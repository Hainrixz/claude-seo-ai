#!/usr/bin/env node
// Analyze internal linking. Backs M10 (internal linking & semantics).
//
// Usage: node link-graph.mjs --url https://example.com/page        (single-page link profile)
//        node link-graph.mjs --url https://example.com --crawl [--max 25] [--max-depth 3] [--no-robots] [--ua <preset>]
//        node link-graph.mjs --file ./page.html --base https://example.com
// Exit codes: 0 ok · 1 usage (no/unreadable input, no base URL) · 2 runtime (fetch failed)
//
// Internal = same site ignoring `www.` (apex vs www is one site). Fragment-only, mailto:, tel:,
// javascript: and data: hrefs are dropped before anything is counted. The crawl keys pages by the
// final URL after redirects, records depth and status per page, respects robots.txt for this
// tool's own token (`--no-robots` to disable), and never reports the start page as an orphan.

import { EXIT, isMain, runCli, loadInput, inputFailure, getLinks } from './lib/util.mjs';
import { fetchRaw, resolveUa } from './lib/fetch.mjs';
import { normalizeUrl, isInternal, linkKind, sameSite } from './lib/urlnorm.mjs';
import { robotsFromFetch, isAllowed, selectGroup, uaToken } from './lib/robots.mjs';

const GENERIC = /^(click here|read more|here|link|more|learn more|this|details|continue|haz clic aquí|leer más|más|aquí|ver más)$/i;
const sleep = (t) => new Promise((r) => setTimeout(r, t));
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

/**
 * Classify <a href> links relative to `baseUrl`.
 * @returns {{internal:string[], external:string[], generic:Array<{href,anchor}>, empty:string[], dropped:object, total_anchor_tags:number}}
 */
export function classify(links, baseUrl) {
  let base = null;
  try { base = new URL(baseUrl); if (!/^https?:$/.test(base.protocol)) base = null; } catch { base = null; }
  const internal = [], external = [], generic = [], empty = [];
  const dropped = { fragment: 0, mailto: 0, tel: 0, javascript: 0, data: 0, other: 0, invalid: 0 };
  for (const l of links || []) {
    const kind = linkKind(l.href);
    if (kind !== 'http') { dropped[kind] = (dropped[kind] || 0) + 1; continue; }
    const anchor = (l.anchor || '').trim();
    if (!anchor) empty.push(l.href);
    else if (GENERIC.test(anchor)) generic.push({ href: l.href, anchor });
    const abs = normalizeUrl(l.href, { base: base ? base.href : undefined, stripTracking: false });
    if (!abs) { dropped.invalid++; continue; }
    if (base && isInternal(abs, base.href)) internal.push(abs);
    else external.push(abs);
  }
  return { internal: [...new Set(internal)], external: [...new Set(external)], generic, empty, dropped, total_anchor_tags: (links || []).length };
}

export async function main(args) {
  const input = await loadInput(args);
  const failed = inputFailure(input);
  if (failed) return failed;
  const baseUrl = args.base || input.finalUrl || args.url;
  if (!baseUrl || typeof baseUrl !== 'string') return { result: { error: 'need --url or --base to resolve relative links' }, code: EXIT.USAGE };

  const profile = classify(getLinks(input.html), baseUrl);
  const result = {
    page: baseUrl,
    total_links: profile.internal.length + profile.external.length,
    internal_unique: profile.internal.length,
    external_unique: profile.external.length,
    generic_anchors: profile.generic.length,
    empty_anchors: profile.empty.length,
    in_content_target: '3-5 contextual internal links is a common target for body content',
    total_anchor_tags: profile.total_anchor_tags,
    dropped: profile.dropped,
    note_total_links: 'total_links = unique internal + unique external http(s) URLs; total_anchor_tags = every <a href> in the markup',
  };

  if (args.crawl) {
    let startUrl;
    try { startUrl = new URL(baseUrl); if (!/^https?:$/.test(startUrl.protocol)) throw new Error('scheme'); }
    catch { return { result: { error: '--crawl needs an absolute http(s) base URL: ' + baseUrl }, code: EXIT.USAGE }; }
    const max = num(args.max, 25);
    const maxDepth = num(args['max-depth'], 3);
    const uaOpts = { ua: typeof args.ua === 'string' ? args.ua : undefined, timeoutMs: num(args.timeout, 20000) };
    const token = uaToken(resolveUa(uaOpts).ua);
    const respectRobots = args.robots !== false;
    const norm = (u) => normalizeUrl(u, { stripTracking: false });

    let robots = null, crawlDelay = null;
    const robotsInfo = { respected: respectRobots, token, mode: null, status: null, crawl_delay_s: null };
    if (respectRobots) {
      const rr = await fetchRaw(startUrl.origin + '/robots.txt', uaOpts);
      robots = robotsFromFetch({ status: rr.status, text: rr.body.text, error: rr.error });
      robotsInfo.mode = robots.mode; robotsInfo.status = rr.status;
      if (robots.mode === 'parsed') {
        const g = selectGroup(robots.robots, token).group;
        if (g && typeof g.crawlDelay === 'number' && g.crawlDelay > 0) crawlDelay = Math.min(g.crawlDelay, 10);
      }
      robotsInfo.crawl_delay_s = crawlDelay;
    }

    const start = norm(startUrl.href);
    const queue = [{ url: start, depth: 0 }];
    const seen = new Set([start]);
    const pages = {};      // final normalized URL -> page record
    const redirects = {};  // requested normalized URL -> final normalized URL
    const skipped = [];
    let seedFinal = null, fetched = 0;

    while (queue.length && Object.keys(pages).length < max) {
      const { url: u, depth } = queue.shift();
      if (robots && !isAllowed(robots, token, u).allowed) { skipped.push(u); continue; }
      if (crawlDelay && fetched > 0) await sleep(crawlDelay * 1000);
      const r = await fetchRaw(u, { ...uaOpts, maxBytes: 2_000_000 });
      fetched++;
      const final = (r.final_url && norm(r.final_url)) || u;
      if (final !== u) redirects[u] = final;
      if (u === start) seedFinal = final;
      if (pages[final]) { pages[final].requested.push(u); continue; }
      const page = { url: final, depth, status: r.status, out: [], requested: [u], error: r.error || null };
      pages[final] = page;
      const ct = r.headers['content-type'] || '';
      if (!r.ok || (ct && !/html|xml/i.test(ct))) continue;
      const site = seedFinal || start;
      page.out = classify(getLinks(r.body.text), final).internal.filter((t) => sameSite(t, site));
      for (const t of page.out) {
        if (!seen.has(t) && depth + 1 <= maxDepth && seen.size < max * 4) { seen.add(t); queue.push({ url: t, depth: depth + 1 }); }
      }
    }

    const toFinal = (t) => redirects[t] || t;
    const inbound = {};
    for (const p of Object.values(pages)) for (const t of p.out) { const f = toFinal(t); if (f !== p.url) inbound[f] = (inbound[f] || 0) + 1; }
    const list = Object.values(pages);
    const orphans = list.filter((p) => p.url !== seedFinal && !(inbound[p.url] > 0)).map((p) => p.url);
    const statusCounts = {};
    for (const p of list) { const k = p.status || 'error'; statusCounts[k] = (statusCounts[k] || 0) + 1; }

    result.crawl = {
      pages_crawled: list.length,
      avg_internal_out: list.length ? +(list.reduce((s, p) => s + p.out.length, 0) / list.length).toFixed(1) : 0,
      potential_orphans: orphans.slice(0, 20),
      note: 'shallow same-site crawl; orphan = crawled page with no inbound internal link from another crawled page (the start page is never an orphan; not authoritative)',
      start: seedFinal || start,
      seed_disallowed: !!(robots && skipped.includes(start)),
      max_pages: max,
      max_depth: maxDepth,
      max_depth_reached: list.length ? Math.max(...list.map((p) => p.depth)) : 0,
      frontier_unvisited: queue.length,
      robots: { ...robotsInfo, skipped_count: skipped.length, skipped_disallowed: skipped.slice(0, 50) },
      redirect_count: Object.keys(redirects).length,
      redirects: Object.entries(redirects).slice(0, 50).map(([from, to]) => ({ from, to })),
      status_counts: statusCounts,
      pages: list.map((p) => ({ url: p.url, depth: p.depth, status: p.status, out_links: p.out.length, in_links: inbound[p.url] || 0, error: p.error })),
    };
  }

  return { result, code: EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);

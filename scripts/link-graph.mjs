#!/usr/bin/env node
// Analyze internal linking. Backs M10 (internal linking & semantics).
//
// Usage: node link-graph.mjs --url https://example.com/page        (single-page link profile)
//        node link-graph.mjs --url https://example.com --crawl --max 30   (shallow same-host crawl)
//        node link-graph.mjs --file ./page.html --base https://example.com

import { parseArgs, emit, loadInput, fetchText, getLinks } from './lib/util.mjs';

const GENERIC = /^(click here|read more|here|link|more|learn more|this|details|continue)$/i;

function classify(links, baseUrl) {
  let base; try { base = new URL(baseUrl); } catch { base = null; }
  const internal = [], external = [], generic = [], empty = [];
  for (const l of links) {
    const anchor = (l.anchor || '').trim();
    if (!anchor) empty.push(l.href);
    else if (GENERIC.test(anchor)) generic.push({ href: l.href, anchor });
    let abs = null;
    try { abs = new URL(l.href, base ? base.href : undefined); } catch { /* skip */ }
    if (!abs) continue;
    if (base && abs.host === base.host) internal.push(abs.href.split('#')[0]);
    else if (/^https?:$/.test(abs.protocol)) external.push(abs.href);
  }
  return { internal: [...new Set(internal)], external: [...new Set(external)], generic, empty };
}

const args = parseArgs();
const input = await loadInput(args);
if (input.error && !input.html) emit({ error: input.error }, 1);
const baseUrl = args.base || input.finalUrl || args.url;
if (!baseUrl) emit({ error: 'need --url or --base to resolve relative links' }, 1);

const profile = classify(getLinks(input.html), baseUrl);
const result = {
  page: baseUrl,
  total_links: profile.internal.length + profile.external.length,
  internal_unique: profile.internal.length,
  external_unique: profile.external.length,
  generic_anchors: profile.generic.length,
  empty_anchors: profile.empty.length,
  in_content_target: '3-5 contextual internal links is a common target for body content',
};

if (args.crawl) {
  const max = Number(args.max) || 25;
  const origin = new URL(baseUrl).origin;
  const queue = [new URL(baseUrl).href.split('#')[0]];
  const seen = new Set(queue);
  const adjacency = {}; // url -> [internal targets]
  const inbound = {};   // url -> count
  while (queue.length && Object.keys(adjacency).length < max) {
    const u = queue.shift();
    const r = await fetchText(u);
    if (!r.ok) { adjacency[u] = []; continue; }
    const targets = classify(getLinks(r.text), u).internal.filter((t) => t.startsWith(origin));
    adjacency[u] = targets;
    for (const t of targets) {
      inbound[t] = (inbound[t] || 0) + 1;
      if (!seen.has(t) && seen.size < max * 3) { seen.add(t); queue.push(t); }
    }
  }
  const pages = Object.keys(adjacency);
  const orphans = pages.filter((p) => p !== queue[0] && !(inbound[p] > 0));
  result.crawl = {
    pages_crawled: pages.length,
    avg_internal_out: pages.length ? +(pages.reduce((s, p) => s + adjacency[p].length, 0) / pages.length).toFixed(1) : 0,
    potential_orphans: orphans.slice(0, 20),
    note: 'shallow same-host crawl; orphan = no inbound internal link seen within the crawl frontier (not authoritative)',
  };
}

emit(result);

#!/usr/bin/env node
// Audit hreflang annotations. Backs M20 (international).
//
// Usage: node hreflang-check.mjs --url https://example.com/page
//        node hreflang-check.mjs --file ./page.html
//        node hreflang-check.mjs --url https://example.com/page --deep   (fetch alternates, check reciprocity)

import { parseArgs, emit, loadInput, fetchText, isBcp47, getLinkRel } from './lib/util.mjs';

function extractHreflang(html) {
  const out = [];
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if (!/rel=["']alternate["']/i.test(tag)) continue;
    const hreflang = (tag.match(/hreflang=["']([^"']+)["']/i) || [])[1];
    const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
    if (hreflang && href) out.push({ hreflang, href });
  }
  return out;
}

const args = parseArgs();
const input = await loadInput(args);
if (input.error && !input.html) emit({ error: input.error }, 1);

const self = input.finalUrl || args.url || null;
const set = extractHreflang(input.html);
const canonical = getLinkRel(input.html, 'canonical');

const invalidCodes = set.filter((e) => !isBcp47(e.hreflang)).map((e) => e.hreflang);
const hasXDefault = set.some((e) => e.hreflang.toLowerCase() === 'x-default');
const selfReferenced = self ? set.some((e) => sameUrl(e.href, self)) : null;
const dupes = findDupes(set);
const canonicalConflict = !!(canonical && self && !sameUrl(canonical, self) && set.length > 0);

const result = {
  source: input.source,
  self,
  hreflang_count: set.length,
  entries: set,
  invalid_bcp47: invalidCodes,
  has_x_default: hasXDefault,
  self_referenced: selfReferenced,
  duplicate_langs: dupes,
  canonical: canonical || null,
  canonical_vs_hreflang_conflict: canonicalConflict,
};

if (args.deep && set.length) {
  const reciprocity = [];
  for (const e of set.slice(0, 25)) {
    if (e.hreflang.toLowerCase() === 'x-default') continue;
    const r = await fetchText(e.href);
    if (!r.ok) { reciprocity.push({ href: e.href, reachable: false, reciprocal: null }); continue; }
    const back = extractHreflang(r.text);
    const reciprocal = self ? back.some((b) => sameUrl(b.href, self)) : null;
    reciprocity.push({ href: e.href, reachable: true, reciprocal });
  }
  result.reciprocity = reciprocity;
  result.non_reciprocal = reciprocity.filter((x) => x.reachable && x.reciprocal === false).map((x) => x.href);
}

emit(result);

function sameUrl(a, b) {
  try { const ua = new URL(a, b), ub = new URL(b); return ua.href.replace(/\/$/, '') === ub.href.replace(/\/$/, ''); }
  catch { return String(a).replace(/\/$/, '') === String(b).replace(/\/$/, ''); }
}
function findDupes(set) {
  const seen = {}; const dup = [];
  for (const e of set) {
    const k = e.hreflang.toLowerCase();
    if (seen[k] && seen[k] !== e.href) dup.push(e.hreflang);
    seen[k] = e.href;
  }
  return [...new Set(dup)];
}

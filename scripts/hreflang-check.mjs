#!/usr/bin/env node
// Audit hreflang annotations (HTML <link> tags ∪ HTTP Link header). Backs M20 (international).
//
// Usage: node hreflang-check.mjs --url https://example.com/page
//        node hreflang-check.mjs --file ./page.html [--url <self>]
//        node hreflang-check.mjs --url https://example.com/page --deep [--budget 25] [--ua <preset>]   (fetch alternates, check reciprocity)
// Exit codes: 0 ok · 1 usage (no/unreadable input) · 2 runtime (fetch failed)

import { EXIT, isMain, runCli, loadInput, inputFailure, isBcp47, getLinkRel } from './lib/util.mjs';
import { fetchRaw } from './lib/fetch.mjs';
import { extractHreflang, collectHreflang, headerCanonical, checkReciprocity } from './lib/hreflang.mjs';
import { urlsEquivalent } from './lib/urlnorm.mjs';

export { extractHreflang };

function findDupes(set) {
  const seen = {}; const dup = [];
  for (const e of set) {
    const k = e.hreflang.toLowerCase();
    const href = e.abs || e.href;
    if (seen[k] && !urlsEquivalent(seen[k], href)) dup.push(e.hreflang);
    seen[k] = href;
  }
  return [...new Set(dup)];
}

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

export async function main(args) {
  const input = await loadInput(args);
  const failed = inputFailure(input);
  if (failed) return failed;

  const self = input.finalUrl || (typeof args.url === 'string' ? args.url : null) || null;
  const headers = input.headers || {};
  const set = collectHreflang(input.html, headers, self);
  const canonical = getLinkRel(input.html, 'canonical');
  const canonicalHeader = headerCanonical(headers, self);

  const invalidCodes = set.filter((e) => !isBcp47(e.hreflang)).map((e) => e.hreflang);
  const hasXDefault = set.some((e) => e.hreflang.toLowerCase() === 'x-default');
  const selfReferenced = self ? set.some((e) => urlsEquivalent(e.abs || e.href, self)) : null;
  const dupes = findDupes(set);
  const canonicalConflict = !!(canonical && self && !urlsEquivalent(canonical, self, self) && set.length > 0);

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
    header_entries: set.filter((e) => e.source === 'header').length,
    canonical_header: canonicalHeader,
    canonical_header_conflict: !!(canonical && canonicalHeader && !urlsEquivalent(canonical, canonicalHeader, self)),
  };

  if (args.deep && set.length) {
    const ua = typeof args.ua === 'string' ? args.ua : undefined;
    const rec = await checkReciprocity(set, (u) => fetchRaw(u, { ua, timeoutMs: num(args.timeout, 20000) }), { budget: num(args.budget, 25), self });
    result.reciprocity = rec.reciprocity;
    result.non_reciprocal = rec.non_reciprocal;
    result.reciprocity_checked = rec.checked;
    result.reciprocity_skipped = rec.skipped;
  }

  return { result, code: EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);

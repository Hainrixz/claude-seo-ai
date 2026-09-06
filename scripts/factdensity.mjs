#!/usr/bin/env node
// Deterministic counts behind the fact-density audit (M12). Judgment calls
// (is a claim "strong"? is a source "authoritative"?) stay manual_review.
//
// Usage: node factdensity.mjs --url https://example.com/post [--lang en|es|auto]
//        node factdensity.mjs --file ./post.html [--url <page url>] [--lang en|es|auto]
// Exit codes: 0 ok · 1 usage (no/unreadable input) · 2 runtime (fetch failed)
//
// numeric_tokens (number) stays = all numeric tokens for compatibility; numeric_tokens_detail splits
// them into years / prices / dates / percentages / substantive, and the density uses `substantive`
// (years, prices and dates are not facts about the topic). Authority hosts are matched on the
// hostname only and counted once per host. Language-dependent fields (original-data phrasing,
// superlatives) are null — never 0 — when the page language is not EN/ES.

import { EXIT, isMain, runCli, loadInput, inputFailure } from './lib/util.mjs';
import { tokenize, parseDocument } from './lib/html.mjs';
import { detectLang, lexiconFor, isAuthorityHost, hostnameOf } from './lib/lang.mjs';
import { contentMask, passages, passagesByTag, classifyNumbers, wordCount } from './lib/passages.mjs';

export const NO_NUMBER_PASSAGE_WORDS = 30;
const NOTE = 'Counts only. Whether a claim needs a source and whether a host is authoritative is a manual_review judgment. Never fabricate a statistic or source to satisfy these counts.';

function langSummary(det) {
  return { detected: det.tag || 'unknown', source: det.source, confidence: det.confidence, supported: det.supported };
}
const globalOf = (re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
const bareHost = (h) => String(h || '').replace(/^www\./, '');

/** Outbound links grouped by hostname (internal links excluded when the page host is known). */
export function outboundHosts(anchors, pageUrl) {
  const pageHost = hostnameOf(pageUrl);
  const hosts = new Map();
  let total = 0;
  for (const a of anchors || []) {
    if (a.scheme !== 'http' || !a.abs) continue;
    const host = hostnameOf(a.abs);
    if (!host) continue;
    if (pageHost && bareHost(host) === bareHost(pageHost)) continue;
    total++;
    hosts.set(host, (hosts.get(host) || 0) + 1);
  }
  return { total, hosts };
}

/** Pure analysis of one HTML document. */
export function analyzeFactDensity(html, { lang: langFlag, url = null } = {}) {
  const tokens = tokenize(html);
  const doc = parseDocument(html, url, { tokens });
  const det = detectLang(tokens, { flag: langFlag, doc });
  const lang = det.supported ? det.lang : null;
  const mask = contentMask(tokens);
  const paras = passages(tokens, { mask });
  const text = paras.map((p) => p.text).join(' ');
  const totalWords = wordCount(text);
  const nums = classifyNumbers(text, { lang });
  const detail = { all: nums.all, years: nums.years, prices: nums.prices, dates: nums.dates, percentages: nums.percentages, substantive: nums.substantive };
  const noNumbers = paras.filter((p) => p.words >= NO_NUMBER_PASSAGE_WORDS && classifyNumbers(p.text, { lang }).substantive === 0).length;

  const out = outboundHosts(doc.anchors, doc.effective_base || url);
  const authorityHosts = [...out.hosts.keys()].filter((h) => isAuthorityHost(h)).sort();

  const lex = lexiconFor(lang);
  const originalData = lex ? lex.original_data.test(text) : null;
  const superlatives = lex ? (text.match(globalOf(lex.superlatives)) || []).length : null;

  return {
    lang: langSummary(det),
    content_words: totalWords,
    numeric_tokens: nums.all,
    numeric_tokens_detail: detail,
    numeric_density_per_100w: totalWords ? +(100 * nums.substantive / totalWords).toFixed(2) : 0,
    numeric_density_all_per_100w: totalWords ? +(100 * nums.all / totalWords).toFixed(2) : 0,
    passages: paras.length,
    passages_by_tag: passagesByTag(paras),
    passages_30w_plus_with_no_numbers: noNumbers,
    original_data_signal: originalData,
    superlative_or_vague_authority_claims: superlatives,
    authoritative_outbound_links: authorityHosts.length,
    authority_hosts: authorityHosts,
    outbound_links: { total: out.total, distinct_hosts: out.hosts.size },
    numeric_samples: nums.sample.slice(0, 12),
    language_dependent_checks: lex ? 'evaluated' : 'manual_review',
    note: lex ? NOTE : `Language '${det.tag || 'unknown'}' is not supported by the EN/ES lexicons: original_data_signal and superlative counts are null and need a manual review. ` + NOTE,
  };
}

const flagValue = (v) => (Array.isArray(v) ? v[v.length - 1] : v);

export async function main(args) {
  const input = await loadInput(args);
  const failed = inputFailure(input);
  if (failed) return failed;
  const langFlag = flagValue(args.lang);
  const url = input.finalUrl || (typeof args.url === 'string' ? args.url : null);
  const result = { source: input.source, ...analyzeFactDensity(input.html, { lang: typeof langFlag === 'string' ? langFlag : undefined, url }) };
  return { result, code: EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);

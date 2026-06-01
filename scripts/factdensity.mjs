#!/usr/bin/env node
// Deterministic counts behind the fact-density audit (M12). Judgment calls
// (is a claim "strong"? is a source "authoritative"?) stay manual_review.
//
// Usage: node factdensity.mjs --url https://example.com/post
//        node factdensity.mjs --file ./post.html

import { parseArgs, emit, loadInput, decodeEntities, getLinks } from './lib/util.mjs';

const NUMERIC = /\b\d+([.,]\d+)?\s?(%|percent|x|k|m|bn|billion|million|thousand)?\b|\$\s?\d|\b(19|20)\d{2}\b/gi;
const ORIGINAL_DATA = /\b(our(?:\s+\w+){0,2}\s+(study|survey|data|research|analysis|test|experiment|benchmark|poll|dataset)|we\s+(analy[sz]ed|surveyed|tested|measured|polled|found that|collected)|internal data|proprietary data|first-party data|in our (test|study|survey))\b/i;
const SUPERLATIVE = /\b(the (best|fastest|most|largest|leading|number one|#1)|fastest|cheapest|studies show|research shows|experts agree|everyone knows)\b/i;
const AUTHORITY_HOST = /(\.gov|\.edu|wikipedia\.org|nature\.com|sciencedirect|nih\.gov|who\.int|oecd\.org|arxiv\.org|w3\.org|schema\.org|developer\.|docs\.)/i;

const stripTags = (s) => decodeEntities(s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
const words = (s) => (s ? s.trim().split(/\s+/).filter(Boolean).length : 0);

const args = parseArgs();
const input = await loadInput(args);
if (input.error && !input.html) emit({ error: input.error }, 1);

let body = input.html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ');

const paras = [...body.matchAll(/<(p|li)[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => stripTags(m[2])).filter((t) => words(t) >= 8);
const text = paras.join(' ');
const totalWords = words(text);
const numericTokens = (text.match(NUMERIC) || []).length;

const passagesNoNumbers = paras.filter((p) => words(p) >= 30 && !(p.match(NUMERIC) || []).length).length;

const links = getLinks(input.html);
let authorityOutbound = 0;
for (const l of links) { try { const u = new URL(l.href, input.finalUrl || args.url || 'https://x.invalid'); if (AUTHORITY_HOST.test(u.host) || AUTHORITY_HOST.test(u.href)) authorityOutbound++; } catch { /* skip */ } }

emit({
  source: input.source,
  content_words: totalWords,
  numeric_tokens: numericTokens,
  numeric_density_per_100w: totalWords ? +(100 * numericTokens / totalWords).toFixed(2) : 0,
  passages: paras.length,
  passages_30w_plus_with_no_numbers: passagesNoNumbers,
  original_data_signal: ORIGINAL_DATA.test(text),
  superlative_or_vague_authority_claims: (text.match(SUPERLATIVE) || []).length,
  authoritative_outbound_links: authorityOutbound,
  note: 'Counts only. Whether a claim needs a source and whether a host is authoritative is a manual_review judgment. Never fabricate a statistic or source to satisfy these counts.',
});

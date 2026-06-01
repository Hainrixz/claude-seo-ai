#!/usr/bin/env node
// Deterministic part of the answer-extractability audit (M11). The semantic-completeness
// judgment stays a manual_review pass; this provides the reproducible counts.
//
// Usage: node check-answerblocks.mjs --url https://example.com/post
//        node check-answerblocks.mjs --file ./post.html

import { parseArgs, emit, loadInput, decodeEntities } from './lib/util.mjs';

const QUESTION = /\b(how|what|why|when|where|who|which|can|do|does|is|are|should|will|did)\b/i;
const WINDUP = /^(in this (section|article|post|guide)|we('| wi)ll (explore|cover|look|discuss)|let'?s|below( we)?|first,|in this chapter|here we)/i;
const ANAPHORA = /^(as (mentioned|noted|discussed|stated) (above|earlier|previously)|as (above|noted)|this\b|that\b|these\b|those\b|the (former|latter)|it\b|they\b)/i;
const TLDR = /\b(tl;?dr|key takeaways?|in short|in summary|summary:|at a glance)\b/i;

const stripTags = (s) => decodeEntities(s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
const words = (s) => (s ? s.trim().split(/\s+/).filter(Boolean).length : 0);

const args = parseArgs();
const input = await loadInput(args);
if (input.error && !input.html) emit({ error: input.error }, 1);

let body = input.html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ');

// headings with byte index
const heads = [];
{ const re = /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi; let m; while ((m = re.exec(body))) heads.push({ level: +m[1][1], text: stripTags(m[2]), end: re.lastIndex, start: m.index }); }

// first <p> after each heading (before the next heading)
function firstParaAfter(idx, nextStart) {
  const slice = body.slice(idx, nextStart === undefined ? undefined : nextStart);
  const m = slice.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  return m ? stripTags(m[1]) : '';
}

const questionHeads = [];
for (let i = 0; i < heads.length; i++) {
  const h = heads[i];
  const w = h.text.trim().split(/\s+/);
  const startsQ = QUESTION.test(w[0] || '');
  // Exclude declarative "How to <verb>" titles and "What we/you/our…" section labels.
  const declarative = /^how\s+to\b/i.test(h.text) || /^what\s+(we|you|i|our|they|this|that|the)\b/i.test(h.text);
  const isQ = /\?$/.test(h.text) || (startsQ && !declarative);
  if (!isQ) continue;
  const answer = firstParaAfter(h.end, heads[i + 1] && heads[i + 1].start);
  const wc = words(answer);
  questionHeads.push({
    heading: h.text.slice(0, 100),
    answer_words: wc,
    has_direct_answer: wc > 0 && !WINDUP.test(answer),
    in_target_band: wc >= 40 && wc <= 60,
    windup: WINDUP.test(answer),
  });
}

// passages
const paras = [...body.matchAll(/<(p|li)[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => stripTags(m[2])).filter((t) => words(t) >= 5);
const longPassages = paras.filter((p) => words(p) > 250).length;
const anaphoraOpeners = paras.filter((p) => ANAPHORA.test(p)).length;

emit({
  source: input.source,
  question_headings: questionHeads.length,
  question_headings_without_direct_answer: questionHeads.filter((q) => !q.has_direct_answer).length,
  answers_in_40_60_band: questionHeads.filter((q) => q.in_target_band).length,
  details: questionHeads.slice(0, 30),
  passages: paras.length,
  long_passages_over_250w: longPassages,
  anaphora_openers: anaphoraOpeners,
  has_tldr_or_summary: TLDR.test(stripTags(body.slice(0, 4000))) || heads.some((h) => TLDR.test(h.text)),
});

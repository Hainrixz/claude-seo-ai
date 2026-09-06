#!/usr/bin/env node
// Deterministic part of the answer-extractability audit (M11). The semantic-completeness
// judgment stays a manual_review pass; this provides the reproducible counts.
//
// Usage: node check-answerblocks.mjs --url https://example.com/post [--lang en|es|auto]
//        node check-answerblocks.mjs --file ./post.html [--url <page url>] [--lang en|es|auto]
// Exit codes: 0 ok · 1 usage (no/unreadable input) · 2 runtime (fetch failed)
//
// Language: --lang > <html lang> > content-language > og:locale > stop-word heuristic. When the page
// language is not EN/ES, every language-dependent count is null (never 0) and
// language_dependent_checks is 'manual_review' — a Spanish or French page must not read as a pass.
// Boilerplate policy and passage rules live in lib/passages.mjs; lexicons in lib/lang.mjs.

import { EXIT, isMain, runCli, loadInput, inputFailure } from './lib/util.mjs';
import { tokenize, parseDocument } from './lib/html.mjs';
import { detectLang, isQuestionHeading, isAnaphoric, hasTldrMarker } from './lib/lang.mjs';
import { contentMask, passages, passagesByTag, headingsOf, answerAfterHeading, visibleText, ANSWER_KINDS } from './lib/passages.mjs';

export const TARGET_BAND = Object.freeze([40, 60]);
export const LONG_PASSAGE_WORDS = 250;
export const TLDR_SCAN_WORDS = 600;
export const MAX_DETAILS = 30;

const NOTE = 'Counts only: has_direct_answer means >= 15 words (or a list with >= 2 items / table with >= 2 rows) that does not open with a wind-up. Whether the answer is correct or complete is a manual_review judgment.';

export function langSummary(det) {
  return { detected: det.tag || 'unknown', source: det.source, confidence: det.confidence, supported: det.supported };
}

/** Pure analysis of one HTML document. `lang` is the --lang value; `url` the page URL when known. */
export function analyzeAnswerBlocks(html, { lang: langFlag, url = null } = {}) {
  const tokens = tokenize(html);
  const doc = parseDocument(html, url, { tokens });
  const det = detectLang(tokens, { flag: langFlag, doc });
  const lang = det.supported ? det.lang : null;
  const mask = contentMask(tokens);
  const heads = headingsOf(tokens, { mask });
  const paras = passages(tokens, { mask });
  const byTag = passagesByTag(paras);
  const longPassages = paras.filter((p) => p.words > LONG_PASSAGE_WORDS).length;
  const h1 = heads.filter((h) => h.level === 1).length;
  const boilerplate = { has_content_root: mask.has_content_root, stripped: mask.stripped, kept_header_with_h1: mask.kept_header_with_h1 };

  if (!lang) {
    return {
      lang: langSummary(det),
      question_headings: null,
      question_headings_without_direct_answer: null,
      answers_in_40_60_band: null,
      details: [],
      passages: paras.length,
      long_passages_over_250w: longPassages,
      anaphora_openers: null,
      has_tldr_or_summary: null,
      answers_by_kind: null,
      passages_by_tag: byTag,
      headings: { total: heads.length, h1, question: null },
      boilerplate,
      language_dependent_checks: 'manual_review',
      note: `Language '${det.tag || 'unknown'}' is not supported by the EN/ES lexicons: question/wind-up/anaphora/TL;DR counts are null and need a manual review. ` + NOTE,
    };
  }

  const details = [];
  const byKind = Object.fromEntries(ANSWER_KINDS.map((k) => [k, 0]));
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    if (!isQuestionHeading(h.text, lang)) continue;
    const a = answerAfterHeading(tokens, h.index, { stopIdx: heads[i + 1] ? heads[i + 1].index : undefined, mask, lang, band: TARGET_BAND });
    byKind[a.kind] = (byKind[a.kind] || 0) + 1;
    const d = {
      heading: h.text.slice(0, 100),
      answer_words: a.words,
      has_direct_answer: a.has_direct_answer === true,
      in_target_band: a.in_target_band,
      windup: a.windup === true,
      level: h.level,
      answer_kind: a.kind,
      anaphoric: a.anaphoric === true,
    };
    if (a.kind === 'list' || a.kind === 'definition') d.list_items = a.items;
    if (a.kind === 'table') d.table_rows = a.rows;
    details.push(d);
  }

  const anaphoraOpeners = paras.filter((p) => isAnaphoric(p.text, lang) === true).length;
  const leadText = visibleText(tokens, { mask, maxWords: TLDR_SCAN_WORDS });
  const hasTldr = heads.some((h) => hasTldrMarker(h.text, lang, { heading: true }) === true) || hasTldrMarker(leadText, lang) === true;

  return {
    lang: langSummary(det),
    question_headings: details.length,
    question_headings_without_direct_answer: details.filter((q) => !q.has_direct_answer).length,
    answers_in_40_60_band: details.filter((q) => q.in_target_band).length,
    details: details.slice(0, MAX_DETAILS),
    passages: paras.length,
    long_passages_over_250w: longPassages,
    anaphora_openers: anaphoraOpeners,
    has_tldr_or_summary: hasTldr,
    answers_by_kind: byKind,
    passages_by_tag: byTag,
    headings: { total: heads.length, h1, question: details.length },
    boilerplate,
    language_dependent_checks: 'evaluated',
    note: NOTE,
  };
}

const flagValue = (v) => (Array.isArray(v) ? v[v.length - 1] : v);

export async function main(args) {
  const input = await loadInput(args);
  const failed = inputFailure(input);
  if (failed) return failed;
  const langFlag = flagValue(args.lang);
  const url = input.finalUrl || (typeof args.url === 'string' ? args.url : null);
  const result = { source: input.source, ...analyzeAnswerBlocks(input.html, { lang: typeof langFlag === 'string' ? langFlag : undefined, url }) };
  return { result, code: EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);

// Content passages for the M11/M12/M13 heuristics. Pure: no I/O.
//
// contentMask(tokens)              -> boilerplate policy as a per-token keep mask (see POLICY below)
// visibleText(tokens, { mask })    -> decoded, collapsed text of the kept tokens
// headingsOf(tokens, { mask })     -> [{ index, level, text, end_idx }] (h1–h6 that survive the policy)
// passages(tokensOrHtml, opts)     -> [{ text, words, tag, region, heading_before, index }]
// answerAfterHeading(tokens, idx)  -> the first answer block after a heading, classified by kind
// classifyNumbers(text, { lang })  -> { all, years, prices, dates, percentages, substantive, sample[] }
//
// POLICY (boilerplate): script/style/noscript/template/svg/iframe/textarea are opaque (never text);
// <head> is never content; nav/footer/aside (tags or roles) are stripped with their subtree;
// <header> is stripped only when it is NOT inside <article>/<main> — and, when the page has no
// <main>/<article> at all, a <header> that contains the <h1> is kept (page-builder markup puts the
// title there). <select>/<datalist> options are dropped (never prose).
//
// PASSAGES: p / li / dd / blockquote / summary with >= minWords (5) words, td / th with >= cellMinWords
// (8) words, and a leaf <div> (no block-level child) with >= minWords words. A block that contains
// another block is a container and is skipped, so text is never counted twice.

import { tokenize, innerText, BLOCK_ELEMENTS } from './html.mjs';
import { decodeEntities } from './entities.mjs';
import { LEXICON, SUPPORTED_LANGS, isWindup, isAnaphoric, findDates } from './lang.mjs';

export const STRIP_LANDMARKS = new Set(['nav', 'footer', 'aside']);
export const PASSAGE_TAGS = new Set(['p', 'li', 'dd', 'td', 'th', 'blockquote', 'summary', 'div']);
export const CELL_TAGS = new Set(['td', 'th']);
export const ANSWER_KINDS = Object.freeze(['paragraph', 'list', 'table', 'div', 'definition', 'text', 'code', 'none']);
export const DEFAULT_MIN_WORDS = 5;
export const CELL_MIN_WORDS = 8;
export const DIRECT_ANSWER_MIN_WORDS = 15;

const HEADING = /^h[1-6]$/;
const BLOCK_CHILD = new Set([...BLOCK_ELEMENTS].filter((n) => n !== 'br'));
const SKIP_IN_ANSWER = new Set(['figure', 'img', 'picture', 'video', 'audio', 'iframe', 'hr', 'br', 'form', 'button', 'input', 'select', 'label', 'nav', 'aside', 'footer', 'header', 'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'object', 'embed']);
const DESCEND_IN_ANSWER = new Set(['div', 'section', 'article', 'main', 'span', 'details', 'hgroup']);
const collapse = (s) => s.replace(/\s+/g, ' ').trim();
const breaks = (name) => BLOCK_ELEMENTS.has(name) || name === 'br' || name === 'button' || name === 'img' || name === 'iframe';

export const wordCount = (s) => { const t = String(s || '').trim(); return t ? t.split(/\s+/).length : 0; };
const toks = (html) => (Array.isArray(html) ? html : tokenize(html));

/**
 * Boilerplate policy → { keep: Uint8Array, has_content_root, stripped: {nav, footer, aside, header}, kept_header_with_h1 }.
 * keep[i] === 1 means the token is page content.
 */
export function contentMask(tokens) {
  const n = tokens.length;
  const keep = new Uint8Array(n).fill(1);
  const hasContentRoot = tokens.some((t) => t.kind === 'open' && (t.landmark === 'main' || t.landmark === 'article'));
  const stripped = { nav: 0, footer: 0, aside: 0, header: 0 };
  let keptHeaderWithH1 = false;
  const dropSubtree = (i) => { const end = tokens[i].end_idx == null ? n : tokens[i].end_idx; for (let j = i; j < end; j++) keep[j] = 0; return end; };
  for (let i = 0; i < n; i++) {
    const t = tokens[i];
    if (t.kind === 'raw' || t.kind === 'comment' || t.kind === 'doctype') { keep[i] = 0; continue; }
    if (t.kind !== 'open') continue;
    if (t.name === 'head' || t.name === 'select' || t.name === 'datalist' || t.name === 'title') { i = dropSubtree(i) - 1; continue; }
    if (!t.landmark) continue;
    if (STRIP_LANDMARKS.has(t.landmark)) { stripped[t.landmark]++; i = dropSubtree(i) - 1; continue; }
    if (t.landmark === 'header') {
      const insideRoot = t.regions.includes('main') || t.regions.includes('article');
      if (insideRoot) continue;
      let hasH1 = false;
      if (!hasContentRoot) {
        const end = t.end_idx == null ? n : t.end_idx;
        for (let j = i + 1; j < end; j++) if (tokens[j].kind === 'open' && tokens[j].name === 'h1') { hasH1 = true; break; }
      }
      if (hasH1) { keptHeaderWithH1 = true; continue; }
      stripped.header++;
      i = dropSubtree(i) - 1;
    }
  }
  return { keep, has_content_root: hasContentRoot, stripped, kept_header_with_h1: keptHeaderWithH1 };
}

const maskOf = (tokens, opts) => (opts && opts.mask) || contentMask(tokens);

/** Decoded, whitespace-collapsed text of the kept tokens (block boundaries become spaces). */
export function visibleText(tokens, { mask, from = 0, to, maxWords = Infinity } = {}) {
  const m = maskOf(tokens, { mask });
  const end = to == null ? tokens.length : to;
  let out = '';
  let words = 0;
  for (let i = from; i < end; i++) {
    if (!m.keep[i]) continue;
    const t = tokens[i];
    if (t.kind === 'text') {
      out += t.text;
      if (maxWords !== Infinity) { words = wordCount(out); if (words > maxWords) break; }
    } else if (t.name && breaks(t.name)) out += ' ';
  }
  let s = collapse(decodeEntities(out));
  if (maxWords !== Infinity) { const w = s.split(' '); if (w.length > maxWords) s = w.slice(0, maxWords).join(' '); }
  return s;
}

/** Headings (h1–h6) that survive the boilerplate policy: [{ index, level, text, end_idx }]. */
export function headingsOf(tokens, { mask } = {}) {
  const m = maskOf(tokens, { mask });
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!m.keep[i] || t.kind !== 'open' || !HEADING.test(t.name)) continue;
    out.push({ index: i, level: Number(t.name[1]), text: innerText(tokens, i), end_idx: t.end_idx == null ? tokens.length : t.end_idx });
  }
  return out;
}

/** True when the element at i has a block-level descendant (so it is a container, not a leaf). */
export function hasBlockChild(tokens, i) {
  const end = tokens[i].end_idx == null ? tokens.length : tokens[i].end_idx;
  for (let j = i + 1; j < end; j++) {
    const c = tokens[j];
    if ((c.kind === 'open' || c.kind === 'self') && BLOCK_CHILD.has(c.name)) return true;
  }
  return false;
}

/**
 * Content passages under the boilerplate policy.
 * Returns [{ text, words, tag, region, heading_before, heading_level, index }].
 */
export function passages(tokensOrHtml, { minWords = DEFAULT_MIN_WORDS, cellMinWords = CELL_MIN_WORDS, mask } = {}) {
  const tokens = toks(tokensOrHtml);
  const m = maskOf(tokens, { mask });
  const out = [];
  let headingBefore = null, headingLevel = null;
  for (let i = 0; i < tokens.length; i++) {
    if (!m.keep[i]) continue;
    const t = tokens[i];
    if (t.kind !== 'open') continue;
    if (HEADING.test(t.name)) { headingBefore = innerText(tokens, i); headingLevel = Number(t.name[1]); continue; }
    if (!PASSAGE_TAGS.has(t.name)) continue;
    if (hasBlockChild(tokens, i)) continue;
    const text = innerText(tokens, i);
    if (!text) continue;
    const words = text.split(' ').length;
    if (words < (CELL_TAGS.has(t.name) ? cellMinWords : minWords)) continue;
    out.push({ text, words, tag: t.name, region: t.region, heading_before: headingBefore, heading_level: headingLevel, index: i });
  }
  return out;
}

/** Tally passages by tag: { p, li, dd, td, th, blockquote, summary, div }. */
export function passagesByTag(list) {
  const by = { p: 0, li: 0, dd: 0, td: 0, th: 0, blockquote: 0, summary: 0, div: 0 };
  for (const p of list) if (p.tag in by) by[p.tag]++;
  return by;
}

function countDirectChildren(tokens, i, name) {
  const end = tokens[i].end_idx == null ? tokens.length : tokens[i].end_idx;
  let n = 0;
  for (let j = i + 1; j < end; j++) if (tokens[j].kind === 'open' && tokens[j].name === name && tokens[j].parent === i) n++;
  return n;
}
function countDescendants(tokens, i, name) {
  const end = tokens[i].end_idx == null ? tokens.length : tokens[i].end_idx;
  let n = 0;
  for (let j = i + 1; j < end; j++) if (tokens[j].kind === 'open' && tokens[j].name === name) n++;
  return n;
}

/**
 * First answer block after the heading at `headingIdx`, scanning until `stopIdx` (the next kept
 * heading) under the boilerplate policy. Accepts paragraph | list | table | div | definition |
 * text (bare inline run) | code. Returns
 * { kind, text, words, items, rows, windup, anaphoric, has_direct_answer, in_target_band, index }.
 * Language-dependent fields (windup, anaphoric, has_direct_answer) are null when `lang` is unsupported.
 */
export function answerAfterHeading(tokens, headingIdx, { stopIdx, mask, lang, minWords = DIRECT_ANSWER_MIN_WORDS, band = [40, 60] } = {}) {
  const m = maskOf(tokens, { mask });
  const h = tokens[headingIdx];
  const start = h && h.end_idx != null ? h.end_idx : headingIdx + 1;
  const stop = stopIdx == null ? tokens.length : stopIdx;
  const res = { kind: 'none', text: '', words: 0, items: 0, rows: 0, windup: null, anaphoric: null, has_direct_answer: null, in_target_band: false, index: null };

  let j = start;
  while (j < stop) {
    if (!m.keep[j]) { j++; continue; }
    const t = tokens[j];
    if (t.kind === 'text') {
      if (!collapse(t.text)) { j++; continue; }
      // bare inline run at section level
      let out = '';
      let k = j;
      while (k < stop) {
        const c = tokens[k];
        if (c.kind === 'text') { if (m.keep[k]) out += c.text; k++; continue; }
        if ((c.kind === 'open' || c.kind === 'self' || c.kind === 'raw') && (BLOCK_CHILD.has(c.name) || HEADING.test(c.name))) break;
        if (c.name === 'br') out += ' ';
        k++;
      }
      res.kind = 'text'; res.text = collapse(decodeEntities(out)); res.index = j;
      break;
    }
    if (t.kind !== 'open') { j++; continue; }
    const name = t.name;
    const end = t.end_idx == null ? tokens.length : t.end_idx;
    if (HEADING.test(name)) break;
    if (SKIP_IN_ANSWER.has(name)) { j = Math.max(end, j + 1); continue; }
    if (name === 'p') { res.kind = 'paragraph'; res.text = innerText(tokens, j); res.index = j; break; }
    if (name === 'ul' || name === 'ol' || name === 'menu') { res.kind = 'list'; res.items = countDirectChildren(tokens, j, 'li'); res.text = innerText(tokens, j); res.index = j; break; }
    if (name === 'table') { res.kind = 'table'; res.rows = countDescendants(tokens, j, 'tr'); res.text = innerText(tokens, j); res.index = j; break; }
    if (name === 'dl') { res.kind = 'definition'; res.items = countDescendants(tokens, j, 'dd'); res.text = innerText(tokens, j); res.index = j; break; }
    if (name === 'pre' || name === 'code') { res.kind = 'code'; res.text = innerText(tokens, j); res.index = j; break; }
    if (name === 'blockquote' || name === 'summary' || name === 'dd' || name === 'li' || name === 'td' || name === 'th' || name === 'figcaption') {
      if (hasBlockChild(tokens, j)) { j++; continue; }
      res.kind = 'paragraph'; res.text = innerText(tokens, j); res.index = j; break;
    }
    if (DESCEND_IN_ANSWER.has(name)) {
      if (name === 'div' && !hasBlockChild(tokens, j)) {
        const text = innerText(tokens, j);
        if (text) { res.kind = 'div'; res.text = text; res.index = j; break; }
        j = end; continue;
      }
      j++; continue; // container: look inside
    }
    // any other inline element at section level starts a bare text run
    if (!BLOCK_CHILD.has(name)) {
      let out = '';
      let k = j;
      while (k < stop) {
        const c = tokens[k];
        if (c.kind === 'text') { if (m.keep[k]) out += c.text; k++; continue; }
        if ((c.kind === 'open' || c.kind === 'self' || c.kind === 'raw') && (BLOCK_CHILD.has(c.name) || HEADING.test(c.name))) break;
        if (c.name === 'br') out += ' ';
        k++;
      }
      const text = collapse(decodeEntities(out));
      if (text) { res.kind = 'text'; res.text = text; res.index = j; break; }
      j = k; continue;
    }
    j++;
  }

  res.words = wordCount(res.text);
  res.in_target_band = res.words >= band[0] && res.words <= band[1];
  if (lang && SUPPORTED_LANGS.includes(lang)) {
    const w = res.kind === 'none' ? false : isWindup(res.text, lang);
    res.windup = w;
    res.anaphoric = res.kind === 'none' ? false : isAnaphoric(res.text, lang);
    let enough = res.words >= minWords;
    if (res.kind === 'list') enough = enough || res.items >= 2;
    if (res.kind === 'table') enough = enough || res.rows >= 2;
    res.has_direct_answer = res.kind !== 'none' && enough && !w;
  }
  return res;
}

// ---------------------------------------------------------------------------
// Numeric tokens

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const altRe = (arr) => arr.slice().sort((a, b) => b.length - a.length).map(escRe).join('|');
const MAG = altRe([...new Set([...LEXICON.en.magnitude_words, ...LEXICON.es.magnitude_words])]);
const PCT_WORDS = altRe([...new Set([...LEXICON.en.percent_words, ...LEXICON.es.percent_words])]);
const CUR_PRE = '(?:US\\$|R\\$|MX\\$|AR\\$|CL\\$|CA\\$|A\\$|NZ\\$|S\\/\\.?|Bs\\.?|USD|EUR|GBP|MXN|ARS|CLP|COP|PEN|BRL|UYU|CAD|AUD|CHF|JPY|CNY|INR|[$€£¥₹₩₽])';
const CUR_POST = '(?:€|\\$|£|¥|₹|USD|EUR|GBP|MXN|ARS|CLP|COP|PEN|BRL|UYU|CAD|AUD|CHF|d[oó]lares|d[oó]lar|euros|euro|pesos|peso|libras|soles|reales|yenes|dollars|dollar|pounds|cents|centavos|c[eé]ntimos)';
const NUM = '\\d+(?:[.,]\\d+)*';
const NUMBER_RE = new RegExp(
  '(?<![\\p{L}\\p{N}_]|\\p{L}-)(?:'
  + '(?<pre>' + CUR_PRE + '\\s?' + NUM + '(?:\\s?(?:' + MAG + '))?)'
  + '|(?<post>' + NUM + '(?:\\s?(?:' + MAG + '))?\\s?' + CUR_POST + ')'
  + '|(?<pct>' + NUM + '\\s?(?:%|' + PCT_WORDS + '))'
  + '|(?<num>' + NUM + ')(?<unit>\\s?(?:' + MAG + '|x))?'
  + ')(?![\\p{L}\\p{N}_])', 'giu');
const TIME_RE = /(?<![\d:])\d{1,2}:\d{2}(?::\d{2})?(?![\d:])/g;
const LIST_MARKER_RE = /^\s*\d{1,2}[.)]\s+/;
const YEAR_RE = /^(?:1[89]|20)\d{2}$/;

/**
 * Classify the numeric tokens of a text. Dates (ISO, month-name, numeric d/m/y) count once each and
 * clock times are ignored. `substantive` = all − years − prices − dates (percentages stay in).
 * Returns { all, years, prices, dates, percentages, substantive, sample: [{ raw, kind }] (≤ 40) }.
 */
export function classifyNumbers(text, { lang, sampleLimit = 40 } = {}) {
  const out = { all: 0, years: 0, prices: 0, dates: 0, percentages: 0, substantive: 0, sample: [] };
  let s = String(text || '');
  if (!s) return out;
  s = s.replace(LIST_MARKER_RE, ' ');
  const pushSample = (raw, kind) => { if (out.sample.length < sampleLimit) out.sample.push({ raw, kind }); };
  // dates first (both lexicons when the language is unknown: month names are language-specific, digits are not)
  const dates = findDates(s, { lang: lang && SUPPORTED_LANGS.includes(lang) ? lang : undefined, limit: 200 });
  if (dates.length) {
    const chars = s.split('');
    for (const d of dates) { for (let i = d.index; i < d.index + d.raw.length; i++) chars[i] = ' '; out.dates++; pushSample(d.raw, 'date'); }
    s = chars.join('');
  }
  s = s.replace(TIME_RE, (m0) => ' '.repeat(m0.length));
  NUMBER_RE.lastIndex = 0;
  let m;
  while ((m = NUMBER_RE.exec(s))) {
    const g = m.groups;
    if (g.pre || g.post) { out.prices++; pushSample(m[0], 'price'); continue; }
    if (g.pct) { out.percentages++; pushSample(m[0], 'percent'); continue; }
    if (!g.unit && YEAR_RE.test(g.num)) { out.years++; pushSample(m[0], 'year'); continue; }
    out.substantive++; pushSample(m[0], 'number');
  }
  out.substantive += out.percentages;
  out.all = out.dates + out.prices + out.percentages + out.years + (out.substantive - out.percentages);
  return out;
}

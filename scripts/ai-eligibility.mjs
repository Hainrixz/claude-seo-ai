#!/usr/bin/env node
// M14 — snippet/index eligibility for AI features (plan 4a).
//
// Google documents one gate for AI Overviews / AI Mode: the page must be indexable AND
// snippet-eligible. `noindex`, `nosnippet`, `max-snippet:0` and `data-nosnippet` therefore remove
// content from those surfaces; blocking Google-Extended does not. This script collects the
// observable facts behind that gate — every meta robots/googlebot/bingbot tag, the X-Robots-Tag
// header (including its UA-scoped form), the `data-nosnippet` share of the page, and the robots.txt
// verdict for Googlebot on this URL — and states what is unknown instead of guessing.
//
// Usage: node ai-eligibility.mjs --url https://example.com/page
//        node ai-eligibility.mjs --file ./page.html [--url <page url>] [--robots ./robots.txt]
//        node ai-eligibility.mjs --snapshot <run>/pages/<slug>.json [--prefer raw|rendered]
// Flags:  --robots <robots.txt|robots.json>  use this robots source instead of fetching/snapshot
//         --no-robots                        skip the robots.txt lookup entirely (url mode)
// Exit codes: 0 ok · 1 usage (no/unreadable input) · 2 runtime (fetch failed)
//
// Findings are NOT emitted here; the checks registry consumes analyzeEligibility().

import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { EXIT, isMain, runCli, loadInput, inputFailure } from './lib/util.mjs';
import { tokenize, parseDocument, innerText } from './lib/html.mjs';
import { contentMask, passages, visibleText, wordCount } from './lib/passages.mjs';
import { parseRobots, robotsFromFetch, isAllowed } from './lib/robots.mjs';
import { fetchRaw } from './lib/fetch.mjs';
import { parseRobotsDirectives, effectiveRobots } from './snapshot.mjs';

/** Elements that may carry data-nosnippet per Google's documentation. */
export const NOSNIPPET_TAGS = Object.freeze(['div', 'span', 'section']);
/** Our own cutoff for "the snippet is capped so low it cannot answer anything" — not a Google number. */
export const LOW_MAX_SNIPPET = 50;

const NOTE = 'Eligibility = indexable AND snippet-eligible (Google, "AI features and your website"). This script reports the directives it can observe; it does not predict whether a page will be cited.';

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/** One agent's view of a directive list: the six directives that decide snippet eligibility. */
export function directiveView(list) {
  const eff = effectiveRobots(list);
  const names = new Set(list.map((d) => d.name));
  return {
    noindex: eff.noindex,
    none: names.has('none'),
    nosnippet: eff.nosnippet,
    max_snippet: eff.max_snippet,
    noimageindex: eff.noimageindex,
    max_image_preview: eff.max_image_preview,
    nofollow: eff.nofollow,
    noarchive: eff.noarchive,
    indexable: eff.indexable,
    snippet_eligible: eff.snippet_eligible,
    directives: eff.directives,
  };
}

const forAgents = (list, agents) => list.filter((d) => agents.has(d.agent));

/**
 * Normalize whatever robots artifact the caller has into something isAllowed() understands:
 * site/robots.json ({mode, parsed}), robotsFromFetch ({mode, robots}), a parseRobots object,
 * or raw robots.txt text.
 */
export function normalizeRobots(robots) {
  if (!robots) return null;
  if (typeof robots === 'string') return { mode: 'parsed', robots: parseRobots(robots) };
  if (robots.mode) {
    if (robots.robots) return robots;
    if (robots.parsed) return { ...robots, robots: robots.parsed };
    // allow-all / disallow-all carry no parsed tree; isAllowed() answers from the mode alone
    return robots.mode === 'parsed' ? null : { mode: robots.mode, robots: null };
  }
  if (robots.groups) return { mode: 'parsed', robots };
  return null;
}

/**
 * data-nosnippet coverage. Only the outermost annotated element counts (nested ones would
 * double-count their own words), and the wrapped range is depth-matched via the tokenizer's end_idx.
 */
export function dataNosnippet(tokens, { mask } = {}) {
  const out = { supported: true, elements: 0, words: 0, word_share: null, wraps_h1: false, wraps_lead: false, by_tag: {}, samples: [] };
  const marked = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'open' && t.kind !== 'self') continue;
    if (!NOSNIPPET_TAGS.includes(t.name)) continue;
    if (t.attrs['data-nosnippet'] === undefined) continue;
    marked.push(i);
  }
  const outer = marked.filter((i) => !marked.some((j) => j !== i && j < i && tokens[j].end_idx != null && tokens[j].end_idx > i));
  const heading1 = tokens.findIndex((t) => t.kind === 'open' && t.name === 'h1');
  const lead = passages(tokens, { mask })[0];
  const leadIdx = lead ? lead.index : -1;
  let words = 0;
  for (const i of outer) {
    const t = tokens[i];
    const end = t.end_idx == null ? i + 1 : t.end_idx;
    const text = t.kind === 'self' ? '' : innerText(tokens, i, { maxLen: 4000 });
    const w = wordCount(text);
    words += w;
    out.by_tag[t.name] = (out.by_tag[t.name] || 0) + 1;
    if (heading1 >= 0 && heading1 > i && heading1 < end) out.wraps_h1 = true;
    if (leadIdx >= 0 && leadIdx > i && leadIdx < end) out.wraps_lead = true;
    if (out.samples.length < 5) out.samples.push({ tag: t.name, words: w, text: text.slice(0, 120) });
  }
  out.elements = outer.length;
  out.words = words;
  return out;
}

/**
 * Pure analysis.
 * @param {object} parsed   parseDocument() result for the page
 * @param {object} headers  lowercased response headers ({} for a local file)
 * @param {object|string|null} robots  site/robots.json, robotsFromFetch result, parseRobots object or robots.txt text
 * @param {string|null} url the page URL (needed for the robots.txt path verdict)
 * @param {object} [opts]   { tokens, html } — one of them is required for the data-nosnippet share
 */
export function analyzeEligibility(parsed, headers = {}, robots = null, url = null, opts = {}) {
  const doc = parsed || {};
  const tokens = opts.tokens || (typeof opts.html === 'string' ? tokenize(opts.html) : null);
  const h = headers && typeof headers === 'object' ? headers : {};
  const rawHeader = h['x-robots-tag'] == null ? null : String(h['x-robots-tag']);
  const headerDirectives = rawHeader ? parseRobotsDirectives(rawHeader) : [];
  const metas = (Array.isArray(doc.robots_meta) ? doc.robots_meta : []).map((m) => ({
    name: m.name, content: m.content, directives: parseRobotsDirectives(m.content, m.name === 'robots' ? null : m.name),
  }));
  const all = [
    ...headerDirectives.map((d) => ({ ...d, source: 'header' })),
    ...metas.flatMap((m) => m.directives.map((d) => ({ ...d, source: 'meta' }))),
  ];

  const google = directiveView(forAgents(all, new Set([null, 'robots', '*', 'googlebot'])));
  const by_agent = {
    all: directiveView(forAgents(all, new Set([null, 'robots', '*']))),
    googlebot: google,
    bingbot: directiveView(forAgents(all, new Set([null, 'robots', '*', 'bingbot']))),
  };

  let nosnippetBlocks;
  if (tokens) nosnippetBlocks = dataNosnippet(tokens, { mask: contentMask(tokens) });
  else nosnippetBlocks = { supported: false, elements: null, words: null, word_share: null, wraps_h1: null, wraps_lead: null, by_tag: {}, samples: [] };
  if (tokens) {
    const contentWords = wordCount(visibleText(tokens, { mask: contentMask(tokens) }));
    nosnippetBlocks.content_words = contentWords;
    nosnippetBlocks.word_share = contentWords > 0 ? Math.round((nosnippetBlocks.words / contentWords) * 1000) / 1000 : null;
  }

  const norm = normalizeRobots(robots);
  let verdict = null;
  if (norm && url) verdict = isAllowed(norm, 'Googlebot', url);
  const googlebot_url_allowed = verdict ? verdict.allowed : null;

  const blockers = [];
  const warnings = [];
  const unknowns = [];
  const reasons = [];
  if (google.noindex) { blockers.push('noindex'); reasons.push('noindex is set' + (google.none ? ' (via "none")' : '') + ' for Googlebot, so the page is not indexed and cannot appear in AI features.'); }
  if (google.nosnippet) { blockers.push('nosnippet'); reasons.push('nosnippet removes every text snippet, which Google documents as removing the page from AI Overviews and AI Mode.'); }
  if (google.max_snippet === 0) { blockers.push('max_snippet_zero'); reasons.push('max-snippet:0 is equivalent to nosnippet for text snippets.'); }
  if (googlebot_url_allowed === false) { blockers.push('robots_disallow'); reasons.push('robots.txt disallows Googlebot for this URL' + (verdict && verdict.rule ? ' (' + verdict.rule.type + ': ' + verdict.rule.path + ', line ' + verdict.rule.line + ')' : '') + '.'); }
  if (google.max_snippet !== null && google.max_snippet > 0 && google.max_snippet < LOW_MAX_SNIPPET) {
    warnings.push('max_snippet_low');
    reasons.push('max-snippet:' + google.max_snippet + ' caps the snippet below our ' + LOW_MAX_SNIPPET + '-character review cutoff (our threshold, not a Google number).');
  }
  if (nosnippetBlocks.supported && nosnippetBlocks.elements > 0) {
    if (nosnippetBlocks.wraps_h1 || nosnippetBlocks.wraps_lead) { warnings.push('data_nosnippet_primary'); reasons.push('data-nosnippet wraps the ' + [nosnippetBlocks.wraps_h1 ? 'H1' : null, nosnippetBlocks.wraps_lead ? 'lead passage' : null].filter(Boolean).join(' and ') + '.'); }
    else { warnings.push('data_nosnippet_partial'); reasons.push('data-nosnippet is present on ' + nosnippetBlocks.elements + ' element(s) but not on the H1 or the lead passage.'); }
  }
  if (!norm) unknowns.push('robots_not_checked');
  else if (!url) unknowns.push('page_url_unknown');
  if (!rawHeader && (!h || Object.keys(h).length === 0)) unknowns.push('no_http_headers');
  if (!nosnippetBlocks.supported) unknowns.push('data_nosnippet_not_scanned');

  let eligible = blockers.length === 0;
  if (eligible && unknowns.length) eligible = null;
  if (eligible === true) reasons.push('No noindex, nosnippet or max-snippet:0 was observed and robots.txt allows Googlebot on this URL.');
  if (eligible === null) reasons.push('Not decidable from what was observed: ' + unknowns.join(', ') + '.');

  return {
    url: url || null,
    meta_robots: metas,
    meta_robots_count: metas.length,
    x_robots_tag: { raw: rawHeader, directives: headerDirectives },
    sources: [rawHeader ? 'header' : null, metas.length ? 'meta' : null].filter(Boolean),
    directives: {
      noindex: google.noindex, none: google.none, nosnippet: google.nosnippet,
      max_snippet: google.max_snippet, noimageindex: google.noimageindex, max_image_preview: google.max_image_preview,
    },
    by_agent,
    data_nosnippet: nosnippetBlocks,
    robots: {
      source: norm ? (robots && robots.source ? robots.source : 'provided') : null,
      googlebot_url_allowed,
      via: verdict ? verdict.via : null,
      rule: verdict ? verdict.rule : null,
      path: verdict ? verdict.path : null,
    },
    eligible_for_ai_features: eligible,
    blockers,
    warnings,
    unknowns,
    reasons,
    note: NOTE,
  };
}

const flagValue = (v) => (Array.isArray(v) ? v[v.length - 1] : v);

/** Locate a robots source: --robots <file>, the snapshot's run dir, or a live fetch (url mode). */
async function loadRobots(args, input, url, fetchImpl) {
  const explicit = flagValue(args.robots);
  if (typeof explicit === 'string' && explicit.trim()) {
    const abs = resolve(explicit.trim());
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch (e) { return { robots: null, source: null, error: 'cannot read --robots ' + abs + ': ' + String(e && e.message || e) }; }
    if (/\.json$/i.test(abs)) {
      try { return { robots: JSON.parse(text), source: 'file:' + abs, error: null }; }
      catch (e) { return { robots: null, source: null, error: 'invalid JSON in --robots ' + abs + ': ' + String(e && e.message || e) }; }
    }
    return { robots: { mode: 'parsed', robots: parseRobots(text) }, source: 'file:' + abs, error: null };
  }
  if (args.robots === false) return { robots: null, source: null, error: null };
  if (input.source === 'snapshot' && input.snapshot && input.snapshot.run_dir) {
    const p = join(input.snapshot.run_dir, 'site', 'robots.json');
    try { return { robots: JSON.parse(readFileSync(p, 'utf8')), source: 'snapshot:' + p, error: null }; }
    catch { return { robots: null, source: null, error: null }; }
  }
  if (input.source === 'url' && url) {
    let origin;
    try { origin = new URL(url).origin; } catch { return { robots: null, source: null, error: null }; }
    const r = await fetchImpl(origin + '/robots.txt', { timeoutMs: 10000, retries: 0 });
    const from = robotsFromFetch({ status: r.status, text: r.body ? r.body.text : '', error: r.error });
    return { robots: from, source: 'http:' + origin + '/robots.txt', error: null };
  }
  return { robots: null, source: null, error: null };
}

export async function main(args, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetchRaw;
  const input = await loadInput(args);
  const failed = inputFailure(input);
  if (failed) return failed;
  const url = input.finalUrl || (typeof flagValue(args.url) === 'string' ? flagValue(args.url) : null);
  const tokens = tokenize(input.html);
  const parsed = parseDocument(input.html, url, { tokens });
  const rb = await loadRobots(args, input, url, fetchImpl);
  if (rb.error) return { result: { error: rb.error }, code: EXIT.USAGE };
  const robots = rb.robots ? { ...rb.robots, source: rb.source } : null;
  const result = { source: input.source, ...analyzeEligibility(parsed, input.headers, robots, url, { tokens }) };
  return { result, code: EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);

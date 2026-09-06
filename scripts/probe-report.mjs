#!/usr/bin/env node
// Probes (plan 4g) — a web-search presence proxy. NEVER scored.
//
// The `geo` skill runs Claude Code's WebSearch for a handful of questions and pipes the raw results
// here. This script only counts: is the host in the top 10 for each question, at what rank, and who
// else is there. It is deliberately not a rank tracker and, above all, it is not AI-citation data —
// see DISCLAIMER, which every consumer of this output must reproduce verbatim.
//
// Usage: node probe-report.mjs --host example.com --results ./probe-results.json
//        cat results.json | node probe-report.mjs --host example.com [--history <dir>] [--out <file>]
// Input:  { host?, queries: [ { query, results: [ { rank, url, title } ] } ] }
// Exit codes: 0 ok · 1 usage (no/invalid input, missing --host)

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { EXIT, isMain, runCli } from './lib/util.mjs';
import { writeJson } from './lib/store.mjs';
import { hostKey } from './lib/urlnorm.mjs';

/** The kind label a report carries so no reader mistakes this for citation data. */
export const PROBE_KIND = 'web_search_presence_proxy';
export const TOP_N = 10;

/** Fixed text. Do not paraphrase it in reports — it is the honesty guardrail for this whole feature. */
export const DISCLAIMER = 'Web-search presence for these questions. This is NOT AI Overview, AI Mode, ChatGPT, or Perplexity citation data — no vendor exposes that. Indexing/retrievability is a documented precondition for Google AI features; presence here is necessary, not sufficient.';

const NOTE = 'One engine, one moment, one set of questions. Re-running the same probe an hour later can return a different set of URLs, so treat movement between runs as a signal to investigate, never as a measurement.';

const hostOf = (url) => { try { return hostKey(new URL(String(url)).href); } catch { return null; } };

/**
 * Pure analysis of one probe batch.
 * @param {object} input { host?, queries: [{ query, results: [{ rank, url, title }] }] }
 * @param {object} [opts] { host } — overrides input.host
 */
export function analyzeProbes(input, { host } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const subject = hostKey(String(host || src.host || ''));
  const queries = Array.isArray(src.queries) ? src.queries : [];
  const rows = [];
  const competitors = new Map();

  for (const q of queries) {
    const results = Array.isArray(q && q.results) ? q.results : [];
    const ranked = results
      .map((r, i) => ({ rank: Number.isFinite(Number(r && r.rank)) ? Number(r.rank) : i + 1, url: r && r.url ? String(r.url) : null, title: r && r.title ? String(r.title) : null }))
      .filter((r) => r.url)
      .sort((a, b) => a.rank - b.rank);
    const mine = ranked.filter((r) => hostOf(r.url) === subject);
    const topHosts = [];
    const seen = new Set();
    for (const r of ranked) {
      if (r.rank > TOP_N) continue;
      const h = hostOf(r.url);
      if (!h || seen.has(h)) continue;
      seen.add(h);
      topHosts.push({ host: h, rank: r.rank });
      if (h === subject) continue;
      const prev = competitors.get(h) || { host: h, queries: 0, best_rank: null };
      prev.queries++;
      prev.best_rank = prev.best_rank === null ? r.rank : Math.min(prev.best_rank, r.rank);
      competitors.set(h, prev);
    }
    rows.push({
      query: q && q.query ? String(q.query) : null,
      results_count: ranked.length,
      host_present_top10: mine.some((r) => r.rank <= TOP_N),
      best_rank: mine.length ? Math.min(...mine.map((r) => r.rank)) : null,
      matching_urls: mine.slice(0, 3).map((r) => ({ rank: r.rank, url: r.url })),
      top_hosts: topHosts,
    });
  }

  const present = rows.filter((r) => r.host_present_top10).length;
  const bestRanks = rows.map((r) => r.best_rank).filter((r) => Number.isFinite(r));
  return {
    kind: PROBE_KIND,
    host: subject || null,
    queries_total: rows.length,
    queries_with_presence: present,
    presence_rate: rows.length ? Math.round((present / rows.length) * 10000) / 10000 : null,
    best_rank_overall: bestRanks.length ? Math.min(...bestRanks) : null,
    queries: rows,
    competitor_hosts: [...competitors.values()].sort((a, b) => b.queries - a.queries || a.best_rank - b.best_rank).slice(0, 20),
    disclaimer: DISCLAIMER,
    note: NOTE,
  };
}

/** Newest prior report in `dir` (by filename, which carries the run timestamp), excluding `exclude`. */
export function previousReport(dir, exclude = null) {
  if (!dir || !existsSync(dir)) return null;
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); }
  catch { return null; }
  const skip = exclude ? basename(exclude) : null;
  for (let i = files.length - 1; i >= 0; i--) {
    if (skip && files[i] === skip) continue;
    try {
      const json = JSON.parse(readFileSync(join(dir, files[i]), 'utf8'));
      if (json && json.kind === PROBE_KIND) return { file: join(dir, files[i]), report: json };
    } catch { /* skip unreadable history entries */ }
  }
  return null;
}

/** Trend against the previous report: absolute deltas only, no invented percentages. */
export function trendAgainst(current, prev) {
  if (!prev || !prev.report) return null;
  const p = prev.report;
  const same = (a, b) => (a === null || b === null ? null : Math.round((a - b) * 10000) / 10000);
  const rate = same(current.presence_rate, p.presence_rate === undefined ? null : p.presence_rate);
  return {
    previous_file: prev.file,
    previous_queries_total: p.queries_total ?? null,
    previous_presence_rate: p.presence_rate ?? null,
    presence_rate_delta: rate,
    previous_best_rank: p.best_rank_overall ?? null,
    best_rank_delta: same(current.best_rank_overall, p.best_rank_overall ?? null),
    direction: rate === null ? 'unknown' : rate > 0 ? 'up' : rate < 0 ? 'down' : 'flat',
    comparable: p.queries_total === current.queries_total,
    note: p.queries_total === current.queries_total ? null : 'The two runs used a different number of questions; the rates are not directly comparable.',
  };
}

const flagValue = (v) => (Array.isArray(v) ? v[v.length - 1] : v);

export async function main(args) {
  const usage = (error, extra) => ({ result: { error, ...(extra || {}) }, code: EXIT.USAGE });
  const resultsFlag = flagValue(args.results);
  let raw = null;
  if (typeof resultsFlag === 'string' && resultsFlag.trim()) {
    try { raw = readFileSync(resolve(resultsFlag.trim()), 'utf8'); }
    catch (e) { return usage('cannot read --results ' + resultsFlag + ': ' + String(e && e.message || e)); }
  } else {
    if (process.stdin.isTTY) return usage('provide --results <file.json> or pipe the WebSearch results on stdin', { input_shape: '{ host, queries: [ { query, results: [ { rank, url, title } ] } ] }' });
    try { raw = readFileSync(0, 'utf8'); }
    catch (e) { return usage('cannot read stdin: ' + String(e && e.message || e)); }
    if (!raw.trim()) return usage('empty stdin');
  }
  let input;
  try { input = JSON.parse(raw); }
  catch (e) { return usage('invalid JSON probe results: ' + String(e && e.message || e)); }
  const host = flagValue(args.host) || input.host;
  if (typeof host !== 'string' || !host.trim()) return usage('provide --host <hostname> (or a "host" key in the input)');
  if (!Array.isArray(input.queries)) return usage('probe results need a "queries" array', { input_shape: '{ host, queries: [ { query, results: [ { rank, url, title } ] } ] }' });

  const report = analyzeProbes(input, { host });
  const out = flagValue(args.out);
  const historyDir = flagValue(args.history);
  report.trend = trendAgainst(report, typeof historyDir === 'string' && historyDir.trim() ? previousReport(resolve(historyDir.trim()), out ? resolve(String(out)) : null) : null);
  report.saved_to = null;
  if (typeof out === 'string' && out.trim()) report.saved_to = writeJson(resolve(out.trim()), report);
  return { result: report, code: EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);

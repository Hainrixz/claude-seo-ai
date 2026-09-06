#!/usr/bin/env node
// Probes (plan 4g) — manual import of a Search Console export. NEVER scored (severity 0, tier 2).
//
// Google's Search Analytics API has no generative-AI search type, and no export separates AI
// surfaces from ordinary search. So this is exactly what it says it is: a CSV the operator
// downloaded by hand, summed. Impressions are the only figure treated as usable — clicks and
// position are not exposed per AI surface, so nothing here may be presented as AI performance.
//
// English and Spanish column headers are both accepted (Page|URL|Página, Impressions|Impresiones,
// Date|Fecha, Query|Consulta), with or without a BOM, quotes or a semicolon delimiter.
// The delimited-file parser is shared with acp-feed-lint.mjs so both read CSV the same way.
//
// Usage: node gsc-ai-import.mjs --csv ./search-console.csv [--host example.com] [--history <dir>]
// Exit codes: 0 ok · 1 usage (no/unreadable CSV, no recognizable columns)

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { EXIT, isMain, runCli } from './lib/util.mjs';
import { hostKey } from './lib/urlnorm.mjs';
import { parseDelimited } from './acp-feed-lint.mjs';

export const SOURCE = 'manual_import';
export const TIER = 2;
/** Accepted header spellings per logical column (compared accent- and case-insensitively). */
export const HEADER_ALIASES = Object.freeze({
  page: ['page', 'url', 'pagina', 'paginas', 'direccion url', 'top pages', 'paginas principales'],
  impressions: ['impressions', 'impresiones'],
  date: ['date', 'fecha', 'dates', 'fechas'],
  query: ['query', 'queries', 'consulta', 'consultas'],
  clicks: ['clicks', 'clics'],
  position: ['position', 'posicion', 'average position', 'posicion media'],
});

export const NOTE = 'Manual import. Search Console does not expose clicks or position for AI surfaces, and the Search Analytics API has no generative-AI search type, so nothing in this file can be attributed to AI Overviews, AI Mode or any assistant. Impressions are reported as the operator exported them; severity 0, never scored.';

const strip = (s) => String(s == null ? '' : s).replace(/^﻿/, '').replace(/^"+|"+$/g, '').trim();
const fold = (s) => strip(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** Map the header row to logical columns; unknown headers are reported, never guessed. */
export function mapHeaders(header) {
  const columns = { page: null, impressions: null, date: null, query: null, clicks: null, position: null };
  const unmapped = [];
  header.forEach((raw) => {
    const key = fold(raw);
    const hit = Object.entries(HEADER_ALIASES).find(([, names]) => names.includes(key));
    if (hit && columns[hit[0]] === null) columns[hit[0]] = strip(raw);
    else if (!hit) unmapped.push(strip(raw));
  });
  return { columns, unmapped };
}

/**
 * Parse a count the way both locales export it: "1,234" (EN thousands) and "1.234" (ES thousands)
 * both mean 1234; "12.5" and "12,5" both mean 12.5. Anything unparsable returns null.
 */
export function parseCount(value) {
  const s = strip(value).replace(/\s/g, '');
  if (!s) return null;
  if (/^\d{1,3}(?:([.,])\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ''));
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^(\d+)[.,](\d+)$/.exec(s);
  if (m) return Number(m[1] + '.' + m[2]);
  return null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const isoOf = (raw) => (ISO_DATE.test(strip(raw)) ? strip(raw) : null);

/**
 * Pure analysis of parsed rows.
 * @param {object[]} rows    objects keyed by the original header names
 * @param {string[]} header
 * @param {object} [opts]    { host } — keep only rows whose page belongs to this host
 */
export function analyzeGscExport(rows, header, { host = null } = {}) {
  const { columns, unmapped } = mapHeaders(header);
  const warnings = [];
  if (!columns.impressions) warnings.push('no impressions column found (' + HEADER_ALIASES.impressions.join(' | ') + ')');
  if (!columns.page && !columns.date && !columns.query) warnings.push('no page, date or query column found — nothing to group by');
  if (columns.clicks) warnings.push('a clicks column is present; it is not summarized because clicks are not exposed per AI surface');
  if (columns.position) warnings.push('a position column is present; it is not summarized because position is not exposed per AI surface');

  const wanted = host ? hostKey(host) : null;
  const byPage = new Map();
  const byDate = new Map();
  const queries = new Set();
  let total = 0;
  let counted = 0;
  let skippedHost = 0;
  let unparsable = 0;

  for (const row of rows) {
    const page = columns.page ? strip(row[columns.page]) : null;
    if (wanted && page) {
      let h = null;
      try { h = hostKey(new URL(page).href); } catch { h = null; }
      if (h && h !== wanted) { skippedHost++; continue; }
    }
    const impressions = columns.impressions ? parseCount(row[columns.impressions]) : null;
    if (columns.impressions && impressions === null) { unparsable++; continue; }
    const value = impressions === null ? 0 : impressions;
    total += value;
    counted++;
    if (page) byPage.set(page, (byPage.get(page) || 0) + value);
    if (columns.date) {
      const raw = strip(row[columns.date]);
      if (raw) {
        const prev = byDate.get(raw) || { date: raw, iso: isoOf(raw), impressions: 0 };
        prev.impressions += value;
        byDate.set(raw, prev);
      }
    }
    if (columns.query) { const q = strip(row[columns.query]); if (q) queries.add(q); }
  }

  const top_pages = [...byPage.entries()].map(([page, impressions]) => ({ page, impressions })).sort((a, b) => b.impressions - a.impressions || a.page.localeCompare(b.page)).slice(0, 20);
  const date_series = [...byDate.values()].sort((a, b) => String(a.iso || a.date).localeCompare(String(b.iso || b.date)));

  let series = null;
  if (date_series.length >= 2) {
    const half = Math.floor(date_series.length / 2);
    const first = date_series.slice(0, half).reduce((n, d) => n + d.impressions, 0);
    const second = date_series.slice(date_series.length - half).reduce((n, d) => n + d.impressions, 0);
    series = {
      points: date_series.length,
      first_date: date_series[0].date,
      last_date: date_series[date_series.length - 1].date,
      first_half_impressions: first,
      second_half_impressions: second,
      delta: second - first,
      direction: second > first ? 'up' : second < first ? 'down' : 'flat',
    };
  }

  return {
    source: SOURCE,
    tier: TIER,
    columns,
    unmapped_columns: unmapped,
    rows_in_file: rows.length,
    rows_counted: counted,
    rows_skipped_other_host: skippedHost,
    rows_unparsable_impressions: unparsable,
    total_impressions: total,
    pages_with_impressions: [...byPage.values()].filter((v) => v > 0).length,
    top_pages,
    date_series,
    queries_distinct: columns.query ? queries.size : null,
    trend: { series, vs_previous_import: null },
    warnings,
    note: NOTE,
  };
}

/** Newest prior import in `dir` (filename order), used for the absolute impressions delta. */
export function previousImport(dir) {
  if (!dir || !existsSync(dir)) return null;
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); }
  catch { return null; }
  for (let i = files.length - 1; i >= 0; i--) {
    try {
      const json = JSON.parse(readFileSync(join(dir, files[i]), 'utf8'));
      if (json && json.source === SOURCE) return { file: join(dir, files[i]), report: json };
    } catch { /* skip unreadable history entries */ }
  }
  return null;
}

const flagValue = (v) => (Array.isArray(v) ? v[v.length - 1] : v);

function detectDelimiter(text) {
  const first = String(text).replace(/^﻿/, '').split(/\r?\n/).find((l) => l.trim()) || '';
  if (first.includes('\t')) return '\t';
  if (!first.includes(',') && first.includes(';')) return ';';
  return ',';
}

export async function main(args) {
  const csv = flagValue(args.csv);
  if (typeof csv !== 'string' || !csv.trim()) return { result: { error: 'provide --csv <file>' }, code: EXIT.USAGE };
  const abs = resolve(csv.trim());
  let raw;
  try { raw = readFileSync(abs, 'utf8'); }
  catch (e) { return { result: { error: 'cannot read --csv ' + abs + ': ' + String(e && e.message || e) }, code: EXIT.USAGE }; }
  const delimiter = detectDelimiter(raw);
  const { header, rows } = parseDelimited(raw, delimiter);
  if (!header.length) return { result: { error: 'no header row in ' + abs }, code: EXIT.USAGE };
  const host = flagValue(args.host);
  const report = { csv: abs, delimiter: delimiter === '\t' ? 'tab' : delimiter, host: typeof host === 'string' ? hostKey(host) : null, ...analyzeGscExport(rows, header, { host: typeof host === 'string' ? host : null }) };
  if (!report.columns.impressions && !report.columns.page && !report.columns.date) {
    return { result: { error: 'no recognizable Search Console columns in ' + abs, header, accepted: HEADER_ALIASES }, code: EXIT.USAGE };
  }
  const historyDir = flagValue(args.history);
  if (typeof historyDir === 'string' && historyDir.trim()) {
    const prev = previousImport(resolve(historyDir.trim()));
    if (prev) {
      report.trend.vs_previous_import = {
        file: prev.file,
        previous_total_impressions: prev.report.total_impressions ?? null,
        delta: Number.isFinite(prev.report.total_impressions) ? report.total_impressions - prev.report.total_impressions : null,
        direction: !Number.isFinite(prev.report.total_impressions) ? 'unknown'
          : report.total_impressions > prev.report.total_impressions ? 'up'
            : report.total_impressions < prev.report.total_impressions ? 'down' : 'flat',
      };
    }
  }
  return { result: report, code: EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);

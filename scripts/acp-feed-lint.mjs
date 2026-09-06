#!/usr/bin/env node
// M18 — Agentic Commerce Protocol product-feed lint (plan 4c).
//
// Checks the shape a feed must have before an agent can read it: the nine required fields, the
// `"79.99 USD"` price form, the availability enum, GTIN check digits, absolute URLs, length caps and
// duplicate item ids. It never fetches the store: a feed that passes this lint is well-formed, not
// necessarily accurate — `feed_page_price_mismatch` is a separate, page-level check.
//
// Usage: node acp-feed-lint.mjs --feed ./feed.jsonl [--format jsonl|csv|tsv|auto] [--sample 500] [--strict]
// Exit codes: 0 ok · 1 usage (no/unreadable feed, unknown format) · 3 --strict with errors

import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { EXIT, isMain, runCli } from './lib/util.mjs';

/** The nine fields an agent needs to render and buy an item. */
export const REQUIRED_FIELDS = Object.freeze(['item_id', 'title', 'description', 'url', 'brand', 'seller_name', 'image_url', 'availability', 'price']);
/** Google Merchant names accepted as aliases; each use is reported as a warning, never an error. */
export const FIELD_ALIASES = Object.freeze({ id: 'item_id', link: 'url', image_link: 'image_url' });
export const AVAILABILITY = Object.freeze(['in_stock', 'out_of_stock', 'pre_order', 'backorder', 'unknown']);
/** Google Merchant availability spellings accepted with a warning. */
export const AVAILABILITY_ALIASES = Object.freeze({ preorder: 'pre_order', in_store_only: 'unknown', limited_availability: 'in_stock' });
export const BOOLEAN_FIELDS = Object.freeze(['is_eligible_search', 'is_eligible_checkout']);
export const MAX_TITLE = 150;
export const MAX_DESCRIPTION = 5000;
export const GTIN_LENGTHS = Object.freeze([8, 12, 13, 14]);
/** decimal, one space, ISO 4217 alphabetic code. */
export const PRICE_RE = /^\d+(?:\.\d+)? [A-Z]{3}$/;

const NOTE = 'Structural lint only. It does not fetch the product pages, so it cannot tell whether the price, availability or image in the feed still match the live page.';

// ---------------------------------------------------------------------------
// parsing

/** Split a delimited text file (RFC 4180 quoting: "" escapes a quote, quoted fields may contain the delimiter and newlines). */
export function parseDelimited(input, delimiter = ',') {
  const src = String(input == null ? '' : input).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') { quoted = true; started = true; continue; }
    if (c === delimiter) { row.push(field); field = ''; started = true; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; started = false; continue; }
    field += c;
    started = true;
  }
  if (started || field !== '' || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift() || [];
  const keys = header.map((h) => String(h).trim());
  const out = [];
  for (const r of rows) {
    if (r.length === 1 && r[0].trim() === '') continue;
    const obj = {};
    keys.forEach((k, i) => { if (k) obj[k] = r[i] === undefined ? '' : r[i]; });
    out.push(obj);
  }
  return { header: keys, rows: out };
}

/** One JSON object per line; blank lines skipped, a bad line becomes a parse error. */
export function parseJsonl(input) {
  const rows = [];
  const errors = [];
  const lines = String(input == null ? '' : input).replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((line, i) => {
    const s = line.trim();
    if (!s) return;
    try {
      const v = JSON.parse(s);
      if (v && typeof v === 'object' && !Array.isArray(v)) rows.push(v);
      else errors.push({ row: i + 1, field: null, reason: 'line_not_an_object' });
    } catch { errors.push({ row: i + 1, field: null, reason: 'invalid_json_line' }); }
  });
  return { rows, errors };
}

export function detectFormat(input, filename = '') {
  const ext = String(extname(filename || '')).toLowerCase();
  if (ext === '.jsonl' || ext === '.ndjson') return 'jsonl';
  if (ext === '.tsv') return 'tsv';
  if (ext === '.csv') return 'csv';
  const first = String(input || '').replace(/^﻿/, '').split(/\r?\n/).find((l) => l.trim());
  if (!first) return 'jsonl';
  if (/^\s*[[{]/.test(first)) return 'jsonl';
  if (first.includes('\t')) return 'tsv';
  return 'csv';
}

export function parseFeed(input, format) {
  if (format === 'jsonl') { const r = parseJsonl(input); return { rows: r.rows, parse_errors: r.errors, header: null }; }
  const d = parseDelimited(input, format === 'tsv' ? '\t' : ',');
  return { rows: d.rows, parse_errors: [], header: d.header };
}

// ---------------------------------------------------------------------------
// field helpers

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

/** GTIN-8/12/13/14 with the standard mod-10 check digit. */
export function gtinValid(value) {
  const s = str(value);
  if (!/^\d+$/.test(s) || !GTIN_LENGTHS.includes(s.length)) return { ok: false, reason: 'gtin_length_or_digits' };
  const digits = s.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += digits[i] * w;
  const expected = (10 - (sum % 10)) % 10;
  return expected === check ? { ok: true, reason: null } : { ok: false, reason: 'gtin_check_digit' };
}

/** "79.99 USD" → { amount: 79.99, currency: 'USD' }; anything else → null. */
export function parsePrice(value) {
  const s = str(value);
  if (!PRICE_RE.test(s)) return null;
  const [amount, currency] = s.split(' ');
  return { amount: Number(amount), currency, raw: s };
}

const isAbsoluteHttp = (v) => /^https?:\/\/[^\s]+$/i.test(str(v));

function booleanValue(v) {
  if (typeof v === 'boolean') return v;
  const s = str(v).toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return null;
}

/** Apply the Google Merchant aliases; the row keeps its original keys plus the canonical ones. */
export function canonicalizeRow(row) {
  const out = { ...row };
  const used = [];
  for (const [alias, canonical] of Object.entries(FIELD_ALIASES)) {
    if (isBlank(out[canonical]) && !isBlank(out[alias])) { out[canonical] = out[alias]; used.push({ alias, canonical }); }
  }
  return { row: out, aliases_used: used };
}

// ---------------------------------------------------------------------------
// lint

/**
 * Lint parsed feed rows.
 * @param {object[]} rows
 * @param {object} [opts] { sample }  — lint only the first `sample` rows
 * @returns {{rows:number, errors:Array, error_counts_by_field:object, duplicates:Array, warnings:Array, first_20:Array}}
 */
export function lintFeed(rows, { sample = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const limited = sample && sample > 0 ? list.slice(0, sample) : list;
  const errors = [];
  const warnings = [];
  const seen = new Map();
  const duplicates = [];
  const fields = new Set();
  const err = (row, field, reason, detail) => errors.push(detail === undefined ? { row, field, reason } : { row, field, reason, detail });
  const warn = (row, field, reason, detail) => warnings.push(detail === undefined ? { row, field, reason } : { row, field, reason, detail });

  limited.forEach((raw, i) => {
    const rowNo = i + 1;
    const { row, aliases_used } = canonicalizeRow(raw);
    for (const k of Object.keys(raw)) fields.add(k);
    for (const a of aliases_used) warn(rowNo, a.alias, 'google_field_alias', a.alias + ' accepted as ' + a.canonical);

    for (const f of REQUIRED_FIELDS) if (isBlank(row[f])) err(rowNo, f, 'missing_required_field');

    const id = str(row.item_id);
    if (id) {
      if (seen.has(id)) { err(rowNo, 'item_id', 'duplicate_item_id', 'first seen on row ' + seen.get(id)); duplicates.push({ item_id: id, rows: [seen.get(id), rowNo] }); }
      else seen.set(id, rowNo);
    }

    if (!isBlank(row.title) && str(row.title).length > MAX_TITLE) err(rowNo, 'title', 'title_too_long', str(row.title).length + ' > ' + MAX_TITLE);
    if (!isBlank(row.description) && str(row.description).length > MAX_DESCRIPTION) err(rowNo, 'description', 'description_too_long', str(row.description).length + ' > ' + MAX_DESCRIPTION);

    for (const f of ['url', 'image_url']) if (!isBlank(row[f]) && !isAbsoluteHttp(row[f])) err(rowNo, f, 'url_not_absolute_http');

    if (!isBlank(row.availability)) {
      const a = str(row.availability).toLowerCase();
      if (!AVAILABILITY.includes(a)) {
        if (AVAILABILITY_ALIASES[a]) warn(rowNo, 'availability', 'google_availability_alias', a + ' accepted as ' + AVAILABILITY_ALIASES[a]);
        else err(rowNo, 'availability', 'availability_not_in_enum', a);
      }
    }

    const price = isBlank(row.price) ? null : parsePrice(row.price);
    if (!isBlank(row.price) && !price) err(rowNo, 'price', 'price_format', 'expected "<decimal> <ISO4217>", got ' + JSON.stringify(str(row.price)));
    if (!isBlank(row.sale_price)) {
      const sale = parsePrice(row.sale_price);
      if (!sale) err(rowNo, 'sale_price', 'price_format', 'expected "<decimal> <ISO4217>", got ' + JSON.stringify(str(row.sale_price)));
      else if (price) {
        if (sale.currency !== price.currency) err(rowNo, 'sale_price', 'sale_price_currency_mismatch', sale.currency + ' vs ' + price.currency);
        else if (sale.amount >= price.amount) err(rowNo, 'sale_price', 'sale_price_not_below_price', sale.amount + ' >= ' + price.amount);
      }
    }

    if (!isBlank(row.gtin)) {
      const g = gtinValid(row.gtin);
      if (!g.ok) err(rowNo, 'gtin', g.reason, str(row.gtin));
    }

    for (const f of BOOLEAN_FIELDS) if (!isBlank(row[f]) && booleanValue(row[f]) === null) err(rowNo, f, 'not_a_boolean', JSON.stringify(str(row[f])));
  });

  const error_counts_by_field = {};
  for (const e of errors) {
    const key = e.field || '(row)';
    error_counts_by_field[key] = (error_counts_by_field[key] || 0) + 1;
  }
  const rowsWithErrors = new Set(errors.map((e) => e.row));
  return {
    rows: limited.length,
    rows_total: list.length,
    sampled: limited.length !== list.length,
    valid_rows: limited.length - rowsWithErrors.size,
    fields_seen: [...fields].sort(),
    errors,
    error_counts_by_field,
    duplicates,
    warnings,
    first_20: errors.slice(0, 20),
  };
}

// ---------------------------------------------------------------------------
// CLI

const flagValue = (v) => (Array.isArray(v) ? v[v.length - 1] : v);

export async function main(args) {
  const feed = flagValue(args.feed);
  if (typeof feed !== 'string' || !feed.trim()) return { result: { error: 'provide --feed <file>' }, code: EXIT.USAGE };
  const abs = resolve(feed.trim());
  let raw;
  try { raw = readFileSync(abs, 'utf8'); }
  catch (e) { return { result: { error: 'cannot read --feed ' + abs + ': ' + String(e && e.message || e) }, code: EXIT.USAGE }; }

  let format = flagValue(args.format);
  format = format === undefined || format === true || format === 'auto' ? detectFormat(raw, abs) : String(format).toLowerCase();
  if (!['jsonl', 'csv', 'tsv'].includes(format)) return { result: { error: 'unknown --format ' + format, hint: 'jsonl | csv | tsv | auto' }, code: EXIT.USAGE };

  const sampleFlag = Number(flagValue(args.sample));
  const parsed = parseFeed(raw, format);
  const lint = lintFeed(parsed.rows, { sample: Number.isFinite(sampleFlag) && sampleFlag > 0 ? sampleFlag : null });
  const errors = [...parsed.parse_errors, ...lint.errors];
  const result = {
    feed: abs,
    format,
    header: parsed.header,
    ...lint,
    errors,
    first_20: errors.slice(0, 20),
    ok: errors.length === 0,
    note: NOTE,
  };
  if (parsed.parse_errors.length) {
    result.error_counts_by_field = { ...result.error_counts_by_field, '(row)': (result.error_counts_by_field['(row)'] || 0) + parsed.parse_errors.length };
  }
  return { result, code: args.strict && errors.length ? EXIT.THRESHOLD : EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);

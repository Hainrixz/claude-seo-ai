#!/usr/bin/env node
// Fetch Core Web Vitals via the Google PageSpeed Insights API. Backs M15.
// Field (CrUX, p75) data is what Google ranks on; lab data is labeled separately.
//
// Usage: node psi-client.mjs --url https://example.com [--strategy mobile|desktop] [--key <PSI_API_KEY>]
//        (key optional but recommended; without network/key the result is status:"needs_api")
//
// Reads PSI_API_KEY from env if --key is omitted.

import { parseArgs, emit, fetchText } from './lib/util.mjs';

const args = parseArgs();
if (!args.url) emit({ status: 'needs_api', error: 'provide --url' }, 1);
const strategy = args.strategy === 'desktop' ? 'desktop' : 'mobile';
const key = args.key || process.env.PSI_API_KEY || null;

const THRESH = { LCP: { good: 2500, poor: 4000 }, INP: { good: 200, poor: 500 }, CLS: { good: 0.1, poor: 0.25 } };
const rate = (metric, v) => v == null ? null : (v <= THRESH[metric].good ? 'good' : v <= THRESH[metric].poor ? 'needs-improvement' : 'poor');

const api = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
api.searchParams.set('url', args.url);
api.searchParams.set('strategy', strategy);
api.searchParams.append('category', 'performance');
if (key) api.searchParams.set('key', key);

const r = await fetchText(api.href, { timeoutMs: 60000 });
if (!r.ok) {
  emit({
    status: 'needs_api',
    strategy,
    error: 'PageSpeed Insights unavailable (no network/key or quota). Field CWV cannot be measured — do not present a heuristic as a measured field value.',
    detail: r.error || ('HTTP ' + r.status),
    hint: 'set PSI_API_KEY or pass --key; otherwise report status needs_api.',
  });
}

let data; try { data = JSON.parse(r.text); } catch (e) { emit({ status: 'needs_api', error: 'PSI returned non-JSON', detail: String(e && e.message || e) }); }

const le = data.loadingExperience && data.loadingExperience.metrics;
const cruxMs = (k) => le && le[k] ? le[k].percentile : null;
const field = le ? {
  has_field_data: true,
  lcp_ms: cruxMs('LARGEST_CONTENTFUL_PAINT_MS'),
  inp_ms: cruxMs('INTERACTION_TO_NEXT_PAINT'),
  cls: cruxMs('CUMULATIVE_LAYOUT_SHIFT_SCORE') != null ? cruxMs('CUMULATIVE_LAYOUT_SHIFT_SCORE') / 100 : null,
} : { has_field_data: false };
if (field.has_field_data) {
  field.lcp_rating = rate('LCP', field.lcp_ms);
  field.inp_rating = rate('INP', field.inp_ms);
  field.cls_rating = rate('CLS', field.cls);
}

const audits = (data.lighthouseResult && data.lighthouseResult.audits) || {};
const num = (id) => audits[id] && typeof audits[id].numericValue === 'number' ? audits[id].numericValue : null;
const lab = {
  note: 'LAB data (single synthetic run) — NOT what Google ranks on; field data above is.',
  performance_score: data.lighthouseResult && data.lighthouseResult.categories && data.lighthouseResult.categories.performance
    ? Math.round(data.lighthouseResult.categories.performance.score * 100) : null,
  lcp_ms: num('largest-contentful-paint'),
  cls: num('cumulative-layout-shift'),
  tbt_ms: num('total-blocking-time'),
};

emit({ status: 'ok', strategy, url: data.id || args.url, field, lab, thresholds: THRESH });

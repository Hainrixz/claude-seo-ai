#!/usr/bin/env node
// Fetch Core Web Vitals via the Google PageSpeed Insights API. Backs M15.
// Field (CrUX, p75) data is what Google ranks on; lab data is labeled separately.
//
// Usage: node psi-client.mjs --url https://example.com [--strategy mobile|desktop] [--timeout 60000]
//        (a key is optional but recommended; without network/key the result is status:"needs_api")
//
// The API key comes from the environment only — CLAUDE_PLUGIN_OPTION_PSI_API_KEY, else PSI_API_KEY.
// There is deliberately no --key flag: a secret in argv lands in `ps`, in shell history and in any
// command log, and this script's own output quotes the command to re-run.
// Exit codes: 0 ok, or status "needs_api" with an `api_error` object when the API could not be
//             used (documented: an unavailable measurement is a finding, not a crash) · 1 usage (no --url)
// Callers MUST branch on `status`, never on the exit code alone.
//
// Honesty: when PSI sets `loadingExperience.origin_fallback`, the numbers are ORIGIN-level (the URL
// itself has too little CrUX traffic) — `field.origin_fallback` + `field.scope` say so; a finding
// must never present them as page-level. Absent metrics → `has_field_data: false`, never zeros.

import { EXIT, isMain, runCli, credential } from './lib/util.mjs';
import { fetchText } from './lib/fetch.mjs';

export const THRESH = Object.freeze({ LCP: { good: 2500, poor: 4000 }, INP: { good: 200, poor: 500 }, CLS: { good: 0.1, poor: 0.25 } });
const rate = (metric, v) => v == null ? null : (v <= THRESH[metric].good ? 'good' : v <= THRESH[metric].poor ? 'needs-improvement' : 'poor');
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

/** Summarize a PSI loadingExperience block (page or origin) into the field shape; null when it has no metrics. */
export function fieldFrom(le) {
  const metrics = le && le.metrics && typeof le.metrics === 'object' && Object.keys(le.metrics).length ? le.metrics : null;
  if (!metrics) return null;
  const p75 = (k) => metrics[k] && typeof metrics[k].percentile === 'number' ? metrics[k].percentile : null;
  const cat = (k) => metrics[k] && metrics[k].category ? String(metrics[k].category).toLowerCase() : null;
  const cls = p75('CUMULATIVE_LAYOUT_SHIFT_SCORE');
  const out = {
    has_field_data: true,
    origin_fallback: le.origin_fallback === true,
    scope: le.origin_fallback === true ? 'origin' : 'page',
    overall_category: le.overall_category || null,
    lcp_ms: p75('LARGEST_CONTENTFUL_PAINT_MS'),
    inp_ms: p75('INTERACTION_TO_NEXT_PAINT'),
    cls: cls != null ? cls / 100 : null,
    fcp_ms: p75('FIRST_CONTENTFUL_PAINT_MS'),
    ttfb_ms: p75('EXPERIMENTAL_TIME_TO_FIRST_BYTE'),
  };
  out.lcp_rating = rate('LCP', out.lcp_ms);
  out.inp_rating = rate('INP', out.inp_ms);
  out.cls_rating = rate('CLS', out.cls);
  out.google_categories = { lcp: cat('LARGEST_CONTENTFUL_PAINT_MS'), inp: cat('INTERACTION_TO_NEXT_PAINT'), cls: cat('CUMULATIVE_LAYOUT_SHIFT_SCORE') };
  return out;
}

export async function main(args) {
  if (!args.url || typeof args.url !== 'string') {
    return { result: { status: 'needs_api', error: 'provide --url' }, code: EXIT.USAGE };
  }
  const strategy = args.strategy === 'desktop' ? 'desktop' : 'mobile';
  const key = credential('PSI_API_KEY');

  const api = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  api.searchParams.set('url', args.url);
  api.searchParams.set('strategy', strategy);
  api.searchParams.append('category', 'performance');
  if (key) api.searchParams.set('key', key);

  // fetchText retries once on network error / 5xx with backoff; never on 4xx (quota, bad key).
  const r = await fetchText(api.href, { timeoutMs: num(args.timeout, 60000), retries: 1 });
  if (!r.ok) {
    return {
      result: {
        status: 'needs_api',
        strategy,
        error: 'PageSpeed Insights unavailable (no network/key or quota). Field CWV cannot be measured — do not present a heuristic as a measured field value.',
        detail: r.error || ('HTTP ' + r.status),
        hint: 'export CLAUDE_PLUGIN_OPTION_PSI_API_KEY or PSI_API_KEY; otherwise report status needs_api.',
        api_error: { kind: r.status ? 'http' : 'network', status: r.status || null, detail: r.error || ('HTTP ' + r.status) },
      },
      code: EXIT.OK,
    };
  }

  let data;
  try { data = JSON.parse(r.text); } catch (e) {
    const detail = String(e && e.message || e);
    return {
      result: {
        status: 'needs_api', strategy, error: 'PSI returned non-JSON', detail,
        api_error: { kind: 'non_json', status: r.status, detail },
      },
      code: EXIT.OK,
    };
  }

  const le = data.loadingExperience || null;
  const field = fieldFrom(le) || {
    has_field_data: false,
    origin_fallback: !!(le && le.origin_fallback),
    scope: null,
    overall_category: (le && le.overall_category) || null,
    note: 'CrUX has no field data for this URL (insufficient real-user traffic); lab data below is the only measurement available.',
  };
  const originField = fieldFrom(data.originLoadingExperience || null);

  const lh = data.lighthouseResult || {};
  const audits = lh.audits || {};
  const numv = (id) => audits[id] && typeof audits[id].numericValue === 'number' ? audits[id].numericValue : null;
  const lab = {
    note: 'LAB data (single synthetic run) — NOT what Google ranks on; field data above is.',
    performance_score: lh.categories && lh.categories.performance && typeof lh.categories.performance.score === 'number'
      ? Math.round(lh.categories.performance.score * 100) : null,
    lcp_ms: numv('largest-contentful-paint'),
    cls: numv('cumulative-layout-shift'),
    tbt_ms: numv('total-blocking-time'),
    fcp_ms: numv('first-contentful-paint'),
    speed_index_ms: numv('speed-index'),
    lighthouse_version: lh.lighthouseVersion || null,
    fetch_time: lh.fetchTime || null,
  };

  return {
    result: {
      status: 'ok', strategy, url: data.id || args.url, analysis_utc: data.analysisUTCTimestamp || null,
      field, origin: originField, lab, thresholds: THRESH,
    },
    code: EXIT.OK,
  };
}

if (isMain(import.meta.url)) runCli(main);

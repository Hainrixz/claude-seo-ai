#!/usr/bin/env node
// M14 — same URL, different user agents (plan 4a).
//
// Fetches one URL once per UA preset and reports what changed: status, title/H1, word count,
// canonical, robots meta and JSON-LD types, plus bot-challenge signals (403/429/503, a
// `cf-mitigated` header, or an interstitial body). Divergence is evidence, never proof: a spoofed
// UA can be refused for legitimate reasons, so every finding built on this output is directional.
//
// Usage: node ua-diff.mjs --url https://example.com/page
//        node ua-diff.mjs --url <u> --ua default,googlebot,gptbot [--run-dir <run>] [--timeout 20000]
// Exit codes: 0 ok · 1 usage (missing/invalid --url, unknown UA) · 2 runtime (every fetch failed)

import { join } from 'node:path';
import { EXIT, isMain, runCli } from './lib/util.mjs';
import { fetchRaw, UA_PRESETS, resolveUa, parseLinkHeader } from './lib/fetch.mjs';
import { tokenize, parseDocument } from './lib/html.mjs';
import { parseRobotsDirectives, effectiveRobots } from './snapshot.mjs';
import { pageSlug, writeJson } from './lib/store.mjs';

/** Default UA set: our own token, the two search crawlers and the three AI fetchers we can name. */
export const DEFAULT_UAS = Object.freeze(['default', 'googlebot', 'gptbot', 'oai-searchbot', 'claude-searchbot']);
export const BASELINE_UA = 'default';
/** Statuses that commonly mean "a bot filter answered instead of the site". */
export const CHALLENGE_STATUSES = Object.freeze([403, 429, 503]);
const CHALLENGE_BODY = /just a moment|attention required|checking your browser|cf-browser-verification|enable javascript and cookies to continue/i;

const NOTE = 'Content divergence across user agents is directional evidence, not proof of cloaking: a spoofed UA can be refused or rate-limited for legitimate reasons, and a CDN may serve a challenge to any unknown client.';

const uniqSorted = (list) => [...new Set(list.filter(Boolean))].sort();

/** Reduce one fetchRaw result to the comparable surface of a page. */
export function summarizeVariant(uaKey, res) {
  const { ua, preset } = resolveUa({ ua: uaKey });
  const headers = (res && res.headers) || {};
  const html = res && res.body ? res.body.text || '' : '';
  const finalUrl = (res && res.final_url) || null;
  const tokens = html ? tokenize(html) : [];
  const doc = html ? parseDocument(html, finalUrl, { tokens }) : null;
  const h1 = doc ? (doc.headings.find((h) => h.level === 1) || null) : null;
  const headerLinks = parseLinkHeader(headers.link || null, finalUrl || undefined);
  const headerCanonical = headerLinks.find((l) => String(l.rel || '').split(/\s+/).includes('canonical'));
  const canonical = doc && doc.canonicals.length ? (doc.canonicals[0].abs || doc.canonicals[0].href) : (headerCanonical ? headerCanonical.url : null);
  const robotsMeta = doc ? doc.robots_meta.map((m) => ({ name: m.name, content: m.content })) : [];
  const xRobots = headers['x-robots-tag'] == null ? null : String(headers['x-robots-tag']);
  const directives = [
    ...(xRobots ? parseRobotsDirectives(xRobots) : []),
    ...robotsMeta.flatMap((m) => parseRobotsDirectives(m.content, m.name === 'robots' ? null : m.name)),
  ];
  const eff = effectiveRobots(directives);
  const signals = [];
  if (res && CHALLENGE_STATUSES.includes(res.status)) signals.push('status_' + res.status);
  if (headers['cf-mitigated']) signals.push('cf-mitigated');
  if (headers['x-datadome'] || headers['x-datadome-cid']) signals.push('datadome');
  if (CHALLENGE_BODY.test(html.slice(0, 8000))) signals.push('interstitial_body');
  return {
    ua: uaKey,
    ua_preset: preset,
    user_agent: ua,
    status: res ? res.status : 0,
    ok: !!(res && res.ok),
    final_url: finalUrl,
    redirect_hops: res && res.redirects ? res.redirects.hops : 0,
    title: doc ? doc.title.value : null,
    h1: h1 ? h1.text : null,
    word_count: doc ? doc.word_count : 0,
    text_bytes: res && res.body ? res.body.bytes : 0,
    canonical,
    robots_meta: robotsMeta,
    x_robots_tag: xRobots,
    noindex: eff.noindex,
    nosnippet: eff.nosnippet,
    jsonld_types: doc ? uniqSorted(doc.jsonld.flatMap((b) => b.type || [])) : [],
    challenge_detected: signals.length > 0,
    challenge_signals: signals,
    error: res ? res.error || null : 'no response',
  };
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Pairwise diff of every variant against the baseline UA (default: our own token). */
export function diffVariants(variants, { baseline = BASELINE_UA } = {}) {
  const base = variants.find((v) => v.ua === baseline) || variants[0] || null;
  const diffs = [];
  if (!base) return { baseline: null, diffs, any_divergence: false, divergent_uas: [], challenged_uas: [] };
  for (const v of variants) {
    if (v === base) continue;
    const word_ratio = base.word_count > 0 ? Math.round((v.word_count / base.word_count) * 1000) / 1000 : null;
    const d = {
      ua: v.ua,
      status_differs: v.status !== base.status,
      title_or_h1_differs: (v.title || '') !== (base.title || '') || (v.h1 || '') !== (base.h1 || ''),
      word_ratio,
      canonical_differs: (v.canonical || null) !== (base.canonical || null),
      noindex_differs: v.noindex !== base.noindex,
      jsonld_differs: !sameList(v.jsonld_types, base.jsonld_types),
      challenge_detected: v.challenge_detected,
    };
    d.differs = d.status_differs || d.title_or_h1_differs || d.canonical_differs || d.noindex_differs || d.jsonld_differs;
    diffs.push(d);
  }
  return {
    baseline: base.ua,
    diffs,
    any_divergence: diffs.some((d) => d.differs),
    divergent_uas: diffs.filter((d) => d.differs).map((d) => d.ua),
    challenged_uas: variants.filter((v) => v.challenge_detected).map((v) => v.ua),
  };
}

/** Fetch the URL once per UA (sequentially — same origin, one page). */
export async function collectVariants(url, { uas = DEFAULT_UAS, fetchImpl = fetchRaw, timeoutMs = 20000, acceptLanguage, maxBytes } = {}) {
  const out = [];
  for (const ua of uas) {
    let res;
    const opts = { timeoutMs, retries: 0 };
    if (acceptLanguage) opts.acceptLanguage = acceptLanguage;
    if (maxBytes) opts.maxBytes = maxBytes;
    if (UA_PRESETS[ua]) opts.uaPreset = ua; else opts.ua = ua;
    try { res = await fetchImpl(url, opts); }
    catch (e) { res = { status: 0, ok: false, final_url: url, headers: {}, body: { text: '', bytes: 0 }, redirects: { hops: 0 }, error: String(e && e.message || e) }; }
    out.push(summarizeVariant(ua, res));
  }
  return out;
}

const flagValue = (v) => (Array.isArray(v) ? v[v.length - 1] : v);
const listFlag = (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean);

export async function main(args, deps = {}) {
  const url = flagValue(args.url);
  if (typeof url !== 'string' || !url.trim()) return { result: { error: 'provide --url <u>' }, code: EXIT.USAGE };
  let target;
  try { target = new URL(url.trim()).href; }
  catch { return { result: { error: 'invalid --url ' + url, hint: 'include the scheme, e.g. https://' + String(url).replace(/^\/+/, '') }, code: EXIT.USAGE }; }
  const uaFlag = flagValue(args.ua);
  const uas = uaFlag === undefined || uaFlag === true ? [...DEFAULT_UAS] : listFlag(uaFlag);
  if (!uas.length) return { result: { error: '--ua needs at least one preset or literal user agent', presets: Object.keys(UA_PRESETS) }, code: EXIT.USAGE };
  if (!uas.includes(BASELINE_UA)) uas.unshift(BASELINE_UA);
  const timeoutMs = Number(flagValue(args.timeout)) > 0 ? Number(flagValue(args.timeout)) : 20000;

  const variants = await collectVariants(target, { uas, fetchImpl: deps.fetchImpl || fetchRaw, timeoutMs });
  const diff = diffVariants(variants);
  const result = {
    url: target,
    ua_presets: Object.keys(UA_PRESETS),
    fetched: variants.length,
    variants,
    baseline: diff.baseline,
    diffs: diff.diffs,
    any_divergence: diff.any_divergence,
    divergent_uas: diff.divergent_uas,
    challenged_uas: diff.challenged_uas,
    saved_to: null,
    note: NOTE,
  };
  const runDir = flagValue(args['run-dir']);
  if (typeof runDir === 'string' && runDir.trim()) {
    result.saved_to = writeJson(join(runDir.trim(), 'pages', pageSlug(target) + '.ua-diff.json'), result);
  }
  if (variants.every((v) => v.status === 0)) return { result: { ...result, error: 'every fetch failed' }, code: EXIT.RUNTIME };
  return { result, code: EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);

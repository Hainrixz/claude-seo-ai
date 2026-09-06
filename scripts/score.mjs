#!/usr/bin/env node
// Compute the two never-blended scores (Search SEO + AI Visibility) from findings.
// Pure logic — fully reproducible. Implements references/scoring-model.md.
//
// Usage:
//   node score.mjs --findings findings.json [--vertical ecommerce,local-business] [--multilingual]
//                  [--vertical-json <detect-output.json>] [--environment production|preview|staging|local]
//                  [--strict] [--validate-only]
//   node score.mjs --run <run-dir> [--manifest [<crawl.json>]]      (reads <run-dir>/findings.json)
//   cat findings.json | node score.mjs
// Input: a JSON array of findings, or { "findings": [...] }, each conforming to
// schema/finding.schema.json. Invalid findings are dropped and listed in dropped_findings[].
// Exit codes: 0 ok · 1 usage (no/unreadable/invalid input or flag) · 2 --strict with dropped findings

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT, isMain, runCli } from './lib/util.mjs';
import { band as bandOf } from './lib/bands.mjs';
import { validateFindings } from './lib/validate-finding.mjs';

export { band } from './lib/bands.mjs';

export const SEARCH = [
  { name: 'Indexability & Crawl', weight: 22, modules: ['M1', 'M2', 'M3'] },
  { name: 'Core Web Vitals / Performance', weight: 16, modules: ['M15'] },
  { name: 'On-Page & Meta', weight: 12, modules: ['M7'] },
  { name: 'Structured Data', weight: 12, modules: ['M5'] },
  { name: 'Rendering', weight: 8, modules: ['M4'] },
  { name: 'Internal Linking & Semantics', weight: 8, modules: ['M10'] },
  { name: 'E-E-A-T', weight: 7, modules: ['M16'] },
  { name: 'Images / Media', weight: 5, modules: ['M9'] },
  { name: 'Sitemaps & Discovery', weight: 5, modules: ['M17'] },
  { name: 'Freshness', weight: 3, modules: ['M13'] },
  { name: 'Social Cards', weight: 2, modules: ['M8'] },
  { name: 'E-commerce', weight: 15, modules: ['M18'], conditional: true, activation: 'vertical:ecommerce' },
  { name: 'Local', weight: 10, modules: ['M19'], conditional: true, activation: 'vertical:local-business' },
  { name: 'International', weight: 8, modules: ['M20'], conditional: true, activation: 'flag:multilingual' },
];

// Always-on weights sum to 100. M21 is reported at weight 0 (never moves the score).
export const AI = [
  { name: 'Answer Extractability', weight: 18, modules: ['M11'] },
  { name: 'AI Crawler Access', weight: 14, modules: ['M14'] },
  { name: 'Fact Density / Original Data', weight: 14, modules: ['M12'] },
  { name: 'Structured Data', weight: 12, modules: ['M5'] },
  { name: 'Rendering (non-JS)', weight: 10, modules: ['M4'] },
  { name: 'Entity / Knowledge-Graph', weight: 9, modules: ['M6'] },
  { name: 'E-E-A-T / Authority', weight: 9, modules: ['M16'] },
  { name: 'Freshness', weight: 6, modules: ['M13'] },
  { name: 'Agent-readiness', weight: 4, modules: ['M22'] },
  { name: 'Images / Multimodal', weight: 4, modules: ['M9'] },
  { name: 'AI discovery & agent endpoints', weight: 0, modules: ['M21'] },
  { name: 'Agentic commerce readiness', weight: 6, modules: ['M18'], conditional: true, activation: 'vertical:ecommerce' },
  { name: 'Local / place data', weight: 5, modules: ['M19'], conditional: true, activation: 'vertical:local-business' },
];

export const VERTICALS = Object.freeze(['saas', 'blog-publisher', 'local-business', 'ecommerce', 'docs', 'generic']);
export const ENVIRONMENTS = Object.freeze(['production', 'preview', 'staging', 'local']);
export const CAP_VALUE = 40;
/**
 * Minimum share (%) of an axis's always-on weight that must carry a scored finding before its band
 * is reported without a caveat. Below it the numbers stay exactly as computed and the axis is
 * marked `provisional` with state `partial` — a one-page run that only measured two categories must
 * not read as a confident "A". See references/scoring-model.md § Coverage.
 */
export const COVERAGE_FLOOR = 50;
/** Cap reasons whose id matches one of these are expected on non-production hosts and are suppressed there. */
export const ENV_SUPPRESSED_CAP_PATTERNS = Object.freeze([/^M2\.[a-z0-9_.-]*noindex/, /^M1\.robots\./, /^M14\.ai_eligibility\.not_indexable$/]);
/** Page weights for the site rollup (used when the manifest does not carry an explicit page weight). */
export const ROLE_WEIGHTS = Object.freeze({ homepage: 3, target: 2, 'template-sample': 2, 'long-tail': 1 });

export const INTERPRETATIONS = Object.freeze({
  hi_search_lo_ai: { search: 'Ranks well; classic fundamentals are strong.', ai: 'Hard to cite by AI engines — add extractable structure and verify AI eligibility.' },
  lo_search_hi_ai: { search: 'Foundational SEO issues to fix first.', ai: 'Citable by AI, but weak classic ranking limits reach.' },
  both_low: { search: 'Foundational issues — fix indexability and structure first.', ai: 'Foundational issues — add structure, schema, and answer blocks.' },
  both_high: { search: 'Strong classic SEO; pursue depth and authority.', ai: 'Strong AI visibility; keep content fresh and original.' },
  mixed: { search: 'Mixed — see the prioritized actions.', ai: 'Mixed — see the prioritized actions.' },
  unscored: { search: 'Unscored — no scored findings in an active Search category.', ai: 'Unscored — no scored findings in an active AI category.' },
});

const STATUS_FACTOR = { pass: 1, warn: 0.5, fail: 0 };
const EXCLUDED = new Set(['needs_api', 'manual_review', 'not_applicable']);

// 'M7b' -> 'M7', 'M21' -> 'M21', 'M3' -> 'M3'
const parentModule = (m) => String(m || '').replace(/[a-z]$/, '');
const round1 = (v) => +Number(v).toFixed(1);

/** "a, b and 3 more" — used by the coverage warning. */
function nameList(names, max = 4) {
  if (!names.length) return '(none)';
  return names.length <= max ? names.join(', ') : names.slice(0, max).join(', ') + ' and ' + (names.length - max) + ' more';
}

/**
 * How much of an axis was actually measured: the share (%) of its ALWAYS-ON weight that carried a
 * scored finding. Conditional categories are left out of the denominator because their weight only
 * exists when the vertical is declared, and the always-on block sums to 100 on both axes — so
 * `pct` reads directly as "percent of this axis we looked at".
 * @returns {{pct:number, measured:number, total:number, missing:string[]}}
 */
export function coverageOf(cats) {
  const alwaysOn = (cats || []).filter((c) => c && !c.conditional && c.weight > 0);
  const total = alwaysOn.reduce((s, c) => s + c.weight, 0);
  const measured = alwaysOn.filter((c) => c.active).reduce((s, c) => s + c.weight, 0);
  return { pct: total > 0 ? round1(100 * measured / total) : 0, measured, total, missing: alwaysOn.filter((c) => !c.active).map((c) => c.name) };
}

const coverageWarning = (cov, axis) => 'coverage ' + cov.pct + '%: only ' + cov.measured + ' of ' + cov.total
  + ' always-on weight on the ' + axis + ' axis carried a scored finding, so the band is provisional — unmeasured: ' + nameList(cov.missing);

function axisMatches(finding, axis) {
  const a = finding && finding.expected_impact && finding.expected_impact.axis;
  return a === axis || a === 'both';
}

function categoryValue(findings) {
  let num = 0, den = 0, scored = 0, needsApi = 0, manualReview = 0;
  for (const f of findings) {
    const status = f.status;
    if (status === 'needs_api') { needsApi++; continue; }
    if (status === 'manual_review') { manualReview++; continue; }
    if (status === 'not_applicable') continue;
    const sev = Number(f.severity) || 0;
    const factor = STATUS_FACTOR[status];
    if (factor === undefined || sev <= 0) continue; // severity 0 = informational, never scored
    num += factor * sev;
    den += sev;
    scored++;
  }
  return { value: den > 0 ? round1(100 * num / den) : null, scored, needsApi, manualReview };
}

/* ------------------------------------------------------------------ options / activation */

function parseBool(v) {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    if (/^(true|yes|1|on)$/i.test(v)) return true;
    if (/^(false|no|0|off)$/i.test(v)) return false;
  }
  return undefined;
}

/**
 * Accepts the seo-vertical-detect output (string or {primary, also[], multilingual, locales}), a
 * profile.json-like wrapper ({vertical, multilingual, environment:{kind}}), and returns
 * { verticals: string[], multilingual: boolean|undefined, environment: string|undefined, unknown: string[] }.
 */
export function normalizeVerticalInput(input) {
  const out = { verticals: [], multilingual: undefined, environment: undefined, unknown: [] };
  if (input === undefined || input === null) return out;
  let v = input;
  if (typeof v === 'object' && !Array.isArray(v) && 'vertical' in v) {
    if (v.environment && typeof v.environment === 'object' && typeof v.environment.kind === 'string') out.environment = v.environment.kind;
    else if (typeof v.environment === 'string') out.environment = v.environment;
    if (v.multilingual !== undefined) out.multilingual = parseBool(v.multilingual);
    v = v.vertical;
  }
  const push = (s) => {
    if (typeof s !== 'string' || !s.trim()) return;
    for (const part of s.split(',')) {
      const id = part.trim().toLowerCase();
      if (!id) continue;
      if (VERTICALS.includes(id)) { if (!out.verticals.includes(id)) out.verticals.push(id); } else out.unknown.push(id);
    }
  };
  if (typeof v === 'string') push(v);
  else if (Array.isArray(v)) v.forEach(push);
  else if (v && typeof v === 'object') {
    push(v.primary);
    if (Array.isArray(v.also)) v.also.forEach(push);
    if (v.multilingual !== undefined) out.multilingual = parseBool(v.multilingual);
    if (out.environment === undefined) {
      if (v.environment && typeof v.environment === 'object' && typeof v.environment.kind === 'string') out.environment = v.environment.kind;
      else if (typeof v.environment === 'string') out.environment = v.environment;
    }
  }
  return out;
}

function normalizeOpts(opts = {}) {
  const warnings = [];
  const fromJson = normalizeVerticalInput(opts.verticalJson);
  const fromFlag = normalizeVerticalInput(opts.vertical);
  const declared = opts.vertical !== undefined || opts.multilingual !== undefined || opts.verticalJson !== undefined;
  const verticals = [...new Set([...fromJson.verticals, ...fromFlag.verticals])];
  for (const u of [...fromJson.unknown, ...fromFlag.unknown]) warnings.push('unknown vertical "' + u + '" ignored (known: ' + VERTICALS.join(', ') + ')');
  let multilingual = fromJson.multilingual;
  if (opts.multilingual !== undefined) multilingual = parseBool(opts.multilingual);
  if (declared && multilingual === undefined) multilingual = false;
  let environment = typeof opts.environment === 'string' ? opts.environment.toLowerCase() : (fromJson.environment || 'production');
  if (!ENVIRONMENTS.includes(environment)) { warnings.push('unknown environment "' + environment + '"; assuming production'); environment = 'production'; }
  const conditions = declared
    ? { 'vertical:ecommerce': verticals.includes('ecommerce'), 'vertical:local-business': verticals.includes('local-business'), 'flag:multilingual': !!multilingual }
    : { 'vertical:ecommerce': undefined, 'vertical:local-business': undefined, 'flag:multilingual': undefined };
  return {
    declared, verticals, multilingual, environment, conditions, warnings,
    validate: opts.validate !== false,
  };
}

/* ------------------------------------------------------------------ one axis */

function computeAxis(categories, entries, axis, ctx) {
  const inAxis = entries.filter((e) => axisMatches(e.f, axis));
  const known = new Set();
  for (const c of categories) for (const m of c.modules) known.add(m);
  const unmapped = [];
  for (const e of inAxis) {
    const pm = parentModule(e.f.module);
    if (!known.has(pm)) unmapped.push({ index: e.i, id: e.f.id, module: e.f.module, axis });
  }

  const cats = [];
  const ignored = [];
  const inferred = [];
  const warnings = [];
  const catFindings = [];
  for (const c of categories) {
    const fs = inAxis.filter((e) => c.modules.includes(parentModule(e.f.module))).map((e) => e.f);
    const { value, scored, needsApi, manualReview } = categoryValue(fs);
    let conditionMet = true, label = 'always';
    if (c.conditional) {
      const cond = ctx.conditions[c.activation];
      if (cond === undefined) { // legacy inference: active when it has scored findings
        conditionMet = scored > 0;
        if (scored > 0) {
          inferred.push(c.name);
          warnings.push('category "' + c.name + '" (' + c.modules.join(',') + ') activated by inference from its findings; pass --vertical/--multilingual or --vertical-json to declare the vertical explicitly');
        }
      } else {
        conditionMet = cond;
        if (cond && scored === 0) warnings.push('category "' + c.name + '" is declared active (' + c.activation + ') but has no scored ' + c.modules.join('/') + ' findings on the ' + axis + ' axis');
        if (!cond && fs.length) for (const f of fs) ignored.push({ id: f.id, module: f.module, category: c.name, axis, reason: c.activation + ' not declared' });
      }
      label = conditionMet ? c.activation : 'inactive';
    }
    const active = conditionMet && scored > 0;
    cats.push({
      name: c.name, weight: c.weight, value: value == null ? 0 : value, active,
      modules: c.modules.slice(), active_weight: 0, activation: label, conditional: !!c.conditional,
      scored, needs_api: conditionMet ? needsApi : 0, manual_review: conditionMet ? manualReview : 0,
    });
    catFindings.push({ cat: c, fs, conditionMet, active });
  }

  const activeCats = cats.filter((c) => c.active && c.weight > 0);
  const totalW = activeCats.reduce((s, c) => s + c.weight, 0);
  for (const c of activeCats) c.active_weight = round1(100 * c.weight / totalW);
  const rawValue = totalW > 0 ? round1(activeCats.reduce((s, c) => s + c.value * c.weight, 0) / totalW) : null;

  // Severity gating: sev-5 established FAIL inside an active, weighted category caps the axis at CAP_VALUE.
  const capReasons = [], suppressed = [];
  catFindings.forEach(({ cat, fs, active }, idx) => {
    if (!active || cat.weight <= 0) return;
    for (const f of fs) {
      if (Number(f.severity) !== 5 || f.status !== 'fail') continue;
      const confidence = f.expected_impact && f.expected_impact.confidence;
      if (confidence !== 'established') continue;
      const reason = { id: f.id, module: f.module, category: cats[idx].name, severity: 5, status: 'fail', confidence, scope: f.scope };
      if (ctx.environment !== 'production' && ENV_SUPPRESSED_CAP_PATTERNS.some((re) => re.test(f.id))) {
        suppressed.push({ ...reason, environment: ctx.environment, reason: 'expected on a non-production host' });
        warnings.push('cap from ' + f.id + ' suppressed: noindex/robots blocking is expected on a ' + ctx.environment + ' host (environment=' + ctx.environment + ')');
      } else capReasons.push(reason);
    }
  });

  let value = rawValue, state = totalW > 0 ? 'scored' : 'unscored', capped = false;
  if (capReasons.length && rawValue !== null) { value = Math.min(rawValue, CAP_VALUE); capped = true; state = 'capped'; }

  // Coverage floor: the value and the band are kept exactly as computed, but an axis built from a
  // sliver of its weight says so instead of reading as a confident grade.
  const coverage = coverageOf(cats);
  const provisional = state !== 'unscored' && coverage.pct < COVERAGE_FLOOR;
  if (provisional) {
    warnings.push(coverageWarning(coverage, axis));
    if (state === 'scored') state = 'partial';
  }

  const scoredTotal = catFindings.reduce((s, x, idx) => s + (x.conditionMet && cats[idx].weight > 0 ? cats[idx].scored : 0), 0);
  const score = {
    value,
    band: bandOf(value),
    capped,
    needs_api_count: cats.reduce((s, c) => s + c.needs_api, 0),
    raw_value: rawValue,
    state,
    cap_reasons: capReasons,
    suppressed_caps: suppressed,
    manual_review_count: cats.reduce((s, c) => s + c.manual_review, 0),
    unscored_count: inAxis.length - scoredTotal,
    dropped_count: 0,
    coverage: coverage.pct,
    coverage_weight: coverage.measured,
    coverage_total: coverage.total,
    provisional,
    warnings,
    categories: cats,
  };
  return { score, unmapped, ignored, inferred };
}

/**
 * Score one axis. Legacy signature (categories, findings, axis); `ctx` is optional
 * ({ conditions, environment } from normalizeOpts). Findings are NOT validated here.
 */
export function computeScore(categories, findings, axis, ctx) {
  const entries = (Array.isArray(findings) ? findings : []).map((f, i) => ({ f, i }));
  const c = ctx || normalizeOpts({});
  return computeAxis(categories, entries, axis, c).score;
}

/* ------------------------------------------------------------------ interpretation */

const level = (s) => (s == null || s.value === null || s.value === undefined) ? 'unscored' : s.value >= 75 ? 'hi' : s.value < 60 ? 'lo' : 'mid';

/** One-line interpretations for the pair. Returns { search, ai }. */
export function interpret(search, ai) {
  const S = level(search), A = level(ai);
  const T = INTERPRETATIONS;
  if (S === 'unscored' || A === 'unscored') {
    const solo = (lvl, axis) => lvl === 'unscored' ? T.unscored[axis] : lvl === 'hi' ? T.both_high[axis] : lvl === 'lo' ? T.both_low[axis] : T.mixed[axis];
    return { search: solo(S, 'search'), ai: solo(A, 'ai') };
  }
  if (S === 'hi' && A === 'lo') return { ...T.hi_search_lo_ai };
  if (S === 'lo' && A === 'hi') return { ...T.lo_search_hi_ai };
  if (S === 'lo' && A === 'lo') return { ...T.both_low };
  if (S === 'hi' && A === 'hi') return { ...T.both_high };
  return { ...T.mixed };
}

/* ------------------------------------------------------------------ public API */

/**
 * Score an already-parsed findings array (or { findings: [...] }). Pure; no I/O.
 * opts: { vertical: 'ecommerce,local-business' | string[] | detect-object, multilingual: boolean,
 *         verticalJson: parsed seo-vertical-detect / profile output, environment: 'production'|'preview'|'staging'|'local',
 *         validate: true }
 */
export function scoreFindings(parsed, opts = {}) {
  const list = Array.isArray(parsed) ? parsed : ((parsed && Array.isArray(parsed.findings)) ? parsed.findings : []);
  const o = normalizeOpts(opts);
  let dropped = [];
  if (o.validate) ({ dropped } = validateFindings(list));
  const droppedIdx = new Set(dropped.map((d) => d.index));
  const entries = list.map((f, i) => ({ f, i })).filter((e) => !droppedIdx.has(e.i));

  const s = computeAxis(SEARCH, entries, 'search', o);
  const a = computeAxis(AI, entries, 'ai', o);
  const texts = interpret(s.score, a.score);
  s.score.dropped_count = dropped.length;
  a.score.dropped_count = dropped.length;
  s.score.interpretation = texts.search;
  a.score.interpretation = texts.ai;

  const inferred = [...new Set([...s.inferred, ...a.inferred])];
  const warnings = [...o.warnings];
  if (dropped.length) warnings.push(dropped.length + ' finding(s) failed schema validation and were dropped (see dropped_findings)');
  const unmapped = [...s.unmapped, ...a.unmapped];
  if (unmapped.length) warnings.push(unmapped.length + ' finding(s) reference a module with no category on their axis and were not scored (see unmapped_findings)');

  return {
    findings_count: list.length,
    search_seo: s.score,
    ai_visibility: a.score,
    dropped_count: dropped.length,
    dropped_findings: dropped,
    unmapped_findings: unmapped,
    ignored_conditional: [...s.ignored, ...a.ignored],
    activation: {
      source: o.declared ? 'declared' : (inferred.length ? 'inferred' : 'none'),
      vertical: { primary: o.verticals[0] || null, also: o.verticals.slice(1), multilingual: o.multilingual === undefined ? null : o.multilingual },
      environment: o.environment,
      inferred_categories: inferred,
    },
    warnings,
  };
}

/* ------------------------------------------------------------------ site rollup */

function normalizeUrl(u) {
  if (typeof u !== 'string' || !u) return '';
  try {
    const x = new URL(u);
    x.hash = '';
    let path = x.pathname.replace(/\/+$/, '') || '/';
    return x.protocol + '//' + x.host.toLowerCase() + path + x.search;
  } catch { return u.replace(/#.*$/, '').replace(/\/+$/, '') || '/'; }
}

const STATUS_RANK = { fail: 3, warn: 2, pass: 1 };
function worse(a, b) {
  const ra = STATUS_RANK[a.status] || 0, rb = STATUS_RANK[b.status] || 0;
  if (ra !== rb) return ra > rb ? a : b;
  return (Number(a.severity) || 0) >= (Number(b.severity) || 0) ? a : b;
}

function dedupeFindings(items) {
  const map = new Map();
  for (const it of items) {
    const f = it.f, loc = f.location || {};
    const key = [f.id, f.scope, loc.url || '', loc.file || '', loc.resource || '', loc.selector || '', it.page || ''].join('|');
    const prev = map.get(key);
    if (!prev) map.set(key, it);
    else if (worse(f, prev.f) === f) map.set(key, it);
  }
  return [...map.values()];
}

function pageWeight(page, seenTemplates) {
  if (typeof page.weight === 'number' && page.weight > 0) return { weight: page.weight, source: 'manifest', role: page.role || null };
  const role = String(page.role || '').toLowerCase();
  if (role === 'homepage' || role === 'home') return { weight: ROLE_WEIGHTS.homepage, source: 'role', role: 'homepage' };
  if (role === 'target') return { weight: ROLE_WEIGHTS.target, source: 'role', role: 'target' };
  if (page.template && !seenTemplates.has(page.template)) { seenTemplates.add(page.template); return { weight: ROLE_WEIGHTS['template-sample'], source: 'role', role: 'template-sample' }; }
  return { weight: ROLE_WEIGHTS['long-tail'], source: 'role', role: 'long-tail' };
}

function pickScore(s) {
  return { value: s.value, raw_value: s.raw_value, band: s.band, state: s.state, capped: s.capped };
}

/**
 * Roll per-page scores up to a site score. `manifest` is a crawl.json ({ pages:[{url, slug?, role?,
 * template?, weight?}], templates?, findings? }); findings come from opts.findings (array or
 * { findings }) or manifest.findings. A finding is attached to a page via location.url,
 * location.file (matched against page.snapshot/slug) or a non-schema `page` hint (url or slug —
 * stripped before validation). Site-scoped findings are deduplicated and scored once per page set
 * (they enter every page's score exactly once); template-scoped findings apply to every page of
 * that template. Rollup = Σ w_page × value / Σ w_page with role weights (or manifest weights).
 */
export function scoreSite(manifest, opts = {}) {
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  const pagesIn = Array.isArray(m.pages) ? m.pages : [];
  const raw = opts.findings !== undefined ? opts.findings : m.findings;
  const list = Array.isArray(raw) ? raw : ((raw && Array.isArray(raw.findings)) ? raw.findings : []);
  const o = normalizeOpts(opts);
  const warnings = [...o.warnings];

  // Strip the non-schema `page` hint before validation.
  const hinted = list.map((f) => {
    if (f && typeof f === 'object' && !Array.isArray(f) && 'page' in f) { const { page, ...rest } = f; return { f: rest, page: typeof page === 'string' ? page : undefined }; }
    return { f, page: undefined };
  });
  const { dropped } = validateFindings(hinted.map((h) => h.f));
  const droppedIdx = new Set(dropped.map((d) => d.index));
  const items = dedupeFindings(hinted.map((h, i) => ({ ...h, i })).filter((h) => !droppedIdx.has(h.i)));
  if (dropped.length) warnings.push(dropped.length + ' finding(s) failed schema validation and were dropped (see dropped_findings)');

  // Index pages.
  const byUrl = new Map(), byKey = new Map();
  const seenTemplates = new Set();
  const pages = pagesIn.filter((p) => p && typeof p.url === 'string').map((p) => {
    const w = pageWeight(p, seenTemplates);
    const rec = { url: p.url, slug: p.slug || null, role: w.role, template: p.template || null, weight: w.weight, weight_source: w.source, _own: [] };
    byUrl.set(normalizeUrl(p.url), rec);
    for (const k of [p.slug, p.snapshot, p.file]) if (typeof k === 'string' && k) byKey.set(k, rec);
    return rec;
  });
  if (!pages.length) warnings.push('manifest has no pages; the rollup is empty');

  const site = [], byTemplate = new Map();
  let unassigned = 0;
  for (const it of items) {
    const f = it.f;
    if (f.scope === 'site') { site.push(f); continue; }
    const loc = f.location || {};
    let page = null;
    for (const hint of [it.page, loc.url, loc.file]) {
      if (!hint) continue;
      page = byUrl.get(normalizeUrl(hint)) || byKey.get(hint) || null;
      if (page) break;
    }
    if (!page) { unassigned++; site.push(f); continue; }
    if (f.scope === 'template' && page.template) {
      if (!byTemplate.has(page.template)) byTemplate.set(page.template, []);
      byTemplate.get(page.template).push(f);
    } else page._own.push(f);
  }
  if (unassigned) warnings.push(unassigned + ' page/template-scoped finding(s) could not be matched to a manifest page and were treated as site-wide');

  const scoreOpts = { ...opts, validate: false };
  const scoredPages = pages.map((p) => {
    const fs = [...site, ...(p.template && byTemplate.get(p.template) ? byTemplate.get(p.template) : []), ...p._own];
    const r = scoreFindings(fs, scoreOpts);
    return { url: p.url, slug: p.slug, role: p.role, template: p.template, weight: p.weight, weight_source: p.weight_source, findings_count: fs.length, search: pickScore(r.search_seo), ai: pickScore(r.ai_visibility), _full: r };
  });

  // Flat pass over the deduplicated set: activation context, counts and category metadata.
  const flat = scoreFindings(items.map((it) => it.f), scoreOpts);

  const rollupAxis = (axisKey, pageKey, table) => {
    const flatAxis = flat[axisKey];
    const scored = scoredPages.filter((p) => p[pageKey].value !== null);
    const W = scored.reduce((s, p) => s + p.weight, 0);
    const value = W > 0 ? round1(scored.reduce((s, p) => s + p.weight * p[pageKey].value, 0) / W) : null;
    const rawValue = W > 0 ? round1(scored.reduce((s, p) => s + p.weight * p[pageKey].raw_value, 0) / W) : null;
    const cappedPages = scored.filter((p) => p[pageKey].capped);
    const capped = scored.length > 0 && cappedPages.length === scored.length;
    const capReasons = [];
    const seen = new Set();
    for (const p of cappedPages) for (const r of p._full[axisKey].cap_reasons) { const k = r.id + '|' + (r.scope || ''); if (!seen.has(k)) { seen.add(k); capReasons.push(r); } }
    const categories = table.map((c, idx) => {
      const fc = flatAxis.categories[idx];
      const activePages = scored.filter((p) => p._full[axisKey].categories[idx].active);
      const Wc = activePages.reduce((s, p) => s + p.weight, 0);
      const v = Wc > 0 ? round1(activePages.reduce((s, p) => s + p.weight * p._full[axisKey].categories[idx].value, 0) / Wc) : 0;
      const aw = Wc > 0 ? round1(activePages.reduce((s, p) => s + p.weight * p._full[axisKey].categories[idx].active_weight, 0) / Wc) : 0;
      return { ...fc, value: v, active: activePages.length > 0, active_weight: aw };
    });
    const axisName = axisKey === 'search_seo' ? 'search' : 'ai';
    const coverage = coverageOf(categories);
    const provisional = value !== null && coverage.pct < COVERAGE_FLOOR;
    const axisWarnings = [...flatAxis.warnings];
    if (cappedPages.length && !capped) axisWarnings.push(cappedPages.length + ' of ' + scored.length + ' scored pages are capped on the ' + axisName + ' axis (see pages[])');
    if (provisional && !axisWarnings.some((w) => w.startsWith('coverage '))) axisWarnings.push(coverageWarning(coverage, axisName));
    return {
      value, band: bandOf(value), capped,
      needs_api_count: flatAxis.needs_api_count,
      raw_value: rawValue,
      state: value === null ? 'unscored' : capped ? 'capped' : provisional ? 'partial' : 'scored',
      cap_reasons: capped ? capReasons : [],
      suppressed_caps: flatAxis.suppressed_caps,
      manual_review_count: flatAxis.manual_review_count,
      unscored_count: flatAxis.unscored_count,
      dropped_count: dropped.length,
      coverage: coverage.pct,
      coverage_weight: coverage.measured,
      coverage_total: coverage.total,
      provisional,
      warnings: axisWarnings,
      categories,
    };
  };

  const search = rollupAxis('search_seo', 'search', SEARCH);
  const ai = rollupAxis('ai_visibility', 'ai', AI);
  const texts = interpret(search, ai);
  search.interpretation = texts.search;
  ai.interpretation = texts.ai;

  const worst = (key) => scoredPages.filter((p) => p[key].value !== null).sort((a, b) => a[key].value - b[key].value).slice(0, 3)
    .map((p) => ({ url: p.url, value: p[key].value, band: p[key].band }));

  return {
    findings_count: list.length,
    pages_count: scoredPages.length,
    method: 'role_weights',
    weights: { ...ROLE_WEIGHTS },
    search_seo: search,
    ai_visibility: ai,
    pages: scoredPages.map(({ _full, ...p }) => p),
    worst_pages: { search: worst('search'), ai: worst('ai') },
    dropped_count: dropped.length,
    dropped_findings: dropped,
    unmapped_findings: flat.unmapped_findings,
    ignored_conditional: flat.ignored_conditional,
    activation: flat.activation,
    unassigned_count: unassigned,
    warnings: [...warnings, ...flat.warnings.filter((w) => !warnings.includes(w))],
  };
}

/* ------------------------------------------------------------------ CLI */

const HINT = 'pass --findings <file.json>, --run <run-dir>, or pipe JSON on stdin';

function readJsonFile(path, what) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) { return { error: 'could not read ' + what + ': ' + String(e && e.message || e) }; }
  try { return { value: JSON.parse(raw) }; }
  catch (e) { return { error: 'invalid JSON in ' + what + ' (' + path + '): ' + String(e && e.message || e) }; }
}

export async function main(args) {
  const usage = (error, extra) => ({ result: { error, hint: HINT, ...(extra || {}) }, code: EXIT.USAGE });

  // --- flags
  const opts = {};
  if (args.environment !== undefined) {
    if (typeof args.environment !== 'string' || !ENVIRONMENTS.includes(args.environment.toLowerCase())) return usage('--environment must be one of ' + ENVIRONMENTS.join('|'));
    opts.environment = args.environment.toLowerCase();
  }
  if (args.vertical !== undefined) {
    if (args.vertical === true) return usage('--vertical needs a comma-separated list (' + VERTICALS.join(', ') + ')');
    const v = normalizeVerticalInput(args.vertical);
    if (v.unknown.length) return usage('unknown vertical(s): ' + v.unknown.join(', ') + ' (known: ' + VERTICALS.join(', ') + ')');
    opts.vertical = v.verticals;
  }
  if (args.multilingual !== undefined) {
    const b = parseBool(args.multilingual);
    if (b === undefined) return usage('--multilingual takes no value (or true|false)');
    opts.multilingual = b;
  }
  if (args['vertical-json'] !== undefined) {
    if (typeof args['vertical-json'] !== 'string') return usage('--vertical-json needs a file path');
    const r = readJsonFile(args['vertical-json'], 'vertical json');
    if (r.error) return usage(r.error);
    opts.verticalJson = r.value;
  }

  // --- run dir / manifest (a manifest that carries its own findings needs no other input)
  let runDir = null;
  if (args.run !== undefined) {
    if (typeof args.run !== 'string') return usage('--run needs a run directory');
    runDir = args.run;
  }
  let manifest = null;
  if (args.manifest !== undefined) {
    let path = args.manifest;
    if (path === true) {
      if (!runDir) return usage('--manifest needs a crawl.json path (or --run <dir> containing crawl.json)');
      path = join(runDir, 'crawl.json');
    }
    if (typeof path !== 'string') return usage('--manifest needs a crawl.json path');
    if (!existsSync(path)) return usage('manifest not found: ' + path);
    const r = readJsonFile(path, 'manifest');
    if (r.error) return usage(r.error);
    manifest = r.value;
  }
  const manifestFindings = manifest && Array.isArray(manifest.findings) ? manifest.findings : null;

  // --- findings input: --run > --findings > stdin > manifest.findings
  let parsed;
  if (runDir) {
    let path = runDir;
    try { if (statSync(runDir).isDirectory()) path = join(runDir, 'findings.json'); } catch { /* reported by readJsonFile */ }
    const r = readJsonFile(path, 'findings');
    if (r.error) return usage(r.error);
    parsed = r.value;
  } else if (args.findings !== undefined) {
    if (typeof args.findings !== 'string') return usage('--findings needs a file path');
    const r = readJsonFile(args.findings, 'findings');
    if (r.error) return usage(r.error.replace(/^invalid JSON in findings \([^)]*\): /, 'invalid JSON: '));
    parsed = r.value;
  } else if (manifestFindings && process.stdin.isTTY) {
    parsed = manifestFindings;
  } else {
    if (process.stdin.isTTY) return usage('no findings input');
    let raw;
    try { raw = readFileSync(0, 'utf8'); }
    catch (e) { return usage('could not read findings: ' + String(e && e.message || e)); }
    if (!raw.trim()) {
      if (!manifestFindings) return usage('no findings input (empty stdin)');
      parsed = manifestFindings;
    } else {
      try { parsed = JSON.parse(raw); }
      catch (e) { return { result: { error: 'invalid JSON: ' + String(e && e.message || e) }, code: EXIT.USAGE }; }
    }
  }
  if (!Array.isArray(parsed) && !(parsed && typeof parsed === 'object' && Array.isArray(parsed.findings))) {
    return usage('findings input must be a JSON array or { "findings": [...] }');
  }

  // --- validate-only
  if (args['validate-only']) {
    const list = Array.isArray(parsed) ? parsed : parsed.findings;
    const { valid, dropped } = validateFindings(list);
    const result = { findings_count: list.length, valid_count: valid.length, dropped_count: dropped.length, dropped_findings: dropped, ok: dropped.length === 0 };
    return { result, code: args.strict && dropped.length ? EXIT.RUNTIME : EXIT.OK };
  }

  const result = manifest ? scoreSite(manifest, { ...opts, findings: parsed }) : scoreFindings(parsed, opts);
  const code = args.strict && result.dropped_count > 0 ? EXIT.RUNTIME : EXIT.OK;
  return { result, code };
}

if (isMain(import.meta.url)) runCli(main);

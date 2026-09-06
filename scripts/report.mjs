#!/usr/bin/env node
// Merge the findings of one run, score them, and render the report.
//
// Usage:
//   node report.mjs <run-dir> [--merge "agents/*.json"] [--lang en|es] [--out-md <path>]
//                   [--environment production|preview|staging|local] [--vertical ecommerce,docs]
//
// Reads   <run>/findings.deterministic.json  (the checks-registry pass written by audit.mjs)
//         every --merge glob (repeatable; the agent arrays saved by the orchestrator)
//         <run>/crawl.json, <run>/profile.json, <run>/site/*.json, <run>/probes/*.json,
//         <run>/checks.json (stats of the deterministic pass, when audit.mjs wrote one)
// Writes  <run>/findings.json  merged, schema-validated, deduplicated findings
//         <run>/report.json    conforming to schema/audit-report.schema.json
//         <run>/report.md      the human report (EN/ES)
//
// Merge rules: every finding is validated against schema/finding.schema.json (invalid ones are
// dropped and listed in report.dropped_findings, never silently ignored); duplicates of the same
// id at the same location keep the most severe status (fail > warn > pass) and, on a tie, the
// higher severity. `needs_api` and `manual_review` never override a scored status — an agent that
// could not decide must not erase a check that did.
//
// Exit codes: 0 ok · 1 usage (no run dir, bad flag, nothing to report) · 2 the assembled report
// failed its own schema (nothing is written) or a file could not be written.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { EXIT, isMain, runCli } from './lib/util.mjs';
import { pluginVersion, readJson, writeJson, writeText } from './lib/store.mjs';
import { FINDING_SCHEMA, PLUGIN_ROOT, validateFinding } from './lib/validate-finding.mjs';
import { formatErrors, validate } from './lib/schema-lite.mjs';
import { AI, ENVIRONMENTS, SEARCH, VERTICALS, isScorablePage, message, normalizeLang, scoreFindings, scoreSite } from './score.mjs';
import { knownIds } from './checks/index.mjs';

/** How many prioritized actions the markdown report lists. */
export const TOP_ACTIONS = 15;
/** Impact/effort proxies for the action ranking: severity x magnitude / effort. */
export const MAGNITUDE_WEIGHT = Object.freeze({ high: 3, medium: 2, low: 1 });
export const EFFORT_WEIGHT = Object.freeze({ auto: 1, proposed: 2, advisory: 3 });
/** Merge precedence. pass (3) outranks needs_api (2): an undecided agent never overrides a check. */
export const STATUS_RANK = Object.freeze({ fail: 5, warn: 4, pass: 3, needs_api: 2, manual_review: 1, not_applicable: 0 });
export const LANGS = Object.freeze(['en', 'es']);

export const REPORT_SCHEMA_PATH = resolve(PLUGIN_ROOT, 'schema', 'audit-report.schema.json');
/** The parsed report schema (read once at import). */
export const REPORT_SCHEMA = JSON.parse(readFileSync(REPORT_SCHEMA_PATH, 'utf8'));
const SCHEMA_REFS = { [FINDING_SCHEMA.$id]: FINDING_SCHEMA, 'finding.schema.json': FINDING_SCHEMA };

const msg = (e) => String((e && e.message) || e);
const uniq = (list) => [...new Set(list)];
const round2 = (n) => Math.round(n * 100) / 100;

/** Sort module ids numerically (M2 before M11) instead of lexicographically. */
export function compareModules(a, b) {
  const na = Number(String(a).replace(/^M/, '').replace(/[a-z]$/, '')) || 0;
  const nb = Number(String(b).replace(/^M/, '').replace(/[a-z]$/, '')) || 0;
  return na - nb || String(a).localeCompare(String(b));
}

const parentModule = (m) => String(m || '').replace(/[a-z]$/, '');

/** Every module the two scoring tables know about (M1..M22, in numeric order). */
export const SCORED_MODULES = Object.freeze(uniq([...SEARCH, ...AI].flatMap((c) => c.modules)).sort(compareModules));

/** Modules the deterministic registry can emit at all (derived from the registry, never hard-coded). */
export function deterministicModules() {
  return new Set(knownIds().map((id) => parentModule(String(id).split('.')[0])));
}

/* ------------------------------------------------------------------ inputs */

/** Validate the assembled report against schema/audit-report.schema.json. */
export function validateReport(report) {
  const r = validate(REPORT_SCHEMA, report, { refs: SCHEMA_REFS });
  return { ok: r.ok, errors: formatErrors(r.errors) };
}

function globToRe(pattern) {
  let out = '';
  for (const ch of pattern) {
    if (ch === '*') out += '[^/\\\\]*';
    else if (ch === '?') out += '[^/\\\\]';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$');
}

/**
 * Expand one --merge pattern relative to the run directory. Only the file name may carry a
 * wildcard (`agents/*.json`); a plain directory expands to its *.json files.
 * @returns {{files: string[], error: string|null}}
 */
export function expandGlob(pattern, runDir) {
  const raw = String(pattern == null ? '' : pattern).trim();
  if (!raw) return { files: [], error: 'empty --merge pattern' };
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(runDir, raw);
  const norm = abs.split('\\').join('/');
  const parts = norm.split('/');
  const last = parts[parts.length - 1];
  const head = parts.slice(0, -1).join('/') || '/';
  if (/[*?]/.test(head)) return { files: [], error: 'only the file name may contain a wildcard: ' + raw };
  if (!/[*?]/.test(last)) {
    if (!existsSync(abs)) return { files: [], error: 'no such file or directory: ' + raw };
    if (statSync(abs).isDirectory()) {
      return { files: readdirSync(abs).filter((f) => f.endsWith('.json')).sort().map((f) => join(abs, f)), error: null };
    }
    return { files: [abs], error: null };
  }
  if (!existsSync(head) || !statSync(head).isDirectory()) return { files: [], error: 'no such directory: ' + head };
  const re = globToRe(last);
  const files = readdirSync(head).filter((f) => re.test(f)).sort()
    .map((f) => join(head, f))
    .filter((p) => { try { return statSync(p).isFile(); } catch { return false; } });
  return { files, error: null };
}

/** Read a findings array (or `{ findings: [...] }`) from a file. */
export function readFindingArray(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch (e) { return { list: [], error: 'cannot read ' + path + ': ' + msg(e) }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return { list: [], error: 'invalid JSON in ' + path + ': ' + msg(e) }; }
  if (Array.isArray(parsed)) return { list: parsed, error: null };
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.findings)) return { list: parsed.findings, error: null };
  return { list: [], error: path + ' is neither a findings array nor { findings: [...] }' };
}

/** www-insensitive, fragment-free, trailing-slash-free URL key used for the merge. */
export function normalizeUrl(u) {
  if (typeof u !== 'string' || !u) return '';
  try {
    const x = new URL(u);
    x.hash = '';
    const path = x.pathname.replace(/\/+$/, '') || '/';
    return x.protocol + '//' + x.host.toLowerCase().replace(/^www\./, '') + path + x.search;
  } catch { return u.replace(/#.*$/, '').replace(/\/+$/, '') || u; }
}

/** Dedupe key: the finding id plus its normalized location. */
export function findingKey(f, pageHint) {
  const loc = (f && f.location) || {};
  return [
    f && f.id, f && f.scope, normalizeUrl(loc.url || pageHint || ''),
    loc.file || '', loc.resource || '', loc.selector || '', loc.line == null ? '' : loc.line,
  ].join('|');
}

/** True when `a` should replace `b` in the merged set. */
export function outranks(a, b) {
  const ra = STATUS_RANK[a && a.status] || 0;
  const rb = STATUS_RANK[b && b.status] || 0;
  if (ra !== rb) return ra > rb;
  return (Number(a && a.severity) || 0) > (Number(b && b.severity) || 0);
}

/**
 * Warnings the report itself emits, in both shipped languages: the Avisos section must not print
 * Spanish headings over English sentences. Score-level warnings and the interpretation line are
 * translated at their source (score.mjs MESSAGES / INTERPRETATIONS_ES); finding text stays English,
 * because it comes from the checks. Every builder takes one params object so the two cannot drift.
 */
export const REPORT_MESSAGES = Object.freeze({
  en: {
    no_deterministic: (p) => 'no findings.deterministic.json in ' + p.dir + ' — run audit.mjs first for the deterministic pass',
    merge_needs_path: () => '--merge needs a path or glob (e.g. --merge "agents/*.json")',
    merge_error: (p) => '--merge "' + p.pattern + '": ' + p.error,
    merge_no_match: (p) => '--merge "' + p.pattern + '" matched no files',
    file_dropped: (p) => p.label + ': ' + p.count + ' finding(s) failed schema validation and were dropped (see dropped_findings)',
    duplicates_merged: (p) => p.count + ' duplicate finding(s) merged (same id and location; most severe kept)',
    vertical_inferred: (p) => 'vertical inferred from the platform profile hints (' + p.hints + '); pass --vertical to declare it',
    vertical_none: () => 'no vertical was detected or declared; scoring with "generic" (conditional categories stay inactive)',
    multilingual_inferred: (p) => 'multilingual inferred from hreflang annotations on ' + p.count + ' of ' + p.total + ' sampled page(s)',
    unknown_environment: (p) => 'unknown environment "' + p.environment + '"; scoring as production',
    page_not_2xx: (p) => 'the audited page returned HTTP ' + p.status
      + ': the on-page checks skipped it, so these scores rest on site-level findings only and describe no page.',
    checks_dropped: (p) => p.count + ' finding(s) built by the checks pass failed schema validation and were dropped'
      + (p.named ? ' (' + p.named + ')' : '') + ' — see checks.json stats.dropped_findings',
    check_failed: (p) => 'check "' + p.check + '"' + (p.page ? ' on ' + p.page : '') + ' failed: ' + p.message,
    more_check_errors: (p) => 'and ' + p.count + ' more check error(s) — see checks.json',
    no_crawl: () => 'no crawl.json in the run: the sampling table and the site rollup are unavailable',
  },
  es: {
    no_deterministic: (p) => 'no hay findings.deterministic.json en ' + p.dir + ' — ejecuta audit.mjs primero para la pasada determinista',
    merge_needs_path: () => '--merge necesita una ruta o un glob (por ejemplo --merge "agents/*.json")',
    merge_error: (p) => '--merge "' + p.pattern + '": ' + p.error,
    merge_no_match: (p) => '--merge "' + p.pattern + '" no coincidió con ningún archivo',
    file_dropped: (p) => p.label + ': ' + p.count + ' hallazgo(s) no pasaron la validación de esquema y se descartaron (ver dropped_findings)',
    duplicates_merged: (p) => p.count + ' hallazgo(s) duplicados se fusionaron (mismo id y ubicación; se conserva el más severo)',
    vertical_inferred: (p) => 'vertical inferida de las pistas del perfil de plataforma (' + p.hints + '); pasa --vertical para declararla',
    vertical_none: () => 'no se detectó ni se declaró ninguna vertical; se puntúa como "generic" (las categorías condicionales quedan inactivas)',
    multilingual_inferred: (p) => 'multilingüe inferido de las anotaciones hreflang en ' + p.count + ' de ' + p.total + ' página(s) muestreadas',
    unknown_environment: (p) => 'entorno desconocido "' + p.environment + '"; se puntúa como production',
    page_not_2xx: (p) => 'la página auditada devolvió HTTP ' + p.status
      + ': las verificaciones de página la omitieron, así que estas puntuaciones se apoyan solo en hallazgos del sitio y no describen ninguna página.',
    checks_dropped: (p) => p.count + ' hallazgo(s) construidos por la pasada de checks no pasaron la validación de esquema y se descartaron'
      + (p.named ? ' (' + p.named + ')' : '') + ' — ver checks.json stats.dropped_findings',
    check_failed: (p) => 'la verificación "' + p.check + '"' + (p.page ? ' en ' + p.page : '') + ' falló: ' + p.message,
    more_check_errors: (p) => 'y ' + p.count + ' error(es) más de verificaciones — ver checks.json',
    no_crawl: () => 'esta ejecución no tiene crawl.json: la tabla de muestreo y el agregado del sitio no están disponibles',
  },
});

/** Build one report-level warning in `lang`; falls back to the English builder for a missing key. */
export function reportMessage(lang, key, params = {}) {
  const table = REPORT_MESSAGES[normalizeLang(lang)] || REPORT_MESSAGES.en;
  const build = table[key] || REPORT_MESSAGES.en[key];
  return typeof build === 'function' ? build(params) : '';
}

/**
 * Load, validate, dedupe. Findings arrive in source order (deterministic first, then each --merge
 * glob), so a tie between an agent and a check keeps the check.
 * @returns {{entries: object[], dropped: object[], sources: object[], duplicates: number, warnings: string[]}}
 */
export function collectFindings(runDir, opts = {}) {
  const dir = resolve(runDir);
  const lang = normalizeLang(opts.lang);
  const warnings = [];
  const sources = [];
  const files = [];

  const deterministic = join(dir, 'findings.deterministic.json');
  if (existsSync(deterministic)) files.push({ label: 'findings.deterministic.json', path: deterministic, kind: 'deterministic' });
  else warnings.push(reportMessage(lang, 'no_deterministic', { dir }));

  const patterns = [].concat(opts.merge === undefined ? [] : opts.merge).filter((p) => p !== false);
  for (const pattern of patterns) {
    if (pattern === true) { warnings.push(reportMessage(lang, 'merge_needs_path')); continue; }
    const { files: found, error } = expandGlob(pattern, dir);
    if (error) { warnings.push(reportMessage(lang, 'merge_error', { pattern, error })); continue; }
    if (!found.length) { warnings.push(reportMessage(lang, 'merge_no_match', { pattern })); continue; }
    for (const p of found) {
      if (files.some((f) => f.path === p)) continue;
      files.push({ label: basename(p), path: p, kind: 'agent' });
    }
  }

  const entries = [];
  const dropped = [];
  let index = 0;
  for (const file of files) {
    const { list, error } = readFindingArray(file.path);
    if (error) { warnings.push(error); sources.push({ label: file.label, kind: file.kind, total: 0, valid: 0, dropped: 0, error }); continue; }
    let valid = 0, bad = 0;
    for (const item of list) {
      // scoreSite accepts a non-schema `page` hint (a url or slug); strip it before validating.
      let f = item, page;
      if (item && typeof item === 'object' && !Array.isArray(item) && 'page' in item) {
        const { page: hint, ...rest } = item;
        f = rest;
        page = typeof hint === 'string' ? hint : undefined;
      }
      const v = validateFinding(f);
      if (!v.ok) {
        dropped.push({ index, id: f && typeof f.id === 'string' ? f.id : null, errors: v.errors.slice(0, 8) });
        bad++;
      } else {
        entries.push({ f, page, source: file.label, kind: file.kind, index });
        valid++;
      }
      index++;
    }
    sources.push({ label: file.label, kind: file.kind, total: list.length, valid, dropped: bad, error: null });
    if (bad) warnings.push(reportMessage(lang, 'file_dropped', { label: file.label, count: bad }));
  }

  // Dedupe by id + normalized location, most severe wins.
  const byKey = new Map();
  let duplicates = 0;
  for (const entry of entries) {
    const key = findingKey(entry.f, entry.page);
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, entry); continue; }
    duplicates++;
    if (outranks(entry.f, prev.f)) byKey.set(key, entry);
  }
  if (duplicates) warnings.push(reportMessage(lang, 'duplicates_merged', { count: duplicates }));

  return { entries: [...byKey.values()], dropped, sources, duplicates, warnings };
}

/* ------------------------------------------------------------------ context */

/** Vertical for the score: --vertical > profile.vertical > profile.vertical_hints > generic. */
export function resolveVertical(opts = {}, profile = null, crawl = null) {
  const lang = normalizeLang(opts.lang);
  const warnings = [];
  const push = (out, value) => {
    for (const part of String(value == null ? '' : value).split(',')) {
      const id = part.trim().toLowerCase();
      if (!id) continue;
      if (!VERTICALS.includes(id)) { warnings.push(message(lang, 'unknown_vertical', { id, known: VERTICALS.join(', ') })); continue; }
      if (!out.includes(id)) out.push(id);
    }
  };

  let source = 'inferred';
  const ids = [];
  let multilingual;
  let locales;
  let signals;

  if (opts.vertical !== undefined && opts.vertical !== true) {
    source = 'declared';
    [].concat(opts.vertical).forEach((v) => push(ids, v));
  } else if (profile && profile.vertical) {
    const v = profile.vertical;
    source = typeof v === 'object' && typeof v.source === 'string' ? v.source : 'detected';
    if (typeof v === 'string') push(ids, v);
    else {
      push(ids, v.primary);
      [].concat(v.also || []).forEach((x) => push(ids, x));
      if (v.multilingual !== undefined) multilingual = !!v.multilingual;
      if (Array.isArray(v.locales) && v.locales.length) locales = v.locales.slice();
      if (v.signals !== undefined) signals = v.signals;
    }
  } else if (profile && Array.isArray(profile.vertical_hints) && profile.vertical_hints.length) {
    source = 'inferred';
    profile.vertical_hints.forEach((h) => push(ids, h));
    warnings.push(reportMessage(lang, 'vertical_inferred', { hints: profile.vertical_hints.join(', ') }));
  }

  if (!ids.length) {
    ids.push('generic');
    if (source !== 'declared') warnings.push(reportMessage(lang, 'vertical_none'));
  }

  if (multilingual === undefined && crawl && Array.isArray(crawl.pages)) {
    const withHreflang = crawl.pages.filter((p) => Number(p.hreflang_count) > 0).length;
    if (withHreflang > 0) {
      multilingual = true;
      warnings.push(reportMessage(lang, 'multilingual_inferred', { count: withHreflang, total: crawl.pages.length }));
    } else multilingual = false;
  }

  const vertical = { primary: ids[0], also: ids.slice(1), source };
  if (multilingual !== undefined) vertical.multilingual = !!multilingual;
  if (locales) vertical.locales = locales;
  if (signals !== undefined) vertical.signals = signals;
  return { vertical, warnings };
}

/** Probe files a run may carry (never scored). Keyed by what the file says it is. */
export function readProbes(runDir) {
  const dir = join(resolve(runDir), 'probes');
  if (!existsSync(dir)) return null;
  const out = {};
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const doc = readJson(join(dir, name), null);
    if (!doc || typeof doc !== 'object') continue;
    let key = basename(name, '.json').replace(/[-\s]+/g, '_');
    if (doc.kind === 'web_search_presence_proxy') key = 'web_search';
    else if (doc.source === 'manual_import') key = 'gsc_generative_ai';
    out[key] = doc;
  }
  return Object.keys(out).length ? out : null;
}

function siteSummary(artifacts, crawl) {
  const out = {};
  const robots = artifacts.robots;
  if (robots) {
    out.robots = {
      status: robots.status == null ? null : robots.status,
      mode: robots.mode || null,
      crawl_delay_s: robots.crawl_delay ? robots.crawl_delay['*'] : null,
      sitemaps_declared: Array.isArray(robots.sitemaps_declared) ? robots.sitemaps_declared.length : null,
      content_signals: robots.content_signals ? !!robots.content_signals.present : null,
    };
  } else if (crawl && crawl.robots) {
    out.robots = { status: crawl.robots.status, mode: crawl.robots.mode, crawl_delay_s: crawl.robots.crawl_delay_s, sitemaps_declared: null, content_signals: null };
  }
  const sm = artifacts.sitemaps;
  if (sm) out.sitemaps = { files: Array.isArray(sm.files) ? sm.files.length : null, urls: sm.url_count == null ? null : sm.url_count, errors_total: sm.errors_total == null ? null : sm.errors_total, probe_misses: sm.probe_misses == null ? null : sm.probe_misses };
  else if (crawl && crawl.sitemaps) out.sitemaps = { files: crawl.sitemaps.files, urls: crawl.sitemaps.urls, errors_total: null, probe_misses: null };
  const disc = artifacts.discovery;
  // `found` already excludes endpoints that answered 200 with an HTML app shell (lib/site.mjs
  // isSoftHtml404); they are listed separately so the report can say "answered 200, served HTML"
  // instead of claiming a third party publishes a file it does not.
  if (disc && disc.summary) out.discovery = { found: disc.summary.found || [], soft_404: disc.summary.soft_404 || [], statuses: disc.summary.statuses || {} };
  return Object.keys(out).length ? out : null;
}

function dataSources(crawl, findings, probes, checks) {
  const pages = crawl && Array.isArray(crawl.pages) ? crawl.pages : [];
  const used = uniq(pages.map((p) => (p.render && p.render.used) || null).filter(Boolean));
  const render = {
    mode: (crawl && crawl.options && crawl.options.render) || null,
    used,
    pages_rendered: pages.filter((p) => p.render && p.render.used && p.render.used !== 'none').length,
  };
  const method = (m) => findings.filter((f) => f.verification && f.verification.method === m);
  // Provenance first: checks.json records what the PSI client actually did. Only when a run has no
  // checks.json (an older run dir, or findings merged from elsewhere) do we fall back to the
  // verification labels — a label is a claim about how to verify, not proof that an API answered.
  const psiRecorded = checks && checks.stats && Object.prototype.hasOwnProperty.call(checks.stats, 'psi') ? checks.stats.psi : undefined;
  const psiFindings = method('psi_api');
  const psi = psiRecorded !== undefined
    ? (psiRecorded || null)
    : (!psiFindings.length ? null : (psiFindings.some((f) => f.status !== 'needs_api') ? 'used' : 'needs_api'));
  const gscFindings = method('gsc_api');
  let gsc = null;
  if (probes && probes.gsc_generative_ai) gsc = 'manual_import';
  else if (gscFindings.length) gsc = gscFindings.some((f) => f.status !== 'needs_api') ? 'used' : 'needs_api';
  return { render, psi, gsc };
}

function tierOf(dataSourcesBlock, probes) {
  let tier = 0;
  if (dataSourcesBlock.render.pages_rendered > 0 || dataSourcesBlock.psi === 'used') tier = 1;
  if (dataSourcesBlock.gsc === 'manual_import' || dataSourcesBlock.gsc === 'used' || (probes && probes.gsc_generative_ai)) tier = 2;
  return tier;
}

function coverageOf(findings, hasAgentFindings) {
  const covered = uniq(findings.map((f) => parentModule(f.module)).filter(Boolean)).sort(compareModules);
  const deterministic = deterministicModules();
  const modelOnly = SCORED_MODULES.filter((m) => !deterministic.has(m) && !covered.includes(m));
  return {
    mode: hasAgentFindings ? 'full' : 'deterministic',
    modules_covered: covered,
    modules_model_only: modelOnly,
  };
}

function targetOf(crawl, profile, runDir, pageCount) {
  const value = (crawl && crawl.target) || (profile && profile.target && (profile.target.url || profile.target.project_root)) || resolve(runDir);
  const kind = /^https?:\/\//i.test(String(value)) ? 'url' : 'path';
  const out = { kind, value: String(value) };
  const host = (crawl && crawl.host) || (profile && profile.target && profile.target.host) || null;
  if (host) out.host = String(host);
  if (pageCount > 0) out.pages_analyzed = pageCount;
  return out;
}

/* ------------------------------------------------------------------ build */

/**
 * Assemble the report for a persisted run.
 * opts: { merge, lang, environment, vertical }
 * @returns {{ok, code, error?, report?, markdown?, findings?, warnings, sources, dropped}}
 */
export function buildReport(runDir, opts = {}) {
  const dir = resolve(runDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { ok: false, code: EXIT.USAGE, error: 'run directory not found: ' + dir, warnings: [], sources: [], dropped: [] };
  }
  const lang = normalizeLang(opts.lang);
  const warnings = [];
  const crawl = readJson(join(dir, 'crawl.json'), null);
  const profile = readJson(join(dir, 'profile.json'), null);
  const artifacts = {
    robots: readJson(join(dir, 'site', 'robots.json'), null),
    sitemaps: readJson(join(dir, 'site', 'sitemaps.json'), null),
    discovery: readJson(join(dir, 'site', 'discovery.json'), null),
  };
  const checks = readJson(join(dir, 'checks.json'), null);

  const collected = collectFindings(dir, { merge: opts.merge, lang });
  warnings.push(...collected.warnings);
  if (!collected.entries.length && !collected.dropped.length) {
    return { ok: false, code: EXIT.USAGE, error: 'no findings to report in ' + dir + ' (looked for findings.deterministic.json and every --merge glob)', warnings, sources: collected.sources, dropped: collected.dropped };
  }
  const findings = collected.entries.map((e) => e.f);
  const hinted = collected.entries.map((e) => (e.page ? { ...e.f, page: e.page } : e.f));
  const hasAgentFindings = collected.entries.some((e) => e.kind === 'agent');

  const { vertical, warnings: verticalWarnings } = resolveVertical({ ...opts, lang }, profile, crawl);
  warnings.push(...verticalWarnings);

  let environment = typeof opts.environment === 'string' ? opts.environment.toLowerCase() : null;
  if (!environment && profile && profile.environment && typeof profile.environment.kind === 'string') environment = profile.environment.kind;
  if (environment && !ENVIRONMENTS.includes(environment)) {
    warnings.push(reportMessage(lang, 'unknown_environment', { environment }));
    environment = 'production';
  }

  const scoreOpts = {
    vertical: { primary: vertical.primary, also: vertical.also },
    multilingual: vertical.multilingual === undefined ? undefined : vertical.multilingual,
    environment: environment || 'production',
    lang,
    validate: false,
  };
  const flat = scoreFindings(findings, scoreOpts);
  const manifestPages = crawl && Array.isArray(crawl.pages) ? crawl.pages : [];
  const rollup = manifestPages.length > 1 ? scoreSite(crawl, { ...scoreOpts, findings: hinted }) : null;
  // One page, and it did not answer 2xx: there is no rollup to drop it from, so the scores below
  // rest on site-level findings alone. Say so rather than presenting them as a page score.
  if (!rollup && manifestPages.length === 1 && !isScorablePage(manifestPages[0])) {
    warnings.push(reportMessage(lang, 'page_not_2xx', { status: manifestPages[0].status }));
  }

  const scores = rollup
    ? { search_seo: rollup.search_seo, ai_visibility: rollup.ai_visibility }
    : { search_seo: flat.search_seo, ai_visibility: flat.ai_visibility };
  for (const axis of ['search_seo', 'ai_visibility']) scores[axis] = { ...scores[axis], dropped_count: collected.dropped.length };

  const probes = readProbes(dir);
  const sources = dataSources(crawl, findings, probes, checks);
  const report = {
    target: targetOf(crawl, profile, dir, manifestPages.length || (findings.length ? 1 : 0)),
    generated_at: new Date().toISOString(),
    run_id: (crawl && crawl.run_id) || basename(dir),
    plugin_version: pluginVersion() || undefined,
    run_dir: dir,
    tier: tierOf(sources, probes),
    vertical,
    coverage: coverageOf(findings, hasAgentFindings),
    scores,
    findings,
    data_sources: sources,
  };
  if (report.plugin_version === undefined) delete report.plugin_version;
  if (rollup) {
    report.pages = rollup.pages;
    report.site_rollup = {
      method: rollup.method,
      weights: rollup.weights,
      worst_pages: rollup.worst_pages,
      pages_count: rollup.pages_count,
      pages_scored: rollup.pages_scored,
      unscored_pages: rollup.unscored_pages,
      findings_count: rollup.findings_count,
      unassigned_count: rollup.unassigned_count,
      flat_scores: {
        search_seo: { value: flat.search_seo.value, band: flat.search_seo.band, state: flat.search_seo.state },
        ai_visibility: { value: flat.ai_visibility.value, band: flat.ai_visibility.band, state: flat.ai_visibility.state },
      },
      warnings: rollup.warnings,
    };
  }
  const site = siteSummary(artifacts, crawl);
  if (site) report.site = site;
  if (profile) report.platform = profile;
  if (probes) report.probes = probes;
  if (collected.dropped.length) report.dropped_findings = collected.dropped;

  for (const w of flat.warnings) if (!warnings.includes(w)) warnings.push(w);
  if (checks && checks.stats && checks.stats.dropped) {
    // A check that builds a schema-invalid finding drops it silently at the mk() boundary; the
    // count is the only way an operator can tell that apart from a clean site.
    const named = (checks.stats.dropped_findings || []).map((d) => d.id || d.check).filter(Boolean).slice(0, 5);
    warnings.push(reportMessage(lang, 'checks_dropped', { count: checks.stats.dropped, named: named.join(', ') }));
  }
  if (checks && checks.stats && Array.isArray(checks.stats.errors)) {
    for (const e of checks.stats.errors.slice(0, 10)) warnings.push(reportMessage(lang, 'check_failed', { check: e.check, page: e.page, message: e.message }));
    if (checks.stats.errors.length > 10) warnings.push(reportMessage(lang, 'more_check_errors', { count: checks.stats.errors.length - 10 }));
  }
  if (!crawl) warnings.push(reportMessage(lang, 'no_crawl'));
  if (warnings.length) report.warnings = warnings;

  const verdict = validateReport(report);
  if (!verdict.ok) {
    return { ok: false, code: EXIT.RUNTIME, error: 'assembled report does not conform to schema/audit-report.schema.json', schema_errors: verdict.errors.slice(0, 20), report, warnings, sources: collected.sources, dropped: collected.dropped };
  }

  const markdown = renderMarkdown(report, { lang, crawl, sources: collected.sources });
  return { ok: true, code: EXIT.OK, report, markdown, findings, warnings, sources: collected.sources, dropped: collected.dropped, duplicates: collected.duplicates, crawl };
}

/* ------------------------------------------------------------------ markdown */

export const STRINGS = Object.freeze({
  en: {
    title: 'SEO + AI-search audit',
    target: 'Target', generated: 'Generated', run: 'run', plugin: 'plugin',
    pages_analyzed: 'pages analyzed',
    coverage: 'Coverage',
    coverage_deterministic: 'Deterministic subset — model-judged modules not evaluated',
    coverage_full: 'Full — deterministic checks plus model-judged modules',
    coverage_prompt: 'Prompt-only mode — not comparable to a scripted run',
    tier: 'data tier',
    platform: 'Platform', hosting: 'hosting', environment: 'environment', unknown: 'unknown',
    scores: 'Scores', axis: 'Axis', score: 'Score', band: 'Band', interpretation: 'Interpretation',
    search: 'Search SEO', ai: 'AI Visibility', unscored: 'unscored',
    capped: 'Score capped at 40 by an established, severity-5 failure',
    suppressed: 'Caps suppressed (non-production environment)',
    categories: 'categories', category: 'Category', weight: 'Weight', value: 'Value', active: 'Active',
    yes: 'yes', no_data: 'no findings', not_active: 'inactive', active_no_findings: 'active, no scored findings',
    coverage_col: 'Coverage', provisional: 'provisional — below the coverage floor, treat the band as indicative',
    scored_col: 'Scored', needs_api: 'needs_api', manual_review: 'manual_review',
    sampling: 'Sampling', template: 'Template', type: 'Type', discovered: 'Discovered', sampled: 'Sampled',
    roles: 'Pages by role', skipped: 'Skipped URLs', no_crawl: 'No crawl manifest in this run — sampling is not available.',
    top_actions: 'Top actions', priority: 'Priority', finding: 'Finding', status: 'Status',
    severity: 'Sev', scope: 'Scope', where: 'Where', fixable: 'Fix', recommendation: 'Recommendation',
    no_actions: 'No failing or warning findings — nothing to act on in this pass.',
    coverage_h: 'Coverage and data', modules_covered: 'Modules covered', modules_model_only: 'Modules not evaluated (model-judged)',
    data_sources: 'Data sources', render: 'render', psi: 'PSI', gsc: 'GSC', none: 'none',
    unresolved: 'Unresolved', probes_h: 'Probes (never scored)', warnings: 'Warnings',
    files: 'Files', findings_total: 'Findings', dropped: 'dropped (schema-invalid)',
    action_note: 'Ranked by severity x impact magnitude / effort proxy. Effort proxy: auto 1, proposed 2, advisory 3.',
    site_rollup: 'Site rollup', worst_pages: 'Weakest pages', pages_by_score: 'Pages by score', page: 'Page',
    pages_scored_lbl: 'scored', not_scored: 'Sampled but not scored (no 2xx response)',
  },
  es: {
    title: 'Auditoría SEO + búsqueda con IA',
    target: 'Objetivo', generated: 'Generado', run: 'ejecución', plugin: 'plugin',
    pages_analyzed: 'páginas analizadas',
    coverage: 'Cobertura',
    coverage_deterministic: 'Subconjunto determinista — los módulos que juzga el modelo no se evaluaron',
    coverage_full: 'Completa — verificaciones deterministas más módulos juzgados por el modelo',
    coverage_prompt: 'Modo solo-prompt — no comparable con una ejecución con scripts',
    tier: 'nivel de datos',
    platform: 'Plataforma', hosting: 'hosting', environment: 'entorno', unknown: 'desconocido',
    scores: 'Puntuaciones', axis: 'Eje', score: 'Puntuación', band: 'Banda', interpretation: 'Interpretación',
    search: 'SEO de búsqueda', ai: 'Visibilidad en IA', unscored: 'sin puntuar',
    capped: 'Puntuación limitada a 40 por un fallo establecido de severidad 5',
    suppressed: 'Límites suprimidos (entorno no productivo)',
    categories: 'categorías', category: 'Categoría', weight: 'Peso', value: 'Valor', active: 'Activa',
    yes: 'sí', no_data: 'sin hallazgos', not_active: 'inactiva', active_no_findings: 'activa, sin hallazgos puntuados',
    coverage_col: 'Cobertura', provisional: 'provisional — por debajo del piso de cobertura; la banda es indicativa',
    scored_col: 'Puntuadas', needs_api: 'needs_api', manual_review: 'manual_review',
    sampling: 'Muestreo', template: 'Plantilla', type: 'Tipo', discovered: 'Descubiertas', sampled: 'Muestreadas',
    roles: 'Páginas por rol', skipped: 'URLs omitidas', no_crawl: 'Esta ejecución no tiene manifiesto de rastreo — no hay muestreo disponible.',
    top_actions: 'Acciones prioritarias', priority: 'Prioridad', finding: 'Hallazgo', status: 'Estado',
    severity: 'Sev', scope: 'Alcance', where: 'Dónde', fixable: 'Arreglo', recommendation: 'Recomendación',
    no_actions: 'Sin hallazgos en fallo o aviso — nada que corregir en esta pasada.',
    coverage_h: 'Cobertura y datos', modules_covered: 'Módulos cubiertos', modules_model_only: 'Módulos no evaluados (los juzga el modelo)',
    data_sources: 'Fuentes de datos', render: 'render', psi: 'PSI', gsc: 'GSC', none: 'ninguna',
    unresolved: 'Sin resolver', probes_h: 'Sondas (nunca puntúan)', warnings: 'Avisos',
    files: 'Archivos', findings_total: 'Hallazgos', dropped: 'descartados (esquema inválido)',
    action_note: 'Ordenadas por severidad x magnitud de impacto / esfuerzo estimado. Esfuerzo: auto 1, propuesto 2, consultivo 3.',
    site_rollup: 'Agregado del sitio', worst_pages: 'Páginas más débiles', pages_by_score: 'Páginas por puntuación', page: 'Página',
    pages_scored_lbl: 'puntuadas', not_scored: 'Muestreadas pero sin puntuar (sin respuesta 2xx)',
  },
});

/** Action priority proxy: severity x impact magnitude / effort. Higher acts first. */
export function priority(f) {
  const sev = Number(f && f.severity) || 0;
  const mag = MAGNITUDE_WEIGHT[f && f.expected_impact && f.expected_impact.magnitude] || 1;
  const eff = EFFORT_WEIGHT[f && f.fixable] || 3;
  return round2((sev * mag) / eff);
}

/**
 * The prioritized action list: failing and warning findings only, most valuable first.
 * The same id on many pages is ONE action (fixing a template fixes them all), so the row carries
 * the number of affected locations instead of eating fifteen slots with the same sentence.
 */
export function topActions(findings, limit = TOP_ACTIONS) {
  const groups = new Map();
  for (const f of Array.isArray(findings) ? findings : []) {
    if (!f || (f.status !== 'fail' && f.status !== 'warn')) continue;
    const g = groups.get(f.id);
    const p = priority(f);
    if (!g) { groups.set(f.id, { f, p, count: 1, locations: [shortLocation(f)] }); continue; }
    g.count++;
    if (g.locations.length < 3 && !g.locations.includes(shortLocation(f))) g.locations.push(shortLocation(f));
    if (p > g.p || (p === g.p && (Number(f.severity) || 0) > (Number(g.f.severity) || 0))) { g.f = f; g.p = p; }
  }
  return [...groups.values()]
    .sort((a, b) => b.p - a.p || (Number(b.f.severity) || 0) - (Number(a.f.severity) || 0) || b.count - a.count || String(a.f.id).localeCompare(String(b.f.id)))
    .slice(0, limit);
}

const cell = (s) => String(s == null ? '' : s).replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const t = cell(s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const num = (v) => (v === null || v === undefined ? '—' : String(v));

function shortLocation(f) {
  const loc = f.location || {};
  if (loc.url) { try { const u = new URL(loc.url); return u.pathname + u.search || '/'; } catch { return loc.url; } }
  return loc.file || loc.resource || loc.selector || (f.scope === 'site' ? 'site' : '—');
}

function categoryTable(t, axisScore) {
  const rows = [
    '| ' + [t.category, t.weight, t.value, t.active, t.scored_col, t.needs_api, t.manual_review].join(' | ') + ' |',
    '|---|---:|---:|---|---:|---:|---:|',
  ];
  for (const c of axisScore.categories) {
    // Four distinct states, which the old label collapsed into one: scored; condition met but no
    // scored finding landed in it; condition not met at all; and — for an always-on category — it
    // ran and produced only unscored findings. That last one must not read "no findings" while the
    // needs_api column on the same row says 1.
    const unscored = (Number(c.needs_api) || 0) + (Number(c.manual_review) || 0);
    const state = c.active
      ? t.yes
      : c.conditional
        ? (c.activation === 'inactive' ? t.not_active : t.active_no_findings + ' (' + c.activation + ')')
        : unscored > 0 ? t.active_no_findings : t.no_data;
    rows.push('| ' + [cell(c.name), c.weight, c.active ? c.value : '—', state, c.scored, c.needs_api, c.manual_review].join(' | ') + ' |');
  }
  return rows;
}

/** Render report.md from the assembled report object. */
export function renderMarkdown(report, opts = {}) {
  const t = STRINGS[opts.lang === 'es' ? 'es' : 'en'];
  const crawl = opts.crawl || null;
  const L = [];
  const host = report.target.host || report.target.value;

  L.push('# ' + t.title + ' — ' + host, '');
  const pagesPart = report.target.pages_analyzed ? ' (' + report.target.pages_analyzed + ' ' + t.pages_analyzed + ')' : '';
  L.push('- **' + t.target + ':** ' + report.target.value + pagesPart);
  L.push('- **' + t.generated + ':** ' + report.generated_at + ' · ' + t.run + ' `' + report.run_id + '`' +
    (report.plugin_version ? ' · ' + t.plugin + ' ' + report.plugin_version : ''));
  const coverageLabel = report.coverage.mode === 'full' ? t.coverage_full : report.coverage.mode === 'prompt-only' ? t.coverage_prompt : t.coverage_deterministic;
  L.push('- **' + t.coverage + ':** ' + coverageLabel + ' · ' + t.tier + ' ' + report.tier);
  const p = report.platform || null;
  if (p) {
    const platformId = (p.platform && p.platform.id) || t.unknown;
    const frameworkId = p.framework && p.framework.id ? ' / ' + p.framework.id : '';
    const hostingId = p.hosting && p.hosting.id ? ' · ' + t.hosting + ' ' + p.hosting.id : '';
    const envKind = p.environment && p.environment.kind ? ' · ' + t.environment + ' ' + p.environment.kind : '';
    L.push('- **' + t.platform + ':** ' + platformId + frameworkId + hostingId + envKind);
  }
  L.push('- **' + t.findings_total + ':** ' + report.findings.length +
    (report.dropped_findings ? ' · ' + report.dropped_findings.length + ' ' + t.dropped : ''));
  L.push('');

  // Scores
  L.push('## ' + t.scores, '');
  L.push('| ' + [t.axis, t.score, t.band, t.coverage_col, t.interpretation].join(' | ') + ' |', '|---|---:|---|---:|---|');
  for (const [key, label] of [['search_seo', t.search], ['ai_visibility', t.ai]]) {
    const s = report.scores[key];
    const band = s.band + (s.provisional ? ' \\*' : '');
    const cov = typeof s.coverage === 'number' ? s.coverage + '%' : '—';
    L.push('| ' + [label, s.value === null ? t.unscored : s.value, band, cov, cell(s.interpretation)].join(' | ') + ' |');
  }
  L.push('');
  for (const [key, label] of [['search_seo', t.search], ['ai_visibility', t.ai]]) {
    const s = report.scores[key];
    if (s.provisional) L.push('- **' + label + ':** \\* ' + t.provisional + ' (' + (s.coverage_weight || 0) + '/' + (s.coverage_total || 0) + ')');
    if (s.capped && s.cap_reasons.length) L.push('- **' + label + ':** ' + t.capped + ' — ' + s.cap_reasons.map((r) => r.id).join(', '));
    if (s.suppressed_caps && s.suppressed_caps.length) L.push('- **' + label + ':** ' + t.suppressed + ' — ' + s.suppressed_caps.map((r) => r.id).join(', '));
  }
  L.push('');
  for (const [key, label] of [['search_seo', t.search], ['ai_visibility', t.ai]]) {
    L.push('### ' + label + ' — ' + t.categories, '');
    L.push(...categoryTable(t, report.scores[key]));
    L.push('');
  }

  // Site rollup
  if (report.site_rollup) {
    L.push('## ' + t.site_rollup, '');
    const scoredCount = report.site_rollup.pages_scored;
    const scoredNote = typeof scoredCount === 'number' && scoredCount !== report.site_rollup.pages_count
      ? ' · ' + scoredCount + ' ' + t.pages_scored_lbl : '';
    L.push('- ' + report.site_rollup.method + ' · ' + report.site_rollup.pages_count + ' ' + t.pages_analyzed + scoredNote);
    // A sampled URL that answered 4xx/5xx is named here: the checks skip it, so it would score high
    // on an empty finding set. It is excluded from the rollup, never silently averaged in.
    const notScored = report.site_rollup.unscored_pages || [];
    if (notScored.length) {
      L.push('- **' + t.not_scored + ':** ' + notScored.slice(0, 10).map((p) => shortPath(p.url) + ' ' + (p.status == null ? '—' : p.status)).join(' · ')
        + (notScored.length > 10 ? ' …' : ''));
    }
    // "Weakest" is a claim, and the list is just the sample sorted ascending: on a run where every
    // page scores at or above the site value there is nothing weak to name, and the same three
    // pages go out under a neutral label instead of reading as a defect report.
    for (const [key, label, axisKey] of [['search', t.search, 'search_seo'], ['ai', t.ai, 'ai_visibility']]) {
      const worst = (report.site_rollup.worst_pages && report.site_rollup.worst_pages[key]) || [];
      if (!worst.length) continue;
      const siteValue = report.scores[axisKey] ? report.scores[axisKey].value : null;
      const anyBelow = typeof siteValue === 'number' && worst.some((w) => typeof w.value === 'number' && w.value < siteValue);
      L.push('- **' + (anyBelow ? t.worst_pages : t.pages_by_score) + ' (' + label + '):** ' + worst.map((w) => shortPath(w.url) + ' ' + num(w.value)).join(' · '));
    }
    L.push('');
  }

  // Sampling
  L.push('## ' + t.sampling, '');
  if (!crawl) L.push(t.no_crawl, '');
  else {
    const templates = Array.isArray(crawl.templates) ? crawl.templates.slice(0, 12) : [];
    if (templates.length) {
      L.push('| ' + [t.template, t.type, t.discovered, t.sampled].join(' | ') + ' |', '|---|---|---:|---:|');
      for (const tpl of templates) L.push('| ' + [cell(tpl.pattern), cell(tpl.type || '—'), tpl.discovered, tpl.sampled].join(' | ') + ' |');
      L.push('');
    }
    const roles = {};
    for (const pg of crawl.pages || []) roles[pg.role || 'sample'] = (roles[pg.role || 'sample'] || 0) + 1;
    L.push('- **' + t.roles + ':** ' + (Object.keys(roles).length ? Object.entries(roles).map(([r, n]) => r + ' ' + n).join(' · ') : '—'));
    const sampling = crawl.sampling || {};
    const skips = Object.keys(sampling).filter((k) => k.startsWith('skipped_by_') && sampling[k] && sampling[k].count > 0)
      .map((k) => k.replace('skipped_by_', '') + ' ' + sampling[k].count);
    L.push('- **' + t.skipped + ':** ' + (skips.length ? skips.join(' · ') : '0'));
    if (sampling.discovered != null) L.push('- **' + t.discovered + ':** ' + sampling.discovered + ' · **' + t.sampled + ':** ' + sampling.sampled);
    L.push('');
  }

  // Top actions
  const actions = topActions(report.findings);
  L.push('## ' + t.top_actions + (actions.length ? ' (' + actions.length + ')' : ''), '');
  if (!actions.length) L.push(t.no_actions, '');
  else {
    L.push('| # | ' + [t.priority, t.finding, t.status, t.severity, t.scope, t.where, t.fixable, t.recommendation].join(' | ') + ' |',
      '|---:|---:|---|---|---:|---|---|---|---|');
    actions.forEach(({ f, p: pri, count, locations }, i) => {
      const where = clip(locations.join(', '), 44) + (count > locations.length ? ' (+' + (count - locations.length) + ')' : '');
      L.push('| ' + [i + 1, pri, '`' + f.id + '`', f.status, f.severity, f.scope, where, f.fixable, clip(f.recommendation, 120)].join(' | ') + ' |');
    });
    L.push('', t.action_note, '');
  }

  // Coverage and data
  L.push('## ' + t.coverage_h, '');
  const s1 = report.scores.search_seo, s2 = report.scores.ai_visibility;
  L.push('- **' + t.needs_api + ':** ' + s1.needs_api_count + ' (' + t.search + ') · ' + s2.needs_api_count + ' (' + t.ai + ')');
  L.push('- **' + t.manual_review + ':** ' + s1.manual_review_count + ' (' + t.search + ') · ' + s2.manual_review_count + ' (' + t.ai + ')');
  L.push('- **' + t.modules_covered + ':** ' + (report.coverage.modules_covered.length ? report.coverage.modules_covered.join(', ') : t.none));
  L.push('- **' + t.modules_model_only + ':** ' + (report.coverage.modules_model_only.length ? report.coverage.modules_model_only.join(', ') : t.none));
  const ds = report.data_sources || {};
  const renderPart = ds.render ? (ds.render.used && ds.render.used.length ? ds.render.used.join(',') : t.none) + ' (' + (ds.render.mode || '—') + ')' : t.none;
  L.push('- **' + t.data_sources + ':** ' + t.render + ' ' + renderPart + ' · ' + t.psi + ' ' + (ds.psi || t.none) + ' · ' + t.gsc + ' ' + (ds.gsc || t.none));
  L.push('');

  if (report.probes) {
    L.push('## ' + t.probes_h, '');
    for (const [key, doc] of Object.entries(report.probes)) {
      const bits = [];
      if (doc.presence_rate !== undefined) bits.push('presence_rate ' + doc.presence_rate);
      if (doc.best_rank_overall !== undefined && doc.best_rank_overall !== null) bits.push('best_rank ' + doc.best_rank_overall);
      if (doc.total_impressions !== undefined) bits.push('impressions ' + doc.total_impressions);
      L.push('- **' + key + ':** ' + (bits.length ? bits.join(' · ') : '—'));
      if (typeof doc.disclaimer === 'string' && doc.disclaimer) L.push('  - ' + doc.disclaimer);
    }
    L.push('');
  }

  const axisWarnings = [];
  for (const [key, label] of [['search_seo', t.search], ['ai_visibility', t.ai]]) {
    const s = report.scores[key];
    for (const w of (s && s.warnings) || []) axisWarnings.push(label + ': ' + w);
  }
  if ((report.warnings && report.warnings.length) || axisWarnings.length) {
    L.push('## ' + t.warnings, '');
    for (const w of report.warnings || []) L.push('- ' + w);
    for (const w of axisWarnings) L.push('- ' + w);
    L.push('');
  }

  L.push('## ' + t.files, '');
  L.push('- `' + join(report.run_dir, 'report.json') + '`');
  L.push('- `' + join(report.run_dir, 'report.md') + '`');
  L.push('- `' + join(report.run_dir, 'findings.json') + '`');
  L.push('');
  return L.join('\n');
}

function shortPath(u) {
  try { const x = new URL(u); return x.pathname + x.search || '/'; } catch { return String(u); }
}

/* ------------------------------------------------------------------ CLI */

const USAGE = 'node report.mjs <run-dir> [--merge "agents/*.json"] [--lang en|es] [--out-md <path>] [--environment <kind>] [--vertical <ids>]';

export async function main(args) {
  const usage = (error) => ({ result: { error, usage: USAGE }, code: EXIT.USAGE });
  const positional = Array.isArray(args._) && typeof args._[0] === 'string' ? args._[0] : null;
  const runArg = positional || (typeof args.run === 'string' ? args.run : null) || (typeof args['run-dir'] === 'string' ? args['run-dir'] : null);
  if (!runArg) return usage('provide the run directory: ' + USAGE);

  const lang = args.lang === undefined || args.lang === true ? 'en' : String(args.lang).toLowerCase();
  if (!LANGS.includes(lang)) return usage('--lang must be one of ' + LANGS.join('|'));
  if (args.environment !== undefined && (args.environment === true || !ENVIRONMENTS.includes(String(args.environment).toLowerCase()))) {
    return usage('--environment must be one of ' + ENVIRONMENTS.join('|'));
  }
  if (args.vertical === true) return usage('--vertical needs a comma-separated list (' + VERTICALS.join(', ') + ')');
  if (args['out-md'] === true) return usage('--out-md needs a file path');

  const built = buildReport(runArg, {
    merge: args.merge,
    lang,
    environment: args.environment === undefined ? undefined : String(args.environment).toLowerCase(),
    vertical: args.vertical,
  });
  if (!built.ok) {
    return { result: { error: built.error, ...(built.schema_errors ? { schema_errors: built.schema_errors } : {}), warnings: built.warnings }, code: built.code };
  }

  const dir = built.report.run_dir;
  let paths;
  try {
    paths = {
      findings_json: writeJson(join(dir, 'findings.json'), built.findings),
      report_json: writeJson(join(dir, 'report.json'), built.report),
      report_md: writeText(join(dir, 'report.md'), built.markdown),
    };
    if (typeof args['out-md'] === 'string' && args['out-md'].trim()) paths.out_md = writeText(args['out-md'].trim(), built.markdown);
  } catch (e) {
    return { result: { error: 'could not write the report: ' + msg(e) }, code: EXIT.RUNTIME };
  }

  const s = built.report.scores;
  return {
    result: {
      run_dir: dir,
      ...paths,
      lang,
      coverage: built.report.coverage.mode,
      tier: built.report.tier,
      vertical: built.report.vertical,
      scores: {
        search_seo: { value: s.search_seo.value, band: s.search_seo.band, state: s.search_seo.state, capped: s.search_seo.capped },
        ai_visibility: { value: s.ai_visibility.value, band: s.ai_visibility.band, state: s.ai_visibility.state, capped: s.ai_visibility.capped },
      },
      findings: built.findings.length,
      dropped: built.dropped.length,
      duplicates_merged: built.duplicates,
      sources: built.sources,
      warnings: built.warnings,
    },
    code: EXIT.OK,
  };
}

if (isMain(import.meta.url)) runCli(main);

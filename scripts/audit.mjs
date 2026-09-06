#!/usr/bin/env node
// Headless audit runner: acquire → detect → check → report, in one command.
//
// Usage:
//   node audit.mjs <url|path|run-dir> [--out <runs root>] [--pages 5] [--max 40] [--no-crawl]
//        [--ua googlebot] [--render static|auto|js] [--renderer auto|chrome|playwright|none]
//        [--checks deterministic|none] [--feed <file>] [--environment <kind>]
//        [--vertical ecommerce] [--merge "agents/*.json"] [--lang en|es]
//        [--fail-under search=70,ai=60] [--fail-on-gated] [--fail-on-severity 5]
//        [--format json|ndjson|md] [--summary-md <path>] [--validate] [--quiet]
//
// A URL is crawled (`crawl.mjs`), or snapshotted when `--pages 1` / `--no-crawl`; a local path is
// snapshotted; an existing run directory skips acquisition entirely (the Claude Code path, where
// the orchestrator already crawled). `--render` defaults to **static**: a headless audit never
// launches a browser unless it is asked to.
//
// Writes into the run directory: profile.json (platform + vertical), findings.deterministic.json,
// checks.json (the registry stats), then report.mjs writes findings.json, report.json, report.md.
//
// Exit codes: 0 ok · 1 usage · 2 runtime (the target could not be acquired, or the report failed
// its schema) · 3 a --fail-under / --fail-on-gated / --fail-on-severity gate tripped.
// Everything that merely could not be measured stays a warning or a `needs_api` finding: a partial
// audit exits 0 and says what it could not see.
//
// Output: `--format json` (default) prints the summary object. `--format ndjson` prints one finding
// per line followed by a `{"type":"summary"}` line, and `--format md` prints report.md; in both
// cases the shared JSON emitter still prints one trailing document, which is `{}` so the payload
// above it stays clean.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT, isMain, runCli, credential } from './lib/util.mjs';
import { pluginVersion, readJson, writeJson } from './lib/store.mjs';
import { main as crawlMain, manifestFromSinglePage } from './crawl.mjs';
import { main as snapshotMain } from './snapshot.mjs';
import { detect } from './detect-platform.mjs';
import { loadRunContext, runChecks } from './checks/index.mjs';
import { main as reportMain, validateReport } from './report.mjs';
import { validateFindings } from './lib/validate-finding.mjs';
import { ENVIRONMENTS, VERTICALS } from './score.mjs';

export const FORMATS = Object.freeze(['json', 'ndjson', 'md']);
export const CHECK_MODES = Object.freeze(['deterministic', 'none']);
export const RENDER_MODES = Object.freeze(['auto', 'static', 'js']);
export const RENDERERS = Object.freeze(['auto', 'chrome', 'playwright', 'none']);
export const LANGS = Object.freeze(['en', 'es']);
/** Axis aliases accepted by --fail-under. */
export const GATE_AXES = Object.freeze({ search: 'search_seo', search_seo: 'search_seo', ai: 'ai_visibility', ai_visibility: 'ai_visibility' });

const USAGE = 'node audit.mjs <url|path|run-dir> [--pages N] [--render static|auto|js] [--format json|ndjson|md] [--fail-under search=70,ai=60]';

class UsageError extends Error {}
const msg = (e) => String((e && e.message) || e);
const usageResult = (error) => ({ result: { error, usage: USAGE }, code: EXIT.USAGE });

/* ------------------------------------------------------------------ options */

/** Parse `search=70,ai=60` into { search_seo: 70, ai_visibility: 60 }. */
export function parseFailUnder(value) {
  const out = {};
  if (value === undefined || value === false) return out;
  if (value === true) throw new UsageError('--fail-under needs thresholds, e.g. --fail-under search=70,ai=60');
  for (const raw of [].concat(value)) {
    for (const part of String(raw).split(',')) {
      const bit = part.trim();
      if (!bit) continue;
      const m = /^([a-z_]+)\s*[=:]\s*(-?\d+(?:\.\d+)?)$/i.exec(bit);
      if (!m) throw new UsageError('--fail-under expects axis=number pairs (search=70,ai=60), got "' + bit + '"');
      const axis = GATE_AXES[m[1].toLowerCase()];
      if (!axis) throw new UsageError('--fail-under: unknown axis "' + m[1] + '" (use search or ai)');
      const n = Number(m[2]);
      // Above 100 is legal on purpose: `--fail-under search=101` is how CI says "always fail",
      // which is exactly what a smoke test of the gate needs.
      if (!Number.isFinite(n) || n < 0) throw new UsageError('--fail-under: ' + m[1] + ' must be a number >= 0');
      out[axis] = n;
    }
  }
  return out;
}

export function readOptions(args = {}) {
  const str = (k) => (typeof args[k] === 'string' && args[k].trim() ? args[k].trim() : undefined);
  const int = (k, def, min) => {
    const v = args[k];
    if (v === undefined || v === true) return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) throw new UsageError('--' + k + ' must be an integer >= ' + min);
    return n;
  };
  const oneOf = (k, list, def) => {
    const v = args[k];
    if (v === undefined || v === true) return def;
    const s = String(v).toLowerCase();
    if (!list.includes(s)) throw new UsageError('--' + k + ' must be one of ' + list.join('|'));
    return s;
  };
  const pages = int('pages', undefined, 1);
  const lang = oneOf('lang', LANGS, 'en');
  const environment = args.environment === undefined ? undefined : oneOf('environment', ENVIRONMENTS, undefined);
  if (args.vertical === true) throw new UsageError('--vertical needs a comma-separated list (' + VERTICALS.join(', ') + ')');
  let failOnSeverity;
  if (args['fail-on-severity'] !== undefined) {
    const v = args['fail-on-severity'];
    const n = v === true ? 5 : Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 5) throw new UsageError('--fail-on-severity must be an integer 0-5');
    failOnSeverity = n;
  }
  return {
    out: str('out'),
    pages,
    max: int('max', undefined, 1),
    noCrawl: args.crawl === false || pages === 1,
    ua: str('ua'),
    render: oneOf('render', RENDER_MODES, 'static'),
    renderer: oneOf('renderer', RENDERERS, undefined),
    checks: oneOf('checks', CHECK_MODES, 'deterministic'),
    // No --psi-key flag: a secret on the command line lands in `ps`, in shell history and in the
    // command logs, so the PageSpeed key is read from the environment only.
    psiKey: credential('PSI_API_KEY'),
    feed: str('feed'),
    environment,
    vertical: args.vertical === undefined ? undefined : args.vertical,
    merge: args.merge,
    lang,
    failUnder: parseFailUnder(args['fail-under']),
    failOnGated: args['fail-on-gated'] === true || args['fail-on-gated'] === 'true',
    failOnSeverity,
    format: oneOf('format', FORMATS, 'json'),
    summaryMd: str('summary-md'),
    noNetwork: args.network === false,
    validate: args.validate === true,
    quiet: args.quiet === true,
  };
}

/** A run directory is a directory that already holds page snapshots. */
export function isRunDir(path) {
  try {
    const pages = join(path, 'pages');
    if (!existsSync(pages) || !statSync(pages).isDirectory()) return false;
    if (existsSync(join(path, 'crawl.json'))) return true;
    return readdirSync(pages).some((f) => f.endsWith('.json'));
  } catch { return false; }
}

/** `<url>` | `<path>` | `<run dir>` — the positional argument, or --url / --path / --run. */
export function classifyTarget(args = {}) {
  const pos = Array.isArray(args._) && typeof args._[0] === 'string' ? args._[0].trim() : '';
  const raw = pos || (typeof args.url === 'string' ? args.url.trim() : '') ||
    (typeof args.path === 'string' ? args.path.trim() : '') || (typeof args.run === 'string' ? args.run.trim() : '');
  if (!raw) throw new UsageError('provide a target: <url|path|run-dir>');
  if (/^https?:\/\//i.test(raw)) return { kind: 'url', value: raw };
  const abs = resolve(raw);
  if (existsSync(abs)) {
    if (statSync(abs).isDirectory() && isRunDir(abs)) return { kind: 'run', value: abs };
    return { kind: 'path', value: abs };
  }
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/|$)/i.test(raw)) return { kind: 'url', value: 'https://' + raw + (raw.includes('/') ? '' : '/') };
  throw new UsageError('target not found: ' + raw + ' (not a URL, a directory or a run directory)');
}

/* ------------------------------------------------------------------ acquisition */

/**
 * Acquire the target into a run directory (crawl for URLs, snapshot for one page or a local path).
 * @returns {Promise<{ok, code, run_dir?, mode?, acquired?, error?, detail?}>}
 */
export async function acquire(target, o = {}) {
  const common = {};
  if (o.out) common.out = o.out;
  if (o.render) common.render = o.render;
  if (o.renderer) common.renderer = o.renderer;
  if (o.ua) common.ua = o.ua;
  if (o.lang) common.lang = o.lang;

  if (target.kind === 'url' && !o.noCrawl) {
    const args = { _: [target.value], ...common, quiet: true };
    if (o.pages !== undefined) args.pages = o.pages;
    if (o.max !== undefined) args.max = o.max;
    const r = await crawlMain(args);
    if (r.code !== EXIT.OK || !r.result || !r.result.run_dir) {
      return { ok: false, code: r.code === EXIT.USAGE ? EXIT.USAGE : EXIT.RUNTIME, error: (r.result && r.result.error) || 'crawl failed', detail: r.result && r.result.detail };
    }
    return { ok: true, code: EXIT.OK, run_dir: r.result.run_dir, mode: 'crawl', acquired: { pages: r.result.pages } };
  }

  const r = await snapshotMain({ _: [target.value], ...common, quiet: true });
  if (r.code !== EXIT.OK || !r.result || !r.result.run_dir) {
    return { ok: false, code: r.code === EXIT.USAGE ? EXIT.USAGE : EXIT.RUNTIME, error: (r.result && r.result.error) || 'snapshot failed', detail: r.result && r.result.hint };
  }
  const pages = Array.isArray(r.result.pages) ? r.result.pages.length : 1;
  return { ok: true, code: EXIT.OK, run_dir: r.result.run_dir, mode: target.kind === 'url' ? 'snapshot' : 'local', acquired: { pages } };
}

/* ------------------------------------------------------------------ profile */

function homepageSnapshot(runDir, crawl) {
  const pages = crawl && Array.isArray(crawl.pages) ? crawl.pages : [];
  const pick = pages.find((p) => p.role === 'homepage') || pages.find((p) => p.role === 'target') || pages[0];
  if (pick && pick.snapshot) {
    const snap = readJson(join(runDir, pick.snapshot), null);
    if (snap) return { snap, entry: pick };
  }
  const dir = join(runDir, 'pages');
  if (!existsSync(dir)) return { snap: null, entry: null };
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json') && !/\.ua-/.test(x)).sort()) {
    const snap = readJson(join(dir, f), null);
    if (snap && Number.isInteger(snap.snapshot_version)) return { snap, entry: null };
  }
  return { snap: null, entry: null };
}

function readSnapshotHtml(runDir, snap) {
  if (snap && snap.raw_html_path) {
    try { return readFileSync(join(runDir, snap.raw_html_path), 'utf8'); } catch { /* fall through */ }
  }
  if (snap && snap.html_inline && typeof snap.html_inline.raw === 'string') return snap.html_inline.raw;
  return '';
}

/**
 * Vertical guess for a headless run: the platform hints first, then the JSON-LD types the crawl
 * already typed the templates with (the same signal the M18 gate uses). Never a silent claim:
 * the guess carries `source: 'inferred'` and the signals it was built from.
 */
export function guessVertical(profile, crawl, declared) {
  const hints = (profile && Array.isArray(profile.vertical_hints) ? profile.vertical_hints : []).filter((h) => VERTICALS.includes(h));
  const jsonldTypes = [...new Set((crawl && Array.isArray(crawl.templates) ? crawl.templates : []).map((t) => t.type).filter(Boolean))];
  const pages = crawl && Array.isArray(crawl.pages) ? crawl.pages : [];
  const hreflangPages = pages.filter((p) => Number(p.hreflang_count) > 0).length;

  let ids = [...hints];
  if (jsonldTypes.some((t) => /^(Product|ProductGroup|Offer)$/i.test(t)) && !ids.includes('ecommerce')) ids.push('ecommerce');
  let source = 'inferred';
  if (declared !== undefined && declared !== true) {
    const asked = [].concat(declared).join(',').split(',').map((x) => x.trim().toLowerCase()).filter((x) => VERTICALS.includes(x));
    if (asked.length) { ids = asked; source = 'declared'; }
  }
  return {
    primary: ids[0] || 'generic',
    also: ids.slice(1),
    multilingual: hreflangPages > 0,
    source,
    signals: { platform_hints: hints, template_types: jsonldTypes.slice(0, 10), hreflang_pages: hreflangPages },
  };
}

/** Detect the platform, merge the vertical, and persist <run>/profile.json. */
export function writeProfile(runDir, crawl, o = {}) {
  const existing = readJson(join(runDir, 'profile.json'), null);
  const { snap } = homepageSnapshot(runDir, crawl);
  const warnings = [];
  let detected = null;
  if (snap) {
    try {
      detected = detect({
        url: (snap.target && (snap.target.final_url || snap.target.requested_url)) || null,
        html: readSnapshotHtml(runDir, snap),
        headers: snap.headers || {},
        cookies: snap.cookie_names || [],
        env: process.env,
      });
    } catch (e) { warnings.push('platform detection failed: ' + msg(e)); }
  } else warnings.push('no page snapshot in the run: platform detection was skipped');

  // Keys the orchestrator (or a previous pass) added and detect() does not own are preserved;
  // every key detect() does own is refreshed from this run.
  const base = existing || (detected ? null : { version: 'detect-platform/1', platform: null, framework: null, notes: ['platform detection did not run'] });
  const profile = { ...(base || {}), ...(detected || {}) };
  if (o.vertical !== undefined && o.vertical !== true) profile.vertical = guessVertical(profile, crawl, o.vertical);
  else if (existing && existing.vertical) profile.vertical = existing.vertical;
  else profile.vertical = guessVertical(profile, crawl);
  if (o.environment) profile.environment = { ...(profile.environment || {}), kind: o.environment, declared: true };
  try { writeJson(join(runDir, 'profile.json'), profile); }
  catch (e) { warnings.push('could not write profile.json: ' + msg(e)); }
  return { profile, warnings };
}

/* ------------------------------------------------------------------ gates */

/** Evaluate the CI gates against the finished report. Returns { gates, warnings }. */
export function evaluateGates(report, findings, o = {}) {
  const gates = [];
  const warnings = [];
  const axes = [['search', 'search_seo'], ['ai', 'ai_visibility']];
  for (const [name, key] of axes) {
    const min = o.failUnder ? o.failUnder[key] : undefined;
    if (min === undefined) continue;
    const s = report.scores[key];
    if (!s || s.value === null) { warnings.push('--fail-under ' + name + '=' + min + ' could not be evaluated: the ' + name + ' axis is unscored'); continue; }
    if (s.value < min) gates.push({ gate: 'fail-under', axis: name, threshold: min, value: s.value, band: s.band });
  }
  if (o.failOnGated) {
    for (const [name, key] of axes) {
      const s = report.scores[key];
      if (s && s.capped) gates.push({ gate: 'fail-on-gated', axis: name, value: s.value, cap_reasons: (s.cap_reasons || []).map((r) => r.id) });
    }
  }
  if (o.failOnSeverity !== undefined) {
    const hits = (findings || []).filter((f) => f.status === 'fail' && (Number(f.severity) || 0) >= o.failOnSeverity);
    if (hits.length) gates.push({ gate: 'fail-on-severity', threshold: o.failOnSeverity, count: hits.length, ids: [...new Set(hits.map((f) => f.id))].slice(0, 10) });
  }
  return { gates, warnings };
}

function countByStatus(findings) {
  const out = {};
  for (const f of findings) out[f.status] = (out[f.status] || 0) + 1;
  return out;
}

/* ------------------------------------------------------------------ run */

/**
 * The whole pipeline. Exposed for tests and for callers that want the objects, not the CLI text.
 * @returns {Promise<{ok, code, summary, report?, findings?, markdown?}>}
 */
export async function runAudit(args = {}) {
  const o = readOptions(args);
  const target = classifyTarget(args);
  const warnings = [];

  let runDir, mode = 'run-dir', acquired = null;
  if (target.kind === 'run') {
    runDir = target.value;
  } else {
    const got = await acquire(target, o);
    if (!got.ok) return { ok: false, code: got.code, summary: { error: got.error, detail: got.detail || null, target: target.value } };
    runDir = got.run_dir;
    mode = got.mode;
    acquired = got.acquired;
  }
  runDir = resolve(runDir);

  // Every downstream consumer reads crawl.json; synthesize one for snapshot-only runs.
  let crawl = readJson(join(runDir, 'crawl.json'), null);
  if (!crawl) {
    try { crawl = manifestFromSinglePage(runDir, { target: target.kind === 'run' ? undefined : target.value, write: true }); }
    catch (e) { warnings.push('could not synthesize crawl.json: ' + msg(e)); }
    if (!crawl) warnings.push('no crawl.json and no page snapshots in ' + runDir);
  }

  const { profile, warnings: profileWarnings } = writeProfile(runDir, crawl, o);
  warnings.push(...profileWarnings);

  let stats = null;
  if (o.checks === 'deterministic') {
    const ctx = loadRunContext(runDir, {
      lang: o.lang, environment: o.environment, psi_key: o.psiKey, feed_path: o.feed,
      no_network: o.noNetwork, profile, vertical: profile.vertical,
    });
    const run = await runChecks(ctx);
    stats = run.stats;
    try { writeJson(join(runDir, 'findings.deterministic.json'), run.findings); }
    catch (e) { return { ok: false, code: EXIT.RUNTIME, summary: { error: 'could not write findings.deterministic.json: ' + msg(e), run_dir: runDir } }; }
    writeJson(join(runDir, 'checks.json'), { generated_at: new Date().toISOString(), plugin_version: pluginVersion(), run_dir: runDir, stats });
    if (stats.errors.length) warnings.push(stats.errors.length + ' check(s) reported an error (see checks.json)');
    if (stats.dropped) warnings.push(stats.dropped + ' finding(s) were dropped by the registry before scoring');
  } else if (!existsSync(join(runDir, 'findings.deterministic.json'))) {
    warnings.push('--checks none and no findings.deterministic.json in the run: the report will only carry merged findings');
  }

  const reportArgs = { _: [runDir], lang: o.lang };
  if (o.environment) reportArgs.environment = o.environment;
  if (o.vertical !== undefined) reportArgs.vertical = o.vertical;
  if (o.merge !== undefined) reportArgs.merge = o.merge;
  if (o.summaryMd) reportArgs['out-md'] = o.summaryMd;
  const rep = await reportMain(reportArgs);
  if (rep.code !== EXIT.OK) {
    return { ok: false, code: rep.code === EXIT.USAGE ? EXIT.USAGE : EXIT.RUNTIME, summary: { error: (rep.result && rep.result.error) || 'report failed', schema_errors: rep.result && rep.result.schema_errors, run_dir: runDir, warnings: [...warnings, ...((rep.result && rep.result.warnings) || [])] } };
  }
  warnings.push(...(rep.result.warnings || []));

  const report = readJson(rep.result.report_json, null);
  if (!report) return { ok: false, code: EXIT.RUNTIME, summary: { error: 'report.json could not be read back: ' + rep.result.report_json, run_dir: runDir } };
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const markdown = (() => { try { return readFileSync(rep.result.report_md, 'utf8'); } catch { return ''; } })();

  let validation;
  if (o.validate) {
    const rv = validateReport(report);
    const fv = validateFindings(findings);
    validation = { report_ok: rv.ok, report_errors: rv.errors.slice(0, 10), findings_checked: findings.length, findings_dropped: fv.dropped.length };
    if (!rv.ok || fv.dropped.length) {
      return { ok: false, code: EXIT.RUNTIME, summary: { error: 'validation failed', validation, run_dir: runDir, warnings } };
    }
  }

  const { gates, warnings: gateWarnings } = evaluateGates(report, findings, o);
  warnings.push(...gateWarnings);
  const code = gates.length ? EXIT.THRESHOLD : EXIT.OK;

  const summary = {
    ok: gates.length === 0,
    run_dir: runDir,
    mode,
    target: report.target,
    coverage: report.coverage.mode,
    tier: report.tier,
    vertical: report.vertical,
    platform: {
      platform: (profile.platform && profile.platform.id) || null,
      framework: (profile.framework && profile.framework.id) || null,
      hosting: (profile.hosting && profile.hosting.id) || null,
      environment: (profile.environment && profile.environment.kind) || null,
    },
    scores: {
      search_seo: { value: report.scores.search_seo.value, band: report.scores.search_seo.band, state: report.scores.search_seo.state, capped: report.scores.search_seo.capped },
      ai_visibility: { value: report.scores.ai_visibility.value, band: report.scores.ai_visibility.band, state: report.scores.ai_visibility.state, capped: report.scores.ai_visibility.capped },
    },
    findings: {
      total: findings.length,
      by_status: countByStatus(findings),
      needs_api: findings.filter((f) => f.status === 'needs_api').length,
      manual_review: findings.filter((f) => f.status === 'manual_review').length,
      dropped: (report.dropped_findings || []).length,
    },
    checks: stats ? { checks_run: stats.checks_run, errors: stats.errors.length, needs_api: stats.needs_api, manual_review: stats.manual_review } : null,
    acquired,
    report_json: rep.result.report_json,
    report_md: rep.result.report_md,
    findings_json: rep.result.findings_json,
    ...(rep.result.out_md ? { summary_md: rep.result.out_md } : {}),
    gates,
    exit_code: code,
    warnings,
    ...(validation ? { validation } : {}),
  };
  return { ok: gates.length === 0, code, summary, report, findings, markdown, options: o };
}

/* ------------------------------------------------------------------ CLI */

function ndjson(findings, summary) {
  const lines = findings.map((f) => JSON.stringify(f));
  lines.push(JSON.stringify({ type: 'summary', scores: summary.scores, gates: summary.gates, exit_code: summary.exit_code }));
  return lines.join('\n') + '\n';
}

export async function main(args) {
  let run;
  try {
    run = await runAudit(args);
  } catch (e) {
    if (e instanceof UsageError) return usageResult(e.message);
    return { result: { error: msg(e) }, code: EXIT.RUNTIME };
  }
  if (!run.summary || run.summary.error) return { result: run.summary || { error: 'audit produced no summary' }, code: run.code };

  const format = (run.options && run.options.format) || 'json';
  const quiet = !!(run.options && run.options.quiet);
  if (format === 'ndjson') {
    process.stdout.write(ndjson(run.findings, run.summary));
    return { result: {}, code: run.code };
  }
  if (format === 'md') {
    process.stdout.write(run.markdown.endsWith('\n') ? run.markdown : run.markdown + '\n');
    return { result: {}, code: run.code };
  }
  if (quiet) {
    const s = run.summary;
    return { result: { run_dir: s.run_dir, report_json: s.report_json, report_md: s.report_md, ...(s.summary_md ? { summary_md: s.summary_md } : {}), scores: s.scores, gates: s.gates, exit_code: s.exit_code }, code: run.code };
  }
  return { result: run.summary, code: run.code };
}

if (isMain(import.meta.url)) runCli(main);

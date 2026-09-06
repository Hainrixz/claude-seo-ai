// End-to-end: scripts/audit.mjs against the local fixture server, then against the run directory
// it just wrote, then against a local directory of HTML files.
//
// Nothing leaves the machine: the fixture server binds 127.0.0.1 on an ephemeral port and every run
// directory lives under os.tmpdir(). audit.mjs is called in-process (never spawned) because the
// fixture server runs in this process: a child that fetched from it would deadlock the parent's
// event loop while spawnSync blocks. tests/helpers/serve.mjs exists for the cases that do need a
// separate process (the CI smoke job).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../helpers/server.mjs';
import { EXIT } from '../../scripts/lib/util.mjs';
import { validateFinding } from '../../scripts/lib/validate-finding.mjs';
import { main as auditMain, classifyTarget, evaluateGates, isRunDir, parseFailUnder } from '../../scripts/audit.mjs';
import { validateReport } from '../../scripts/report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AUDIT = join(ROOT, 'scripts', 'audit.mjs');
let srv, out, first, runDir, report;

/** In-process call: the only way to reach the fixture server, which lives in THIS process. */
const audit = (args) => auditMain(args);

/**
 * Real CLI call. Safe only for run-directory targets with --no-network: spawnSync blocks this
 * process's event loop, so a child that fetched from the in-process fixture server would deadlock.
 * Never capture process.stdout.write instead — under `node --test` that swallows the test events
 * the runner counts.
 */
function auditCli(args) {
  const r = spawnSync(process.execPath, [AUDIT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

before(async () => {
  srv = await startServer();
  out = mkdtempSync(join(tmpdir(), 'cseo-audit-e2e-'));
  first = await audit({ _: [srv.url], out, pages: 6, render: 'static' });
  runDir = first.result.run_dir;
  report = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8'));
});

after(async () => {
  await srv.close();
  try { rmSync(out, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('a URL audit exits 0 and writes every artifact of the run', () => {
  assert.equal(first.code, EXIT.OK, JSON.stringify(first.result).slice(0, 400));
  assert.equal(first.result.ok, true);
  assert.equal(first.result.mode, 'crawl');
  for (const file of ['crawl.json', 'profile.json', 'checks.json', 'findings.deterministic.json', 'findings.json', 'report.json', 'report.md']) {
    assert.ok(existsSync(join(runDir, file)), 'missing ' + file);
  }
  assert.equal(first.result.report_json, join(runDir, 'report.json'));
  assert.ok(first.result.checks.checks_run >= 20, 'the whole registry should have run');
  assert.equal(first.result.checks.errors, 0, 'no check may fail: ' + JSON.stringify(first.result.warnings));
});

test('report.json conforms to schema/audit-report.schema.json', () => {
  const { ok, errors } = validateReport(report);
  assert.ok(ok, errors.join('; '));
  for (const f of report.findings) {
    const v = validateFinding(f);
    assert.ok(v.ok, f.id + ': ' + v.errors.join('; '));
  }
});

test('the report carries both scores, the coverage label and the tier', () => {
  assert.equal(report.coverage.mode, 'deterministic');
  assert.ok(report.coverage.modules_covered.length > 3, 'expected several covered modules');
  assert.ok(report.coverage.modules_model_only.includes('M11'), 'answer extractability is model-judged and was not evaluated');
  assert.equal(report.tier, 0, 'a static run with no PSI key stays on tier 0');
  assert.equal(report.target.kind, 'url');
  assert.ok(report.target.pages_analyzed >= 2);
  assert.equal(typeof report.scores.search_seo.band, 'string');
  assert.equal(typeof report.scores.ai_visibility.interpretation, 'string');
  assert.notEqual(report.scores.search_seo.value, report.scores.ai_visibility.value, 'the two axes are never blended');
  assert.equal(report.plugin_version, JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version);
});

test('a multi-page crawl produces the site rollup with per-page scores', () => {
  assert.ok(report.pages.length >= 2, 'expected per-page scores');
  assert.equal(report.site_rollup.method, 'role_weights');
  assert.equal(report.site_rollup.pages_count, report.pages.length);
  assert.equal(report.site_rollup.weights.homepage, 3);
  for (const page of report.pages) {
    assert.equal(typeof page.url, 'string');
    assert.ok(page.weight > 0);
    assert.ok(page.search.value === null || (page.search.value >= 0 && page.search.value <= 100));
  }
  assert.ok(report.site_rollup.worst_pages.search.length > 0);
});

test('report.md states the coverage caveat, the scores and the top actions', () => {
  const md = readFileSync(join(runDir, 'report.md'), 'utf8');
  assert.match(md, /^# SEO \+ AI-search audit/);
  assert.match(md, /Deterministic subset — model-judged modules not evaluated/);
  assert.match(md, /\| Search SEO \|/);
  assert.match(md, /\| AI Visibility \|/);
  assert.match(md, /## Top actions/);
  assert.match(md, /## Sampling/);
  assert.match(md, /Modules not evaluated \(model-judged\)/);
});

test('--format ndjson prints one finding per line, then the summary line', () => {
  const r = auditCli([runDir, '--format', 'ndjson', '--checks', 'none', '--no-network']);
  assert.equal(r.status, EXIT.OK, r.stderr.slice(0, 400));
  const lines = r.stdout.trim().split('\n');
  const parsed = lines.map((l, i) => { try { return JSON.parse(l); } catch { throw new Error('line ' + (i + 1) + ' is not JSON: ' + l.slice(0, 80)); } });
  // Last line is the shared JSON emitter's document; in ndjson mode it is an empty object so the
  // payload above stays a clean stream.
  assert.deepEqual(parsed[parsed.length - 1], {});
  const summary = parsed[parsed.length - 2];
  assert.equal(summary.type, 'summary');
  assert.equal(summary.exit_code, 0);
  assert.equal(typeof summary.scores.search_seo.band, 'string');
  assert.equal(parsed.length - 2, report.findings.length, 'one line per merged finding');
  for (const f of parsed.slice(0, -2)) assert.ok(validateFinding(f).ok, f.id + ' must survive the round trip');
});

test('--format md prints report.md', () => {
  const r = auditCli([runDir, '--format', 'md', '--checks', 'none', '--no-network']);
  assert.equal(r.status, EXIT.OK, r.stderr.slice(0, 400));
  assert.match(r.stdout, /^# SEO \+ AI-search audit/);
  assert.ok(r.stdout.includes('## Top actions'));
  assert.ok(r.stdout.trimEnd().endsWith('{}'), 'the JSON emitter still prints its one document');
});

test('the CLI exit code follows the gate: 3 when --fail-under trips, 0 when it does not', () => {
  const failed = auditCli([runDir, '--fail-under', 'search=101,ai=0', '--checks', 'none', '--no-network', '--quiet']);
  assert.equal(failed.status, EXIT.THRESHOLD, failed.stdout.slice(0, 300));
  assert.equal(JSON.parse(failed.stdout).exit_code, EXIT.THRESHOLD);
  const passed = auditCli([runDir, '--fail-under', 'search=0,ai=0', '--checks', 'none', '--no-network', '--quiet']);
  assert.equal(passed.status, EXIT.OK, passed.stdout.slice(0, 300));
});

test('a run directory skips acquisition entirely — not one new request', async () => {
  assert.ok(isRunDir(runDir));
  const before = srv.hits.length;
  const r = await audit({ _: [runDir], network: false, quiet: true });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.result.run_dir, runDir);
  assert.equal(srv.hits.length, before, 'auditing a persisted run must not touch the network');
  assert.equal(typeof r.result.scores.search_seo.value, 'number');
});

test('--fail-under trips the threshold gate with exit 3, and a met threshold exits 0', async () => {
  const fail = await audit({ _: [runDir], 'fail-under': 'search=101,ai=0', checks: 'none', network: false, quiet: true });
  assert.equal(fail.code, EXIT.THRESHOLD);
  assert.equal(fail.result.exit_code, EXIT.THRESHOLD);
  assert.equal(fail.result.gates.length, 1);
  assert.deepEqual({ gate: fail.result.gates[0].gate, axis: fail.result.gates[0].axis, threshold: fail.result.gates[0].threshold },
    { gate: 'fail-under', axis: 'search', threshold: 101 });

  const pass = await audit({ _: [runDir], 'fail-under': 'search=0,ai=0', checks: 'none', network: false, quiet: true });
  assert.equal(pass.code, EXIT.OK);
  assert.deepEqual(pass.result.gates, []);
});

test('--fail-on-severity counts only failing findings at or above the threshold', async () => {
  const r = await audit({ _: [runDir], 'fail-on-severity': 5, checks: 'none', network: false, quiet: true });
  const worst = report.findings.filter((f) => f.status === 'fail' && f.severity >= 5).length;
  if (worst) {
    assert.equal(r.code, EXIT.THRESHOLD);
    assert.equal(r.result.gates[0].count, worst);
  } else {
    assert.equal(r.code, EXIT.OK);
    assert.deepEqual(r.result.gates, []);
  }
});

test('a local directory of HTML files is audited without a crawl', async () => {
  const r = await audit({ _: [join(ROOT, 'tests', 'fixtures', 'site')], out, quiet: true });
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.result).slice(0, 300));
  const local = JSON.parse(readFileSync(r.result.report_json, 'utf8'));
  assert.equal(local.target.kind, 'path');
  assert.ok(validateReport(local).ok, validateReport(local).errors.join('; '));
  assert.ok(local.findings.length > 5, 'the page-level checks still run on local files');
  assert.equal(local.data_sources.render.pages_rendered, 0);
  // No key was supplied, so no PSI/CrUX data entered this run — whatever verification labels the
  // static Core Web Vitals heuristics carry. data_sources.psi drives the reported data tier.
  assert.equal(local.data_sources.psi, 'needs_api');
  assert.equal(local.tier, 0);
});

test('usage errors exit 1 and say what is wrong', async () => {
  assert.equal((await audit({ _: [] })).code, EXIT.USAGE);
  assert.equal((await audit({ _: [runDir], format: 'xml' })).code, EXIT.USAGE);
  assert.equal((await audit({ _: [runDir], 'fail-under': 'search' })).code, EXIT.USAGE);
  assert.equal((await audit({ _: [join(out, 'nope-does-not-exist')] })).code, EXIT.USAGE);
  const bad = await audit({ _: [runDir], lang: 'fr' });
  assert.equal(bad.code, EXIT.USAGE);
  assert.match(bad.result.error, /--lang/);
});

test('a target that cannot be fetched at all is a runtime failure, not a score of zero', async () => {
  const r = await audit({ _: ['http://127.0.0.1:1/'], out, pages: 1 });
  assert.equal(r.code, EXIT.RUNTIME);
  assert.equal(typeof r.result.error, 'string');
  assert.ok(!('scores' in r.result), 'a failed acquisition must never produce a score');
});

test('parseFailUnder / classifyTarget / evaluateGates behave on their own', () => {
  assert.deepEqual(parseFailUnder('search=70,ai=60'), { search_seo: 70, ai_visibility: 60 });
  assert.deepEqual(parseFailUnder(undefined), {});
  assert.throws(() => parseFailUnder('seo=70'), /unknown axis/);
  assert.throws(() => parseFailUnder(true), /needs thresholds/);

  assert.deepEqual(classifyTarget({ _: ['https://example.test/a'] }), { kind: 'url', value: 'https://example.test/a' });
  assert.deepEqual(classifyTarget({ _: ['example.test'] }), { kind: 'url', value: 'https://example.test/' });
  assert.deepEqual(classifyTarget({ _: [runDir] }), { kind: 'run', value: runDir });
  assert.equal(classifyTarget({ _: [join(ROOT, 'tests', 'fixtures', 'site')] }).kind, 'path');

  const fake = { scores: { search_seo: { value: 50, band: 'F', capped: true, cap_reasons: [{ id: 'M2.robots.noindex' }] }, ai_visibility: { value: null, band: 'unscored', capped: false, cap_reasons: [] } } };
  const gated = evaluateGates(fake, [], { failOnGated: true });
  assert.equal(gated.gates.length, 1);
  assert.deepEqual(gated.gates[0].cap_reasons, ['M2.robots.noindex']);
  const unscored = evaluateGates(fake, [], { failUnder: { ai_visibility: 60 } });
  assert.deepEqual(unscored.gates, [], 'an unscored axis is not a failure');
  assert.match(unscored.warnings[0], /unscored/);
});

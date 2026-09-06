// End-to-end: scripts/compare.mjs over real run directories.
//
// The pairwise case is two audits of the same origin on the local fixture server, with the site
// changed in between (robots.txt starts answering 404, which unblocks GPTBot and drops the declared
// sitemap) — a genuine before/after with no network beyond 127.0.0.1. The gate, baseline-pointer,
// competitor and gap cases run on synthetic run directories built from tests/fixtures/report-*.json
// and from snapshot.mjs, so they are deterministic.
//
// compare.mjs is called in-process whenever the fixture server is involved (it lives in THIS
// process, so a child that fetched from it would deadlock the parent); the exit-code assertions use
// the real CLI on run directories, which touch no network at all.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../helpers/server.mjs';
import { EXIT } from '../../scripts/lib/util.mjs';
import { readJson, resolveRunRef } from '../../scripts/lib/store.mjs';
import { main as auditMain } from '../../scripts/audit.mjs';
import { main as snapshotMain } from '../../scripts/snapshot.mjs';
import { main as compareMain } from '../../scripts/compare.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPARE = join(ROOT, 'scripts', 'compare.mjs');
const FIXTURES = join(ROOT, 'tests', 'fixtures');

/** Mutated between the two audits: the fixture server reads it on every request. */
const serverOpts = {};
let srv, out, runA, runB, pairwise;
/** Root holding the synthetic run directories built from the report fixtures. */
let synth, synthA, synthB, synthC;

/** Real CLI call. Safe only for run-directory refs: they never reach the fixture server. */
function compareCli(args) {
  const r = spawnSync(process.execPath, [COMPARE, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json: parse(r.stdout) };
}
function parse(text) { try { return JSON.parse(text); } catch { return null; } }

/** Drop a fixture report into `<root>/<host>/<run-id>/report.json` and return the run directory. */
function synthRun(root, host, runId, report) {
  const dir = join(root, host, runId);
  mkdirSync(join(dir, 'pages'), { recursive: true });
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
  return dir;
}

before(async () => {
  srv = await startServer(serverOpts);
  out = mkdtempSync(join(tmpdir(), 'cseo-compare-e2e-'));
  const first = await auditMain({ _: [srv.url], out, pages: 5, render: 'static', quiet: true });
  assert.equal(first.code, EXIT.OK, 'the reference audit must succeed: ' + JSON.stringify(first.result).slice(0, 500));
  runA = first.result.run_dir;
  // The change under test: robots.txt disappears, so GPTBot is no longer disallowed.
  serverOpts.robotsStatus = 404;
  const second = await auditMain({ _: [srv.url], out, pages: 5, render: 'static', quiet: true });
  assert.equal(second.code, EXIT.OK, 'the second audit must succeed: ' + JSON.stringify(second.result).slice(0, 500));
  runB = second.result.run_dir;
  pairwise = await compareMain({ _: [], baseline: runA, against: runB, out });

  synth = mkdtempSync(join(tmpdir(), 'cseo-compare-synth-'));
  const reportA = JSON.parse(readFileSync(join(FIXTURES, 'report-a.json'), 'utf8'));
  const reportB = JSON.parse(readFileSync(join(FIXTURES, 'report-b.json'), 'utf8'));
  const reportC = JSON.parse(readFileSync(join(FIXTURES, 'report-a.json'), 'utf8'));
  reportC.target = { kind: 'url', value: 'https://third.test/', host: 'third.test', pages_analyzed: 2 };
  reportC.run_id = '2026-09-05T10-00-00Z';
  reportC.scores.search_seo.value = 82;
  reportC.scores.search_seo.band = 'B';
  synthA = synthRun(synth, 'example.com', reportA.run_id, reportA);
  synthB = synthRun(synth, 'staging.example.com', reportB.run_id, reportB);
  synthC = synthRun(synth, 'third.test', reportC.run_id, reportC);
});

after(async () => {
  await srv.close();
  for (const dir of [out, synth]) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

/* ------------------------------------------------------------------ pairwise, real runs */

test('two audits of the same origin compare as a baseline and write compare.json', () => {
  assert.equal(pairwise.code, EXIT.OK, JSON.stringify(pairwise.result).slice(0, 400));
  const s = pairwise.result;
  assert.equal(s.mode, 'baseline', 'the same host on both sides is a baseline comparison');
  assert.ok(existsSync(s.compare_json), 'compare.json was not written: ' + s.compare_json);
  assert.ok(s.compare_json.includes(sep + 'compare' + sep), 'the document lives under <root>/compare/');
  assert.notEqual(s.a.run_id, s.b.run_id, 'two distinct runs were compared');
  assert.ok(['improved', 'regressed', 'mixed', 'unchanged'].includes(s.verdict));
  assert.equal(s.gaps, 'available', 'both runs carry page snapshots');
});

test('the persisted document carries the full compare schema', () => {
  const doc = readJson(pairwise.result.compare_json);
  assert.equal(doc.compare_version, 1);
  assert.equal(doc.mode, 'baseline');
  assert.equal(doc.a.run_dir, runA);
  assert.equal(doc.b.run_dir, runB);
  for (const key of ['scores', 'categories', 'findings', 'gaps', 'pages', 'verdict']) assert.ok(key in doc, 'missing ' + key);
  for (const bucket of ['fixed', 'new', 'regressed', 'improved', 'coverage_changes']) assert.ok(Array.isArray(doc.findings[bucket]), bucket + ' must be an array');
  assert.equal(typeof doc.findings.unchanged, 'number');
  assert.ok(doc.pages.some((p) => p.status === 'matched'), 'the two crawls share at least one page path');
  assert.equal(doc.scores.search_seo.a !== null, true);
  assert.equal(doc.scores.ai_visibility.a !== null, true);
});

test('unblocking GPTBot between the runs shows up in the AI-crawler posture gap', () => {
  const doc = readJson(pairwise.result.compare_json);
  assert.equal(doc.gaps.available, true);
  assert.ok(doc.gaps.ai_crawler_posture !== 'unavailable', 'both runs saved site/robots.json');
  assert.ok(doc.gaps.ai_crawler_posture.blocked_only_a.includes('GPTBot'), 'GPTBot was disallowed in run a and allowed in run b');
  assert.deepEqual(doc.gaps.ai_crawler_posture.blocked_only_b, []);
  const h = doc.gaps.headings;
  assert.ok(h.overlap_jaccard === null || (h.overlap_jaccard >= 0 && h.overlap_jaccard <= 1), 'the topic overlap is a ratio, or null when neither run found a topic');
  assert.deepEqual([doc.gaps.agentic_endpoints.only_a, doc.gaps.agentic_endpoints.only_b], [[], []], 'the discovery endpoints are probed directly, so robots.txt going away did not move them');
  assert.ok(doc.gaps.agentic_endpoints.a.includes('/llms.txt'), 'the fixture site serves /llms.txt on both runs');
  assert.equal(typeof doc.gaps.word_count.a.median, 'number');
  assert.equal(doc.gaps.word_count.delta_median, 0, 'no page body changed between the two runs');
  assert.ok(doc.findings.unchanged > 0, 'most of a site that barely changed stays unchanged');
});

test('`latest` resolves to the newest run of the host', async () => {
  const r = await compareMain({ _: [], baseline: runA, against: 'latest:' + new URL(srv.url).host, out });
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.result).slice(0, 300));
  assert.equal(r.result.b.run_id, readJson(join(dirname(runB), 'latest.json')).run);
});

test('--set-baseline marks the newer run so `baseline` resolves to it later', async () => {
  const r = await compareMain({ _: [], baseline: runA, against: runB, out, 'set-baseline': true });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.result.set_baseline.ok, true);
  const pointer = readJson(join(dirname(runB), 'baseline.json'));
  assert.equal(pointer.run, r.result.b.run_id);
  assert.equal(pointer.path, runB);
  assert.equal(pointer.set_by, 'compare');
  const resolved = resolveRunRef('baseline:' + new URL(srv.url).host, out);
  assert.equal(resolved.dir, runB, 'the pointer is what resolveRunRef reads back');
});

// This one audits the URL, so it moves the host's `latest` pointer: keep it after the tests above.
test('a URL with no run is audited first instead of being compared from nothing', async () => {
  const r = await compareMain({ _: [], baseline: runA, against: srv.url, out });
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.result).slice(0, 300));
  const doc = readJson(r.result.compare_json);
  assert.ok(Array.isArray(doc.audited) && doc.audited.length === 1, 'the run it had to acquire is recorded in the document');
  assert.equal(doc.audited[0].url, srv.url);
  assert.deepEqual({ pages: doc.audited[0].pages, checks: doc.audited[0].checks }, { pages: 3, checks: 'deterministic' });
  assert.equal(doc.b.coverage, 'deterministic', 'an on-demand run is a deterministic one and says so');
  assert.notEqual(doc.b.run_dir, runB);
});

/* ------------------------------------------------------------------ CLI contract */

test('the CLI compares two run directories and exits 0', () => {
  const r = compareCli(['--baseline', synthA, '--against', synthB, '--out', synth]);
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.equal(r.json.mode, 'staging', 'staging.example.com is recognised as a deployment of example.com');
  assert.deepEqual(r.json.findings, { fixed: 2, new: 1, regressed: 1, improved: 1, unchanged: 2, coverage_changes: 3 });
});

test('--fail-on-regression exits 3 when a finding got worse', () => {
  const r = compareCli(['--baseline', synthA, '--against', synthB, '--out', synth, '--fail-on-regression']);
  assert.equal(r.status, EXIT.THRESHOLD, 'a warn -> fail transition and a -4 search delta must fail the gate');
  assert.equal(r.json.exit_code, EXIT.THRESHOLD);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.gate.tripped, true);
  assert.ok(r.json.gate.reasons.some((x) => x.gate === 'axis' && x.axis === 'search'));
});

test('--fail-on-regression exits 0 when a run is compared with itself', () => {
  const r = compareCli(['--baseline', synthA, '--against', synthA, '--out', synth, '--fail-on-regression']);
  assert.equal(r.status, EXIT.OK, r.stdout);
  assert.equal(r.json.verdict, 'unchanged');
  assert.deepEqual(r.json.scores.search.delta, 0);
});

test('a reference that is not an audit run is a usage error', () => {
  const r = compareCli(['--baseline', join(FIXTURES, 'site'), '--against', synthB, '--out', synth]);
  assert.equal(r.status, EXIT.USAGE);
  assert.match(r.json.error, /not an audit run/);
});

test('two references are required', () => {
  const r = compareCli(['--baseline', synthA, '--out', synth]);
  assert.equal(r.status, EXIT.USAGE);
  assert.match(r.json.error, /--baseline and --against/);
});

test('--format md prints the tables and saves compare.md next to compare.json', () => {
  const r = compareCli(['--baseline', synthA, '--against', synthB, '--out', synth, '--format', 'md']);
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.match(r.stdout, /# Comparison \(staging\)/);
  assert.match(r.stdout, /## Findings/);
  // The markdown is printed first; the shared emitter still prints one trailing JSON document.
  const at = r.stdout.lastIndexOf('\n{\n');
  const tail = parse(r.stdout.slice(at + 1));
  assert.ok(tail && tail.compare_md, 'the trailing document names the markdown it wrote');
  assert.ok(existsSync(tail.compare_md), 'compare.md must be written next to compare.json');
  assert.equal(dirname(tail.compare_md), dirname(tail.compare_json));
  assert.match(readFileSync(tail.compare_md, 'utf8'), /# Comparison \(staging\)/);
});

test('--data returns the whole document instead of the summary', () => {
  const r = compareCli(['--baseline', synthA, '--against', synthB, '--out', synth, '--data']);
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.equal(r.json.compare_version, 1);
  assert.equal(r.json.findings.fixed.length, 2);
  assert.ok(Array.isArray(r.json.categories));
});

/* ------------------------------------------------------------------ competitor */

test('three references produce a competitor matrix and never a findings diff', () => {
  const r = compareCli([synthA, synthB, synthC, '--out', synth]);
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.equal(r.json.mode, 'competitor');
  assert.deepEqual(r.json.refs.map((x) => x.label), ['example.com', 'staging.example.com', 'third.test']);
  assert.deepEqual(r.json.scores.search.map((x) => x.value), [70, 66, 82]);
  const doc = readJson(r.json.compare_json);
  assert.equal(doc.findings, null, 'findings are not comparable across different sites');
  assert.match(doc.findings_note, /not the same fact/);
  assert.equal(doc.gaps.best_in_set.search.label, 'third.test');
  assert.ok(doc.table.categories.length > 0);
  assert.ok(doc.presence_matrix.length > 0);
  assert.ok(doc.honesty.some((h) => /not their rankings/.test(h)));
});

test('--fail-on-regression is refused, not faked, in competitor mode', () => {
  const r = compareCli([synthA, synthB, synthC, '--out', synth, '--fail-on-regression']);
  assert.equal(r.status, EXIT.OK);
  const doc = readJson(r.json.compare_json);
  assert.ok(doc.warnings.some((w) => /does not apply in competitor mode/.test(w)));
});

/* ------------------------------------------------------------------ gap */

test('gap mode builds the deterministic matrix from snapshot-only runs', async () => {
  const pages = mkdtempSync(join(tmpdir(), 'cseo-compare-gap-'));
  const html = (title, headings, body, jsonld) => '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>' + title + '</title>'
    + (jsonld ? '<script type="application/ld+json">' + JSON.stringify(jsonld) + '</script>' : '')
    + '</head><body><main><h1>' + title + '</h1>'
    + headings.map((h) => '<h2>' + h + '</h2><p>' + body + '</p>').join('')
    + '</main></body></html>';
  const rivalCopy = 'Gore Tex membranes keep the upper dry for 3 hours in 20 mm of rain.';
  const files = {
    subject: html('Our boots', ['Materials'], 'Our own membrane keeps the upper dry in the rain.', { '@context': 'https://schema.org', '@type': 'Product', name: 'Boot' }),
    rival1: html('Rival one', ['Materials', 'How long does shipping take?', 'Sizing'], rivalCopy, { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [] }),
    rival2: html('Rival two', ['How long does shipping take?', 'Warranty'], rivalCopy, { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [] }),
  };
  const runs = {};
  for (const [name, body] of Object.entries(files)) {
    const file = join(pages, name + '.html');
    writeFileSync(file, body);
    const snap = await snapshotMain({ _: [file], out, run: 'gap-' + name, render: 'static', quiet: true });
    assert.equal(snap.code, EXIT.OK, JSON.stringify(snap.result));
    runs[name] = snap.result.run_dir;
  }

  const r = await compareMain({ _: [], mode: 'gap', subject: runs.subject, set: runs.rival1 + ',' + runs.rival2, query: 'best waterproof boots', out });
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.result).slice(0, 400));
  assert.equal(r.result.mode, 'gap');
  assert.equal(r.result.query, 'best waterproof boots');
  assert.equal(r.result.confidence, 'directional');

  const doc = readJson(r.result.compare_json);
  assert.equal(doc.threshold, 2, 'a signal must appear on at least two comparison pages');
  assert.deepEqual(doc.matrix.heading_topics.map((t) => t.topic), ['how long does shipping take']);
  assert.deepEqual(doc.matrix.schema_types.map((t) => t.type), ['FAQPage']);
  assert.ok(doc.matrix.terms.some((t) => t.term === 'gore tex'), 'a capitalized term shared by the set is listed');
  assert.equal(typeof doc.matrix.word_count.delta, 'number');
  assert.ok(doc.honesty.some((h) => /directional/.test(h)));
  assert.ok(doc.warnings.some((w) => /no report\.json/.test(w)), 'a snapshot-only run says it carries no scores');
  try { rmSync(pages, { recursive: true, force: true }); } catch { /* best effort */ }
});

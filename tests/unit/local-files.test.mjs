// Unit tests for scripts/adapters/local-files.mjs — plan/preview/apply/verify/rollback on a
// throwaway copy of a fixture repository. Nothing here touches the network or the real fixtures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LF = await import(pathToFileURL(join(ROOT, 'scripts', 'adapters', 'local-files.mjs')).href);
const A = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'adapter.mjs')).href);
const REPOS = join(ROOT, 'tests', 'fixtures', 'repos');

/** A temp data dir plus a throwaway copy of one fixture repo. */
function sandbox(fixture) {
  const base = mkdtempSync(join(tmpdir(), 'cseo-lf-'));
  const project = join(base, 'project');
  cpSync(join(REPOS, fixture), project, { recursive: true });
  const dataDir = join(base, 'data');
  mkdirSync(dataDir, { recursive: true });
  return { base, project, dataDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const DESCRIPTION_SNIPPET = '<meta name="description" content="Why the east side of the range stays dry.">';

function report(target, findings) {
  return { target: { kind: 'url', value: target }, findings };
}

const metaFinding = (url) => ({
  id: 'M7.meta.description_missing',
  module: 'M7',
  title: 'Meta description missing',
  status: 'fail',
  severity: 3,
  scope: 'page',
  location: { url },
  evidence: { observed: 'no <meta name="description"> in the head' },
  expected: 'a unique meta description under 160 characters',
  recommendation: 'add a meta description that matches the page content',
  fixable: 'auto',
  fix_preview: DESCRIPTION_SNIPPET,
  verification: { method: 'dom_assert', assertion: 'head contains a description', reproduce: 'node scripts/parse-html.mjs --url ' + url },
  expected_impact: { axis: 'search', confidence: 'established', magnitude: 'medium', rationale: 'Google shows the description in the snippet' },
});

test('parseFixPreview understands a unified diff, front matter, key/value lines and a raw snippet', () => {
  const diff = LF.parseFixPreview('--- a/x.html\n+++ b/x.html\n@@ -1 +1,2 @@\n <head>\n+<meta name="x" content="1">\n');
  assert.equal(diff.kind, 'diff');
  assert.equal(diff.snippet, '<meta name="x" content="1">');

  const fm = LF.parseFixPreview('---\ndescription: "A dry side"\n---\n');
  assert.equal(fm.kind, 'front-matter');
  assert.deepEqual(fm.updates, { description: 'A dry side' });

  const fields = LF.parseFixPreview('description: A dry side\ntitle: Rain shadow');
  assert.equal(fields.kind, 'fields');
  assert.deepEqual(fields.updates, { description: 'A dry side', title: 'Rain shadow' });

  assert.equal(LF.parseFixPreview(DESCRIPTION_SNIPPET).kind, 'snippet');
  assert.equal(LF.parseFixPreview('').kind, 'none');
  assert.equal(LF.parseFixPreview(undefined).kind, 'none');
});

test('containedPath refuses to leave the project', () => {
  const { base, project, cleanup } = sandbox('static');
  try {
    assert.equal(LF.containedPath(project, 'about/index.html').ok, true);
    assert.equal(LF.containedPath(project, './robots.txt').rel, 'robots.txt');
    const up = LF.containedPath(project, '../escape.txt');
    assert.equal(up.ok, false);
    assert.match(up.reason, /escapes the project root/);
    assert.equal(LF.containedPath(project, join(base, 'outside.txt')).ok, false);
    assert.equal(LF.containedPath(project, '').ok, false);
  } finally { cleanup(); }
});

test('fixableFindings filters by status, fixable and --category', () => {
  const findings = [
    { id: 'M7.a', module: 'M7', status: 'fail', fixable: 'auto', expected_impact: { axis: 'search' } },
    { id: 'M5.b', module: 'M5', status: 'warn', fixable: 'proposed', expected_impact: { axis: 'both' } },
    { id: 'M1.c', module: 'M1', status: 'pass', fixable: 'auto', expected_impact: { axis: 'search' } },
    { id: 'M9.d', module: 'M9', status: 'fail', fixable: 'advisory', expected_impact: { axis: 'ai' } },
  ];
  assert.deepEqual(LF.fixableFindings(findings).map((f) => f.id), ['M7.a']);
  assert.deepEqual(LF.fixableFindings(findings, { includeProposed: true }).map((f) => f.id), ['M7.a', 'M5.b']);
  assert.deepEqual(LF.fixableFindings(findings, { includeProposed: true, category: 'M5' }).map((f) => f.id), ['M5.b']);
  assert.deepEqual(LF.fixableFindings(findings, { includeProposed: true, category: 'ai' }).map((f) => f.id), ['M5.b'], 'axis "both" answers to ai');
});

test('plan -> preview -> apply -> verify -> rollback on an Astro page (auto, html-head)', async () => {
  const { project, dataDir, cleanup } = sandbox('astro');
  try {
    const url = 'https://ridgeline.example/blog/rain-shadow';
    const run = A.openFixRun(dataDir, { report: 'report.json', target: { kind: 'url', value: url } });
    const planned = await LF.plan({ report: report(url, [metaFinding(url)]), project }, { run, dataDir });

    assert.equal(planned.changes.length, 1, JSON.stringify(planned.skipped));
    const change = planned.changes[0];
    assert.equal(change.adapter, 'local-files');
    assert.equal(change.class, 'auto');
    assert.equal(change.strategy, 'html-head');
    assert.equal(change.op, 'insert');
    assert.equal(change.target.locator, 'src/pages/blog/[slug].astro');
    assert.equal(change.live_impact, 'none');
    assert.deepEqual(change.requires, { credentials: [], tools: [] });
    assert.equal(change.rollback.kind, 'restore-file');
    assert.equal(change.status, 'planned');
    assert.deepEqual(A.validateChange(change, { phase: 'preview' }), []);
    assert.equal(change.preview.kind, 'diff');
    assert.match(change.preview.body, /^--- a\/src\/pages\/blog\/\[slug\]\.astro/m);
    assert.match(change.preview.body, /^\+.*meta name="description"/m);

    // preview writes the diff into the run and reports no drift
    const previewed = await LF.preview(change, { run, project });
    assert.equal(previewed.ok, true);
    assert.equal(previewed.drifted, false);
    assert.equal(previewed.change.status, 'previewed');
    assert.ok(existsSync(run.previewPath(change.id, '.diff')));

    // apply: a backup is made first, and the file really changes
    const file = join(project, 'src', 'pages', 'blog', '[slug].astro');
    const original = readFileSync(file, 'utf8');
    const applied = await LF.apply(previewed.change, { run, project });
    assert.equal(applied.ok, true);
    assert.equal(applied.change.status, 'applied');
    const after = readFileSync(file, 'utf8');
    assert.ok(after.includes('name="description"'));
    assert.ok(after.includes('<!-- claude-seo-ai -->'), 'the marker makes the edit idempotent');
    assert.ok(after.includes('<meta charset="utf-8">'), 'the anchor line survives');
    assert.equal(readFileSync(run.backupPath('src/pages/blog/[slug].astro'), 'utf8'), original, 'the backup is byte-identical');
    assert.ok(existsSync(run.afterPath(change.id)));

    // verify: source-level pass
    const verified = await LF.verify(applied.change, { run, project });
    assert.equal(verified.ok, true);
    assert.equal(verified.change.status, 'verified');

    // rollback restores the original bytes
    const rolled = await LF.rollback(verified.change, { run, project });
    assert.equal(rolled.ok, true);
    assert.equal(rolled.change.status, 'rolled_back');
    assert.equal(readFileSync(file, 'utf8'), original);
  } finally { cleanup(); }
});

test('a second plan on an already-fixed file is skipped as idempotent, not applied twice', async () => {
  const { project, dataDir, cleanup } = sandbox('astro');
  try {
    const url = 'https://ridgeline.example/blog/rain-shadow';
    const run = A.openFixRun(dataDir, {});
    const first = await LF.plan({ report: report(url, [metaFinding(url)]), project }, { run, dataDir });
    const applied = await LF.apply(A.transition(first.changes[0], 'confirmed'), { run, project });
    assert.equal(applied.ok, true);

    const again = await LF.plan({ report: report(url, [metaFinding(url)]), project }, { run, dataDir });
    assert.equal(again.changes.length, 0);
    assert.equal(again.skipped.length, 1);
    assert.match(again.skipped[0].reason, /already applied/);

    // and applying the original change object again is a no-op, not a duplicate insertion
    const repeat = await LF.apply(A.transition(first.changes[0], 'confirmed'), { run, project });
    assert.equal(repeat.change.status, 'skipped_idempotent');
    const body = readFileSync(join(project, 'src', 'pages', 'blog', '[slug].astro'), 'utf8');
    assert.equal((body.match(/name="description"/g) || []).length, 1);
  } finally { cleanup(); }
});

test('a Hugo front-matter fix merges keys and leaves the body alone', async () => {
  const { project, dataDir, cleanup } = sandbox('hugo');
  try {
    const url = 'https://ridgeline.example/posts/rain-shadow/';
    const finding = { ...metaFinding(url), id: 'M7.meta.description_missing', fix_preview: '---\ndescription: "Why the east side of the range stays dry."\n---\n' };
    const run = A.openFixRun(dataDir, {});
    const planned = await LF.plan({ report: report(url, [finding]), project }, { run, dataDir });
    assert.equal(planned.changes.length, 1, JSON.stringify(planned.skipped));
    const change = planned.changes[0];
    assert.equal(change.target.locator, 'content/posts/rain-shadow.md');
    assert.equal(change.strategy, 'front-matter');
    assert.equal(change.op, 'update-fields');
    assert.equal(change.class, 'auto');

    const applied = await LF.apply(A.transition(change, 'confirmed'), { run, project });
    assert.equal(applied.ok, true);
    const text = readFileSync(join(project, 'content', 'posts', 'rain-shadow.md'), 'utf8');
    assert.match(text, /^description: Why the east side of the range stays dry\.$/m);
    assert.match(text, /title: "Rain shadow"/, 'the existing keys are untouched');
    assert.ok(text.endsWith('Why the east side of the range stays dry.\n'), 'the body survives');

    const verified = await LF.verify(applied.change, { run, project });
    assert.equal(verified.ok, true);
  } finally { cleanup(); }
});

test('a JSX strategy is planned as proposed with a text preview and is never written by apply', async () => {
  const { project, dataDir, cleanup } = sandbox('nextjs-app');
  try {
    const url = 'https://ridgeline.example/blog/rain-shadow';
    const run = A.openFixRun(dataDir, {});
    const planned = await LF.plan({ report: report(url, [metaFinding(url)]), project }, { run, dataDir });
    assert.equal(planned.changes.length, 1, JSON.stringify(planned.skipped));
    const change = planned.changes[0];
    assert.equal(change.class, 'proposed');
    assert.equal(change.strategy, 'metadata-object');
    assert.equal(change.preview.kind, 'text');
    assert.match(change.preview.body, /Manual merge required/);
    assert.equal(change.verify.method, 'manual_review');

    const before = readFileSync(join(project, 'app', '(marketing)', 'blog', '[slug]', 'page.tsx'), 'utf8');
    const out = await LF.apply(change, { run, project });
    assert.equal(out.ok, false);
    assert.equal(out.change.status, 'skipped_unready');
    assert.match(out.change.error, /Edit\/Write/);
    assert.equal(readFileSync(join(project, 'app', '(marketing)', 'blog', '[slug]', 'page.tsx'), 'utf8'), before, 'nothing was written');
  } finally { cleanup(); }
});

test('a finding pointing outside the project is skipped, never written', async () => {
  const { base, project, dataDir, cleanup } = sandbox('static');
  try {
    writeFileSync(join(base, 'outside.txt'), 'do not touch\n');
    const url = 'https://ridgeline.example/about';
    const escaping = { ...metaFinding(url), location: { url, file: '../outside.txt' } };
    const run = A.openFixRun(dataDir, {});
    const planned = await LF.plan({ report: report(url, [escaping]), project }, { run, dataDir });
    assert.equal(planned.changes.length, 0);
    assert.match(planned.skipped[0].reason, /escapes the project root/);
    assert.equal(readFileSync(join(base, 'outside.txt'), 'utf8'), 'do not touch\n');
  } finally { cleanup(); }
});

test('--answers supplies a value the audit could not know, and is never invented', async () => {
  const { project, dataDir, cleanup } = sandbox('static');
  try {
    const url = 'https://ridgeline.example/about';
    const bare = { ...metaFinding(url) };
    delete bare.fix_preview;
    const run = A.openFixRun(dataDir, {});

    const withoutAnswer = await LF.plan({ report: report(url, [bare]), project }, { run, dataDir });
    assert.equal(withoutAnswer.changes.length, 0, 'nothing is fabricated when the value is unknown');

    const answers = { 'M7.meta.description_missing': '<meta name="description" content="From the user">' };
    const withAnswer = await LF.plan({ report: report(url, [bare]), project, answers }, { run, dataDir });
    assert.equal(withAnswer.changes.length, 1);
    assert.match(withAnswer.changes[0].preview.body, /From the user/);

    // the same JSON as a string, and as a file, are both accepted
    assert.deepEqual(LF.normalizeAnswers(JSON.stringify(answers)), answers);
    assert.deepEqual(LF.normalizeAnswers({ 'M7.x': { fix_preview: 'a' } }), { 'M7.x': 'a' });
    assert.deepEqual(LF.normalizeAnswers('not json'), {});
    assert.deepEqual(LF.normalizeAnswers(undefined), {});
  } finally { cleanup(); }
});

test('a finding with no fix_preview is left to the instructions adapter', async () => {
  const { project, dataDir, cleanup } = sandbox('static');
  try {
    const url = 'https://ridgeline.example/about';
    const bare = { ...metaFinding(url) };
    delete bare.fix_preview;
    const run = A.openFixRun(dataDir, {});
    const planned = await LF.plan({ report: report(url, [bare]), project }, { run, dataDir });
    assert.equal(planned.changes.length, 0);
    assert.match(planned.skipped[0].reason, /instructions adapter/);
  } finally { cleanup(); }
});

test('preview reports drift when the file changed after planning', async () => {
  const { project, dataDir, cleanup } = sandbox('static');
  try {
    const url = 'https://ridgeline.example/about';
    const run = A.openFixRun(dataDir, {});
    const planned = await LF.plan({ report: report(url, [metaFinding(url)]), project }, { run, dataDir });
    const change = planned.changes[0];
    assert.equal(change.target.locator, 'about/index.html');
    const file = join(project, 'about', 'index.html');
    writeFileSync(file, readFileSync(file, 'utf8').replace('<title>About</title>', '<title>About us</title>'));
    const previewed = await LF.preview(change, { run, project });
    assert.equal(previewed.drifted, true, 'the plan was built against different bytes');
    assert.equal(previewed.ok, true, 'a drifted file still previews — the diff is recomputed from disk');
    assert.match(previewed.body, /About us/);
  } finally { cleanup(); }
});

test('capabilities is honest about needing --project', async () => {
  const { project, cleanup } = sandbox('static');
  try {
    const ok = await LF.capabilities({ project });
    assert.equal(ok.ready, true);
    assert.deepEqual(ok.needs, []);
    const missing = await LF.capabilities({});
    assert.equal(missing.ready, false);
    assert.deepEqual(missing.needs, ['--project <dir>']);
  } finally { cleanup(); }
});

test('CLI: plan writes the run, apply refuses without a ticket and works with one', async () => {
  const { base, project, dataDir, cleanup } = sandbox('static');
  try {
    const url = 'https://ridgeline.example/about';
    const reportPath = join(base, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report(url, [metaFinding(url)])));

    const planned = await LF.main({ _: ['plan'], data: dataDir, report: reportPath, project });
    assert.equal(planned.code, 0);
    assert.equal(planned.result.changes.length, 1);
    const runDir = planned.result.run_dir;
    const changeId = planned.result.changes[0].id;
    assert.ok(existsSync(join(runDir, 'plan.json')));

    const noTicket = await LF.main({ _: ['apply'], data: dataDir, run: runDir, change: changeId, project });
    assert.equal(noTicket.code, 2);
    assert.match(noTicket.result.results[0].error, /confirmation ticket \(no-ticket\)/);
    assert.ok(!readFileSync(join(project, 'about', 'index.html'), 'utf8').includes('name="description"'), 'nothing written without a ticket');

    const { id } = A.issueTicket(dataDir, { command: 'local-files apply ' + changeId, run: planned.result.run, change: changeId });
    const applied = await LF.main({ _: ['apply'], data: dataDir, run: runDir, change: changeId, project, ticket: id });
    assert.equal(applied.code, 0);
    assert.equal(applied.result.results[0].status, 'applied');
    assert.ok(readFileSync(join(project, 'about', 'index.html'), 'utf8').includes('name="description"'));

    const verified = await LF.main({ _: ['verify'], data: dataDir, run: runDir, change: changeId, project });
    assert.equal(verified.result.results[0].status, 'verified');

    const rolledBack = await LF.main({ _: ['rollback'], data: dataDir, run: runDir, change: changeId, project });
    assert.equal(rolledBack.result.results[0].status, 'rolled_back');
    assert.ok(!readFileSync(join(project, 'about', 'index.html'), 'utf8').includes('name="description"'));

    const log = A.loadFixRun(runDir).readLog().map((e) => e.event);
    // every op is logged once by the CLI; apply/rollback log again from inside when they act.
    // The apply that was refused for want of a ticket wrote nothing, so it is logged as `refused`
    // — an `apply` line there would put a write in the audit trail that never happened.
    assert.deepEqual(log, ['plan', 'refused', 'apply', 'apply', 'verify', 'rollback', 'rollback']);
    const refusedEvent = A.loadFixRun(runDir).readLog().find((e) => e.event === 'refused');
    assert.equal(refusedEvent.op, 'apply');
    assert.equal(refusedEvent.reason, 'no-ticket', 'the audit log says why it was refused');
  } finally { cleanup(); }
});

test('CLI: an unknown op and a missing --run are usage errors', async () => {
  const { dataDir, cleanup } = sandbox('static');
  try {
    const bad = await LF.main({ _: ['destroy'], data: dataDir });
    assert.equal(bad.code, 1);
    assert.match(bad.result.error, /usage: local-files/);
    const noRun = await LF.main({ _: ['preview'], data: dataDir });
    assert.equal(noRun.code, 1);
    assert.match(noRun.result.error, /needs --run/);
  } finally { cleanup(); }
});

test('verify with --dev-url reports pending_cache when the server has not caught up', async () => {
  const { project, dataDir, cleanup } = sandbox('static');
  try {
    const url = 'https://ridgeline.example/about';
    const run = A.openFixRun(dataDir, {});
    const planned = await LF.plan({ report: report(url, [metaFinding(url)]), project }, { run, dataDir });
    const applied = await LF.apply(A.transition(planned.changes[0], 'confirmed'), { run, project });

    const stale = async () => ({ status: 200, text: async () => '<html><head><title>About</title></head></html>' });
    const pending = await LF.verify(applied.change, { run, project, devUrl: 'http://localhost:4321', fetchImpl: stale });
    assert.equal(pending.change.status, 'pending_cache');
    assert.equal(pending.ok, null, 'a stale cache is never reported as a pass');

    const fresh = async () => ({ status: 200, text: async () => '<html><head>' + DESCRIPTION_SNIPPET + '</head></html>' });
    const good = await LF.verify(applied.change, { run, project, devUrl: 'http://localhost:4321', fetchImpl: fresh });
    assert.equal(good.change.status, 'verified');
    assert.equal(good.checks.find((c) => c.name === 'dev-url').ok, true);
  } finally { cleanup(); }
});

test('rollback without a backup fails loudly instead of claiming success', async () => {
  const { project, dataDir, cleanup } = sandbox('static');
  try {
    const url = 'https://ridgeline.example/about';
    const run = A.openFixRun(dataDir, {});
    const planned = await LF.plan({ report: report(url, [metaFinding(url)]), project }, { run, dataDir });
    const applied = A.transition(A.transition(planned.changes[0], 'confirmed'), 'applied');
    const out = await LF.rollback(applied, { run, project });
    assert.equal(out.ok, false);
    assert.match(out.change.error, /no backup/);
    assert.equal(out.change.status, 'failed');
  } finally { cleanup(); }
});

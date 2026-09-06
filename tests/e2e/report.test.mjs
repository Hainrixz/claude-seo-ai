// End-to-end: scripts/report.mjs merging a deterministic pass with the synthetic agent arrays in
// tests/fixtures/agents-sample/. No network and no crawl — the run directory is built from
// synthetic JSON so the merge rules (validate, dedupe, most-severe-wins) are asserted exactly.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXIT } from '../../scripts/lib/util.mjs';
import { writeJson } from '../../scripts/lib/store.mjs';
import {
  buildReport, expandGlob, findingKey, main as reportMain, normalizeUrl, outranks, priority,
  topActions, validateReport,
} from '../../scripts/report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENTS = join(ROOT, 'tests', 'fixtures', 'agents-sample');
const HOME = 'https://example.test/';
const POST = 'https://example.test/blog/a';

const finding = (over = {}) => ({
  id: 'M7.title.missing', module: 'M7', title: 'Synthetic deterministic finding',
  status: 'warn', severity: 4, scope: 'page', location: { url: HOME },
  evidence: { observed: 'parse-html reported title.value === null on the home snapshot.' },
  expected: 'A <title> of 50-60 characters.',
  recommendation: 'Add a <title> to the home template.',
  fixable: 'proposed',
  verification: { method: 'dom_assert', assertion: "document.querySelectorAll('title').length === 1", reproduce: 'node "/plugin/scripts/parse-html.mjs" --snapshot pages/home.json' },
  expected_impact: { axis: 'search', confidence: 'established', magnitude: 'high', rationale: 'Titles are the result link text.' },
  ...over,
});

const DETERMINISTIC = [
  finding(),
  finding({
    id: 'M4.render.csr_only_primary_content', module: 'M4', title: 'Server HTML carries the body copy',
    status: 'pass', severity: 3, scope: 'page', location: { url: HOME },
    evidence: { observed: 'The raw HTML already carries 812 words; no render was needed.' },
    verification: { method: 'render_diff', assertion: 'rendered/raw word ratio < 2', reproduce: 'node "/plugin/scripts/snapshot.mjs" --snapshot pages/home.json --render js' },
    expected_impact: { axis: 'both', confidence: 'established', magnitude: 'high', rationale: 'Crawlers that do not execute JavaScript see only the server response.' },
  }),
  finding({
    id: 'M17.sitemap.missing_indexable_url', module: 'M17', title: 'An indexable URL is missing from the sitemap',
    status: 'warn', severity: 3, scope: 'site', location: { url: POST },
    evidence: { observed: '/blog/a returns 200 and is indexable but appears in none of the 1 declared sitemaps.' },
    verification: { method: 'xml_parse', assertion: 'sitemap <loc> set contains /blog/a', reproduce: 'node "/plugin/scripts/parse-robots-sitemap.mjs" --url https://example.test/robots.txt --path /blog/a' },
    expected_impact: { axis: 'search', confidence: 'directional', magnitude: 'medium', rationale: 'A sitemap is the cheapest discovery signal for a URL with few inbound links.' },
  }),
];

const MANIFEST = {
  crawl_version: 1, plugin_version: '0.2.0', run_id: 'synthetic-run', origin: 'https://example.test',
  host: 'example.test', target: HOME, options: { render: 'static' },
  pages: [
    { url: HOME, slug: 'home', snapshot: 'pages/home.json', role: 'homepage', template: '/|WebSite', status: 200, hreflang_count: 0, render: { needed: false, used: 'none', confidence: 'high' }, weight: 3 },
    { url: POST, slug: 'blog-a', snapshot: 'pages/blog-a.json', role: 'sample', template: '/blog/*|Article', status: 200, hreflang_count: 0, render: { needed: false, used: 'none', confidence: 'high' }, weight: 2 },
  ],
  templates: [
    { key: '/|WebSite', pattern: '/', type: 'WebSite', discovered: 1, sampled: 1 },
    { key: '/blog/*|Article', pattern: '/blog/*', type: 'Article', discovered: 4, sampled: 1 },
  ],
  sampling: { mode: 'crawl', discovered: 5, sampled: 2, skipped_by_robots: { count: 1, urls: [], truncated: false } },
};

let dir;

function newRun({ agents = true, findings = DETERMINISTIC, manifest = MANIFEST } = {}) {
  const run = mkdtempSync(join(tmpdir(), 'cseo-report-e2e-'));
  if (findings) writeJson(join(run, 'findings.deterministic.json'), findings);
  if (manifest) writeJson(join(run, 'crawl.json'), { ...manifest, run_dir: run });
  if (agents) { mkdirSync(join(run, 'agents'), { recursive: true }); cpSync(AGENTS, join(run, 'agents'), { recursive: true }); }
  return run;
}

before(() => { dir = newRun(); });
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

test('the merge validates, dedupes and writes the three files', async () => {
  const r = await reportMain({ _: [dir], merge: 'agents/*.json', lang: 'en' });
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.result).slice(0, 400));
  for (const file of ['findings.json', 'report.json', 'report.md']) assert.ok(existsSync(join(dir, file)), 'missing ' + file);
  assert.equal(r.result.findings, 6, '3 deterministic + 6 valid agent findings, minus the 3 duplicates');
  assert.equal(r.result.dropped, 1);
  assert.equal(r.result.duplicates_merged, 3);
  assert.equal(r.result.coverage, 'full');
  const labels = r.result.sources.map((s) => s.label);
  assert.deepEqual(labels, ['findings.deterministic.json', 'content-eeat-analyst.json', 'schema-generator.json', 'technical-auditor.json']);
});

test('a duplicate keeps the most severe status, and needs_api never overrides a scored check', () => {
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  const title = report.findings.filter((f) => f.id === 'M7.title.missing');
  assert.equal(title.length, 1, 'the same id at the same URL is one finding');
  assert.equal(title[0].status, 'fail', 'the agent fail beats the deterministic warn and the manual_review duplicate');

  const render = report.findings.filter((f) => f.id === 'M4.render.csr_only_primary_content');
  assert.equal(render.length, 1);
  assert.equal(render[0].status, 'pass', 'an agent that could not decide must not erase a check that did');
});

test('an invalid agent finding is dropped, named and never scored', () => {
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  assert.equal(report.dropped_findings.length, 1);
  assert.equal(report.dropped_findings[0].id, 'M16.transparency.no_disclosure');
  assert.match(report.dropped_findings[0].errors[0], /expected_impact/);
  assert.ok(!report.findings.some((f) => f.id === 'M16.transparency.no_disclosure'));
  assert.equal(report.scores.search_seo.dropped_count, 1);
  assert.equal(report.scores.ai_visibility.dropped_count, 1);
});

test('the merged report conforms to the schema and carries the site rollup', () => {
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  const { ok, errors } = validateReport(report);
  assert.ok(ok, errors.join('; '));
  assert.equal(report.coverage.mode, 'full');
  assert.ok(report.coverage.modules_covered.includes('M16'), 'an agent-only module counts as covered');
  assert.ok(!report.coverage.modules_model_only.includes('M16'));
  assert.equal(report.pages.length, 2);
  assert.equal(report.site_rollup.method, 'role_weights');
  assert.equal(report.target.host, 'example.test');
  assert.equal(report.target.pages_analyzed, 2);
  // The `page` hint of the schema-generator fixture attaches its finding to the article page.
  const post = report.pages.find((p) => p.url === POST);
  assert.ok(post.findings_count >= 3, 'site-scoped plus page-scoped findings reach the page score');
});

test('report.md is rendered in the requested language', async () => {
  const es = await reportMain({ _: [dir], merge: 'agents/*.json', lang: 'es' });
  assert.equal(es.code, EXIT.OK);
  const md = readFileSync(join(dir, 'report.md'), 'utf8');
  assert.match(md, /^# Auditoría SEO \+ búsqueda con IA/);
  assert.match(md, /## Acciones prioritarias/);
  assert.match(md, /## Muestreo/);
  const en = await reportMain({ _: [dir], merge: 'agents/*.json', lang: 'en' });
  assert.equal(en.code, EXIT.OK);
  assert.match(readFileSync(join(dir, 'report.md'), 'utf8'), /^# SEO \+ AI-search audit/);
});

test('--out-md writes a second copy, --lang and --environment are validated', async () => {
  const extra = join(dir, 'summary-copy.md');
  const r = await reportMain({ _: [dir], merge: 'agents/*.json', 'out-md': extra });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.result.out_md, extra);
  assert.equal(readFileSync(extra, 'utf8'), readFileSync(join(dir, 'report.md'), 'utf8'));

  assert.equal((await reportMain({ _: [dir], lang: 'fr' })).code, EXIT.USAGE);
  assert.equal((await reportMain({ _: [dir], environment: 'prod' })).code, EXIT.USAGE);
  assert.equal((await reportMain({ _: [] })).code, EXIT.USAGE);
  assert.equal((await reportMain({ _: [join(dir, 'nope')] })).code, EXIT.USAGE);
});

test('without agent files the coverage stays deterministic and says which modules were skipped', async () => {
  const run = newRun({ agents: false });
  try {
    const r = await reportMain({ _: [run] });
    assert.equal(r.code, EXIT.OK);
    assert.equal(r.result.coverage, 'deterministic');
    const report = JSON.parse(readFileSync(join(run, 'report.json'), 'utf8'));
    assert.ok(report.coverage.modules_model_only.includes('M16'), 'E-E-A-T is model-judged and was not evaluated here');
    assert.match(readFileSync(join(run, 'report.md'), 'utf8'), /Deterministic subset/);
  } finally { rmSync(run, { recursive: true, force: true }); }
});

test('an empty run directory is a usage error, and a --merge glob that matches nothing warns', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'cseo-report-empty-'));
  try {
    const r = await reportMain({ _: [empty] });
    assert.equal(r.code, EXIT.USAGE);
    assert.match(r.result.error, /no findings to report/);
  } finally { rmSync(empty, { recursive: true, force: true }); }

  const run = newRun({ agents: false });
  try {
    const r = await reportMain({ _: [run], merge: 'agents/*.json' });
    assert.equal(r.code, EXIT.OK, 'a missing agent directory is a warning, not a failure');
    assert.ok(r.result.warnings.some((w) => /matched no files|no such directory/.test(w)));
  } finally { rmSync(run, { recursive: true, force: true }); }
});

test('a single-page run reports without a rollup', async () => {
  const run = newRun({ agents: false, manifest: { ...MANIFEST, pages: [MANIFEST.pages[0]] } });
  try {
    const r = await reportMain({ _: [run] });
    assert.equal(r.code, EXIT.OK);
    const report = JSON.parse(readFileSync(join(run, 'report.json'), 'utf8'));
    assert.ok(!('site_rollup' in report), 'one page is not a site rollup');
    assert.ok(!('pages' in report));
    assert.equal(report.target.pages_analyzed, 1);
    assert.ok(validateReport(report).ok);
  } finally { rmSync(run, { recursive: true, force: true }); }
});

test('the merge helpers behave on their own', () => {
  assert.equal(normalizeUrl('https://WWW.Example.test/a/?b=1#frag'), 'https://example.test/a?b=1');
  assert.equal(findingKey({ id: 'M1.x', scope: 'page', location: { url: 'https://example.test' } }),
    findingKey({ id: 'M1.x', scope: 'page' }, 'https://example.test/'));
  assert.equal(outranks({ status: 'fail', severity: 1 }, { status: 'warn', severity: 5 }), true);
  assert.equal(outranks({ status: 'needs_api', severity: 5 }, { status: 'pass', severity: 1 }), false);
  assert.equal(outranks({ status: 'warn', severity: 4 }, { status: 'warn', severity: 3 }), true);

  assert.equal(priority({ severity: 4, fixable: 'auto', expected_impact: { magnitude: 'high' } }), 12);
  assert.equal(priority({ severity: 3, fixable: 'advisory', expected_impact: { magnitude: 'low' } }), 1);

  const grouped = topActions([
    finding({ location: { url: HOME } }),
    finding({ location: { url: POST } }),
    finding({ id: 'M9.img.alt', module: 'M9', status: 'pass' }),
  ]);
  assert.equal(grouped.length, 1, 'the same id on two pages is one action');
  assert.equal(grouped[0].count, 2);

  const { files } = expandGlob('agents/*.json', dir);
  assert.equal(files.length, 3);
  assert.match(expandGlob('*/*.json', dir).error, /only the file name/);
});

test('buildReport is usable without writing anything', () => {
  const built = buildReport(dir, { merge: 'agents/*.json', lang: 'en' });
  assert.equal(built.ok, true);
  assert.equal(built.report.findings.length, 6);
  assert.ok(built.markdown.includes('## Scores'));
  assert.ok(validateReport(built.report).ok);
});

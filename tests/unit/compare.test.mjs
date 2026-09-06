// Unit tests for scripts/compare.mjs — the pure halves: option parsing, mode detection, location
// normalization, the findings diff and its honesty rules, the category/page deltas, the gap matrix
// and the markdown renderer. Nothing here touches the network or a run directory: the two synthetic
// reports in tests/fixtures/report-a.json / report-b.json are the fixture pair.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AXES, MAX_REFS, REGRESSION_DELTA,
  capitalizedTerms, categoryDeltas, collectRefs, commonPathPrefix, compareDirName, compareRuns,
  diffFindings, gapMatrix, loadSide, looksLikeStagingHost, looksLikeUrlRef, median, normalizeLocation,
  pageDeltas, pagePath, parseMap, presenceMatrix, readOptions, regressionGate, renderMarkdown,
  resolveMode, sideMetrics, splitRefs, structuralGaps, topicKey, verdictOf,
} from '../../scripts/compare.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = join(ROOT, 'tests', 'fixtures');
const reportA = JSON.parse(readFileSync(join(FIXTURES, 'report-a.json'), 'utf8'));
const reportB = JSON.parse(readFileSync(join(FIXTURES, 'report-b.json'), 'utf8'));
/** The rewrite `--map staging.example.com=example.com` (and what staging mode derives on its own). */
const STAGING_MAP = { 'staging.example.com': 'example.com' };

/* ------------------------------------------------------------------ options */

test('parseMap reads repeated and comma-separated host pairs', () => {
  assert.deepEqual(parseMap('staging.example.com=example.com'), STAGING_MAP);
  assert.deepEqual(parseMap(['A.test=b.test', 'c.test=d.test']), { 'a.test': 'b.test', 'c.test': 'd.test' });
  assert.deepEqual(parseMap('a.test=b.test,c.test=d.test'), { 'a.test': 'b.test', 'c.test': 'd.test' });
  assert.deepEqual(parseMap(undefined), {});
  assert.throws(() => parseMap(true), /--map needs a pair/);
  assert.throws(() => parseMap('example.com'), /--map expects/);
  assert.throws(() => parseMap('=example.com'), /--map expects/);
});

test('splitRefs accepts repeated and comma-separated values', () => {
  assert.deepEqual(splitRefs('a,b'), ['a', 'b']);
  assert.deepEqual(splitRefs(['a', 'b,c']), ['a', 'b', 'c']);
  assert.deepEqual(splitRefs(undefined), []);
  assert.throws(() => splitRefs(true), /--set needs/);
});

test('readOptions validates the enums and keeps the honest defaults', () => {
  const o = readOptions({});
  assert.equal(o.mode, 'auto');
  assert.equal(o.format, 'json');
  assert.equal(o.hostNormalize, true);
  assert.equal(o.failOnRegression, false);
  assert.equal(o.setBaseline, false);
  assert.equal(readOptions({ 'host-normalize': false }).hostNormalize, false);
  assert.equal(readOptions({ gap: 'best running shoes' }).mode, 'gap');
  assert.equal(readOptions({ gap: 'best running shoes' }).query, 'best running shoes');
  assert.throws(() => readOptions({ mode: 'sideways' }), /--mode must be one of/);
  assert.throws(() => readOptions({ format: 'csv' }), /--format must be one of/);
});

test('collectRefs understands every accepted invocation shape', () => {
  const o = readOptions({});
  assert.deepEqual(collectRefs({ _: [], baseline: 'latest', against: 'https://example.com' }, o), { refs: ['latest', 'https://example.com'], subject: null, set: [], shape: 'pairwise' });
  assert.deepEqual(collectRefs({ _: [], prod: 'a', staging: 'b' }, o), { refs: ['a', 'b'], subject: null, set: [], shape: 'pairwise' });
  assert.deepEqual(collectRefs({ _: ['a', 'b', 'c'] }, o).shape, 'list');
  const gap = collectRefs({ _: [], subject: 's', set: 'x,y' }, o);
  assert.deepEqual(gap, { refs: ['s', 'x', 'y'], subject: 's', set: ['x', 'y'], shape: 'gap' });
  assert.throws(() => collectRefs({ _: [], baseline: 'latest' }, o), /--baseline and --against/);
  assert.throws(() => collectRefs({ _: ['only-one'] }, o), /give two references/);
  assert.throws(() => collectRefs({ _: ['a', 'b', 'c', 'd', 'e', 'f'] }, o), new RegExp('at most ' + MAX_REFS));
  assert.throws(() => collectRefs({ _: ['a'] }, readOptions({ mode: 'gap' })), /gap mode needs --set/);
});

/* ------------------------------------------------------------------ mode */

test('looksLikeStagingHost only fires on the documented patterns', () => {
  for (const h of ['staging.example.com', 'staging-shop.example.com', 'preview.example.com', 'my-preview-2.example.com', 'shop.myshopify.com', 'app-git-main.vercel.app']) {
    assert.equal(looksLikeStagingHost(h), true, h);
  }
  for (const h of ['example.com', 'www.example.com', 'shop.example.com', '', null]) assert.equal(looksLikeStagingHost(h), false, String(h));
});

test('resolveMode: same host is a baseline comparison', () => {
  const r = resolveMode([{ host: 'example.com' }, { host: 'www.example.com' }], { mode: 'auto', map: {} });
  assert.equal(r.mode, 'baseline');
  assert.deepEqual(r.map, {});
});

test('resolveMode: a staging-looking host becomes staging mode and gets an implicit host map', () => {
  const r = resolveMode([{ host: 'example.com' }, { host: 'staging.example.com' }], { mode: 'auto', map: {} });
  assert.equal(r.mode, 'staging');
  assert.deepEqual(r.map, STAGING_MAP, 'the staging host is rewritten onto production so locations line up');
});

test('resolveMode: --map alone is enough to make it a staging comparison', () => {
  const r = resolveMode([{ host: 'example.com' }, { host: 'build-17.internal' }], { mode: 'auto', map: { 'build-17.internal': 'example.com' } });
  assert.equal(r.mode, 'staging');
  assert.equal(r.map['build-17.internal'], 'example.com');
});

test('resolveMode: two unrelated hosts are competitors, and three refs always are', () => {
  assert.equal(resolveMode([{ host: 'example.com' }, { host: 'rival.test' }], { mode: 'auto', map: {} }).mode, 'competitor');
  assert.equal(resolveMode([{ host: 'a.test' }, { host: 'b.test' }, { host: 'c.test' }], { mode: 'auto', map: {} }).mode, 'competitor');
  assert.equal(resolveMode([{ host: 'example.com' }, { host: 'rival.test' }], { mode: 'baseline', map: {} }).mode, 'baseline', '--mode wins over the guess');
});

test('resolveMode: two local runs of the same path are a baseline comparison', () => {
  const side = { host: null, target: '/tmp/site' };
  assert.equal(resolveMode([side, { ...side }], { mode: 'auto', map: {} }).mode, 'baseline');
});

/* ------------------------------------------------------------------ locations */

test('normalizeLocation folds www, trailing slashes, index.html and tracking parameters', () => {
  const key = (url, opts) => normalizeLocation({ url }, opts);
  assert.equal(key('https://www.example.com/a/'), key('https://example.com/a'));
  assert.equal(key('https://example.com/a/index.html'), key('https://example.com/a/'));
  assert.equal(key('https://example.com/a?utm_source=x'), key('https://example.com/a'));
  assert.equal(key('https://example.com/a?b=2&a=1'), key('https://example.com/a?a=1&b=2'));
  assert.notEqual(key('https://example.com/a'), key('https://example.com/b'));
});

test('normalizeLocation applies the host map and can be told not to normalize hosts', () => {
  const a = normalizeLocation({ url: 'https://example.com/a' }, {});
  assert.equal(normalizeLocation({ url: 'https://staging.example.com/a' }, { map: STAGING_MAP }), a);
  assert.notEqual(normalizeLocation({ url: 'https://staging.example.com/a' }, {}), a);
  assert.notEqual(
    normalizeLocation({ url: 'https://www.example.com/a' }, { hostNormalize: false }),
    normalizeLocation({ url: 'https://example.com/a' }, { hostNormalize: false }),
    'with --no-host-normalize www.example.com and example.com stay separate locations',
  );
});

test('normalizeLocation keys file paths, resources, selectors and site scope', () => {
  assert.equal(normalizeLocation({ file: 'themes/dawn/layout/theme.liquid' }), 'file:themes/dawn/layout/theme.liquid');
  assert.equal(normalizeLocation({ resource: 'robots.txt group *' }), 'resource:robots.txt group *');
  assert.equal(normalizeLocation(null), 'site');
  assert.equal(normalizeLocation({}), 'site');
  assert.equal(normalizeLocation({ url: 'https://example.com/a', selector: 'head > title' }), 'url:example.com/a|sel:head > title');
  assert.equal(
    normalizeLocation({ url: 'file:///tmp/build-1/site/blog/a.html' }, { stripPrefix: '/tmp/build-1/site' }),
    normalizeLocation({ url: 'file:///tmp/build-2/site/blog/a.html' }, { stripPrefix: '/tmp/build-2/site' }),
    'two local builds of the same tree align on their shared prefix',
  );
});

test('pagePath drops the host so the same path matches across deployments', () => {
  assert.equal(pagePath('https://staging.example.com/a/'), '/a');
  assert.equal(pagePath('https://www.example.com/a'), '/a');
  assert.equal(pagePath('file:///tmp/x/site/blog/a.html', { stripPrefix: '/tmp/x/site' }), '/blog/a.html');
});

test('commonPathPrefix finds the shared directory of a run', () => {
  assert.equal(commonPathPrefix(['/tmp/x/site/index.html', '/tmp/x/site/blog/a.html']), '/tmp/x/site');
  assert.equal(commonPathPrefix(['/tmp/x/site/index.html']), '/tmp/x/site');
  assert.equal(commonPathPrefix([]), '');
});

/* ------------------------------------------------------------------ findings diff */

const diffAB = (opts = {}) => diffFindings(reportA.findings, reportB.findings, { map: STAGING_MAP, ...opts });
const ids = (list) => list.map((f) => f.id).sort();

test('diffFindings sorts each transition into its own bucket', () => {
  const d = diffAB();
  assert.deepEqual(ids(d.fixed), ['M17.sitemap.missing_indexable_url', 'M7.title.missing']);
  assert.deepEqual(ids(d.new), ['M8.og.image_missing']);
  assert.deepEqual(ids(d.regressed), ['M7.description.too_short']);
  assert.deepEqual(ids(d.improved), ['M2.canonical.missing']);
  assert.equal(d.unchanged, 2);
});

test('diffFindings names the direction of every transition it reports', () => {
  const d = diffAB();
  const by = (list, id) => list.find((f) => f.id === id);
  assert.deepEqual({ from: by(d.fixed, 'M7.title.missing').from, to: by(d.fixed, 'M7.title.missing').to }, { from: 'fail', to: 'pass' });
  assert.deepEqual({ from: by(d.regressed, 'M7.description.too_short').from, to: by(d.regressed, 'M7.description.too_short').to }, { from: 'warn', to: 'fail' });
  assert.deepEqual({ from: by(d.improved, 'M2.canonical.missing').from, to: by(d.improved, 'M2.canonical.missing').to }, { from: 'fail', to: 'warn' });
  assert.deepEqual({ from: by(d.new, 'M8.og.image_missing').from, to: by(d.new, 'M8.og.image_missing').to }, { from: 'pass', to: 'fail' });
  assert.equal(by(d.fixed, 'M17.sitemap.missing_indexable_url').to, 'absent', 'a site-scoped finding that is gone at a covered location counts as fixed');
});

test('a needs_api transition is a coverage change, never a fixed or regressed finding', () => {
  const d = diffAB();
  const gated = d.coverage_changes.find((f) => f.id === 'M15.cwv.field_data');
  assert.ok(gated, 'the needs_api -> fail transition must be reported');
  assert.equal(gated.kind, 'gated_transition');
  assert.deepEqual({ from: gated.from, to: gated.to }, { from: 'needs_api', to: 'fail' });
  for (const bucket of ['fixed', 'new', 'regressed', 'improved']) {
    assert.equal(d[bucket].some((f) => f.id === 'M15.cwv.field_data'), false, 'M15 must not appear in ' + bucket);
  }
});

test('a finding at a location the other run never visited is a coverage change, not a result', () => {
  const d = diffAB();
  const onlyA = d.coverage_changes.find((f) => f.id === 'M9.images.alt_missing');
  const onlyB = d.coverage_changes.find((f) => f.id === 'M5.product.missing_offers');
  assert.equal(onlyA.kind, 'only_in_a');
  assert.equal(onlyB.kind, 'only_in_b');
  assert.equal(d.fixed.some((f) => f.id === 'M9.images.alt_missing'), false, 'an unvisited page is not a fix');
  assert.equal(d.new.some((f) => f.id === 'M5.product.missing_offers'), false, 'an unvisited page is not a new problem');
  assert.equal(d.coverage_changes.length, 3);
});

test('without a host map only the site-scoped findings can still match', () => {
  const d = diffFindings(reportA.findings, reportB.findings, {});
  assert.deepEqual([d.new.length, d.regressed.length, d.improved.length], [0, 0, 0], 'no per-URL transition survives without the map');
  assert.deepEqual(d.fixed.map((f) => f.id), ['M17.sitemap.missing_indexable_url'], 'site scope has no host in its key');
  assert.equal(d.unchanged, 1);
  assert.equal(d.coverage_changes.length, 14, 'every per-URL finding is now only on its own side');
});

test('the same run compared with itself reports no change at all', () => {
  const d = diffFindings(reportA.findings, reportA.findings, {});
  assert.deepEqual([d.fixed.length, d.new.length, d.regressed.length, d.improved.length, d.coverage_changes.length], [0, 0, 0, 0, 0]);
  assert.equal(d.unchanged, reportA.findings.length);
});

test('buckets are ordered by severity so the worst change reads first', () => {
  const d = diffFindings(
    [{ id: 'M7.a.x', module: 'M7', status: 'pass', severity: 1, location: { url: 'https://e.test/1' } },
      { id: 'M2.b.y', module: 'M2', status: 'pass', severity: 5, location: { url: 'https://e.test/2' } }],
    [{ id: 'M7.a.x', module: 'M7', status: 'fail', severity: 1, location: { url: 'https://e.test/1' } },
      { id: 'M2.b.y', module: 'M2', status: 'fail', severity: 5, location: { url: 'https://e.test/2' } }],
    {},
  );
  assert.deepEqual(d.new.map((f) => f.id), ['M2.b.y', 'M7.a.x']);
});

/* ------------------------------------------------------------------ scores, categories, pages */

const sideOf = (report, extra = {}) => ({
  ref: report.target.host, label: report.target.host, run_id: report.run_id, run_dir: '/runs/' + report.target.host,
  report_json: '/runs/' + report.target.host + '/report.json', host: report.target.host, target: report.target.value,
  generated_at: report.generated_at, coverage: report.coverage.mode, tier: report.tier, scores: report.scores,
  pages_scored: report.pages, findings: report.findings, report, crawl: null,
  site: { robots: null, sitemaps: null, discovery: null }, page_data: [], data_available: false, file_prefix: '',
  warnings: [], metrics: sideMetrics([]), ...extra,
});

test('categoryDeltas reports an inactive category as null instead of a zero', () => {
  const rows = categoryDeltas(sideOf(reportA), sideOf(reportB));
  const cwv = rows.find((r) => r.name === 'Core Web Vitals / Performance');
  assert.equal(cwv.a, null, 'the category carried no scored finding in run a');
  assert.equal(cwv.b, 40);
  assert.equal(cwv.delta, null, 'a category that was inactive on one side has no honest delta');
  const meta = rows.find((r) => r.name === 'On-Page & Meta');
  assert.deepEqual([meta.a, meta.b, meta.delta], [50, 30, -20]);
  assert.ok(Math.abs(rows[0].delta) >= Math.abs(rows[rows.length - 1].delta || 0), 'rows are ordered by how far they moved');
});

test('pageDeltas matches pages by path across hosts and flags the unmatched ones', () => {
  const rows = pageDeltas(sideOf(reportA), sideOf(reportB));
  const a = rows.find((r) => r.path === '/a');
  assert.equal(a.status, 'matched');
  assert.deepEqual(a.delta, { search: 10, ai: 5 });
  assert.equal(rows.find((r) => r.path === '/b').status, 'only_a');
  assert.equal(rows.find((r) => r.path === '/c').status, 'only_b');
});

/**
 * The same site audited twice with the same findings, except that the one sampled page answered
 * 429 the second time — so the rollup averaged nothing and the axis scores "rose". The real
 * allbirds case: the site did not change, one page was rate-limited.
 */
const rateLimited = () => {
  const a = { ...reportA, pages: [reportA.pages[0]] };
  const b = {
    ...reportA, run_id: 'run-b',
    scores: {
      search_seo: { ...reportA.scores.search_seo, value: 78 },
      ai_visibility: { ...reportA.scores.ai_visibility, value: 72 },
    },
    pages: [{
      ...reportA.pages[0], status: 429, scorable: false, unscored_reason: 'non_2xx_status',
      search: { value: null, raw_value: null, band: 'unscored', state: 'unscored', capped: false },
      ai: { value: null, raw_value: null, band: 'unscored', state: 'unscored', capped: false },
    }],
  };
  return [sideOf(a), sideOf(b, { run_id: 'run-b' })];
};

test('a page that stopped answering 2xx is a coverage change, never a score move', () => {
  const [a, b] = rateLimited();
  const rows = pageDeltas(a, b);
  const row = rows.find((r) => r.path === '/a');
  assert.equal(row.status, 'matched');
  assert.equal(row.coverage_change, true);
  assert.deepEqual(row.delta, { search: null, ai: null }, 'no delta can be computed against a page that was not scored');
  assert.equal(row.b.http_status, 429);
  assert.equal(row.b.scored, false);
  assert.match(row.coverage_note, /HTTP 429/);

  const doc = compareRuns(a, b, { mode: 'baseline' });
  assert.equal(doc.page_coverage.same_pages, false);
  assert.deepEqual(doc.page_coverage.changes.map((c) => [c.path, c.kind, c.status_b]), [['/a', 'dropped_from_scoring', 429]]);
  assert.deepEqual([doc.page_coverage.scored_a, doc.page_coverage.scored_b], [1, 0]);
  assert.ok(doc.warnings.some((w) => /did not score the same pages/.test(w)), doc.warnings.join(' | '));
  assert.deepEqual([doc.scores.search_seo.delta, doc.scores.ai_visibility.delta], [8, 12], 'the axis numbers are still reported…');
  assert.deepEqual([doc.findings.fixed.length, doc.findings.regressed.length, doc.findings.new.length], [0, 0, 0]);
  assert.equal(doc.verdict, 'unchanged', '…but a rollup over a different page set never reads as an improvement');
  const md = renderMarkdown(doc);
  assert.match(md, /Pages that changed coverage/);
  assert.equal(/## Pages that moved/.test(md), false, 'an unmeasured page never appears as a page that moved');
});

test('two runs that scored the same pages keep the axis deltas in the verdict', () => {
  const a = sideOf({ ...reportA, pages: [reportA.pages[0]] });
  const b = sideOf({ ...reportB, pages: [reportB.pages[0]] });
  const doc = compareRuns(a, b, { mode: 'staging', map: STAGING_MAP });
  assert.equal(doc.page_coverage.same_pages, true);
  assert.deepEqual(doc.page_coverage.changes, []);
  assert.equal(doc.warnings.some((w) => /did not score the same pages/.test(w)), false);
});

test('the presence matrix never lists an endpoint that answered 200 with an HTML app shell', () => {
  const disc = (found, probes) => ({ summary: { found, statuses: {} }, probes });
  const withShell = sideOf(reportA, {
    label: 'rival.example', data_available: true,
    // A run captured before the soft-404 rule: summary.found still lists both paths.
    site: { robots: null, sitemaps: null, discovery: disc(['/llms.txt', '/llms-full.txt'], {
      '/llms.txt': { ok: true, looks_like_html: false, content_type: 'text/plain' },
      '/llms-full.txt': { ok: true, looks_like_html: true, content_type: 'text/html; charset=utf-8' },
    }) },
  });
  const plain = sideOf(reportB, { label: 'me.example', data_available: true, site: { robots: null, sitemaps: null, discovery: null } });
  const rows = presenceMatrix([withShell, plain]);
  const features = rows.filter((r) => r.kind === 'agentic_endpoint').map((r) => r.feature);
  assert.deepEqual(features, ['endpoint:/llms.txt'], 'the app shell at /llms-full.txt is not a published endpoint');
});

test('verdictOf blends the two kinds of evidence', () => {
  const none = { search_seo: { delta: 0 }, ai_visibility: { delta: 0 } };
  const empty = { fixed: [], new: [], regressed: [], improved: [] };
  assert.equal(verdictOf(none, empty), 'unchanged');
  assert.equal(verdictOf(none, { ...empty, fixed: [1] }), 'improved');
  assert.equal(verdictOf(none, { ...empty, regressed: [1] }), 'regressed');
  assert.equal(verdictOf(none, { ...empty, fixed: [1], new: [1] }), 'mixed');
  assert.equal(verdictOf({ search_seo: { delta: -9 }, ai_visibility: { delta: null } }, empty), 'regressed');
  assert.equal(verdictOf({ search_seo: { delta: -9 }, ai_visibility: { delta: null } }, empty, { samePages: false }), 'unchanged',
    'a rollup over a different page set is a coverage change, not a regression');
});

test('compareRuns assembles the whole document and its coverage warning', () => {
  const doc = compareRuns(sideOf(reportA), sideOf(reportB), { mode: 'staging', map: STAGING_MAP });
  assert.equal(doc.compare_version, 1);
  assert.equal(doc.mode, 'staging');
  assert.equal(doc.verdict, 'mixed');
  assert.deepEqual(doc.scores.search_seo, { a: 70, b: 66, delta: -4, band_a: 'C', band_b: 'D', state_a: 'scored', state_b: 'scored', provisional_a: false, provisional_b: false, capped_a: false, capped_b: false });
  assert.equal(doc.scores.ai_visibility.delta, 3);
  assert.equal(doc.coverage_warning, null, 'both runs are deterministic-only');
  assert.equal(doc.gaps.available, false, 'neither synthetic report has page snapshots');
  assert.equal(doc.gaps.schema_types, 'unavailable');
  assert.equal(doc.findings.fixed.length, 2);
  assert.deepEqual(doc.a.run_id, reportA.run_id);
});

test('compareRuns warns when the two runs measured different amounts', () => {
  const doc = compareRuns(sideOf(reportA), sideOf(reportB, { coverage: 'full' }), { mode: 'baseline', map: STAGING_MAP });
  assert.match(doc.coverage_warning, /coverage modes differ/);
});

test('regressionGate trips on a worse finding or an axis that lost more than two points', () => {
  const doc = compareRuns(sideOf(reportA), sideOf(reportB), { mode: 'staging', map: STAGING_MAP });
  const gate = regressionGate(doc);
  assert.equal(gate.applicable, true);
  assert.equal(gate.tripped, true);
  assert.ok(gate.reasons.some((r) => r.gate === 'findings' && r.regressed === 1 && r.new === 1));
  assert.ok(gate.reasons.some((r) => r.gate === 'axis' && r.axis === 'search' && r.delta < REGRESSION_DELTA));
  const clean = compareRuns(sideOf(reportA), sideOf(reportA), { mode: 'baseline' });
  assert.equal(regressionGate(clean).tripped, false);
  assert.equal(regressionGate({ mode: 'competitor' }).applicable, false, 'there is no findings diff to gate on across sites');
});

/* ------------------------------------------------------------------ metrics and gaps */

const fakePage = (url, { headings = [], types = [], words = 120, terms = [], questions = 0, answered = 0, links = [] } = {}) => ({
  url,
  parsed: {
    headings: headings.map((t) => ({ level: 2, text: t, region: 'article' })),
    jsonld: types.map((t) => ({ ok: true, type: [t], data: {} })),
    word_count: words,
    anchors: links.map((href) => ({ href, abs: href, scheme: 'http', internal: false })),
    hreflang: [],
  },
  snapshot: { render: { used: 'none', needed: false }, header_links: { alternates: [] } },
  text_metrics: {
    lang: 'en',
    numbers: { substantive: 6, all: 8, content_words: words },
    answer: { question_headings: questions, question_headings_without_direct_answer: questions - answered, has_tldr_or_summary: false },
    terms,
  },
});

const fakeSide = (label, pages, extra = {}) => {
  const page_data = pages;
  return {
    ref: label, label, run_id: 'run-' + label, run_dir: '/runs/' + label, report_json: null, host: label,
    target: 'https://' + label + '/', generated_at: null, coverage: 'deterministic', tier: 0, scores: {},
    pages_scored: [], findings: [], report: null, crawl: null,
    site: { robots: null, sitemaps: null, discovery: { summary: { found: [], statuses: {} } } },
    page_data, data_available: true, file_prefix: '', warnings: [], metrics: sideMetrics(page_data), ...extra,
  };
};

test('sideMetrics aggregates the comparable facts of a run', () => {
  const side = fakeSide('a.test', [
    fakePage('https://a.test/1', { headings: ['How long does shipping take?', 'Returns'], types: ['FAQPage', 'Organization'], words: 100, links: ['https://en.wikipedia.org/wiki/Shoe'] }),
    fakePage('https://a.test/2', { headings: ['Returns'], types: ['FAQPage'], words: 300 }),
  ]);
  assert.deepEqual(side.metrics.schema_types, ['FAQPage', 'Organization']);
  assert.equal(side.metrics.schema_counts.FAQPage, 2);
  assert.equal(side.metrics.word_count.median, 200);
  assert.equal(side.metrics.pages, 2);
  assert.deepEqual(side.metrics.entity_links.authority_hosts, ['en.wikipedia.org']);
  assert.equal(side.metrics.heading_topics[0].topic, 'returns', 'the topic seen on both pages sorts first');
  assert.equal(side.metrics.render.used.none, 2);
});

test('topicKey, median and capitalizedTerms behave as the matrices assume', () => {
  assert.equal(topicKey('  How long does SHIPPING take? '), 'how long does shipping take');
  assert.equal(topicKey('Envíos y devoluciones'), 'envios y devoluciones');
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  const terms = capitalizedTerms('We ship with Royal Mail. Royal Mail delivers on Saturday. The service is fast.');
  assert.equal(terms.get('royal mail'), 2);
  assert.equal(terms.has('the service'), false, 'a sentence-initial "The …" is not a proper noun');
});

test('structuralGaps reports the two sides and refuses to invent what it cannot see', () => {
  const a = fakeSide('a.test', [fakePage('https://a.test/1', { headings: ['Shipping'], types: ['Organization'], words: 100, questions: 2, answered: 1 })]);
  const b = fakeSide('b.test', [fakePage('https://b.test/1', { headings: ['Shipping', 'Returns'], types: ['Organization', 'FAQPage'], words: 400, questions: 4, answered: 4 })]);
  const gaps = structuralGaps(a, b);
  assert.equal(gaps.available, true);
  assert.deepEqual(gaps.schema_types.only_b, ['FAQPage']);
  assert.deepEqual(gaps.schema_types.only_a, []);
  assert.deepEqual(gaps.headings.only_b_topics.map((t) => t.topic), ['returns']);
  assert.equal(gaps.headings.overlap_jaccard, 0.5);
  assert.equal(gaps.word_count.delta_median, 300);
  assert.equal(gaps.answer_blocks.delta.direct_answers, 3);

  const blind = structuralGaps(a, { ...b, data_available: false });
  assert.equal(blind.available, false);
  for (const key of ['schema_types', 'agentic_endpoints', 'ai_crawler_posture', 'headings', 'answer_blocks', 'entity_links', 'word_count', 'render', 'hreflang']) {
    assert.equal(blind[key], 'unavailable', key + ' must say so rather than report a zero');
  }
});

test('structuralGaps compares the AI-crawler posture of the two runs', () => {
  const posture = (allowed) => ({ summary: { found: [] } } && { ai_posture: { search: { GPTBot: { root_allowed: allowed, url_allowed: null, via: 'rule' } } } });
  const a = fakeSide('a.test', [fakePage('https://a.test/1')], { site: { robots: posture(true), sitemaps: null, discovery: { summary: { found: ['/llms.txt'] } } } });
  const b = fakeSide('b.test', [fakePage('https://b.test/1')], { site: { robots: posture(false), sitemaps: null, discovery: { summary: { found: ['/llms.txt', '/agents.md'] } } } });
  const gaps = structuralGaps(a, b);
  assert.deepEqual(gaps.ai_crawler_posture.blocked_only_b, ['GPTBot']);
  assert.deepEqual(gaps.ai_crawler_posture.blocked_only_a, []);
  assert.deepEqual(gaps.agentic_endpoints.only_b, ['/agents.md']);
});

/* ------------------------------------------------------------------ competitor + gap */

test('presenceMatrix reports an unknown as null, never as a "no"', () => {
  const a = fakeSide('a.test', [fakePage('https://a.test/1', { types: ['Organization'] })]);
  const b = fakeSide('b.test', [], { data_available: false, metrics: sideMetrics([]) });
  const rows = presenceMatrix([a, b]);
  const schema = rows.find((r) => r.feature === 'schema:Organization');
  assert.deepEqual(schema.values, [true, null]);
});

test('gapMatrix lists what at least two comparison pages have and the subject does not', () => {
  const subject = fakeSide('mine.test', [fakePage('https://mine.test/p', { headings: ['Materials'], types: ['Product'], words: 300, terms: [['acme', 3]] })]);
  const rivals = [
    fakeSide('r1.test', [fakePage('https://r1.test/p', { headings: ['Materials', 'How long does shipping take?', 'Sizing'], types: ['Product', 'FAQPage'], words: 900, terms: [['gore tex', 4]] })]),
    fakeSide('r2.test', [fakePage('https://r2.test/p', { headings: ['How long does shipping take?', 'Warranty'], types: ['FAQPage'], words: 1100, terms: [['gore tex', 2]] })]),
  ];
  const m = gapMatrix(subject, rivals, { query: 'best waterproof boots' });
  assert.equal(m.mode, 'gap');
  assert.equal(m.query, 'best waterproof boots');
  assert.equal(m.threshold, 2);
  assert.deepEqual(m.matrix.heading_topics.map((t) => t.topic), ['how long does shipping take'], 'a topic on one rival only is not a pattern');
  assert.deepEqual(m.matrix.schema_types.map((t) => t.type), ['FAQPage']);
  assert.deepEqual(m.matrix.terms.map((t) => t.term), ['gore tex']);
  assert.equal(m.matrix.word_count.subject_median, 300);
  assert.equal(m.matrix.word_count.set_median, 1000);
  assert.equal(m.matrix.word_count.delta, 700);
  assert.equal(m.confidence, 'directional', 'every row of a gap matrix is directional');
  assert.ok(m.honesty.length >= 2);
});

test('gapMatrix says so when the comparison set is a single page', () => {
  const subject = fakeSide('mine.test', [fakePage('https://mine.test/p', { headings: ['Materials'] })]);
  const m = gapMatrix(subject, [fakeSide('r1.test', [fakePage('https://r1.test/p', { headings: ['Sizing'] })])], { query: 'q' });
  assert.equal(m.threshold, 1);
  assert.deepEqual(m.matrix.heading_topics.map((t) => t.topic), ['sizing']);
  assert.ok(m.notes.some((n) => /only one comparison page/.test(n)));
  assert.ok(m.notes.some((n) => /relaxed/.test(n)));
});

/* ------------------------------------------------------------------ output */

test('compareDirName pairs the two runs and stays a legal directory name', () => {
  const name = compareDirName([{ label: 'example.com', run_id: '2026-09-01T10-00-00Z' }, { label: 'staging.example.com', run_id: '2026-09-04T10-00-00Z' }]);
  assert.match(name, /^example\.com-.*__staging\.example\.com-.*$/);
  assert.equal(/[^A-Za-z0-9._-]/.test(name.replace(/__/g, '')), false);
  const long = compareDirName([{ label: 'x'.repeat(200), run_id: 'y'.repeat(200) }, { label: 'z'.repeat(200), run_id: 'w'.repeat(200) }]);
  assert.ok(long.length <= 120, 'a long pair is hashed instead of overflowing the filesystem');
});

test('renderMarkdown renders each document shape without throwing', () => {
  const pairwise = renderMarkdown(compareRuns(sideOf(reportA), sideOf(reportB), { mode: 'staging', map: STAGING_MAP }));
  assert.match(pairwise, /# Comparison \(staging\): mixed/);
  assert.match(pairwise, /\| search \| 70 \(C\) \| 66 \(D\) \| -4 \|/);
  assert.match(pairwise, /coverage changes \(never counted as fixed or regressed\)/);

  const gapDoc = gapMatrix(
    fakeSide('mine.test', [fakePage('https://mine.test/p', { headings: ['Materials'], words: 300 })]),
    [fakeSide('r1.test', [fakePage('https://r1.test/p', { headings: ['Sizing'], types: ['FAQPage'], words: 900 })])],
    { query: 'best boots' },
  );
  const gapMd = renderMarkdown(gapDoc);
  assert.match(gapMd, /# Content gap: "best boots"/);
  assert.match(gapMd, /directional/);
});

test('loadSide refuses a directory that carries no report when scores are the point', () => {
  const r = loadSide({ dir: join(FIXTURES, 'site'), ref: 'fixtures/site', kind: 'dir', report_json: null, pages_count: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /no readable report\.json/);
  assert.equal(r.code, 1);
});

test('looksLikeUrlRef separates a pointer, a path and a host', () => {
  assert.equal(looksLikeUrlRef('https://example.com'), true);
  assert.equal(looksLikeUrlRef('example.com'), true);
  assert.equal(looksLikeUrlRef('latest'), false);
  assert.equal(looksLikeUrlRef('baseline:example.com'), false);
  assert.equal(looksLikeUrlRef(ROOT), false);
  assert.equal(looksLikeUrlRef(''), false);
});

test('the axis table is the report.json one, never a blend', () => {
  assert.deepEqual(AXES.map(([k]) => k), ['search_seo', 'ai_visibility']);
});

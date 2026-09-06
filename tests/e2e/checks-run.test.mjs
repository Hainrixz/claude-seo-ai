// End-to-end: crawl the local fixture server with scripts/crawl.mjs, load the persisted run with
// loadRunContext() and run the whole checks registry over it.
//
// Nothing leaves the machine: the fixture server binds 127.0.0.1 on an ephemeral port and the run
// directory lives under os.tmpdir(). The point of this test is the join between the three layers —
// crawl manifest, page snapshots and site artifacts — so it asserts findings that can only exist
// when all three are read correctly: a title shared by two URLs, the /old redirect chain, the
// X-Robots-Tag on /noindex, a sitemap URL the page itself excludes, the Content-Signal line in
// robots.txt, the discovery files, and the M22 counts.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../helpers/server.mjs';
import { main as crawlMain } from '../../scripts/crawl.mjs';
import { EXIT } from '../../scripts/lib/util.mjs';
import { validateFinding } from '../../scripts/lib/validate-finding.mjs';
import { snapshotUrl } from '../../scripts/snapshot.mjs';
import { loadRunContext, runChecks } from '../../scripts/checks/index.mjs';
import { check as sitemapsCheck } from '../../scripts/checks/sitemaps.mjs';
import { check as wordpressCheck } from '../../scripts/checks/platform-wordpress.mjs';

let srv, out, ctx, findings, stats;

before(async () => {
  srv = await startServer();
  out = mkdtempSync(join(tmpdir(), 'cseo-checks-e2e-'));
  const U = (p) => srv.url + p;
  // --render static keeps Chrome out of the test; the seeds pull in the pages the fixture does not
  // link from the homepage (the header-controlled /noindex page, the redirect source, the shop).
  const r = await crawlMain({
    _: [srv.url],
    out,
    render: 'static',
    pages: 18,
    'per-template': 3,
    'link-status': 40,
    seeds: [U('/noindex'), U('/shop'), U('/blog/b?ref=sitemap&v=2')].join(','),
    json: true,
  });
  assert.equal(r.code, EXIT.OK);
  ctx = loadRunContext(r.result.run_dir, {});
  ({ findings, stats } = await runChecks(ctx));
});

after(async () => {
  await srv.close();
  try { rmSync(out, { recursive: true, force: true }); } catch { /* best effort */ }
});

const ids = () => findings.map((f) => f.id);
const byId = (id) => findings.filter((f) => f.id === id);
const has = (id) => byId(id).length > 0;
const U = (p) => srv.url + p;

test('the whole registry runs over a real crawl without a single check failing', () => {
  assert.equal(stats.errors.length, 0, 'check errors: ' + JSON.stringify(stats.errors));
  assert.ok(stats.checks_run >= 20, 'expected the whole registry to run, got ' + stats.checks_run);
  assert.ok(findings.length > 20, 'expected a real finding set, got ' + findings.length);
  assert.ok(ctx.pages.length >= 8, 'expected the crawl to sample the fixture site, got ' + ctx.pages.length);
  assert.ok(ctx.crawl && ctx.crawl.pages.length === ctx.pages.length, 'every manifest page is loaded');
  assert.ok(ctx.site.robots && ctx.site.sitemaps && ctx.site.discovery, 'the three site artifacts are loaded');
});

test('every finding validates against the schema and carries a runnable reproduce command', () => {
  for (const f of findings) {
    const { ok, errors } = validateFinding(f);
    assert.ok(ok, f.id + ': ' + errors.join('; '));
    assert.match(f.verification.reproduce, /^node "\/.*\/scripts\/[a-z-]+\.mjs"/, f.id + ' reproduce must be an absolute command');
    assert.ok(f.evidence.observed.length > 10, f.id + ' must quote what it observed');
    if (['needs_api', 'manual_review', 'not_applicable'].includes(f.status)) {
      assert.ok(f.severity === 0 || f.status === 'needs_api', f.id + ' unscored statuses carry severity 0 (needs_api may keep its module severity)');
    }
  }
  const unscored = findings.filter((f) => f.status === 'needs_api').length;
  assert.equal(unscored, stats.needs_api, 'stats.needs_api matches the findings');
});

test('no finding renders an object into its prose', () => {
  // One assertion for the whole registry: any check that hands listing()/clip() an array of example
  // objects would ship "[object Object]" to the reader, and the evidence — the entire point of a
  // finding — would be unusable. This caught five M22 ids and one M21 id in round 2.
  for (const f of findings) {
    for (const field of [f.title, f.evidence.observed, f.evidence.snippet, f.expected, f.recommendation, f.verification.assertion]) {
      if (typeof field !== 'string') continue;
      assert.ok(!field.includes('[object Object]'), f.id + ' renders an object into its prose: ' + field);
    }
  }
});

test('schema-invalid findings would be counted, not silently dropped', () => {
  assert.equal(stats.dropped, 0, 'this fixture run drops nothing: ' + JSON.stringify(stats.dropped_findings));
  assert.ok(Array.isArray(stats.dropped_findings), 'runChecks reports which findings were dropped');
});

test('two URLs serving one title are reported as a duplicate', () => {
  const dupes = byId('M7.title.duplicate_across_urls');
  assert.equal(dupes.length, 1, 'the fixture has exactly one duplicated title (/blog/b and its ?ref= sitemap twin)');
  assert.match(dupes[0].evidence.observed, /Second article/);
  assert.match(dupes[0].evidence.observed, /ref=sitemap/);
  assert.equal(dupes[0].scope, 'site');
});

test('the /old -> /older -> /blog/a chain is reported with its hops', () => {
  const chains = byId('M2.redirect.chain');
  assert.ok(chains.length >= 1, 'expected the fixture redirect chain, got ' + chains.length);
  const chain = chains.find((f) => f.evidence.observed.includes('/old'));
  assert.ok(chain, 'the chain finding names the /old URL: ' + chains.map((f) => f.evidence.observed).join(' | '));
  assert.match(chain.evidence.observed, /2 hops/);
  assert.match(chain.evidence.observed, /301/);
  assert.equal(chain.severity, 4);
});

test('the X-Robots-Tag on /noindex is read from the response headers, not the HTML', () => {
  const page = ctx.pages.find((p) => p.url === U('/noindex'));
  assert.ok(page, 'the seeded /noindex page is in the run');
  assert.equal(page.snapshot.headers['x-robots-tag'], 'noindex, nofollow');
  assert.deepEqual(page.parsed.robots_meta, [], 'the fixture serves the directive only in the header, never as a meta tag');
  assert.equal(page.snapshot.robots_directives.effective.noindex, true);
  assert.deepEqual(page.snapshot.robots_directives.sources, ['header']);

  // Its Link header canonical points elsewhere, so this is the lethal pair, not a coherent exclusion.
  const conflict = byId('M2.canonical.noindex_conflict').find((f) => f.location.url === U('/noindex'));
  assert.ok(conflict, 'expected the canonical/noindex conflict on /noindex');
  assert.match(conflict.evidence.observed, /X-Robots-Tag: noindex/);
  assert.equal(conflict.severity, 4);

  const blocked = byId('M14.ai_eligibility.not_indexable');
  assert.equal(blocked.length, 1, 'only one page is blocked, so the finding stays at page scope');
  assert.equal(blocked[0].scope, 'page');
  assert.equal(blocked[0].severity, 4, 'a single page must not reach the capping severity');
});

test('a sitemap URL that the page itself excludes is reported', () => {
  const excluded = byId('M17.sitemap.noindex_url');
  assert.equal(excluded.length, 1);
  assert.match(excluded[0].evidence.observed, /ref=sitemap/);
  assert.match(excluded[0].evidence.observed, /canonical ->/);
  assert.ok(has('M17.sitemap.missing_indexable_url'), 'the crawl also found indexable URLs the sitemap omits');
});

test('sitemap URLs that redirect or error are classified from the statuses the crawl really saw', async () => {
  // The shared fixture sitemap lists only healthy URLs (other suites assert its exact url_count), so
  // this test builds the join it cannot: a sitemap whose <loc> entries are the redirecting and 404
  // URLs of this very server. Both statuses come from real responses, not from a hand-written page.
  const erroring = ctx.pages.find((p) => p.status === 404);
  assert.ok(erroring, 'the crawl snapshotted the linked 404 (/shop/missing-item)');

  const old = await snapshotUrl(U('/old'), { persist: false, render: 'static', artifacts: 'none' });
  assert.equal(old.ok, true, 'the redirect source is fetchable');
  assert.equal(old.snapshot.redirects.hops, 2, '/old -> /older -> /blog/a');
  const redirecting = {
    slug: 'old', url: old.snapshot.target.final_url, snapshot: old.snapshot, parsed: old.snapshot.parsed,
    parsed_rendered: null, html_path: null, html: null, rendered_html: null,
    status: old.snapshot.status, template: null, role: null, in_sitemap: true, inlinks: null, ua_diff: null,
  };

  const probeCtx = {
    ...ctx,
    pages: [...ctx.pages, redirecting],
    site: {
      ...ctx.site,
      sitemaps: {
        found: 1,
        url_count: 2,
        declared: [srv.url + '/sitemap.xml'],
        files: [{ url: srv.url + '/sitemap.xml', status: 200, kind: 'urlset' }],
        sample: [
          { loc: U('/old'), lastmod: null, sitemap: srv.url + '/sitemap.xml' },
          { loc: erroring.url, lastmod: null, sitemap: srv.url + '/sitemap.xml' },
        ],
        lastmod: { count: 0, min: null, max: null },
      },
    },
  };
  const out2 = await sitemapsCheck.run(probeCtx);
  for (const f of out2) assert.ok(validateFinding(f).ok, f.id);
  const redirected = out2.find((f) => f.id === 'M17.sitemap.redirected_url');
  assert.ok(redirected, 'expected M17.sitemap.redirected_url, got ' + out2.map((f) => f.id).join(', '));
  assert.match(redirected.evidence.observed, /\/old -> .*\/blog\/a/);
  const errored = out2.find((f) => f.id === 'M17.sitemap.error_url');
  assert.ok(errored, 'expected M17.sitemap.error_url');
  assert.match(errored.evidence.observed, /HTTP 404/);
});

test('a legacy sitemap path that redirects onto the declared one is not a second source', async () => {
  // End to end over the real fixture server, where /wp-sitemap.xml 301s to /sitemap_index.xml, which
  // 302s to /sitemap.xml. This is the shape that made the check tell a WordPress publisher it was
  // serving three sitemaps and to "disable the core sitemap" — the site was doing the right thing.
  const wpCtx = { ...ctx, profile: { platform: { id: 'wordpress', confidence: 'high' }, cms_plugins: [], target: {} } };
  const out = await wordpressCheck.run(wpCtx);
  for (const f of out) assert.ok(validateFinding(f).ok, f.id);
  const dupe = out.find((f) => f.id === 'M17.wordpress.duplicate_sitemaps');
  assert.ok(dupe, 'the check still reports what the extra paths serve, got ' + out.map((f) => f.id).join(', '));
  assert.equal(dupe.status, 'pass', dupe.evidence.observed);
  assert.match(dupe.evidence.observed, /redirects to/);
  assert.equal(out.some((f) => f.id === 'M17.wordpress.no_sitemap_any'), false);
});

test('the Content-Signal line in robots.txt is reported without ever claiming it is enforced', () => {
  const signals = findings.filter((f) => f.id.startsWith('M14.content_signal'));
  assert.ok(signals.length >= 2, 'the fixture declares search=yes, ai-input=no, ai-train=no');
  const aiInput = byId('M14.content_signal.ai_input_no')[0];
  assert.ok(aiInput, 'ai-input=no must be reported');
  assert.match(aiInput.evidence.observed, /Content-Signal: search=yes, ai-input=no, ai-train=no/);
  assert.equal(aiInput.severity, 3);
  assert.equal(byId('M14.content_signal.ai_train_no')[0].status, 'pass', 'a training opt-out costs no citations');
  assert.ok(!has('M14.content_signal.search_no'), 'the fixture allows search');
  for (const f of signals) assert.notEqual(f.expected_impact.confidence, 'established');

  // The fixture blocks GPTBot (training only) and explicitly allows OAI-SearchBot.
  assert.ok(has('M14.retrieval.allowed'), 'no citation-capable crawler is blocked in the fixture');
  assert.ok(!has('M14.citation_bots.blocked'));
});

test('the discovery files the fixture publishes are reported, and the missing ones are not invented', () => {
  assert.ok(!has('M21.llmstxt.missing'), '/llms.txt is served by the fixture');
  assert.ok(!has('M21.llmstxt.malformed'), 'and it parses as llms.txt');
  assert.equal(byId('M21.agents_md.present')[0].status, 'pass');
  const ucp = byId('M21.ucp.present_valid')[0];
  assert.ok(ucp, '/.well-known/ucp validates');
  assert.equal(ucp.status, 'pass', 'the fixture is not an e-commerce vertical, so M21 keeps the UCP block');
  assert.equal(byId('M21.agentic_sitemap.present')[0].status, 'pass');
  assert.ok(!has('M21.ai_catalog.present'), '/.well-known/ai-catalog.json is a 404 on the fixture');
  for (const f of findings.filter((x) => x.module === 'M21')) assert.ok(f.severity <= 2, f.id + ' severity ' + f.severity);
});

test('M22 counts the fixture pages as semantically clean and states what it could not check', () => {
  const clean = byId('M22.semantics.ok');
  const contentPages = ctx.pages.filter((p) => p.status >= 200 && p.status < 300);
  assert.ok(clean.length >= contentPages.length - 2, 'most fixture pages have no improvised controls: ' + clean.length + '/' + contentPages.length);
  assert.ok(clean.every((f) => f.status === 'pass' && f.severity === 3));

  const jsHref = byId('M22.links.href_javascript');
  assert.equal(jsHref.length, 1, 'only the homepage carries the javascript: menu link');
  assert.match(jsHref[0].evidence.observed, /javascript:/);

  const notCheckable = byId('M22.static.not_checkable');
  assert.equal(notCheckable.length, 1);
  assert.equal(notCheckable[0].status, 'not_applicable');
  assert.match(notCheckable[0].evidence.observed, /cursor_affordance/);
  assert.equal(byId('M22.lighthouse.agentic_browsing')[0].status, 'needs_api');
  for (const f of findings.filter((x) => x.module === 'M22')) assert.notEqual(f.expected_impact.confidence, 'established');
});

test('modules that had no data report needs_api instead of a silent pass', () => {
  const needsApi = findings.filter((f) => f.status === 'needs_api').map((f) => f.id);
  assert.ok(needsApi.includes('M15.field.needs_api'), 'no PSI key in the test environment');
  assert.ok(needsApi.some((id) => id.startsWith('M4.render')), 'no renderer ran, so the delta is unmeasured');
  assert.ok(!ids().includes('M2.robots.unintended_noindex'), 'the escalation is never emitted without a human confirming intent');
  assert.equal(stats.manual_review + stats.needs_api + stats.not_applicable > 0, true);
});

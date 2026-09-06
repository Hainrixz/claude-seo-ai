// End-to-end tests for scripts/crawl.mjs against the local fixture server (tests/helpers/server.mjs):
// template clustering, the sampling table and every skip reason, robots (a disallowed URL is never
// requested, a 5xx robots.txt crawls the target only, Crawl-delay paces the crawl), link-status probes
// including the /old redirect chain and the 404, the crawl.json shape, manifestFromSinglePage() and the
// exit codes through the real CLI. Nothing leaves the machine: the fixture server binds 127.0.0.1 and the
// only other address touched is a closed loopback port. Nothing is written outside os.tmpdir().

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server.mjs';
import { main, manifestFromSinglePage, probeLinkStatus, sampleByPattern, dedupeKey, CRAWL_VERSION, ROLE_WEIGHTS } from '../../scripts/crawl.mjs';
import { snapshotUrl } from '../../scripts/snapshot.mjs';
import { readJson } from '../../scripts/lib/store.mjs';
import { looksLikeHtml, isHtmlDocument, mediaTypeOf } from '../../scripts/lib/site.mjs';
import { EXIT } from '../../scripts/lib/util.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CRAWL = join(ROOT, 'scripts', 'crawl.mjs');
const PAGE_KEYS = ['canonical', 'depth', 'discovered_via', 'h1', 'hops', 'hreflang_count', 'in_sitemap', 'inlinks', 'ms',
  'noindex', 'outlinks_internal', 'render', 'role', 'slug', 'snapshot', 'status', 'template', 'title', 'url', 'weight'];

let srv, out;
before(async () => { srv = await startServer(); out = mkdtempSync(join(tmpdir(), 'cseo-crawl-')); });
after(async () => { await srv.close(); try { rmSync(out, { recursive: true, force: true }); } catch { /* best effort */ } });
const U = (p) => srv.url + p;
/** Keep Chrome out of every test: the crawler defaults to --render static anyway. */
const run = (args) => main({ _: [], out, render: 'static', ...args });

function cli(args, env = {}) {
  return new Promise((done) => {
    execFile(process.execPath, [CRAWL, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* leave null */ }
      done({ status: err ? (typeof err.code === 'number' ? err.code : 2) : 0, stdout, stderr, json });
    });
  });
}

test('templates emerge from URL pattern + page type, and the manifest has the documented shape', async () => {
  const before = srv.hits.length;
  const r = await run({ _: [U('/shop')], pages: 12, 'per-template': 2, 'link-status': 20, json: true });
  assert.equal(r.code, EXIT.OK);
  const m = r.result;

  assert.equal(m.crawl_version, CRAWL_VERSION);
  assert.equal(typeof m.plugin_version, 'string');
  assert.match(m.run_id, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-\d+)?$/);
  assert.equal(m.origin, srv.url);
  assert.equal(m.host, '127.0.0.1:' + srv.port);
  assert.equal(m.target, U('/shop'));
  assert.ok(Date.parse(m.started_at) <= Date.parse(m.finished_at));
  assert.equal(m.options.pages, 12);
  assert.equal(m.options.per_template, 2);
  assert.equal(m.options.respect_robots, true);
  assert.match(m.options.ua, /claude-seo-ai/);

  // At least two templates, and the /shop/* pattern splits on the page type it carries.
  const keys = m.templates.map((t) => t.key);
  assert.ok(m.templates.length >= 2, keys.join(' '));
  assert.ok(keys.includes('/shop/*|Product'), keys.join(' '));
  assert.ok(keys.includes('/shop/*|Article'), 'the sizing guide shares the URL pattern but not the type: ' + keys.join(' '));
  const product = m.templates.find((t) => t.key === '/shop/*|Product');
  assert.equal(product.sampled, 3, 'red-shoes (JSON-LD), green-cap (JSON-LD) and blue-hat (body class only)');
  assert.ok(product.evidence.includes('jsonld:Product'));
  assert.ok(product.evidence.includes('body-class:template-product=>Product'), product.evidence.join(' '));
  assert.ok(product.split, 'the pattern carries two types');
  assert.ok(product.examples.length >= 1 && product.examples.every((u) => u.startsWith(srv.url)));
  assert.ok(product.weight > 0 && product.weight <= 1);
  for (const t of m.templates) assert.ok(t.discovered >= t.sampled, t.key);

  // Roles: the origin is always the homepage, the requested URL is always the target.
  const homepage = m.pages.filter((p) => p.role === 'homepage');
  const target = m.pages.filter((p) => p.role === 'target');
  assert.equal(homepage.length, 1);
  assert.equal(homepage[0].url, U('/'));
  assert.equal(homepage[0].weight, ROLE_WEIGHTS.homepage);
  assert.equal(target.length, 1);
  assert.equal(target[0].url, U('/shop'));
  assert.equal(target[0].weight, ROLE_WEIGHTS.target);
  assert.equal(target[0].template, '/shop|CollectionPage');
  assert.equal(target[0].discovered_via, 'target');

  // Every page carries the documented fields and points at a snapshot that exists.
  for (const p of m.pages) {
    assert.deepEqual(Object.keys(p).sort(), PAGE_KEYS, p.url);
    assert.match(p.snapshot, /^pages[\\/].+\.json$/);
    assert.ok(existsSync(join(m.run_dir, p.snapshot)), p.snapshot);
    assert.equal(typeof p.status, 'number');
    assert.equal(typeof p.outlinks_internal, 'number');
    assert.equal(p.render.used, 'none');
  }
  const home = homepage[0];
  assert.equal(home.title, 'Fixture Site Home');
  assert.equal(home.h1, 'Fixture Site');
  assert.equal(home.canonical, U('/'));
  assert.equal(home.noindex, false);
  assert.equal(home.in_sitemap, true, '/ is listed in the gzipped child sitemap');
  assert.ok(home.inlinks >= 3, 'every fixture page links home');
  const article = m.pages.find((p) => p.url === U('/blog/a'));
  assert.equal(article.hreflang_count, 3);

  // Graph + budget.
  assert.equal(m.graph.nodes.length, m.sampling.discovered);
  assert.ok(m.graph.edge_count > 0);
  assert.equal(m.graph.edges.length, m.graph.edge_count);
  assert.equal(m.graph.truncated, false);
  for (const [a, b] of m.graph.edges) {
    assert.ok(Number.isInteger(a) && Number.isInteger(b));
    assert.ok(m.graph.nodes[a] && m.graph.nodes[b]);
  }
  assert.ok(m.budget.requests > 0);
  assert.equal(m.budget.delay_ms, 0);
  assert.equal(m.budget.max_reached, false);

  // robots: one fetch for the whole crawl, and the disallowed page is never requested.
  assert.equal(m.robots.status, 200);
  assert.equal(m.robots.mode, 'parsed');
  assert.equal(m.robots.root_allowed, true);
  assert.equal(m.robots.path, 'site/robots.json');
  assert.equal(m.robots.ua_token, 'claude-seo-ai');
  assert.deepEqual(m.robots.recorded_uas, ['Googlebot', 'Bingbot']);
  assert.ok(m.robots.verdicts.Googlebot && m.robots.verdicts.Bingbot, 'other bots verdicts are recorded, not acted on');
  const since = srv.hits.slice(before);
  assert.equal(since.filter((h) => h.path === '/robots.txt').length, 1, 'robots.txt is fetched once per run, not once per page');
  assert.equal(since.some((h) => h.path === '/admin/secret'), false, 'a disallowed URL is never requested, by any method');
  assert.equal(m.sampling.skipped_by_robots.count, 1);
  assert.equal(m.sampling.skipped_by_robots.urls[0].url, U('/admin/secret'));
  assert.deepEqual(m.sampling.skipped_by_robots.urls[0].rule, { type: 'disallow', path: '/admin/', line: 3 });

  // sitemaps: declared child + gzipped child were read and sampled round-robin.
  assert.equal(m.sitemaps.path, 'site/sitemaps.json');
  assert.ok(m.sitemaps.urls >= 5);
  assert.ok(m.sitemaps.sampled >= 3);

  // crawl.json on disk is the same document.
  const onDisk = readJson(join(m.run_dir, 'crawl.json'));
  assert.equal(onDisk.run_id, m.run_id);
  assert.equal(onDisk.pages.length, m.pages.length);
  assert.ok(existsSync(join(m.run_dir, '..', 'latest.json')), 'the run is finalized once, at the end of the crawl');
});

test('sampling: --pages and --per-template bound the crawl and every skip is logged', async () => {
  const r = await run({ _: [U('/shop')], pages: 3, 'per-template': 1, 'link-status': 0 });
  assert.equal(r.code, EXIT.OK);
  const s = r.result;
  assert.equal(s.pages, 3);
  assert.equal(s.sample.length, 3);
  assert.deepEqual(s.sample.slice(0, 2).map((p) => p.role), ['homepage', 'target'], 'homepage and target are always sampled first');
  assert.ok(s.discovered > s.pages);
  assert.ok(s.skipped.budget + s.skipped.per_template >= s.discovered - s.pages - s.skipped.robots);
  assert.equal(s.budget.pages_exhausted, true);
  assert.ok(s.warnings.some((w) => /discovered but not sampled/.test(w)));
  for (const t of s.template_table) assert.ok(t.sampled <= t.discovered);
});

test('--max caps the frontier and says so in warnings and sampling.skipped_by_cap', async () => {
  const r = await run({ _: [U('/shop')], pages: 4, max: 6, 'link-status': 0, json: true });
  assert.equal(r.code, EXIT.OK);
  const m = r.result;
  assert.ok(m.sampling.discovered <= 6, 'the frontier never grows past --max');
  assert.ok(m.sampling.skipped_by_cap.count > 0);
  assert.equal(m.sampling.skipped_by_cap.urls[0].max, 6);
  // A URL linked from five pages hits the cap five times and is ONE skipped URL: the count and the
  // list must describe the same thing, or the report overstates what was left out.
  const capped = m.sampling.skipped_by_cap.urls.map((u) => u.url);
  assert.deepEqual(capped.length, new Set(capped).size, JSON.stringify(capped));
  assert.equal(m.sampling.skipped_by_cap.count, capped.length, 'the count is distinct URLs, not discoveries');
  assert.equal(m.budget.max_reached, true);
  assert.ok(m.warnings.some((w) => /--max 6/.test(w)), m.warnings.join(' | '));
});

test('link-status probes the /old redirect chain with HEAD and flags the 404', async () => {
  const before = srv.hits.length;
  const r = await run({ _: [U('/shop')], pages: 3, 'link-status': 20, json: true });
  const ls = r.result.link_status;
  assert.equal(ls.budget, 20);
  assert.ok(ls.checked >= 5);
  assert.equal(ls.checked, ls.results.length);

  const old = ls.results.find((x) => x.url === U('/old'));
  assert.ok(old, 'the discovered-but-unsampled /old is probed');
  assert.equal(old.method, 'HEAD');
  assert.deepEqual(old.chain.map((c) => c.status), [301, 302]);
  assert.deepEqual(old.chain.map((c) => c.location), ['/older', '/blog/a']);
  assert.equal(old.final_url, U('/blog/a'));
  assert.equal(old.hops, 2);
  assert.equal(old.status, 200);
  assert.equal(old.redirect, true);
  assert.equal(old.broken, false);

  const missing = ls.results.find((x) => x.url === U('/shop/missing-item'));
  assert.ok(missing);
  assert.equal(missing.status, 404);
  assert.equal(missing.broken, true);
  assert.equal(missing.ok, false);
  assert.equal(ls.broken >= 1, true);
  assert.equal(ls.redirects >= 1, true);

  const since = srv.hits.slice(before);
  assert.ok(since.some((h) => h.method === 'HEAD' && h.path === '/old'), 'probes use HEAD, not a full GET');
  assert.equal(since.some((h) => h.path === '/admin/secret'), false, 'probes respect robots too');
});

test('Crawl-delay is honoured: one request at a time, paced', async () => {
  const slow = await startServer({ robotsBody: 'User-agent: *\nCrawl-delay: 1\nDisallow: /admin/\n' });
  try {
    const r = await run({ _: [slow.url + '/'], pages: 2, concurrency: 4, 'link-status': 0, json: true });
    assert.equal(r.code, EXIT.OK);
    const m = r.result;
    assert.equal(m.robots.crawl_delay_s, 1);
    assert.equal(m.options.delay_ms, 1000);
    assert.equal(m.options.concurrency, 1, 'a declared Crawl-delay forces a single lane');
    assert.equal(m.pages.length, 2);
    assert.ok(m.budget.elapsed_ms >= 900, 'two paced page fetches take at least one delay: ' + m.budget.elapsed_ms);
    assert.ok(m.warnings.some((w) => /Crawl-delay 1s honoured/.test(w)), m.warnings.join(' | '));
  } finally { await slow.close(); }
});

test('a 5xx robots.txt means crawl nothing: only the requested URL is fetched', async () => {
  const broken = await startServer({ robotsStatus: 500 });
  try {
    const r = await run({ _: [broken.url + '/blog/a'], pages: 8, 'link-status': 5, json: true });
    assert.equal(r.code, EXIT.OK);
    const m = r.result;
    assert.equal(m.robots.mode, 'disallow-all');
    assert.equal(m.pages.length, 1);
    assert.equal(m.pages[0].url, broken.url + '/blog/a');
    assert.equal(m.pages[0].role, 'target');
    assert.ok(m.warnings.some((w) => /robots\.txt is unavailable \(status 500\)/.test(w)), m.warnings.join(' | '));
    assert.equal(broken.hits.filter((h) => h.path === '/about').length, 0, 'nothing else is crawled');
    assert.equal(broken.hits.filter((h) => h.path === '/').length, 0);
    assert.equal(m.link_status.checked, 0, 'nothing is probed either');
  } finally { await broken.close(); }
});

test('--no-robots crawls the disallowed page and records that it did', async () => {
  const before = srv.hits.length;
  const r = await run({ _: [U('/')], pages: 12, robots: false, 'link-status': 0, json: true });
  const m = r.result;
  assert.equal(m.options.respect_robots, false);
  assert.equal(m.robots.respected, false);
  assert.equal(m.robots.root_allowed, true, 'the robots.txt verdicts are still recorded');
  assert.ok(m.pages.some((p) => p.url === U('/admin/secret')));
  assert.equal(srv.hits.slice(before).some((h) => h.path === '/admin/secret'), true);
  assert.equal(m.sampling.skipped_by_robots.count, 0);
  assert.ok(m.warnings.some((w) => /--no-robots/.test(w)));
});

test('--depth 0 crawls only the seeds and logs what the depth limit cut', async () => {
  const r = await run({ _: [U('/')], pages: 12, depth: 0, 'link-status': 0, json: true });
  const m = r.result;
  assert.ok(m.pages.length >= 2, 'the sitemap sample seeds are depth 0 too');
  assert.ok(m.pages.every((p) => p.depth === 0), JSON.stringify(m.pages.map((p) => [p.url, p.depth])));
  assert.ok(m.sampling.skipped_by_depth.count > 0);
  assert.equal(m.sampling.skipped_by_depth.urls[0].depth, 1);
  assert.equal(m.sampling.depth, 0);
});

test('--exclude keeps URLs out of the frontier and logs the skip', async () => {
  const r = await run({ _: [U('/')], pages: 12, exclude: '/blog/', 'link-status': 0, json: true });
  const m = r.result;
  assert.ok(m.sampling.skipped_by_filter.count >= 2, JSON.stringify(m.sampling.skipped_by_filter));
  assert.equal(m.sampling.skipped_by_filter.urls[0].filter, 'exclude');
  assert.equal(m.pages.some((p) => p.url.includes('/blog/')), false);
  assert.ok(m.sampling.skipped_by_filter.urls.some((u) => u.filter === 'exclude-after-redirect' && u.url === U('/blog/a')),
    '/old redirects into the excluded space: the page is dropped and the reason recorded');
  assert.deepEqual(m.options.exclude, ['/\\/blog\\//']);
});

test('--include restricts the frontier to what matches (seeds always survive)', async () => {
  const r = await run({ _: [U('/')], pages: 12, include: 'shop', 'link-status': 0, json: true });
  const m = r.result;
  assert.equal(m.pages[0].role, 'homepage', 'the origin seed is never filtered out');
  assert.ok(m.sampling.skipped_by_filter.count >= 3);
  assert.ok(m.sampling.skipped_by_filter.urls.every((u) => u.filter === 'include'));
});

test('a non-HTML response is fetched but never sampled as a page', async () => {
  const r = await run({ _: [U('/md-host')], pages: 12, 'link-status': 0, json: true });
  assert.equal(r.code, EXIT.OK);
  const m = r.result;
  assert.ok(m.pages.some((p) => p.url === U('/md-host')), 'the HTML host page is sampled');
  assert.equal(m.pages.some((p) => p.url === U('/notes.md')), false, 'a text/markdown body is not a web page');
  const skip = m.sampling.skipped_by_filter.urls.find((u) => u.url === U('/notes.md'));
  assert.ok(skip, 'the drop is logged, never silent: ' + JSON.stringify(m.sampling.skipped_by_filter));
  assert.equal(skip.filter, 'non-html-response');
  assert.match(skip.content_type, /^text\/markdown/);
  assert.ok(srv.hits.some((h) => h.path === '/notes.md'), 'it was fetched — the type is only known from the response');
  assert.equal(m.templates.some((t) => (t.examples || []).some((u) => u === U('/notes.md'))), false,
    'a machine-readable artifact is not a page template: it never appears in the sampling table');

  const direct = await run({ _: [U('/notes.md')], pages: 2, 'link-status': 0, json: true });
  assert.ok(direct.result.pages.some((p) => p.url === U('/notes.md')),
    'an explicitly targeted URL is still audited: the user asked for that URL');
});

test('--seeds adds URLs the link graph never reaches', async () => {
  const r = await run({ _: [U('/')], pages: 6, seeds: U('/fr/blog/a'), 'link-status': 0, json: true });
  const m = r.result;
  assert.equal(m.sampling.seeds.extra, 1);
  const fr = m.pages.find((p) => p.url === U('/fr/blog/a'));
  assert.ok(fr, 'the French page is linked from nowhere; only a seed reaches it');
  assert.equal(fr.discovered_via, 'seeds');
  assert.equal(fr.template, '/fr/blog/*|');
});

test('manifestFromSinglePage synthesizes the same shape for a snapshot-only run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cseo-one-'));
  try {
    const s = await snapshotUrl(U('/shop/red-shoes'), { out: dir, render: 'static' });
    assert.equal(s.ok, true);
    const m = manifestFromSinglePage(s.run.dir, { target: U('/shop/red-shoes'), write: true });
    assert.equal(m.crawl_version, CRAWL_VERSION);
    assert.equal(m.pages.length, 1);
    assert.deepEqual(Object.keys(m.pages[0]).sort(), PAGE_KEYS);
    assert.equal(m.pages[0].role, 'target');
    assert.equal(m.pages[0].template, '/shop/*|Product');
    assert.equal(m.pages[0].weight, ROLE_WEIGHTS.target);
    assert.equal(m.pages[0].inlinks, null, 'no crawl ran: unknown is null, never 0');
    assert.equal(m.pages[0].in_sitemap, null);
    assert.equal(m.options.crawled, false);
    assert.equal(m.templates.length, 1);
    assert.equal(m.graph.edges.length, 0);
    assert.ok(m.warnings.some((w) => /no crawl was run/.test(w)));
    assert.equal(m.robots.status, 200, 'the snapshot run already fetched robots.txt');
    assert.ok(existsSync(join(s.run.dir, 'crawl.json')), 'write: true saves it next to the pages');
    assert.equal(manifestFromSinglePage(join(dir, 'nope')), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the site artifacts a crawl writes: expected well-known 404s are probe misses, not sitemap errors', async () => {
  const r = await run({ _: [U('/about')], pages: 1, 'link-status': 0, json: true });
  const sm = readJson(join(r.result.run_dir, 'site', 'sitemaps.json'));
  assert.equal(sm.found, 3, 'the declared index and its two children — the two redirect aliases are not extra sitemaps');
  assert.equal(sm.probe_misses, 2, 'the two well-known paths this site does not serve at all');
  assert.equal(sm.errors_total, 0, 'a guessed path that 404s is the probe answering "no", not a site error');
  const aliases = sm.files.filter((f) => f.alias_of);
  assert.deepEqual(aliases.map((f) => f.url).sort(), [U('/sitemap_index.xml'), U('/wp-sitemap.xml')].sort(),
    'the legacy paths redirect onto the declared sitemap and are recorded as aliases of it');
  assert.ok(aliases.every((f) => f.final_url === U('/sitemap.xml')));
  assert.equal(r.result.sitemaps.probe_hits, 0, 'nothing was found by guessing: everything came from robots.txt');
});

test('looksLikeHtml sees through a BOM or a leading comment (the soft-404 hint depends on it)', () => {
  assert.equal(looksLikeHtml('<!doctype html><html>'), true);
  assert.equal(looksLikeHtml('   <html lang="en">'), true);
  assert.equal(looksLikeHtml('<!--\n  BRAND\n-->\n<!doctype html>'), true, 'an HTML page that opens with a banner comment is still HTML');
  assert.equal(looksLikeHtml('\uFEFF<!-- a --> <!-- b --><html>'), true);
  assert.equal(looksLikeHtml('# llms.txt\n\n- one'), false);
  assert.equal(looksLikeHtml('{"ok":true}'), false);
  assert.equal(looksLikeHtml('<!-- ' + 'x'.repeat(9000) + ' --><html>'), false, 'an unclosed comment inside the sniff window is not a claim of HTML');
  assert.equal(looksLikeHtml(''), false);
  assert.equal(looksLikeHtml(null), false);
});

test('isHtmlDocument believes the content-type, and the body when the header is wrong', () => {
  assert.equal(isHtmlDocument({ 'content-type': 'text/html; charset=utf-8' }, '<html>'), true);
  assert.equal(isHtmlDocument({ 'Content-Type': 'application/xhtml+xml' }, '<html>'), true, 'the header name is matched case-insensitively');
  assert.equal(isHtmlDocument({ 'content-type': 'text/markdown; charset=utf-8' }, '# Notes'), false);
  assert.equal(isHtmlDocument({ 'content-type': 'application/json' }, '{"ok":true}'), false);
  assert.equal(isHtmlDocument({ 'content-type': 'text/plain' }, '<!doctype html><html>'), true, 'a mislabelled HTML page is still a page');
  assert.equal(isHtmlDocument({}, '# not html'), true, 'an undeclared type is judged by status alone, as before');
  assert.equal(isHtmlDocument(null, null), true);
  assert.equal(mediaTypeOf({ 'content-type': 'TEXT/HTML; charset=UTF-8' }), 'text/html');
  assert.equal(mediaTypeOf({}), '');
});

test('probeLinkStatus falls back to a ranged GET when HEAD is refused', async () => {
  const calls = [];
  const fake = async (url, opts) => {
    calls.push({ url, method: opts.method, range: opts.headers && opts.headers.range });
    if (opts.method === 'HEAD') return { status: 405, ok: false, headers: {}, error: null };
    return { status: 200, ok: true, headers: {}, error: null };
  };
  const r = await probeLinkStatus('https://x.test/a', { fetchImpl: fake });
  assert.equal(r.method, 'GET');
  assert.equal(r.status, 200);
  assert.equal(r.broken, false);
  assert.deepEqual(calls.map((c) => c.method), ['HEAD', 'GET']);
  assert.equal(calls[1].range, 'bytes=0-0', 'the fallback downloads one byte, not the page');
});

test('probeLinkStatus reports a redirect loop as broken instead of spinning', async () => {
  const fake = async (url) => ({ status: 302, ok: false, headers: { location: url.endsWith('/1') ? '/2' : '/1' }, error: null });
  const r = await probeLinkStatus('https://x.test/1', { fetchImpl: fake });
  assert.equal(r.loop, true);
  assert.equal(r.broken, true);
  assert.ok(r.chain.length >= 2);
});

test('sampleByPattern spreads a sitemap sample across templates instead of taking the first N', () => {
  const urls = ['/blog/a-post', '/blog/b-post', '/blog/c-post', '/shop/red-shoes', '/shop/blue-hat', '/about'];
  assert.deepEqual(sampleByPattern(urls, 3), ['/blog/a-post', '/shop/red-shoes', '/about']);
  assert.equal(sampleByPattern(urls, 99).length, 6);
  assert.deepEqual(sampleByPattern([], 5), []);
});

test('dedupeKey folds www, trailing slashes, index.html and tracking parameters', () => {
  assert.equal(dedupeKey('https://www.x.test/a/'), dedupeKey('https://x.test/a'));
  assert.equal(dedupeKey('https://x.test/index.html'), dedupeKey('https://x.test/'));
  assert.equal(dedupeKey('https://x.test/a?utm_source=n'), dedupeKey('https://x.test/a'));
  assert.notEqual(dedupeKey('https://x.test/a?ref=n'), dedupeKey('https://x.test/a'));
});

test('usage errors exit 1; an unreachable target exits 2', async () => {
  const noTarget = await run({});
  assert.equal(noTarget.code, EXIT.USAGE);
  assert.match(noTarget.result.error, /provide a target URL/);

  const badRegex = await run({ _: [U('/')], include: '(' });
  assert.equal(badRegex.code, EXIT.USAGE);
  assert.match(badRegex.result.error, /--include is not a valid regular expression/);

  const badNumber = await run({ _: [U('/')], pages: 'lots' });
  assert.equal(badNumber.code, EXIT.USAGE);
  assert.match(badNumber.result.error, /--pages must be an integer/);

  const notUrl = await run({ _: ['./index.html'] });
  assert.equal(notUrl.code, EXIT.USAGE);
  assert.match(notUrl.result.error, /not a URL/);

  const dead = await run({ _: ['http://127.0.0.1:1/'], artifacts: 'none', 'link-status': 0 });
  assert.equal(dead.code, EXIT.RUNTIME);
  assert.equal(dead.result.error, 'fetch failed');
  assert.equal(dead.result.status, 0);
});

test('the real CLI writes crawl.json and prints paths (--quiet) or the manifest (--json)', async () => {
  const quiet = await cli([U('/about'), '--out', out, '--pages', '2', '--link-status', '0', '--render', 'static', '--quiet']);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.ok(quiet.json.crawl.endsWith('crawl.json'));
  assert.equal(quiet.json.pages, 2);
  assert.ok(existsSync(quiet.json.crawl));
  assert.deepEqual(Object.keys(quiet.json).sort(), ['crawl', 'pages', 'run_dir']);

  const json = await cli([U('/about'), '--out', out, '--pages', '1', '--link-status', '0', '--render', 'static', '--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(json.json.crawl_version, CRAWL_VERSION);
  assert.equal(json.json.pages.length, 1);
  assert.equal(json.json.pages[0].role, 'homepage', 'with --pages 1 the origin still wins the first slot');

  const bad = await cli(['--pages', '2']);
  assert.equal(bad.status, 1);
  assert.match(bad.json.error, /provide a target URL/);
});

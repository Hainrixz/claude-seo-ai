// End-to-end tests for scripts/snapshot.mjs against the local fixture server (tests/helpers/server.mjs) and
// temp directories: redirect chain/loop/truncation flags, headers, header canonical + hreflang, --max-bytes,
// site artifacts (robots verdicts, gz sitemap child, discovery statuses, saved bodies, reuse within a run),
// --ua files, --no-persist and --quiet through the real CLI, exit codes, local directory / file modes, the
// framework-source-dir error, retention, --snapshot read-back through loadInput/parse-html, and a Chrome
// render that runs only when findChrome() locates a browser. Nothing leaves the machine; nothing is written
// outside os.tmpdir().

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server.mjs';
import { main, snapshotUrl, parseRobotsDirectives, effectiveRobots, SNAPSHOT_VERSION } from '../../scripts/snapshot.mjs';
import { main as parseHtml } from '../../scripts/parse-html.mjs';
import { loadInput, readSnapshot, inputFailure, EXIT } from '../../scripts/lib/util.mjs';
import { findChrome } from '../../scripts/lib/renderers.mjs';
import { readJson, readIndex } from '../../scripts/lib/store.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SNAP = join(ROOT, 'scripts', 'snapshot.mjs');
let srv, out;
before(async () => { srv = await startServer(); out = mkdtempSync(join(tmpdir(), 'cseo-snap-')); });
after(async () => { await srv.close(); try { rmSync(out, { recursive: true, force: true }); } catch { /* best effort */ } });
const U = (p) => srv.url + p;
const STATIC = { render: 'static' }; // keep Chrome out of every test but the dedicated one
const run = (args) => main({ _: [], out, ...STATIC, ...args });
const hits = (p) => srv.hits.filter((h) => h.path === p).length;

/** Run the real CLI asynchronously (a sync spawn would starve the in-process fixture server). */
function cli(args, env = {}) {
  return new Promise((done) => {
    execFile(process.execPath, [SNAP, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* leave null */ }
      done({ status: err ? (typeof err.code === 'number' ? err.code : 2) : 0, stdout, stderr, json });
    });
  });
}

test('redirect chain: hops, final URL, real status/headers, persisted files, latest pointer and index', async () => {
  const r = await run({ _: [U('/old')] });
  assert.equal(r.code, EXIT.OK);
  const s = r.result;
  assert.equal(s.final_url, U('/blog/a'));
  assert.equal(s.status, 200);
  assert.equal(s.ok, true);
  assert.equal(s.hops, 2);
  assert.deepEqual(s.redirects, { loop: false, truncated: false, http_to_https: false, host_changed: false, www_normalized: false });
  assert.equal(s.host_key, '127.0.0.1_' + srv.port);
  assert.match(s.run_id, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
  assert.equal(s.root, out);
  assert.equal(s.root_source, '--out');
  assert.match(s.snapshot, /[\\/]pages[\\/]blog_a--[0-9a-f]{8}\.json$/);
  assert.equal(s.counts.title, 'First article');
  assert.equal(s.counts.h1, 1);
  assert.equal(s.counts.canonicals, 1);
  assert.equal(s.counts.hreflang, 3);
  assert.equal(s.counts.links_internal, 2);
  assert.equal(s.render.used, 'none');
  assert.equal(s.tier, 0);
  assert.equal(s.error, null);
  // the persisted snapshot
  const snap = readJson(s.snapshot);
  assert.equal(snap.snapshot_version, SNAPSHOT_VERSION);
  assert.equal(typeof snap.plugin_version, 'string');
  assert.equal(snap.run_id, s.run_id);
  assert.equal(snap.target.kind, 'url');
  assert.equal(snap.target.requested_url, U('/old'));
  assert.equal(snap.target.final_url, U('/blog/a'));
  assert.equal(snap.target.host, '127.0.0.1:' + srv.port);
  assert.equal(snap.request.ua_preset, 'default');
  assert.match(snap.request.user_agent, /claude-seo-ai/);
  assert.equal(snap.status_chain.length, 3);
  assert.deepEqual(snap.status_chain.map((h) => h.status), [301, 302, 200]);
  assert.match(snap.headers['content-type'], /text\/html/);
  assert.equal(snap.headers['set-cookie'], undefined);
  assert.deepEqual(snap.cookie_names, []);
  assert.equal(snap.body.bytes > 0, true);
  assert.equal(snap.body.sha256.length, 64);
  assert.equal(snap.body.truncated, false);
  assert.equal(typeof snap.timing.ttfb_ms, 'number');
  assert.equal(snap.raw_html_path, 'pages/' + snap.target.slug + '.html');
  assert.equal(snap.rendered_html_path, null);
  assert.match(readFileSync(join(s.run_dir, snap.raw_html_path), 'utf8'), /First article/);
  assert.equal(snap.parsed.title.value, 'First article');
  assert.equal(snap.parsed_rendered, null);
  assert.equal(snap.robots_directives.effective.noindex, false);
  assert.deepEqual(snap.robots_directives.sources, []);
  assert.equal(snap.render.confidence, 'reduced', 'thin fixture page + --render static is honestly reported as reduced');
  assert.match(snap.render.hint, /--render auto/);
  assert.equal(snap.html_inline, undefined, 'persisted snapshots never inline HTML');
  // pointer + index
  const hostDir = dirname(s.run_dir);
  assert.equal(readJson(join(hostDir, 'latest.json')).run, s.run_id);
  const idx = readIndex(out);
  assert.ok(idx.hosts[s.host_key].runs.includes(s.run_id));
  assert.equal(idx.hosts[s.host_key].latest, s.run_id);
});

test('redirect loop is a finding, not a failure: exit 0, loop flag, 3xx status, empty body, render not applicable', async () => {
  const r = await run({ _: [U('/loop1')], artifacts: 'none' });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.result.redirects.loop, true);
  assert.equal(r.result.status, 302);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error, 'redirect loop');
  assert.equal(r.result.render.confidence, 'not_applicable');
  assert.ok(r.result.warnings.includes('redirect loop'));
  const snap = readJson(r.result.snapshot);
  assert.equal(snap.status_chain.length, 2);
  assert.equal(snap.body.bytes, 0);
});

test('--max-hops truncates the chain and flags it', async () => {
  const r = await run({ _: [U('/hop/5')], 'max-hops': '3', artifacts: 'none' });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.result.redirects.truncated, true);
  assert.equal(r.result.hops, 3);
  assert.match(r.result.error, /too many redirects/);
});

test('HTTP Link header canonical + hreflang and X-Robots-Tag are captured', async () => {
  const r = await run({ _: [U('/noindex')], artifacts: 'none', json: true });
  assert.equal(r.code, EXIT.OK);
  const s = r.result;
  assert.equal(s.header_links.canonical, U('/canonical-target'));
  assert.deepEqual(s.header_links.alternates, [{ hreflang: 'es', url: U('/es/header-alt') }]);
  assert.equal(s.header_links.all.length, 2);
  assert.equal(s.robots_directives.header.raw, 'noindex, nofollow');
  assert.deepEqual(s.robots_directives.header.directives.map((d) => d.name), ['noindex', 'nofollow']);
  assert.equal(s.robots_directives.effective.noindex, true);
  assert.equal(s.robots_directives.effective.nofollow, true);
  assert.equal(s.robots_directives.effective.indexable, false);
  assert.equal(s.robots_directives.effective.snippet_eligible, true);
  assert.deepEqual(s.robots_directives.sources, ['header']);
  assert.equal(s.snapshot_path, join(s.run_dir, s.raw_html_path.replace(/\.html$/, '.json')));
});

test('robots directive parsing: bot-scoped X-Robots-Tag, max-snippet, meta robots merge (most restrictive wins)', () => {
  const d = parseRobotsDirectives('googlebot: noindex, nofollow, max-snippet:50, unavailable_after: 25 Jun 2030 15:00:00 PST');
  assert.deepEqual(d.map((x) => [x.agent, x.name, x.value]), [
    ['googlebot', 'noindex', null], ['googlebot', 'nofollow', null], ['googlebot', 'max-snippet', '50'], ['googlebot', 'unavailable_after', '25 Jun 2030 15:00:00 PST'],
  ]);
  const eff = effectiveRobots([...d, ...parseRobotsDirectives('max-snippet:0, nosnippet', 'bingbot'), ...parseRobotsDirectives('noarchive')]);
  assert.equal(eff.noindex, true);
  assert.equal(eff.max_snippet, 50);
  assert.equal(eff.nosnippet, false, 'bingbot-only directives do not count toward the Google view');
  assert.equal(eff.noarchive, true);
  assert.equal(eff.snippet_eligible, true);
  assert.deepEqual(eff.agents_seen, ['all', 'bingbot', 'googlebot']);
  assert.equal(effectiveRobots(parseRobotsDirectives('none')).nofollow, true);
  assert.equal(effectiveRobots(parseRobotsDirectives('max-snippet:0')).snippet_eligible, false);
});

test('--max-bytes truncates the body and says so', async () => {
  const r = await run({ _: [U('/big')], 'max-bytes': '4096', artifacts: 'none' });
  assert.equal(r.code, EXIT.OK);
  assert.ok(r.result.warnings.some((w) => /truncated at --max-bytes 4096/.test(w)), r.result.warnings.join(' | '));
  const snap = readJson(r.result.snapshot);
  assert.equal(snap.body.truncated, true);
  assert.equal(snap.body.bytes, 4096);
});

test('site artifacts once per run: robots verdicts for the audited path, gz sitemap child, discovery statuses, saved bodies, reuse', async () => {
  const robotsHits = hits('/robots.txt');
  const r = await run({ _: [U('/admin/secret')] });
  assert.equal(r.code, EXIT.OK);
  const s = r.result;
  assert.equal(s.site.reused, false);
  assert.equal(s.site.robots.mode, 'parsed');
  assert.equal(s.site.robots.status, 200);
  assert.equal(s.site.robots.googlebot_allowed, true, 'Googlebot has its own Allow: / group');
  assert.equal(s.site.robots.content_signals, true);
  assert.equal(s.site.sitemaps_found, 3);
  assert.equal(s.site.sitemap_urls, 5);
  assert.deepEqual(s.site.discovery, {
    '/llms.txt': 200, '/llms-full.txt': 404, '/agents.md': 200, '/.well-known/ucp': 200, '/.well-known/ai-catalog.json': 404, '/sitemap_agentic_discovery.xml': 200, '/api/ucp/mcp': 404,
  });
  assert.equal(s.site.https_enforced, null, 'http origin: not applicable');
  const snap = readJson(s.snapshot);
  assert.deepEqual(snap.site, { robots: 'site/robots.json', sitemaps: 'site/sitemaps.json', sitemap_urls: 'site/sitemap-urls.txt', discovery: 'site/discovery.json', robots_txt: 'site/robots.txt' });
  const robots = readJson(join(s.run_dir, snap.site.robots));
  assert.equal(robots.path, '/admin/secret');
  assert.equal(robots.verdicts['claude-seo-ai'].allowed, false, 'wildcard group disallows /admin/');
  assert.equal(robots.verdicts['claude-seo-ai'].rule.path, '/admin/');
  assert.equal(robots.verdicts.Googlebot.allowed, true);
  assert.equal(robots.verdicts.Googlebot.via, 'explicit');
  assert.equal(robots.crawl_delay.Googlebot, null);
  assert.deepEqual(robots.crawl_delay.declared.map((d) => d.crawl_delay), [5]);
  assert.equal(robots.content_signals.present, true);
  assert.deepEqual(robots.sitemaps_declared, [U('/sitemap.xml')]);
  assert.equal(robots.ai_posture.training.GPTBot.root_allowed, false);
  assert.equal(robots.parsed.groups.length >= 4, true);
  assert.match(readFileSync(join(s.run_dir, snap.site.robots_txt), 'utf8'), /Content-Signal/);
  const sm = readJson(join(s.run_dir, snap.site.sitemaps));
  const gz = sm.files.find((f) => f.url.endsWith('/sitemap-pages.xml.gz'));
  assert.ok(gz, 'gz child discovered via the index');
  assert.equal(gz.gz, true);
  assert.equal(gz.kind, 'urlset');
  assert.equal(gz.source, 'index');
  assert.equal(gz.status, 200);
  assert.equal(sm.url_count, 5);
  assert.equal(sm.well_known_only, false);
  assert.equal(sm.sample.length, 5);
  assert.equal(sm.lastmod.count > 0, true);
  const urls = readFileSync(join(s.run_dir, snap.site.sitemap_urls), 'utf8').trim().split('\n');
  assert.equal(urls.length, 5);
  assert.ok(urls.every((u) => u.startsWith(srv.url)));
  const disc = readJson(join(s.run_dir, snap.site.discovery));
  assert.equal(disc.source, 'http');
  assert.equal(disc.probes['/.well-known/ucp'].json_valid, true);
  assert.deepEqual(disc.probes['/.well-known/ucp'].parsed_keys, ['ucp', 'services', 'capabilities']);
  assert.equal(disc.probes['/.well-known/ucp'].saved_as, 'ucp.json');
  assert.equal(disc.probes['/llms.txt'].saved_as, 'llms.txt');
  assert.equal(disc.probes['/llms.txt'].looks_like_html, false);
  assert.match(disc.probes['/llms.txt'].text_head, /^# Fixture Site/);
  assert.equal(disc.probes['/llms-full.txt'].saved_as, null);
  assert.equal(disc.probes['/api/ucp/mcp'].status, 404);
  assert.equal(disc.probes['/api/ucp/mcp'].looks_like_html, true, 'the 404 page is HTML — recorded, not mistaken for an endpoint');
  assert.equal(disc.https_enforcement.applicable, false);
  assert.deepEqual(disc.summary.found, ['/llms.txt', '/agents.md', '/.well-known/ucp', '/sitemap_agentic_discovery.xml']);
  for (const f of ['llms.txt', 'agents.md', 'ucp.json', 'sitemap_agentic_discovery.xml', 'robots.json', 'sitemaps.json', 'discovery.json']) assert.ok(existsSync(join(s.run_dir, 'site', f)), f);
  assert.equal(hits('/robots.txt'), robotsHits + 1);
  assert.equal(hits('/admin/secret'), 1, 'the audited page itself is fetched once');
  // a second page in the same run reuses the artifacts (no new robots/sitemap/probe requests)
  const before = srv.hits.length;
  const r2 = await run({ _: [U('/about')], run: s.run_id });
  assert.equal(r2.result.run_id, s.run_id);
  assert.equal(r2.result.site.reused, true);
  assert.equal(hits('/robots.txt'), robotsHits + 1);
  assert.equal(srv.hits.length - before, 1, 'only /about was requested');
  assert.deepEqual(readJson(r2.result.snapshot).site, snap.site);
});

test('--artifacts none skips site fetches; --artifacts robots fetches robots only', async () => {
  const before = srv.hits.length;
  const r = await run({ _: [U('/about')], artifacts: 'none' });
  assert.equal(r.result.site, null);
  assert.deepEqual(readJson(r.result.snapshot).site, { robots: null, sitemaps: null, sitemap_urls: null, discovery: null, robots_txt: null });
  assert.equal(srv.hits.length - before, 1);
  assert.equal(readdirSync(join(r.result.run_dir, 'site')).length, 0);
  const only = await run({ _: [U('/about')], artifacts: 'robots' });
  assert.equal(only.result.site.robots.mode, 'parsed');
  assert.equal(only.result.site.sitemaps_files, null);
  assert.equal(only.result.site.discovery, null);
  assert.deepEqual(readdirSync(join(only.result.run_dir, 'site')).sort(), ['robots.json', 'robots.txt']);
  assert.equal((await run({ _: [U('/about')], artifacts: 'bogus' })).code, EXIT.USAGE);
});

test('--ua googlebot writes pages/<slug>.ua-googlebot.* and sends the preset header', async () => {
  const base = await run({ _: [U('/blog/b')], artifacts: 'none' });
  const r = await run({ _: [U('/blog/b')], run: base.result.run_id, ua: 'googlebot', artifacts: 'none' });
  assert.equal(r.code, EXIT.OK);
  assert.match(r.result.snapshot, /blog_b--[0-9a-f]{8}\.ua-googlebot\.json$/);
  assert.ok(existsSync(r.result.snapshot.replace(/\.json$/, '.html')));
  const snap = readJson(r.result.snapshot);
  assert.equal(snap.request.ua_preset, 'googlebot');
  assert.match(snap.request.user_agent, /Googlebot\/2\.1/);
  assert.equal(snap.raw_html_path, 'pages/' + snap.target.slug + '.ua-googlebot.html');
  const uas = srv.hits.filter((h) => h.path === '/blog/b').map((h) => /Googlebot/.test(h.ua));
  assert.deepEqual(uas.slice(-2), [false, true]);
  assert.ok(existsSync(base.result.snapshot), 'the default-UA snapshot is untouched');
  const custom = await run({ _: [U('/blog/b')], run: base.result.run_id, ua: 'MyAuditBot/1.0', artifacts: 'none' });
  assert.match(custom.result.snapshot, /\.ua-custom-[0-9a-f]{6}\.json$/);
  assert.equal(readJson(custom.result.snapshot).request.ua_preset, 'custom');
});

test('--lang sets Accept-Language; the request block records it', async () => {
  const r = await run({ _: [U('/echo-ua')], lang: 'es-MX', artifacts: 'none', json: true });
  assert.equal(r.result.request.accept_language, 'es-MX,es;q=0.9');
  const echoed = JSON.parse(readFileSync(join(r.result.run_dir, r.result.raw_html_path), 'utf8'));
  assert.equal(echoed['accept-language'], 'es-MX,es;q=0.9');
});

test('CLI: --no-persist prints the full snapshot (HTML inlined) and writes nothing; --quiet prints only paths', async () => {
  const fresh = join(out, 'never-created');
  const r = await cli([U('/about'), '--no-persist', '--render', 'static', '--artifacts', 'none', '--out', fresh]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.snapshot_version, SNAPSHOT_VERSION);
  assert.equal(r.json.raw_html_path, null);
  assert.equal(r.json.run_id, null);
  assert.equal(r.json.run_dir, null);
  assert.equal(r.json.snapshot_path, null);
  assert.match(r.json.html_inline.raw, /<title>About the fixture<\/title>/);
  assert.equal(r.json.html_inline.rendered, null);
  assert.equal(existsSync(fresh), false);
  const q = await cli([U('/about'), '--quiet', '--render', 'static', '--artifacts', 'none', '--out', out]);
  assert.equal(q.status, 0, q.stderr);
  assert.deepEqual(Object.keys(q.json).sort(), ['render', 'run_dir', 'snapshot', 'status']);
  assert.ok(existsSync(q.json.snapshot));
  assert.ok(!q.stdout.includes('<html'), 'stdout never carries HTML in summary mode');
});

test('exit codes: network failure → 2; no target / bad flags / missing path → 1', async () => {
  const closed = await run({ _: ['http://127.0.0.1:1/'], artifacts: 'none' });
  assert.equal(closed.code, EXIT.RUNTIME);
  assert.equal(closed.result.error, 'fetch failed');
  assert.equal(closed.result.status, 0);
  assert.equal(typeof closed.result.detail, 'string');
  assert.equal((await run({ _: [] })).code, EXIT.USAGE);
  assert.match((await run({ _: [] })).result.error, /provide a target/);
  assert.equal((await run({ _: [U('/about')], render: 'sometimes' })).code, EXIT.USAGE);
  assert.equal((await run({ _: [U('/about')], renderer: 'firefox' })).code, EXIT.USAGE);
  assert.equal((await run({ _: [U('/about')], timeout: 'soon' })).code, EXIT.USAGE);
  assert.equal((await run({ _: [U('/about')], 'max-bytes': '10' })).code, EXIT.USAGE);
  assert.equal((await run({ _: [join(out, 'no-such-file.html')] })).code, EXIT.USAGE);
  assert.equal((await run({ _: ['not a url or path'] })).code, EXIT.USAGE);
  assert.equal((await run({ _: [U('/about')], 'rendered-file': join(out, 'missing-dom.html') })).code, EXIT.USAGE);
  const c = await cli([]);
  assert.equal(c.status, 1);
  assert.match(c.json.hint, /snapshot\.mjs <url\|path>/);
});

test('local directory: index.html first, *.html pages, status null, local robots/sitemap/llms.txt artifacts', async () => {
  const site = mkdtempSync(join(tmpdir(), 'cseo-localsite-'));
  mkdirSync(join(site, 'blog'));
  mkdirSync(join(site, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(site, 'index.html'), '<!doctype html><html lang="en"><head><title>Local home</title><link rel="canonical" href="https://local.test/"></head><body><h1>Home</h1><p>Built output of a synthetic static site.</p><a href="/about.html">About</a> <a href="/blog/a.html">Post</a> <a href="/blog/b.html">Other</a></body></html>');
  writeFileSync(join(site, 'about.html'), '<html><head><title>About local</title></head><body><h1>About</h1><p>About page.</p></body></html>');
  writeFileSync(join(site, 'blog', 'a.html'), '<html><head><title>Post A</title></head><body><h1>Post A</h1><p>Post body.</p></body></html>');
  writeFileSync(join(site, 'node_modules', 'pkg', 'readme.html'), '<html><title>dep</title></html>');
  writeFileSync(join(site, 'robots.txt'), 'User-agent: *\nDisallow: /private/\nSitemap: https://local.test/sitemap.xml\n');
  writeFileSync(join(site, 'sitemap.xml'), '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://local.test/</loc><lastmod>2026-01-01</lastmod></url><url><loc>https://local.test/about.html</loc></url></urlset>');
  writeFileSync(join(site, 'llms.txt'), '# Local\n\n> synthetic\n');
  const r = await run({ _: [site], url: 'https://local.test/' });
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.result));
  const s = r.result;
  assert.equal(s.kind, 'dir');
  assert.equal(s.pages_count, 3, 'node_modules is skipped');
  assert.equal(s.pages[0].file, 'index.html');
  assert.equal(s.homepage.file, 'index.html');
  assert.match(s.homepage.slug, /^index--[0-9a-f]{8}$/);
  assert.deepEqual(s.pages.map((p) => p.file), ['index.html', 'about.html', 'blog/a.html']);
  assert.ok(s.host_key.startsWith('local/'), s.host_key);
  assert.equal(s.site.robots.mode, 'parsed');
  assert.equal(s.site.sitemaps_files, 1);
  assert.equal(s.site.sitemap_urls, 2);
  assert.equal(s.site.discovery['/llms.txt'], 200);
  assert.equal(s.site.discovery['/agents.md'], 404);
  assert.ok(s.warnings.every((w) => typeof w === 'string'));
  const home = readJson(s.homepage.snapshot);
  assert.equal(home.status, null);
  assert.deepEqual(home.headers, {});
  assert.deepEqual(home.status_chain, []);
  assert.equal(home.target.kind, 'dir-page');
  assert.equal(home.target.final_url, 'https://local.test/', '--url maps index.html to the site root');
  assert.equal(home.target.relative_path, 'index.html');
  assert.equal(home.request.user_agent, null);
  assert.equal(home.body.sha256.length, 64);
  assert.ok(home.warnings.some((w) => /status null/.test(w)));
  assert.equal(home.parsed.anchors.filter((a) => a.internal === true).length, 3);
  const post = readJson(s.pages[2].snapshot);
  assert.equal(post.target.final_url, 'https://local.test/blog/a.html');
  const robots = readJson(join(s.run_dir, home.site.robots));
  assert.equal(robots.source, 'local');
  assert.equal(robots.verdicts.Googlebot.allowed, true);
  const disc = readJson(join(s.run_dir, home.site.discovery));
  assert.equal(disc.source, 'local');
  assert.equal(disc.https_enforcement.applicable, false);
  assert.ok(existsSync(join(s.run_dir, 'site', 'llms.txt')));
  assert.equal(readdirSync(join(s.run_dir, 'pages')).filter((n) => n.endsWith('.json')).length, 3);
  assert.equal(readJson(join(dirname(s.run_dir), 'latest.json')).run, s.run_id);
  rmSync(site, { recursive: true, force: true });
});

test('a framework source directory without built HTML exits 2 with the build hint; an empty directory exits 1', async () => {
  const fw = mkdtempSync(join(tmpdir(), 'cseo-fw-'));
  mkdirSync(join(fw, 'app'));
  writeFileSync(join(fw, 'next.config.mjs'), 'export default {};\n');
  writeFileSync(join(fw, 'app', 'page.tsx'), 'export default function Page() { return null; }\n');
  writeFileSync(join(fw, 'package.json'), JSON.stringify({ dependencies: { next: '15.0.0' } }));
  const r = await run({ _: [fw] });
  assert.equal(r.code, EXIT.RUNTIME);
  assert.match(r.result.error, /no built HTML found/);
  assert.match(r.result.hint, /build first or give the deployed URL/);
  assert.ok(r.result.framework_markers.includes('next.config.mjs'));
  assert.ok(r.result.framework_markers.includes('app/'));
  assert.ok(r.result.framework_markers.includes('package.json:next'));
  const empty = mkdtempSync(join(tmpdir(), 'cseo-empty-'));
  const e = await run({ _: [empty] });
  assert.equal(e.code, EXIT.USAGE);
  assert.match(e.result.error, /no \.html files/);
  rmSync(fw, { recursive: true, force: true }); rmSync(empty, { recursive: true, force: true });
});

test('single local file: status null, headers {}, --url supplies the page URL, no site artifacts', async () => {
  const f = join(out, 'single.html');
  writeFileSync(f, '<html lang="es"><head><title>Suelto</title><link rel="canonical" href="/suelto"></head><body><h1>Suelto</h1><p>Archivo local.</p></body></html>');
  const r = await run({ _: [f], url: 'https://example.test/suelto' });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.result.status, null);
  assert.equal(r.result.final_url, 'https://example.test/suelto');
  assert.equal(r.result.site, null);
  assert.match(r.result.snapshot, /[\\/]pages[\\/]single--[0-9a-f]{8}\.json$/);
  const snap = readJson(r.result.snapshot);
  assert.equal(snap.target.kind, 'file');
  assert.equal(snap.target.host, 'example.test');
  assert.deepEqual(snap.headers, {});
  assert.equal(snap.parsed.canonicals[0].abs, 'https://example.test/suelto');
  assert.equal(snap.parsed.lang, 'es');
  const viaFlag = await main({ _: [], file: f, out, ...STATIC });
  assert.equal(viaFlag.code, EXIT.OK);
  assert.match(readJson(viaFlag.result.snapshot).target.final_url, /^file:\/\//, 'without --url the page URL is the file URL');
});

test('--snapshot read-back: loadInput and parse-html see the real status, headers and HTML', async () => {
  const r = await run({ _: [U('/noindex')], artifacts: 'none' });
  const input = await loadInput({ snapshot: r.result.snapshot });
  assert.equal(input.source, 'snapshot');
  assert.equal(input.status, 200);
  assert.equal(input.headers['x-robots-tag'], 'noindex, nofollow');
  assert.match(input.html, /Header controlled/);
  assert.equal(input.finalUrl, U('/noindex'));
  assert.equal(input.snapshot.used, 'raw');
  assert.equal(input.snapshot.rendered_available, false);
  assert.equal(input.snapshot.run_dir, r.result.run_dir);
  assert.equal(inputFailure(input), null);
  const rendered = await loadInput({ snapshot: r.result.snapshot, prefer: 'rendered' });
  assert.equal(rendered.snapshot.used, 'raw');
  assert.match(rendered.snapshot.note, /rendered DOM not available/);
  assert.equal((await loadInput({ snapshot: r.result.snapshot, prefer: 'sideways' })).error, '--prefer must be raw or rendered');
  const missing = await loadInput({ snapshot: join(out, 'nope.json') });
  assert.match(missing.error, /cannot read snapshot/);
  assert.equal(inputFailure(missing).code, EXIT.USAGE);
  assert.match((await loadInput({ snapshot: true })).error, /provide --snapshot/);
  const rs = readSnapshot(r.result.snapshot);
  assert.equal(rs.snapshot.snapshot_version, SNAPSHOT_VERSION);
  assert.equal(rs.run_dir, r.result.run_dir);
  const notSnap = join(out, 'plain.json');
  writeFileSync(notSnap, '{"a":1}');
  assert.match(readSnapshot(notSnap).error, /not a PageSnapshot/);
  // an existing script consumes the snapshot with no network: real status + header canonical
  const ph = await parseHtml({ snapshot: r.result.snapshot });
  assert.equal(ph.code, EXIT.OK);
  assert.equal(ph.result.source, 'snapshot');
  assert.equal(ph.result.status, 200);
  assert.equal(ph.result.canonical_target, 'other');
  assert.equal(ph.result.canonicals[0].source, 'header');
  // snapshots that inline HTML (--no-persist output saved by hand) also load
  const np = await snapshotUrl(U('/about'), { persist: false, render: 'static', artifacts: 'none' });
  const saved = join(out, 'saved-no-persist.json');
  writeFileSync(saved, JSON.stringify(np.snapshot));
  const inl = await loadInput({ snapshot: saved });
  assert.match(inl.html, /About the fixture/);
  assert.equal(inl.status, 200);
});

test('retention: --keep prunes older runs of the host but never latest/baseline', async () => {
  const ids = ['2020-01-01T00-00-00Z', '2020-01-02T00-00-00Z', '2020-01-03T00-00-00Z'];
  const own = join(out, 'retention');
  let last;
  for (const id of ids) last = await main({ _: [U('/about')], out: own, run: id, artifacts: 'none', ...STATIC, keep: id === ids[2] ? '1' : undefined });
  const hostDir = dirname(last.result.run_dir);
  const dirs = readdirSync(hostDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name).sort();
  assert.deepEqual(dirs, [ids[2]]);
  assert.equal(readJson(join(hostDir, 'latest.json')).run, ids[2]);
  assert.deepEqual(readIndex(own).hosts[last.result.host_key].runs, [ids[2]]);
  const noPrune = await main({ _: [U('/about')], out: own, run: '2020-01-04T00-00-00Z', prune: false, keep: '1', artifacts: 'none', ...STATIC });
  assert.equal(noPrune.code, EXIT.OK);
  assert.equal(readdirSync(hostDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink()).length, 2, '--no-prune leaves both');
});

test('snapshotUrl (programmatic): reuses a caller-provided site result and honours finalize:false', async () => {
  const first = await snapshotUrl(U('/blog/a'), { out, render: 'static' });
  assert.equal(first.ok, true);
  assert.equal(first.site.reused, false);
  const before = srv.hits.length;
  const second = await snapshotUrl(U('/blog/b'), { out, render: 'static', run: first.run, site: first.site, finalize: false });
  assert.equal(second.ok, true);
  assert.equal(srv.hits.length - before, 1, 'only the page itself was fetched');
  assert.equal(second.finalized, null);
  assert.equal(second.run.dir, first.run.dir);
  assert.deepEqual(second.snapshot.site, first.snapshot.site);
  assert.equal(second.summary.site.reused, false, 'the shared object is reported as it was produced');
  const nothing = await snapshotUrl('http://127.0.0.1:1/', { persist: false });
  assert.equal(nothing.ok, false);
  assert.equal(nothing.code, EXIT.RUNTIME);
});

test('JS render through headless Chrome (skipped when no browser is installed)', { timeout: 90000 }, async (t) => {
  const chrome = findChrome();
  if (!chrome) { t.skip('no Chrome/Chromium/Edge/Brave found on this machine — set CLAUDE_SEO_AI_CHROME to run this test'); return; }
  const spa = join(out, 'spa.html');
  writeFileSync(spa, '<!DOCTYPE html><html><head><title>Shell</title></head><body><div id="root"></div>'
    + '<noscript>You need to enable JavaScript to run this app.</noscript>'
    + '<script>document.getElementById("root").innerHTML="<h1>Hydrated heading</h1><p>Client rendered paragraph with enough words to count as content for the delta test.</p><a href=\\"/x\\">x</a>";'
    + 'var s=document.createElement("script");s.type="application/ld+json";s.textContent=JSON.stringify({"@context":"https://schema.org","@type":"WebPage","name":"Hydrated"});document.head.appendChild(s);</script>'
    + '</body></html>');
  const r = await main({ _: [spa], out, render: 'js', renderer: 'chrome', json: true, artifacts: 'none' });
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.result.render));
  const s = r.result;
  assert.equal(s.render.used, 'chrome');
  assert.equal(s.render.confidence, 'full');
  assert.equal(s.render.renderer_path, chrome.path);
  assert.equal(typeof s.render.ms, 'number');
  assert.equal(s.tier, 1);
  assert.equal(s.render.delta.h1_added, true);
  assert.ok(s.render.delta.headings >= 1);
  assert.equal(s.render.delta.jsonld_blocks, 1);
  assert.ok(s.render.delta.words >= 10);
  assert.equal(s.render.delta.meaningful, true);
  assert.ok(s.parsed_rendered.headings.some((h) => h.text === 'Hydrated heading'));
  assert.equal(s.parsed_rendered.jsonld.length, 1);
  assert.equal(s.parsed.jsonld.length, 0, 'the static parse stays untouched');
  assert.equal(s.rendered_html_path, 'pages/' + s.target.slug + '.rendered.html');
  assert.match(readFileSync(join(s.run_dir, s.rendered_html_path), 'utf8'), /Hydrated heading/);
  assert.ok(['killed-after-dump', 'code:0'].includes(s.render.chrome_exit), s.render.chrome_exit);
  // read the rendered DOM back through the shared loader
  const inp = await loadInput({ snapshot: s.snapshot_path, prefer: 'rendered' });
  assert.equal(inp.snapshot.used, 'rendered');
  assert.match(inp.html, /Hydrated heading/);
  // auto mode on the same JS shell also renders (needsRender fires on the empty root + noscript notice)
  const auto = await main({ _: [spa], out, render: 'auto', renderer: 'chrome', artifacts: 'none' });
  assert.equal(auto.result.render.needed, true);
  assert.equal(auto.result.render.used, 'chrome');
});

test('--renderer none with a JS-dependent page keeps exit 0 and reports reduced confidence with a hint', async () => {
  const r = await main({ _: [U('/about')], out, render: 'js', renderer: 'none', artifacts: 'none' });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.result.render.used, 'none');
  assert.equal(r.result.render.confidence, 'reduced');
  assert.match(r.result.render.hint, /--renderer none/);
  assert.ok(r.result.warnings.some((w) => /renderer unavailable/.test(w)));
  const dom = join(out, 'external-dom.html');
  writeFileSync(dom, '<html><head><title>About the fixture</title></head><body><h1>About</h1><h2>Injected later</h2><p>Captured by another tool.</p></body></html>');
  const ext = await main({ _: [U('/about')], out, render: 'auto', 'rendered-file': dom, artifacts: 'none' });
  assert.equal(ext.result.render.used, 'external');
  assert.equal(ext.result.render.confidence, 'full');
  assert.equal(ext.result.render.delta.headings, 1);
  assert.equal(ext.result.tier, 1);
  assert.ok(existsSync(join(ext.result.run_dir, 'pages', readJson(ext.result.snapshot).rendered_html_path.replace(/^pages\//, ''))));
});

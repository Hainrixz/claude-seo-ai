// End-to-end against the local fixture server: parse-robots-sitemap (robots + verdicts + Content-Signal +
// recursive sitemap discovery, 4xx/5xx robots semantics), discoverSitemaps with the real fetcher,
// link-graph crawl (seed never an orphan, redirect-keyed adjacency, robots respected, depth/status),
// hreflang-check --deep (non-reciprocal pair, header alternates), and psi-client's pure field mapping.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';
import { fetchRaw } from '../../scripts/lib/fetch.mjs';
import { discoverSitemaps } from '../../scripts/lib/sitemaps.mjs';
import { main as robotsMain, aiPosture, VERDICT_UAS } from '../../scripts/parse-robots-sitemap.mjs';
import { main as linkMain, classify } from '../../scripts/link-graph.mjs';
import { main as hreflangMain } from '../../scripts/hreflang-check.mjs';
import { fieldFrom } from '../../scripts/psi-client.mjs';
import { parseRobots } from '../../scripts/lib/robots.mjs';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });
const U = (p) => srv.url + p;

describe('parse-robots-sitemap.mjs --url (live robots + sitemaps)', () => {
  let out;
  before(async () => { out = await robotsMain({ url: U('/blog/a'), _: [] }); });

  it('keeps the legacy keys and reports mode/status for a 200 robots.txt', () => {
    const r = out.result;
    assert.equal(out.code, 0);
    assert.equal(r.robots_url, U('/robots.txt'));
    assert.equal(r.exists, true);
    assert.equal(r.status, 200);
    assert.equal(r.mode, 'parsed');
    assert.equal(r.groups, 5);
    assert.deepEqual(r.sitemaps_declared, [U('/sitemap.xml')]);
    assert.equal(r.ai_posture.training.GPTBot, 'blocked');
    assert.equal(r.ai_posture.retrieval['OAI-SearchBot'], 'allowed');
    assert.equal(r.ai_posture.search.Googlebot, 'allowed');
    assert.equal(r.wildcard_disallow_all, false);
    assert.equal(r.ua_table_version, '2026-09');
  });
  it('may_block_render_assets looks only at Googlebot\'s effective group', () => {
    // The * group disallows /assets/app.js but Googlebot has its own group (Allow: /) → not blocked for Google.
    assert.equal(out.result.may_block_render_assets, false);
    const legacy = parseRobots('User-agent: *\nDisallow: /assets/app.js\n');
    assert.equal(aiPosture(legacy).search.Googlebot, 'allowed');
  });
  it('verdicts for the audited path, --path override, crawl-delay, syntax', async () => {
    const v = out.result.verdicts;
    assert.deepEqual(Object.keys(v), [...VERDICT_UAS]);
    assert.equal(out.result.path, '/blog/a');
    assert.deepEqual(v.Googlebot, { allowed: true, via: 'explicit', rule: { type: 'allow', path: '/', line: 21 } });
    assert.equal(v.Bingbot.allowed, true);
    assert.equal(v.Bingbot.via, 'wildcard');
    assert.equal(v['claude-seo-ai'].via, 'wildcard');
    const admin = await robotsMain({ url: U('/'), path: '/admin/secret', sitemaps: false, _: [] });
    assert.equal(admin.result.path, '/admin/secret');
    assert.equal(admin.result.verdicts['claude-seo-ai'].allowed, false);
    assert.equal(admin.result.verdicts['claude-seo-ai'].rule.path, '/admin/');
    assert.equal(admin.result.verdicts.Googlebot.allowed, true, 'Googlebot has its own permissive group');
    assert.equal(admin.result.sitemaps_all, undefined, '--no-sitemaps skips discovery');
    assert.equal(admin.result.first_sitemap, undefined);
    assert.deepEqual(out.result.crawl_delay.declared, [{ agents: ['SlowBot'], seconds: 5 }]);
    assert.equal(out.result.crawl_delay.Googlebot, null);
    assert.equal(out.result.syntax.has_bom, false);
    assert.deepEqual(out.result.syntax.unknown_directives, []);
  });
  it('parses the global Content-Signal line and exposes effective_access per bot', () => {
    const cs = out.result.content_signals;
    assert.equal(cs.present, true);
    assert.equal(cs.placement, 'global');
    assert.deepEqual(cs.global, { search: 'yes', 'ai-input': 'no', 'ai-train': 'no', raw: 'search=yes, ai-input=no, ai-train=no' });
    assert.equal(cs.cloudflare_managed_hint, true);
    const ea = out.result.effective_access;
    assert.equal(ea.GPTBot.class, 'training');
    assert.equal(ea.GPTBot.fetch, 'blocked');
    assert.equal(ea.GPTBot.url_allowed, false);
    assert.equal(ea.GPTBot.via, 'explicit');
    assert.deepEqual(ea.GPTBot.signals, { search: 'yes', 'ai-input': 'no', 'ai-train': 'no' });
    assert.equal(ea['OAI-SearchBot'].fetch, 'allowed');
    assert.equal(ea['OAI-SearchBot'].url_allowed, true);
    assert.equal(ea.Googlebot.doc_url.startsWith('https://developers.google.com/'), true);
    assert.equal(ea.Bytespider.robots_reliability, 'unreliable');
    assert.equal(Object.keys(ea).length, 24);
  });
  it('walks the sitemap index recursively (gz child included) and keeps the legacy first_sitemap', () => {
    const fs = out.result.first_sitemap;
    assert.equal(fs.url, U('/sitemap.xml'));
    assert.equal(fs.kind, 'sitemapindex');
    assert.equal(fs.url_count, 2);
    assert.equal(fs.lastmod_count, 2);
    assert.deepEqual(fs.children, [U('/sitemap-posts.xml'), U('/sitemap-pages.xml.gz')]);
    const all = out.result.sitemaps_all;
    assert.deepEqual(all.declared, [U('/sitemap.xml')]);
    assert.equal(all.found, 3);
    assert.equal(all.url_count, 5, '3 posts + 2 pages');
    assert.equal(all.truncated, false);
    assert.equal(all.over_50k_any, false);
    assert.equal(all.well_known_only, false);
    const gz = all.files.find((f) => f.url === U('/sitemap-pages.xml.gz'));
    assert.equal(gz.gz, true);
    assert.equal(gz.kind, 'urlset');
    assert.equal(gz.url_count, 2);
    assert.equal(gz.source, 'index');
    const posts = all.files.find((f) => f.url === U('/sitemap-posts.xml'));
    assert.equal(posts.lastmod.count, 3);
    assert.deepEqual(posts.errors, []);
    assert.ok(all.files.some((f) => f.url === U('/sitemap-index.xml') && f.status === 404), 'well-known candidates are probed and reported');
    // /wp-sitemap.xml -> 301 -> /sitemap_index.xml -> 302 -> /sitemap.xml is one sitemap under three
    // names. Keying each file on the REQUESTED url with the POST-redirect status made it three live
    // sources with identical url counts, and walked the same index three times.
    for (const alias of ['/wp-sitemap.xml', '/sitemap_index.xml']) {
      const f = all.files.find((x) => x.url === U(alias));
      assert.equal(f.status, 200, alias + ' answers, after redirects');
      assert.equal(f.final_url, U('/sitemap.xml'), alias + ' resolves to the one sitemap');
      assert.equal(f.alias_of, U('/sitemap.xml'));
    }
    assert.equal(all.files.filter((f) => f.parent === U('/sitemap.xml')).length, 2, 'the index is walked once, not three times');
    assert.equal(all.lastmod.min, '2026-07-01T00:00:00.000Z');
    assert.equal(all.lastmod.max, '2026-08-15T00:00:00.000Z');
    assert.ok(all.sample.includes(U('/blog/b?ref=sitemap&v=2')), 'entity-decoded loc');
  });
  it('--sitemap on a single file (gz) and on a missing file', async () => {
    const one = await robotsMain({ sitemap: U('/sitemap-pages.xml.gz'), _: [] });
    assert.equal(one.code, 0);
    assert.equal(one.result.exists, true);
    assert.equal(one.result.gz, true);
    assert.equal(one.result.sitemap.kind, 'urlset');
    assert.equal(one.result.sitemap.url_count, 2);
    assert.equal(one.result.sitemap.lastmod_all_identical, true);
    const missing = await robotsMain({ sitemap: U('/nope.xml'), _: [] });
    assert.equal(missing.code, 0, 'an HTTP 404 sitemap is a finding, not a crash');
    assert.equal(missing.result.exists, false);
    assert.equal(missing.result.status, 404);
    const bad = await robotsMain({ sitemap: 'nope', _: [] });
    assert.equal(bad.code, 1);
  });
});

describe('parse-robots-sitemap.mjs robots status semantics', () => {
  it('5xx robots → exists:true, mode disallow-all, exit 0, every verdict blocked via status-5xx', async () => {
    const s5 = await startServer({ robotsStatus: 500 });
    try {
      const out = await robotsMain({ url: s5.url + '/page', _: [] });
      assert.equal(out.code, 0);
      const r = out.result;
      assert.equal(r.exists, true);
      assert.equal(r.status, 500);
      assert.equal(r.mode, 'disallow-all');
      assert.match(r.note, /5xx/);
      assert.equal(r.groups, 0);
      assert.equal(r.wildcard_disallow_all, true);
      assert.equal(r.may_block_render_assets, true);
      for (const ua of VERDICT_UAS) assert.deepEqual(r.verdicts[ua], { allowed: false, via: 'status-5xx', rule: null }, ua);
      assert.equal(r.ai_posture.search.Googlebot, 'blocked');
      assert.equal(r.effective_access.Googlebot.fetch, 'blocked');
      assert.equal(r.content_signals.present, false);
      assert.ok(r.sitemaps_all.found >= 1, 'well-known sitemap probing still runs');
      assert.equal(r.first_sitemap, undefined, 'nothing declared');
      assert.equal(r.sitemaps_all.well_known_only, true);
    } finally { await s5.close(); }
  });
  it('4xx robots → exists:false, mode allow-all, exit 0, verdicts allowed via status-4xx', async () => {
    const s4 = await startServer({ robotsStatus: 404 });
    try {
      const out = await robotsMain({ url: s4.url + '/', _: [] });
      assert.equal(out.code, 0);
      const r = out.result;
      assert.equal(r.exists, false);
      assert.equal(r.status, 404);
      assert.equal(r.mode, 'allow-all');
      assert.equal(r.note, 'no robots.txt (all crawlable by default)');
      assert.deepEqual(r.verdicts.Googlebot, { allowed: true, via: 'status-4xx', rule: null });
      assert.equal(r.ai_posture.training.GPTBot, 'allowed');
    } finally { await s4.close(); }
  });
  it('--robots pointing at a 200 file works; scheme-less --url is USAGE with a hint', async () => {
    const out = await robotsMain({ robots: U('/robots.txt'), sitemaps: false, _: [] });
    assert.equal(out.code, 0);
    assert.equal(out.result.groups, 5);
    assert.equal(out.result.path, '/');
    const bad = await robotsMain({ url: 'example.com', _: [] });
    assert.equal(bad.code, 1);
    assert.match(bad.result.error, /invalid --url/);
    assert.equal(bad.result.hint, 'did you mean https://example.com ?');
    assert.equal(srv.hits.some((h) => h.path === '/admin/secret'), false, 'nothing fetched the disallowed page so far');
  });
});

describe('discoverSitemaps with the real fetcher', () => {
  it('finds declared + index children, inflates gz and tags urls with their sitemap', async () => {
    const robots = parseRobots('Sitemap: ' + U('/sitemap.xml') + '\n');
    const d = await discoverSitemaps(srv.url, robots, fetchRaw, { wellKnown: false });
    assert.equal(d.files.length, 3);
    assert.equal(d.found, 3);
    assert.equal(d.urls.length, 5);
    assert.equal(d.files.find((f) => f.url.endsWith('.gz')).gz, true);
    assert.ok(d.urls.every((u) => u.loc.startsWith(srv.url) && u.sitemap.startsWith(srv.url)));
  });
});

describe('link-graph.mjs', () => {
  it('classify: apex vs www is internal; fragment/mailto/tel/javascript are dropped before counting', () => {
    const c = classify([
      { href: 'https://example.com/a', anchor: 'A' }, { href: 'http://www.example.com/b', anchor: 'B' }, { href: '/c#frag', anchor: 'C' },
      { href: '#top', anchor: 'Top' }, { href: 'mailto:x@example.com', anchor: '' }, { href: 'tel:+1', anchor: 'call' },
      { href: 'javascript:void(0)', anchor: 'click here' }, { href: 'https://other.example/x', anchor: 'read more' }, { href: 'https://example.com/a', anchor: '' },
    ], 'https://www.example.com/page');
    assert.deepEqual(c.internal, ['https://example.com/a', 'http://www.example.com/b', 'https://www.example.com/c']);
    assert.deepEqual(c.external, ['https://other.example/x']);
    assert.deepEqual(c.generic.map((g) => g.anchor), ['read more'], 'javascript: link with generic anchor is dropped, not counted');
    assert.deepEqual(c.empty, ['https://example.com/a']);
    assert.deepEqual(c.dropped, { fragment: 1, mailto: 1, tel: 1, javascript: 1, data: 0, other: 0, invalid: 0 });
    assert.equal(c.total_anchor_tags, 9);
  });
  it('single page profile keeps legacy keys and adds dropped counts', async () => {
    const out = await linkMain({ url: U('/'), _: [] });
    assert.equal(out.code, 0);
    const r = out.result;
    assert.equal(r.page, U('/'));
    assert.equal(r.internal_unique, 7, '/ /about /blog/a /blog/b /old /es/blog/a /admin/secret');
    assert.equal(r.external_unique, 1);
    assert.equal(r.total_links, 8);
    assert.equal(r.total_anchor_tags, 12);
    assert.deepEqual(r.dropped, { fragment: 1, mailto: 1, tel: 1, javascript: 1, data: 0, other: 0, invalid: 0 });
  });
  it('crawl: seed is never an orphan, adjacency is keyed by final URL, robots respected, depth and status recorded', async () => {
    const before = srv.hits.length;
    const out = await linkMain({ url: U('/'), crawl: true, max: 20, _: [] });
    assert.equal(out.code, 0);
    const c = out.result.crawl;
    assert.deepEqual(c.potential_orphans, [], 'the start page has no inbound link but must not be reported as an orphan');
    assert.equal(c.start, U('/'));
    assert.equal(c.seed_disallowed, false);
    const urls = c.pages.map((p) => p.url);
    assert.ok(urls.includes(U('/blog/a')));
    assert.ok(!urls.includes(U('/old')) && !urls.includes(U('/older')), 'redirect sources are not pages');
    assert.ok(c.redirects.some((x) => x.from === U('/old') && x.to === U('/blog/a')));
    assert.ok(c.redirect_count >= 1);
    const home = c.pages.find((p) => p.url === U('/'));
    assert.equal(home.depth, 0);
    assert.equal(home.status, 200);
    assert.equal(c.pages.find((p) => p.url === U('/about')).depth, 1);
    assert.ok(c.pages.find((p) => p.url === U('/blog/a')).in_links >= 1);
    assert.ok(c.pages.find((p) => p.url === U('/blog/b')).in_links >= 2, 'linked from / and /about');
    assert.equal(c.status_counts['200'], c.pages.length);
    assert.equal(c.robots.respected, true);
    assert.equal(c.robots.mode, 'parsed');
    assert.equal(c.robots.token, 'claude-seo-ai');
    assert.deepEqual(c.robots.skipped_disallowed, [U('/admin/secret')]);
    assert.equal(srv.hits.slice(before).some((h) => h.path === '/admin/secret'), false, 'a disallowed URL is never requested');
    assert.ok(srv.hits.slice(before).some((h) => h.path === '/robots.txt'));
    assert.ok(!urls.some((u) => u.includes('#')), 'fragments never become pages');
  });
  it('--no-robots fetches the disallowed page; --max-depth bounds the frontier', async () => {
    const before = srv.hits.length;
    const out = await linkMain({ url: U('/'), crawl: true, robots: false, max: 20, 'max-depth': 1, _: [] });
    const c = out.result.crawl;
    assert.equal(c.robots.respected, false);
    assert.equal(c.robots.mode, null);
    assert.ok(c.pages.some((p) => p.url === U('/admin/secret')));
    assert.ok(srv.hits.slice(before).some((h) => h.path === '/admin/secret'));
    assert.ok(c.pages.every((p) => p.depth <= 1));
    assert.equal(c.max_depth_reached, 1);
  });
  it('crawl against a 5xx robots.txt crawls nothing and says why', async () => {
    const s5 = await startServer({ robotsStatus: 500 });
    try {
      const out = await linkMain({ url: s5.url + '/', crawl: true, _: [] });
      assert.equal(out.result.crawl.pages_crawled, 0);
      assert.equal(out.result.crawl.seed_disallowed, true);
      assert.equal(out.result.crawl.robots.mode, 'disallow-all');
      assert.equal(s5.hits.filter((h) => h.path === '/').length, 1, 'only the initial single-page profile fetch');
    } finally { await s5.close(); }
  });
});

describe('hreflang-check.mjs', () => {
  it('--deep finds the non-reciprocal alternate and resolves everything absolutely', async () => {
    const out = await hreflangMain({ url: U('/blog/a'), deep: true, _: [] });
    assert.equal(out.code, 0);
    const r = out.result;
    assert.equal(r.source, 'url');
    assert.equal(r.hreflang_count, 3);
    assert.equal(r.self_referenced, true);
    assert.equal(r.has_x_default, false);
    assert.deepEqual(r.invalid_bcp47, []);
    assert.deepEqual(r.duplicate_langs, []);
    assert.equal(r.canonical_vs_hreflang_conflict, false);
    assert.equal(r.header_entries, 0);
    assert.equal(r.reciprocity_checked, 3);
    assert.deepEqual(r.non_reciprocal, [U('/fr/blog/a')]);
    const es = r.reciprocity.find((x) => x.href === U('/es/blog/a'));
    assert.deepEqual([es.reachable, es.reciprocal, es.status], [true, true, 200]);
    assert.ok(r.entries.every((e) => e.abs && e.source === 'html'));
  });
  it('merges Link-header alternates and reports the header canonical', async () => {
    const out = await hreflangMain({ url: U('/noindex'), _: [] });
    const r = out.result;
    assert.equal(r.hreflang_count, 1);
    assert.equal(r.header_entries, 1);
    assert.deepEqual(r.entries[0], { hreflang: 'es', href: U('/es/header-alt'), abs: U('/es/header-alt'), source: 'header' });
    assert.equal(r.canonical_header, U('/canonical-target'));
    assert.equal(r.canonical, null);
  });
});

describe('psi-client fieldFrom (pure)', () => {
  it('surfaces origin_fallback and never fabricates field data', () => {
    const page = fieldFrom({ metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2100, category: 'FAST' }, INTERACTION_TO_NEXT_PAINT: { percentile: 250 }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 12 } }, overall_category: 'AVERAGE' });
    assert.equal(page.has_field_data, true);
    assert.equal(page.origin_fallback, false);
    assert.equal(page.scope, 'page');
    assert.equal(page.overall_category, 'AVERAGE');
    assert.deepEqual([page.lcp_ms, page.inp_ms, page.cls], [2100, 250, 0.12]);
    assert.deepEqual([page.lcp_rating, page.inp_rating, page.cls_rating], ['good', 'needs-improvement', 'needs-improvement']);
    const origin = fieldFrom({ origin_fallback: true, metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 4200 } } });
    assert.equal(origin.origin_fallback, true);
    assert.equal(origin.scope, 'origin');
    assert.equal(origin.lcp_rating, 'poor');
    assert.equal(origin.inp_ms, null);
    assert.equal(fieldFrom({ metrics: {} }), null);
    assert.equal(fieldFrom(null), null);
    assert.equal(fieldFrom({ origin_fallback: true }), null, 'absent metrics → no field data, even when origin_fallback is set');
  });
});

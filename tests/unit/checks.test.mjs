// Unit tests for the deterministic checks registry (scripts/checks/*) and lib/imgsize.mjs.
//
// Every test builds a synthetic context by hand — no network, no run directory unless the test
// creates one under os.tmpdir(). Findings are produced through lib/finding.mjs makeFinding(), which
// throws inside node:test when a finding does not validate, so a schema regression fails here
// rather than silently dropping a finding in production.
//
// Each check has at least one "the fact is present" assertion and one honesty assertion:
// needs_api when the data was missing, or not_applicable when another owner is responsible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDocument } from '../../scripts/lib/html.mjs';
import { robotsDirectives } from '../../scripts/snapshot.mjs';
import { parseRobots, isAllowed, aiPosture } from '../../scripts/lib/robots.mjs';
import { pageSlug } from '../../scripts/lib/store.mjs';
import { validateFinding } from '../../scripts/lib/validate-finding.mjs';
import { imageSize, sniffFormat } from '../../scripts/lib/imgsize.mjs';

import { CHECKS, runChecks, loadRunContext, knownIds } from '../../scripts/checks/index.mjs';
import { check as crawlability } from '../../scripts/checks/crawlability.mjs';
import { check as indexability } from '../../scripts/checks/indexability.mjs';
import { check as indexabilitySite } from '../../scripts/checks/indexability-site.mjs';
import { check as onpage } from '../../scripts/checks/onpage.mjs';
import { check as onpageSite } from '../../scripts/checks/onpage-site.mjs';
import { check as social } from '../../scripts/checks/social.mjs';
import { check as images } from '../../scripts/checks/images.mjs';
import { check as links } from '../../scripts/checks/links.mjs';
import { check as linksSite } from '../../scripts/checks/links-site.mjs';
import { check as schema } from '../../scripts/checks/schema.mjs';
import { check as sitemaps } from '../../scripts/checks/sitemaps.mjs';
import { check as international } from '../../scripts/checks/international.mjs';
import { check as freshness } from '../../scripts/checks/freshness.mjs';
import { check as rendering } from '../../scripts/checks/rendering.mjs';
import { check as aiCrawlers } from '../../scripts/checks/ai-crawlers.mjs';
import { check as aiEligibility } from '../../scripts/checks/ai-eligibility.mjs';
import { check as aiDiscovery } from '../../scripts/checks/ai-discovery.mjs';
import { check as agenticCommerce } from '../../scripts/checks/agentic-commerce.mjs';
import { check as ecommerce } from '../../scripts/checks/ecommerce.mjs';
import { check as agentReadiness } from '../../scripts/checks/agent-readiness.mjs';
import { check as cwv } from '../../scripts/checks/cwv.mjs';
import { check as platformShopify } from '../../scripts/checks/platform-shopify.mjs';
import { check as platformWordpress } from '../../scripts/checks/platform-wordpress.mjs';
import { check as platformFrameworks } from '../../scripts/checks/platform-frameworks.mjs';
import { check as hostingEnvironment } from '../../scripts/checks/hosting-environment.mjs';

/* ------------------------------------------------------------------ fixtures */

const ORIGIN = 'https://example.test';
const RUN_DIR = join(tmpdir(), 'cseo-checks-synthetic-run');

/** Build a page entry shaped exactly like loadRunContext() produces. */
function mkPage(url, html, opts = {}) {
  const parsed = parseDocument(html, url);
  // A real snapshot always carries response headers; without any, ai-eligibility reports
  // "no_http_headers" and every page becomes undecidable, which would hide the checks under test.
  const headers = { 'content-type': 'text/html; charset=utf-8', ...(opts.headers || {}) };
  const slug = opts.slug || pageSlug(url);
  return {
    slug,
    url,
    snapshot: {
      target: { final_url: url, requested_url: opts.requested_url || url, value: url, slug },
      status: opts.status === undefined ? 200 : opts.status,
      headers,
      header_links: opts.header_links || { all: [], canonical: null, alternates: [] },
      robots_directives: robotsDirectives(headers, parsed),
      redirects: { hops: opts.hops || 0, loop: false, truncated: false },
      render: opts.render || null,
      raw_html_path: null,
    },
    parsed,
    parsed_rendered: opts.parsed_rendered || null,
    html_path: null,
    html,
    rendered_html: null,
    status: opts.status === undefined ? 200 : opts.status,
    template: opts.template || null,
    role: opts.role || null,
    in_sitemap: opts.in_sitemap === undefined ? null : opts.in_sitemap,
    inlinks: opts.inlinks === undefined ? null : opts.inlinks,
    ua_diff: opts.ua_diff || null,
    manifest: null,
  };
}

/** site/robots.json built with the real robots parser, so the fixtures cannot drift from lib. */
function robotsArtifact(text, opts = {}) {
  const parsed = parseRobots(text);
  const status = opts.status === undefined ? 200 : opts.status;
  const path = opts.path || '/';
  const verdict = (ua) => isAllowed(parsed, ua, ORIGIN + path);
  return {
    url: ORIGIN + '/robots.txt',
    status,
    ok: status >= 200 && status < 300,
    mode: status >= 500 ? 'disallow-all' : status >= 400 ? 'allow-all' : 'parsed',
    error: opts.error || null,
    verdicts: { Googlebot: verdict('Googlebot'), Bingbot: verdict('Bingbot'), 'claude-seo-ai': verdict('claude-seo-ai') },
    crawl_delay: opts.crawl_delay || { Googlebot: null, '*': null, declared: [] },
    content_signals: parsed.contentSignals,
    sitemaps_declared: parsed.sitemaps,
    ai_posture: aiPosture(parsed, ORIGIN + path),
    parsed,
  };
}

function mkCtx(over = {}) {
  return {
    run_dir: over.run_dir || RUN_DIR,
    crawl: over.crawl === undefined ? null : over.crawl,
    site: { robots: null, sitemaps: null, discovery: null, ...(over.site || {}) },
    pages: over.pages || [],
    page: null,
    profile: over.profile === undefined ? null : over.profile,
    vertical: over.vertical === undefined ? null : over.vertical,
    options: over.options || {},
    tools: over.tools || {},
  };
}

/** Run one check the way runChecks() does, and validate everything it returns. */
async function run(check, ctx) {
  const out = [];
  if (check.scope === 'page') {
    for (const page of ctx.pages) out.push(...(await check.run({ ...ctx, page })));
  } else {
    out.push(...(await check.run({ ...ctx, page: null })));
  }
  for (const f of out) {
    const { ok, errors } = validateFinding(f);
    assert.ok(ok, f.id + ' must validate: ' + errors.join('; '));
    assert.ok(f.verification.reproduce.startsWith('node "'), f.id + ' reproduce must be a runnable command');
  }
  return out;
}

const ids = (list) => list.map((f) => f.id);
const byId = (list, id) => list.filter((f) => f.id === id);
const one = (list, id) => {
  const hits = byId(list, id);
  assert.equal(hits.length, 1, 'expected exactly one ' + id + ', got ' + hits.length + ' in [' + ids(list).join(', ') + ']');
  return hits[0];
};

const HTML = (head = '', body = '', attrs = 'lang="en"') =>
  `<!DOCTYPE html><html ${attrs}><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

/* ------------------------------------------------------------------ registry */

test('the registry exposes the documented contract', async () => {
  assert.ok(CHECKS.length >= 20, 'expected the full registry, got ' + CHECKS.length);
  const seen = new Set();
  for (const c of CHECKS) {
    assert.equal(typeof c.id, 'string', 'every check needs an id');
    assert.ok(!seen.has(c.id), 'duplicate check id ' + c.id);
    seen.add(c.id);
    assert.match(c.module, /^M[0-9]{1,2}[a-z]?$/, c.id + ' needs a module');
    assert.ok(['page', 'site'].includes(c.scope), c.id + ' scope must be page or site');
    assert.ok(Array.isArray(c.ids) && c.ids.length, c.id + ' must declare the ids it can emit');
    assert.equal(typeof c.run, 'function', c.id + ' must export run()');
    for (const id of c.ids) assert.match(id, /^M[0-9]{1,2}[a-z]?\.[a-z0-9_.-]+$/, 'bad finding id ' + id + ' in ' + c.id);
  }
  assert.ok(knownIds().includes('M14.ai_eligibility.ok'));
  assert.ok(knownIds().length >= 100, 'expected the full id catalogue, got ' + knownIds().length);
});

test('runChecks never throws and records the failure of a single check', async () => {
  const exploding = {
    slug: 'boom', url: ORIGIN + '/boom', html: '<html></html>', status: 200,
    snapshot: { target: { final_url: ORIGIN + '/boom' }, status: 200, headers: {} },
    get parsed() { throw new Error('synthetic parse failure'); },
  };
  const ctx = mkCtx({ pages: [exploding] });
  const { findings, stats } = await runChecks(ctx);
  assert.ok(Array.isArray(findings), 'runChecks resolves with findings even when a check throws');
  assert.ok(stats.errors.length > 0, 'the failure must be recorded in stats.errors');
  assert.ok(stats.errors.every((e) => typeof e.check === 'string' && typeof e.message === 'string'));
  assert.equal(typeof stats.per_module, 'object');
});

/* ------------------------------------------------------------------ M1 */

test('M1 reports robots.txt access, syntax, sitemap and crawl-delay facts', async () => {
  const text = [
    'User-agent: *', 'Disallow: /assets/', 'Disallow /no-colon', 'Crawl-delay: 30', '',
    'User-agent: Googlebot', 'Disallow: /',
  ].join('\n');
  const ctx = mkCtx({
    crawl: { target: ORIGIN + '/', origin: ORIGIN, pages: [] },
    site: { robots: robotsArtifact(text, { crawl_delay: { Googlebot: null, '*': 30, declared: [{ agents: ['*'], crawl_delay: 30, line: 4 }] } }) },
    pages: [mkPage(ORIGIN + '/', HTML('<link rel="stylesheet" href="/assets/app.css">'))],
  });
  const out = await run(crawlability, ctx);
  const blocked = one(out, 'M1.robots.blocks_googlebot');
  assert.equal(blocked.severity, 5);
  assert.equal(blocked.scope, 'site');
  assert.match(blocked.evidence.observed, /Disallow: \//);
  const css = one(out, 'M1.robots.blocks_css_js');
  assert.match(css.evidence.observed, /app\.css/);
  assert.ok(byId(out, 'M1.robots.syntax_error').length === 1, 'the colon-less directive is a syntax error');
  assert.equal(one(out, 'M1.crawl_delay.excessive').severity, 2);
  assert.equal(one(out, 'M1.sitemap.missing_directive').status, 'warn');
});

test('M1 reports a 5xx robots.txt as unreachable and a missing artifact as needs_api', async () => {
  const bad = await run(crawlability, mkCtx({ site: { robots: robotsArtifact('', { status: 503 }) } }));
  const unreachable = one(bad, 'M1.robots.unreachable');
  assert.equal(unreachable.status, 'fail');
  assert.equal(unreachable.severity, 5);
  assert.equal(unreachable.expected_impact.confidence, 'established');

  const none = await run(crawlability, mkCtx({}));
  assert.equal(none.length, 1);
  assert.equal(none[0].status, 'needs_api');
  assert.equal(none[0].severity, 0, 'needs_api findings never carry a scoring severity by default');
});

/* ------------------------------------------------------------------ M2 */

test('M2 separates the coherent noindex from the lethal canonical conflict', async () => {
  const self = mkPage(ORIGIN + '/a', HTML('<title>A page about things</title><link rel="canonical" href="' + ORIGIN + '/a"><meta name="robots" content="noindex">'));
  const cross = mkPage(ORIGIN + '/b', HTML('<title>B page about things</title><link rel="canonical" href="' + ORIGIN + '/other">'), { headers: { 'x-robots-tag': 'noindex' } });

  const selfOut = await run(indexability, mkCtx({ pages: [self] }));
  assert.deepEqual(ids(selfOut).filter((i) => i.startsWith('M2.robots')), ['M2.robots.noindex_present']);
  assert.equal(one(selfOut, 'M2.robots.noindex_present').severity, 3);
  assert.ok(!ids(selfOut).includes('M2.canonical.noindex_conflict'), 'a self-canonical noindex is not a conflict');
  assert.ok(!ids(selfOut).includes('M2.robots.unintended_noindex'), 'the escalation is never emitted automatically');

  const crossOut = await run(indexability, mkCtx({ pages: [cross] }));
  const conflict = one(crossOut, 'M2.canonical.noindex_conflict');
  assert.equal(conflict.status, 'fail');
  assert.equal(conflict.severity, 4);
  assert.match(conflict.evidence.observed, /X-Robots-Tag: noindex/);
});

test('M2 escalates a missing canonical to fail when another URL serves the same title, and reports mixed content', async () => {
  const head = '<title>Identical title for two URLs</title>';
  const a = mkPage(ORIGIN + '/a', HTML(head, '<img src="http://insecure.test/x.png" alt="x">'));
  const b = mkPage(ORIGIN + '/b', HTML(head));
  const out = await run(indexability, mkCtx({ pages: [a, b] }));
  const missing = byId(out, 'M2.canonical.missing');
  assert.equal(missing.length, 2);
  assert.ok(missing.every((f) => f.status === 'fail'), 'duplicated titles make the missing canonical a fail');
  const mixed = one(out, 'M2.mixed_content');
  assert.match(mixed.evidence.observed, /insecure\.test/);

  const alone = await run(indexability, mkCtx({ pages: [mkPage(ORIGIN + '/solo', HTML('<title>A title that is only used once</title>'))] }));
  assert.equal(one(alone, 'M2.canonical.missing').status, 'warn');
});

test('M2 reads cloaking from the ua-diff artifact', async () => {
  const page = mkPage(ORIGIN + '/a', HTML('<title>Cloaked page for the bots</title><link rel="canonical" href="' + ORIGIN + '/a">'), {
    ua_diff: {
      baseline: 'default',
      variants: [
        { ua: 'default', status: 200, title: 'Real title', word_count: 900 },
        { ua: 'googlebot', status: 200, title: 'Keyword stuffed title', word_count: 120 },
      ],
      diffs: [{ ua: 'googlebot', status_differs: false, title_or_h1_differs: true, canonical_differs: false, noindex_differs: false, jsonld_differs: false, differs: true, challenge_detected: false }],
    },
  });
  const out = await run(indexability, mkCtx({ pages: [page] }));
  const cloak = one(out, 'M2.cloaking.ua_content_divergence');
  assert.equal(cloak.expected_impact.confidence, 'directional', 'a one-shot UA diff is never established');
  assert.equal(cloak.verification.method, 'ua_diff');
});

test('M2 cross-URL checks read redirects and broken links from the crawl, and need one to exist', async () => {
  const crawl = {
    target: ORIGIN + '/', origin: ORIGIN,
    pages: [{ url: ORIGIN + '/gone', status: 404, inlinks: 2 }],
    link_status: {
      budget: 20, checked: 3,
      results: [
        { url: ORIGIN + '/old', status: 200, hops: 2, loop: false, broken: false, final_url: ORIGIN + '/new', inlinks: 1, chain: [{ url: ORIGIN + '/old', status: 301 }, { url: ORIGIN + '/mid', status: 302 }] },
        { url: ORIGIN + '/loop', status: 0, hops: 3, loop: true, broken: true, final_url: null, inlinks: 1, chain: [{ url: ORIGIN + '/loop', status: 302 }] },
      ],
    },
  };
  const out = await run(indexabilitySite, mkCtx({
    crawl,
    site: { discovery: { https_enforcement: { applicable: true, url: 'http://example.test/', status: 200, final_url: 'http://example.test/', hops: 0, redirects_to_https: false } } },
  }));
  assert.equal(one(out, 'M2.redirect.chain').severity, 4);
  assert.equal(one(out, 'M2.redirect.loop').scope, 'page', 'one looping URL stays at page scope so it cannot cap');
  assert.match(one(out, 'M2.links.broken_internal').evidence.observed, /HTTP 404/);
  assert.equal(one(out, 'M2.https.not_enforced').severity, 4);

  const noCrawl = await run(indexabilitySite, mkCtx({}));
  assert.equal(noCrawl.length, 1);
  assert.equal(noCrawl[0].status, 'needs_api');
  assert.match(noCrawl[0].evidence.observed, /No crawl\.json/);
});

/* ------------------------------------------------------------------ M7 */

test('M7 quotes the band that produced each head verdict', async () => {
  const page = mkPage(ORIGIN + '/a', HTML(
    '<title>Short</title><meta name="description" content="tiny"><meta name="viewport" content="width=device-width, user-scalable=no">',
    '<h1>One</h1><h1>Two</h1><h2>Section</h2><h4>Skipped</h4>',
  ));
  const out = await run(onpage, mkCtx({ pages: [page] }));
  assert.match(one(out, 'M7.title.length_out_of_band').evidence.observed, /pass band 30-60/);
  assert.match(one(out, 'M7.description.length_out_of_band').evidence.observed, /pass band 70-160/);
  assert.equal(one(out, 'M7b.viewport.user_scalable_no').status, 'warn');
  assert.equal(one(out, 'M7c.h1.multiple').severity, 3);
  assert.match(one(out, 'M7c.outline.skipped_level').evidence.observed, /h2 .* h4/);
  assert.ok(ids(out).includes('M7c.landmark.no_main'));

  const empty = await run(onpage, mkCtx({ pages: [mkPage(ORIGIN + '/b', '<html><head></head><body></body></html>')] }));
  assert.equal(one(empty, 'M7.title.missing').status, 'fail');
  assert.equal(one(empty, 'M7.viewport.missing').fixable, 'auto');
});

test('M7 duplicate detection needs at least two URLs and ignores fragment-only differences', async () => {
  const head = '<title>The same title on two different URLs</title><meta name="description" content="' + 'x'.repeat(90) + '">';
  const pages = [mkPage(ORIGIN + '/a', HTML(head)), mkPage(ORIGIN + '/b', HTML(head))];
  const out = await run(onpageSite, mkCtx({ pages }));
  assert.equal(one(out, 'M7.title.duplicate_across_urls').status, 'warn');
  assert.equal(one(out, 'M7.description.duplicate_across_urls').severity, 2);
  // The two mobile items static HTML cannot decide are stated once, as unmeasured.
  for (const id of ['M7b.layout.horizontal_scroll', 'M7b.taptarget.too_small']) {
    const f = one(out, id);
    assert.equal(f.status, 'needs_api');
    assert.match(f.evidence.observed, /Not measured in this run/);
  }

  const single = await run(onpageSite, mkCtx({ pages: [pages[0]] }));
  assert.equal(single.length, 1);
  assert.equal(single[0].status, 'needs_api');
});

/* ------------------------------------------------------------------ M8 + imgsize */

test('lib/imgsize reads PNG, GIF, JPEG and WebP headers and refuses everything else', () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'),
    (() => { const b = Buffer.alloc(8); b.writeUInt32BE(1200, 0); b.writeUInt32BE(630, 4); return b; })(),
  ]);
  assert.deepEqual({ ...imageSize(png), bytes: undefined }, { format: 'png', width: 1200, height: 630, error: null, bytes: undefined });

  const gif = Buffer.concat([Buffer.from('GIF89a'), (() => { const b = Buffer.alloc(4); b.writeUInt16LE(48, 0); b.writeUInt16LE(24, 2); return b; })()]);
  assert.deepEqual([imageSize(gif).width, imageSize(gif).height], [48, 24]);

  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0); sof.writeUInt16BE(9, 2); sof[4] = 8; sof.writeUInt16BE(300, 5); sof.writeUInt16BE(400, 7);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), sof]);
  assert.deepEqual([imageSize(jpeg).format, imageSize(jpeg).width, imageSize(jpeg).height], ['jpeg', 400, 300]);

  const bits = (100 - 1) | ((50 - 1) << 14);
  const webp = Buffer.concat([
    Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from('VP8L'), Buffer.alloc(4),
    Buffer.from([0x2f]), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(bits, 0); return b; })(),
  ]);
  assert.deepEqual([imageSize(webp).format, imageSize(webp).width, imageSize(webp).height], ['webp', 100, 50]);

  assert.equal(sniffFormat(Buffer.from('<html>')), null);
  const bad = imageSize(Buffer.from('<!doctype html><html>not an image'));
  assert.equal(bad.format, null);
  assert.match(bad.error, /not a PNG/);
});

test('M8 reports missing social tags and, with a fetch, an og:image that is not an image', async () => {
  const bare = await run(social, mkCtx({ pages: [mkPage(ORIGIN + '/a', HTML('<title>No social tags at all here</title>'))] }));
  assert.equal(one(bare, 'M8.og.missing_image').status, 'fail');
  assert.equal(one(bare, 'M8.twitter.no_card').severity, 2);

  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, headers: { 'content-type': 'text/html' }, body: { buffer: Buffer.from('<html>soft 404</html>') } };
  };
  const withImage = mkPage(ORIGIN + '/a', HTML('<title>Has an og image tag</title><meta property="og:image" content="/card.png"><meta name="twitter:card" content="summary">'));
  const out = await run(social, mkCtx({ pages: [withImage], tools: { fetchImpl } }));
  assert.deepEqual(calls, [ORIGIN + '/card.png'], 'the og:image is resolved against the page URL before fetching');
  assert.match(one(out, 'M8.og.image_unreachable').evidence.observed, /not an image type/);
});

test('M8 measures the og:image and refuses one that is too small to be a card', async () => {
  const png = (w, h) => Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'),
    (() => { const b = Buffer.alloc(8); b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4); return b; })(),
  ]);
  const serve = (buf) => async () => ({ ok: true, status: 200, headers: { 'content-type': 'image/png' }, body: { buffer: buf } });
  const page = () => mkPage(ORIGIN + '/a', HTML('<title>Has a valid og image tag</title><meta property="og:image" content="' + ORIGIN + '/card.png"><meta name="twitter:card" content="summary_large_image">'));

  const small = await run(social, mkCtx({ pages: [page()], tools: { fetchImpl: serve(png(64, 64)) } }));
  const tooSmall = one(small, 'M8.og.image_unreachable');
  assert.match(tooSmall.evidence.observed, /PNG measuring 64×64 px/);
  assert.match(tooSmall.evidence.observed, /below the 200×200 px/);

  const big = await run(social, mkCtx({ pages: [page()], tools: { fetchImpl: serve(png(1200, 630)) } }));
  assert.deepEqual(ids(big), [], 'a reachable, correctly sized card image produces no finding');
});

/* ------------------------------------------------------------------ M9 */

test('M9 judges content images only, and asks for VideoObject when a video is embedded', async () => {
  const page = mkPage(ORIGIN + '/a', HTML('<title>Images and one embedded video</title>', [
    '<nav><img src="/logo.png"></nav>',
    '<main><img src="/hero.png"><img src="/sized.png" alt="ok" width="10" height="10">',
    '<iframe src="https://www.youtube.com/embed/abc" title="Demo"></iframe></main>',
  ].join('')));
  const out = await run(images, mkCtx({ pages: [page] }));
  const alt = one(out, 'M9.alt.missing');
  assert.match(alt.evidence.observed, /1 content <img> of 2/, 'the nav logo is boilerplate and is not counted');
  assert.equal(one(out, 'M9.img.no_dimensions').fixable, 'auto');
  assert.match(one(out, 'M9.video.missing_videoobject').evidence.observed, /youtube/);

  const clean = await run(images, mkCtx({ pages: [mkPage(ORIGIN + '/b', HTML('<title>Nothing to report on this page</title>', '<main><p>text</p></main>'))] }));
  assert.deepEqual(ids(clean), []);
});

/* ------------------------------------------------------------------ M10 */

test('M10 counts in-body links, generic anchors and the missing landmark', async () => {
  const page = mkPage(ORIGIN + '/a', HTML('<title>A page with one weak in-body link</title>',
    '<nav><a href="/x">X</a><a href="/y">Y</a><a href="/z">Z</a></nav><p><a href="/more">read more</a></p>'));
  const out = await run(links, mkCtx({ pages: [page] }));
  assert.match(one(out, 'M10.contextual.too_few_inbody_links').evidence.observed, /1 internal link/);
  assert.match(one(out, 'M10.anchor.generic_text').evidence.observed, /read more/);
  assert.ok(ids(out).includes('M10.semantic.missing_main'));
});

test('M10 orphans exclude seeds and state the crawl frontier; without a crawl the answer is needs_api', async () => {
  const crawl = {
    target: ORIGIN + '/', origin: ORIGIN,
    sampling: { discovered: 40 },
    budget: { max_reached: true },
    pages: [
      { url: ORIGIN + '/', role: 'homepage', discovered_via: 'origin', inlinks: 0, status: 200 },
      { url: ORIGIN + '/seeded', role: 'sample', discovered_via: 'seeds', inlinks: 0, status: 200 },
      { url: ORIGIN + '/orphan', role: 'sample', discovered_via: 'sitemap', inlinks: 0, status: 200, in_sitemap: true },
      { url: ORIGIN + '/linked', role: 'sample', discovered_via: 'link', inlinks: 3, status: 200 },
    ],
  };
  const out = await run(linksSite, mkCtx({ crawl }));
  const orphans = byId(out, 'M10.orphan.no_incoming_links').filter((f) => f.status === 'fail');
  assert.equal(orphans.length, 1, 'only the sitemap-discovered URL is an orphan');
  assert.equal(orphans[0].location.url, ORIGIN + '/orphan');
  assert.match(orphans[0].evidence.observed, /4 URLs sampled of 40 discovered, frontier cap reached/);

  const none = await run(linksSite, mkCtx({}));
  assert.equal(none[0].status, 'needs_api');
});

/* ------------------------------------------------------------------ M5 */

test('M5 reports unparseable JSON-LD, a Product with no Offer and a price the page contradicts', async () => {
  const broken = mkPage(ORIGIN + '/a', HTML('<title>Broken structured data block</title><script type="application/ld+json">{"@type":"Product",}</script>'));
  const brokenOut = await run(schema, mkCtx({ pages: [broken] }));
  assert.equal(one(brokenOut, 'M5.jsonld.invalid_json').severity, 4);

  const noOffer = mkPage(ORIGIN + '/p', HTML('<title>Product without any offer node</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Thing"}</script>'));
  const noOfferOut = await run(schema, mkCtx({ pages: [noOffer] }));
  assert.match(one(noOfferOut, 'M5.product.missing_offer_price').evidence.observed, /no `offers` property/);

  const mismatch = mkPage(ORIGIN + '/q', HTML(
    '<title>Product whose price disagrees</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Thing","offers":{"@type":"Offer","price":"49.00","priceCurrency":"EUR"}}</script>',
    '<main><p>Buy it today for $99.00 including shipping and handling.</p></main>',
  ));
  const mismatchOut = await run(schema, mkCtx({ pages: [mismatch] }));
  const contradiction = one(mismatchOut, 'M5.jsonld.contradicts_page');
  assert.match(contradiction.evidence.observed, /49\.00/);
  assert.match(contradiction.evidence.observed, /99\.00/);

  const faq = mkPage(ORIGIN + '/f', HTML('<title>A page carrying FAQPage markup</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>'));
  const faqOut = await run(schema, mkCtx({ pages: [faq] }));
  assert.equal(one(faqOut, 'M5.faqpage.deprecated_richresult').severity, 1);
  assert.equal(one(faqOut, 'M5.faqpage.deprecated_richresult').expected_impact.axis, 'ai');
});

/* ------------------------------------------------------------------ M17 */

test('M17 joins the sitemap to what the crawl fetched, and never invents a verdict for an unfetched URL', async () => {
  const noindexPage = mkPage(ORIGIN + '/excluded', HTML('<title>Excluded from the index</title>'), { headers: { 'x-robots-tag': 'noindex' }, in_sitemap: true });
  const errorPage = mkPage(ORIGIN + '/gone', HTML('<title>Gone</title>'), { status: 404, in_sitemap: true });
  const redirectPage = mkPage(ORIGIN + '/new', HTML('<title>Moved here</title>'), { requested_url: ORIGIN + '/moved', hops: 1, in_sitemap: true });
  redirectPage.snapshot.target.requested_url = ORIGIN + '/moved';
  const missing = mkPage(ORIGIN + '/not-listed', HTML('<title>Indexable but not in the sitemap</title>'), { in_sitemap: false });

  const ctx = mkCtx({
    pages: [noindexPage, errorPage, redirectPage, missing],
    site: {
      robots: robotsArtifact('User-agent: *\nDisallow:\n'),
      sitemaps: {
        found: 1, url_count: 5, declared: [],
        files: [{ url: ORIGIN + '/sitemap.xml', status: 200, kind: 'urlset' }],
        sample: [
          { loc: ORIGIN + '/excluded', lastmod: null, sitemap: ORIGIN + '/sitemap.xml' },
          { loc: ORIGIN + '/gone', lastmod: null, sitemap: ORIGIN + '/sitemap.xml' },
          { loc: ORIGIN + '/moved', lastmod: null, sitemap: ORIGIN + '/sitemap.xml' },
          { loc: ORIGIN + '/never-fetched', lastmod: null, sitemap: ORIGIN + '/sitemap.xml' },
        ],
        lastmod: { count: 0, min: null, max: null },
      },
    },
  });
  const out = await run(sitemaps, ctx);
  assert.match(one(out, 'M17.sitemap.noindex_url').evidence.observed, /\/excluded \(noindex\)/);
  assert.match(one(out, 'M17.sitemap.error_url').evidence.observed, /HTTP 404/);
  assert.match(one(out, 'M17.sitemap.redirected_url').evidence.observed, /\/moved -> https:\/\/example\.test\/new/);
  assert.match(one(out, 'M17.sitemap.missing_indexable_url').evidence.observed, /not-listed/);
  assert.equal(one(out, 'M17.robots.no_sitemap_line').status, 'warn');
  assert.ok(!out.some((f) => f.evidence.observed.includes('never-fetched')), 'an unfetched loc gets no verdict');
});

test('M17 reports no sitemap at all, and needs_api when discovery did not run', async () => {
  const empty = await run(sitemaps, mkCtx({ site: { sitemaps: { found: 0, url_count: 0, declared: [], files: [], sample: [] } } }));
  assert.equal(one(empty, 'M17.sitemap.missing').status, 'fail');
  const none = await run(sitemaps, mkCtx({}));
  assert.equal(none[0].status, 'needs_api');
});

/* ------------------------------------------------------------------ M20 */

test('M20 is not_applicable without hreflang and checks reciprocity only against fetched pages', async () => {
  const mono = await run(international, mkCtx({ pages: [mkPage(ORIGIN + '/a', HTML('<title>Monolingual page</title>'))] }));
  assert.equal(mono.length, 1);
  assert.equal(mono[0].id, 'M20.hreflang.not_applicable');
  assert.equal(mono[0].status, 'not_applicable');
  assert.equal(mono[0].severity, 0);

  const en = mkPage(ORIGIN + '/en/a', HTML([
    '<title>English page in a cluster</title>',
    '<link rel="alternate" hreflang="en" href="' + ORIGIN + '/en/a">',
    '<link rel="alternate" hreflang="es" href="' + ORIGIN + '/es/a">',
    '<link rel="alternate" hreflang="en-UK" href="' + ORIGIN + '/uk/a">',
    '<link rel="alternate" hreflang="fr" href="' + ORIGIN + '/fr/a">',
  ].join('')));
  // The Spanish page points back at the English one but never lists itself.
  const es = mkPage(ORIGIN + '/es/a', HTML('<title>Pagina en espanol del cluster</title><link rel="alternate" hreflang="en" href="' + ORIGIN + '/en/a">'));
  // The UK page declares no alternates at all and canonicalises somewhere else.
  const uk = mkPage(ORIGIN + '/uk/a', HTML('<title>UK page canonicalising elsewhere</title><link rel="canonical" href="' + ORIGIN + '/en/a">'));
  const out = await run(international, mkCtx({ pages: [en, es, uk] }));
  assert.match(one(out, 'M20.hreflang.invalid_bcp47').evidence.observed, /en-UK/);
  assert.match(one(out, 'M20.hreflang.invalid_bcp47').evidence.observed, /ISO 3166-1/);
  const selfless = byId(out, 'M20.hreflang.missing_self');
  assert.equal(selfless.length, 1, 'only the Spanish page declares a set it is absent from');
  assert.equal(selfless[0].location.url, ORIGIN + '/es/a');
  const oneWay = byId(out, 'M20.hreflang.missing_reciprocal').filter((f) => f.status === 'fail');
  assert.ok(oneWay.length >= 1, 'the UK page does not link back');
  const unmeasured = byId(out, 'M20.hreflang.missing_reciprocal').filter((f) => f.status === 'needs_api');
  assert.equal(unmeasured.length, 0, 'a one-way alternate is reported instead of the unmeasured note');
  assert.equal(one(out, 'M20.hreflang.canonical_conflict').severity, 4);
  assert.ok(byId(out, 'M20.hreflang.missing_xdefault').length >= 1);
});

/* ------------------------------------------------------------------ M13 */

test('M13 asks for dateModified and reports an unparseable date instead of a mismatch', async () => {
  const html = HTML('<title>Article with only a published date</title><script type="application/ld+json">'
    + '{"@context":"https://schema.org","@type":"Article","headline":"H","datePublished":"2026-01-02"}</script>',
    '<article><h1>H</h1><p>Body copy.</p></article>');
  const out = await run(freshness, mkCtx({ pages: [mkPage(ORIGIN + '/a', html)] }));
  assert.equal(one(out, 'M13.datemodified.missing').status, 'fail');
  assert.equal(one(out, 'M13.datemodified.missing').expected_impact.confidence, 'directional');

  const junk = HTML('<title>Article with an unreadable date</title><script type="application/ld+json">'
    + '{"@context":"https://schema.org","@type":"Article","headline":"H","datePublished":"someday","dateModified":"whenever"}</script>',
    '<article><h1>H</h1><p>Body.</p></article>');
  const junkOut = await run(freshness, mkCtx({ pages: [mkPage(ORIGIN + '/b', junk)] }));
  assert.match(one(junkOut, 'M13.schema.date_unparseable').evidence.observed, /does not parse/);
});

/* ------------------------------------------------------------------ M4 */

test('M4 reports an unrendered page as needs_api and a whole CSR template at template scope', async () => {
  const render = { needed: true, signals: ['low_word_count', 'next_root_empty'], mode: 'static', renderer: 'auto', used: 'none', delta: null, hint: 'try --render js' };
  const unrendered = await run(rendering, mkCtx({ pages: [mkPage(ORIGIN + '/a', HTML('<title>Shell</title>'), { render })] }));
  const needs = one(unrendered, 'M4.render.needs_renderer');
  assert.equal(needs.status, 'needs_api');
  assert.match(needs.evidence.observed, /low_word_count/);

  const shellRender = { needed: true, signals: ['low_word_count'], mode: 'js', renderer: 'chrome', used: 'chrome', delta: { headings: 4, h1_added: 1, anchors: 12, images: 3, jsonld_blocks: 1, words: 900, title_changed: false, canonical_changed: false, meaningful: true } };
  const p1 = mkPage(ORIGIN + '/p/1', HTML('<title>Shell one</title>'), { render: shellRender, template: '/p/*|Product' });
  const p2 = mkPage(ORIGIN + '/p/2', HTML('<title>Shell two</title>'), { render: shellRender, template: '/p/*|Product' });
  const out = await run(rendering, mkCtx({ pages: [p1, p2] }));
  const csr = one(out, 'M4.render.csr_only_primary_content');
  assert.equal(csr.scope, 'template', 'a whole template rendered client-side is a template-scope fact');
  assert.equal(csr.severity, 5);
  assert.equal(csr.expected_impact.confidence, 'established');
  assert.equal(byId(out, 'M4.render.jsonld_js_injected').length, 2);
});

/* ------------------------------------------------------------------ M14 */

test('M14 posture: citation bots, Google-Extended and Content-Signal', async () => {
  const blockedText = ['User-agent: OAI-SearchBot', 'Disallow: /', '', 'User-agent: Google-Extended', 'Disallow: /', '',
    'User-agent: *', 'Disallow:', 'Content-Signal: search=no, ai-input=no, ai-train=no'].join('\n');
  const out = await run(aiCrawlers, mkCtx({ site: { robots: robotsArtifact(blockedText) }, crawl: { target: ORIGIN + '/', origin: ORIGIN } }));
  const blocked = one(out, 'M14.citation_bots.blocked');
  assert.equal(blocked.severity, 4);
  assert.match(blocked.evidence.observed, /OAI-SearchBot/);
  const ge = one(out, 'M14.google_extended.blocked_info');
  assert.equal(ge.status, 'pass', 'a Google-Extended block is informational, never a citation loss');
  assert.equal(ge.severity, 1);
  assert.equal(one(out, 'M14.content_signal.ai_input_no').expected_impact.confidence, 'directional');
  assert.equal(one(out, 'M14.content_signal.search_no').severity, 3);
  assert.equal(one(out, 'M14.content_signal.ai_train_no').status, 'pass');
  for (const f of out.filter((x) => x.id.startsWith('M14.content_signal'))) {
    assert.notEqual(f.expected_impact.confidence, 'established', f.id + ' must never claim established');
  }

  const open = await run(aiCrawlers, mkCtx({ site: { robots: robotsArtifact('User-agent: *\nDisallow:\n') }, crawl: { target: ORIGIN + '/', origin: ORIGIN } }));
  assert.equal(one(open, 'M14.retrieval.allowed').status, 'pass');
  assert.equal(one(open, 'M14.content_signal.absent').status, 'not_applicable');
});

test('M14 eligibility escalates a site-wide blocker to severity 5 and reports an undecidable page as needs_api', async () => {
  const robots = robotsArtifact('User-agent: *\nDisallow:\n');
  const noindexPages = [
    mkPage(ORIGIN + '/a', HTML('<title>Blocked one</title><meta name="robots" content="noindex">')),
    mkPage(ORIGIN + '/b', HTML('<title>Blocked two</title><meta name="robots" content="noindex">')),
  ];
  const siteWide = await run(aiEligibility, mkCtx({ pages: noindexPages, site: { robots } }));
  const lethal = one(siteWide, 'M14.ai_eligibility.not_indexable');
  assert.equal(lethal.scope, 'site');
  assert.equal(lethal.severity, 5);

  const mixed = await run(aiEligibility, mkCtx({
    pages: [noindexPages[0], mkPage(ORIGIN + '/c', HTML('<title>Fine page</title>'))],
    site: { robots },
  }));
  const perPage = one(mixed, 'M14.ai_eligibility.not_indexable');
  assert.equal(perPage.scope, 'page');
  assert.equal(perPage.severity, 4, 'a single blocked page must not reach the capping severity');
  assert.equal(one(mixed, 'M14.ai_eligibility.ok').status, 'pass');

  const noRobots = await run(aiEligibility, mkCtx({ pages: [mkPage(ORIGIN + '/c', HTML('<title>Unknown eligibility</title>'))] }));
  const unknown = one(noRobots, 'M14.ai_eligibility.ok');
  assert.equal(unknown.status, 'needs_api', 'unknown eligibility is never a pass');
  assert.match(unknown.evidence.observed, /robots_not_checked/);
});

test('M14 data-nosnippet distinguishes the primary content from an ancillary block', async () => {
  const robots = robotsArtifact('User-agent: *\nDisallow:\n');
  const primary = mkPage(ORIGIN + '/a', HTML('<title>Nosnippet on the heading</title>', '<main><div data-nosnippet><h1>The answer</h1><p>' + 'word '.repeat(40) + '</p></div></main>'));
  const primaryOut = await run(aiEligibility, mkCtx({ pages: [primary], site: { robots } }));
  assert.equal(one(primaryOut, 'M14.ai_eligibility.data_nosnippet_primary').severity, 4);

  const partial = mkPage(ORIGIN + '/b', HTML('<title>Nosnippet on a side note</title>', '<main><h1>The answer</h1><p>' + 'word '.repeat(60) + '</p><span data-nosnippet>internal ref 42</span></main>'));
  const partialOut = await run(aiEligibility, mkCtx({ pages: [partial], site: { robots } }));
  assert.equal(one(partialOut, 'M14.ai_eligibility.data_nosnippet_partial').status, 'pass');
});

/* ------------------------------------------------------------------ M21 */

test('M21 reports missing discovery files and hands the UCP block to M18 on a store', async () => {
  const discovery = {
    origin: ORIGIN,
    probes: {
      '/llms.txt': { url: ORIGIN + '/llms.txt', status: 404, ok: false },
      '/agents.md': { url: ORIGIN + '/agents.md', status: 404, ok: false },
      '/.well-known/ucp': { url: ORIGIN + '/.well-known/ucp', status: 200, ok: true, text: JSON.stringify({ ucp: { version: '2026-01-15' }, services: {}, capabilities: {} }) },
    },
    summary: { statuses: {}, found: [] },
  };
  const generic = await run(aiDiscovery, mkCtx({ site: { discovery, robots: robotsArtifact('User-agent: *\nDisallow:\n') }, crawl: { origin: ORIGIN, target: ORIGIN + '/' } }));
  assert.equal(one(generic, 'M21.llmstxt.missing').severity, 1);
  assert.equal(one(generic, 'M21.agents_md.missing').status, 'warn');
  assert.ok(generic.every((f) => f.severity <= 2), 'M21 severities stay at 2 or below');
  assert.ok(generic.every((f) => f.expected_impact.axis === 'ai'));

  const store = await run(aiDiscovery, mkCtx({
    site: { discovery, robots: robotsArtifact('User-agent: *\nDisallow:\n') },
    crawl: { origin: ORIGIN, target: ORIGIN + '/' },
    vertical: { primary: 'ecommerce', also: [], multilingual: false },
  }));
  const owned = store.find((f) => f.id.startsWith('M21.ucp.'));
  assert.equal(owned.status, 'not_applicable');
  assert.match(owned.evidence.observed, /M18/);
});

/* ------------------------------------------------------------------ M18 */

test('M18 agentic block only runs on a store and reports an unread feed as needs_api', async () => {
  const discovery = { origin: ORIGIN, probes: { '/.well-known/ucp': { url: ORIGIN + '/.well-known/ucp', status: 404, ok: false } }, summary: { statuses: {}, found: [] } };
  const notAStore = await run(agenticCommerce, mkCtx({ site: { discovery }, crawl: { origin: ORIGIN, target: ORIGIN + '/' } }));
  assert.deepEqual(notAStore, [], 'nothing agentic is reported on a site that is not e-commerce');

  const store = await run(agenticCommerce, mkCtx({
    site: { discovery }, crawl: { origin: ORIGIN, target: ORIGIN + '/' },
    vertical: { primary: 'ecommerce', also: [], multilingual: false },
  }));
  assert.equal(one(store, 'M18.agentic.ucp_profile_missing').severity, 3);
  assert.equal(one(store, 'M18.agentic.merchant_center_hint').expected_impact.confidence, 'established');
  const feed = one(store, 'M18.agentic.acp_feed_errors');
  assert.equal(feed.status, 'needs_api');
  assert.match(feed.evidence.observed, /no --feed path/);
});

test('M18 lints a supplied feed and groups the errors by reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cseo-feed-'));
  const feedPath = join(dir, 'feed.jsonl');
  writeFileSync(feedPath, [
    JSON.stringify({ item_id: 'A', title: 'T', description: 'D', url: 'not-a-url', brand: 'B', seller_name: 'S', image_url: ORIGIN + '/i.png', availability: 'in_stock', price: '10.00 USD' }),
    JSON.stringify({ item_id: 'A', title: 'T2', description: 'D', url: ORIGIN + '/p', brand: 'B', seller_name: 'S', image_url: ORIGIN + '/i.png', availability: 'maybe', price: '10.00 USD' }),
  ].join('\n'));
  try {
    const out = await run(agenticCommerce, mkCtx({
      site: { discovery: { origin: ORIGIN, probes: {}, summary: { statuses: {}, found: [] } } },
      crawl: { origin: ORIGIN, target: ORIGIN + '/' },
      vertical: { primary: 'ecommerce' },
      options: { feed_path: feedPath },
    }));
    const errors = byId(out, 'M18.agentic.acp_feed_errors').filter((f) => f.status === 'fail');
    assert.ok(errors.length >= 2, 'one finding per error class, got ' + errors.length);
    const reasons = errors.map((f) => f.title).join(' ');
    assert.match(reasons, /url_not_absolute_http/);
    assert.match(reasons, /duplicate_item_id|availability_not_in_enum/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M18 product block reports Offer gaps, variants, facets and catalogue eligibility', async () => {
  const product = mkPage(ORIGIN + '/p/1', HTML('<title>Product with an incomplete offer</title>'
    + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Thing","image":"' + ORIGIN + '/i.png",'
    + '"offers":{"@type":"Offer","price":"","availability":"https://schema.org/InStock"}}</script>'));
  const twoProducts = mkPage(ORIGIN + '/p/2', HTML('<title>Two products on one URL</title>'
    + '<script type="application/ld+json">[{"@context":"https://schema.org","@type":"Product","name":"S","offers":{"@type":"Offer","price":"1.00","priceCurrency":"EUR","availability":"https://schema.org/InStock"},"image":"i"},'
    + '{"@type":"Product","name":"M","offers":{"@type":"Offer","price":"2.00","priceCurrency":"EUR","availability":"https://schema.org/InStock"},"image":"i"}]</script>'));
  const facet = mkPage(ORIGIN + '/c?filter.color=red&sort_by=price', HTML('<title>Faceted listing page</title>'));

  const out = await run(ecommerce, mkCtx({ pages: [product, twoProducts, facet], vertical: { primary: 'ecommerce' } }));
  assert.match(one(out, 'M18.offer.missing_price').evidence.observed, /priceCurrency=undefined/);
  assert.equal(one(out, 'M18.variants.no_productgroup').severity, 3);
  assert.match(one(out, 'M18.facets.uncanonicalized').evidence.observed, /filter\.color/);
  const eligibility = byId(out, 'M18.agentic.catalog_eligibility');
  assert.equal(eligibility.length, 2);
  assert.ok(eligibility.some((f) => f.status !== 'pass'), 'the product with an empty price is not eligible');
  assert.ok(byId(out, 'M18.offer.price_feed_mismatch').every((f) => f.status === 'needs_api'), 'without a feed the comparison is unmeasured');
});

/* ------------------------------------------------------------------ M22 */

test('M22 counts improvised controls and states what static HTML cannot decide', async () => {
  const messy = mkPage(ORIGIN + '/a', HTML('<title>A page full of improvised controls</title>', [
    '<main><div onclick="go()">Continue</div><span role="button" onclick="x()">Send</span>',
    '<button></button><a href="javascript:void(0)">Menu</a>',
    '<form><input type="text" name="q"></form></main>',
  ].join('')));
  const out = await run(agentReadiness, mkCtx({ pages: [messy] }));
  const fake = one(out, 'M22.controls.non_semantic_interactive');
  assert.equal(fake.status, 'fail', 'improvised controls outnumber the native ones here');
  assert.equal(fake.expected_impact.confidence, 'directional');
  assert.equal(one(out, 'M22.controls.button_without_name').severity, 2);
  assert.equal(one(out, 'M22.links.href_javascript').severity, 2);
  assert.equal(one(out, 'M22.forms.unlabeled_controls').severity, 3);
  const notCheckable = one(out, 'M22.static.not_checkable');
  assert.equal(notCheckable.status, 'not_applicable');
  assert.match(notCheckable.evidence.observed, /target_size/);
  assert.equal(one(out, 'M22.lighthouse.agentic_browsing').status, 'needs_api');
  assert.ok(out.every((f) => f.expected_impact.confidence !== 'established'), 'nothing in M22 is established');

  const clean = await run(agentReadiness, mkCtx({
    pages: [mkPage(ORIGIN + '/b', HTML('<title>A clean, semantic page</title>', '<main><h1>Hi</h1><button type="button">Buy now</button><a href="/x">Product details</a></main>'))],
  }));
  assert.equal(one(clean, 'M22.semantics.ok').status, 'pass');
});

/* ------------------------------------------------------------------ M15 */

test('M15 is needs_api without a key and reads the PSI field block when one answers', async () => {
  const page = mkPage(ORIGIN + '/', HTML('<title>Home page of the site</title>', '<main><img src="/hero.png" alt="hero"></main>'), { role: 'homepage' });
  const ctx = mkCtx({ pages: [page], crawl: { target: ORIGIN + '/', origin: ORIGIN } });
  const noKey = await run(cwv, { ...ctx, options: { psi_key: null } });
  const needs = one(noKey, 'M15.field.needs_api');
  assert.equal(needs.status, 'needs_api');
  assert.equal(needs.severity, 4);
  const cls = one(noKey, 'M15.cls.unsized_image');
  assert.match(cls.evidence.observed, /lab-side/, 'a source heuristic must never read as a measured CLS');

  const psi = async () => ({ result: { status: 'ok', field: { has_field_data: true, origin_fallback: true, scope: 'origin', lcp_ms: 5200, lcp_rating: 'poor', cls: 0.02 } } });
  const withKey = await run(cwv, { ...ctx, options: { psi_key: 'k' }, tools: { psi } });
  const lcp = one(withKey, 'M15.lcp.exceeds_p75');
  assert.match(lcp.evidence.observed, /ORIGIN-level/, 'origin_fallback must be disclosed, not hidden');
  assert.equal(lcp.severity, 4);
});

/* ------------------------------------------------------------------ platform */

test('platform checks stay silent without a matching profile and name the owner when they suppress', async () => {
  const page = mkPage(ORIGIN + '/collections/shoes/products/red', HTML('<title>Red shoes in a collection path</title><link rel="canonical" href="' + ORIGIN + '/collections/shoes/products/red">'
    + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Red","offers":{"@type":"Offer","price":"1.00","priceCurrency":"EUR"}}</script>'));
  const noProfile = await run(platformShopify, mkCtx({ pages: [page] }));
  assert.deepEqual(noProfile, [], 'no profile means no platform findings');

  const ctx = mkCtx({
    pages: [page],
    crawl: { origin: ORIGIN, target: ORIGIN + '/' },
    site: { robots: robotsArtifact('User-agent: *\nDisallow:\n') },
    profile: { platform: { id: 'shopify', confidence: 'high' }, framework: null, cms_plugins: [], target: {} },
  });
  const out = await run(platformShopify, ctx);
  const dupe = one(out, 'M2.shopify.collection_path_duplicate');
  assert.equal(dupe.severity, 4);
  assert.match(dupe.evidence.observed, /\/products\/red/);
  const owned = one(out, 'M17.shopify.sitemap_platform_owned');
  assert.equal(owned.status, 'not_applicable');
  assert.match(owned.evidence.observed, /Owner: Shopify/);
  assert.ok(ids(out).includes('M5.shopify.theme_jsonld_gaps'));
  assert.ok(ids(out).includes('M1.shopify.tag_combo_urls_crawlable'));

  const lowConfidence = await run(platformShopify, { ...ctx, profile: { ...ctx.profile, platform: { id: 'shopify', confidence: 'low' } } });
  assert.deepEqual(lowConfidence, [], 'a low-confidence platform verdict never produces platform findings');
});

test('WordPress checks report blog_public and hand the head to the SEO plugin', async () => {
  const noindexPage = mkPage(ORIGIN + '/', HTML('<title>Site discouraging search engines</title><meta name="robots" content="noindex">'));
  const out = await run(platformWordpress, mkCtx({
    pages: [noindexPage],
    crawl: { origin: ORIGIN, target: ORIGIN + '/' },
    site: { robots: robotsArtifact('User-agent: *\nDisallow: /\n'), sitemaps: { found: 0, files: [] } },
    profile: { platform: { id: 'wordpress', confidence: 'high' }, cms_plugins: [{ id: 'yoast-seo', confidence: 'high', signals: [{ kind: 'dom', value: 'yoast' }] }], target: {} },
  }));
  const blogPublic = one(out, 'M2.wordpress.blog_public_off');
  assert.equal(blogPublic.severity, 5);
  assert.equal(blogPublic.location.resource, 'option blog_public');
  const head = one(out, 'M7.wordpress.plugin_owned_head');
  assert.equal(head.status, 'not_applicable');
  assert.match(head.evidence.observed, /yoast-seo/);
  assert.equal(one(out, 'M1.wordpress.physical_robots_shadowing').status, 'needs_api');
});

test('framework checks read the repo when there is one and report needs_api when there is not', async () => {
  const ctxNoRepo = mkCtx({
    crawl: { origin: ORIGIN, target: ORIGIN + '/' },
    profile: { platform: null, framework: { id: 'nextjs', confidence: 'high' }, target: {} },
  });
  const noRepo = await run(platformFrameworks, ctxNoRepo);
  assert.equal(noRepo.length, 1);
  assert.equal(noRepo[0].status, 'needs_api');
  assert.match(noRepo[0].evidence.observed, /project_root/);

  const repo = mkdtempSync(join(tmpdir(), 'cseo-next-'));
  try {
    mkdirSync(join(repo, 'app'), { recursive: true });
    mkdirSync(join(repo, 'public'), { recursive: true });
    writeFileSync(join(repo, 'app', 'layout.tsx'), 'export const metadata = { title: "x" };\nexport default function L(){return null}\n');
    writeFileSync(join(repo, 'app', 'robots.ts'), 'export default function robots(){return {}}\n');
    writeFileSync(join(repo, 'public', 'robots.txt'), 'User-agent: *\n');
    const out = await run(platformFrameworks, { ...ctxNoRepo, profile: { ...ctxNoRepo.profile, target: { project_root: repo } } });
    assert.equal(one(out, 'M7.nextjs.metadata_base_missing').status, 'fail');
    assert.match(one(out, 'M1.nextjs.robots_conflict').evidence.observed, /public\/robots\.txt/);
    assert.ok(ids(out).includes('M17.nextjs.sitemap_missing_source'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a non-production host is recorded so the scorer can explain its suppressed caps', async () => {
  const preview = await run(hostingEnvironment, mkCtx({
    crawl: { origin: ORIGIN, target: ORIGIN + '/' },
    profile: { environment: { kind: 'preview', signals: [{ kind: 'header', value: 'x-vercel-deployment-url' }] }, target: {} },
  }));
  assert.equal(one(preview, 'M2.hosting.preview_environment_audited').severity, 1);
  assert.match(preview[0].evidence.observed, /preview/);

  const production = await run(hostingEnvironment, mkCtx({ profile: { environment: { kind: 'production', signals: [] }, target: {} } }));
  assert.deepEqual(production, []);
});

/* ------------------------------------------------------------------ loadRunContext */

test('loadRunContext reads a run directory, its site artifacts and the ua-diff sidecar', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cseo-run-'));
  try {
    const runDir = join(root, 'run');
    mkdirSync(join(runDir, 'pages'), { recursive: true });
    mkdirSync(join(runDir, 'site'), { recursive: true });
    const html = HTML('<title>Persisted page in a run directory</title>');
    writeFileSync(join(runDir, 'pages', 'index--abcd1234.html'), html);
    writeFileSync(join(runDir, 'pages', 'index--abcd1234.json'), JSON.stringify({
      snapshot_version: 2, target: { final_url: ORIGIN + '/', slug: 'index--abcd1234' }, status: 200, headers: {},
      raw_html_path: 'pages/index--abcd1234.html', parsed: parseDocument(html, ORIGIN + '/'),
    }));
    writeFileSync(join(runDir, 'pages', 'index--abcd1234.ua-diff.json'), JSON.stringify({ baseline: 'default', variants: [], diffs: [] }));
    writeFileSync(join(runDir, 'site', 'robots.json'), JSON.stringify(robotsArtifact('User-agent: *\nDisallow:\n')));
    writeFileSync(join(runDir, 'crawl.json'), JSON.stringify({
      crawl_version: 1, origin: ORIGIN, target: ORIGIN + '/',
      pages: [{ url: ORIGIN + '/', slug: 'index--abcd1234', snapshot: 'pages/index--abcd1234.json', status: 200, role: 'homepage', template: '/|', inlinks: 0, in_sitemap: true, discovered_via: 'origin' }],
    }));

    const ctx = loadRunContext(runDir, { lang: 'en', feed_path: null });
    assert.equal(ctx.pages.length, 1);
    assert.equal(ctx.pages[0].url, ORIGIN + '/');
    assert.equal(ctx.pages[0].role, 'homepage');
    assert.equal(ctx.pages[0].html, html, 'the raw HTML is loaded from raw_html_path');
    assert.ok(ctx.pages[0].ua_diff, 'the ua-diff sidecar is attached to its page');
    assert.ok(ctx.site.robots && ctx.site.robots.verdicts, 'site/robots.json is loaded');
    assert.equal(ctx.site.sitemaps, null, 'a missing artifact is null, not an empty object');
    assert.equal(typeof ctx.tools.fetchImpl, 'function');

    const { findings, stats } = await runChecks(ctx);
    assert.equal(stats.errors.length, 0, JSON.stringify(stats.errors));
    assert.ok(findings.length > 0);
    for (const f of findings) assert.ok(validateFinding(f).ok, f.id + ' must validate');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

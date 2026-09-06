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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDocument } from '../../scripts/lib/html.mjs';
import { robotsDirectives } from '../../scripts/snapshot.mjs';
import { parseRobots, isAllowed, aiPosture } from '../../scripts/lib/robots.mjs';
import { pageSlug } from '../../scripts/lib/store.mjs';
import { validateFinding } from '../../scripts/lib/validate-finding.mjs';
import { imageSize, sniffFormat } from '../../scripts/lib/imgsize.mjs';
import { analyzeDiscovery } from '../../scripts/ai-discovery.mjs';

import { CHECKS, runChecks, loadRunContext, knownIds } from '../../scripts/checks/index.mjs';
import { isContentPage, contentPages } from '../../scripts/checks/_shared.mjs';
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
import { check as platformWordpress, THIN_ARCHIVE_RE } from '../../scripts/checks/platform-wordpress.mjs';
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

test('M9 quotes the tag a framework-bound image actually ships, and says the alt is JS-written', async () => {
  // The live allbirds run quoted a Vue-bound <img :src :alt> as `<img src="" width="96" ...>`:
  // markup the page does not contain. The claim (no alt in the static HTML) is true and stays.
  const page = mkPage(ORIGIN + '/a', HTML('<title>A Vue-rendered cart thumbnail</title>',
    '<main><p>Some copy for the page body.</p>'
    + '<img v-if="added" :src="added.image" :alt="added.title" width="96" height="96">'
    + '<img src="/hero.png" alt="A described hero" width="10" height="10"></main>'));
  const alt = one(await run(images, mkCtx({ pages: [page] })), 'M9.alt.missing');
  assert.match(alt.evidence.observed, /1 content <img> of 2 has no alt attribute: <img width="96" height="96">/);
  assert.ok(!/src=""/.test(alt.evidence.observed), 'never quote an attribute the markup does not carry: ' + alt.evidence.observed);
  assert.match(alt.evidence.observed, /1 of them carries framework-bound attributes instead \(:alt, :src\); the alt on 1 of those is written by JavaScript/);
  assert.equal(alt.expected_impact.confidence, 'established', 'the attribute is absent from the HTML a non-JS consumer reads — that is still a fact');
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
  const unparseable = one(junkOut, 'M13.schema.date_unparseable').evidence.observed;
  assert.match(unparseable, /2 schema dates do not parse/, 'the verb agrees with the count');
  const oneBad = await run(freshness, mkCtx({ pages: [mkPage(ORIGIN + '/c', HTML('<title>Article with one unreadable date</title><script type="application/ld+json">'
    + '{"@context":"https://schema.org","@type":"Article","headline":"H","datePublished":"2026-01-02","dateModified":"whenever"}</script>',
    '<article><h1>H</h1><p>Body.</p></article>'))] }));
  assert.match(one(oneBad, 'M13.schema.date_unparseable').evidence.observed, /1 schema date does not parse/);
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

test('a citation-bot block resting only on undocumented tokens is directional, not established', async () => {
  // lib/bots.mjs records Claude-Web and MistralAI-User with doc_url null / robots_reliability
  // "unknown", and references/ai-crawlers.md marks them TO-VERIFY. A severity-4 `established` fail
  // whose rationale is "each vendor documents its token and states that it honours robots.txt"
  // cannot rest on those — the repo's own rule is that only vendor-documented claims may be
  // `established`.
  const legacyOnly = ['User-agent: Claude-Web', 'Disallow: /', '', 'User-agent: MistralAI-User', 'Disallow: /', '', 'User-agent: *', 'Disallow:'].join('\n');
  const out = await run(aiCrawlers, mkCtx({ site: { robots: robotsArtifact(legacyOnly) }, crawl: { target: ORIGIN + '/', origin: ORIGIN } }));
  const f = one(out, 'M14.citation_bots.blocked');
  assert.equal(f.status, 'fail', 'the block is still reported — it is real');
  assert.equal(f.expected_impact.confidence, 'directional');
  assert.match(f.evidence.observed, /Claude-Web/);
  assert.match(f.evidence.observed, /no vendor documentation/);
  assert.doesNotMatch(f.expected_impact.rationale, /documents that the crawler honours robots\.txt/);

  // One documented token in the set restores the documented claim, and the legacy ones stay visible
  // as evidence that does not carry it.
  const mixedText = ['User-agent: OAI-SearchBot', 'Disallow: /', '', 'User-agent: Claude-Web', 'Disallow: /', '', 'User-agent: *', 'Disallow:'].join('\n');
  const mixed = one(await run(aiCrawlers, mkCtx({ site: { robots: robotsArtifact(mixedText) }, crawl: { target: ORIGIN + '/', origin: ORIGIN } })), 'M14.citation_bots.blocked');
  assert.equal(mixed.expected_impact.confidence, 'established');
  assert.match(mixed.evidence.observed, /Claude-Web .*no vendor documentation/);
  // One excluded token takes the singular verb: evidence a person reads is undermined by
  // "it is listed as evidence but do not carry the claim".
  assert.match(mixed.evidence.observed, /Claude-Web is a legacy or undocumented token .*so it is listed as evidence but does not carry the claim\./);
  assert.match(f.evidence.observed, /are legacy or undocumented tokens .*so they are listed as evidence but do not carry the claim\./,
    'the plural set keeps the plural verb');
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

  assert.equal(cls.verification.method, 'dom_assert', 'a static heuristic must not claim the PSI API as its method');
  assert.ok(noKey.every((f) => f.verification.method !== 'psi_api' || f.status === 'needs_api'),
    'with no key, every psi_api-labelled finding must be needs_api: ' + JSON.stringify(noKey.map((f) => [f.id, f.status, f.verification.method])));

  const psi = async () => ({ result: { status: 'ok', field: { has_field_data: true, origin_fallback: true, scope: 'origin', lcp_ms: 5200, lcp_rating: 'poor', cls: 0.02 } } });
  const withKey = await run(cwv, { ...ctx, options: { psi_key: 'k' }, tools: { psi } });
  const lcp = one(withKey, 'M15.lcp.exceeds_p75');
  assert.match(lcp.evidence.observed, /ORIGIN-level/, 'origin_fallback must be disclosed, not hidden');
  assert.equal(lcp.severity, 4);
});

test('the run records what the PSI client actually did, so no lab finding can raise the data tier', async () => {
  // report.mjs reads stats.psi (through checks.json) to fill data_sources.psi and the data tier.
  // A run with no key must never report PSI data, whatever verification labels the findings carry.
  const page = mkPage(ORIGIN + '/', HTML('<title>Home page of the site</title>', '<main><h1>Home</h1><p>Some copy.</p><img src="/hero.png" alt="A hero image with no width or height"></main>'), { role: 'homepage' });
  const base = mkCtx({ pages: [page], crawl: { target: ORIGIN + '/', origin: ORIGIN } });
  const offline = async () => ({ ok: false, status: 0, error: 'offline in tests', headers: {}, body: null });

  const noKey = await runChecks({ ...base, options: { psi_key: null }, tools: { fetchImpl: offline } });
  assert.equal(noKey.stats.psi, 'needs_api', 'no key means the PSI client could not answer');
  assert.ok(noKey.findings.some((f) => f.id === 'M15.cls.unsized_image'), 'the lab-side heuristic still fires');

  const psi = async () => ({ result: { status: 'ok', field: { has_field_data: true, lcp_ms: 1200, lcp_rating: 'good', cls: 0.01 } } });
  const withKey = await runChecks({ ...base, options: { psi_key: 'k' }, tools: { fetchImpl: offline, psi } });
  assert.equal(withKey.stats.psi, 'used', 'a PSI call that returned data is recorded as used, even when it emits no finding');
});

test('a non-HTML 200 is not audited as a web page', async () => {
  // /agents.md and friends are machine-readable artifacts: a missing <title> there is not a defect.
  const md = mkPage(ORIGIN + '/agents.md', '# Agent instructions\n\nPlain markdown, not a page.\n', {
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  });
  assert.equal(isContentPage(md), false, 'a text/markdown response is not a content page');
  assert.deepEqual(contentPages(mkCtx({ pages: [md] })), [], 'the on-page checks must not see it');
  assert.deepEqual(await run(onpage, mkCtx({ pages: [md] })), [], 'no title/viewport/canonical findings for a markdown file');

  const mislabelled = mkPage(ORIGIN + '/x', HTML('<title>Served with the wrong content type</title>', '<main><h1>Hi</h1></main>'), {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
  assert.equal(isContentPage(mislabelled), true, 'a body that parses as HTML is audited whatever the header says');

  const local = mkPage('file:///tmp/page.html', HTML('<title>A local file with no HTTP response</title>', '<main><h1>Hi</h1></main>'), { status: null, headers: {} });
  delete local.snapshot.headers['content-type'];
  assert.equal(isContentPage(local), true, 'a local file declares no type and is still a page');

  const notFound = mkPage(ORIGIN + '/gone', HTML('<title>Not found</title>'), { status: 404 });
  assert.equal(isContentPage(notFound), false, 'the status gate still applies');
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

test('a snapshot the crawler dropped as non-HTML is not loaded back as a page', async () => {
  // crawl.mjs takes a 200 that is not an HTML document (/agents.md, llms.txt, a JSON endpoint) out of
  // the manifest on purpose and leaves the snapshot on disk as evidence. The "manually added page"
  // fallback used to add it straight back, so the checks context held 4 pages where crawl.json and
  // report.json said 3, and every site check that iterates ctx.pages directly saw a markdown file.
  const root = mkdtempSync(join(tmpdir(), 'cseo-nonhtml-'));
  try {
    const runDir = join(root, 'run');
    mkdirSync(join(runDir, 'pages'), { recursive: true });
    const html = HTML('<title>The one real page in this run</title>');
    writeFileSync(join(runDir, 'pages', 'index--abcd1234.html'), html);
    writeFileSync(join(runDir, 'pages', 'index--abcd1234.json'), JSON.stringify({
      snapshot_version: 2, target: { final_url: ORIGIN + '/', slug: 'index--abcd1234' }, status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' }, raw_html_path: 'pages/index--abcd1234.html',
      parsed: parseDocument(html, ORIGIN + '/'),
    }));
    // Dropped by the crawler, kept on disk: markdown, and a hand-added HTML page the manifest missed.
    writeFileSync(join(runDir, 'pages', 'agents-md--ffff0000.json'), JSON.stringify({
      snapshot_version: 2, target: { final_url: ORIGIN + '/agents.md', slug: 'agents-md--ffff0000' }, status: 200,
      headers: { 'content-type': 'text/markdown; charset=utf-8' }, html_inline: { raw: '# Agents\n\nNot a web page.\n' },
    }));
    const extra = HTML('<title>A page added by hand after the crawl</title>');
    writeFileSync(join(runDir, 'pages', 'extra--11112222.json'), JSON.stringify({
      snapshot_version: 2, target: { final_url: ORIGIN + '/extra', slug: 'extra--11112222' }, status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' }, html_inline: { raw: extra }, parsed: parseDocument(extra, ORIGIN + '/extra'),
    }));
    writeFileSync(join(runDir, 'crawl.json'), JSON.stringify({
      crawl_version: 1, origin: ORIGIN, target: ORIGIN + '/',
      pages: [{ url: ORIGIN + '/', slug: 'index--abcd1234', snapshot: 'pages/index--abcd1234.json', status: 200, role: 'homepage', template: '/|', inlinks: 0, in_sitemap: true, discovered_via: 'origin' }],
    }));

    const ctx = loadRunContext(runDir, {});
    const urls = ctx.pages.map((p) => p.url).sort();
    assert.deepEqual(urls, [ORIGIN + '/', ORIGIN + '/extra'],
      'the markdown snapshot stays evidence on disk; the hand-added HTML page is still checked');
    assert.equal(contentPages(ctx).length, 2, 'and the two views of the run agree');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ discovery hydration */

const PROBE_TEXT_HEAD = 4096;

/** A site/discovery.json probe entry shaped exactly like lib/site.mjs writes one. */
function probeEntry(path, body, { saved_as = null, json_valid = null } = {}) {
  return {
    url: ORIGIN + path, status: 200, ok: true, final_url: ORIGIN + path, redirected: false,
    content_type: json_valid === null ? 'text/plain; charset=utf-8' : 'application/json',
    bytes: Buffer.byteLength(body), truncated: false, sha256: null,
    text_head: body.slice(0, PROBE_TEXT_HEAD), looks_like_html: false,
    json_valid, parsed_keys: null, saved_as, error: null,
  };
}

/** A run directory holding only crawl.json + the site/ artifacts a discovery test needs. */
function discoveryRun(root, probes, files) {
  const runDir = join(root, 'run');
  mkdirSync(join(runDir, 'pages'), { recursive: true });
  mkdirSync(join(runDir, 'site'), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(runDir, 'site', name), body);
  writeFileSync(join(runDir, 'site', 'discovery.json'), JSON.stringify({
    origin: ORIGIN, source: 'http', fetched_at: '2026-01-01T00:00:00.000Z', probes,
  }));
  writeFileSync(join(runDir, 'crawl.json'), JSON.stringify({
    crawl_version: 1, origin: ORIGIN, target: ORIGIN + '/', pages: [],
  }));
  return runDir;
}

const ECOMMERCE = { primary: 'ecommerce', also: [], multilingual: false };

test('a discovery body past the text_head preview is read from the saved artifact, not from the prefix', async () => {
  // The regression this guards: site/discovery.json only stores the first 4096 chars of each probe.
  // Validating that prefix turns a valid 5 KB UCP profile into "the store publishes no UCP profile",
  // with the probe's own HTTP 200 sitting in the same evidence string.
  const root = mkdtempSync(join(tmpdir(), 'cseo-discovery-'));
  try {
    const ucpBody = JSON.stringify({
      ucp: { version: '2026-01-01' },
      services: { 'dev.shopify.catalog': [{ version: '2026-01-01', spec: 'https://spec.example/catalog', transport: 'rest', endpoint: ORIGIN + '/api/catalog' }] },
      capabilities: { 'dev.example.checkout': [{ version: '2026-01-01', spec: 'https://spec.example/checkout' }] },
      notes: 'p'.repeat(5000),
    });
    assert.ok(ucpBody.length > PROBE_TEXT_HEAD, 'the fixture must exceed the preview cap to exercise the bug');
    // The only link sits AFTER the cap, so a prefix parse reports "no_links" and a full parse does not.
    const llmsBody = ['# Fixture store', '', '> A shop that documents itself.', '', '## Docs', '',
      'x'.repeat(4200), '', '- [Catalogue](' + ORIGIN + '/catalog): every product', ''].join('\n');

    const runDir = discoveryRun(root, {
      '/llms.txt': probeEntry('/llms.txt', llmsBody, { saved_as: 'llms.txt' }),
      '/.well-known/ucp': probeEntry('/.well-known/ucp', ucpBody, { saved_as: 'ucp.json', json_valid: true }),
    }, { 'llms.txt': llmsBody, 'ucp.json': ucpBody });

    const raw = JSON.parse(readFileSync(join(runDir, 'site', 'discovery.json'), 'utf8'));
    assert.equal(analyzeDiscovery(raw).ucp.present, false, 'guard: the un-hydrated preview really is unparseable');
    assert.equal(analyzeDiscovery(raw).llms_txt.ok, false, 'guard: the un-hydrated preview really does lose the link');

    const ctx = loadRunContext(runDir, { vertical: ECOMMERCE, profile: null });
    const hydrated = analyzeDiscovery(ctx.site.discovery);
    assert.equal(hydrated.ucp.present, true, 'loadRunContext must hydrate the saved body');
    assert.equal(hydrated.ucp.ok, true);
    assert.equal(hydrated.llms_txt.ok, true, 'the link past the cap is seen');
    assert.equal(hydrated.llms_txt.links_total, 1);
    assert.equal(hydrated.llms_txt.truncated_source, false, 'a hydrated probe is not a truncated one');

    const m18 = await run(agenticCommerce, ctx);
    assert.ok(!m18.some((f) => f.id === 'M18.agentic.ucp_profile_missing'),
      'a published profile must never be reported missing: ' + JSON.stringify(m18.map((f) => [f.id, f.evidence.observed])));
    assert.equal(one(m18, 'M18.agentic.shopify_catalog_declared').status, 'pass');

    const m21 = await run(aiDiscovery, ctx);
    assert.ok(!m21.some((f) => f.id === 'M21.llmstxt.malformed'),
      'a well-formed llms.txt must not be called malformed because of the preview cap');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('when only the head of a discovery body survives, the finding says so instead of claiming absence', async () => {
  // No saved_as: an --artifacts-limited run, or a body past the save limit. Hydration cannot help,
  // so the honest states are a disclosed partial parse (llms.txt) and needs_api (UCP).
  const root = mkdtempSync(join(tmpdir(), 'cseo-discovery-truncated-'));
  try {
    const ucpBody = JSON.stringify({ ucp: { version: '2026-01-01' }, services: {}, notes: 'p'.repeat(5000) });
    const llmsBody = ['# Fixture store', '', '## Docs', '', '- Product catalogue: ' + ORIGIN + '/catalog', '',
      'x'.repeat(4200), '', '- [Catalogue](' + ORIGIN + '/catalog): every product', ''].join('\n');
    const runDir = discoveryRun(root, {
      '/llms.txt': probeEntry('/llms.txt', llmsBody),
      '/.well-known/ucp': probeEntry('/.well-known/ucp', ucpBody, { json_valid: true }),
    }, {});

    const ctx = loadRunContext(runDir, { vertical: ECOMMERCE, profile: null });
    const d = analyzeDiscovery(ctx.site.discovery);
    assert.equal(d.llms_txt.truncated_source, true, 'guard: nothing was saved, so only text_head exists');
    assert.equal(d.ucp.body_unread, true, 'a UCP body we only read the head of is unknown, not absent');

    const m21 = await run(aiDiscovery, ctx);
    const malformed = one(m21, 'M21.llmstxt.malformed');
    assert.match(malformed.evidence.observed, /line 5: malformed_list_item/, 'the defect is still reported');
    assert.match(malformed.evidence.observed, /Parsed from the first \d+ of \d+ bytes/,
      'a line-precise claim built from a prefix must disclose the prefix: ' + malformed.evidence.observed);

    const m18 = await run(agenticCommerce, ctx);
    const ucp = one(m18, 'M18.agentic.ucp_profile_missing');
    assert.equal(ucp.status, 'needs_api', 'an unread body is needs_api, never a "no profile" claim');
    assert.match(ucp.evidence.observed, /not fully captured/);
    assert.match(ucp.evidence.observed, /Parsed from/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ evidence rendering (round-2 fixes) */

test('M22 evidence quotes the offending markup instead of stringifying the example objects', async () => {
  const messy = mkPage(ORIGIN + '/a', HTML('<title>A page full of improvised controls</title>', [
    '<main><div class="cta primary" onclick="go()">Continue</div>',
    '<button class="icon-only" id="cart"></button>',
    '<a href="/x"><img src="/i.png"></a>',
    '<a href="javascript:void(0)">Menu</a>',
    '<form><input type="email" name="signup_email" placeholder="you@example.com"></form></main>',
  ].join('')));
  const out = await run(agentReadiness, mkCtx({ pages: [messy] }));

  for (const f of out) {
    assert.ok(!/\[object Object\]/.test(JSON.stringify(f)), f.id + ' must never ship [object Object]: ' + f.evidence.observed);
  }
  assert.match(one(out, 'M22.controls.non_semantic_interactive').evidence.observed, /<div class="cta primary" onclick>/);
  assert.match(one(out, 'M22.controls.button_without_name').evidence.observed, /<button id="cart" class="icon-only">/);
  assert.match(one(out, 'M22.links.empty_name').evidence.observed, /<a href="\/x">.*no text/);
  assert.match(one(out, 'M22.links.href_javascript').evidence.observed, /<a href="javascript:void\(0\)"> "Menu"/);
  assert.match(one(out, 'M22.forms.unlabeled_controls').evidence.observed, /<input type="email" name="signup_email" placeholder="you@example.com">/);
});

test('M21 broken agentic sitemap names each parse error, and an HTML soft-404 is reported as absent', async () => {
  const withXml = (body) => ({
    origin: ORIGIN,
    probes: {
      '/sitemap_agentic_discovery.xml': { url: ORIGIN + '/sitemap_agentic_discovery.xml', status: 200, ok: true, content_type: 'application/xml', looks_like_html: false, text: body },
    },
    summary: { statuses: {}, found: [] },
  });
  const broken = await run(aiDiscovery, mkCtx({ site: { discovery: withXml('<?xml version="1.0"?><sitemapindex><sitemap><loc>' + ORIGIN + '/s.xml</loc></sitemap></sitemapindex>') }, crawl: { origin: ORIGIN, target: ORIGIN + '/' } }));
  const f = one(broken, 'M21.agentic_sitemap.broken_locs');
  assert.ok(!/\[object Object\]/.test(f.evidence.observed), f.evidence.observed);
  assert.match(f.evidence.observed, /xml: sitemapindex_not_urlset/);

  // A Next.js style catch-all page served at that path means the file does not exist: reporting it
  // as a published-but-broken sitemap would invent a defect.
  const soft404 = withXml('<!doctype html><html><body>Page not found</body></html>');
  soft404.probes['/sitemap_agentic_discovery.xml'].content_type = 'text/html; charset=utf-8';
  soft404.probes['/sitemap_agentic_discovery.xml'].looks_like_html = true;
  const out = await run(aiDiscovery, mkCtx({ site: { discovery: soft404 }, crawl: { origin: ORIGIN, target: ORIGIN + '/' } }));
  assert.equal(byId(out, 'M21.agentic_sitemap.broken_locs').length, 0, 'a soft 404 is not a broken sitemap');
  assert.equal(byId(out, 'M21.agentic_sitemap.present').length, 0, 'and it is not a published one either');
});

test('M18 keeps one finding per feed error class (distinct locations) and counts rows, not the sampled flag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cseo-feed-classes-'));
  const feedPath = join(dir, 'feed.jsonl');
  writeFileSync(feedPath, [
    JSON.stringify({ item_id: 'A', title: 'T', description: 'D', url: 'not-a-url', brand: 'B', seller_name: 'S', image_url: ORIGIN + '/i.png', availability: 'in_stock', price: '10.00 USD' }),
    JSON.stringify({ item_id: 'A', title: 'T2', description: 'D', url: ORIGIN + '/p', brand: 'B', seller_name: 'S', image_url: ORIGIN + '/i.png', availability: 'maybe', price: 'ten dollars' }),
  ].join('\n'));
  try {
    const out = await run(agenticCommerce, mkCtx({
      site: { discovery: { origin: ORIGIN, probes: {}, summary: { statuses: {}, found: [] } } },
      crawl: { origin: ORIGIN, target: ORIGIN + '/' },
      vertical: { primary: 'ecommerce' },
      options: { feed_path: feedPath },
    }));
    const errors = byId(out, 'M18.agentic.acp_feed_errors').filter((f) => f.status === 'fail');
    const classes = errors.map((f) => f.location.selector).sort();
    assert.deepEqual(classes, ['availability_not_in_enum', 'duplicate_item_id', 'price_format', 'url_not_absolute_http']);
    // report.mjs dedupes on id + scope + url + file + resource + selector: without the selector all
    // four collapse into one and three of the four defects are never reported.
    assert.equal(new Set(errors.map((f) => [f.id, f.scope, f.location.file, f.location.selector].join('|'))).size, 4);
    for (const f of errors) {
      assert.match(f.evidence.observed, /of 2 rows linted \(the whole jsonl feed\)/, 'the row count must be a number, not the truncation flag');
      assert.ok(!/ of (true|false) /.test(f.evidence.observed), f.evidence.observed);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M5 reports Product-without-Offer once per page and leaves variant reference stubs to M18', async () => {
  const group = mkPage(ORIGIN + '/p/group', HTML('<title>A product group with variant stubs</title>'
    + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"ProductGroup","name":"Runner",'
    + '"hasVariant":[{"@type":"Product","url":"' + ORIGIN + '/p/1"},{"@type":"Product","url":"' + ORIGIN + '/p/2"},{"@type":"Product","url":"' + ORIGIN + '/p/3"}]}</script>'));
  const stubsOnly = await run(schema, mkCtx({ pages: [group] }));
  assert.equal(byId(stubsOnly, 'M5.product.missing_offer_price').length, 0,
    'a hasVariant entry that carries only a url is a reference, not a Product missing its price');

  const twoReal = mkPage(ORIGIN + '/p/two', HTML('<title>Two real products, neither priced</title>'
    + '<script type="application/ld+json">[{"@context":"https://schema.org","@type":"Product","name":"Alpha","image":"/a.png"},'
    + '{"@type":"Product","name":"Beta","image":"/b.png","url":"' + ORIGIN + '/p/beta"}]</script>'));
  const out = await run(schema, mkCtx({ pages: [twoReal] }));
  const f = one(out, 'M5.product.missing_offer_price');
  assert.equal(f.status, 'fail');
  assert.match(f.evidence.observed, /2 Product nodes on .* declare no `offers` property/);
  assert.match(f.evidence.observed, /Alpha/);
  assert.match(f.evidence.observed, /Beta/);
});

test('a schema-invalid finding is counted in stats.dropped and named, instead of vanishing', async () => {
  const shared = await import('../../scripts/checks/_shared.mjs');
  // mk() throws inside node:test on purpose; production returns null. Drop the marker for one
  // synchronous call so the production path is the one under test.
  const marker = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  let result;
  try {
    shared.takeDropped();
    result = shared.mk({ id: 'M7.title.missing', title: 'Missing everything else' });
  } finally {
    if (marker !== undefined) process.env.NODE_TEST_CONTEXT = marker;
  }
  assert.equal(result, null, 'an invalid finding is still not returned');
  const drops = shared.takeDropped();
  assert.equal(drops.entries.length, 1);
  assert.equal(drops.total, 1, 'the count and the entries agree below the cap');
  assert.deepEqual([drops.entries[0].id, drops.entries[0].module], ['M7.title.missing', 'M7']);
  assert.ok(drops.entries[0].errors.length > 0, 'the validation errors are kept so the regression is diagnosable');
  assert.deepEqual(shared.takeDropped(), { entries: [], total: 0 }, 'draining the log clears it');

  // runChecks() drains the same log after every check, so the counter is wired to stats.
  const { stats } = await runChecks(mkCtx({ pages: [] }));
  assert.equal(stats.dropped, 0, 'a clean run reports zero drops');
  assert.deepEqual(stats.dropped_findings, [], 'and names none');
});

test('drops past the entry cap are still counted, so the total can never under-report', async () => {
  const shared = await import('../../scripts/checks/_shared.mjs');
  const marker = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    shared.takeDropped();
    for (let i = 0; i < 130; i++) shared.mk({ id: 'M7.title.missing', title: 'Missing everything else' });
  } finally {
    if (marker !== undefined) process.env.NODE_TEST_CONTEXT = marker;
  }
  const drops = shared.takeDropped();
  assert.equal(drops.entries.length, 100, 'the named list stays bounded');
  assert.equal(drops.total, 130, 'the count is exact — a silent under-report is the bug this log exists to prevent');
  assert.deepEqual(shared.takeDropped(), { entries: [], total: 0 }, 'the counter is zeroed with the entries');
});

/* ------------------------------------------------------------------ pointers vs declarations */

test('M5 leaves a review widget\'s itemReviewed alone: a back-reference is not a Product missing its Offer', async () => {
  const page = mkPage(ORIGIN + '/p/wool-runners', HTML(
    '<title>A variant page carrying a review widget</title>'
    + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"ProductGroup","name":"Wool Runners",'
    + '"image":"' + ORIGIN + '/i.png","offers":{"@type":"Offer","price":"110.00","priceCurrency":"USD","availability":"https://schema.org/InStock"},'
    + '"hasVariant":[{"@type":"Product","url":"' + ORIGIN + '/p/wool-runners?size=8"},{"@type":"Product","url":"' + ORIGIN + '/p/wool-runners?size=9"}]}</script>'
    + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"AggregateRating","ratingValue":"4.6","reviewCount":"812",'
    + '"itemReviewed":{"@type":"Product","name":"Wool Runners","image":"' + ORIGIN + '/i.png","brand":{"@type":"Brand","name":"Acme"}}}</script>',
    '<main><h1>Wool Runners</h1><p>Buy the Wool Runners for $110.00 today, in every size we stock.</p></main>',
  ));
  const out = await run(schema, mkCtx({ pages: [page] }));
  assert.equal(byId(out, 'M5.product.missing_offer_price').length, 0,
    'the ProductGroup carries the offer and the itemReviewed node points at it — neither is a Product short of a price');

  // The same node OUTSIDE a back-reference property is a declaration and is still reported.
  const bare = mkPage(ORIGIN + '/p/bare', HTML('<title>A product declared with no offer at all</title>'
    + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Wool Runners","image":"/i.png"}</script>'));
  assert.equal(one(await run(schema, mkCtx({ pages: [bare] })), 'M5.product.missing_offer_price').status, 'fail');
});

test('M18 catalogue eligibility describes the primary node, not a url-only hasVariant stub', async () => {
  const page = mkPage(ORIGIN + '/p/runners', HTML(
    '<title>A product group with variant stubs</title>'
    + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"ProductGroup","name":"Wool Runners",'
    + '"image":"' + ORIGIN + '/i.png","offers":{"@type":"Offer","price":"110.00","priceCurrency":"USD","availability":"https://schema.org/InStock"},'
    + '"hasVariant":[{"@type":"Product","url":"' + ORIGIN + '/p/runners?size=8"},{"@type":"Product","url":"' + ORIGIN + '/p/runners?size=9"}]}</script>',
    '<main><h1>Wool Runners</h1><p>Buy the Wool Runners for $110.00 today.</p></main>',
  ));
  const out = await run(ecommerce, mkCtx({ pages: [page], vertical: { primary: 'ecommerce' } }));
  const elig = one(out, 'M18.agentic.catalog_eligibility');
  assert.equal(elig.status, 'pass', elig.evidence.observed);
  assert.match(elig.evidence.observed, /ProductGroup: title="Wool Runners"/);
  assert.match(elig.evidence.observed, /price=110 \(ProductGroup\.offers\)/);
  assert.ok(!/missing/.test(elig.evidence.observed), elig.evidence.observed);
  assert.equal(byId(out, 'M18.variants.no_productgroup').length, 0, 'variant stubs are not "several Product blocks"');
});

/* The shape a real Shopify variant page emits (allbirds.com/products/mens-wool-runners-…): one
   ProductGroup carrying brand/sku/offers, 20 url-only hasVariant stubs, one fully described variant,
   and a review widget whose itemReviewed points back at the item. Every module that reads Product
   nodes has to agree that this page declares ONE product — the live run reported "29 Product nodes",
   "ProductGroup.hasVariant[0] lacks brand, sku, gtin, offers.url" and a missing Offer at once. */
const ALLBIRDS_JSONLD = (origin) => {
  const stubs = Array.from({ length: 20 }, (_, i) => ({ '@type': 'Product', url: origin + '/products/wool-runners?size=' + (i + 5) }));
  return JSON.stringify({
    '@context': 'https://schema.org', '@type': 'ProductGroup', name: 'Wool Runners',
    brand: { '@type': 'Brand', name: 'Allbirds' }, sku: 'WR-NAT-WHITE', gtin13: '0123456789012', image: origin + '/i.png',
    productGroupID: 'WR', url: origin + '/products/wool-runners',
    offers: { '@type': 'Offer', price: '110.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock', url: origin + '/products/wool-runners' },
    hasVariant: [...stubs, {
      '@type': 'Product', name: 'Wool Runners — 9', sku: 'WR-9', image: origin + '/9.png',
      offers: { '@type': 'Offer', price: '110.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock', url: origin + '/products/wool-runners?size=9' },
    }],
    aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.6', reviewCount: '812', itemReviewed: { '@type': 'Product', name: 'Wool Runners', image: origin + '/i.png' } },
  });
};

const allbirdsPage = () => mkPage(ORIGIN + '/products/wool-runners', HTML(
  '<title>Wool Runners — a ProductGroup with 21 variants</title>'
  + '<script type="application/ld+json">' + ALLBIRDS_JSONLD(ORIGIN) + '</script>',
  '<main><h1>Wool Runners</h1><p>Buy the Wool Runners for $110.00 in every size we stock.</p></main>',
));

test('a ProductGroup with 20 url-only variant stubs is one declared product, not 21', async () => {
  const page = allbirdsPage();
  const shopifyCtx = mkCtx({
    pages: [page],
    crawl: { origin: ORIGIN, target: ORIGIN + '/products/wool-runners' },
    site: { robots: robotsArtifact('User-agent: *\nDisallow: /collections/*+*\nDisallow: /collections/*%2B*\nDisallow: *sort_by*\nDisallow: /collections/*filter*\n') },
    profile: { platform: { id: 'shopify', confidence: 'high' }, framework: null, cms_plugins: [], target: {} },
  });
  const shop = await run(platformShopify, shopifyCtx);
  assert.equal(byId(shop, 'M5.shopify.duplicate_product_jsonld').length, 0,
    'hasVariant entries are the documented way to model variants, not a second Product block');
  assert.equal(byId(shop, 'M5.shopify.theme_jsonld_gaps').length, 0,
    'brand, sku and offers.url are on the group; the variants inherit them');

  assert.equal(byId(await run(schema, mkCtx({ pages: [page] })), 'M5.product.missing_offer_price').length, 0,
    'the group carries the Offer and the stubs point at variants defined elsewhere');

  const shopping = await run(ecommerce, mkCtx({ pages: [page], vertical: { primary: 'ecommerce' } }));
  assert.equal(byId(shopping, 'M18.variants.no_productgroup').length, 0);
  const elig = one(shopping, 'M18.agentic.catalog_eligibility');
  assert.equal(elig.status, 'pass', elig.evidence.observed);
  assert.match(elig.evidence.observed, /ProductGroup: title="Wool Runners"/);
});

test('Shopify still reports two real Product declarations, and names the pointers it left out', async () => {
  const themeAndApp = mkPage(ORIGIN + '/products/dup', HTML(
    '<title>Theme and app both emit Product markup</title>'
    + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Runner","sku":"R1","brand":"Acme",'
    + '"offers":{"@type":"Offer","price":"10.00","priceCurrency":"USD","url":"' + ORIGIN + '/products/dup"},'
    + '"isSimilarTo":{"@type":"Product","name":"Other","image":"' + ORIGIN + '/o.png","description":"A related product"}}</script>'
    + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Runner (app)","sku":"R1",'
    + '"brand":"Acme","offers":{"@type":"Offer","price":"10.00","priceCurrency":"USD","url":"' + ORIGIN + '/products/dup"}}</script>'));
  const out = await run(platformShopify, mkCtx({
    pages: [themeAndApp],
    crawl: { origin: ORIGIN, target: ORIGIN + '/products/dup' },
    site: { robots: robotsArtifact('User-agent: *\nDisallow:\n') },
    profile: { platform: { id: 'shopify', confidence: 'high' }, framework: null, cms_plugins: [], target: {} },
  }));
  const dupe = one(out, 'M5.shopify.duplicate_product_jsonld');
  assert.match(dupe.evidence.observed, /^2 Product nodes declared/);
  assert.match(dupe.evidence.observed, /isSimilarTo/, 'the excluded pointer is named, so the count is auditable');
  // The gap list may still fire (neither node carries a gtin) — but never against a pointer.
  for (const gap of byId(out, 'M5.shopify.theme_jsonld_gaps')) {
    assert.doesNotMatch(gap.evidence.observed, /hasVariant|isSimilarTo|itemReviewed/, gap.evidence.observed);
  }
});

test('M18 prices a ProductGroup from its variants when the group carries no offers of its own', async () => {
  const page = mkPage(ORIGIN + '/products/tree', HTML(
    '<title>A ProductGroup priced through its variants</title>'
    + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"ProductGroup","name":"Tree Runners",'
    + '"image":"' + ORIGIN + '/t.png","brand":"Acme","hasVariant":['
    + '{"@type":"Product","name":"Tree Runners — 8","sku":"T8","offers":{"@type":"Offer","price":"98.00","priceCurrency":"USD","availability":"https://schema.org/InStock","url":"' + ORIGIN + '/products/tree?size=8"}},'
    + '{"@type":"Product","name":"Tree Runners — 9","sku":"T9","offers":{"@type":"Offer","price":"110.00","priceCurrency":"USD","availability":"https://schema.org/InStock","url":"' + ORIGIN + '/products/tree?size=9"}}]}</script>',
    '<main><h1>Tree Runners</h1><p>From $98.00.</p></main>',
  ));
  const elig = one(await run(ecommerce, mkCtx({ pages: [page], vertical: { primary: 'ecommerce' } })), 'M18.agentic.catalog_eligibility');
  assert.equal(elig.status, 'pass', elig.evidence.observed);
  assert.match(elig.evidence.observed, /price=98 \(ProductGroup\.hasVariant\[0\]\.offers, the lowest of 2 variant offers the group carries\)/);
  assert.ok(!/missing/.test(elig.evidence.observed), elig.evidence.observed);
});

/* Two sibling root ProductGroups — a theme and an app each emitting one, the shape
   M5.shopify.duplicate_product_jsonld exists to report. Both flatten to the path "ProductGroup",
   so matching variants by path prefix priced group A from group B's cheapest offer and let group
   B's gtin answer for group A. Membership is object identity; the paths only name the evidence. */
const TWO_GROUPS_HTML = () => HTML(
  '<title>A theme and an app each emit a ProductGroup</title>'
  + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"ProductGroup","name":"Group A",'
  + '"url":"' + ORIGIN + '/products/a","image":"' + ORIGIN + '/a.png","brand":"Acme","sku":"A-SKU","hasVariant":['
  + '{"@type":"Product","name":"A — 8","sku":"A8","offers":{"@type":"Offer","price":"500.00","priceCurrency":"USD","availability":"https://schema.org/InStock","url":"' + ORIGIN + '/products/a?size=8"}},'
  + '{"@type":"Product","name":"A — 9","sku":"A9","offers":{"@type":"Offer","price":"700.00","priceCurrency":"USD","availability":"https://schema.org/InStock","url":"' + ORIGIN + '/products/a?size=9"}}]}</script>'
  + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"ProductGroup","name":"Group B",'
  + '"image":"' + ORIGIN + '/b.png","hasVariant":['
  + '{"@type":"Product","name":"B — 8","gtin13":"0123456789012","offers":{"@type":"Offer","price":"10.00","priceCurrency":"USD","availability":"https://schema.org/InStock"}}]}</script>',
  '<main><h1>Group A</h1><p>Group A costs $500.00 and up.</p></main>',
);

test('M18 prices a ProductGroup from its own variants when a second group shares its flatten path', async () => {
  const page = mkPage(ORIGIN + '/products/a', TWO_GROUPS_HTML());
  const out = await run(ecommerce, mkCtx({ pages: [page], vertical: { primary: 'ecommerce' } }));
  const elig = one(out, 'M18.agentic.catalog_eligibility');
  assert.equal(elig.status, 'pass', elig.evidence.observed);
  assert.match(elig.evidence.observed, /ProductGroup: title="Group A"/);
  assert.match(elig.evidence.observed, /price=500 \(ProductGroup\.hasVariant\[0\]\.offers, the lowest of 2 variant offers the group carries\)/,
    'the page renders $500; 10 is the other group\'s price and stating it would be a false claim');
  assert.ok(!/price=10\b/.test(elig.evidence.observed), elig.evidence.observed);
});

test('Shopify judges each sibling ProductGroup on its own identifiers, and counts only its variants', async () => {
  const page = mkPage(ORIGIN + '/products/a', TWO_GROUPS_HTML());
  const out = await run(platformShopify, mkCtx({
    pages: [page],
    crawl: { origin: ORIGIN, target: ORIGIN + '/products/a' },
    site: { robots: robotsArtifact('User-agent: *\nDisallow:\n') },
    profile: { platform: { id: 'shopify', confidence: 'high' }, framework: null, cms_plugins: [], target: {} },
  }));

  const dupe = one(out, 'M5.shopify.duplicate_product_jsonld');
  assert.match(dupe.evidence.observed, /ProductGroup "Group A", ProductGroup\[1\] "Group B"/,
    'two roots of one type share a path, so the second is named — evidence has to point at one node');

  const gaps = one(out, 'M5.shopify.theme_jsonld_gaps');
  assert.match(gaps.evidence.observed, /ProductGroup \(with its 2 variant nodes\) lacks gtin/,
    'group A really has no gtin; group B\'s gtin13 must not answer for it, and the 2 nested Offers are not variants');
  assert.match(gaps.evidence.observed, /ProductGroup\[1\] \(with its 1 variant node\) lacks brand, sku, offers\.url/,
    'group B carries neither brand nor sku — group A\'s must not satisfy it');
});

/* M17.wordpress.duplicate_sitemaps — the id that told techcrunch.com it had three sitemap sources
   when /wp-sitemap.xml 301s to /sitemap_index.xml, which 302s to /sitemap.xml. Duplication is a
   claim about two different URL sets, so it is only made when two different documents were read. */
const smFile = (path, over = {}) => ({
  url: ORIGIN + path,
  final_url: over.final_url || ORIGIN + path,
  redirected: !!over.final_url && over.final_url !== ORIGIN + path,
  alias_of: over.alias_of || null,
  source: 'well-known', parent: over.parent || null, depth: 0,
  status: over.status === undefined ? 200 : over.status,
  kind: over.kind || 'urlset', url_count: (over.locs || []).length, errors: [], lastmod: null, error: null,
});
const smSite = (files, over = {}) => ({
  found: files.filter((f) => f.kind && f.kind !== 'invalid' && !f.alias_of).length,
  files,
  urls: files.flatMap((f) => (f.locs || []).map((loc) => ({ loc, lastmod: null, sitemap: f.url }))),
  truncated_files: false, truncated_urls: false, ...over,
});
const wpCtx = (sitemaps) => mkCtx({
  pages: [mkPage(ORIGIN + '/', HTML('<title>A WordPress site with more than one sitemap path</title>'))],
  crawl: { origin: ORIGIN, target: ORIGIN + '/' },
  site: { robots: robotsArtifact('User-agent: *\nDisallow:\n'), sitemaps },
  profile: { platform: { id: 'wordpress', confidence: 'high' }, cms_plugins: [], target: {} },
});
/** files carry `locs` for the fixture builder; the check reads site.sitemaps.urls. */
const withLocs = (path, locs, over = {}) => Object.assign(smFile(path, { ...over, locs }), { locs });

test('three sitemap paths that redirect to one document are one source, not three', async () => {
  const canonical = withLocs('/sitemap.xml', [ORIGIN + '/a', ORIGIN + '/b']);
  const files = [
    canonical,
    withLocs('/sitemap_index.xml', [], { final_url: ORIGIN + '/sitemap.xml', alias_of: ORIGIN + '/sitemap.xml', kind: 'sitemapindex' }),
    withLocs('/wp-sitemap.xml', [], { final_url: ORIGIN + '/sitemap.xml', alias_of: ORIGIN + '/sitemap.xml', kind: 'sitemapindex' }),
  ];
  const f = one(await run(platformWordpress, wpCtx(smSite(files))), 'M17.wordpress.duplicate_sitemaps');
  assert.equal(f.status, 'pass', f.evidence.observed);
  assert.match(f.evidence.observed, /redirects to \/sitemap\.xml/);
  assert.doesNotMatch(f.evidence.observed, /\bboth\b/, 'three items joined with "and" plus "both" was the grammar bug');
});

test('two sitemap paths serving the same URL set are one source; different sets are the real defect', async () => {
  const same = [
    withLocs('/wp-sitemap.xml', [ORIGIN + '/a', ORIGIN + '/b']),
    withLocs('/sitemap_index.xml', [ORIGIN + '/a', ORIGIN + '/b']),
  ];
  const identical = one(await run(platformWordpress, wpCtx(smSite(same))), 'M17.wordpress.duplicate_sitemaps');
  assert.equal(identical.status, 'pass', identical.evidence.observed);
  assert.match(identical.evidence.observed, /the same set/);

  const different = [
    withLocs('/wp-sitemap.xml', [ORIGIN + '/a', ORIGIN + '/b']),
    withLocs('/sitemap_index.xml', [ORIGIN + '/c']),
  ];
  const dupe = one(await run(platformWordpress, wpCtx(smSite(different))), 'M17.wordpress.duplicate_sitemaps');
  assert.equal(dupe.status, 'warn');
  assert.equal(dupe.expected_impact.confidence, 'established', 'both URL lists were read, so the disagreement is measured');
  assert.match(dupe.evidence.observed, /\/wp-sitemap\.xml lists 2 URLs/);
  assert.match(dupe.evidence.observed, /\/sitemap_index\.xml lists 1 URL\b/);
});

test('an unread URL list downgrades the duplicate-sitemap claim to directional', async () => {
  const files = [withLocs('/wp-sitemap.xml', [ORIGIN + '/a']), withLocs('/sitemap_index.xml', [ORIGIN + '/c'])];
  const f = one(await run(platformWordpress, wpCtx(smSite(files, { truncated_files: true }))), 'M17.wordpress.duplicate_sitemaps');
  assert.equal(f.status, 'warn');
  assert.equal(f.expected_impact.confidence, 'directional');
  assert.match(f.evidence.observed, /not both collected/);
  assert.doesNotMatch(f.expected_impact.rationale, /different URL sets/);
});

test('one sitemap path stays silent, and no reachable sitemap at all is still a failure', async () => {
  const solo = await run(platformWordpress, wpCtx(smSite([withLocs('/sitemap.xml', [ORIGIN + '/a'])])));
  assert.equal(byId(solo, 'M17.wordpress.duplicate_sitemaps').length, 0, 'nothing to say about one source');
  const none = await run(platformWordpress, wpCtx({ found: 0, files: [], urls: [] }));
  assert.equal(one(none, 'M17.wordpress.no_sitemap_any').status, 'fail');
});

test('WordPress thin-archive detection matches date archives and never a dated post permalink', async () => {
  for (const p of ['/2026/', '/2026', '/2026/09/', '/2026/09/05/', '/category/news/', '/tag/seo/', '/author/jo/', '/page/2/']) {
    assert.ok(THIN_ARCHIVE_RE.test(p), p + ' is an archive path');
  }
  for (const p of ['/2026/09/05/seattle-times-and-newsday-partner/', '/2026/09/05/slug', '/2026/09/post/', '/blog/2026/09/', '/about/']) {
    assert.ok(!THIN_ARCHIVE_RE.test(p), p + ' is a post permalink, not an archive');
  }

  const post = mkPage(ORIGIN + '/2026/09/05/a-real-article/', HTML('<title>A dated post permalink on WordPress</title>',
    '<main><h1>A real article</h1><p>The permalink structure is /%year%/%monthnum%/%day%/%postname%/.</p></main>'));
  const archive = mkPage(ORIGIN + '/2026/09/', HTML('<title>The September 2026 date archive</title>',
    '<main><h1>September 2026</h1><p>Everything published that month.</p></main>'));
  const base = mkCtx({
    crawl: { origin: ORIGIN, target: ORIGIN + '/' },
    site: { robots: robotsArtifact('User-agent: *\nAllow: /\n'), sitemaps: { found: 1, files: [] } },
    profile: { platform: { id: 'wordpress', confidence: 'high' }, cms_plugins: [], target: {} },
  });

  const postOnly = await run(platformWordpress, { ...base, pages: [post] });
  assert.equal(byId(postOnly, 'M2.wordpress.thin_archives_indexable').length, 0,
    'noindexing this URL would noindex the article itself');

  const withArchive = await run(platformWordpress, { ...base, pages: [post, archive] });
  const thin = one(withArchive, 'M2.wordpress.thin_archives_indexable');
  assert.match(thin.evidence.observed, /\/2026\/09\//);
  assert.ok(!thin.evidence.observed.includes('a-real-article'), thin.evidence.observed);
});

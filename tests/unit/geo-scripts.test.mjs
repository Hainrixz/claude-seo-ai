// Phase 4 GEO scripts: ai-eligibility, ua-diff, ai-discovery, acp-feed-lint, agent-readiness,
// probe-report and gsc-ai-import. Everything is fixture- or injection-driven: the only network is
// the local fixture server in tests/helpers/server.mjs, and ua-diff runs against an injected
// fetchImpl so no request leaves the process.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { tokenize, parseDocument } from '../../scripts/lib/html.mjs';
import { parseRobots } from '../../scripts/lib/robots.mjs';

import { analyzeEligibility, dataNosnippet, normalizeRobots, main as eligibilityMain, LOW_MAX_SNIPPET } from '../../scripts/ai-eligibility.mjs';
import { summarizeVariant, diffVariants, collectVariants, main as uaDiffMain, DEFAULT_UAS } from '../../scripts/ua-diff.mjs';
import {
  validateLlmsTxt, validateAgentsMd, validateUcp, validateAiCatalog, validateAgenticSitemap,
  discoveryRobotsCheck, analyzeDiscovery, main as discoveryMain, DISCOVERY_AUDIENCE,
} from '../../scripts/ai-discovery.mjs';
import { lintFeed, parseDelimited, parseJsonl, parseFeed, detectFormat, gtinValid, parsePrice, main as feedMain } from '../../scripts/acp-feed-lint.mjs';
import { analyzeAgentReadiness, serverRenderedFrom, accessibleName, nameText, NOT_CHECKABLE_STATIC, main as agentMain } from '../../scripts/agent-readiness.mjs';
import { analyzeProbes, trendAgainst, previousReport, main as probeMain, DISCLAIMER, PROBE_KIND } from '../../scripts/probe-report.mjs';
import { analyzeGscExport, parseCount, mapHeaders, main as gscMain } from '../../scripts/gsc-ai-import.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const FIX = resolve(ROOT, 'tests', 'fixtures');
const fixture = (name) => readFileSync(resolve(FIX, name), 'utf8');
const parse = (name, url) => {
  const html = fixture(name);
  const tokens = tokenize(html);
  return { html, tokens, doc: parseDocument(html, url || null, { tokens }) };
};
const tmp = (prefix) => mkdtempSync(join(tmpdir(), 'claude-seo-ai-' + prefix + '-'));

// ---------------------------------------------------------------------------

describe('ai-eligibility (M14)', () => {
  const PAGE = 'https://fixture.example/pricing';
  const restricted = parse('snippet-controls.html', PAGE);
  const ok = parse('snippet-controls-ok.html', PAGE);
  const allowAll = parseRobots('User-agent: *\nDisallow: /admin/\n');
  const blockPricing = parseRobots('User-agent: Googlebot\nDisallow: /pricing\n');

  it('reads every robots meta tag, not only the first', () => {
    const r = analyzeEligibility(restricted.doc, {}, null, PAGE, { tokens: restricted.tokens });
    assert.equal(r.meta_robots_count, 3);
    assert.deepEqual(r.meta_robots.map((m) => m.name), ['robots', 'googlebot', 'bingbot']);
  });

  it('restricted fixture is not eligible and names every blocker', () => {
    const r = analyzeEligibility(restricted.doc, { 'x-robots-tag': 'all' }, allowAll, PAGE, { tokens: restricted.tokens });
    assert.equal(r.eligible_for_ai_features, false);
    assert.deepEqual(r.blockers, ['noindex', 'nosnippet', 'max_snippet_zero']);
    assert.equal(r.directives.noindex, true);
    assert.equal(r.directives.nosnippet, true);
    assert.equal(r.directives.max_snippet, 0);
    assert.equal(r.directives.noimageindex, true);
    assert.equal(r.directives.max_image_preview, 'none');
    assert.ok(r.reasons.length >= 3);
  });

  it('scopes directives per agent: bingbot is not affected by a googlebot-only noindex', () => {
    const r = analyzeEligibility(restricted.doc, {}, null, PAGE, { tokens: restricted.tokens });
    assert.equal(r.by_agent.googlebot.noindex, true);
    assert.equal(r.by_agent.bingbot.noindex, false);
    assert.equal(r.by_agent.all.noindex, false);
    assert.equal(r.by_agent.all.max_snippet, 0, 'the unscoped max-snippet still applies to everyone');
  });

  it('parses the UA-scoped X-Robots-Tag form', () => {
    const r = analyzeEligibility(ok.doc, { 'x-robots-tag': 'googlebot: noindex, nosnippet' }, allowAll, PAGE, { tokens: ok.tokens });
    assert.equal(r.by_agent.googlebot.noindex, true);
    assert.equal(r.by_agent.all.noindex, false);
    assert.equal(r.x_robots_tag.raw, 'googlebot: noindex, nosnippet');
    assert.equal(r.eligible_for_ai_features, false);
  });

  it('clean page with headers and robots is eligible', () => {
    const r = analyzeEligibility(ok.doc, { 'x-robots-tag': 'all' }, allowAll, PAGE, { tokens: ok.tokens });
    assert.equal(r.eligible_for_ai_features, true);
    assert.deepEqual(r.blockers, []);
    assert.deepEqual(r.unknowns, []);
    assert.equal(r.data_nosnippet.elements, 0);
  });

  it('robots.txt disallowing Googlebot is a blocker on its own', () => {
    const r = analyzeEligibility(ok.doc, { 'x-robots-tag': 'all' }, blockPricing, PAGE, { tokens: ok.tokens });
    assert.equal(r.eligible_for_ai_features, false);
    assert.deepEqual(r.blockers, ['robots_disallow']);
    assert.equal(r.robots.googlebot_url_allowed, false);
    assert.equal(r.robots.rule.type, 'disallow');
  });

  it('never reports a silent pass: unknown robots/headers make eligibility null', () => {
    const r = analyzeEligibility(ok.doc, {}, null, PAGE, { tokens: ok.tokens });
    assert.equal(r.eligible_for_ai_features, null);
    assert.deepEqual(r.blockers, []);
    assert.ok(r.unknowns.includes('robots_not_checked'));
    assert.ok(r.unknowns.includes('no_http_headers'));
  });

  it('data-nosnippet: outermost elements only, with H1 and lead coverage', () => {
    const r = dataNosnippet(restricted.tokens);
    assert.equal(r.elements, 2, 'the nested <span data-nosnippet> must not be counted again');
    assert.equal(r.wraps_h1, true);
    assert.equal(r.wraps_lead, true);
    assert.deepEqual(r.by_tag, { div: 1, section: 1 });
    const full = analyzeEligibility(restricted.doc, {}, null, PAGE, { tokens: restricted.tokens });
    assert.ok(full.data_nosnippet.word_share > 0 && full.data_nosnippet.word_share < 1);
    assert.ok(full.warnings.includes('data_nosnippet_primary'));
  });

  it('a low max-snippet is a warning, not a blocker', () => {
    const html = '<html><head><meta name="robots" content="max-snippet:20"></head><body><main><h1>H</h1><p>Words here.</p></main></body></html>';
    const tokens = tokenize(html);
    const r = analyzeEligibility(parseDocument(html, null, { tokens }), { 'x-robots-tag': 'all' }, parseRobots('User-agent: *\nAllow: /\n'), 'https://x.example/', { tokens });
    assert.deepEqual(r.blockers, []);
    assert.ok(r.warnings.includes('max_snippet_low'));
    assert.ok(r.reasons.some((s) => s.includes(String(LOW_MAX_SNIPPET))));
  });

  it('without tokens the data-nosnippet scan is reported as not performed', () => {
    const r = analyzeEligibility(ok.doc, { 'x-robots-tag': 'all' }, allowAll, PAGE);
    assert.equal(r.data_nosnippet.supported, false);
    assert.equal(r.data_nosnippet.elements, null);
    assert.ok(r.unknowns.includes('data_nosnippet_not_scanned'));
    assert.equal(r.eligible_for_ai_features, null);
  });

  it('normalizeRobots accepts robots.json, robotsFromFetch, parseRobots and raw text', () => {
    assert.equal(normalizeRobots(null), null);
    assert.ok(normalizeRobots('User-agent: *\nDisallow:\n').robots.groups);
    assert.ok(normalizeRobots(allowAll).robots.groups);
    assert.ok(normalizeRobots({ mode: 'parsed', parsed: allowAll }).robots.groups);
    assert.equal(normalizeRobots({ mode: 'disallow-all', robots: null }).mode, 'disallow-all');
  });

  it('CLI: --file works and a missing input is a usage error', async () => {
    const good = await eligibilityMain({ file: resolve(FIX, 'snippet-controls.html'), url: PAGE, robots: resolve(FIX, 'robots.txt') });
    assert.equal(good.code, 0);
    assert.equal(good.result.source, 'file');
    assert.equal(good.result.eligible_for_ai_features, false);
    const bad = await eligibilityMain({});
    assert.equal(bad.code, 1);
    assert.match(bad.result.error, /provide --url/);
    const missingRobots = await eligibilityMain({ file: resolve(FIX, 'snippet-controls.html'), robots: resolve(FIX, 'does-not-exist.txt') });
    assert.equal(missingRobots.code, 1);
  });
});

// ---------------------------------------------------------------------------

describe('ua-diff (M14)', () => {
  const page = (title, h1, body, extra = '') =>
    `<!doctype html><html lang="en"><head><title>${title}</title>${extra}</head><body><main><h1>${h1}</h1><p>${body}</p></main></body></html>`;
  const full = page('Merino tee', 'Merino wool tee', 'A long product description that a crawler should be able to read in full, repeated words words words words words words.');
  const thin = page('Merino tee', 'Merino wool tee', 'Short.');

  const reply = (html, { status = 200, headers = {}, url = 'https://shop.example/p' } = {}) => ({
    status, ok: status >= 200 && status < 300, final_url: url, headers, redirects: { hops: 0 },
    body: { text: html, bytes: Buffer.byteLength(html) }, error: null,
  });

  const fakeFetch = (map) => async (url, opts) => {
    const ua = String(opts.uaPreset || opts.ua || 'default');
    return map[ua] || map.default;
  };

  it('summarizes the comparable surface of one response', () => {
    const html = page('T', 'H', 'text', '<link rel="canonical" href="https://shop.example/p"><meta name="robots" content="noindex"><script type="application/ld+json">{"@type":"Product","name":"x"}</script>');
    const v = summarizeVariant('googlebot', reply(html));
    assert.equal(v.status, 200);
    assert.equal(v.title, 'T');
    assert.equal(v.h1, 'H');
    assert.equal(v.canonical, 'https://shop.example/p');
    assert.equal(v.noindex, true);
    assert.deepEqual(v.jsonld_types, ['Product']);
    assert.equal(v.challenge_detected, false);
    assert.equal(v.ua_preset, 'googlebot');
  });

  it('detects a bot challenge from status, header or interstitial body', () => {
    assert.equal(summarizeVariant('gptbot', reply('<html><body>x</body></html>', { status: 403 })).challenge_detected, true);
    assert.deepEqual(summarizeVariant('gptbot', reply('x', { status: 429 })).challenge_signals, ['status_429']);
    const cf = summarizeVariant('gptbot', reply('<html><body>Just a moment...</body></html>', { headers: { 'cf-mitigated': 'challenge' } }));
    assert.deepEqual(cf.challenge_signals.sort(), ['cf-mitigated', 'interstitial_body']);
  });

  it('diffs every variant against the default UA', async () => {
    const variants = await collectVariants('https://shop.example/p', {
      uas: ['default', 'googlebot', 'gptbot'],
      fetchImpl: fakeFetch({
        default: reply(full),
        googlebot: reply(full),
        gptbot: reply('<html><body>Attention Required!</body></html>', { status: 403 }),
      }),
    });
    const d = diffVariants(variants);
    assert.equal(d.baseline, 'default');
    const gb = d.diffs.find((x) => x.ua === 'googlebot');
    assert.equal(gb.differs, false);
    assert.equal(gb.word_ratio, 1);
    const gpt = d.diffs.find((x) => x.ua === 'gptbot');
    assert.equal(gpt.status_differs, true);
    assert.equal(gpt.title_or_h1_differs, true);
    assert.equal(gpt.challenge_detected, true);
    assert.deepEqual(d.divergent_uas, ['gptbot']);
    assert.deepEqual(d.challenged_uas, ['gptbot']);
  });

  it('word_ratio catches a thinner page served to one agent', async () => {
    const variants = await collectVariants('https://shop.example/p', {
      uas: ['default', 'oai-searchbot'],
      fetchImpl: fakeFetch({ default: reply(full), 'oai-searchbot': reply(thin) }),
    });
    const d = diffVariants(variants);
    assert.ok(d.diffs[0].word_ratio < 0.5, 'ratio ' + d.diffs[0].word_ratio);
    assert.equal(d.diffs[0].status_differs, false);
    assert.equal(d.any_divergence, false, 'a word-count drop alone is reported through word_ratio, not as a hard difference');
  });

  it('CLI: injected fetchImpl, saved run artifact and usage errors', async () => {
    const runDir = tmp('uadiff');
    const r = await uaDiffMain({ url: 'https://shop.example/p', ua: 'default,gptbot', 'run-dir': runDir },
      { fetchImpl: fakeFetch({ default: reply(full), gptbot: reply(thin, { status: 503 }) }) });
    assert.equal(r.code, 0);
    assert.equal(r.result.fetched, 2);
    assert.deepEqual(r.result.challenged_uas, ['gptbot']);
    assert.ok(r.result.saved_to.endsWith('.ua-diff.json'));
    assert.equal(JSON.parse(readFileSync(r.result.saved_to, 'utf8')).url, 'https://shop.example/p');

    assert.equal((await uaDiffMain({})).code, 1);
    assert.equal((await uaDiffMain({ url: 'shop.example' })).code, 1);
    assert.deepEqual([...DEFAULT_UAS], ['default', 'googlebot', 'gptbot', 'oai-searchbot', 'claude-searchbot']);
  });

  it('every fetch failing is a runtime error, not a silent pass', async () => {
    const dead = async () => ({ status: 0, ok: false, final_url: null, headers: {}, redirects: { hops: 0 }, body: { text: '', bytes: 0 }, error: 'network' });
    const r = await uaDiffMain({ url: 'https://shop.example/p', ua: 'default,gptbot' }, { fetchImpl: dead });
    assert.equal(r.code, 2);
    assert.match(r.result.error, /every fetch failed/);
  });
});

// ---------------------------------------------------------------------------

describe('ai-discovery (M21)', () => {
  it('llms.txt: a well-formed file parses into title, summary, sections and links', () => {
    const r = validateLlmsTxt(fixture('llms-valid.txt'), { origin: 'https://fixture.example' });
    assert.equal(r.ok, true);
    assert.equal(r.title, 'Fixture Shop');
    assert.ok(r.summary.startsWith('Synthetic llms.txt'));
    assert.equal(r.sections.length, 2);
    assert.equal(r.links_total, 3);
    assert.deepEqual(r.errors, []);
    assert.equal(r.links[1].abs, 'https://fixture.example/shipping');
    assert.equal(r.links[0].note, 'every product with price and availability');
  });

  it('llms.txt: a malformed file reports each defect with its line', () => {
    const r = validateLlmsTxt(fixture('llms-malformed.txt'), { origin: 'https://fixture.example' });
    assert.equal(r.ok, false);
    const reasons = r.errors.map((e) => e.reason).sort();
    assert.deepEqual(reasons, ['malformed_list_item', 'missing_h1_title']);
    assert.equal(r.warnings[0].reason, 'section_without_links');
    assert.equal(r.links_total, 1);
    assert.ok(r.errors.every((e) => Number.isInteger(e.line)));
  });

  it('llms.txt: a prose bullet is legal markdown, not a structural defect', () => {
    // llmstxt.org allows "zero or more markdown sections … of any type except headings", so a file
    // that explains itself in bullets before listing its links is correct.
    const body = [
      '# Vendor', '', '> A frontend cloud.', '',
      '## When to use it', '',
      '- You are deploying a JavaScript app', '- You want a preview per pull request', '',
      '## Docs', '', '- [Getting started](https://vendor.example/docs): the basics', '',
    ].join('\n');
    const r = validateLlmsTxt(body, { origin: 'https://vendor.example' });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.errors, []);
    assert.equal(r.prose_items, 2, 'the prose bullets are counted, not flagged');
    assert.deepEqual(r.warnings, [], 'a section made of prose is not a "section without links"');
    assert.equal(r.links_total, 1);
  });

  it('llms.txt: a prose bullet that quotes a URL in a code span is prose, not a malformed link', () => {
    // The real-world shape this protects: a documentation bullet whose only URL is an example
    // request in backticks. Flagging it produced a line-precise defect claim against a correct file.
    const body = [
      '# Fixture Shop', '', '> A store that documents its agent endpoints.', '',
      '## How agents use this store', '',
      '- **Discovery** — `GET https://fixture.example/.well-known/ucp` returns the merchant profile: versions, endpoints and payment handlers.',
      '- Checkout is described at the endpoint above; see the profile for the supported versions.', '',
      '## Links', '', '- [Catalogue](https://fixture.example/catalog): every product', '',
    ].join('\n');
    const r = validateLlmsTxt(body, { origin: 'https://fixture.example' });
    assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
    assert.equal(r.ok, true);
    assert.equal(r.prose_items, 2, 'both sentences are counted as prose');
    assert.equal(r.links_total, 1);
  });

  it('llms.txt: a bullet that tried to be a link and failed is still an error', () => {
    // A URL in LINK POSITION: bare, or straight after a short label. Both are un-bracketed links.
    const r = validateLlmsTxt('# T\n\n## S\n\n- [Broken](\n- https://bare.example/x\n- **Privacy policy**: https://ok.example/p\n- [Fine](https://ok.example/y)\n');
    assert.deepEqual(r.errors.map((e) => e.reason), ['malformed_list_item', 'malformed_list_item', 'malformed_list_item']);
    assert.equal(r.prose_items, 0);
  });

  it('llms.txt: HTML served instead of markdown is an error, not an empty pass', () => {
    const r = validateLlmsTxt('<!doctype html><html><body>404</body></html>');
    assert.equal(r.looks_like_html, true);
    assert.deepEqual(r.errors.map((e) => e.reason), ['html_instead_of_markdown']);
  });

  it('agents.md: headings and the Shopify default hint', () => {
    const plain = validateAgentsMd('# Agents\n\nContact support@example.com.\n');
    assert.equal(plain.present, true);
    assert.equal(plain.headings.length, 1);
    assert.equal(plain.shopify_default_hint, false);
    const shopify = validateAgentsMd('# Agents\n\nSee https://shop.app/ and the SKILL.md file.\n');
    assert.equal(shopify.mentions_shop_app, true);
    assert.equal(shopify.mentions_skill_md, true);
    assert.equal(shopify.shopify_default_hint, true);
  });

  it('ucp: the valid fixture passes and reports the Shopify catalog key', () => {
    const r = validateUcp(JSON.parse(fixture('ucp-valid.json')), { origin: 'https://shop.fixture.example', status: 200, public_ok: true });
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
    assert.equal(r.version, '2026-02-01');
    assert.equal(r.version_valid, true);
    assert.equal(r.services.count, 2);
    assert.equal(r.capabilities.count, 1);
    assert.equal(r.shopify_catalog_declared, true);
    assert.equal(r.mcp_endpoint_host_differs, false);
    assert.equal(r.payment_handlers_declared, true);
    assert.deepEqual(r.supported_versions, ['2026-02-01', '2025-11-20']);
  });

  it('ucp: the invalid fixture reports one error per defect', () => {
    const r = validateUcp(JSON.parse(fixture('ucp-invalid.json')), { origin: 'https://shop.fixture.example', status: 200, public_ok: true });
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors.map((e) => e.reason).sort(), [
      'endpoint_not_https_url', 'key_not_reverse_dns', 'missing_spec', 'not_an_object', 'transport_not_in_enum', 'version_not_yyyy_mm_dd',
    ]);
    assert.equal(r.version_valid, false);
    assert.equal(r.shopify_catalog_declared, false);
  });

  it('ucp: a non-public document and an MCP endpoint on another host are both reported', () => {
    const priv = validateUcp({ ucp: { version: '2026-02-01' }, services: {} }, { origin: 'https://a.example', status: 401, public_ok: false });
    assert.ok(priv.errors.some((e) => e.reason === 'not_publicly_readable'));
    const off = validateUcp({
      ucp: { version: '2026-02-01' },
      services: { 'com.a.mcp': [{ version: '1', spec: 'https://a.example/s.json', transport: 'mcp', endpoint: 'https://mcp.vendor.example/x' }] },
    }, { origin: 'https://a.example', status: 200, public_ok: true });
    assert.equal(off.mcp_endpoint_host_differs, true);
    assert.equal(off.endpoints[0].host, 'mcp.vendor.example');
  });

  it('ai-catalog is reported by keys only, and the agentic sitemap must be a urlset', () => {
    const cat = validateAiCatalog({ version: '0.9', products: [{ id: 1 }] }, { status: 200 });
    assert.deepEqual(cat.keys, ['version', 'products']);
    const good = validateAgenticSitemap('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://a.example/x?a=1&amp;b=2</loc></url></urlset>');
    assert.equal(good.ok, true);
    assert.equal(good.url_count, 1);
    assert.equal(good.locs[0], 'https://a.example/x?a=1&b=2', 'entities in <loc> are decoded');
    const bad = validateAgenticSitemap('<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://a.example/s.xml</loc></sitemap></sitemapindex>');
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => e.reason === 'sitemapindex_not_urlset'), JSON.stringify(bad.errors));
  });

  it('agentic sitemap: an HTML catch-all page at that path is absent, not published-and-broken', () => {
    const body = '<!doctype html><html><body>This page could not be found.</body></html>';
    for (const probe of [{ looks_like_html: true }, { content_type: 'text/html; charset=utf-8' }, {}]) {
      const r = validateAgenticSitemap(body, probe);
      assert.equal(r.present, false, JSON.stringify(probe));
      assert.equal(r.looks_like_html, true);
      assert.deepEqual(r.errors, [], 'a file that does not exist has no defects to fix');
      assert.deepEqual(r.warnings.map((w) => w.reason), ['html_response_not_xml']);
    }
  });

  it('a soft-404 HTML body at /.well-known/ucp is not reported as an invalid profile', () => {
    const discovery = {
      origin: 'https://a.example',
      probes: { '/.well-known/ucp': { url: 'https://a.example/.well-known/ucp', status: 200, ok: true, json_valid: false, looks_like_html: true, content_type: 'text/html', text: '<!doctype html><html></html>' } },
      summary: { statuses: {}, found: [] },
    };
    const d = analyzeDiscovery(discovery, null);
    assert.equal(d.ucp.present, false);
    assert.deepEqual(d.ucp.errors, []);
  });

  it('an endpoint that answers 200 with the app shell is a soft 404, not a found endpoint', async () => {
    const { fetchSiteArtifacts, isSoftHtml404 } = await import('../../scripts/lib/site.mjs');
    const shell = '<!doctype html><html><head><title>Vercel</title></head><body><div id="__next"></div></body></html>';
    const fetchImpl = async (url) => {
      const path = new URL(url).pathname;
      const html = path === '/llms-full.txt' || path === '/sitemap_agentic_discovery.xml';
      const body = path === '/llms.txt' ? '# Site\n\n> real file\n' : shell;
      const ok = path === '/llms.txt' || html;
      return {
        status: ok ? 200 : 404, ok, final_url: url, redirects: { hops: 0 },
        headers: { 'content-type': ok && !html ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8' },
        body: { text: ok ? body : shell, bytes: Buffer.byteLength(ok ? body : shell), truncated: false, sha256: null },
        error: null,
      };
    };
    const site = await fetchSiteArtifacts('https://a.example', { fetchImpl, artifacts: 'discovery' });
    const d = site.discovery;
    assert.deepEqual(d.summary.found, ['/llms.txt'], 'a text/html body at a machine endpoint is not the endpoint');
    assert.deepEqual(d.summary.soft_404, ['/llms-full.txt', '/sitemap_agentic_discovery.xml']);
    assert.deepEqual([d.summary.statuses['/llms-full.txt'], d.probes['/llms-full.txt'].looks_like_html], [200, true],
      'the 200 is still recorded — the endpoint is dropped, the evidence is not');
    assert.equal(isSoftHtml404(d.probes['/llms.txt']), false);

    // analyzeDiscovery reaches the same conclusion from the same two fields.
    const r = analyzeDiscovery(d, null);
    assert.deepEqual(r.summary.found, ['/llms.txt']);
    assert.deepEqual(r.summary.soft_404, ['/llms-full.txt', '/sitemap_agentic_discovery.xml']);
    assert.ok(r.summary.missing.includes('/sitemap_agentic_discovery.xml'));
    assert.equal(r.agentic_sitemap.present, false);
  });

  it('robots cross-check flags a discovery file blocked for its own audience', () => {
    const robots = parseRobots('User-agent: PerplexityBot\nDisallow: /llms.txt\n\nUser-agent: *\nDisallow:\n');
    const r = discoveryRobotsCheck(['/llms.txt', '/agents.md'], robots, 'https://a.example');
    assert.equal(r.checked, true);
    assert.equal(r.discovery_paths_blocked_for.length, 1);
    assert.equal(r.discovery_paths_blocked_for[0].path, '/llms.txt');
    assert.deepEqual(r.discovery_paths_blocked_for[0].blocked_for, ['PerplexityBot']);
    assert.ok(DISCOVERY_AUDIENCE.includes('Googlebot') && DISCOVERY_AUDIENCE.includes('OAI-SearchBot'));
    assert.ok(!DISCOVERY_AUDIENCE.includes('CCBot'), 'training-only crawlers are not the audience for these files');
    assert.equal(discoveryRobotsCheck(['/llms.txt'], null, 'https://a.example').checked, false);
  });

  it('analyzeDiscovery assembles one report from the probe artifact', () => {
    const probe = (path, body, extra = {}) => [path, {
      url: 'https://a.example' + path, status: 200, ok: true, final_url: 'https://a.example' + path, redirected: false,
      content_type: 'text/plain', bytes: Buffer.byteLength(body), truncated: false, sha256: null,
      text: body, text_head: body.slice(0, 4096), looks_like_html: false, json_valid: null, parsed_keys: null, saved_as: null, error: null, ...extra,
    }];
    const missing = (path) => [path, { url: 'https://a.example' + path, status: 404, ok: false, final_url: 'https://a.example' + path, bytes: 0, text_head: '', looks_like_html: false, error: null }];
    const discovery = {
      origin: 'https://a.example', source: 'http', fetched_at: '2026-09-01T00:00:00Z',
      probes: Object.fromEntries([
        probe('/llms.txt', fixture('llms-valid.txt')),
        missing('/llms-full.txt'),
        probe('/agents.md', '# Agents\n\nShop with https://shop.app/.\n'),
        probe('/.well-known/ucp', fixture('ucp-valid.json'), { content_type: 'application/json', json_valid: true }),
        missing('/.well-known/ai-catalog.json'),
        probe('/sitemap_agentic_discovery.xml', '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://a.example/.well-known/ucp</loc></url></urlset>'),
        missing('/api/ucp/mcp'),
      ]),
      https_enforcement: { applicable: true, redirects_to_https: true },
      summary: { statuses: {}, found: [] },
    };
    const r = analyzeDiscovery(discovery, parseRobots('User-agent: *\nDisallow: /admin/\n'));
    assert.equal(r.origin, 'https://a.example');
    assert.equal(r.llms_txt.ok, true);
    assert.equal(r.llms_txt.links_total, 3);
    assert.equal(r.agents_md.shopify_default_hint, true);
    assert.equal(r.ucp.shopify_catalog_declared, true);
    assert.equal(r.agentic_sitemap.url_count, 1);
    assert.deepEqual(r.summary.found, ['/llms.txt', '/agents.md', '/.well-known/ucp', '/sitemap_agentic_discovery.xml']);
    assert.deepEqual(r.summary.missing, ['/llms-full.txt', '/.well-known/ai-catalog.json', '/api/ucp/mcp']);
    assert.equal(r.summary.errors_total, 0);
    assert.deepEqual(r.summary.blocked_paths, []);
    assert.equal(r.statuses['/llms.txt'], 200);
    assert.ok(r.note.length > 40);
  });

  it('a missing file is reported as absent, never as valid', () => {
    const r = analyzeDiscovery({ origin: 'https://a.example', probes: {} }, null);
    assert.equal(r.llms_txt.present, false);
    assert.equal(r.ucp.present, false);
    assert.equal(r.agentic_sitemap.present, false);
    assert.deepEqual(r.summary.found, []);
    assert.equal(r.robots_cross_check.checked, false);
  });

  it('CLI: --ucp-file and --llms-file override the probes; no input is a usage error', async () => {
    const runDir = tmp('discovery');
    const bad = await discoveryMain({});
    assert.equal(bad.code, 1);
    assert.match(bad.result.error, /provide --url/);
    assert.equal((await discoveryMain({ 'run-dir': runDir })).code, 1);
    assert.equal((await discoveryMain({ url: 'a.example' })).code, 1);
  });
});

// ---------------------------------------------------------------------------

describe('acp-feed-lint (M18)', () => {
  const JSONL = resolve(FIX, 'acp-feed.jsonl');
  const CSV = resolve(FIX, 'acp-feed.csv');

  it('finds exactly the three seeded defects in the JSONL feed', async () => {
    const r = await feedMain({ feed: JSONL });
    assert.equal(r.code, 0);
    assert.equal(r.result.format, 'jsonl');
    assert.equal(r.result.rows, 4);
    assert.equal(r.result.errors.length, 3);
    assert.deepEqual(r.result.errors.map((e) => [e.row, e.field, e.reason]), [
      [2, 'price', 'price_format'],
      [3, 'brand', 'missing_required_field'],
      [4, 'item_id', 'duplicate_item_id'],
    ]);
    assert.deepEqual(r.result.error_counts_by_field, { price: 1, brand: 1, item_id: 1 });
    assert.deepEqual(r.result.duplicates, [{ item_id: 'SKU-1001', rows: [1, 4] }]);
    assert.equal(r.result.valid_rows, 1);
    assert.equal(r.result.ok, false);
  });

  it('the CSV feed produces identical findings (parser parity)', async () => {
    const a = await feedMain({ feed: JSONL });
    const b = await feedMain({ feed: CSV });
    assert.equal(b.result.format, 'csv');
    assert.deepEqual(b.result.errors, a.result.errors);
    assert.deepEqual(b.result.duplicates, a.result.duplicates);
    assert.equal(b.result.rows, a.result.rows);
  });

  it('--strict turns errors into the threshold exit code', async () => {
    assert.equal((await feedMain({ feed: JSONL, strict: true })).code, 3);
    assert.equal((await feedMain({ feed: JSONL })).code, 0);
    assert.equal((await feedMain({})).code, 1);
    assert.equal((await feedMain({ feed: JSONL, format: 'xml' })).code, 1);
  });

  it('quoted CSV fields keep their commas and newlines', () => {
    const { header, rows } = parseDelimited('a,b\r\n"x, y","line1\nline2"\r\n"he said ""hi""",z\r\n');
    assert.deepEqual(header, ['a', 'b']);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].a, 'x, y');
    assert.equal(rows[0].b, 'line1\nline2');
    assert.equal(rows[1].a, 'he said "hi"');
    assert.equal(detectFormat('a\tb\n1\t2\n'), 'tsv');
    assert.equal(detectFormat('{"a":1}\n'), 'jsonl');
    assert.equal(parseFeed('a,b\n1,2\n', 'csv').rows.length, 1);
    assert.equal(parseJsonl('{"a":1}\nnot json\n').errors[0].reason, 'invalid_json_line');
  });

  it('GTIN check digits are verified, not just the length', () => {
    assert.equal(gtinValid('4006381333931').ok, true);
    assert.equal(gtinValid('9780306406157').ok, true);
    assert.equal(gtinValid('12345670').ok, true);
    assert.equal(gtinValid('4006381333930').reason, 'gtin_check_digit');
    assert.equal(gtinValid('400638133393').reason, 'gtin_check_digit');
    assert.equal(gtinValid('40063813339311').reason, 'gtin_check_digit');
    assert.equal(gtinValid('abcdefgh').reason, 'gtin_length_or_digits');
    assert.equal(gtinValid('123456789').reason, 'gtin_length_or_digits');
  });

  it('prices must be "<decimal> <ISO4217>" and a sale price must be below it', () => {
    assert.deepEqual(parsePrice('79.99 USD'), { amount: 79.99, currency: 'USD', raw: '79.99 USD' });
    assert.equal(parsePrice('79,99 EUR'), null);
    assert.equal(parsePrice('$79.99'), null);
    assert.equal(parsePrice('79.99USD'), null);
    const base = { item_id: 'a', title: 't', description: 'd', url: 'https://a.example/p', brand: 'b', seller_name: 's', image_url: 'https://a.example/i.jpg', availability: 'in_stock', price: '10.00 USD' };
    assert.deepEqual(lintFeed([{ ...base, sale_price: '12.00 USD' }]).errors.map((e) => e.reason), ['sale_price_not_below_price']);
    assert.deepEqual(lintFeed([{ ...base, sale_price: '8.00 EUR' }]).errors.map((e) => e.reason), ['sale_price_currency_mismatch']);
    assert.deepEqual(lintFeed([{ ...base, sale_price: '8.00 USD' }]).errors, []);
  });

  it('Google field and availability spellings are accepted as warnings, never errors', () => {
    const r = lintFeed([{
      id: 'SKU-9', title: 't', description: 'd', link: 'https://a.example/p', brand: 'b', seller_name: 's',
      image_link: 'https://a.example/i.jpg', availability: 'preorder', price: '10.00 USD',
    }]);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings.map((w) => w.reason).sort(), ['google_availability_alias', 'google_field_alias', 'google_field_alias', 'google_field_alias']);
    assert.deepEqual(lintFeed([{ ...r, availability: 'sold_out' }]).errors.filter((e) => e.field === 'availability').map((e) => e.reason), ['availability_not_in_enum']);
  });

  it('length caps, relative URLs and non-boolean eligibility flags are errors', () => {
    const row = {
      item_id: 'a', title: 'x'.repeat(151), description: 'd', url: '/relative', brand: 'b', seller_name: 's',
      image_url: 'https://a.example/i.jpg', availability: 'in_stock', price: '10.00 USD', is_eligible_checkout: 'yes',
    };
    const reasons = lintFeed([row]).errors.map((e) => e.reason).sort();
    assert.deepEqual(reasons, ['not_a_boolean', 'title_too_long', 'url_not_absolute_http']);
    assert.deepEqual(lintFeed([{ ...row, title: 't', url: 'https://a.example/p', is_eligible_checkout: 'TRUE' }]).errors, []);
  });

  it('--sample limits how many rows are linted', async () => {
    const r = await feedMain({ feed: JSONL, sample: 2 });
    assert.equal(r.result.rows, 2);
    assert.equal(r.result.rows_total, 4);
    assert.equal(r.result.sampled, true);
    assert.equal(r.result.errors.length, 1);
  });
});

// ---------------------------------------------------------------------------

describe('agent-readiness (M22)', () => {
  const { html, tokens, doc } = parse('agent-readiness.html', 'https://shop.fixture.example/products/merino-tee');
  const r = analyzeAgentReadiness(doc, html, { tokens });

  it('counts semantic vs faked controls', () => {
    assert.equal(r.interactive.semantic, 2);
    assert.equal(r.interactive.fake, 3);
    assert.deepEqual(r.interactive.fake_examples.map((f) => f.tag), ['div', 'span', 'div']);
    assert.equal(r.interactive.fake_examples[0].onclick, true);
    assert.equal(r.interactive.fake_examples[1].role, 'button');
  });

  it('counts anchors without href and javascript: hrefs separately from links', () => {
    assert.equal(r.interactive.anchor_no_href, 1);
    assert.equal(r.interactive.anchor_javascript_href, 1);
    assert.equal(r.links.total, 6);
    assert.equal(r.links.with_href, 5);
  });

  it('a button whose only content is aria-hidden has no accessible name', () => {
    assert.equal(r.buttons.total, 2);
    assert.equal(r.buttons.without_name, 1);
    assert.equal(r.buttons.without_name_examples[0].class, 'icon-only');
  });

  it('form controls: 1 of 3 is labeled, hidden and submit inputs excluded', () => {
    assert.equal(r.forms.controls_total, 3);
    assert.equal(r.forms.labeled, 1);
    assert.equal(r.forms.unlabeled, 2);
    assert.deepEqual(r.forms.label_sources, { 'label[for]': 1 });
    assert.deepEqual(r.forms.unlabeled_examples.map((e) => e.tag), ['input', 'select']);
  });

  it('links: empty accessible name is an error, generic anchor text is reference-only', () => {
    assert.equal(r.links.empty_name, 1);
    assert.equal(r.links.empty_name_examples[0].href, '/collections/deals');
    assert.equal(r.links.generic, 1);
    assert.equal(r.links.generic_examples[0].anchor, 'read more');
    assert.match(r.links.generic_note, /M10/);
  });

  it('images are reported for context and handed to M9', () => {
    assert.equal(r.images.total, 3);
    assert.equal(r.images.missing_alt, 1);
    assert.equal(r.images.see_m9, true);
  });

  it('lists exactly the four things static HTML cannot decide', () => {
    assert.equal(r.not_checkable_static.length, 4);
    assert.deepEqual(NOT_CHECKABLE_STATIC.map((x) => x.id), ['cursor_affordance', 'target_size', 'overlays_and_interstitials', 'focus_order_and_traps']);
    assert.ok(r.not_checkable_static.every((x) => x.reason && x.tier1));
  });

  it('server_rendered comes from the M4 artifact when one is given', () => {
    assert.equal(serverRenderedFrom(doc, { render: { needed: false, used: 'none' } }).value, true);
    const suspected = serverRenderedFrom(doc, { render: { needed: true, signals: ['low_word_count'] } });
    assert.equal(suspected.value, null, 'a suspected render that never ran is unknown, not a verdict');
    assert.ok(suspected.signals.includes('render_suspected_but_not_performed'));
    assert.equal(serverRenderedFrom(doc, { render: { needed: true, used: 'chrome', delta: { meaningful: false } } }).value, true);
    assert.equal(serverRenderedFrom(doc, { render: { needed: false, delta: { meaningful: true } } }).value, false);
    assert.equal(serverRenderedFrom(doc, { server_rendered: true }).source, 'm4');
    const shell = parseDocument('<html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">{}</script></body></html>');
    assert.equal(serverRenderedFrom(shell, null).value, false);
    assert.equal(r.content.server_rendered_source, 'heuristic');
  });

  it('a page whose content lives in an iframe is flagged', () => {
    const framed = '<html lang="en"><body><main><h1>Booking</h1><iframe src="https://widget.example/book" title="Booking"></iframe></main></body></html>';
    const f = analyzeAgentReadiness(parseDocument(framed), framed);
    assert.equal(f.content.iframes.in_content, 1);
    assert.equal(f.content.iframe_primary, true);
    assert.equal(r.content.iframe_primary, false, 'a footer widget on a text page is not the primary content');
  });

  it('WebMCP and dialogs are detected, report-only', () => {
    assert.equal(r.webmcp_detected, false);
    const mcp = '<html lang="en"><body><dialog aria-modal="true" role="dialog"><p>Hi</p></dialog><script>navigator.modelContext.registerTool({});</script></body></html>';
    const m = analyzeAgentReadiness(parseDocument(mcp), mcp);
    assert.equal(m.webmcp_detected, true);
    assert.equal(m.dialogs.dialog_elements, 1);
    assert.equal(m.dialogs.role_dialog, 1);
    assert.equal(m.dialogs.aria_modal, 1);
  });

  it('accessible names resolve aria-label, aria-labelledby and image alt in order', () => {
    const t = tokenize('<span id="lbl">From the label</span><button aria-labelledby="lbl"></button><button aria-label="Direct">x</button><button><img src="i.png" alt="Cart"></button><button><span aria-hidden="true">x</span></button>');
    const idx = t.map((tok, i) => (tok.name === 'button' && tok.kind === 'open' ? i : -1)).filter((i) => i >= 0);
    const idText = new Map([['lbl', 'From the label']]);
    assert.deepEqual(accessibleName(t, idx[0], idText), { name: 'From the label', source: 'aria-labelledby' });
    assert.equal(accessibleName(t, idx[1], idText).source, 'aria-label');
    assert.deepEqual(accessibleName(t, idx[2], idText), { name: 'Cart', source: 'image-alt' });
    assert.equal(accessibleName(t, idx[3], idText).name, '');
    assert.equal(nameText(t, idx[3]), '');
  });

  it('CLI: --file works and a missing input is a usage error', async () => {
    const good = await agentMain({ file: resolve(FIX, 'agent-readiness.html') });
    assert.equal(good.code, 0);
    assert.equal(good.result.interactive.fake, 3);
    assert.equal(good.result.lang.detected, 'en');
    assert.equal((await agentMain({})).code, 1);
    assert.equal((await agentMain({ file: resolve(FIX, 'agent-readiness.html'), m4: resolve(FIX, 'nope.json') })).code, 1);
  });

  it('an unsupported page language leaves the generic-anchor count null instead of 0', () => {
    const fr = '<html lang="fr"><body><main><h1>Titre</h1><p>Un paragraphe.</p><a href="/a">cliquez ici</a></main></body></html>';
    const out = analyzeAgentReadiness(parseDocument(fr), fr);
    assert.equal(out.lang.supported, false);
    assert.equal(out.links.generic, null);
    assert.equal(out.links.total, 1);
  });
});

// ---------------------------------------------------------------------------

describe('probe-report (never scored)', () => {
  const input = JSON.parse(fixture('probe-results.json'));

  it('presence is counted per query, top 10 only', () => {
    const r = analyzeProbes(input, { host: 'shop.fixture.example' });
    assert.equal(r.kind, PROBE_KIND);
    assert.equal(r.queries_total, 3);
    assert.equal(r.queries_with_presence, 1);
    assert.equal(r.presence_rate, 0.3333);
    assert.equal(r.best_rank_overall, 3);
    assert.equal(r.queries[0].host_present_top10, true);
    assert.equal(r.queries[1].host_present_top10, false);
    assert.equal(r.queries[2].host_present_top10, false, 'rank 14 is not presence in the top 10');
    assert.equal(r.queries[2].best_rank, 14, 'but the rank is still reported');
  });

  it('competitor hosts are tallied without the subject', () => {
    const r = analyzeProbes(input, { host: 'shop.fixture.example' });
    assert.ok(!r.competitor_hosts.some((c) => c.host === 'shop.fixture.example'));
    const reviews = r.competitor_hosts.find((c) => c.host === 'reviews.fixture.example');
    assert.equal(reviews.queries, 3);
    assert.equal(reviews.best_rank, 1);
  });

  it('the disclaimer is fixed text and says what this is not', () => {
    const r = analyzeProbes(input, { host: 'shop.fixture.example' });
    assert.equal(r.disclaimer, DISCLAIMER);
    assert.match(r.disclaimer, /NOT AI Overview, AI Mode, ChatGPT, or Perplexity citation data/);
    assert.match(r.disclaimer, /necessary, not sufficient/);
  });

  it('the geo skill quotes the same disclaimer the script emits', () => {
    // One source of truth: a model following skills/geo/SKILL.md must not print a sentence that
    // contradicts the machine-generated line next to it in report.md.
    const skill = readFileSync(resolve(ROOT, 'skills', 'geo', 'SKILL.md'), 'utf8');
    assert.ok(skill.includes(DISCLAIMER), 'skills/geo/SKILL.md must quote scripts/probe-report.mjs DISCLAIMER verbatim');
  });

  it('www and host case do not change the match', () => {
    const r = analyzeProbes({ queries: [{ query: 'q', results: [{ rank: 1, url: 'https://WWW.Shop.Fixture.example/x' }] }] }, { host: 'shop.fixture.example' });
    assert.equal(r.queries[0].host_present_top10, true);
  });

  it('trend compares against the newest prior report in the history dir', async () => {
    const dir = tmp('probes');
    writeFileSync(join(dir, '2026-08-01.json'), JSON.stringify({ kind: PROBE_KIND, queries_total: 3, presence_rate: 0.6667, best_rank_overall: 2 }));
    const r = await probeMain({ host: 'shop.fixture.example', results: resolve(FIX, 'probe-results.json'), history: dir, out: join(dir, '2026-09-01.json') });
    assert.equal(r.code, 0);
    assert.equal(r.result.trend.previous_presence_rate, 0.6667);
    assert.equal(r.result.trend.presence_rate_delta, -0.3334);
    assert.equal(r.result.trend.direction, 'down');
    assert.equal(r.result.trend.comparable, true);
    assert.ok(r.result.saved_to);
    assert.equal(JSON.parse(readFileSync(r.result.saved_to, 'utf8')).kind, PROBE_KIND);
    assert.equal(trendAgainst(r.result, null), null);
    assert.equal(previousReport(join(dir, 'nope')), null);
  });

  it('a run with a different number of questions is marked not comparable', () => {
    const t = trendAgainst({ presence_rate: 0.5, best_rank_overall: 4, queries_total: 2 }, { file: 'x', report: { kind: PROBE_KIND, queries_total: 3, presence_rate: 0.5, best_rank_overall: 4 } });
    assert.equal(t.comparable, false);
    assert.match(t.note, /not directly comparable/);
  });

  it('CLI: usage errors when the host or the input is missing', async () => {
    assert.equal((await probeMain({ host: 'a.example', results: resolve(FIX, 'nope.json') })).code, 1);
    const noHost = await probeMain({ results: resolve(FIX, 'probe-results.json'), host: '' });
    assert.equal(noHost.code, 0, 'the input file carries its own host');
    assert.equal(noHost.result.host, 'shop.fixture.example');
  });
});

// ---------------------------------------------------------------------------

describe('gsc-ai-import (never scored)', () => {
  it('English and Spanish exports produce identical totals', async () => {
    const en = await gscMain({ csv: resolve(FIX, 'gsc-ai-export.csv') });
    const es = await gscMain({ csv: resolve(FIX, 'gsc-ai-export-es.csv') });
    assert.equal(en.code, 0);
    assert.equal(es.code, 0);
    assert.equal(en.result.total_impressions, 4470);
    assert.equal(es.result.total_impressions, en.result.total_impressions);
    assert.equal(es.result.pages_with_impressions, en.result.pages_with_impressions);
    assert.deepEqual(es.result.top_pages, en.result.top_pages);
    assert.deepEqual(es.result.date_series.map((d) => [d.date, d.impressions]), en.result.date_series.map((d) => [d.date, d.impressions]));
    assert.equal(en.result.delimiter, ',');
    assert.equal(es.result.delimiter, ';');
    assert.equal(es.result.columns.page, 'Página');
  });

  it('is labelled a manual import at tier 2 and says what Search Console does not expose', async () => {
    const en = await gscMain({ csv: resolve(FIX, 'gsc-ai-export.csv') });
    assert.equal(en.result.source, 'manual_import');
    assert.equal(en.result.tier, 2);
    assert.match(en.result.note, /Search Analytics API has no generative-AI search type/);
    assert.match(en.result.note, /clicks or position/);
    assert.ok(en.result.warnings.some((w) => /clicks/.test(w)));
  });

  it('summarizes pages, dates and the within-series trend', async () => {
    const en = await gscMain({ csv: resolve(FIX, 'gsc-ai-export.csv') });
    assert.equal(en.result.pages_with_impressions, 3);
    assert.equal(en.result.top_pages[0].impressions, 3730);
    assert.equal(en.result.date_series.length, 3);
    assert.equal(en.result.trend.series.direction, 'up');
    assert.equal(en.result.trend.series.delta, 225);
    assert.equal(en.result.trend.vs_previous_import, null);
    assert.equal(en.result.queries_distinct, 6);
  });

  it('--history adds an absolute delta against the previous import', async () => {
    const dir = tmp('gsc');
    writeFileSync(join(dir, '2026-07.json'), JSON.stringify({ source: 'manual_import', total_impressions: 5000 }));
    const r = await gscMain({ csv: resolve(FIX, 'gsc-ai-export.csv'), history: dir });
    assert.equal(r.result.trend.vs_previous_import.previous_total_impressions, 5000);
    assert.equal(r.result.trend.vs_previous_import.delta, -530);
    assert.equal(r.result.trend.vs_previous_import.direction, 'down');
  });

  it('--host keeps only the rows of that host', async () => {
    const r = await gscMain({ csv: resolve(FIX, 'gsc-ai-export.csv'), host: 'other.example' });
    assert.equal(r.result.rows_counted, 0);
    assert.equal(r.result.rows_skipped_other_host, 6);
    assert.equal(r.result.total_impressions, 0);
  });

  it('both thousands conventions parse to the same number', () => {
    assert.equal(parseCount('1,240'), 1240);
    assert.equal(parseCount('1.240'), 1240);
    assert.equal(parseCount('1 240'), 1240);
    assert.equal(parseCount('320'), 320);
    assert.equal(parseCount('12.5'), 12.5);
    assert.equal(parseCount('12,5'), 12.5);
    assert.equal(parseCount(''), null);
    assert.equal(parseCount('n/a'), null);
  });

  it('headers are matched accent- and case-insensitively, unknown ones are listed', () => {
    const m = mapHeaders(['FECHA', 'Página', 'Impresiones', 'Something else']);
    assert.equal(m.columns.date, 'FECHA');
    assert.equal(m.columns.page, 'Página');
    assert.equal(m.columns.impressions, 'Impresiones');
    assert.deepEqual(m.unmapped, ['Something else']);
    const empty = analyzeGscExport([], [], {});
    assert.ok(empty.warnings.some((w) => /no impressions column/.test(w)));
    assert.equal(empty.total_impressions, 0);
  });

  it('CLI: missing or unusable files are usage errors', async () => {
    assert.equal((await gscMain({})).code, 1);
    assert.equal((await gscMain({ csv: resolve(FIX, 'nope.csv') })).code, 1);
    const dir = tmp('gsc-bad');
    const bad = join(dir, 'bad.csv');
    writeFileSync(bad, 'alpha,beta\n1,2\n');
    const r = await gscMain({ csv: bad });
    assert.equal(r.code, 1);
    assert.match(r.result.error, /no recognizable Search Console columns/);
  });
});

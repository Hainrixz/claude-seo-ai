// Unit tests for the page-api adapter and its five providers.
//
// Offline throughout: every provider gets an injected `fetchImpl`, so the assertions are about the
// exact request each platform would receive — the payload, whether it is staged or live, whether a
// full-set write kept the tags nobody asked us to touch, whether Ghost carried the `updated_at` that
// stops us overwriting someone else's edit, and whether a truncated value says it was truncated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const PAGEAPI = await load('scripts/adapters/page-api.mjs');
const WEBFLOW = await load('scripts/adapters/providers/webflow.mjs');
const WIX = await load('scripts/adapters/providers/wix.mjs');
const GHOST = await load('scripts/adapters/providers/ghost.mjs');
const HUBSPOT = await load('scripts/adapters/providers/hubspot.mjs');
const BIGCOMMERCE = await load('scripts/adapters/providers/bigcommerce.mjs');
const A = await load('scripts/lib/adapter.mjs');
const SNAPSHOTS = join(ROOT, 'tests', 'snapshots', 'page-api');

const PAGE = 'https://shop.example.test/rain-shadow/';

// ---------------------------------------------------------------------------
// Helpers

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'cseo-papi-'));
  return { dataDir: join(base, 'data'), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function mockFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const method = String(opts.method || 'GET').toUpperCase();
    let body = null;
    if (typeof opts.body === 'string') { try { body = JSON.parse(opts.body); } catch { body = opts.body; } }
    calls.push({ url, method, headers: opts.headers || {}, body });
    for (const route of routes) {
      if (route.method && route.method !== method) continue;
      const hit = typeof route.match === 'function' ? route.match(url) : url.includes(route.match);
      if (!hit) continue;
      const payload = typeof route.body === 'function' ? route.body({ url, method, body }) : route.body;
      return {
        status: route.status || 200,
        headers: new Map([['content-type', route.contentType || 'application/json']]),
        text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload === undefined ? {} : payload)),
      };
    }
    return { status: 404, headers: new Map([['content-type', 'application/json']]), text: async () => '{"error":"no route"}' };
  };
  return { impl, calls };
}

function snapshot(name, value) {
  const file = join(SNAPSHOTS, name + '.json');
  const actual = JSON.parse(JSON.stringify(value));
  if (process.env.UPDATE_SNAPSHOTS) {
    mkdirSync(SNAPSHOTS, { recursive: true });
    writeFileSync(file, JSON.stringify(actual, null, 2) + '\n');
  }
  assert.ok(existsSync(file), 'missing snapshot ' + file + ' (regenerate with UPDATE_SNAPSHOTS=1)');
  assert.deepEqual(actual, JSON.parse(readFileSync(file, 'utf8')));
}

const finding = (over = {}) => ({
  id: 'M7.meta.description_missing',
  module: 'M7',
  title: 'Meta description missing',
  status: 'fail',
  severity: 3,
  scope: 'page',
  location: { url: PAGE },
  evidence: { observed: 'no <meta name="description"> in the head' },
  expected: 'a unique meta description under 160 characters',
  recommendation: 'add a meta description that matches the page',
  fixable: 'proposed',
  fix_preview: '<meta name="description" content="Why the east side of the range stays dry.">',
  verification: { method: 'dom_assert', assertion: 'head has a description', reproduce: 'node scripts/parse-html.mjs --url ' + PAGE },
  expected_impact: { axis: 'search', confidence: 'established', magnitude: 'medium', rationale: 'Google shows it in the snippet' },
  ...over,
});

const DESCRIPTION = 'Why the east side of the range stays dry.';
const report = (findings) => ({ target: { kind: 'url', value: PAGE }, findings });

// ---------------------------------------------------------------------------
// Dispatcher

test('page-api knows its providers and which of them publish', () => {
  assert.deepEqual([...PAGEAPI.PROVIDER_IDS], ['webflow', 'wix', 'ghost', 'hubspot', 'bigcommerce']);
  assert.deepEqual([...PAGEAPI.PUBLISHERS], ['webflow', 'hubspot']);
  assert.equal(PAGEAPI.providerFor('WEBFLOW').PROVIDER, 'webflow');
  assert.equal(PAGEAPI.providerFor('squarespace'), null);
  assert.deepEqual(PAGEAPI.keysFor('ghost'), ['GHOST_URL', 'GHOST_ADMIN_KEY']);
});

test('every provider exports the adapter contract', async () => {
  for (const id of PAGEAPI.PROVIDER_IDS) {
    const mod = PAGEAPI.PROVIDERS[id];
    for (const op of ['capabilities', 'plan', 'preview', 'apply', 'verify', 'rollback']) {
      assert.equal(typeof mod[op], 'function', id + ' must export ' + op);
    }
    assert.ok(Array.isArray(mod.KEYS) && mod.KEYS.length, id + ' must declare its credential keys');
  }
  for (const op of ['capabilities', 'plan', 'preview', 'apply', 'verify', 'rollback', 'publish']) {
    assert.equal(typeof PAGEAPI[op], 'function', 'page-api must export ' + op);
  }
});

test('CLI: an unknown provider is a usage error, and ops need one', async () => {
  const unknown = await PAGEAPI.main({ _: ['plan'], provider: 'squarespace' });
  assert.equal(unknown.code, 1);
  assert.match(unknown.result.error, /unknown provider/);
  const missing = await PAGEAPI.main({ _: ['preview'] });
  assert.equal(missing.code, 1);
  assert.match(missing.result.error, /needs --provider/);
});

test('capabilities without --provider reports every provider by credential name only', async () => {
  const caps = await PAGEAPI.capabilities({ env: {} }, {});
  assert.equal(caps.ready, false);
  assert.deepEqual(Object.keys(caps.providers), [...PAGEAPI.PROVIDER_IDS]);
  assert.deepEqual(caps.providers.wix.needs, ['WIX_API_KEY', 'WIX_SITE_ID']);
  assert.ok(!JSON.stringify(caps).includes('undefined-secret'));
});

// ---------------------------------------------------------------------------
// Webflow

const WEBFLOW_ENV = { WEBFLOW_TOKEN: 'wf_live_token_value', WEBFLOW_SITE_ID: 'site-1' };
const WEBFLOW_PAGE = {
  id: 'page-9', siteId: 'site-1', title: 'Rain shadow', slug: 'rain-shadow', publishedPath: '/rain-shadow',
  seo: { title: 'Old SEO title', description: 'Old SEO description' },
  openGraph: { title: 'Old OG title', titleCopied: false },
};

function webflowRoutes(extra = []) {
  return [
    ...extra,
    { match: '/v2/sites/site-1/pages', method: 'GET', body: { pages: [WEBFLOW_PAGE], pagination: { limit: 100, offset: 0, total: 1 } } },
    { match: '/v2/pages/page-9', method: 'GET', body: { ...WEBFLOW_PAGE, seo: { title: 'Old SEO title', description: DESCRIPTION } } },
  ];
}

test('webflow: the page metadata object is sent whole, staged, and rolls back to what was there', async () => {
  const { impl, calls } = mockFetch(webflowRoutes());
  const out = await WEBFLOW.plan({ report: report([finding()]) }, { env: { ...WEBFLOW_ENV }, fetchImpl: impl });
  assert.equal(out.ready, true);
  assert.equal(out.changes.length, 1);
  const change = out.changes[0];
  assert.equal(change.adapter, 'page-api');
  assert.equal(change.payload.provider, 'webflow');
  assert.equal(change.live_impact, 'staged');
  assert.equal(change.payload.method, 'PUT');
  assert.equal(change.payload.body.title, 'Rain shadow', 'title and slug travel back unchanged');
  assert.equal(change.payload.body.seo.title, 'Old SEO title', 'the untouched half of seo is preserved');
  assert.equal(change.payload.body.seo.description, DESCRIPTION);
  assert.deepEqual(change.rollback.data.body.seo, WEBFLOW_PAGE.seo);
  assert.ok(calls.every((c) => c.method === 'GET'), 'plan only reads');
  snapshot('webflow-page', {
    method: change.payload.method, url: change.payload.url, body: change.payload.body,
    live_impact: change.live_impact, rollback: change.rollback,
  });
});

test('webflow: verify on a staged change says "saved, not published" instead of passing', async () => {
  const { impl } = mockFetch(webflowRoutes());
  const ctx = { env: { ...WEBFLOW_ENV }, fetchImpl: impl };
  const out = await WEBFLOW.plan({ report: report([finding()]) }, ctx);
  const applied = A.transition(A.transition(out.changes[0], 'confirmed'), 'applied');
  const verified = await WEBFLOW.verify(applied, ctx);
  assert.equal(verified.ok, null);
  assert.equal(verified.change.status, 'applied', 'a staged change is not "verified"');
  assert.match(verified.note, /until you publish/);
  assert.equal(verified.checks.find((c) => c.name === 'api').ok, true);
});

test('webflow: a Designer-only fix is handed to the instructions adapter, not written blind', async () => {
  const { impl } = mockFetch(webflowRoutes());
  const jsonld = finding({ id: 'M5.schema.article_missing', module: 'M5', title: 'Article JSON-LD missing', fix_preview: '<script type="application/ld+json">{"@type":"Article"}</script>' });
  const out = await WEBFLOW.plan({ report: report([jsonld]) }, { env: { ...WEBFLOW_ENV }, fetchImpl: impl });
  assert.deepEqual(out.changes, []);
  assert.match(out.skipped[0].reason, /Custom code/);
});

test('webflow: publish posts to the site publish endpoint and says what it did', async () => {
  const { impl, calls } = mockFetch([{ match: '/v2/sites/site-1/publish', method: 'POST', body: { customDomains: [] } }]);
  const out = await WEBFLOW.publish(null, { env: { ...WEBFLOW_ENV }, fetchImpl: impl }, {});
  assert.equal(out.ok, true);
  assert.match(out.note, /every staged change/);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { publishToWebflowSubdomain: false });
});

test('webflow: CLI publish refuses without its own ticket', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const run = A.openFixRun(dataDir, {});
    const out = await PAGEAPI.main({ _: ['publish'], provider: 'webflow', data: dataDir, run: run.dir });
    assert.equal(out.code, 1);
    assert.match(out.result.error, /own confirmation ticket \(no-ticket\)/);
  } finally { cleanup(); }
});

test('webflow: a ticket issued for one change does not unlock a site-wide publish', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const { impl } = mockFetch(webflowRoutes());
    const run = A.openFixRun(dataDir, {});
    const planned = await WEBFLOW.plan({ report: report([finding()]) }, { env: { ...WEBFLOW_ENV }, fetchImpl: impl, run });
    const first = planned.changes[0];
    run.setChanges([first, { ...first, id: 'chg_0000000000aa' }]);
    const { id } = A.issueTicket(dataDir, { command: 'page-api publish webflow', run: run.id, change: first.id });
    const out = await PAGEAPI.main({ _: ['publish'], provider: 'webflow', data: dataDir, run: run.dir, ticket: id });
    assert.equal(out.code, 1);
    assert.match(out.result.error, /issued for change chg_/);
  } finally { cleanup(); }
});

test('page-api: a provider without a publish step says so instead of pretending', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const run = A.openFixRun(dataDir, {});
    const out = await PAGEAPI.main({ _: ['publish'], provider: 'ghost', data: dataDir, run: run.dir });
    assert.equal(out.code, 1);
    assert.match(out.result.error, /no publish step/);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Wix

const WIX_ENV = { WIX_API_KEY: 'wix-secret-key-value', WIX_SITE_ID: 'site-abc' };
const EXISTING_TAGS = [
  { type: 'title', children: 'Old title' },
  { type: 'meta', props: { name: 'google-site-verification', content: 'keep-me' } },
  { type: 'meta', props: { property: 'og:image', content: 'https://static.wixstatic.com/hero.jpg' } },
];

function wixRoutes({ probeStatus = 400, tags = EXISTING_TAGS } = {}) {
  return [
    { match: 'item-tags?', method: 'GET', body: { tags } },
    { match: 'item-tags', method: 'GET', status: probeStatus, body: { message: 'itemType is required' } },
    { match: 'item-tags', method: 'PUT', body: { tags } },
  ];
}

const wixAnswers = { resources: { [PAGE]: { itemType: 'STATIC_PAGE', itemId: 'item-7' } } };

test('wix: mergeTags replaces the slot it owns and keeps every other tag', () => {
  const merged = WIX.mergeTags(EXISTING_TAGS, [
    { type: 'title', children: 'New title' },
    { type: 'meta', props: { name: 'description', content: DESCRIPTION } },
  ]);
  assert.equal(merged.tags.length, 4);
  assert.equal(merged.tags[0].children, 'New title');
  assert.deepEqual(merged.tags[1], EXISTING_TAGS[1], 'the verification meta is untouched');
  assert.deepEqual(merged.tags[2], EXISTING_TAGS[2], 'the og:image is untouched');
  assert.equal(merged.tags[3].props.content, DESCRIPTION);
  assert.deepEqual(merged.replaced, ['title|']);
  assert.deepEqual(merged.added, ['meta|description']);
});

test('wix: a write sends the whole merged set, marks it live, and rolls back to the captured set', async () => {
  const { impl } = mockFetch(wixRoutes());
  const out = await WIX.plan({ report: report([finding()]), answers: wixAnswers }, { env: { ...WIX_ENV }, fetchImpl: impl });
  assert.equal(out.ready, true);
  assert.equal(out.changes.length, 1);
  const change = out.changes[0];
  assert.equal(change.status, 'planned');
  assert.equal(change.live_impact, 'live');
  assert.equal(change.payload.publish, true, 'a static page needs publish: true');
  assert.equal(change.payload.body.tags.length, 4);
  assert.deepEqual(change.rollback.data.body.tags, EXISTING_TAGS);
  assert.match(change.preview.body, /UNVERIFIED/);
  assert.match(change.preview.body, /left exactly as they were/);
  snapshot('wix-item-tags', { method: change.payload.method, url: change.payload.url, body: change.payload.body });
});

test('wix: without item type and id, nothing is guessed', async () => {
  const { impl } = mockFetch(wixRoutes());
  const out = await WIX.plan({ report: report([finding()]) }, { env: { ...WIX_ENV }, fetchImpl: impl });
  assert.deepEqual(out.changes, []);
  assert.match(out.skipped[0].reason, /item type \+ item id/);
});

test('wix: when the endpoint probe fails the change is parked as skipped_unready', async () => {
  const { impl } = mockFetch(wixRoutes({ probeStatus: 404 }));
  const out = await WIX.plan({ report: report([finding()]), answers: wixAnswers }, { env: { ...WIX_ENV }, fetchImpl: impl });
  assert.equal(out.ready, false);
  assert.equal(out.changes.length, 1);
  assert.equal(out.changes[0].status, 'skipped_unready');
  assert.match(out.changes[0].error, /UNVERIFIED/);
  assert.equal(out.changes[0].rollback.kind, 'none', 'no captured tag set means no rollback claim');
});

test('wix: capabilities treats a 400 as "the endpoint is there" and a 404 as "it is not"', async () => {
  const ok = await WIX.capabilities({ env: { ...WIX_ENV }, fetchImpl: mockFetch(wixRoutes({ probeStatus: 400 })).impl });
  assert.equal(ok.ready, true);
  assert.equal(ok.probe.exists, true);
  const gone = await WIX.capabilities({ env: { ...WIX_ENV }, fetchImpl: mockFetch(wixRoutes({ probeStatus: 404 })).impl });
  assert.equal(gone.ready, false);
  assert.match(gone.notes.join(' '), /UNVERIFIED/);
  const denied = await WIX.capabilities({ env: { ...WIX_ENV }, fetchImpl: mockFetch(wixRoutes({ probeStatus: 401 })).impl });
  assert.equal(denied.ready, false);
  assert.match(denied.notes.join(' '), /API key was rejected/);
});

// ---------------------------------------------------------------------------
// Ghost

const GHOST_ENV = { GHOST_URL: 'https://blog.example.test', GHOST_ADMIN_KEY: '6421f0dbb9a0e0a1:0123456789abcdef0123456789abcdef' };
const GHOST_POST = {
  id: 'p1', slug: 'rain-shadow', status: 'published', updated_at: '2026-09-01T10:00:00.000Z',
  meta_title: 'Old meta title', meta_description: 'Old meta description', codeinjection_head: null,
};

function ghostRoutes({ post = GHOST_POST, onPut = null } = {}) {
  return [
    { match: '/posts/slug/rain-shadow/', method: 'GET', body: { posts: [post] } },
    { match: '/posts/p1/', method: 'GET', body: { posts: [post] } },
    { match: '/posts/p1/', method: 'PUT', body: ({ body }) => { if (onPut) onPut(body); return { posts: [{ ...post, ...body.posts[0] }] }; } },
    { match: '/pages/slug/', method: 'GET', status: 404, body: { errors: [{ message: 'not found' }] } },
  ];
}

test('ghost: the admin token is a real HS256 JWT with kid and aud', () => {
  const token = GHOST.ghostToken(GHOST_ENV.GHOST_ADMIN_KEY, { now: 1767225600000 });
  const [h, p, s] = token.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  assert.deepEqual(header, { alg: 'HS256', typ: 'JWT', kid: '6421f0dbb9a0e0a1' });
  assert.equal(payload.aud, '/admin/');
  assert.equal(payload.exp - payload.iat, 300);
  assert.ok(s.length > 20);
  assert.equal(GHOST.ghostToken('not-a-key'), null);
  assert.equal(GHOST.ghostToken('id:nothex'), null);
});

test('ghost: a metadata write carries updated_at and never sends status or the post body', async () => {
  const { impl } = mockFetch(ghostRoutes());
  const out = await GHOST.plan({ report: report([finding()]) }, { env: { ...GHOST_ENV }, fetchImpl: impl });
  assert.equal(out.changes.length, 1);
  const change = out.changes[0];
  const sent = change.payload.body.posts[0];
  assert.equal(sent.updated_at, GHOST_POST.updated_at);
  assert.equal(sent.meta_description, DESCRIPTION);
  assert.ok(!('status' in sent) && !('html' in sent) && !('title' in sent));
  assert.equal(change.live_impact, 'live', 'the post is published, so this is live');
  snapshot('ghost-post', { method: change.payload.method, url: change.payload.url, body: change.payload.body, live_impact: change.live_impact });
});

test('ghost: a draft post is live_impact none and stays a draft', async () => {
  const { impl } = mockFetch(ghostRoutes({ post: { ...GHOST_POST, status: 'draft' } }));
  const out = await GHOST.plan({ report: report([finding()]) }, { env: { ...GHOST_ENV }, fetchImpl: impl });
  assert.equal(out.changes[0].live_impact, 'none');
  assert.ok(!('status' in out.changes[0].payload.body.posts[0]));
});

test('ghost: apply refuses when the post moved under the plan', async () => {
  const { impl } = mockFetch(ghostRoutes({ post: { ...GHOST_POST } }));
  const ctx = { env: { ...GHOST_ENV }, fetchImpl: impl };
  const out = await GHOST.plan({ report: report([finding()]) }, ctx);
  const change = out.changes[0];

  const moved = mockFetch(ghostRoutes({ post: { ...GHOST_POST, updated_at: '2026-09-02T08:00:00.000Z' } }));
  const applied = await GHOST.apply(change, { env: { ...GHOST_ENV }, fetchImpl: moved.impl });
  assert.equal(applied.ok, false);
  assert.equal(applied.change.status, 'failed');
  assert.match(applied.change.error, /changed since this fix was planned/);
  assert.ok(!moved.calls.some((c) => c.method === 'PUT'), 'nothing was written');
});

test('ghost: apply writes with the current updated_at when nothing moved', async () => {
  const sent = [];
  const { impl } = mockFetch(ghostRoutes({ onPut: (body) => sent.push(body) }));
  const ctx = { env: { ...GHOST_ENV }, fetchImpl: impl };
  const out = await GHOST.plan({ report: report([finding()]) }, ctx);
  const applied = await GHOST.apply(out.changes[0], ctx);
  assert.equal(applied.ok, true);
  assert.equal(applied.change.status, 'applied');
  assert.equal(sent[0].posts[0].updated_at, GHOST_POST.updated_at);
});

test('ghost: JSON-LD is appended behind markers and re-running does not stack a second copy', async () => {
  const snippet = '<script type="application/ld+json">{"@type":"Article"}</script>';
  const first = GHOST.upsertHeadBlock(null, snippet);
  assert.equal(first.changed, true);
  assert.match(first.text, /<!-- claude-seo-ai:start -->/);
  const again = GHOST.upsertHeadBlock(first.text, snippet);
  assert.equal(again.changed, false, 'the same block twice is a no-op');
  assert.equal(again.text.split('claude-seo-ai:start').length - 1, 1);

  const existing = '<meta name="verify" content="keep">';
  const kept = GHOST.upsertHeadBlock(existing, snippet);
  assert.ok(kept.text.startsWith(existing), 'code already in the head is left alone');

  const updated = GHOST.upsertHeadBlock(first.text, '<script type="application/ld+json">{"@type":"FAQPage"}</script>');
  assert.equal(updated.changed, true);
  assert.equal(updated.text.split('claude-seo-ai:start').length - 1, 1, 'the block is replaced, not duplicated');
  assert.ok(!updated.text.includes('"Article"'));
});

test('ghost: verify sees the JSON-LD block inside a head that also holds other code', async () => {
  const snippet = '<script type="application/ld+json">{"@type":"Article"}</script>';
  const head = '<meta name="verify" content="keep">\n' + GHOST.upsertHeadBlock(null, snippet).text;
  const post = { ...GHOST_POST, codeinjection_head: head };
  const { impl } = mockFetch([
    { match: '/posts/p1/', method: 'GET', body: { posts: [post] } },
    { match: (url) => url.startsWith(PAGE), method: 'GET', body: '<html><head>' + snippet + '</head></html>', contentType: 'text/html' },
  ]);
  const change = {
    id: 'chg_0000000000bb', adapter: 'page-api', status: 'applied', live_impact: 'live',
    target: { kind: 'resource', locator: 'ghost:posts:p1', url: PAGE },
    payload: { provider: 'ghost', resource: 'posts', post_id: 'p1', url: 'https://blog.example.test/ghost/api/admin/posts/p1/', expect: { jsonld: snippet } },
  };
  const out = await GHOST.verify(change, { env: { ...GHOST_ENV }, fetchImpl: impl });
  assert.equal(out.ok, true);
  assert.equal(out.change.status, 'verified');
});

test('ghost: a JSON-LD finding plans a codeinjection_head write', async () => {
  const { impl } = mockFetch(ghostRoutes());
  const jsonld = finding({ id: 'M5.schema.article_missing', module: 'M5', title: 'Article JSON-LD missing', fix_preview: '<script type="application/ld+json">{"@type":"Article"}</script>' });
  const out = await GHOST.plan({ report: report([jsonld]) }, { env: { ...GHOST_ENV }, fetchImpl: impl });
  assert.equal(out.changes.length, 1);
  const head = out.changes[0].payload.body.posts[0].codeinjection_head;
  assert.match(head, /claude-seo-ai:start/);
  assert.match(head, /"@type":"Article"/);
});

// ---------------------------------------------------------------------------
// HubSpot

const HUBSPOT_ENV = { HUBSPOT_TOKEN: 'pat-na1-secret-token' };
const HUBSPOT_PAGE = { id: '55', slug: 'rain-shadow', url: PAGE, htmlTitle: 'Old title', metaDescription: 'Old description' };

function hubspotRoutes(extra = []) {
  return [
    ...extra,
    { match: '/cms/v3/pages/site-pages?', method: 'GET', body: { results: [HUBSPOT_PAGE], total: 1, paging: {} } },
    { match: '/cms/v3/pages/site-pages/55/draft', method: 'GET', body: { ...HUBSPOT_PAGE, metaDescription: DESCRIPTION } },
    { match: '/cms/v3/pages/site-pages/55/draft', method: 'PATCH', body: { ...HUBSPOT_PAGE, metaDescription: DESCRIPTION } },
  ];
}

test('hubspot: the default route patches the draft and is staged', async () => {
  const { impl } = mockFetch(hubspotRoutes());
  const out = await HUBSPOT.plan({ report: report([finding()]) }, { env: { ...HUBSPOT_ENV }, fetchImpl: impl });
  assert.equal(out.changes.length, 1);
  const change = out.changes[0];
  assert.equal(change.live_impact, 'staged');
  assert.equal(change.payload.draft, true);
  assert.match(change.payload.url, /\/cms\/v3\/pages\/site-pages\/55\/draft$/);
  assert.deepEqual(change.payload.body, { metaDescription: DESCRIPTION });
  assert.deepEqual(change.rollback.data.body, { metaDescription: 'Old description' });
  snapshot('hubspot-draft', { method: change.payload.method, url: change.payload.url, body: change.payload.body, live_impact: change.live_impact });
});

test('hubspot: --live patches the published page and says it is live', async () => {
  const { impl } = mockFetch(hubspotRoutes());
  const out = await HUBSPOT.plan({ report: report([finding()]), live: true }, { env: { ...HUBSPOT_ENV }, fetchImpl: impl });
  const change = out.changes[0];
  assert.equal(change.live_impact, 'live');
  assert.equal(change.payload.draft, false);
  assert.ok(!change.payload.url.endsWith('/draft'));
  assert.match(change.preview.body, /LIVE/);
});

test('hubspot: verify on a staged draft points at the publish step', async () => {
  const { impl } = mockFetch(hubspotRoutes());
  const ctx = { env: { ...HUBSPOT_ENV }, fetchImpl: impl };
  const out = await HUBSPOT.plan({ report: report([finding()]) }, ctx);
  const applied = A.transition(A.transition(out.changes[0], 'confirmed'), 'applied');
  const verified = await HUBSPOT.verify(applied, ctx);
  assert.equal(verified.ok, null);
  assert.match(verified.note, /push-live|pushed live/);
  assert.equal(verified.checks.find((c) => c.name === 'api').ok, true);
});

test('hubspot: publish pushes the draft live, and a 404 says the path is unverified', async () => {
  const okFetch = mockFetch([{ match: '/draft/push-live', method: 'POST', body: { id: '55' } }]);
  const ctx = { env: { ...HUBSPOT_ENV }, fetchImpl: okFetch.impl };
  const change = { id: 'chg_000000000001', payload: { provider: 'hubspot', page_id: '55' } };
  const pushed = await HUBSPOT.publish(change, ctx, {});
  assert.equal(pushed.ok, true);
  assert.match(pushed.url, /\/cms\/v3\/pages\/site-pages\/55\/draft\/push-live$/);

  const gone = mockFetch([{ match: '/draft/push-live', method: 'POST', status: 404, body: { message: 'not found' } }]);
  const failed = await HUBSPOT.publish(change, { env: { ...HUBSPOT_ENV }, fetchImpl: gone.impl }, {});
  assert.equal(failed.ok, false);
  assert.match(failed.note, /UNVERIFIED/);
});

// ---------------------------------------------------------------------------
// BigCommerce

const BC_ENV = { BIGCOMMERCE_STORE_HASH: 'abc123', BIGCOMMERCE_TOKEN: 'bc-secret-token' };
const BC_PRODUCT = {
  id: 12, name: 'Rain shadow guide', custom_url: { url: '/rain-shadow/' },
  page_title: 'Old page title', meta_description: 'Old meta description',
};
const LONG_DESCRIPTION = 'The east side of the range stays dry because the air has already dropped its water on the way up, '
  + 'and what comes down the far slope is warm, thirsty and stripped of every drop it once carried over the ridge line.';

function bcRoutes(extra = []) {
  return [
    ...extra,
    { match: '/v3/catalog/products?', method: 'GET', body: { data: [BC_PRODUCT], meta: { pagination: { total_pages: 1 } } } },
    { match: '/v3/content/pages?', method: 'GET', body: { data: [], meta: { pagination: { total_pages: 1 } } } },
    { match: '/v3/catalog/products/12', method: 'GET', body: { data: { ...BC_PRODUCT } } },
    { match: '/v3/catalog/products/12', method: 'PUT', body: { data: { ...BC_PRODUCT } } },
  ];
}

test('bigcommerce: a product write uses the catalog fields and is live', async () => {
  const { impl } = mockFetch(bcRoutes());
  const out = await BIGCOMMERCE.plan({ report: report([finding()]) }, { env: { ...BC_ENV }, fetchImpl: impl });
  assert.equal(out.changes.length, 1);
  const change = out.changes[0];
  assert.equal(change.live_impact, 'live');
  assert.equal(change.payload.kind, 'product');
  assert.deepEqual(change.payload.body, { meta_description: DESCRIPTION });
  assert.deepEqual(change.payload.truncated, []);
  assert.deepEqual(change.rollback.data.body, { meta_description: 'Old meta description' });
  snapshot('bigcommerce-product', { method: change.payload.method, url: change.payload.url, body: change.payload.body, live_impact: change.live_impact });
});

test('bigcommerce: an over-long value is cut at a word boundary and the preview says so', async () => {
  const { impl } = mockFetch(bcRoutes());
  const long = finding({ fix_preview: '<meta name="description" content="' + LONG_DESCRIPTION + '">' });
  const out = await BIGCOMMERCE.plan({ report: report([long]) }, { env: { ...BC_ENV }, fetchImpl: impl });
  const change = out.changes[0];
  const written = change.payload.body.meta_description;
  assert.ok(written.length <= 160, 'the platform limit is respected');
  assert.ok(LONG_DESCRIPTION.startsWith(written), 'the kept part is a prefix of the original');
  assert.ok(!/\s$/.test(written) && !written.endsWith(','), 'the cut lands on a word boundary');
  assert.deepEqual(change.payload.truncated.map((t) => t.field), ['meta_description']);
  assert.match(change.preview.body, /truncated at a word boundary/);
  snapshot('bigcommerce-truncated', { body: change.payload.body, truncated: change.payload.truncated });
});

test('bigcommerce: a title longer than 70 characters is cut too', async () => {
  const { impl } = mockFetch(bcRoutes());
  const long = finding({ id: 'M7.title.too_long', title: 'Title tag too long', fix_preview: '<title>' + LONG_DESCRIPTION + '</title>' });
  const out = await BIGCOMMERCE.plan({ report: report([long]) }, { env: { ...BC_ENV }, fetchImpl: impl });
  assert.ok(out.changes[0].payload.body.page_title.length <= 70);
  assert.equal(out.changes[0].payload.truncated[0].limit, 70);
});

test('bigcommerce: verify --dev-url looks at the staging storefront', async () => {
  const staging = 'https://staging.example.test';
  const { impl, calls } = mockFetch(bcRoutes([
    { match: (url) => url.startsWith(staging), method: 'GET', body: '<html><head><meta name="description" content="' + DESCRIPTION + '"></head></html>', contentType: 'text/html' },
    { match: '/v3/catalog/products/12', method: 'GET', body: { data: { ...BC_PRODUCT, meta_description: DESCRIPTION } } },
  ]));
  const ctx = { env: { ...BC_ENV }, fetchImpl: impl, devUrl: staging };
  const out = await BIGCOMMERCE.plan({ report: report([finding()]) }, ctx);
  const applied = A.transition(A.transition(out.changes[0], 'confirmed'), 'applied');
  const verified = await BIGCOMMERCE.verify(applied, ctx);
  assert.equal(verified.ok, true);
  assert.equal(verified.change.status, 'verified');
  const checked = calls.filter((c) => c.url.startsWith(staging));
  assert.equal(checked.length, 1);
  assert.ok(!calls.some((c) => c.url.startsWith(PAGE)), 'the production storefront was never fetched');
});

test('bigcommerce: an unmatched URL is reported, not written somewhere else', async () => {
  const { impl } = mockFetch(bcRoutes());
  const elsewhere = finding({ location: { url: 'https://shop.example.test/not-in-the-catalog/' } });
  const out = await BIGCOMMERCE.plan({ report: report([elsewhere]) }, { env: { ...BC_ENV }, fetchImpl: impl });
  assert.deepEqual(out.changes, []);
  assert.match(out.skipped[0].reason, /no BigCommerce product or content page matches/);
});

// ---------------------------------------------------------------------------
// Cross-provider: tickets, persistence, secrets

test('page-api: apply needs a ticket, previews carry no secret, and the log carries no secret', async () => {
  const { dataDir, cleanup } = sandbox();
  const saved = {};
  for (const [k, v] of Object.entries(WEBFLOW_ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const { impl } = mockFetch(webflowRoutes());
    const run = A.openFixRun(dataDir, { target: { kind: 'url', value: PAGE } });
    const out = await WEBFLOW.plan({ report: report([finding()]) }, { env: process.env, fetchImpl: impl, run, dataDir });
    run.setChanges(out.changes);
    const change = out.changes[0];

    const denied = await PAGEAPI.main({ _: ['apply'], provider: 'webflow', data: dataDir, run: run.dir, change: change.id });
    assert.equal(denied.code, 2);
    assert.match(denied.result.results[0].error, /confirmation ticket \(no-ticket\)/);

    const previewed = await PAGEAPI.main({ _: ['preview'], provider: 'webflow', data: dataDir, run: run.dir, change: change.id });
    assert.equal(previewed.code, 0);
    assert.equal(previewed.result.results[0].status, 'previewed');
    const body = readFileSync(run.previewPath(change.id, '.json.txt'), 'utf8');
    assert.ok(!body.includes(WEBFLOW_ENV.WEBFLOW_TOKEN), 'the API token never reaches a preview');
    assert.match(body, /headers: accept, authorization, content-type \(values withheld\)/);
    assert.ok(!readFileSync(run.paths.log, 'utf8').includes(WEBFLOW_ENV.WEBFLOW_TOKEN));
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    cleanup();
  }
});

test('page-api: ops only touch their own provider\'s changes in a shared run', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const run = A.openFixRun(dataDir, {});
    const webflowPlan = await WEBFLOW.plan({ report: report([finding()]) }, { env: { ...WEBFLOW_ENV }, fetchImpl: mockFetch(webflowRoutes()).impl, run });
    const ghostPlan = await GHOST.plan({ report: report([finding()]) }, { env: { ...GHOST_ENV }, fetchImpl: mockFetch(ghostRoutes()).impl, run });
    run.setChanges([...webflowPlan.changes, ...ghostPlan.changes]);
    assert.equal(run.readPlan().changes.length, 2);

    const out = await PAGEAPI.main({ _: ['preview'], provider: 'ghost', data: dataDir, run: run.dir });
    assert.equal(out.result.results.length, 1);
    assert.equal(out.result.results[0].provider, 'ghost');
    const after = run.readPlan().changes;
    assert.equal(after.find((c) => c.payload.provider === 'ghost').status, 'previewed');
    assert.equal(after.find((c) => c.payload.provider === 'webflow').status, 'planned', 'the other provider was left alone');
  } finally { cleanup(); }
});

test('page-api: every provider refuses to plan without its credentials, naming them', async () => {
  for (const id of PAGEAPI.PROVIDER_IDS) {
    const mod = PAGEAPI.PROVIDERS[id];
    const out = await mod.plan({ report: report([finding()]) }, { env: {} });
    assert.equal(out.ready, false, id + ' must not be ready without credentials');
    assert.deepEqual(out.changes, [], id + ' must plan nothing without credentials');
    assert.ok(out.notes.join(' ').includes(mod.KEYS[0]), id + ' must name the missing key');
  }
});

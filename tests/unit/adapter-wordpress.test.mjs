// Unit tests for the two WordPress write adapters.
//
// Everything here is offline: `fetchImpl` and `execImpl` are injected, so the REST adapter never
// opens a socket and the WP-CLI adapter never spawns a process. What is asserted is the part that
// would hurt in production — the exact payload, the refusal to send `status`/`content`, the refusal
// to speak Basic auth over http, the Yoast hand-off, the ticket gate, and that no secret ever
// reaches a preview, a result or the run log.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WP = await import(pathToFileURL(join(ROOT, 'scripts', 'adapters', 'wordpress-rest.mjs')).href);
const CLI = await import(pathToFileURL(join(ROOT, 'scripts', 'adapters', 'wordpress-wpcli.mjs')).href);
const A = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'adapter.mjs')).href);
const SNAPSHOTS = join(ROOT, 'tests', 'snapshots', 'wordpress');

const SITE = 'https://blog.example.test';
const PAGE = SITE + '/rain-shadow/';
const PASSWORD = 'abcd efgh ijkl mnop';
const ENV = Object.freeze({ WP_URL: SITE, WP_USER: 'seobot', WP_APP_PASSWORD: PASSWORD });

// ---------------------------------------------------------------------------
// Helpers

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'cseo-wp-'));
  return { dataDir: join(base, 'data'), base, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}


/** A fetch stand-in driven by a route table; records every call for assertions. */
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
    return { status: 404, headers: new Map([['content-type', 'application/json']]), text: async () => '{"code":"rest_no_route"}' };
  };
  return { impl, calls };
}

/** An exec stand-in: matches on the joined argv, records the calls. */
function mockExec(routes) {
  const calls = [];
  const impl = async (argv) => {
    const line = argv.join(' ');
    calls.push({ argv, line });
    for (const route of routes) {
      const hit = typeof route.match === 'function' ? route.match(line) : line.includes(route.match);
      if (hit) return { code: route.code === undefined ? 0 : route.code, stdout: route.stdout === undefined ? '' : route.stdout, stderr: route.stderr || '', error: null };
    }
    return { code: 0, stdout: '', stderr: '', error: null };
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

const descriptionFinding = {
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
};

const titleFinding = {
  ...descriptionFinding,
  id: 'M7.title.too_long',
  title: 'Title tag too long',
  fix_preview: '<title>Rain shadow, explained</title>',
};

const altFinding = {
  ...descriptionFinding,
  id: 'M9.image.alt_missing',
  module: 'M9',
  title: 'Image alt text missing',
  location: { url: PAGE, selector: 'img[src="/wp-content/uploads/2026/01/dry-valley.jpg"]' },
  fix_preview: '<img src="/wp-content/uploads/2026/01/dry-valley.jpg" alt="A dry valley floor below the ridge">',
};

const report = (findings) => ({ target: { kind: 'url', value: PAGE }, findings });

const POST_EDIT = {
  id: 42,
  slug: 'rain-shadow',
  link: PAGE,
  type: 'post',
  aioseo_meta_data: { title: 'Old SEO title', description: 'Old SEO description' },
  meta: { _seopress_titles_title: 'Old SEOPress title', _seopress_titles_desc: 'Old SEOPress description' },
};

function restRoutes(extra = []) {
  return [
    ...extra,
    { match: '/wp-json/wp/v2/posts?', method: 'GET', body: [{ id: 42, slug: 'rain-shadow', link: PAGE, type: 'post' }] },
    { match: '/wp-json/wp/v2/posts/42', method: 'GET', body: POST_EDIT },
    { match: '/wp-json/wp/v2/media?', method: 'GET', body: [{ id: 77, slug: 'dry-valley', source_url: SITE + '/wp-content/uploads/2026/01/dry-valley.jpg' }] },
    { match: '/wp-json/wp/v2/media/77', method: 'GET', body: { id: 77, alt_text: '' } },
  ];
}

const planCtx = (fetchImpl) => ({ env: { ...ENV }, fetchImpl, dataDir: null });

// ---------------------------------------------------------------------------
// REST: safety rails

test('requireHttps refuses plain http and accepts https', () => {
  const bad = WP.requireHttps('http://blog.example.test');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /readable by anyone on the network path/);
  assert.equal(WP.requireHttps(SITE + '/').ok, true);
  assert.equal(WP.requireHttps(SITE + '/').url, SITE);
  assert.equal(WP.requireHttps('').ok, false);
  assert.equal(WP.requireHttps('not a url').ok, false);
});

test('plan over http produces no changes at all', async () => {
  const { impl, calls } = mockFetch(restRoutes());
  const out = await WP.plan({ report: report([descriptionFinding]) }, { env: { ...ENV, WP_URL: 'http://blog.example.test' }, fetchImpl: impl });
  assert.equal(out.ready, false);
  assert.deepEqual(out.changes, []);
  assert.match(out.notes[0], /refusing http:/);
  assert.equal(calls.length, 0, 'nothing was requested over http');
});

test('sanitizeBody drops status and content', () => {
  const { body, refused } = WP.sanitizeBody({ title: 'ok', status: 'publish', content: '<p>hi</p>', excerpt: 'e' });
  assert.deepEqual(body, { title: 'ok', excerpt: 'e' });
  assert.deepEqual(refused.sort(), ['content', 'status']);
});

test('detectPlugin reads REST namespaces first, then the profile', () => {
  assert.equal(WP.detectPlugin({ namespaces: ['wp/v2', 'aioseo/v1'] }).id, 'aioseo');
  assert.equal(WP.detectPlugin({ namespaces: ['wp/v2', 'aioseo/v1'] }).source, 'rest-namespaces');
  assert.equal(WP.detectPlugin({ profile: { cms_plugins: [{ id: 'woocommerce' }, { id: 'yoast' }] } }).id, 'yoast');
  assert.equal(WP.detectPlugin({ plugin: 'seopress' }).id, 'seopress');
  assert.equal(WP.detectPlugin({}), null);
});

test('resourceFromSnapshot reads the post id from the REST alternate link', () => {
  const snap = {
    parsed: {
      links_rel: [
        { rel: ['https://api.w.org/'], href: SITE + '/wp-json/' },
        { rel: ['alternate'], type: 'application/json', href: SITE + '/wp-json/wp/v2/posts/1984', abs: SITE + '/wp-json/wp/v2/posts/1984' },
      ],
    },
  };
  assert.deepEqual(WP.resourceFromSnapshot(snap), { type: 'posts', id: 1984, source: 'snapshot-alternate-link' });
  assert.equal(WP.resourceFromSnapshot({ parsed: { links_rel: [] } }), null);
});

// ---------------------------------------------------------------------------
// REST: per-plugin payloads

test('AIOSEO plan writes aioseo_meta_data and never touches status or content', async () => {
  const { impl, calls } = mockFetch(restRoutes());
  const out = await WP.plan({
    report: report([descriptionFinding, titleFinding]),
    namespaces: ['wp/v2', 'aioseo/v1'],
  }, planCtx(impl));

  assert.equal(out.plugin, 'aioseo');
  assert.equal(out.changes.length, 2);
  for (const change of out.changes) {
    assert.equal(change.adapter, 'wordpress-rest');
    assert.equal(change.live_impact, 'live');
    assert.equal(change.class, 'proposed');
    assert.equal(change.payload.method, 'POST');
    assert.ok(!('status' in change.payload.body), 'status is never in the body');
    assert.ok(!('content' in change.payload.body), 'content is never in the body');
  }
  snapshot('aioseo-post', out.changes.map((c) => ({
    strategy: c.strategy, method: c.payload.method, path: c.payload.path, body: c.payload.body,
    before: c.before.value, live_impact: c.live_impact, rollback: c.rollback,
  })));
  assert.ok(calls.every((c) => c.method === 'GET'), 'plan only reads');
});

test('SEOPress plan sends title and description together through its own endpoint', async () => {
  const { impl } = mockFetch(restRoutes());
  const out = await WP.plan({
    report: report([descriptionFinding]),
    namespaces: ['wp/v2', 'seopress/v1'],
  }, planCtx(impl));

  assert.equal(out.changes.length, 1);
  const change = out.changes[0];
  assert.equal(change.payload.method, 'PUT');
  assert.equal(change.payload.path, 'seopress/v1/posts/42/title-description-metas');
  assert.equal(change.payload.body.description, 'Why the east side of the range stays dry.');
  assert.equal(change.payload.body.title, 'Old SEOPress title', 'the untouched half is resent as-is, never blanked');
  assert.ok(change.payload.unverified.length, 'the free-tier endpoint is flagged UNVERIFIED');
  snapshot('seopress-put', {
    strategy: change.strategy, method: change.payload.method, path: change.payload.path,
    body: change.payload.body, rollback: change.rollback,
  });
});

test('Yoast has no REST write: the change is skipped_unready with the shim and the WP-CLI command', async () => {
  const { impl } = mockFetch(restRoutes());
  const out = await WP.plan({
    report: report([descriptionFinding, titleFinding]),
    namespaces: ['wp/v2', 'yoast/v1'],
  }, planCtx(impl));

  assert.equal(out.changes.length, 2);
  for (const change of out.changes) {
    assert.equal(change.status, 'skipped_unready');
    assert.equal(change.live_impact, 'none');
    assert.equal(change.preview.kind, 'text');
    assert.match(change.preview.body, /register_post_meta/);
    assert.match(change.preview.body, /'show_in_rest'\s*=>\s*true/);
    assert.match(change.preview.body, /wp post meta update 42 _yoast_wpseo_(title|metadesc)/);
    assert.equal(change.rollback.kind, 'none');
  }
  const description = out.changes.find((c) => c.payload.field === 'description');
  assert.equal(description.payload.meta_key, '_yoast_wpseo_metadesc');
  snapshot('yoast-skipped', out.changes.map((c) => ({
    field: c.payload.field, plugin: c.payload.plugin, meta_key: c.payload.meta_key,
    status: c.status, strategy: c.strategy, live_impact: c.live_impact, verify_method: c.verify.method,
  })));
});

test('Rank Math takes the same shim route as Yoast, with its own meta keys', async () => {
  const { impl } = mockFetch(restRoutes());
  const out = await WP.plan({ report: report([titleFinding]), namespaces: ['rankmath/v1'] }, planCtx(impl));
  assert.equal(out.changes[0].status, 'skipped_unready');
  assert.equal(out.changes[0].payload.meta_key, 'rank_math_title');
});

test('with no SEO plugin, core REST is used for what it owns and the rest is handed back', async () => {
  const { impl } = mockFetch(restRoutes());
  const out = await WP.plan({ report: report([descriptionFinding]) }, planCtx(impl));
  assert.deepEqual(out.changes, []);
  assert.match(out.skipped[0].reason, /no SEO plugin was detected/);
  assert.match(out.skipped[0].reason, /would change the page itself/);
});

test('image alt goes to the attachment the file name resolves to, not to the post', async () => {
  const { impl } = mockFetch(restRoutes());
  const out = await WP.plan({ report: report([altFinding]), namespaces: ['aioseo/v1'] }, planCtx(impl));
  assert.equal(out.changes.length, 1);
  const change = out.changes[0];
  assert.equal(change.payload.path, 'wp/v2/media/77');
  assert.deepEqual(change.payload.body, { alt_text: 'A dry valley floor below the ridge' });
  snapshot('media-alt', { method: change.payload.method, path: change.payload.path, body: change.payload.body });
});

test('an ambiguous attachment is an error, never a coin flip', async () => {
  const { impl } = mockFetch(restRoutes([
    {
      match: '/wp-json/wp/v2/media?',
      method: 'GET',
      body: [
        { id: 77, slug: 'dry-valley', source_url: SITE + '/wp-content/uploads/2026/01/dry-valley.jpg' },
        { id: 78, slug: 'dry-valley', source_url: SITE + '/wp-content/uploads/2025/09/dry-valley.jpg' },
      ],
    },
  ]));
  const out = await WP.plan({ report: report([altFinding]), namespaces: ['aioseo/v1'] }, planCtx(impl));
  assert.deepEqual(out.changes, []);
  assert.match(out.skipped[0].reason, /matches 2 attachments/);
});

test('a finding with no fix_preview is skipped instead of getting an invented value', async () => {
  const { impl } = mockFetch(restRoutes());
  const bare = { ...descriptionFinding };
  delete bare.fix_preview;
  const out = await WP.plan({ report: report([bare]), namespaces: ['aioseo/v1'] }, planCtx(impl));
  assert.deepEqual(out.changes, []);
  assert.match(out.skipped[0].reason, /no value to write/);
});

// ---------------------------------------------------------------------------
// REST: apply / verify / rollback

async function plannedAioseo(fetchImpl, dataDir) {
  const run = A.openFixRun(dataDir, { report: 'report.json', target: { kind: 'url', value: PAGE } });
  const out = await WP.plan({ report: report([descriptionFinding]), namespaces: ['aioseo/v1'] }, { env: { ...ENV }, fetchImpl, run, dataDir });
  run.setChanges(out.changes);
  return { run, change: out.changes[0] };
}

test('apply sends exactly the planned payload and records the run', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const writes = [];
    const { impl, calls } = mockFetch(restRoutes([
      { match: '/wp-json/wp/v2/posts/42', method: 'POST', body: ({ body }) => { writes.push(body); return { id: 42, aioseo_meta_data: body.aioseo_meta_data }; } },
    ]));
    const { run, change } = await plannedAioseo(impl, dataDir);
    const out = await WP.apply(change, { env: { ...ENV }, fetchImpl: impl, run, dataDir });
    assert.equal(out.ok, true);
    assert.equal(out.change.status, 'applied');
    assert.deepEqual(writes, [{ aioseo_meta_data: { description: 'Why the east side of the range stays dry.' } }]);
    const post = calls.find((c) => c.method === 'POST');
    assert.equal(post.url, SITE + '/wp-json/wp/v2/posts/42');
    assert.ok(existsSync(run.afterPath(change.id)), 'the write is recorded in after/');
  } finally { cleanup(); }
});

test('apply refuses a payload that carries status or content', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const { impl } = mockFetch(restRoutes());
    const { run, change } = await plannedAioseo(impl, dataDir);
    const tampered = { ...change, payload: { ...change.payload, body: { ...change.payload.body, status: 'publish' } } };
    const out = await WP.apply(tampered, { env: { ...ENV }, fetchImpl: impl, run, dataDir });
    assert.equal(out.ok, false);
    assert.equal(out.change.status, 'failed');
    assert.match(out.change.error, /never changes post status or content/);
  } finally { cleanup(); }
});

test('apply refuses an http:// target even when the change already carries one', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const { impl, calls } = mockFetch(restRoutes());
    const { run, change } = await plannedAioseo(impl, dataDir);
    const downgraded = { ...change, payload: { ...change.payload, url: 'http://blog.example.test/wp-json/wp/v2/posts/42' } };
    const out = await WP.apply(downgraded, { env: { ...ENV }, fetchImpl: impl, run, dataDir });
    assert.equal(out.ok, false);
    assert.equal(out.change.status, 'failed');
    assert.match(out.change.error, /refusing http:/);
    assert.ok(!calls.some((c) => c.method === 'POST'), 'nothing was sent in the clear');
  } finally { cleanup(); }
});

test('verify: REST correct but the public page stale is pending_cache with flush instructions', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const stale = '<html><head><meta name="description" content="Old SEO description"></head></html>';
    const { impl } = mockFetch(restRoutes([
      { match: '/wp-json/wp/v2/posts/42', method: 'GET', body: { ...POST_EDIT, aioseo_meta_data: { title: 'Old SEO title', description: 'Why the east side of the range stays dry.' } } },
      { match: (url) => url.startsWith(PAGE), method: 'GET', body: stale, contentType: 'text/html' },
    ]));
    const { run, change } = await plannedAioseo(impl, dataDir);
    const applied = A.transition(A.transition(change, 'confirmed'), 'applied');
    const out = await WP.verify(applied, { env: { ...ENV }, fetchImpl: impl, run, dataDir });
    assert.equal(out.ok, null);
    assert.equal(out.change.status, 'pending_cache');
    assert.match(out.note, /wp cache flush/);
    assert.equal(out.checks.find((c) => c.name === 'rest').ok, true);
    assert.equal(out.checks.find((c) => c.name === 'public').ok, false);
  } finally { cleanup(); }
});

test('verify: REST and the public page agree -> verified', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const fresh = '<html><head><meta name="description" content="Why the east side of the range stays dry."></head></html>';
    const { impl, calls } = mockFetch(restRoutes([
      { match: '/wp-json/wp/v2/posts/42', method: 'GET', body: { ...POST_EDIT, aioseo_meta_data: { description: 'Why the east side of the range stays dry.' } } },
      { match: (url) => url.startsWith(PAGE), method: 'GET', body: fresh, contentType: 'text/html' },
    ]));
    const { run, change } = await plannedAioseo(impl, dataDir);
    const applied = A.transition(A.transition(change, 'confirmed'), 'applied');
    const out = await WP.verify(applied, { env: { ...ENV }, fetchImpl: impl, run, dataDir });
    assert.equal(out.ok, true);
    assert.equal(out.change.status, 'verified');
    const publicCall = calls.find((c) => c.url.startsWith(PAGE));
    assert.match(publicCall.url, /claude_seo_ai_cb=\d+/, 'the public re-read is cache-busted');
  } finally { cleanup(); }
});

test('rollback re-sends the value captured before the write', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const writes = [];
    const { impl } = mockFetch(restRoutes([
      { match: '/wp-json/wp/v2/posts/42', method: 'POST', body: ({ body }) => { writes.push(body); return { id: 42 }; } },
    ]));
    const { run, change } = await plannedAioseo(impl, dataDir);
    const applied = A.transition(A.transition(change, 'confirmed'), 'applied');
    const out = await WP.rollback(applied, { env: { ...ENV }, fetchImpl: impl, run, dataDir });
    assert.equal(out.ok, true);
    assert.equal(out.change.status, 'rolled_back');
    assert.deepEqual(writes, [{ aioseo_meta_data: { description: 'Old SEO description' } }]);
  } finally { cleanup(); }
});

test('verify --dev-url checks the staging host instead of production', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const staging = 'https://staging.example.test';
    const fresh = '<html><head><meta name="description" content="Why the east side of the range stays dry."></head></html>';
    const { impl, calls } = mockFetch(restRoutes([
      { match: '/wp-json/wp/v2/posts/42', method: 'GET', body: { ...POST_EDIT, aioseo_meta_data: { description: 'Why the east side of the range stays dry.' } } },
      { match: (url) => url.startsWith(staging), method: 'GET', body: fresh, contentType: 'text/html' },
    ]));
    const { run, change } = await plannedAioseo(impl, dataDir);
    const applied = A.transition(A.transition(change, 'confirmed'), 'applied');
    const out = await WP.verify(applied, { env: { ...ENV }, fetchImpl: impl, run, dataDir, devUrl: staging });
    assert.equal(out.ok, true);
    assert.equal(out.change.status, 'verified');
    const checked = calls.filter((c) => c.url.startsWith(staging));
    assert.equal(checked.length, 1, 'the public check went to the staging host');
    assert.match(checked[0].url, /\/rain-shadow\?claude_seo_ai_cb=/);
    assert.ok(!calls.some((c) => c.url.startsWith(PAGE)), 'production was never fetched');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// REST: CLI, tickets, secrets

test('CLI: apply refuses without a ticket and works with one, and no secret is ever printed', async () => {
  const { dataDir, cleanup } = sandbox();
  const saved = {};
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const { impl } = mockFetch(restRoutes([
      { match: '/wp-json/wp/v2/posts/42', method: 'POST', body: { id: 42 } },
    ]));
    const run = A.openFixRun(dataDir, { report: 'report.json', target: { kind: 'url', value: PAGE } });
    const out = await WP.plan({ report: report([descriptionFinding]), namespaces: ['aioseo/v1'] }, { env: process.env, fetchImpl: impl, run, dataDir });
    run.setChanges(out.changes);
    const change = out.changes[0];

    const denied = await WP.main({ _: ['apply'], data: dataDir, run: run.dir, change: change.id });
    assert.equal(denied.code, 2);
    assert.match(denied.result.results[0].error, /confirmation ticket \(no-ticket\)/);

    const { id } = A.issueTicket(dataDir, { command: 'wordpress-rest apply ' + change.id, run: run.id, change: change.id });
    // The CLI path uses the real global fetch, so only the ticket gate is exercised here; the write
    // itself is covered by the apply test above with an injected fetch.
    const wrongRun = A.requireTicket(dataDir, { ticket: id, run: 'someone-elses-run', change: change.id, consume: false });
    assert.equal(wrongRun.reason, 'wrong-run');

    const previewed = await WP.main({ _: ['preview'], data: dataDir, run: run.dir, change: change.id });
    assert.equal(previewed.code, 0);
    const body = readFileSync(run.previewPath(change.id, '.json.txt'), 'utf8');
    assert.ok(!body.includes(PASSWORD), 'the application password never reaches a preview');
    assert.match(body, /headers: accept, authorization, content-type \(values withheld\)/);
    const log = readFileSync(run.paths.log, 'utf8');
    assert.ok(!log.includes(PASSWORD), 'the application password never reaches the run log');
    assert.ok(!JSON.stringify(previewed.result).includes(PASSWORD));
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    cleanup();
  }
});

test('rollback is never blocked by a missing ticket: undoing a live write must always be possible', async () => {
  const { dataDir, cleanup } = sandbox();
  const saved = {};
  for (const [k, v] of Object.entries({ ...ENV, CLAUDE_SEO_AI_OFFLINE: '1' })) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const { impl } = mockFetch(restRoutes());
    const run = A.openFixRun(dataDir, {});
    const planned = await WP.plan({ report: report([descriptionFinding]), namespaces: ['aioseo/v1'] }, { env: { ...ENV }, fetchImpl: impl, run, dataDir });
    const change = A.transition(A.transition(planned.changes[0], 'confirmed'), 'applied');
    run.setChanges([change]);

    const out = await WP.main({ _: ['rollback'], data: dataDir, run: run.dir, change: change.id });
    const rendered = JSON.stringify(out.result);
    assert.ok(!/confirmation ticket/.test(rendered), 'a rollback is not gated on a ticket');
    assert.match(rendered, /CLAUDE_SEO_AI_OFFLINE/, 'it got as far as trying the request');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    cleanup();
  }
});

test('CLI: plan runs with no network when --answers names the post id, and admits the before value is unknown', async () => {
  const { dataDir, base, cleanup } = sandbox();
  const saved = {};
  for (const [k, v] of Object.entries({ ...ENV, CLAUDE_SEO_AI_OFFLINE: '1' })) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    mkdirSync(base, { recursive: true });
    const reportPath = join(base, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report([descriptionFinding])));
    // Without --include-proposed a live-write adapter plans nothing and says why.
    const held = await WP.main({
      _: ['plan'], report: reportPath, data: dataDir, plugin: 'aioseo',
      answers: JSON.stringify({ resources: { [PAGE]: { type: 'posts', id: 42 } } }),
    });
    assert.deepEqual(held.result.changes, []);
    assert.match(held.result.notes.join(' '), /Re-run with --include-proposed/);

    const out = await WP.main({
      _: ['plan'], report: reportPath, data: dataDir, plugin: 'aioseo', 'include-proposed': true,
      answers: JSON.stringify({ resources: { [PAGE]: { type: 'posts', id: 42 } } }),
    });
    assert.equal(out.code, 0);
    assert.equal(out.result.changes.length, 1);
    const change = out.result.changes[0];
    assert.equal(change.before.known, false, 'an unread before value is reported as unknown, not as empty');
    assert.equal(change.rollback.kind, 'none', 'no captured value means no rollback promise');
    assert.match(out.result.notes.join(' '), /could not read/);
    const written = JSON.parse(readFileSync(join(out.result.run_dir, 'plan.json'), 'utf8'));
    assert.equal(written.changes.length, 1);
    assert.ok(existsSync(join(out.result.run_dir, 'preview')), 'the run has a preview directory');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    cleanup();
  }
});

test('capabilities reports namespaces, the plugin and the application-passwords flag', async () => {
  const { impl } = mockFetch([
    { match: '/wp-json/wp/v2/users/me', method: 'GET', body: { id: 3, slug: 'seobot', capabilities: { edit_posts: true, upload_files: true } } },
    { match: '/wp-json/', method: 'GET', body: { namespaces: ['wp/v2', 'aioseo/v1'], authentication: { 'application-passwords': { endpoints: { authorization: SITE } } } } },
  ]);
  const caps = await WP.capabilities({ env: { ...ENV }, fetchImpl: impl });
  assert.equal(caps.ready, true);
  assert.deepEqual(caps.seo_plugins, ['aioseo']);
  assert.equal(caps.application_passwords, true);
  assert.ok(!JSON.stringify(caps).includes(PASSWORD));
});

test('capabilities is not ready when authentication fails', async () => {
  const { impl } = mockFetch([
    { match: '/wp-json/wp/v2/users/me', method: 'GET', status: 401, body: { code: 'rest_not_logged_in' } },
    { match: '/wp-json/', method: 'GET', body: { namespaces: ['wp/v2'] } },
  ]);
  const caps = await WP.capabilities({ env: { ...ENV }, fetchImpl: impl });
  assert.equal(caps.ready, false);
  assert.match(caps.notes.join(' '), /authentication failed/);
});

// ---------------------------------------------------------------------------
// WP-CLI

const wpCtx = (execImpl, env = {}) => ({ env: { ...env }, execImpl, dataDir: null });

test('wp-cli builds an ssh command with BatchMode and a quoted remote command', async () => {
  const built = CLI.wpCommand(['post', 'meta', 'update', '42', '_yoast_wpseo_title', 'Rain shadow, explained'],
    { env: {} }, { ssh: 'deploy@host.example:/srv/www' });
  assert.equal(built.transport, 'ssh');
  assert.equal(built.argv[0], 'ssh');
  assert.ok(built.argv.includes('BatchMode=yes'));
  assert.ok(built.argv.includes('ConnectTimeout=10'));
  assert.equal(built.remote, "cd /srv/www && wp post meta update 42 _yoast_wpseo_title 'Rain shadow, explained'");
  assert.equal(built.argv[built.argv.length - 1], built.remote, 'the remote command travels as one argv element, not through a local shell');
});

test('wp-cli capabilities runs `wp core version --format=json`', async () => {
  const { impl, calls } = mockExec([{ match: 'core version', stdout: '"6.7.1"' }]);
  const caps = await CLI.capabilities(wpCtx(impl), { ssh: 'deploy@host.example:/srv/www' });
  assert.equal(caps.ready, true);
  assert.equal(caps.version, '6.7.1');
  assert.equal(caps.transport, 'ssh');
  assert.match(calls[0].line, /wp core version --format=json/);
});

test('wp-cli capabilities probes for the binaries instead of asserting them, and names what is missing', async () => {
  const base = mkdtempSync(join(tmpdir(), 'cseo-wpcli-'));
  try {
    // No injected exec and nothing on PATH: `tools.wp` must be the answer of a real probe.
    const bare = await CLI.capabilities({ env: { PATH: '' }, dataDir: null });
    assert.equal(bare.ready, false);
    assert.equal(bare.tools.wp, false, 'capabilities must never claim a tool it did not find');
    assert.deepEqual(bare.needs, ['wp-cli on PATH'], 'a not-ready answer always names what is missing');
    assert.match(bare.notes.join('\n'), /wp` on PATH/);

    // With a `wp` on PATH the probe flips, without spawning it for the answer.
    const bin = join(base, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'wp'), '#!/bin/sh\n', { mode: 0o755 });
    const { impl } = mockExec([{ match: 'core version', stdout: '"6.7.1"' }]);
    const found = await CLI.capabilities({ env: { PATH: bin }, execImpl: impl, dataDir: null });
    assert.equal(found.tools.wp, true);
    assert.equal(found.ready, true);
    assert.deepEqual(found.needs, []);

    // Over ssh the remote host owns `wp`, so the local probe only speaks for the ssh client.
    const remote = await CLI.capabilities({ env: { PATH: '' }, dataDir: null }, { ssh: 'deploy@host.example:/srv/www' });
    assert.equal(remote.tools.wp, undefined, 'no claim is made about a binary on another machine');
    assert.equal(remote.tools.ssh, false);
    assert.deepEqual(remote.needs, ['ssh on PATH']);

    // A transport with no target still says WP_SSH, as before.
    const noTarget = await CLI.capabilities({ env: { PATH: bin }, dataDir: null }, { transport: 'ssh' });
    assert.deepEqual(noTarget.needs, ['WP_SSH']);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('wp-cli plan writes post meta for Yoast, captures before, and can roll it back', async () => {
  const { impl, calls } = mockExec([
    { match: 'post list', stdout: '[42]' },
    { match: 'post meta get 42 _yoast_wpseo_metadesc', stdout: '"Old SEO description"' },
  ]);
  const out = await CLI.plan({
    report: report([descriptionFinding]),
    profile: { cms_plugins: [{ id: 'yoast' }] },
    ssh: 'deploy@host.example:/srv/www',
  }, wpCtx(impl));

  assert.equal(out.changes.length, 1);
  const change = out.changes[0];
  assert.equal(change.strategy, 'wp-post-meta');
  assert.equal(change.payload.key, '_yoast_wpseo_metadesc');
  assert.equal(change.live_impact, 'live');
  assert.equal(change.before.value, 'Old SEO description');
  assert.deepEqual(change.requires.tools, ['wp', 'ssh']);
  assert.match(change.preview.body, /wp post meta update 42 _yoast_wpseo_metadesc/);
  assert.match(change.preview.body, /wp cache flush/);
  assert.ok(calls.every((c) => !/meta update/.test(c.line)), 'plan runs reads only');
  snapshot('wpcli-yoast-meta', {
    strategy: change.strategy, argv: change.payload.argv, read_argv: change.payload.read_argv,
    flush_argv: change.payload.flush_argv, rollback: change.rollback, live_impact: change.live_impact,
  });
});

test('wp-cli refuses to fabricate a post-meta write for AIOSEO', async () => {
  const { impl } = mockExec([{ match: 'post list', stdout: '[42]' }]);
  const out = await CLI.plan({
    report: report([descriptionFinding]),
    profile: { cms_plugins: [{ id: 'aioseo' }] },
    ssh: 'deploy@host.example:/srv/www',
  }, wpCtx(impl));
  assert.deepEqual(out.changes, []);
  assert.match(out.skipped[0].reason, /own database table/);
});

test('wp-cli plans the blog_public option fix and marks the unverified option name', async () => {
  const optionFindings = [
    {
      ...descriptionFinding,
      id: 'M2.wordpress.blog_public_off',
      module: 'M2',
      title: 'Site visibility is set to discourage search engines',
      severity: 5,
      scope: 'site',
      location: { url: SITE + '/' },
      fix_preview: undefined,
    },
    {
      ...descriptionFinding,
      id: 'M2.wordpress.attachment_pages_indexable',
      module: 'M2',
      title: 'Attachment pages are indexable',
      severity: 2,
      scope: 'site',
      location: { url: SITE + '/' },
      fix_preview: undefined,
    },
  ];
  const { impl } = mockExec([
    { match: 'option get blog_public', stdout: '0' },
    { match: 'option get wp_attachment_pages_enabled', stdout: '1' },
  ]);
  const out = await CLI.plan({ report: report(optionFindings), ssh: 'deploy@host.example:/srv/www' }, wpCtx(impl));
  assert.equal(out.changes.length, 2);
  const blogPublic = out.changes.find((c) => c.payload.option === 'blog_public');
  assert.equal(blogPublic.target.kind, 'option');
  assert.equal(blogPublic.before.value, '0');
  assert.deepEqual(blogPublic.payload.unverified, []);
  const attachments = out.changes.find((c) => c.payload.option === 'wp_attachment_pages_enabled');
  assert.deepEqual(attachments.payload.unverified, ['option name wp_attachment_pages_enabled']);
  assert.match(attachments.preview.body, /UNVERIFIED/);
  snapshot('wpcli-options', out.changes.map((c) => ({
    option: c.payload.option, argv: c.payload.argv, before: c.before.value,
    rollback: c.rollback, unverified: c.payload.unverified,
  })));
});

test('wp-cli apply runs the write then the cache flush; rollback restores the old value', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const { impl, calls } = mockExec([
      { match: 'post list', stdout: '[42]' },
      { match: 'post meta get', stdout: '"Old SEO description"' },
      { match: 'post meta update', stdout: 'Success: Updated custom field.' },
      { match: 'cache flush', stdout: 'Success: The cache was flushed.' },
    ]);
    const run = A.openFixRun(dataDir, {});
    const ctx = { env: {}, execImpl: impl, run, dataDir };
    const out = await CLI.plan({
      report: report([descriptionFinding]), profile: { cms_plugins: [{ id: 'rankmath' }] },
      ssh: 'deploy@host.example:/srv/www',
    }, ctx);
    const change = out.changes[0];
    assert.equal(change.payload.key, 'rank_math_description');

    const applied = await CLI.apply(change, ctx);
    assert.equal(applied.ok, true);
    assert.equal(applied.change.status, 'applied');
    assert.equal(applied.cache_flushed, true);
    assert.ok(calls.some((c) => /wp post meta update 42 rank_math_description/.test(c.line)));
    assert.ok(calls.some((c) => /wp cache flush/.test(c.line)));

    const rolled = await CLI.rollback(applied.change, ctx);
    assert.equal(rolled.ok, true);
    assert.equal(rolled.change.status, 'rolled_back');
    const last = calls[calls.length - 1].line;
    assert.match(last, /rank_math_description 'Old SEO description'/);
  } finally { cleanup(); }
});

test('wp-cli apply refuses a command that is not a recognised WP-CLI write', async () => {
  const { impl, calls } = mockExec([]);
  const change = {
    id: 'chg_000000000001', adapter: 'wordpress-wpcli', status: 'planned', live_impact: 'live',
    payload: { argv: ['ssh', 'host', 'cd \'/srv\' && wp plugin list'], command: 'ssh host "wp plugin list"' },
  };
  const out = await CLI.apply(change, wpCtx(impl));
  assert.equal(out.ok, false);
  assert.equal(out.change.status, 'failed');
  assert.match(out.change.error, /not a recognised WP-CLI write/);
  assert.equal(calls.length, 0, 'nothing was executed');
});

test('wp-cli verify: stored but publicly stale is pending_cache', async () => {
  const { impl } = mockExec([
    { match: 'post list', stdout: '[42]' },
    { match: 'post meta get', stdout: '"Why the east side of the range stays dry."' },
  ]);
  const fetch = mockFetch([{ match: (url) => url.startsWith(PAGE), body: '<html><head></head></html>', contentType: 'text/html' }]);
  const ctx = { env: {}, execImpl: impl, fetchImpl: fetch.impl };
  const out = await CLI.plan({
    report: report([descriptionFinding]), profile: { cms_plugins: [{ id: 'yoast' }] },
    ssh: 'deploy@host.example:/srv/www',
  }, ctx);
  const applied = A.transition(A.transition(out.changes[0], 'confirmed'), 'applied');
  const verified = await CLI.verify(applied, ctx);
  assert.equal(verified.ok, null);
  assert.equal(verified.change.status, 'pending_cache');
  assert.match(verified.note, /wp cache flush/);
});

test('wp-cli refuses to reach a remote host when CLAUDE_SEO_AI_OFFLINE is set and no exec is injected', async () => {
  const built = CLI.wpCommand(['core', 'version'], { env: { CLAUDE_SEO_AI_OFFLINE: '1' } }, { ssh: 'deploy@host.example:/srv/www' });
  const res = await CLI.runCommand(built, { env: { CLAUDE_SEO_AI_OFFLINE: '1' } });
  assert.equal(res.code, 1);
  assert.match(res.error, /CLAUDE_SEO_AI_OFFLINE=1/);
});

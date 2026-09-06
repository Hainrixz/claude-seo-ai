// Unit tests for the two Shopify adapters.
//
// Nothing here touches a network socket or a real `shopify` binary: every CLI call goes through an
// injected execImpl and every HTTP call through an injected fetchImpl. The mock exec even simulates
// `theme pull` by copying tests/fixtures/shopify-theme into the working directory, so the pull →
// edit → check → push flow is exercised end to end against real files.
//
// The invariants these tests exist to protect:
//   - a credential never appears in argv (it goes in the child environment)
//   - `--allow-live` / a live push is refused before anything runs
//   - the first push creates an unpublished theme, later pushes target that theme id
//   - a `theme check` error blocks the push and reverts the working file
//   - the GraphQL payloads match the snapshots in tests/snapshots/shopify
//   - a second run of the same fix writes nothing (skipped_idempotent)
//   - apply and publish refuse to run without a confirmation ticket

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const T = await import(pathToFileURL(join(ROOT, 'scripts', 'adapters', 'shopify-theme.mjs')).href);
const S = await import(pathToFileURL(join(ROOT, 'scripts', 'adapters', 'shopify-admin.mjs')).href);
const A = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'adapter.mjs')).href);

const FIXTURE_THEME = join(ROOT, 'tests', 'fixtures', 'shopify-theme');
const SNAPSHOTS = join(ROOT, 'tests', 'snapshots', 'shopify');
const snapshot = (name) => JSON.parse(readFileSync(join(SNAPSHOTS, name), 'utf8'));

const STORE = 'ridgeline-demo.myshopify.com';
const THEME_TOKEN = 'shptka_thisisafaketokenvalue0000';
const ADMIN_TOKEN = 'shpat_thisisafakeadmintoken00000';
const PRODUCT_GID = 'gid://shopify/Product/1234567890';
const COLLECTION_GID = 'gid://shopify/Collection/9876543210';

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'cseo-shop-'));
  const dataDir = join(base, 'data');
  mkdirSync(dataDir, { recursive: true });
  return { base, dataDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const themeEnv = (extra = {}) => ({ PATH: '/usr/bin', SHOPIFY_STORE: STORE, SHOPIFY_THEME_TOKEN: THEME_TOKEN, ...extra });
const adminEnv = (extra = {}) => ({ PATH: '/usr/bin', SHOPIFY_STORE: STORE, SHOPIFY_ADMIN_TOKEN: ADMIN_TOKEN, ...extra });

/**
 * A Shopify CLI stand-in. `handlers` is keyed by subcommand; `pull` copies the fixture theme into
 * whatever `--path` the adapter asked for, which is what the real CLI does.
 */
function mockExec(handlers = {}) {
  const calls = [];
  const impl = async (argv, opts = {}) => {
    calls.push({ argv: [...argv], env: opts.env || {} });
    const sub = argv[0] === 'shopify' ? (argv[1] === 'theme' ? argv[2] : argv[1]) : argv[0];
    const h = handlers[sub];
    if (h === undefined) return { code: 0, stdout: '', stderr: '' };
    const res = typeof h === 'function' ? await h(argv, opts) : h;
    return { code: 0, stdout: '', stderr: '', ...(res || {}) };
  };
  impl.calls = calls;
  impl.forSub = (sub) => calls.filter((c) => (c.argv[1] === 'theme' ? c.argv[2] : c.argv[1]) === sub);
  return impl;
}

const pathArgOf = (argv) => {
  const at = argv.indexOf('--path');
  return at === -1 ? null : argv[at + 1];
};

const copyFixtureOnPull = (argv) => {
  const dest = pathArgOf(argv);
  if (dest) { mkdirSync(dest, { recursive: true }); cpSync(FIXTURE_THEME, dest, { recursive: true }); }
  return { code: 0, stdout: '' };
};

const THEME_LIST = JSON.stringify([
  { id: '101', name: 'Ridgeline live', role: 'main' },
  { id: '102', name: 'Ridgeline backup', role: 'unpublished' },
]);

const okCheck = { code: 0, stdout: '[]' };

function themeCtx(dataDir, run, exec, extra = {}) {
  return { dataDir, run, env: themeEnv(), execImpl: exec, store: STORE, now: () => new Date('2026-09-06T10:00:00Z'), ...extra };
}

/** An HTML response shaped like lib/fetch.mjs `fetchRaw`, which is what snapshotUrl consumes. */
function rawHtml(html, { status = 200, url = 'https://example.invalid/' } = {}) {
  return {
    url, ok: status >= 200 && status < 400, status, final_url: url, status_chain: [{ status, url }], attempts: 1,
    redirects: { hops: 0, loop: false, truncated: false, http_to_https: false, host_changed: false, www_normalized: false, trailing_slash_changed: false },
    headers: { 'content-type': 'text/html' },
    body: { text: html, bytes: html.length, truncated: false, charset: 'utf-8', charset_source: 'meta', content_encoding: null, gunzipped: false, sha256: 'x' },
    timing: { ttfb_ms: 1, download_ms: 1, total_ms: 2 }, error: null,
  };
}

/** A GraphQL stand-in: `route(body)` gets the parsed request body and returns the JSON to send back. */
function mockFetch(route) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, headers: init.headers || {}, body });
    const out = await route(body, calls.length);
    const status = (out && out.__status) || 200;
    const payload = { ...out };
    delete payload.__status;
    return { status, statusText: 'OK', headers: new Map([['content-type', 'application/json']]), text: async () => JSON.stringify(payload) };
  };
  impl.calls = calls;
  return impl;
}

/** Route an Admin GraphQL call by the root field named in its document. */
function graphqlRouter(table) {
  return (body) => {
    const doc = String((body && body.query) || '');
    for (const [name, handler] of Object.entries(table)) {
      if (new RegExp('\\b' + name + '\\b').test(doc)) return typeof handler === 'function' ? handler(body) : handler;
    }
    return { errors: [{ message: 'unrouted operation in test: ' + doc.split('\n')[0] }] };
  };
}

// ---------------------------------------------------------------------------
// shopify-theme: stores, URLs and argv safety

test('normalizeStore accepts a handle, a domain and a full URL, and rejects nonsense', () => {
  assert.equal(T.normalizeStore('ridgeline-demo'), STORE);
  assert.equal(T.normalizeStore(STORE), STORE);
  assert.equal(T.normalizeStore('https://' + STORE + '/products/x?y=1'), STORE);
  assert.equal(T.normalizeStore('HTTPS://Ridgeline-Demo.MyShopify.com/'), STORE);
  assert.equal(T.normalizeStore('shop.example.co.uk'), 'shop.example.co.uk');
  assert.equal(T.normalizeStore(''), null);
  assert.equal(T.normalizeStore('  '), null);
  assert.equal(T.normalizeStore(null), null);
});

test('preview and editor URLs follow the documented shapes', () => {
  const snap = snapshot('theme-cli.argv.json');
  assert.equal(T.previewUrl(STORE, 202, '/collections/trail/products/wool-runner'), snap.preview_url);
  assert.equal(T.editorUrl(STORE, 202), snap.editor_url);
  assert.equal(T.previewUrl(STORE, 202, 'https://' + STORE + '/products/x'), 'https://' + STORE + '/products/x?preview_theme_id=202');
  assert.equal(T.previewUrl(STORE, 202), 'https://' + STORE + '/?preview_theme_id=202');
  assert.equal(T.previewUrl(null, 202), null);
  assert.equal(T.previewUrl(STORE, null), null);
});

test('every CLI argv matches the snapshot, and none of them carries a credential', () => {
  const snap = snapshot('theme-cli.argv.json');
  const work = '/work/shopify/' + STORE + '/101';
  assert.deepEqual(T.themeArgv(['list', '--json']).argv, snap.list);
  assert.deepEqual(T.themeArgv(['pull', '--live'], { path: work }).argv, snap.pull);
  assert.deepEqual(T.themeArgv(['check', '-o', 'json', '--fail-level', 'error'], { path: work }).argv, snap.check);
  assert.deepEqual(T.themeArgv(['push', '--unpublished', '--theme', 'claude-seo-ai 2026-09-06', '--json'], { path: work }).argv, snap.push_first);
  assert.deepEqual(T.themeArgv(['push', '--theme', '202', '--nodelete', '--json'], { path: work }).argv, snap.push_later);
  assert.deepEqual(T.themeArgv(['publish', '--theme', '202', '--force']).argv, snap.publish);
  assert.deepEqual(T.themeArgv(['delete', '--theme', '202', '--force']).argv, snap.delete);
  for (const argv of [snap.list, snap.pull, snap.check, snap.push_first, snap.push_later, snap.publish, snap.delete]) {
    for (const token of argv) {
      assert.ok(!/shptka_|shpat_|--password|--store\b/.test(token), 'no credential or --store in argv: ' + token);
    }
  }
});

test('a live push is refused before it can run, but pulling the live theme is fine', () => {
  assert.throws(() => T.themeArgv(['push', '--allow-live', '--json']), /--allow-live/);
  assert.throws(() => T.themeArgv(['push', '--live', '--json']), /live theme/);
  assert.throws(() => T.themeArgv(['push', '--publish', '--json']), /live theme/);
  assert.throws(() => T.themeArgv(['push', '-l']), /live theme/);
  assert.throws(() => T.assertNoLiveFlags(['shopify', 'theme', 'pull', '--allow-live']), /--allow-live/);
  // `pull --live` reads the published theme into the working copy; nothing on the store changes.
  assert.deepEqual(T.themeArgv(['pull', '--live'], { path: '/w' }).argv, ['shopify', 'theme', 'pull', '--live', '--path', '/w']);
});

test('credentials travel in the child environment, never in argv', () => {
  const env = T.childEnv(themeEnv(), { store: STORE });
  assert.equal(env.SHOPIFY_FLAG_STORE, STORE);
  assert.equal(env.SHOPIFY_CLI_THEME_TOKEN, THEME_TOKEN);
  assert.equal(env.CI, '1', 'the CLI must not open an interactive prompt inside a subagent');
  const names = snapshot('theme-cli.argv.json').env_var_names;
  for (const name of names) assert.ok(name in env, name + ' is set for the child');
  // The alias spelling resolves too (SHOPIFY_CLI_THEME_TOKEN is the name lib/platform-rules uses).
  const aliased = T.childEnv({ SHOPIFY_STORE: STORE, SHOPIFY_CLI_THEME_TOKEN: THEME_TOKEN }, { store: STORE });
  assert.equal(aliased.SHOPIFY_CLI_THEME_TOKEN, THEME_TOKEN);
});

// ---------------------------------------------------------------------------
// shopify-theme: parsing CLI output

test('parseThemeList reads both output shapes and finds the live and staging themes', () => {
  const themes = T.parseThemeList(THEME_LIST);
  assert.equal(themes.length, 2);
  assert.equal(T.liveThemeOf(themes).id, '101');
  assert.equal(T.stagingThemeOf(themes), null);
  const withStaging = T.parseThemeList(JSON.stringify({ themes: [{ id: '101', role: 'main', name: 'live' }, { id: '202', role: 'unpublished', name: 'claude-seo-ai 2026-09-06' }] }));
  assert.equal(T.stagingThemeOf(withStaging).id, '202');
  assert.equal(T.parseThemeList('not json at all'), null);
  assert.equal(T.liveThemeOf(T.parseThemeList(JSON.stringify([{ id: '9', role: 'live', name: 'x' }]))).id, '9');
});

test('parseThemeCheck reports errors, and unparseable output with a bad exit is not a pass', () => {
  const clean = T.parseThemeCheck('[]', 0);
  assert.equal(clean.ok, true);
  assert.equal(clean.errors.length, 0);

  const failing = T.parseThemeCheck(JSON.stringify([
    { path: 'layout/theme.liquid', offenses: [{ check: 'LiquidTag', message: 'Syntax error', severity: 0, start_line: 12 }, { check: 'Style', message: 'nit', severity: 1 }] },
  ]), 1);
  assert.equal(failing.ok, false);
  assert.equal(failing.offenses, 2);
  assert.equal(failing.errors.length, 1);
  assert.equal(failing.errors[0].line, 12);

  const garbled = T.parseThemeCheck('the CLI crashed', 2);
  assert.equal(garbled.parsed, false);
  assert.equal(garbled.ok, false, 'a non-zero exit with no JSON must block, not pass');
  assert.equal(T.parseThemeCheck('', 0).ok, true);
});

test('parsePushResult accepts several key spellings and derives the URLs when the CLI omits them', () => {
  const nested = T.parsePushResult(JSON.stringify({ theme: { id: 202, name: 'claude-seo-ai 2026-09-06' } }), { store: STORE });
  assert.equal(nested.theme_id, '202');
  assert.equal(nested.preview_url, 'https://' + STORE + '/?preview_theme_id=202');
  assert.equal(nested.url_source, 'derived');

  const explicit = T.parsePushResult(JSON.stringify({ id: 303, preview_url: 'https://x.test/p', editor_url: 'https://x.test/e' }), { store: STORE });
  assert.equal(explicit.theme_id, '303');
  assert.equal(explicit.preview_url, 'https://x.test/p');
  assert.equal(explicit.url_source, 'cli');

  const noise = T.parsePushResult('info: pushing…\n{"theme":{"id":"404"}}\n', { store: STORE });
  assert.equal(noise.theme_id, '404');
  assert.equal(T.parsePushResult('nothing json here', { store: STORE }).ok, false);
});

// ---------------------------------------------------------------------------
// shopify-theme: the fix map (references/platforms/shopify.md §5)

test('the fix map routes each finding to the theme file the card names', () => {
  const at = (id) => T.themeTargetFor({ id });
  assert.equal(at('M2.shopify.collection_path_duplicate').file, 'layout/theme.liquid');
  assert.equal(at('M2.shopify.collection_path_duplicate').block, 'canonical');
  assert.equal(at('M2.shopify.variant_param_canonical').block, 'canonical');
  assert.equal(at('M20.shopify.duplicate_hreflang').strategy, 'manual');
  assert.equal(at('M1.shopify.tag_combo_urls_crawlable').file, 'templates/robots.txt.liquid');
  assert.equal(at('M17.robots.no_sitemap_line').file, 'templates/robots.txt.liquid');
  assert.equal(at('M5.shopify.theme_jsonld_gaps').file, 'sections/main-product.liquid');
  assert.equal(at('M5.organization.missing').file, 'snippets/seo-structured-data.liquid');
  assert.equal(at('M5.article.missing').file, 'sections/main-article.liquid');
  assert.equal(at('M5.jsonld.invalid_json').strategy, 'manual');
  assert.equal(at('M21.llmstxt.missing').file, 'templates/llms.txt.liquid');
  assert.equal(at('M8.og.missing_image').block, 'social');
  assert.equal(at('M20.lang.mismatch').strategy, 'liquid-html-lang');
});

test('platform-owned and unobservable ids are never claimed by the theme adapter', () => {
  assert.equal(T.themeTargetFor({ id: 'M17.shopify.sitemap_platform_owned' }), null, 'Shopify owns sitemap.xml');
  assert.equal(T.themeTargetFor({ id: 'M1.shopify.robots_liquid_drops_defaults' }), null, 'that id is needs_api, not a fix');
  assert.equal(T.themeTargetFor({ id: 'M1.robots.unreachable' }), null, 'a robots.txt that does not answer is a server problem, not a theme edit');
  assert.equal(T.themeTargetFor({ id: 'M15.lcp.exceeds_p75' }), null);
  assert.equal(T.themeTargetFor({}), null);
});

test('only an additive robots line is auto: blocks, crawl-delay and the default groups are proposed', () => {
  const at = (id) => T.themeTargetFor({ id });
  // Additive and deterministic: appending the directive is the whole fix.
  for (const id of ['M1.sitemap.missing_directive', 'M17.robots.no_sitemap_line']) {
    assert.equal(at(id).cls, 'auto', id + ' only adds a line');
    assert.equal(at(id).strategy, 'liquid-robots', id);
    assert.equal(at(id).robots_kind, 'additive', id);
  }
  // Restoring the platform defaults re-imposes every Shopify Disallow: a person approves that.
  for (const id of ['M1.shopify.tag_combo_urls_crawlable', 'M1.shopify.filter_sort_urls_crawlable']) {
    assert.equal(at(id).cls, 'proposed', id + ' changes what is crawlable');
    assert.equal(at(id).robots_kind, 'restore-defaults', id);
  }
  // Nothing that removes or rewrites an existing directive is an append, so none of these is auto.
  for (const id of ['M1.robots.blocks_googlebot', 'M1.robots.blocks_css_js', 'M1.robots.syntax_error', 'M1.crawl_delay.excessive']) {
    const entry = at(id);
    assert.equal(entry.cls, 'proposed', id + ' must not be auto');
    assert.equal(entry.strategy, 'manual', id + ' cannot be performed by appending a block');
    assert.equal(entry.robots_kind, 'edit-existing', id);
  }
  // Every robots route lands in the template, and no robots route is auto unless it is additive.
  for (const entry of T.THEME_FIX_MAP.filter((e) => e.block === 'robots')) {
    assert.equal(entry.file, 'templates/robots.txt.liquid');
    if (entry.cls === 'auto') assert.equal(entry.robots_kind, 'additive', 'an auto robots edit must be additive: ' + entry.id);
  }
});

test('an additive robots change is skipped when nobody supplied the directive to add', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const run = A.openFixRun(dataDir, {});
    const noLine = {
      id: 'M17.robots.no_sitemap_line', module: 'M17', title: 'robots.txt declares no sitemap',
      status: 'warn', severity: 3, scope: 'site', fixable: 'auto',
      location: { url: 'https://' + STORE + '/robots.txt' },
    };
    const bare = await T.plan({ report: { target: { kind: 'url', value: 'https://' + STORE + '/' }, findings: [noLine] }, store: STORE }, { run, dataDir, env: themeEnv() });
    assert.deepEqual(bare.changes, [], 'a robots block with no directive would write nothing');
    assert.match(bare.skipped[0].reason, /never invented/);

    // With the line, it is planned as an auto, additive change carrying exactly that directive.
    const withLine = await T.plan({
      report: { target: { kind: 'url', value: 'https://' + STORE + '/' }, findings: [{ ...noLine, fix_preview: 'Sitemap: https://' + STORE + '/sitemap.xml' }] },
      store: STORE,
    }, { run, dataDir, env: themeEnv() });
    assert.equal(withLine.changes.length, 1);
    assert.equal(withLine.changes[0].class, 'auto');
    assert.deepEqual(withLine.changes[0].payload.rules, ['Sitemap: https://' + STORE + '/sitemap.xml']);
    assert.equal(withLine.changes[0].payload.robots_kind, 'additive');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// shopify-theme: the edits themselves

const themeSource = () => readFileSync(join(FIXTURE_THEME, 'layout', 'theme.liquid'), 'utf8');

test('a head block goes in behind a liquid marker comment and re-running it changes nothing', () => {
  const change = { strategy: 'liquid-head', payload: { block: 'canonical', snippet: '<link rel="canonical" href="{{ canonical_url }}">' } };
  const first = T.computeThemeEdit(themeSource(), change);
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.match(first.text, /\{% comment %\}claude-seo-ai:canonical:start\{% endcomment %\}/);
  assert.match(first.text, /\{% comment %\}claude-seo-ai:canonical:end\{% endcomment %\}/);
  assert.match(first.text, /<link rel="canonical" href="\{\{ canonical_url \}\}">/);
  assert.ok(first.text.indexOf('claude-seo-ai:canonical:start') < first.text.indexOf('</head>'), 'the block lands inside <head>');

  const second = T.computeThemeEdit(first.text, change);
  assert.equal(second.changed, false, 'a second run is a no-op, not a duplicate block');
  assert.equal(second.text, first.text);
});

test('a head block is refused when there is no head and when there is no snippet', () => {
  const noHead = T.computeThemeEdit('{{ content_for_layout }}', { strategy: 'liquid-head', payload: { block: 'social', snippet: '<meta>' } });
  assert.equal(noHead.ok, false);
  assert.equal(noHead.reason, 'no-head');
  const empty = T.computeThemeEdit(themeSource(), { strategy: 'liquid-head', payload: { block: 'social', snippet: '   ' } });
  assert.equal(empty.reason, 'empty-snippet');
  const missing = T.computeThemeEdit(null, { strategy: 'liquid-head', payload: { block: 'social', snippet: '<meta>' } });
  assert.equal(missing.reason, 'theme-file-missing');
});

test('the html lang edit is exact, idempotent, and refuses an ambiguous document', () => {
  const change = { strategy: 'liquid-html-lang', payload: { block: 'html-lang', lang: T.HTML_LANG_VALUE } };
  const out = T.computeThemeEdit(themeSource(), change);
  assert.equal(out.changed, true);
  assert.match(out.text, /<html lang="\{\{ request\.locale\.iso_code \}\}" class="no-js">/);
  assert.equal(T.computeThemeEdit(out.text, change).changed, false);

  const existing = T.computeThemeEdit('<html lang="en"><head><title>x</title></head></html>', change);
  assert.match(existing.text, /lang="\{\{ request\.locale\.iso_code \}\}"/);
  assert.ok(!existing.text.includes('lang="en"'));

  assert.equal(T.computeThemeEdit('<div>no html tag</div>', change).reason, 'no-html-tag');
  assert.equal(T.computeThemeEdit('<html><body></body></html><html></html>', change).reason, 'ambiguous-html-tag');
});

test('the robots template always keeps Shopify\'s default_groups loop', () => {
  const change = { strategy: 'liquid-robots', payload: { block: 'robots', rules: [] } };
  const created = T.computeThemeEdit(null, change);
  assert.equal(created.changed, true);
  assert.ok(T.hasDefaultGroupsLoop(created.text));
  assert.match(created.text, /\{% for group in robots\.default_groups %\}/);

  // A merchant template that dropped the loop silently discards every Shopify default: put it back.
  const broken = 'User-agent: *\nDisallow: /internal\n';
  const repaired = T.computeThemeEdit(broken, change);
  assert.equal(repaired.changed, true);
  assert.ok(T.hasDefaultGroupsLoop(repaired.text));
  assert.ok(repaired.text.includes('Disallow: /internal'), 'the merchant\'s own rules are kept');
  assert.ok(repaired.text.indexOf('default_groups') < repaired.text.indexOf('Disallow: /internal'));

  assert.equal(T.computeThemeEdit(repaired.text, change).changed, false, 'nothing to do the second time');

  const withRules = T.computeThemeEdit(created.text, { strategy: 'liquid-robots', payload: { block: 'robots', rules: ['Disallow: /collections/*+*'] } });
  assert.match(withRules.text, /claude-seo-ai:robots:start/);
  assert.match(withRules.text, /Disallow: \/collections\/\*\+\*/);
});

test('robotsRulesFrom keeps directive lines and drops prose', () => {
  const rules = T.robotsRulesFrom('Add these lines:\nDisallow: /collections/*+*\nSitemap: https://x.test/sitemap.xml\nthanks!');
  assert.deepEqual(rules, ['Disallow: /collections/*+*', 'Sitemap: https://x.test/sitemap.xml']);
  assert.deepEqual(T.robotsRulesFrom(''), []);
});

test('a generated snippet file is created and then updated in place', () => {
  const change = { strategy: 'liquid-snippet', payload: { block: 'structured-data', snippet: '<script type="application/ld+json">{"@type":"Organization"}</script>' } };
  const created = T.computeThemeEdit(null, change);
  assert.equal(created.reason, 'created');
  assert.match(created.text, /claude-seo-ai:structured-data:start/);
  const again = T.computeThemeEdit(created.text, change);
  assert.equal(again.changed, false);
  const updated = T.computeThemeEdit(created.text, { strategy: 'liquid-snippet', payload: { block: 'structured-data', snippet: '<script type="application/ld+json">{"@type":"WebSite"}</script>' } });
  assert.equal(updated.reason, 'block-updated');
  assert.match(updated.text, /WebSite/);
  assert.ok(!updated.text.includes('Organization'), 'the block is replaced, not stacked');
});

test('a manual strategy is never rewritten automatically', () => {
  const out = T.computeThemeEdit(themeSource(), { strategy: 'manual', payload: { block: 'hreflang' } });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'manual-edit-required');
  assert.equal(out.changed, false);
});

// ---------------------------------------------------------------------------
// shopify-theme: plan

const themeFindings = [
  {
    id: 'M2.shopify.collection_path_duplicate', module: 'M2', title: 'Collection-path product URLs do not canonicalise',
    status: 'fail', severity: 4, scope: 'template', fixable: 'auto',
    location: { url: 'https://' + STORE + '/collections/trail/products/wool-runner' },
    evidence: { observed: 'the canonical points at the collection path' },
  },
  {
    id: 'M8.og.missing_image', module: 'M8', title: 'No og:image', status: 'warn', severity: 2, scope: 'template', fixable: 'auto',
    location: { url: 'https://' + STORE + '/products/wool-runner' },
    fix_preview: '<meta property="og:image" content="{{ page_image | image_url: width: 1200 }}">',
  },
  {
    id: 'M8.twitter.no_card', module: 'M8', title: 'No twitter:card', status: 'warn', severity: 2, scope: 'template', fixable: 'auto',
    location: { url: 'https://' + STORE + '/products/wool-runner' },
  },
  {
    id: 'M1.shopify.tag_combo_urls_crawlable', module: 'M1', title: 'Tag combinations are crawlable', status: 'warn', severity: 3, scope: 'site', fixable: 'auto',
    location: { url: 'https://' + STORE + '/robots.txt' },
  },
  {
    id: 'M20.shopify.duplicate_hreflang', module: 'M20', title: 'Duplicate hreflang', status: 'fail', severity: 3, scope: 'page', fixable: 'proposed',
    location: { url: 'https://' + STORE + '/products/wool-runner' },
  },
  {
    id: 'M5.organization.missing', module: 'M5', title: 'No Organization markup', status: 'warn', severity: 3, scope: 'site', fixable: 'auto',
    location: { url: 'https://' + STORE + '/' },
    fix_preview: '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Ridgeline"}</script>',
  },
];

const themeReport = { target: { kind: 'url', value: 'https://' + STORE + '/' }, findings: themeFindings };

test('plan maps findings onto theme files, and never invents a value it was not given', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const run = A.openFixRun(dataDir, {});
    const out = await T.plan({ report: themeReport, store: STORE, includeProposed: true }, { run, dataDir, env: themeEnv() });
    assert.equal(out.ready, true);
    assert.equal(out.store, STORE);

    const byFile = new Map(out.changes.map((c) => [c.payload.block, c]));
    const canonical = byFile.get('canonical');
    assert.equal(canonical.target.kind, 'theme-file');
    assert.equal(canonical.target.locator, 'layout/theme.liquid');
    assert.equal(canonical.class, 'auto');
    assert.equal(canonical.live_impact, 'staged', 'a theme edit is staged, never live');
    assert.deepEqual(canonical.requires, { credentials: ['SHOPIFY_STORE', 'SHOPIFY_THEME_TOKEN'], tools: ['shopify'] });
    assert.equal(canonical.rollback.kind, 'restore-file');
    assert.deepEqual(A.validateChange(canonical, { phase: 'preview' }), []);
    assert.match(canonical.preview.body, /Nothing goes live/);

    assert.equal(byFile.get('social').payload.snippet, themeFindings[1].fix_preview);
    assert.equal(byFile.get('robots').target.locator, 'templates/robots.txt.liquid');
    assert.equal(byFile.get('hreflang').class, 'proposed', 'removing hand-written hreflang is a manual edit');
    assert.equal(byFile.get('hreflang').op, 'remove');

    // A generated JSON-LD snippet also needs the layout to render it: the pair is planned together.
    assert.ok(byFile.has('structured-data'));
    assert.ok(byFile.has('structured-data-render'));
    assert.equal(byFile.get('structured-data-render').payload.snippet, T.RENDER_STRUCTURED_DATA);

    const skippedTwitter = out.skipped.find((s) => s.finding === 'M8.twitter.no_card');
    assert.ok(skippedTwitter, 'a social block with no text to write is skipped');
    assert.match(skippedTwitter.reason, /never invented|nothing here is invented|invented/);

    // Every id is stable: planning the same report twice yields the same ids.
    const again = await T.plan({ report: themeReport, store: STORE, includeProposed: true }, { run, dataDir, env: themeEnv() });
    assert.deepEqual(again.changes.map((c) => c.id).sort(), out.changes.map((c) => c.id).sort());
  } finally { cleanup(); }
});

test('plan drops proposed changes unless they were asked for, and reports a missing store', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const run = A.openFixRun(dataDir, {});
    const auto = await T.plan({ report: themeReport, store: STORE }, { run, dataDir, env: themeEnv() });
    assert.ok(!auto.changes.some((c) => c.payload.block === 'hreflang'));

    const noStore = await T.plan({ report: themeReport }, { run, dataDir, env: { PATH: '/usr/bin' } });
    assert.equal(noStore.ready, false);
    assert.match(noStore.notes.join(' '), /store/);
  } finally { cleanup(); }
});

test('plan can take the text from --answers when the audit had none', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const run = A.openFixRun(dataDir, {});
    const answers = { 'M8.twitter.no_card': '<meta name="twitter:card" content="summary_large_image">' };
    const out = await T.plan({ report: themeReport, store: STORE, answers }, { run, dataDir, env: themeEnv() });
    const social = out.changes.filter((c) => c.payload.block === 'social');
    assert.equal(social.length, 2, 'og and twitter each get their own block now');
    assert.ok(social.some((c) => c.payload.snippet.includes('twitter:card')));
    assert.ok(social.some((c) => c.payload.source === 'answers'));
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// shopify-theme: preview / apply

async function plannedRun(dataDir, exec, { includeProposed = false } = {}) {
  const run = A.openFixRun(dataDir, {});
  const out = await T.plan({ report: themeReport, store: STORE, includeProposed }, { run, dataDir, env: themeEnv(), execImpl: exec });
  run.setChanges(out.changes);
  return { run, changes: out.changes };
}

test('preview pulls once, backs the theme up, edits the working copy and returns a diff', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const exec = mockExec({ list: { stdout: THEME_LIST }, pull: copyFixtureOnPull, check: okCheck });
    const { run, changes } = await plannedRun(dataDir, exec);
    const canonical = changes.find((c) => c.payload.block === 'canonical');

    const res = await T.preview(canonical, themeCtx(dataDir, run, exec));
    assert.equal(res.ok, true);
    assert.equal(res.change.status, 'previewed');
    assert.equal(res.change.preview.kind, 'diff');
    assert.match(res.body, /^--- a\/layout\/theme\.liquid/m);
    assert.match(res.body, /\+.*claude-seo-ai:canonical:start/);

    const work = T.workDirFor(dataDir, STORE, '101');
    assert.ok(existsSync(join(work, 'layout', 'theme.liquid')));
    assert.match(readFileSync(join(work, 'layout', 'theme.liquid'), 'utf8'), /canonical_url/);

    const manifest = run.readManifest();
    assert.equal(manifest.shopify.live_theme_id, '101');
    assert.ok(existsSync(join(manifest.shopify.backup_dir, 'layout', 'theme.liquid')), 'the pull was copied to a backup');
    assert.ok(!readFileSync(join(manifest.shopify.backup_dir, 'layout', 'theme.liquid'), 'utf8').includes('claude-seo-ai'), 'the backup is the pre-edit theme');

    // A second preview reuses the working copy: exactly one pull for the whole run.
    const robots = changes.find((c) => c.payload.block === 'robots');
    await T.preview(robots, themeCtx(dataDir, run, exec));
    assert.equal(exec.forSub('pull').length, 1);
    assert.ok(existsSync(join(work, 'templates', 'robots.txt.liquid')));
  } finally { cleanup(); }
});

test('a theme check error blocks the change, reverts the working file and never pushes', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const failing = JSON.stringify([{ path: 'layout/theme.liquid', offenses: [{ check: 'LiquidHTMLSyntaxError', message: 'Attempting to end parsing before end of document', severity: 0, start_line: 6 }] }]);
    const exec = mockExec({ list: { stdout: THEME_LIST }, pull: copyFixtureOnPull, check: { code: 1, stdout: failing } });
    const { run, changes } = await plannedRun(dataDir, exec);
    const canonical = changes.find((c) => c.payload.block === 'canonical');

    const res = await T.preview(canonical, themeCtx(dataDir, run, exec));
    assert.equal(res.ok, false);
    assert.equal(res.change.status, 'failed');
    assert.match(res.change.error, /theme check failed/);
    assert.match(res.change.error, /LiquidHTMLSyntaxError/);

    const work = T.workDirFor(dataDir, STORE, '101');
    assert.ok(!readFileSync(join(work, 'layout', 'theme.liquid'), 'utf8').includes('claude-seo-ai'), 'the working file was put back');
    assert.equal(exec.forSub('push').length, 0, 'nothing is pushed after a failed check');

    // apply refuses the same way, even with the change already confirmed.
    const confirmed = A.transition(changes.find((c) => c.payload.block === 'robots'), 'confirmed');
    const applied = await T.apply(confirmed, themeCtx(dataDir, run, exec));
    assert.equal(applied.ok, false);
    assert.equal(applied.change.status, 'failed');
    assert.match(applied.change.error, /nothing was pushed/);
    assert.equal(exec.forSub('push').length, 0);
  } finally { cleanup(); }
});

test('the first apply creates an unpublished theme; later applies push to that theme id', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const exec = mockExec({
      list: { stdout: THEME_LIST },
      pull: copyFixtureOnPull,
      check: okCheck,
      push: { stdout: JSON.stringify({ theme: { id: 202, name: 'claude-seo-ai 2026-09-06' } }) },
    });
    const { run, changes } = await plannedRun(dataDir, exec);
    const canonical = A.transition(changes.find((c) => c.payload.block === 'canonical'), 'confirmed');
    const robots = A.transition(changes.find((c) => c.payload.block === 'robots'), 'confirmed');

    const ctx1 = themeCtx(dataDir, run, exec);
    const first = await T.apply(canonical, ctx1);
    assert.equal(first.ok, true);
    assert.equal(first.change.status, 'applied');
    assert.equal(first.push.theme_id, '202');
    assert.equal(first.push.created, true);

    const firstPush = exec.forSub('push')[0].argv;
    assert.ok(firstPush.includes('--unpublished'), 'the first push creates an unpublished theme');
    assert.ok(firstPush.includes('claude-seo-ai 2026-09-06'));
    assert.ok(!firstPush.includes('--allow-live') && !firstPush.includes('--live'));

    // Two changes applied in one invocation share a single push.
    const alsoFirst = await T.apply(robots, ctx1);
    assert.equal(alsoFirst.ok, true);
    assert.equal(exec.forSub('push').length, 1, 'one push per invocation, not one per change');

    // A later invocation reuses the staging theme recorded in the manifest.
    const ctx2 = themeCtx(dataDir, run, exec);
    const second = await T.apply(A.transition(changes.find((c) => c.payload.block === 'social'), 'confirmed'), ctx2);
    assert.equal(second.ok, true);
    const laterPush = exec.forSub('push')[1].argv;
    assert.deepEqual(laterPush.slice(0, 7), ['shopify', 'theme', 'push', '--theme', '202', '--nodelete', '--json']);
    assert.ok(!laterPush.includes('--unpublished'));

    const manifest = run.readManifest();
    assert.equal(manifest.shopify.staging_theme_id, '202');
    assert.equal(manifest.shopify.preview_url, 'https://' + STORE + '/?preview_theme_id=202');
    assert.deepEqual(manifest.shopify.created_themes, ['202']);

    // Nothing this adapter ran carried a credential on the command line.
    for (const call of exec.calls) {
      for (const token of call.argv) assert.ok(!token.includes(THEME_TOKEN), 'no token in argv');
      assert.equal(call.env.SHOPIFY_CLI_THEME_TOKEN, THEME_TOKEN, 'the token is in the child env instead');
    }
  } finally { cleanup(); }
});

test('applying an already-staged change writes nothing and pushes nothing', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const exec = mockExec({ list: { stdout: THEME_LIST }, pull: copyFixtureOnPull, check: okCheck, push: { stdout: '{"theme":{"id":202}}' } });
    const { run, changes } = await plannedRun(dataDir, exec);
    const canonical = changes.find((c) => c.payload.block === 'canonical');
    await T.preview(canonical, themeCtx(dataDir, run, exec));
    const second = await T.preview(canonical, themeCtx(dataDir, run, exec));
    assert.equal(second.change.status, 'skipped_idempotent');
    assert.equal(exec.forSub('push').length, 0);
  } finally { cleanup(); }
});

test('a manual change is handed back rather than applied, and missing credentials are not a failure', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const exec = mockExec({ list: { stdout: THEME_LIST }, pull: copyFixtureOnPull, check: okCheck });
    const { run, changes } = await plannedRun(dataDir, exec, { includeProposed: true });
    const hreflang = changes.find((c) => c.payload.block === 'hreflang');
    const previewed = await T.preview(hreflang, themeCtx(dataDir, run, exec));
    assert.equal(previewed.change.status, 'previewed');
    assert.equal(previewed.manual, true);
    const applied = await T.apply(A.transition(previewed.change, 'confirmed'), themeCtx(dataDir, run, exec));
    assert.equal(applied.change.status, 'skipped_unready');
    assert.match(applied.change.error, /Edit\/Write/);

    const canonical = changes.find((c) => c.payload.block === 'canonical');
    const noCreds = await T.preview(canonical, { dataDir, run, env: { PATH: '/usr/bin', SHOPIFY_STORE: STORE }, execImpl: exec, store: STORE });
    assert.equal(noCreds.change.status, 'skipped_unready');
    assert.match(noCreds.change.error, /SHOPIFY_THEME_TOKEN/);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// shopify-theme: verify, rollback, publish

const PREVIEWED_HTML = (canonical) => '<!doctype html><html lang="en-US"><head><meta charset="utf-8"><title>Wool Runner</title>'
  + '<link rel="canonical" href="' + canonical + '"></head><body><h1>Wool Runner</h1></body></html>';

test('verify passes when the preview theme serves the canonical the fix asked for', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const exec = mockExec({ list: { stdout: THEME_LIST }, pull: copyFixtureOnPull, check: okCheck, push: { stdout: '{"theme":{"id":202}}' } });
    const { run, changes } = await plannedRun(dataDir, exec);
    const canonical = changes.find((c) => c.payload.block === 'canonical');
    const previewed = await T.preview(canonical, themeCtx(dataDir, run, exec));
    const applied = await T.apply(A.transition(previewed.change, 'confirmed'), themeCtx(dataDir, run, exec));
    assert.equal(applied.change.status, 'applied');

    let asked = null;
    const fetchImpl = async (url) => { asked = url; return rawHtml(PREVIEWED_HTML('https://' + STORE + '/products/wool-runner'), { url }); };
    const out = await T.verify(applied.change, themeCtx(dataDir, run, exec, { fetchImpl }));
    assert.equal(out.ok, true);
    assert.equal(out.change.status, 'verified');
    assert.match(asked, /preview_theme_id=202/);
    assert.match(asked, /\/collections\/trail\/products\/wool-runner/);
  } finally { cleanup(); }
});

test('a stale CDN answer is pending_cache, never a pass', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const exec = mockExec({ list: { stdout: THEME_LIST }, pull: copyFixtureOnPull, check: okCheck, push: { stdout: '{"theme":{"id":202}}' } });
    const { run, changes } = await plannedRun(dataDir, exec);
    const canonical = changes.find((c) => c.payload.block === 'canonical');
    const previewed = await T.preview(canonical, themeCtx(dataDir, run, exec));
    const applied = await T.apply(A.transition(previewed.change, 'confirmed'), themeCtx(dataDir, run, exec));

    const stale = 'https://' + STORE + '/collections/trail/products/wool-runner';
    const fetchImpl = async (url) => rawHtml(PREVIEWED_HTML(stale), { url });
    const out = await T.verify(applied.change, themeCtx(dataDir, run, exec, { fetchImpl }));
    assert.equal(out.ok, null, 'not a pass');
    assert.equal(out.change.status, 'pending_cache');
    assert.match(out.note, /has not caught up|does not serve it yet/);
  } finally { cleanup(); }
});

test('the robots assertion checks the tag-combination rule, not a marker comment', () => {
  const change = { payload: { block: 'robots' }, target: {} };
  const kept = S_parseRobotsFor('User-agent: *\nDisallow: /collections/*+*\n');
  assert.equal(T.assertBlock(change, { robots: kept }).ok, true);
  const dropped = S_parseRobotsFor('User-agent: *\nAllow: /\n');
  assert.equal(T.assertBlock(change, { robots: dropped }).ok, false);
  assert.equal(T.assertBlock(change, { robots: null }).ok, null, 'unparseable robots is unknown, never a pass');
  assert.equal(T.assertBlock({ payload: { block: 'llms' }, target: {} }, {}).ok, null);

  // A literal custom rule is asserted too; a wildcard one is named as not asserted, not as a pass.
  const withCustom = { payload: { block: 'robots', rules: ['Disallow: /internal', 'Disallow: /tmp/*'] }, target: {} };
  const partial = T.assertBlock(withCustom, { robots: kept });
  assert.equal(partial.ok, false);
  assert.match(partial.detail, /still crawlable: \/internal/);
  const both = S_parseRobotsFor('User-agent: *\nDisallow: /collections/*+*\nDisallow: /internal\n');
  const full = T.assertBlock(withCustom, { robots: both });
  assert.equal(full.ok, true);
  assert.match(full.detail, /1 rule\(s\) \(wildcards, Allow, Crawl-delay\) were not asserted automatically/);

  // An added Sitemap: line is asserted against what the served file declares, not just counted.
  const withSitemap = { payload: { block: 'robots', robots_kind: 'additive', rules: ['Sitemap: https://x.test/sitemap.xml'] }, target: {} };
  const missing = T.assertBlock(withSitemap, { robots: kept });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /does not declare https:\/\/x\.test\/sitemap\.xml/);
  const declared = S_parseRobotsFor('User-agent: *\nDisallow: /collections/*+*\nSitemap: https://x.test/sitemap.xml\n');
  const served = T.assertBlock(withSitemap, { robots: declared });
  assert.equal(served.ok, true);
  assert.match(served.detail, /declares https:\/\/x\.test\/sitemap\.xml/);
  assert.ok(!served.detail.includes('not asserted automatically'), 'a Sitemap line is asserted, not written off as a wildcard');

  // A hand edit has no marked block and no rule this module can name: unknown, never a pass.
  const manual = T.assertBlock({ payload: { block: 'robots', robots_kind: 'edit-existing' }, target: {} }, { robots: kept });
  assert.equal(manual.ok, null);
  assert.match(manual.detail, /hand edit/);
});

// parseRobots lives in lib/robots; the test needs it to build the two cases above.
const { parseRobots: S_parseRobotsFor } = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'robots.mjs')).href);
const { parseDocument } = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'html.mjs')).href);

test('the social and JSON-LD assertions look at the rendered output, not the Liquid source', () => {
  assert.deepEqual(T.metaNamesIn('<meta property="og:image" content="{{ page_image | image_url }}">\n<meta name="twitter:card" content="summary">'), ['og:image', 'twitter:card']);
  assert.deepEqual(T.metaNamesIn('<meta name="viewport" content="x">'), [], 'only social tags count');
  assert.deepEqual(T.jsonLdTypesIn('{"@context":"https://schema.org","@type":"Organization"}'), ['Organization']);

  const social = { payload: { block: 'social', snippet: '<meta property="og:image" content="{{ page_image | image_url }}">' }, target: {} };
  const served = parseDocument('<html><head><meta property="og:image" content="https://cdn.test/i.jpg"></head><body></body></html>', 'https://x.test/');
  assert.equal(T.assertBlock(social, { snapshot: { parsed: served } }).ok, true, 'the Liquid never appears verbatim, the tag does');
  const empty = parseDocument('<html><head><meta property="og:image" content=""></head><body></body></html>', 'https://x.test/');
  assert.equal(T.assertBlock(social, { snapshot: { parsed: empty } }).ok, false, 'a tag with no value is not a pass');

  const jsonld = { payload: { block: 'structured-data', snippet: '{"@type":"Organization","name":"Ridgeline"}' }, target: {} };
  const withOrg = parseDocument('<html><head><script type="application/ld+json">{"@type":"Organization","name":"R"}</script></head><body></body></html>', 'https://x.test/');
  assert.equal(T.assertBlock(jsonld, { snapshot: { parsed: withOrg } }).ok, true);
  const withProduct = parseDocument('<html><head><script type="application/ld+json">{"@type":"Product"}</script></head><body></body></html>', 'https://x.test/');
  assert.equal(T.assertBlock(jsonld, { snapshot: { parsed: withProduct } }).ok, false);
  assert.equal(T.assertBlock(jsonld, { snapshot: { parsed: parseDocument('<html><head></head><body></body></html>', 'https://x.test/') } }).ok, false);
});

test('rollback restores the pulled file, and rollback --all deletes only themes this run created', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const exec = mockExec({ list: { stdout: THEME_LIST }, pull: copyFixtureOnPull, check: okCheck, push: { stdout: '{"theme":{"id":202}}' }, delete: { code: 0 } });
    const { run, changes } = await plannedRun(dataDir, exec);
    const canonical = changes.find((c) => c.payload.block === 'canonical');
    const previewed = await T.preview(canonical, themeCtx(dataDir, run, exec));
    const applied = await T.apply(A.transition(previewed.change, 'confirmed'), themeCtx(dataDir, run, exec));

    const work = T.workDirFor(dataDir, STORE, '101');
    assert.match(readFileSync(join(work, 'layout', 'theme.liquid'), 'utf8'), /claude-seo-ai:canonical/);
    const back = await T.rollback(applied.change, themeCtx(dataDir, run, exec));
    assert.equal(back.ok, true);
    assert.equal(back.change.status, 'rolled_back');
    assert.ok(!readFileSync(join(work, 'layout', 'theme.liquid'), 'utf8').includes('claude-seo-ai'));

    const all = await T.rollbackAll(themeCtx(dataDir, run, exec));
    assert.equal(all.ok, true);
    const deletes = exec.forSub('delete');
    assert.equal(deletes.length, 1);
    assert.deepEqual(deletes[0].argv, ['shopify', 'theme', 'delete', '--theme', '202', '--force']);
  } finally { cleanup(); }
});

test('rollback --all with nothing to undo says so instead of touching the store', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const exec = mockExec({});
    const run = A.openFixRun(dataDir, {});
    const out = await T.rollbackAll(themeCtx(dataDir, run, exec));
    assert.equal(out.ok, true);
    assert.equal(out.results.length, 0);
    assert.equal(exec.calls.length, 0);
    assert.match(out.note, /nothing to undo/);
  } finally { cleanup(); }
});

test('publish records the previous live theme first and refuses when it cannot', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const exec = mockExec({ list: { stdout: THEME_LIST }, publish: { code: 0 } });
    const run = A.openFixRun(dataDir, {});
    run.updateManifest((m) => { m.shopify = { store: STORE, staging_theme_id: '202' }; return m; });

    const out = await T.publish(themeCtx(dataDir, run, exec));
    assert.equal(out.ok, true);
    assert.equal(out.previous_live_id, '101');
    assert.deepEqual(exec.forSub('publish')[0].argv, ['shopify', 'theme', 'publish', '--theme', '202', '--force']);
    assert.equal(run.readManifest().shopify.published.previous_live_id, '101');

    // With no theme list there is no way back, so it refuses rather than publish blind.
    const blind = mockExec({ list: { code: 1, stdout: 'error' } });
    const run2 = A.openFixRun(dataDir, { id: 'blind' });
    run2.updateManifest((m) => { m.shopify = { store: STORE, staging_theme_id: '202' }; return m; });
    const refused = await T.publish(themeCtx(dataDir, run2, blind));
    assert.equal(refused.ok, false);
    assert.match(refused.error, /refusing to publish/);
    assert.equal(blind.forSub('publish').length, 0);
  } finally { cleanup(); }
});

test('publish with nothing staged is an error, not a no-op that looks like success', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const exec = mockExec({ list: { stdout: THEME_LIST } });
    const run = A.openFixRun(dataDir, {});
    const out = await T.publish(themeCtx(dataDir, run, exec));
    assert.equal(out.ok, false);
    assert.match(out.error, /has not pushed a staging theme/);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// shopify-theme: the CLI ticket gate

test('apply and publish refuse to run without a valid confirmation ticket', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const run = A.openFixRun(dataDir, {});
    const planned = await T.plan({ report: themeReport, store: STORE }, { run, dataDir, env: themeEnv() });
    run.setChanges(planned.changes);
    const id = planned.changes[0].id;

    const noTicket = await T.main({ _: ['apply'], run: run.dir, data: dataDir, change: id });
    assert.match(noTicket.result.results[0].error, /confirmation ticket \(no-ticket\)/);

    // A ticket bound to a different change does not unlock this one.
    const wrong = A.issueTicket(dataDir, { command: 'apply other', run: run.id, change: 'chg_000000000000' });
    const mismatched = await T.main({ _: ['apply'], run: run.dir, data: dataDir, change: id, ticket: wrong.id });
    assert.match(mismatched.result.results[0].error, /wrong-change/);

    // The right ticket gets past the gate; the run then stops for the missing credentials instead.
    const right = A.issueTicket(dataDir, { command: 'apply this', run: run.id, change: id });
    const allowed = await T.main({ _: ['apply'], run: run.dir, data: dataDir, change: id, ticket: right.id });
    const first = allowed.result.results[0];
    assert.ok(!String(first.error || '').includes('ticket'), 'the ticket was accepted');
    assert.equal(first.status, 'skipped_unready');

    const publishNoTicket = await T.main({ _: ['publish'], run: run.dir, data: dataDir });
    assert.equal(publishNoTicket.code, 1);
    assert.match(publishNoTicket.result.error, /its own confirmation ticket/);
  } finally { cleanup(); }
});

test('capabilities reports the CLI, the credentials, the theme slots and the reusable staging theme', async () => {
  const { base, dataDir, cleanup } = sandbox();
  try {
    const bin = join(base, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'shopify'), '#!/bin/sh\n');
    const env = themeEnv({ PATH: bin });

    const exec = mockExec({ version: { stdout: 'Shopify CLI 3.99.0' }, list: { stdout: THEME_LIST } });
    const out = await T.capabilities({ dataDir, env, execImpl: exec, store: STORE });
    assert.equal(out.ready, true);
    assert.deepEqual(out.needs, []);
    assert.equal(out.tools.shopify.on_path, true);
    assert.equal(out.tools.shopify.version, 'Shopify CLI 3.99.0');
    assert.equal(out.slots.used, 2);
    assert.equal(out.slots.limit_documented, 20);
    assert.equal(out.slots.remaining_if_limit_is_20, 18);
    assert.match(out.slots.note, /cannot read/);
    assert.equal(out.staging_theme, null);
    assert.match(out.notes.join('\n'), /live theme: "Ridgeline live"/);
    assert.equal(JSON.stringify(out).includes(THEME_TOKEN), false);

    // A full store with no staging theme to reuse is called out before a push is attempted.
    const full = JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ id: String(i + 1), name: 'theme ' + i, role: i === 0 ? 'main' : 'unpublished' })));
    const crowded = await T.capabilities({ dataDir, env, execImpl: mockExec({ version: { stdout: 'x' }, list: { stdout: full } }), store: STORE });
    assert.match(crowded.notes.join('\n'), /already has 20 themes/);

    // Missing credentials are named, and the theme list is not even attempted.
    const noToken = mockExec({ version: { stdout: 'x' }, list: { stdout: THEME_LIST } });
    const bare = await T.capabilities({ dataDir, env: { PATH: bin, SHOPIFY_STORE: STORE }, execImpl: noToken, store: STORE });
    assert.equal(bare.ready, false);
    assert.deepEqual(bare.needs, ['SHOPIFY_THEME_TOKEN']);
    assert.equal(noToken.forSub('list').length, 0);
  } finally { cleanup(); }
});

test('the theme plan CLI writes the plan and the previews into the run directory', async () => {
  const { base, dataDir, cleanup } = sandbox();
  try {
    const reportPath = join(base, 'report.json');
    writeFileSync(reportPath, JSON.stringify(themeReport));
    const out = await T.main({ _: ['plan'], report: reportPath, data: dataDir, store: STORE });
    assert.equal(out.code, 0);
    assert.ok(out.result.changes.length > 0);
    const runDir = out.result.run_dir;
    const plan = JSON.parse(readFileSync(join(runDir, 'plan.json'), 'utf8'));
    assert.equal(plan.changes.length, out.result.changes.length);
    assert.ok(plan.changes.every((c) => c.adapter === 'shopify-theme'));
    assert.ok(existsSync(join(runDir, 'preview', plan.changes[0].id + '.txt')));
    const log = readFileSync(join(runDir, 'log.ndjson'), 'utf8');
    assert.match(log, /"event":"plan"/);
    assert.equal(log.includes(THEME_TOKEN), false);
  } finally { cleanup(); }
});

test('the CLI rejects an unknown op and a plan without a report', async () => {
  const bad = await T.main({ _: ['frobnicate'] });
  assert.equal(bad.code, 1);
  assert.match(bad.result.error, /usage: shopify-theme/);
  const noReport = await T.main({ _: ['plan'] });
  assert.equal(noReport.code, 1);
  assert.match(noReport.result.error, /--report/);
});

// ---------------------------------------------------------------------------
// shopify-admin: reading a report

test('resourceFromUrl recognises the storefront URL shapes', () => {
  assert.deepEqual(S.resourceFromUrl('https://' + STORE + '/products/wool-runner'), { kind: 'product', handle: 'wool-runner' });
  assert.deepEqual(S.resourceFromUrl('https://' + STORE + '/collections/trail/products/wool-runner'), { kind: 'product', handle: 'wool-runner' });
  assert.deepEqual(S.resourceFromUrl('https://' + STORE + '/collections/trail-shoes'), { kind: 'collection', handle: 'trail-shoes' });
  assert.deepEqual(S.resourceFromUrl('https://' + STORE + '/pages/about'), { kind: 'page', handle: 'about' });
  assert.deepEqual(S.resourceFromUrl('https://' + STORE + '/blogs/journal/wet-granite'), { kind: 'article', handle: 'wet-granite' });
  assert.equal(S.resourceFromUrl('https://' + STORE + '/collections/all'), null);
  assert.equal(S.resourceFromUrl('https://' + STORE + '/'), null);
  assert.equal(S.resourceFromUrl('not a url at all'), null);
});

test('seoFieldsFor takes the text from the finding, and only the field the id names', () => {
  const P = (s) => ({ kind: 'snippet', snippet: s, updates: null });
  assert.deepEqual(S.seoFieldsFor({ id: 'M7.title.missing' }, P('Wool Runner | Ridgeline')), { title: 'Wool Runner | Ridgeline' });
  assert.deepEqual(S.seoFieldsFor({ id: 'M7.description.length_out_of_band' }, P('A merino upper.')), { description: 'A merino upper.' });
  assert.deepEqual(S.seoFieldsFor({ id: 'M7.shopify.description_is_body_fallback' }, P('Written by hand.')), { description: 'Written by hand.' });
  assert.deepEqual(
    S.seoFieldsFor({ id: 'M7.title.missing' }, { kind: 'fields', snippet: '', updates: { title: 'A', description: 'B' } }),
    { title: 'A', description: 'B' },
  );
  assert.equal(S.seoFieldsFor({ id: 'M9.alt.missing' }, P('alt text')), null, 'an unrelated id yields no SEO field');
  assert.equal(S.seoFieldsFor({ id: 'M7.title.missing' }, P('')), null);
});

test('redirectPairFrom parses the pair it was given and refuses to guess one', () => {
  assert.deepEqual(S.redirectPairFrom('/products/old -> /products/new'), { path: '/products/old', target: '/products/new' });
  assert.deepEqual(S.redirectPairFrom('/a => /b'), { path: '/a', target: '/b' });
  assert.deepEqual(S.redirectPairFrom('from: /a\nto: /b'), { path: '/a', target: '/b' });
  assert.deepEqual(S.redirectPairFrom('/a -> https://' + STORE + '/b?x=1'), { path: '/a', target: '/b?x=1' });
  assert.equal(S.redirectPairFrom('this URL 404s, please redirect it somewhere sensible'), null);
  assert.equal(S.redirectPairFrom(''), null);
  assert.equal(S.redirectPairFrom('old -> new'), null, 'both sides have to be real paths');
});

test('hiddenDirective only fires on an explicit request from the user', () => {
  for (const yes of ['hidden', 'seo.hidden', 'seo.hidden = 1', 'hidden: true', ' HIDDEN ']) assert.equal(S.hiddenDirective(yes), true, yes);
  for (const no of ['', 'hide it from Google please', 'hidden = 0 maybe', 'noindex']) assert.equal(S.hiddenDirective(no), false, no);
});

test('the endpoint is pinned to one API version', () => {
  const snap = snapshot('endpoint.json');
  assert.equal(S.API_VERSION, snap.api_version);
  assert.equal(S.adminEndpoint(STORE), snap.endpoint);
  assert.match(S.adminEndpoint(STORE), /\/admin\/api\/\d{4}-\d{2}\/graphql\.json$/);
  assert.equal(S.adminEndpoint(''), null);
});

// ---------------------------------------------------------------------------
// shopify-admin: capabilities

test('capabilities compares the token scopes with what each write needs', async () => {
  const fetchImpl = mockFetch(graphqlRouter({
    currentAppInstallation: { data: { currentAppInstallation: { accessScopes: [{ handle: 'read_products' }, { handle: 'write_products' }] } } },
  }));
  const out = await S.capabilities({ env: adminEnv(), fetchImpl, store: STORE });
  assert.equal(out.api_version, S.API_VERSION);
  assert.deepEqual(out.scopes.granted, ['read_products', 'write_products']);
  assert.deepEqual(out.scopes.missing, ['write_online_store_navigation']);
  assert.equal(out.ready, false, 'a redirect write is not available with this token');
  assert.match(out.notes.join('\n'), /redirect needs write_online_store_navigation/);
  assert.match(out.notes.join('\n'), /page-seo is not offered/);
  assert.match(out.notes.join('\n'), /UNVERIFIED/);
  assert.equal(JSON.stringify(out).includes(ADMIN_TOKEN), false, 'the token never appears in the result');

  const query = fetchImpl.calls[0].body.query;
  assert.equal(query, snapshot('access-scopes.query.json').query);
  assert.equal(fetchImpl.calls[0].headers['x-shopify-access-token'], ADMIN_TOKEN);
});

test('capabilities without a token says what is missing instead of calling the API', async () => {
  const fetchImpl = mockFetch(() => ({ data: {} }));
  const out = await S.capabilities({ env: { SHOPIFY_STORE: STORE }, fetchImpl });
  assert.equal(out.ready, false);
  assert.deepEqual(out.needs, ['SHOPIFY_ADMIN_TOKEN']);
  assert.equal(out.scopes.granted, null);
  assert.equal(fetchImpl.calls.length, 0);
});

// ---------------------------------------------------------------------------
// shopify-admin: plan

const PRODUCT_NODE = {
  id: PRODUCT_GID, handle: 'wool-runner', title: 'Wool Runner',
  onlineStoreUrl: 'https://' + STORE + '/products/wool-runner',
  seo: { title: null, description: null }, metafield: null,
};
const COLLECTION_NODE = {
  id: COLLECTION_GID, handle: 'trail-shoes', title: 'Trail shoes',
  onlineStoreUrl: 'https://' + STORE + '/collections/trail-shoes',
  seo: { title: null, description: 'old description' }, metafield: null,
};

const NEW_TITLE = 'Wool Runner — breathable everyday shoe | Ridgeline';
const NEW_COLLECTION_TITLE = 'Trail shoes built for wet granite | Ridgeline';

const adminFindings = [
  {
    id: 'M7.title.missing', module: 'M7', title: 'Page title missing', status: 'fail', severity: 4, scope: 'page', fixable: 'proposed',
    location: { url: 'https://' + STORE + '/products/wool-runner' }, fix_preview: NEW_TITLE,
  },
  {
    id: 'M7.title.length_out_of_band', module: 'M7', title: 'Title too short', status: 'warn', severity: 2, scope: 'page', fixable: 'proposed',
    location: { url: 'https://' + STORE + '/collections/trail-shoes' }, fix_preview: NEW_COLLECTION_TITLE,
  },
  {
    id: 'M2.redirect.chain', module: 'M2', title: 'Redirect chain', status: 'fail', severity: 3, scope: 'page', fixable: 'proposed',
    location: { url: 'https://' + STORE + '/products/wool-runner' },
  },
  {
    id: 'M7.title.missing', module: 'M7', title: 'Page title missing', status: 'fail', severity: 4, scope: 'page', fixable: 'proposed',
    location: { url: 'https://' + STORE + '/pages/about' }, fix_preview: 'About Ridgeline',
  },
];

function adminRouter({ product = PRODUCT_NODE, collection = COLLECTION_NODE, redirect = null, mutations = {} } = {}) {
  return graphqlRouter({
    currentAppInstallation: { data: { currentAppInstallation: { accessScopes: [{ handle: 'write_products' }, { handle: 'write_online_store_navigation' }] } } },
    productByIdentifier: { data: { productByIdentifier: product } },
    productByHandle: { data: { productByHandle: product } },
    collectionByHandle: { data: { collectionByHandle: collection } },
    urlRedirects: { data: { urlRedirects: { edges: redirect ? [{ node: redirect }] : [] } } },
    productUpdate: mutations.productUpdate || { data: { productUpdate: { product: { id: PRODUCT_GID, handle: 'wool-runner', seo: { title: NEW_TITLE, description: null } }, userErrors: [] } } },
    collectionUpdate: mutations.collectionUpdate || { data: { collectionUpdate: { collection: { id: COLLECTION_GID, handle: 'trail-shoes', seo: { title: NEW_COLLECTION_TITLE, description: 'old description' } }, userErrors: [] } } },
    metafieldsSet: mutations.metafieldsSet || { data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/1', namespace: 'seo', key: 'hidden', type: 'number_integer', value: '1' }], userErrors: [] } } },
    metafieldsDelete: mutations.metafieldsDelete || { data: { metafieldsDelete: { deletedMetafields: [{ key: 'hidden', namespace: 'seo', ownerId: PRODUCT_GID }], userErrors: [] } } },
    urlRedirectCreate: mutations.urlRedirectCreate || { data: { urlRedirectCreate: { urlRedirect: { id: 'gid://shopify/UrlRedirect/55', path: '/products/old-handle', target: '/products/wool-runner' }, userErrors: [] } } },
    urlRedirectDelete: mutations.urlRedirectDelete || { data: { urlRedirectDelete: { deletedUrlRedirectId: 'gid://shopify/UrlRedirect/55', userErrors: [] } } },
  });
}

// Every Admin write is `proposed` (the API has no staging surface), so the fix flow reaches these
// with --include-proposed. The helper passes the flag; the test below covers what happens without it.
async function adminPlan(dataDir, fetchImpl, { answers = {}, findings = adminFindings, includeProposed = true } = {}) {
  const run = A.openFixRun(dataDir, {});
  const report = { target: { kind: 'url', value: 'https://' + STORE + '/' }, findings };
  const out = await S.plan({ report, store: STORE, answers, includeProposed }, { run, dataDir, env: adminEnv(), fetchImpl });
  run.setChanges(out.changes);
  return { run, out };
}

test('the Admin adapter honours --include-proposed instead of assuming it', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const fetchImpl = mockFetch(adminRouter());
    const { out } = await adminPlan(dataDir, fetchImpl, { includeProposed: false });
    assert.deepEqual(out.changes, [], 'without the flag a proposed finding is not planned');
    const note = out.notes.join(' ');
    assert.match(note, /--include-proposed/, 'the drop is named, never silent');
    assert.match(note, /M7\.title\.missing/, 'the withheld findings are listed by id');
  } finally { cleanup(); }
});

test('plan builds the mutations the snapshots record, with the values from the report', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const fetchImpl = mockFetch(adminRouter());
    const { out } = await adminPlan(dataDir, fetchImpl, { answers: { 'M2.redirect.chain': '/products/old-handle -> /products/wool-runner' } });

    const product = out.changes.find((c) => c.payload.mutation === 'productUpdate');
    const productSnap = snapshot('product-seo-update.mutation.json');
    assert.equal(product.payload.document, productSnap.query);
    assert.deepEqual(product.payload.variables, { input: { id: PRODUCT_GID, seo: { title: NEW_TITLE } } });
    assert.equal(product.class, 'proposed', 'an Admin write is never auto');
    assert.equal(product.live_impact, 'live');
    assert.deepEqual(product.requires.scopes, ['write_products']);
    assert.equal(product.target.kind, 'resource');
    assert.equal(product.target.locator, 'product:wool-runner');
    assert.equal(product.rollback.kind, 'restore-fields');
    assert.deepEqual(A.validateChange(product, { phase: 'preview' }), []);
    assert.match(product.preview.body, /This write is LIVE/);
    assert.match(product.preview.body, new RegExp(NEW_TITLE.replace(/[|]/g, '\\|')));
    assert.match(product.preview.body, /"title": null/, 'the current value is shown next to the new one');

    const collection = out.changes.find((c) => c.payload.mutation === 'collectionUpdate');
    assert.equal(collection.payload.document, snapshot('collection-seo-update.mutation.json').query);
    assert.deepEqual(collection.payload.variables, { input: { id: COLLECTION_GID, seo: { title: NEW_COLLECTION_TITLE } } });

    const redirect = out.changes.find((c) => c.payload.mutation === 'urlRedirectCreate');
    const redirectSnap = snapshot('url-redirect.mutation.json');
    assert.equal(redirect.payload.document, redirectSnap.query);
    assert.deepEqual(redirect.payload.variables, redirectSnap.variables);
    assert.equal(redirect.target.kind, 'redirect');
    assert.equal(redirect.op, 'create-redirect');
    assert.deepEqual(redirect.requires.scopes, ['write_online_store_navigation']);
    assert.equal(redirect.rollback.kind, 'delete-redirect');

    // The idempotency read ran before the redirect was planned.
    const idem = fetchImpl.calls.find((c) => c.body.query.includes('urlRedirects('));
    assert.equal(idem.body.query, redirectSnap.idempotency.query);
    assert.deepEqual(idem.body.variables, redirectSnap.idempotency.variables);

    // A page is not written: its scopes are unverified.
    const page = out.skipped.find((s) => /UNVERIFIED/.test(s.reason));
    assert.ok(page, 'the /pages/ finding is skipped with the reason spelled out');
    assert.ok(!out.changes.some((c) => JSON.stringify(c).includes('About Ridgeline')));
    assert.match(out.notes.join('\n'), /pageUpdate/);
  } finally { cleanup(); }
});

test('plan resolves a handle with productByIdentifier and falls back to productByHandle', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const route = adminRouter();
    const fetchImpl = mockFetch((body) => {
      if (String(body.query).includes('productByIdentifier(')) return { errors: [{ message: "Field 'productByIdentifier' doesn't exist on type 'QueryRoot'" }] };
      return route(body);
    });
    const { out } = await adminPlan(dataDir, fetchImpl, { findings: [adminFindings[0]] });
    const product = out.changes[0];
    assert.equal(product.payload.resolved_by, 'productByHandle');
    assert.equal(fetchImpl.calls[0].body.query, snapshot('product-resolve.query.json').query);
    assert.deepEqual(fetchImpl.calls[0].body.variables, snapshot('product-resolve.query.json').variables);
    assert.equal(fetchImpl.calls[1].body.query, snapshot('product-resolve.query.json').fallback.query);
    assert.deepEqual(fetchImpl.calls[1].body.variables, snapshot('product-resolve.query.json').fallback.variables);
    assert.match(product.preview.body, /productByHandle fallback/);
  } finally { cleanup(); }
});

test('plan writes nothing when the resource already has the target values', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const already = { ...PRODUCT_NODE, seo: { title: NEW_TITLE, description: null } };
    const fetchImpl = mockFetch(adminRouter({ product: already }));
    const { out } = await adminPlan(dataDir, fetchImpl, { findings: [adminFindings[0]] });
    assert.equal(out.changes.length, 0);
    assert.equal(out.skipped[0].status, 'skipped_idempotent');
    assert.match(out.skipped[0].reason, /already has these SEO values/);
  } finally { cleanup(); }
});

test('plan refuses to invent a title, a description or a redirect target', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const fetchImpl = mockFetch(adminRouter());
    const bare = [
      { ...adminFindings[0], fix_preview: undefined },
      { ...adminFindings[2] },
    ];
    const { out } = await adminPlan(dataDir, fetchImpl, { findings: bare });
    assert.equal(out.changes.length, 0);
    assert.match(out.skipped.map((s) => s.reason).join('\n'), /never writes a title or description it made up/);
    assert.match(out.skipped.map((s) => s.reason).join('\n'), /never guessed/);
  } finally { cleanup(); }
});

test('plan will not overwrite a redirect somebody else made, and skips one that already matches', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const answers = { 'M2.redirect.chain': '/products/old-handle -> /products/wool-runner' };
    const same = mockFetch(adminRouter({ redirect: { id: 'gid://shopify/UrlRedirect/1', path: '/products/old-handle', target: '/products/wool-runner' } }));
    const a = await adminPlan(dataDir, same, { answers, findings: [adminFindings[2]] });
    assert.equal(a.out.changes.length, 0);
    assert.equal(a.out.skipped[0].status, 'skipped_idempotent');

    const other = mockFetch(adminRouter({ redirect: { id: 'gid://shopify/UrlRedirect/2', path: '/products/old-handle', target: '/somewhere-else' } }));
    const b = await adminPlan(dataDir, other, { answers, findings: [adminFindings[2]] });
    assert.equal(b.out.changes.length, 0);
    assert.match(b.out.skipped[0].reason, /already redirects to \/somewhere-else/);
  } finally { cleanup(); }
});

test('seo.hidden is planned only when the user asks for it, with the metafieldsSet payload', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const fetchImpl = mockFetch(adminRouter());
    const { out } = await adminPlan(dataDir, fetchImpl, {
      answers: { 'M7.title.missing': 'hidden' },
      findings: [{ ...adminFindings[0], fix_preview: undefined }],
    });
    const change = out.changes[0];
    const snap = snapshot('seo-hidden.mutation.json');
    assert.equal(change.payload.mutation, 'metafieldsSet');
    assert.equal(change.payload.document, snap.query);
    assert.deepEqual(change.payload.variables, snap.variables);
    assert.equal(change.target.locator, 'product:wool-runner#seo.hidden');
    assert.match(change.preview.body, /Unlisted product status/);
    assert.match(change.preview.body, /sitemap/);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// shopify-admin: preview / apply / verify / rollback

test('apply re-reads first, runs the mutation and records what it replaced', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const snap = snapshot('product-seo-update.mutation.json');
    // `title: …` / `description: …` in a fix_preview writes both fields — the snapshot's payload.
    const bothFields = { ...adminFindings[0], fix_preview: 'title: ' + snap.variables.input.seo.title + '\ndescription: ' + snap.variables.input.seo.description };
    const fetchImpl = mockFetch(adminRouter());
    const { run, out } = await adminPlan(dataDir, fetchImpl, { findings: [bothFields] });
    const change = A.transition(out.changes[0], 'confirmed');
    const applied = await S.apply(change, { run, dataDir, env: adminEnv(), fetchImpl, store: STORE });
    assert.equal(applied.ok, true);
    assert.equal(applied.change.status, 'applied');

    const mutation = fetchImpl.calls.find((c) => c.body.query.includes('productUpdate('));
    assert.deepEqual(mutation.body.variables, snapshot('product-seo-update.mutation.json').variables);
    assert.equal(mutation.headers['x-shopify-access-token'], ADMIN_TOKEN);
    assert.match(mutation.url, /\/admin\/api\/\d{4}-\d{2}\/graphql\.json$/);

    const after = JSON.parse(readFileSync(run.afterPath(change.id), 'utf8'));
    assert.equal(after.mutation, 'productUpdate');
    assert.equal(after.api_version, S.API_VERSION);
    assert.equal(JSON.stringify(after).includes(ADMIN_TOKEN), false);
  } finally { cleanup(); }
});

test('userErrors from a mutation fail the change instead of being swallowed', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const fetchImpl = mockFetch(adminRouter({
      mutations: { productUpdate: { data: { productUpdate: { product: null, userErrors: [{ field: ['input', 'seo', 'title'], message: 'Title is too long' }] } } } },
    }));
    const { run, out } = await adminPlan(dataDir, fetchImpl, { findings: [adminFindings[0]] });
    const applied = await S.apply(A.transition(out.changes[0], 'confirmed'), { run, dataDir, env: adminEnv(), fetchImpl, store: STORE });
    assert.equal(applied.ok, false);
    assert.equal(applied.change.status, 'failed');
    assert.match(applied.change.error, /input\.seo\.title: Title is too long/);
  } finally { cleanup(); }
});

test('apply is a no-op when the live values already match, even after a plan', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    let node = PRODUCT_NODE;
    const fetchImpl = mockFetch((body) => adminRouter({ product: node })(body));
    const { run, out } = await adminPlan(dataDir, fetchImpl, { findings: [adminFindings[0]] });
    node = { ...PRODUCT_NODE, seo: { title: NEW_TITLE, description: null } }; // somebody set it in the Admin meanwhile
    const applied = await S.apply(A.transition(out.changes[0], 'confirmed'), { run, dataDir, env: adminEnv(), fetchImpl, store: STORE });
    assert.equal(applied.change.status, 'skipped_idempotent');
    assert.equal(fetchImpl.calls.some((c) => c.body.query.includes('productUpdate(')), false, 'no mutation was sent');
  } finally { cleanup(); }
});

test('preview shows the live values and flags drift since the plan', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    let node = PRODUCT_NODE;
    const fetchImpl = mockFetch((body) => adminRouter({ product: node })(body));
    const { run, out } = await adminPlan(dataDir, fetchImpl, { findings: [adminFindings[0]] });
    node = { ...PRODUCT_NODE, seo: { title: 'Someone else edited this', description: null } };
    const res = await S.preview(out.changes[0], { run, dataDir, env: adminEnv(), fetchImpl, store: STORE });
    assert.equal(res.ok, true);
    assert.equal(res.change.status, 'previewed');
    assert.equal(res.drifted, true);
    assert.match(res.body, /HEADS UP/);
    assert.match(res.body, /Someone else edited this/);
  } finally { cleanup(); }
});

test('a preview whose live read failed never shows the plan-time values as if read', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const fetchImpl = mockFetch(adminRouter());
    const { run, out } = await adminPlan(dataDir, fetchImpl, { findings: [adminFindings[0]] });
    const change = out.changes[0];
    assert.match(change.preview.body, /^Current values:/m, 'the planned body claims a fresh read');

    // The Admin API is unreachable now, so there is no "current" anything to show.
    const broken = async () => { throw new Error('ECONNREFUSED shop.myshopify.com'); };
    const res = await S.preview(change, { run, dataDir, env: adminEnv(), fetchImpl: broken, store: STORE });

    assert.equal(res.ok, null, 'an unread state is unknown, never an ok preview');
    assert.equal(res.live, null);
    assert.match(res.read_error, /ECONNREFUSED/);
    assert.match(res.warning, /could not be read/);
    assert.ok(!/^Current values:/m.test(res.body), 'the stale block must not keep the heading of a fresh read');
    assert.match(res.body, /Current values AT PLAN TIME/);
    assert.match(res.body, /could not be re-read/);
    assert.match(res.body, /do not confirm the write/);

    // The CLI row carries the warning too, not just the module return.
    const saved = { ...process.env };
    try {
      Object.assign(process.env, adminEnv(), { CLAUDE_SEO_AI_OFFLINE: '1' });
      const cli = await S.main({ _: ['preview'], run: run.dir, data: dataDir });
      const row = cli.result.results[0];
      assert.ok(row.error || row.warning, 'a preview that could not read says so: ' + JSON.stringify(row));
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  } finally { cleanup(); }
});

test('verify waits for the storefront: the API alone is pending_cache, not verified', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    let node = PRODUCT_NODE;
    const written = { ...PRODUCT_NODE, seo: { title: NEW_TITLE, description: null } };
    const gql = (body) => adminRouter({ product: node })(body);
    let html = '<!doctype html><html><head><meta charset="utf-8"><title>Old title</title></head><body></body></html>';
    const fetchImpl = async (url, init) => {
      if (init && init.body) return mockFetch(gql)(url, init);
      return rawHtml(html, { url });
    };
    const { run, out } = await adminPlan(dataDir, mockFetch(gql), { findings: [adminFindings[0]] });
    const applied = A.transition(A.transition(out.changes[0], 'confirmed'), 'applied');
    node = written;

    const stale = await S.verify(applied, { run, dataDir, env: adminEnv(), fetchImpl, store: STORE });
    assert.equal(stale.ok, null);
    assert.equal(stale.change.status, 'pending_cache');
    assert.match(stale.note, /has not caught up/);

    html = '<!doctype html><html><head><meta charset="utf-8"><title>' + NEW_TITLE + '</title></head><body></body></html>';
    const fresh = await S.verify(stale.change, { run, dataDir, env: adminEnv(), fetchImpl, store: STORE });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.change.status, 'verified');
  } finally { cleanup(); }
});

test('rollback restores the SEO fields it recorded and deletes the redirect it created', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const withOld = { ...PRODUCT_NODE, seo: { title: 'Old title', description: 'Old description' } };
    let node = withOld;
    const fetchImpl = mockFetch((body) => adminRouter({ product: node })(body));
    const { run, out } = await adminPlan(dataDir, fetchImpl, { findings: [adminFindings[0]] });
    const applied = await S.apply(A.transition(out.changes[0], 'confirmed'), { run, dataDir, env: adminEnv(), fetchImpl, store: STORE });
    node = { ...PRODUCT_NODE, seo: { title: NEW_TITLE, description: 'Old description' } };

    const back = await S.rollback(applied.change, { run, dataDir, env: adminEnv(), fetchImpl, store: STORE });
    assert.equal(back.ok, true);
    assert.equal(back.change.status, 'rolled_back');
    const restore = fetchImpl.calls.filter((c) => c.body.query.includes('productUpdate(')).pop();
    assert.deepEqual(restore.body.variables, { input: { id: PRODUCT_GID, seo: { title: 'Old title' } } });

    // The redirect path deletes by id.
    const redirectFetch = mockFetch(adminRouter());
    const r = await adminPlan(dataDir, redirectFetch, { answers: { 'M2.redirect.chain': '/products/old-handle -> /products/wool-runner' }, findings: [adminFindings[2]] });
    const redirectApplied = await S.apply(A.transition(r.out.changes[0], 'confirmed'), { run: r.run, dataDir, env: adminEnv(), fetchImpl: redirectFetch, store: STORE });
    assert.equal(redirectApplied.ok, true);
    const undone = await S.rollback(redirectApplied.change, { run: r.run, dataDir, env: adminEnv(), fetchImpl: redirectFetch, store: STORE });
    assert.equal(undone.ok, true);
    const del = redirectFetch.calls.filter((c) => c.body.query.includes('urlRedirectDelete(')).pop();
    assert.equal(del.body.query, snapshot('url-redirect.mutation.json').rollback.query);
    assert.deepEqual(del.body.variables, { id: 'gid://shopify/UrlRedirect/55' });
  } finally { cleanup(); }
});

test('rollback of seo.hidden deletes the metafield when there was none before', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const fetchImpl = mockFetch(adminRouter());
    const { run, out } = await adminPlan(dataDir, fetchImpl, {
      answers: { 'M7.title.missing': 'seo.hidden = 1' },
      findings: [{ ...adminFindings[0], fix_preview: undefined }],
    });
    const applied = await S.apply(A.transition(out.changes[0], 'confirmed'), { run, dataDir, env: adminEnv(), fetchImpl, store: STORE });
    assert.equal(applied.ok, true);
    const back = await S.rollback(applied.change, { run, dataDir, env: adminEnv(), fetchImpl, store: STORE });
    assert.equal(back.ok, true);
    const del = fetchImpl.calls.filter((c) => c.body.query.includes('metafieldsDelete(')).pop();
    assert.equal(del.body.query, snapshot('seo-hidden.mutation.json').rollback.query);
    assert.deepEqual(del.body.variables, snapshot('seo-hidden.mutation.json').rollback.variables);
  } finally { cleanup(); }
});

test('a live Admin write needs a confirmation ticket', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const fetchImpl = mockFetch(adminRouter());
    const { run, out } = await adminPlan(dataDir, fetchImpl, { findings: [adminFindings[0]] });
    const id = out.changes[0].id;
    const before = fetchImpl.calls.length;

    const denied = await S.main({ _: ['apply'], run: run.dir, data: dataDir, change: id });
    assert.match(denied.result.results[0].error, /writes live data and needs a valid confirmation ticket/);
    assert.equal(fetchImpl.calls.length, before, 'nothing was sent to the API');

    const wrongRun = A.issueTicket(dataDir, { command: 'apply elsewhere', run: 'some-other-run', change: id });
    const mismatched = await S.main({ _: ['apply'], run: run.dir, data: dataDir, change: id, ticket: wrongRun.id });
    assert.match(mismatched.result.results[0].error, /wrong-run/);
  } finally { cleanup(); }
});

test('the admin CLI rejects an unknown op and a missing report', async () => {
  const bad = await S.main({ _: ['publish'] });
  assert.equal(bad.code, 1);
  assert.match(bad.result.error, /usage: shopify-admin/);
  const noReport = await S.main({ _: ['plan'], report: '/nope/report.json' });
  assert.equal(noReport.code, 1);
  assert.match(noReport.result.error, /cannot read report/);
});

// ---------------------------------------------------------------------------
// Both adapters: the honest-defaults contract

test('a change from either adapter never claims to be auto-applied to a live surface', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const run = A.openFixRun(dataDir, {});
    const theme = await T.plan({ report: themeReport, store: STORE, includeProposed: true }, { run, dataDir, env: themeEnv() });
    for (const c of theme.changes) {
      assert.equal(c.live_impact, 'staged');
      assert.equal(c.adapter, 'shopify-theme');
      assert.ok(['auto', 'proposed'].includes(c.class));
    }
    const fetchImpl = mockFetch(adminRouter());
    const admin = await S.plan({ report: { findings: adminFindings }, store: STORE }, { run, dataDir, env: adminEnv(), fetchImpl });
    for (const c of admin.changes) {
      assert.equal(c.live_impact, 'live');
      assert.equal(c.class, 'proposed', 'a live write is never auto');
      assert.ok(c.requires.scopes.length > 0);
    }
  } finally { cleanup(); }
});

test('the fixture theme is the shape the adapters expect', () => {
  for (const rel of ['layout/theme.liquid', 'templates/product.json', 'sections/main-product.liquid', 'config/settings_schema.json']) {
    assert.ok(existsSync(join(FIXTURE_THEME, rel)), rel + ' exists');
  }
  const layout = themeSource();
  assert.match(layout, /<head>/);
  assert.match(layout, /content_for_header/);
  assert.ok(!layout.includes('claude-seo-ai'), 'the fixture starts clean');
  JSON.parse(readFileSync(join(FIXTURE_THEME, 'templates', 'product.json'), 'utf8'));
  JSON.parse(readFileSync(join(FIXTURE_THEME, 'config', 'settings_schema.json'), 'utf8'));
});

// ---------------------------------------------------------------------------
// A thrown op must say why, and must not burn the change

test('an op that throws marks the change failed and keeps the reason, on the row and in plan.json', async () => {
  const { dataDir, cleanup } = sandbox();
  const saved = { ...process.env };
  try {
    // Plan against a mock so the run holds two real shopify-admin changes…
    const fetchImpl = mockFetch(adminRouter());
    const { run, out } = await adminPlan(dataDir, fetchImpl, { findings: [adminFindings[0], adminFindings[1]] });
    assert.ok(out.changes.length >= 2);
    const id = out.changes[0].id;

    // …then preview through the CLI with nothing injected and the network refused, so the op throws
    // somewhere it does not describe. Every adapter routes that through _shared.opThrew.
    Object.assign(process.env, adminEnv(), { CLAUDE_SEO_AI_OFFLINE: '1' });
    const failed = await S.main({ _: ['preview'], run: run.dir, data: dataDir });
    assert.equal(failed.code, 2);
    for (const row of failed.result.results) {
      assert.equal(row.ok, false);
      assert.match(String(row.error || ''), /OFFLINE/i, 'the row carries the reason, not a bare "failed"');
      assert.equal(row.status, 'failed', 'a throw leaves the change failed, not silently still pending');
    }

    // The reason travels with the change: plan.json records why, so a manifest cannot claim the op
    // is still in flight. `failed` is terminal, so recovery is re-planning, not retrying this row.
    delete process.env.CLAUDE_SEO_AI_OFFLINE;
    const plan = JSON.parse(readFileSync(join(run.dir, 'plan.json'), 'utf8'));
    const stored = plan.changes.find((c) => c.id === id);
    assert.equal(stored.status, 'failed');
    assert.match(String(stored.error || ''), /OFFLINE/i, 'the persisted change keeps the reason');
    assert.equal(A.canTransition(stored.status, 'previewed'), false, 'failed is terminal');

    // Re-planning the same finding rebuilds the same change id at `planned`, which is the way back.
    const again = await adminPlan(dataDir, fetchImpl, { findings: [adminFindings[0], adminFindings[1]] });
    const rebuilt = again.out.changes.find((c) => c.id === id);
    assert.ok(rebuilt, 'the change id is deterministic, so a re-plan reopens the same edit');
    assert.equal(rebuilt.status, 'planned');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    cleanup();
  }
});

test('a ticketless apply is logged as refused, and a failed op is recorded in manifest.json', async () => {
  const { dataDir, cleanup } = sandbox();
  const saved = { ...process.env };
  try {
    const fetchImpl = mockFetch(adminRouter());
    const { run, out } = await adminPlan(dataDir, fetchImpl, { findings: [adminFindings[0]] });
    const id = out.changes[0].id;
    assert.equal(run.readManifest().dry_run, undefined, 'nothing has claimed a write yet');

    // Everything below is offline: the CLI has no injected fetch, so nothing may reach the network.
    Object.assign(process.env, adminEnv(), { CLAUDE_SEO_AI_OFFLINE: '1' });

    // apply with no ticket: the gate refuses before any request, so the audit log must not say "apply".
    const refused = await S.main({ _: ['apply'], run: run.dir, data: dataDir });
    assert.equal(refused.code, 2);
    assert.equal(refused.result.results[0].refused, 'no-ticket');
    const events = run.readLog().map((e) => e.event);
    assert.ok(events.includes('refused'), 'a run in which every change was refused is logged as refused: ' + events.join(','));
    assert.ok(!events.includes('apply'), 'no apply event for a run that wrote nothing');
    const afterRefusal = run.readManifest();
    assert.notEqual(afterRefusal.dry_run, false, 'a refused apply does not end the dry run');
    assert.deepEqual(afterRefusal.applied || [], [], 'nothing was applied');

    // A preview that throws is recorded as failed, with the reason, and still not as a write.
    const failed = await S.main({ _: ['preview'], run: run.dir, data: dataDir });
    assert.equal(failed.code, 2);
    const manifest = run.readManifest();
    assert.deepEqual(manifest.failed, [id]);
    assert.deepEqual(manifest.applied, []);
    assert.equal(manifest.results[id].status, 'failed');
    assert.equal(manifest.results[id].op, 'preview');
    assert.match(manifest.results[id].error, /OFFLINE/i, 'the manifest keeps why it failed');
    assert.notEqual(manifest.dry_run, false, 'a failed read-only op is not a write');
    assert.equal(manifest.last_op.op, 'preview');
    assert.ok(manifest.previewed_at, 'the op is timestamped');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    cleanup();
  }
});

test('CLAUDE_SEO_AI_OFFLINE refuses to spawn the Shopify CLI instead of reaching the store', async () => {
  const { base, dataDir, cleanup } = sandbox();
  try {
    const bin = join(base, 'bin');
    mkdirSync(bin, { recursive: true });
    // A stub that leaves a mark: if the adapter spawns it, the marker file proves it.
    const marker = join(base, 'spawned');
    writeFileSync(join(bin, 'shopify'), '#!/bin/sh\necho ran > ' + JSON.stringify(marker) + '\n', { mode: 0o755 });
    // No execImpl: with the flag set the adapter must answer without spawning anything.
    const out = await T.capabilities({ dataDir, env: themeEnv({ PATH: bin, CLAUDE_SEO_AI_OFFLINE: '1' }), store: STORE });
    assert.equal(existsSync(marker), false, 'the Shopify CLI was spawned despite CLAUDE_SEO_AI_OFFLINE=1');
    assert.equal(out.tools.shopify.on_path, true, 'the PATH probe still answers offline');
    assert.equal(out.tools.shopify.version, null);
    assert.equal(out.themes, null, 'the theme list was never fetched');
    assert.match(JSON.stringify(out.notes), /CLAUDE_SEO_AI_OFFLINE/);
  } finally { cleanup(); }
});

test('capabilities names each missing credential exactly once', async () => {
  const { dataDir, cleanup } = sandbox();
  try {
    const theme = await T.capabilities({ dataDir, env: { PATH: '' } });
    assert.deepEqual(theme.needs, [...new Set(theme.needs)], 'no duplicate keys: ' + theme.needs.join(', '));
    assert.equal(theme.needs.filter((n) => n === 'SHOPIFY_STORE').length, 1);

    const admin = await S.capabilities({ dataDir, env: { PATH: '' } });
    assert.deepEqual(admin.needs, [...new Set(admin.needs)], 'no duplicate keys: ' + admin.needs.join(', '));
    assert.equal(admin.needs.filter((n) => n === 'SHOPIFY_STORE').length, 1);
  } finally { cleanup(); }
});

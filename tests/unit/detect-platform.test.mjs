// scripts/detect-platform.mjs + scripts/lib/platform-rules.mjs —
// per-fixture platform/framework/plugin/hosting/environment verdicts, the four independent layers,
// the confidence bands, credential/tool readiness, the WordPress REST probe, the CLI surface,
// and the shape of the knowledge cards the profile points at.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildEvidence, detect, detectEnvironment, hasCredential, main, normalizeCookies, normalizeProbes,
  probeWordPress, readProject, runProbes, scoreLayer, testRule, RULES, PROFILE_VERSION,
} from '../../scripts/detect-platform.mjs';
import { CARD_IDS, confidenceOf } from '../../scripts/lib/platform-rules.mjs';
import { canonicalKey } from '../../scripts/lib/credentials.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const FIX = resolve(HERE, '..', 'fixtures', 'platforms');
const CARDS = resolve(ROOT, 'references', 'platforms');

/** Every fixture's public URL — fixtures carry markers, the URL carries host/environment evidence. */
const URLS = {
  shopify: 'https://northwind-supply.myshopify.com/products/merino-crew-tee',
  'shopify-hydrogen': 'https://www.northwind-outdoors.com/products/trail-runner-3',
  'wordpress-yoast': 'https://blog.northwind.example/how-we-source-merino/',
  'wordpress-rankmath': 'https://blog.northwind.example/how-we-source-merino/',
  'wordpress-aioseo': 'https://blog.northwind.example/how-we-source-merino/',
  'wordpress-seopress': 'https://blog.northwind.example/how-we-source-merino/',
  woocommerce: 'https://store.northwind.example/product/merino-beanie/',
  'nextjs-app': 'https://www.northwind-cloud.example/pricing',
  'nextjs-pages': 'https://docs.northwind-cloud.example/quickstart',
  nuxt: 'https://studio.northwind.example/field-notes',
  astro: 'https://handbook.northwind.example/onboarding/',
  sveltekit: 'https://www.northwind.example/changelog',
  gatsby: 'https://stories.northwind.example/',
  'react-router': 'https://ops.northwind.example/dashboard',
  hugo: 'https://notes.northwind.example/posts/rain-shadow/',
  jekyll: 'https://notes.northwind.example/2026/01/14/rain-shadow.html',
  eleventy: 'https://guides.northwind.example/',
  docusaurus: 'https://docs.northwind.example/docs/intro',
  wix: 'https://www.northwind-ceramics.example/',
  squarespace: 'https://www.northwind-studio.example/',
  webflow: 'https://www.northwind-agency.example/',
  framer: 'https://www.northwind-launch.example/',
  ghost: 'https://dispatch.northwind.example/rain-shadow/',
  hubspot: 'https://www.northwind-software.example/platform',
  bigcommerce: 'https://kitchen.northwind.example/cast-iron-skillet/',
  magento: 'https://gear.northwind.example/trail-pack-40l.html',
  drupal: 'https://www.northwind-county.example/services',
  static: 'https://www.northwind-rope.example/',
  'vercel-preview': 'https://northwind-cloud-git-feat-seo.vercel.app/pricing',
};

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined);

/** Load a fixture into a detect() input. `repo` opt-in mirrors the CLI's `--path`. */
function load(id, { repo = true, probes = true, env = {}, tools = {} } = {}) {
  const dir = join(FIX, id);
  const input = {
    url: URLS[id],
    html: readFileSync(join(dir, 'page.html'), 'utf8'),
    headers: readJson(join(dir, 'headers.json')),
    cookies: readJson(join(dir, 'cookies.json')),
    probes: probes ? readJson(join(dir, 'probes.json')) : undefined,
    env, tools,
  };
  if (repo && existsSync(join(dir, 'repo'))) {
    const p = readProject(join(dir, 'repo'));
    input.files = p.files; input.deps = p.deps; input.project_root = p.root;
  }
  return input;
}

// id -> expected verdict. `undefined` means "we do not assert it"; `null` means "must be absent".
const EXPECTED = {
  shopify: { platform: ['shopify', 'high'], framework: null, hosting: 'shopify', env: 'production', head_owner: 'theme', hints: ['ecommerce'] },
  'shopify-hydrogen': { platform: ['shopify', 'high'], framework: ['react-router', 'high'], flavor: 'hydrogen', router: 'remix', hosting: 'shopify', env: 'production', head_owner: 'framework' },
  'wordpress-yoast': { platform: ['wordpress', 'high'], framework: null, plugins: ['yoast'], env: 'production', head_owner: 'seo-plugin', hints: ['blog-publisher'] },
  'wordpress-rankmath': { platform: ['wordpress', 'high'], plugins: ['rankmath'], head_owner: 'seo-plugin' },
  'wordpress-aioseo': { platform: ['wordpress', 'high'], plugins: ['aioseo'], head_owner: 'seo-plugin' },
  'wordpress-seopress': { platform: ['wordpress', 'high'], plugins: ['seopress'], head_owner: 'seo-plugin' },
  woocommerce: { platform: ['wordpress', 'high'], plugins: ['woocommerce'], head_owner: 'theme', hints: ['blog-publisher', 'ecommerce'] },
  'nextjs-app': { platform: null, framework: ['nextjs', 'high'], flavor: 'app-router', router: 'app', env: 'production', head_owner: 'framework' },
  'nextjs-pages': { platform: null, framework: ['nextjs', 'high'], flavor: 'pages-router', router: 'pages', head_owner: 'framework' },
  nuxt: { platform: null, framework: ['nuxt', 'high'], head_owner: 'framework' },
  astro: { platform: null, framework: ['astro', 'high'], head_owner: 'framework' },
  sveltekit: { platform: null, framework: ['sveltekit', 'high'], head_owner: 'framework' },
  gatsby: { platform: null, framework: ['gatsby', 'high'], head_owner: 'framework' },
  'react-router': { platform: null, framework: ['react-router', 'high'], flavor: 'react-router-7', router: 'framework' },
  hugo: { platform: null, framework: ['hugo', 'high'] },
  jekyll: { platform: null, framework: ['jekyll', 'high'], flavor: 'jekyll-seo-tag' },
  eleventy: { platform: null, framework: ['eleventy', 'high'] },
  docusaurus: { platform: null, framework: ['docusaurus', 'high'], hints: ['docs'] },
  wix: { platform: ['wix', 'high'], framework: null, head_owner: 'builder' },
  squarespace: { platform: ['squarespace', 'high'], framework: null, head_owner: 'builder' },
  webflow: { platform: ['webflow', 'high'], framework: null, head_owner: 'builder' },
  framer: { platform: ['framer', 'high'], framework: null, head_owner: 'builder' },
  ghost: { platform: ['ghost', 'high'], framework: null, head_owner: 'builder', hints: ['blog-publisher'] },
  hubspot: { platform: ['hubspot', 'high'], framework: null, head_owner: 'builder' },
  bigcommerce: { platform: ['bigcommerce', 'high'], framework: null, head_owner: 'builder', hints: ['ecommerce'] },
  magento: { platform: ['magento', 'high'], framework: null, head_owner: 'theme', hints: ['ecommerce'] },
  drupal: { platform: ['drupal', 'high'], framework: null, head_owner: 'theme' },
  static: { platform: null, framework: ['static', 'medium'], env: 'production' },
  'vercel-preview': { platform: null, framework: ['nextjs', 'high'], hosting: 'vercel', env: 'preview' },
};

describe('detect() over the platform fixtures', () => {
  for (const [id, want] of Object.entries(EXPECTED)) {
    it(`${id} resolves to the expected layers`, () => {
      const profile = detect(load(id));
      assert.equal(profile.version, PROFILE_VERSION);

      if (want.platform === null) assert.equal(profile.platform, null, 'platform must stay absent, not be guessed');
      else if (want.platform) {
        assert.ok(profile.platform, `${id}: no platform detected`);
        assert.equal(profile.platform.id, want.platform[0]);
        assert.equal(profile.platform.confidence, want.platform[1]);
        assert.ok(profile.platform.signals.length >= 2, 'a verdict must carry its evidence');
        for (const s of profile.platform.signals) {
          assert.ok(['header', 'cookie', 'generator', 'asset_host', 'path', 'dom', 'link_rel', 'probe', 'repo', 'pkg'].includes(s.kind));
          assert.ok(s.weight >= 1 && s.weight <= 5);
        }
      }
      if (want.framework === null) assert.equal(profile.framework, null, 'framework must stay absent, not be guessed');
      else if (want.framework) {
        assert.ok(profile.framework, `${id}: no framework detected`);
        assert.equal(profile.framework.id, want.framework[0]);
        assert.equal(profile.framework.confidence, want.framework[1]);
      }
      if (want.flavor !== undefined) assert.equal(profile.framework.flavor, want.flavor);
      if (want.router !== undefined) assert.equal(profile.framework.router, want.router);
      if (want.plugins) assert.deepEqual(profile.cms_plugins.map((p) => p.id).sort(), [...want.plugins].sort());
      if (want.hosting !== undefined) assert.equal(profile.hosting.id, want.hosting);
      if (want.env) assert.equal(profile.environment.kind, want.env);
      if (want.head_owner) assert.equal(profile.capabilities.head_owner, want.head_owner);
      if (want.hints) assert.deepEqual([...profile.vertical_hints].sort(), [...want.hints].sort());
    });
  }

  it('every fixture profile carries the full contract', () => {
    for (const id of Object.keys(EXPECTED)) {
      const p = detect(load(id));
      for (const key of ['version', 'platform', 'framework', 'cms_plugins', 'hosting', 'environment',
        'capabilities', 'write_targets', 'candidates', 'vertical_hints']) {
        assert.ok(key in p, `${id}: profile is missing ${key}`);
      }
      for (const cap of ['local_files', 'theme_files', 'rest_api', 'wp_cli', 'admin_api', 'page_api',
        'instructions_only', 'sitemap_editable', 'robots_editable', 'redirects', 'head_owner']) {
        assert.ok(cap in p.capabilities, `${id}: capabilities is missing ${cap}`);
      }
      assert.ok(['theme-template', 'physical', 'plugin', 'file', 'none'].includes(p.capabilities.robots_editable), id);
      assert.ok(['admin-api', 'plugin', 'file', 'none'].includes(p.capabilities.redirects), id);
      assert.ok(['theme', 'seo-plugin', 'framework', 'builder'].includes(p.capabilities.head_owner), id);
      assert.ok(['production', 'preview', 'staging', 'local'].includes(p.environment.kind), id);
      assert.equal(p.write_targets.at(-1).adapter, 'instructions', `${id}: instructions is always the last resort`);
      for (const t of p.write_targets) {
        assert.ok(Array.isArray(t.needs) && t.needs.every((n) => /^[A-Z0-9_]+$/.test(n)), `${id}/${t.adapter}: needs must be key names`);
        assert.equal(typeof t.ready, 'boolean');
      }
      assert.ok(p.cards.every((c) => existsSync(resolve(ROOT, c))), `${id}: a referenced card does not exist`);
    }
  });

  it('shopify offers both the theme and the admin write path; hydrogen drops the theme one', () => {
    const shop = detect(load('shopify'));
    assert.deepEqual(shop.write_targets.map((t) => t.adapter), ['shopify-theme', 'shopify-admin', 'instructions']);
    assert.equal(shop.capabilities.robots_editable, 'theme-template');
    assert.equal(shop.capabilities.redirects, 'admin-api');
    assert.equal(shop.capabilities.sitemap_editable, false, 'Shopify owns sitemap.xml');

    const hydrogen = detect(load('shopify-hydrogen'));
    assert.ok(!hydrogen.write_targets.some((t) => t.adapter === 'shopify-theme'), 'a Hydrogen storefront has no Liquid theme');
    assert.ok(hydrogen.write_targets.some((t) => t.adapter === 'shopify-admin'));
    assert.equal(hydrogen.capabilities.theme_files, false);
  });

  it('wordpress exposes the REST and WP-CLI paths, and wp_cli follows the tool lookup', () => {
    const without = detect(load('wordpress-yoast'));
    assert.deepEqual(without.write_targets.map((t) => t.adapter), ['wordpress-rest', 'wordpress-wpcli', 'instructions']);
    assert.equal(without.capabilities.wp_cli, false);
    const withCli = detect(load('wordpress-yoast', { tools: { wp: true, ssh: true } }));
    assert.equal(withCli.capabilities.wp_cli, true);
    const cli = withCli.write_targets.find((t) => t.adapter === 'wordpress-wpcli');
    assert.deepEqual(cli.tools, { wp: true, ssh: true });
    assert.equal(cli.ready, false, 'the tools exist but WORDPRESS_SSH does not');
  });

  it('the plugin layer is scored on its own: without a probe a comment-only verdict stays medium', () => {
    const probed = detect(load('wordpress-yoast'));
    assert.equal(probed.cms_plugins[0].confidence, 'high');
    const unprobed = detect(load('wordpress-yoast', { probes: false }));
    assert.equal(unprobed.cms_plugins[0].id, 'yoast');
    assert.equal(unprobed.cms_plugins[0].confidence, 'medium', 'HTML comments alone are one signal kind');
    assert.ok(unprobed.notes.some((n) => n.includes('--probe')), 'the profile must say the probe evidence is missing');
    assert.equal(unprobed.platform.id, 'wordpress', 'the platform verdict survives without probes');
  });
});

describe('ambiguity and honesty', () => {
  it('an unrecognisable page resolves to no platform and no framework', () => {
    const p = detect({
      url: 'https://www.example.com/',
      html: '<!doctype html><html lang="en"><head><title>Hi</title></head><body><h1>Hi</h1></body></html>',
      headers: { 'content-type': 'text/html', 'cf-ray': '9f1a2b3c-CDG' },
      env: {}, tools: {},
    });
    assert.equal(p.platform, null);
    assert.equal(p.framework, null);
    assert.equal(p.hosting.id, 'cloudflare', 'a CDN header is a hosting hint only');
    assert.equal(p.hosting.confidence, 'low');
    assert.equal(p.capabilities.instructions_only, true);
    assert.deepEqual(p.write_targets.map((t) => t.adapter), ['instructions']);
    assert.ok(p.notes.some((n) => n.includes('platform unresolved')));
  });

  it('one weak signal lands at low confidence and never selects a write path', () => {
    const p = detect({
      url: 'https://www.example.com/',
      html: '<html><body><div class="wp-block-group">hi</div></body></html>',
      headers: {}, env: {}, tools: {},
    });
    assert.equal(p.platform.id, 'wordpress');
    assert.equal(p.platform.confidence, 'low', 'a single weight-2 signal is a hint, not a verdict');
    assert.deepEqual(p.write_targets.map((t) => t.adapter), ['instructions'], 'a low verdict never selects a CMS write path');
    assert.ok(p.notes.some((n) => n.includes('low confidence')));
    const cands = scoreLayer(RULES.platform, buildEvidence({ html: '<div class="wp-block-group">hi</div>' }));
    assert.equal(cands[0].score, 2);
    assert.equal(cands[0].confidence, 'low');
  });

  it('a static verdict is dropped as soon as any build framework has evidence', () => {
    const staticOnly = detect({ files: ['index.html', 'about/index.html', 'css/site.css'], env: {}, tools: {} });
    assert.equal(staticOnly.framework.id, 'static');
    const withBuild = detect({ files: ['index.html', 'about/index.html', 'css/site.css', 'astro.config.mjs'], env: {}, tools: {} });
    assert.equal(withBuild.framework.id, 'astro');
    assert.ok(!withBuild.candidates.framework.some((c) => c.id === 'static'));
  });

  it('cookie names are evidence; cookie values are never recorded', () => {
    assert.deepEqual(normalizeCookies(['_shopify_y=9f1a2b3c-secret', 'cart=abc']), ['_shopify_y', 'cart']);
    const p = detect({
      url: 'https://shop.example.com/',
      html: readFileSync(join(FIX, 'shopify', 'page.html'), 'utf8'),
      headers: { 'set-cookie': '_shopify_y=9f1a2b3c-secret; Path=/' },
      env: {}, tools: {},
    });
    const dump = JSON.stringify(p);
    assert.ok(dump.includes('_shopify_y'));
    assert.ok(!dump.includes('9f1a2b3c-secret'), 'no cookie value may reach the profile');
  });

  it('records which evidence sources were unavailable', () => {
    const p = detect(load('nextjs-app', { repo: false }));
    assert.equal(p.sources.repo, null);
    assert.equal(p.sources.repo_files, 0);
    assert.ok(p.notes.some((n) => n.includes('no --path')));
    assert.equal(p.capabilities.local_files, false);
    assert.deepEqual(p.write_targets.map((t) => t.adapter), ['instructions'], 'no project, no local write path');
  });
});

describe('four independent layers', () => {
  it('headless WordPress behind Next.js resolves both, and the framework owns the head', () => {
    const p = detect({
      url: 'https://www.northwind.example/blog/rain-shadow',
      html: readFileSync(join(FIX, 'nextjs-app', 'page.html'), 'utf8'),
      headers: { ...readJson(join(FIX, 'wordpress-yoast', 'headers.json')), 'x-powered-by': 'Next.js' },
      probes: readJson(join(FIX, 'wordpress-yoast', 'probes.json')),
      env: {}, tools: {},
    });
    assert.equal(p.platform.id, 'wordpress');
    assert.equal(p.platform.confidence, 'high');
    assert.equal(p.framework.id, 'nextjs');
    assert.equal(p.framework.confidence, 'high');
    assert.deepEqual(p.cms_plugins.map((x) => x.id), ['yoast']);
    assert.equal(p.capabilities.head_owner, 'framework', 'the Next.js head wins over the WordPress theme');
    assert.equal(p.capabilities.theme_files, false);
    assert.ok(p.notes.some((n) => n.includes('headless')));
    assert.ok(p.cards.includes('references/platforms/wordpress.md'));
    assert.ok(p.cards.includes('references/platforms/nextjs.md'));
    assert.ok(p.cards.includes('references/platforms/yoast.md') === false, 'only ids with a card are listed');
  });

  it('Hydrogen resolves shopify (platform) and react-router (framework) at once', () => {
    const p = detect(load('shopify-hydrogen'));
    assert.equal(p.platform.id, 'shopify');
    assert.equal(p.framework.id, 'react-router');
    assert.equal(p.framework.flavor, 'hydrogen');
    assert.deepEqual(p.cards, ['references/platforms/shopify.md', 'references/platforms/react-router.md']);
  });
});

describe('repo-path detection (--path only, no HTTP evidence)', () => {
  const cases = [
    ['nextjs-app', 'nextjs', 'app'],
    ['astro', 'astro', null],
    ['hugo', 'hugo', null],
  ];
  for (const [id, framework, router] of cases) {
    it(`${id}: the project tree alone identifies ${framework}`, () => {
      const p = readProject(join(FIX, id, 'repo'));
      assert.equal(p.error, null);
      assert.ok(p.files.length > 0);
      const profile = detect({ files: p.files, deps: p.deps, project_root: p.root, env: {}, tools: {} });
      assert.equal(profile.framework.id, framework);
      assert.ok(['high', 'medium'].includes(profile.framework.confidence));
      assert.equal(profile.framework.router, router);
      assert.equal(profile.capabilities.local_files, true);
      assert.equal(profile.environment.kind, 'local', 'a project directory with no URL is a local target');
      assert.ok(profile.write_targets.some((t) => t.adapter === 'local-files' && t.ready === true));
      assert.equal(profile.sources.html, false);
    });
  }

  it('readProject skips node_modules and build output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csa-repo-'));
    mkdirSync(join(dir, 'node_modules', 'next'), { recursive: true });
    mkdirSync(join(dir, '.next'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'next', 'next.config.js'), '// decoy\n');
    writeFileSync(join(dir, '.next', 'next.config.js'), '// decoy\n');
    writeFileSync(join(dir, 'index.html'), '<html></html>\n');
    const p = readProject(dir);
    assert.deepEqual(p.files, ['index.html']);
    assert.equal(readProject(join(dir, 'nope')).error !== null, true);
  });
});

describe('scoreLayer + confidence bands', () => {
  it('high needs >= 8 AND >= 2 signal kinds; medium >= 5; low >= 2', () => {
    assert.equal(confidenceOf(9, 2), 'high');
    assert.equal(confidenceOf(9, 1), 'medium', 'one kind of evidence never reaches high');
    assert.equal(confidenceOf(5, 1), 'medium');
    assert.equal(confidenceOf(4, 3), 'low');
    assert.equal(confidenceOf(1, 1), null);
  });

  it('sums matched rules only, records one signal per rule, and sorts by score', () => {
    const rules = {
      alpha: [{ kind: 'header', match: 'x-alpha', weight: 5 }, { kind: 'dom', match: /alpha-marker/, weight: 4 }],
      beta: [{ kind: 'dom', match: /alpha-marker/, weight: 3 }, { kind: 'cookie', match: /^never$/, weight: 5 }],
    };
    const ev = buildEvidence({ html: '<div class="alpha-marker"></div>', headers: { 'X-Alpha': '1' } });
    const out = scoreLayer(rules, ev);
    assert.deepEqual(out.map((c) => [c.id, c.score, c.confidence]), [['alpha', 9, 'high'], ['beta', 3, 'low']]);
    assert.deepEqual(out[0].signals.map((s) => s.kind), ['header', 'dom']);
    assert.deepEqual(out[0].kinds, ['header', 'dom']);
    assert.equal(scoreLayer({ nothing: [{ kind: 'dom', match: /absent/, weight: 5 }] }, ev).length, 0);
  });

  it('matches each rule kind against its own haystack', () => {
    const ev = buildEvidence({
      url: 'https://shop.example.com/a?preview_theme_id=9',
      html: '<meta name="generator" content="Astro v5"><link rel="https://api.w.org/" href="https://x/wp-json/">'
        + '<script src="https://cdn.shopify.com/s/files/a.js"></script><img src="/wp-content/uploads/a.png">',
      headers: { 'X-ShopId': '42', 'x-powered-by': 'Next.js' },
      cookies: ['_shopify_y'],
      probes: { '/wp-json/': { status: 200, json: { namespaces: ['wp/v2', 'yoast/v1'] } } },
      files: ['layout/theme.liquid'],
      deps: { next: '15.0.0' },
    });
    const hit = (rule) => testRule(rule, ev);
    assert.ok(hit({ kind: 'header', match: 'x-shopid', weight: 5 }));
    assert.ok(hit({ kind: 'header', match: 'x-powered-by', value: /Next\.js/i, weight: 5 }));
    assert.equal(hit({ kind: 'header', match: 'x-powered-by', value: /Nuxt/i, weight: 5 }), null);
    assert.ok(hit({ kind: 'cookie', match: /^_shopify_y$/, weight: 4 }));
    assert.ok(hit({ kind: 'generator', match: /Astro/i, weight: 4 }));
    assert.ok(hit({ kind: 'asset_host', match: 'cdn.shopify.com', weight: 4 }));
    assert.ok(hit({ kind: 'path', match: '/wp-content/', weight: 4 }));
    assert.ok(hit({ kind: 'dom', match: /application\/ld\+json|api\.w\.org/, weight: 3 }));
    assert.ok(hit({ kind: 'link_rel', match: /https:\/\/api\.w\.org\//, weight: 5 }));
    assert.ok(hit({ kind: 'probe', match: '/wp-json', value: /"yoast\/v1"/, weight: 5 }));
    assert.equal(hit({ kind: 'probe', match: '/products.json', weight: 2 }), null, 'an absent probe never matches');
    assert.ok(hit({ kind: 'repo', match: /^layout\/theme\.liquid$/, weight: 5 }));
    assert.ok(hit({ kind: 'pkg', match: 'next', weight: 4 }));
    assert.equal(hit({ kind: 'pkg', match: 'nuxt', weight: 4 }), null);
    assert.equal(hit({ kind: 'nonsense', match: 'x', weight: 5 }), null);
  });

  it('normalizes probe keys and treats a non-2xx probe as no evidence', () => {
    const probes = normalizeProbes({ '/wp-json/': { status: 200, json: { namespaces: [] } }, 'products.json': { status: 404 } });
    assert.deepEqual(Object.keys(probes).sort(), ['/products.json', '/wp-json']);
    const ev = buildEvidence({ probes });
    assert.ok(testRule({ kind: 'probe', match: '/wp-json/', weight: 5 }, ev));
    assert.equal(testRule({ kind: 'probe', match: '/products.json', weight: 2 }, ev), null);
  });
});

describe('environment layer', () => {
  const env = (url, html = '', headers = {}) => detectEnvironment(buildEvidence({ url, html, headers }));
  it('classifies preview, staging, local and production hosts', () => {
    assert.equal(env('https://acme.vercel.app/').kind, 'preview');
    assert.equal(env('https://deploy-preview-42--acme.netlify.app/').kind, 'preview');
    assert.equal(env('https://acme--feature-x.netlify.app/').kind, 'preview');
    assert.equal(env('https://shop.myshopify.com/?preview_theme_id=123').kind, 'preview');
    assert.equal(env('https://staging.example.com/').kind, 'staging');
    assert.equal(env('https://acme.wpengine.com/').kind, 'staging');
    assert.equal(env('http://localhost:4321/').kind, 'local');
    assert.equal(env('https://www.example.com/').kind, 'production');
  });
  it('noindex corroborates a non-production host but never classifies one on its own', () => {
    const preview = env('https://acme.vercel.app/', '<meta name="robots" content="noindex, nofollow">');
    assert.equal(preview.kind, 'preview');
    assert.ok(preview.signals.some((s) => s.value.includes('noindex')));
    const prod = env('https://www.example.com/', '<meta name="robots" content="noindex">');
    assert.equal(prod.kind, 'production', 'plenty of production pages carry noindex on purpose');
    assert.deepEqual(prod.signals, []);
  });
  it('the vercel-preview fixture reports hosting and environment together', () => {
    const p = detect(load('vercel-preview'));
    assert.equal(p.hosting.id, 'vercel');
    assert.equal(p.environment.kind, 'preview');
    assert.ok(p.environment.signals.some((s) => s.value.includes('noindex')));
  });
});

describe('credentials and tools', () => {
  it('checks key names in both CLAUDE_PLUGIN_OPTION_<KEY> and <KEY> form, never values', () => {
    assert.equal(hasCredential('SHOPIFY_STORE', { SHOPIFY_STORE: '' }), true, 'presence, not truthiness');
    assert.equal(hasCredential('SHOPIFY_STORE', { CLAUDE_PLUGIN_OPTION_SHOPIFY_STORE: 'x' }), true);
    assert.equal(hasCredential('SHOPIFY_STORE', { OTHER: 'x' }), false);
    // The catalog name is what the profile asks for; the historical spelling still resolves, so an
    // operator who exported the old variable is not told the key is missing.
    assert.equal(hasCredential('SHOPIFY_THEME_TOKEN', { SHOPIFY_CLI_THEME_TOKEN: 'x' }), true);
    assert.equal(hasCredential('WP_URL', { CLAUDE_PLUGIN_OPTION_WORDPRESS_URL: 'x' }), true);
  });

  it('a write target is ready only when every key AND every tool is present', () => {
    const base = { ...load('shopify'), tools: { shopify: false } };
    const none = detect(base);
    const theme = none.write_targets.find((t) => t.adapter === 'shopify-theme');
    // Catalog/UI names — the same ones plugin.json userConfig prompts for and the docs quote.
    assert.deepEqual(theme.needs, ['SHOPIFY_STORE', 'SHOPIFY_THEME_TOKEN']);
    assert.deepEqual(theme.tools, { shopify: false });
    assert.equal(theme.ready, false);

    const keysOnly = detect({ ...base, env: { SHOPIFY_STORE: '1', CLAUDE_PLUGIN_OPTION_SHOPIFY_CLI_THEME_TOKEN: '1' } });
    assert.equal(keysOnly.write_targets.find((t) => t.adapter === 'shopify-theme').ready, false, 'the CLI is still missing');

    const ready = detect({ ...base, tools: { shopify: true }, env: { SHOPIFY_STORE: '1', SHOPIFY_CLI_THEME_TOKEN: '1' } });
    assert.equal(ready.write_targets.find((t) => t.adapter === 'shopify-theme').ready, true);
    assert.equal(ready.write_targets.find((t) => t.adapter === 'shopify-admin').ready, false, 'a different key set');
  });

  it('page-api targets carry the platform-specific key names', () => {
    const keys = {
      webflow: ['WEBFLOW_TOKEN', 'WEBFLOW_SITE_ID'],
      wix: ['WIX_API_KEY', 'WIX_SITE_ID'],
      ghost: ['GHOST_URL', 'GHOST_ADMIN_KEY'],
      hubspot: ['HUBSPOT_TOKEN'],
      bigcommerce: ['BIGCOMMERCE_STORE_HASH', 'BIGCOMMERCE_TOKEN'],
    };
    for (const [id, needs] of Object.entries(keys)) {
      const t = detect(load(id)).write_targets.find((x) => x.adapter === 'page-api');
      assert.ok(t, `${id}: no page-api target`);
      assert.deepEqual(t.needs, needs, `${id}: needs[] must name the catalog keys, not an alias`);
      for (const key of needs) assert.equal(canonicalKey(key), key, `${key} is not a catalog name`);
    }
    for (const id of ['squarespace', 'framer']) {
      const p = detect(load(id));
      assert.deepEqual(p.write_targets.map((t) => t.adapter), ['instructions'], `${id} has no SEO write API`);
      assert.equal(p.capabilities.instructions_only, true);
    }
  });
});

describe('probeWordPress', () => {
  const ok = (json) => async () => ({ status: 200, text: JSON.stringify(json), error: null });

  it('reads the REST namespace list and maps it to plugin ids', async () => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(url); return { status: 200, text: JSON.stringify({ namespaces: ['oembed/1.0', 'wp/v2', 'yoast/v1', 'wc/v3'] }) }; };
    const r = await probeWordPress('https://blog.example.com', fetchImpl);
    assert.deepEqual(calls, ['https://blog.example.com/wp-json/']);
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.deepEqual(r.namespaces, ['oembed/1.0', 'wp/v2', 'yoast/v1', 'wc/v3']);
    assert.deepEqual(r.plugins, ['yoast', 'woocommerce']);
    assert.equal(r.error, null);
  });

  it('reports a 404, a non-JSON body and a thrown fetch as failures, never as "no plugins"', async () => {
    const notFound = await probeWordPress('https://example.com', async () => ({ status: 404, text: 'Not found' }));
    assert.equal(notFound.ok, false);
    assert.equal(notFound.status, 404);
    assert.match(notFound.error, /404/);

    const html = await probeWordPress('https://example.com', async () => ({ status: 200, text: '<!doctype html><html></html>' }));
    assert.equal(html.ok, false);
    assert.match(html.error, /not a WP REST index/);

    const boom = await probeWordPress('https://example.com', async () => { throw new Error('ECONNREFUSED'); });
    assert.equal(boom.ok, false);
    assert.equal(boom.status, null);
    assert.match(boom.error, /ECONNREFUSED/);
    assert.deepEqual(boom.plugins, []);
  });

  it('runProbes returns a probes map detect() can score directly', async () => {
    const fetchImpl = async (url) => (url.endsWith('/wp-json/')
      ? { status: 200, text: JSON.stringify({ namespaces: ['wp/v2', 'rankmath/v1'] }) }
      : { status: 404, text: '' });
    const probes = await runProbes('https://blog.example.com', fetchImpl, ['/wp-json/', '/products.json']);
    assert.deepEqual(Object.keys(probes), ['/wp-json/', '/products.json']);
    const p = detect({
      url: 'https://blog.example.com/post/',
      html: readFileSync(join(FIX, 'wordpress-rankmath', 'page.html'), 'utf8'),
      headers: readJson(join(FIX, 'wordpress-rankmath', 'headers.json')),
      probes, env: {}, tools: {},
    });
    assert.equal(p.cms_plugins[0].id, 'rankmath');
    assert.equal(p.cms_plugins[0].confidence, 'high');
  });

  it('an empty namespace list confirms the REST index but names no plugin', async () => {
    const r = await probeWordPress('https://example.com', ok({ namespaces: [] }));
    assert.equal(r.ok, true, 'the response is still a WP REST index');
    assert.deepEqual(r.plugins, [], 'no namespace, no plugin claim');
  });
});

describe('CLI', () => {
  it('--html/--headers/--cookies/--probes builds the same profile as detect()', async () => {
    const dir = join(FIX, 'shopify');
    const { result, code } = await main({
      html: join(dir, 'page.html'), headers: join(dir, 'headers.json'),
      cookies: join(dir, 'cookies.json'), probes: join(dir, 'probes.json'), url: URLS.shopify,
    });
    assert.equal(code, 0);
    assert.equal(result.platform.id, 'shopify');
    assert.equal(result.platform.confidence, 'high');
    assert.equal(result.version, PROFILE_VERSION);
  });

  it('--path alone profiles a project tree and --out persists it', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'csa-out-')), 'profile.platform.json');
    const { result, code } = await main({ path: join(FIX, 'nextjs-app', 'repo'), out });
    assert.equal(code, 0);
    assert.equal(result.framework.id, 'nextjs');
    const written = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(written.framework.id, 'nextjs');
    assert.equal(written.capabilities.local_files, true);
  });

  it('--snapshot reads the persisted PageSnapshot (html, headers, cookie names)', async () => {
    const run = mkdtempSync(join(tmpdir(), 'csa-run-'));
    mkdirSync(join(run, 'pages'), { recursive: true });
    const snap = {
      snapshot_version: 2,
      target: { kind: 'url', value: URLS.shopify, requested_url: URLS.shopify, final_url: URLS.shopify, origin: 'https://northwind-supply.myshopify.com' },
      status: 200, ok: true,
      headers: readJson(join(FIX, 'shopify', 'headers.json')),
      cookie_names: readJson(join(FIX, 'shopify', 'cookies.json')),
      html_inline: { raw: readFileSync(join(FIX, 'shopify', 'page.html'), 'utf8'), rendered: null },
    };
    writeFileSync(join(run, 'pages', 'home.json'), JSON.stringify(snap));
    const { result, code } = await main({ snapshot: join(run, 'pages', 'home.json') });
    assert.equal(code, 0);
    assert.equal(result.platform.id, 'shopify');
    assert.equal(result.target.url, URLS.shopify);
    assert.ok(result.platform.signals.some((s) => s.kind === 'cookie'));
  });

  it('bad invocations exit 1 with an error, never with a guessed profile', async () => {
    assert.equal((await main({})).code, 1);
    assert.match((await main({})).result.error, /provide --snapshot/);
    assert.equal((await main({ snapshot: '/no/such/snapshot.json' })).code, 1);
    assert.equal((await main({ html: '/no/such/page.html' })).code, 1);
    assert.equal((await main({ path: join(FIX, 'nope') })).code, 1);
    assert.equal((await main({ html: join(FIX, 'shopify', 'page.html'), headers: '/no/such.json' })).code, 1);
    const probeNoTarget = await main({ path: join(FIX, 'astro', 'repo'), probe: true });
    assert.equal(probeNoTarget.code, 1);
    assert.match(probeNoTarget.result.error, /--probe needs an http\(s\) target/);
  });
});

describe('knowledge cards and routing', () => {
  const cardFiles = readdirSync(CARDS).filter((f) => f.endsWith('.md') && f !== 'README.md');
  const HEADINGS = [
    'Detection recap', 'Generated automatically', 'URL surfaces', 'Platform-owned', 'Fix map',
    'Write method & credentials', 'Preview & publish', 'Verification', 'Rollback', 'Check ids',
    'Manual paths', 'Honesty',
  ];

  it('there is exactly one card per detectable id', () => {
    assert.deepEqual(cardFiles.map((f) => f.replace(/\.md$/, '')).sort(), [...CARD_IDS].sort());
    assert.equal(CARD_IDS.length, 24);
    assert.ok(existsSync(join(CARDS, 'README.md')), 'the template lives next to the cards');
  });

  for (const file of cardFiles) {
    it(`${file} has the status header and all 12 sections in order`, () => {
      const text = readFileSync(join(CARDS, file), 'utf8');
      assert.match(text, /^# [a-z0-9-]+\n/, 'the H1 is the detector id');
      assert.match(text, /^\*\*Status:\*\* (stable|beta|instructions-only) · \*\*Last verified:\*\* \d{4}-\d{2}-\d{2}/m);
      const found = [...text.matchAll(/^## (\d{1,2})\. (.+)$/gm)];
      assert.equal(found.length, 12, `${file}: expected 12 numbered sections, found ${found.length}`);
      found.forEach(([, n, title], i) => {
        assert.equal(Number(n), i + 1, `${file}: section numbering is out of order at "${title}"`);
        assert.ok(title.includes(HEADINGS[i]), `${file}: section ${n} should be "${HEADINGS[i]}…", got "${title}"`);
      });
    });
  }

  it('every card that promises an unconfirmed API detail marks it UNVERIFIED', () => {
    for (const file of ['shopify.md', 'wordpress.md', 'wix.md', 'webflow.md', 'ghost.md', 'hubspot.md', 'bigcommerce.md', 'payload.md']) {
      const text = readFileSync(join(CARDS, file), 'utf8');
      const honesty = text.slice(text.indexOf('## 12.'));
      assert.match(honesty, /UNVERIFIED/, `${file}: §12 must name what is not vendor-confirmed`);
    }
  });

  it('references/routing.md lists all 24 card ids and the profile shape', () => {
    const routing = readFileSync(resolve(ROOT, 'references', 'routing.md'), 'utf8');
    for (const id of CARD_IDS) {
      assert.ok(routing.includes(`platforms/${id}.md`), `routing.md does not route to platforms/${id}.md`);
    }
    assert.ok(routing.includes(`"version": "${PROFILE_VERSION}"`), 'the SiteProfile shape must carry the real version string');
    for (const key of ['write_targets', 'capabilities', 'vertical_hints', 'candidates', 'head_owner', 'robots_editable']) {
      assert.ok(routing.includes(key), `routing.md SiteProfile shape is missing ${key}`);
    }
  });

  it('the hidden detect skill is not user-invocable and only runs plugin scripts', () => {
    const skill = readFileSync(resolve(ROOT, 'skills', 'seo-platform-detect', 'SKILL.md'), 'utf8');
    const fm = skill.slice(0, skill.indexOf('\n---', 4));
    assert.match(fm, /^name: seo-platform-detect$/m);
    assert.match(fm, /^user-invocable: false$/m);
    assert.match(fm, /^allowed-tools: Read, Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/\*"\)$/m);
    assert.ok(skill.includes('detect-platform.mjs'));
    assert.ok(skill.includes('profile.json'));
    assert.ok(skill.includes('seo-vertical-detect'));
  });
});

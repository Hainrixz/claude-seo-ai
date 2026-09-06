// Unit tests for scripts/lib/route-map.mjs — the URL -> source file mapping, against the synthetic
// repositories in tests/fixtures/repos. Covers the cases named in the plan (3i) plus the class rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'route-map.mjs')).href);
const REPOS = join(ROOT, 'tests', 'fixtures', 'repos');
const repo = (name) => join(REPOS, name);

test('CLASS RULE: only html-head, front-matter, config-file and liquid are auto', () => {
  assert.deepEqual([...R.AUTO_STRATEGIES], ['html-head', 'front-matter', 'config-file', 'liquid']);
  for (const s of R.AUTO_STRATEGIES) assert.equal(R.classFor(s), 'auto', s);
  for (const s of ['metadata-object', 'next-head-jsx', 'use-seo-meta', 'svelte-head', 'meta-export-array', 'gatsby-head-export', 'manual']) {
    assert.equal(R.classFor(s), 'proposed', s + ' must never be auto');
  }
});

test('pathSegments handles URLs, encoding, query strings and the root', () => {
  assert.deepEqual(R.pathSegments('https://h.example/blog/rain-shadow?x=1#f'), ['blog', 'rain-shadow']);
  assert.deepEqual(R.pathSegments('/a//b/'), ['a', 'b']);
  assert.deepEqual(R.pathSegments('/'), []);
  assert.deepEqual(R.pathSegments('/caf%C3%A9'), ['café']);
  assert.equal(R.normalizePath('https://h/x/y/'), '/x/y');
  assert.equal(R.normalizePath(''), '/');
});

test('Next app router: (marketing) group is stripped and [slug] matches', () => {
  const r = R.resolveRoute(repo('nextjs-app'), '/blog/rain-shadow');
  assert.equal(r.framework, 'nextjs');
  assert.equal(r.file, 'app/(marketing)/blog/[slug]/page.tsx');
  assert.equal(r.route.pattern, '/blog/[slug]');
  assert.deepEqual(r.params, { slug: 'rain-shadow' });
  assert.equal(r.layout, 'app/(marketing)/layout.tsx', 'the nearest layout wins over the root one');
  assert.equal(r.strategy, 'metadata-object');
  assert.equal(r.class, 'proposed');
  assert.equal(r.confidence, 'medium');
  assert.equal(r.anchor.present, true, 'the literal `export const metadata = {` is detected');
  assert.ok(r.notes.some((n) => /CLASS RULE/.test(n)));
});

test('Next app router: [[...slug]] matches zero and many segments, generateMetadata is reported', () => {
  const zero = R.resolveRoute(repo('nextjs-app'), '/docs');
  assert.equal(zero.file, 'app/docs/[[...slug]]/page.tsx');
  assert.deepEqual(zero.params, { slug: [] });
  assert.equal(zero.anchor.present, false);
  assert.equal(zero.anchor.generate, true);
  assert.ok(zero.notes.some((n) => /generateMetadata/.test(n)));

  const many = R.resolveRoute(repo('nextjs-app'), '/docs/getting-started/install');
  assert.equal(many.file, 'app/docs/[[...slug]]/page.tsx');
  assert.deepEqual(many.params, { slug: ['getting-started', 'install'] });
});

test('Next app router: a static route beats a dynamic one, and _private folders never route', () => {
  const home = R.resolveRoute(repo('nextjs-app'), '/');
  assert.equal(home.file, 'app/page.tsx');
  assert.equal(home.confidence, 'high');
  assert.equal(home.layout, 'app/layout.tsx');

  const priv = R.resolveRoute(repo('nextjs-app'), '/drafts');
  assert.equal(priv.file, null);
  assert.equal(priv.confidence, 'none');
  assert.equal(priv.strategy, 'manual');
  assert.ok(priv.notes.some((n) => n.includes('no nextjs route file matches /drafts')));
});

test('Next app router: site-wide files point at the route files, not stray public/ ones', () => {
  const r = R.resolveRoute(repo('nextjs-app'), '/');
  assert.deepEqual(r.site_wide.lang_file, { path: 'app/layout.tsx', exists: true });
  assert.deepEqual(r.site_wide.robots, { path: 'app/robots.ts', exists: true });
  assert.deepEqual(r.site_wide.config, { path: 'next.config.mjs', exists: true });
  assert.deepEqual(r.site_wide.sitemap, { path: 'public/sitemap.xml', exists: false }, 'names the conventional location and says it is missing');
});

test('Next pages router: [...slug], _document/_app/api excluded', () => {
  const r = R.resolveRoute(repo('nextjs-pages'), '/posts/2026/rain-shadow');
  assert.equal(r.framework, 'nextjs');
  assert.equal(r.file, 'pages/posts/[...slug].tsx');
  assert.deepEqual(r.params, { slug: ['2026', 'rain-shadow'] });
  assert.equal(r.strategy, 'next-head-jsx');
  assert.equal(r.class, 'proposed');
  assert.equal(r.anchor.present, true, 'the file already renders a <Head>');
  assert.deepEqual(r.site_wide.lang_file, { path: 'pages/_document.tsx', exists: true });
  assert.deepEqual(r.site_wide.robots, { path: 'public/robots.txt', exists: true });

  const candidates = R.nextPagesCandidates(R.scanProject(repo('nextjs-pages'))).map((c) => c.file);
  assert.ok(!candidates.some((f) => /_app|_document|\/api\//.test(f)), 'framework files are not routes');
});

test('Astro: src/pages/blog/[slug].astro is html-head and therefore auto', () => {
  const r = R.resolveRoute(repo('astro'), '/blog/rain-shadow');
  assert.equal(r.framework, 'astro');
  assert.equal(r.file, 'src/pages/blog/[slug].astro');
  assert.equal(r.strategy, 'html-head');
  assert.equal(r.class, 'auto');
  assert.equal(r.layout, 'src/layouts/Base.astro');
  assert.deepEqual(r.site_wide.config, { path: 'astro.config.mjs', exists: true });
});

test('SvelteKit: (app) group is stripped, the nearest +layout wins, and the class stays proposed', () => {
  const r = R.resolveRoute(repo('sveltekit'), '/blog/rain-shadow');
  assert.equal(r.framework, 'sveltekit');
  assert.equal(r.file, 'src/routes/(app)/blog/[slug]/+page.svelte');
  assert.equal(r.route.pattern, '/blog/[slug]');
  assert.equal(r.layout, 'src/routes/(app)/+layout.svelte');
  assert.equal(r.strategy, 'svelte-head');
  assert.equal(r.class, 'proposed');
  assert.ok(r.notes.some((n) => /CLASS RULE/.test(n)));
  assert.deepEqual(r.site_wide.lang_file, { path: 'src/app.html', exists: true });
  assert.deepEqual(r.site_wide.robots, { path: 'static/robots.txt', exists: true });
});

test('React Router 7: app/routes.ts is parsed, including prefix() nesting', () => {
  const entries = R.parseRoutesConfig(`
    import { index, layout, prefix, route } from '@react-router/dev/routes';
    export default [
      index('routes/home.tsx'),
      route('about', 'routes/about.tsx'),
      layout('routes/shell.tsx', [
        ...prefix('blog', [
          index('routes/blog/index.tsx'),
          route(':slug', 'routes/blog/post.tsx'),
        ]),
      ]),
    ];
  `);
  assert.deepEqual(entries.filter((e) => e.kind !== 'layout'), [
    { path: '/', file: 'routes/home.tsx', kind: 'index' },
    { path: '/about', file: 'routes/about.tsx', kind: 'route' },
    { path: '/blog', file: 'routes/blog/index.tsx', kind: 'index' },
    { path: '/blog/:slug', file: 'routes/blog/post.tsx', kind: 'route' },
  ]);

  const r = R.resolveRoute(repo('react-router'), '/blog/rain-shadow');
  assert.equal(r.framework, 'react-router');
  assert.equal(r.file, 'app/routes/blog/post.tsx');
  assert.deepEqual(r.params, { slug: 'rain-shadow' });
  assert.equal(r.strategy, 'meta-export-array');
  assert.equal(r.class, 'proposed');
  assert.ok(r.notes.some((n) => n.includes('config-based routing')));
  assert.deepEqual(r.site_wide.lang_file, { path: 'app/root.tsx', exists: true });
});

test('Remix flat routes: dots, $params, $ splat, _index and pathless layouts', () => {
  const files = [
    'app/routes/_index.tsx', 'app/routes/about.tsx', 'app/routes/products.$handle.tsx',
    'app/routes/$.tsx', 'app/routes/_public.contact.tsx', 'app/routes/blog_.new.tsx',
    'app/routes/dashboard.settings/route.tsx',
  ];
  const patterns = Object.fromEntries(R.remixFlatCandidates(files).map((c) => [c.file, R.patternToString(c.pattern)]));
  assert.equal(patterns['app/routes/_index.tsx'], '/');
  assert.equal(patterns['app/routes/about.tsx'], '/about');
  assert.equal(patterns['app/routes/products.$handle.tsx'], '/products/[handle]');
  assert.equal(patterns['app/routes/$.tsx'], '/[...splat]');
  assert.equal(patterns['app/routes/_public.contact.tsx'], '/contact');
  assert.equal(patterns['app/routes/blog_.new.tsx'], '/blog/new');
  assert.equal(patterns['app/routes/dashboard.settings/route.tsx'], '/dashboard/settings');
  assert.deepEqual(R.splitFlatSegments('products.[sitemap.xml].$id'), ['products', '[sitemap.xml]', '$id']);
});

test('Hugo: content mapping, a front-matter url override, and the theme-partial warning', () => {
  const post = R.resolveRoute(repo('hugo'), '/posts/rain-shadow/');
  assert.equal(post.framework, 'hugo');
  assert.equal(post.file, 'content/posts/rain-shadow.md');
  assert.equal(post.strategy, 'front-matter');
  assert.equal(post.class, 'auto');
  assert.deepEqual(post.site_wide.config, { path: 'hugo.toml', exists: true });
  assert.ok(post.notes.some((n) => n.includes('layouts/partials/head.html')));

  const about = R.resolveRoute(repo('hugo'), '/company/about/');
  assert.equal(about.file, 'content/about.md', 'the `url:` in the front matter decides the URL');

  // a project without its own partial must be told to copy the theme one, never to edit themes/
  const files = R.scanProject(repo('hugo')).filter((f) => f !== 'layouts/partials/head.html');
  const copied = R.resolveRoute(repo('hugo'), '/posts/rain-shadow/', null, { files });
  assert.ok(copied.notes.some((n) => /never edit themes\//.test(n)));
  assert.ok(!R.scanProject(repo('hugo')).some((f) => f.startsWith('themes/')), 'themes/ is never scanned as project source');
});

test('Jekyll: a dated post file answers to its permalink and to its slug', () => {
  const dated = R.resolveRoute(repo('jekyll'), '/2026/01/14/rain-shadow.html');
  assert.equal(dated.framework, 'jekyll');
  assert.equal(dated.file, '_posts/2026-01-14-rain-shadow.md');
  assert.equal(dated.strategy, 'front-matter');
  assert.equal(dated.class, 'auto');

  const bySlug = R.resolveRoute(repo('jekyll'), '/rain-shadow');
  assert.equal(bySlug.file, '_posts/2026-01-14-rain-shadow.md');
  assert.ok(bySlug.notes.some((n) => n.includes('permalink style')));

  const home = R.resolveRoute(repo('jekyll'), '/');
  assert.equal(home.file, 'index.md');
  assert.deepEqual(home.site_wide.config, { path: '_config.yml', exists: true });
});

test('Static HTML: /about, /about/index.html and a flat .html page all resolve', () => {
  for (const url of ['/about', '/about/', '/about/index.html']) {
    assert.equal(R.resolveRoute(repo('static'), url).file, 'about/index.html', url);
  }
  const post = R.resolveRoute(repo('static'), '/blog/rain-shadow');
  assert.equal(post.file, 'blog/rain-shadow.html');
  assert.equal(post.strategy, 'html-head');
  assert.equal(post.class, 'auto');
  assert.deepEqual(post.site_wide.robots, { path: 'robots.txt', exists: true });
});

test('Gatsby: a page wins; a template is a low-confidence guess; a component is never offered', () => {
  const home = R.resolveRoute(repo('gatsby'), '/');
  assert.equal(home.file, 'src/pages/index.js');
  assert.equal(home.confidence, 'high');
  assert.ok(home.notes.some((n) => n.includes('Head exports work here')));

  const post = R.resolveRoute(repo('gatsby'), '/blog/rain-shadow');
  assert.equal(post.file, 'src/templates/post.js');
  assert.equal(post.confidence, 'low');
  assert.ok(post.notes.some((n) => /is a guess/.test(n)));

  assert.equal(R.isGatsbyHeadCapable('src/pages/index.js'), true);
  assert.equal(R.isGatsbyHeadCapable('src/templates/post.js'), true);
  assert.equal(R.isGatsbyHeadCapable('src/components/seo.js'), false, 'a Head export outside pages/templates does nothing');
});

test('detectFramework prefers the profile but records how sure it is', () => {
  const files = R.scanProject(repo('astro'));
  assert.equal(R.detectFramework(files).id, 'astro');
  assert.equal(R.detectFramework(files, { framework: { id: 'astro' } }).confidence, 'high');
  const disagree = R.detectFramework(files, { framework: { id: 'nextjs' } });
  assert.equal(disagree.id, 'nextjs');
  assert.equal(disagree.confidence, 'medium', 'a profile that disagrees with the files is not "high"');
  assert.equal(R.detectFramework([]).id, null);
});

test('an empty or unknown project resolves to nothing, with an actionable note', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cseo-route-'));
  try {
    writeFileSync(join(dir, 'notes.txt'), 'nothing to see');
    const r = R.resolveRoute(dir, '/anything');
    assert.equal(r.file, null);
    assert.equal(r.framework, null);
    assert.equal(r.confidence, 'none');
    assert.ok(r.notes.some((n) => n.includes('--project')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const missing = R.resolveRoute(join(tmpdir(), 'cseo-does-not-exist-' + Date.now()), '/');
  assert.equal(missing.file, null);
  assert.ok(missing.notes[0].includes('project root not found'));
});

test('scanProject skips build output and dependencies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cseo-scan-'));
  try {
    for (const d of ['node_modules/pkg', '.next/static', 'dist', 'src/pages']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, 'node_modules/pkg/index.js'), '');
    writeFileSync(join(dir, '.next/static/x.js'), '');
    writeFileSync(join(dir, 'dist/out.html'), '');
    writeFileSync(join(dir, 'src/pages/index.astro'), '');
    const files = R.scanProject(dir);
    assert.deepEqual(files, ['src/pages/index.astro']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('matchPattern scores static above dynamic above catch-all', () => {
  const segs = ['blog', 'x'];
  const statics = R.matchPattern([{ kind: 'static', value: 'blog' }, { kind: 'static', value: 'x' }], segs);
  const dynamic = R.matchPattern([{ kind: 'static', value: 'blog' }, { kind: 'dynamic', name: 'slug' }], segs);
  const catchall = R.matchPattern([{ kind: 'static', value: 'blog' }, { kind: 'catchall', name: 'rest' }], segs);
  assert.ok(statics.score > dynamic.score && dynamic.score > catchall.score);
  assert.equal(R.matchPattern([{ kind: 'catchall', name: 'r' }], []).ok, false, 'a catch-all needs at least one segment');
  assert.equal(R.matchPattern([{ kind: 'optional-catchall', name: 'r' }], []).ok, true);
});

test('the platform fixtures used by the detector resolve too (no repo shape is left behind)', () => {
  const P = join(ROOT, 'tests', 'fixtures', 'platforms');
  assert.equal(R.resolveRoute(join(P, 'nextjs-app', 'repo'), '/pricing').file, 'app/pricing/page.tsx');
  assert.equal(R.resolveRoute(join(P, 'nextjs-pages', 'repo'), '/quickstart').file, 'pages/quickstart.tsx');
  assert.equal(R.resolveRoute(join(P, 'astro', 'repo'), '/onboarding').file, 'src/pages/onboarding.astro');
  assert.equal(R.resolveRoute(join(P, 'sveltekit', 'repo'), '/changelog').file, 'src/routes/changelog/+page.svelte');
  assert.equal(R.resolveRoute(join(P, 'hugo', 'repo'), '/posts/rain-shadow/').file, 'content/posts/rain-shadow.md');
  assert.equal(R.resolveRoute(join(P, 'jekyll', 'repo'), '/rain-shadow').file, '_posts/2026-01-14-rain-shadow.md');
  assert.equal(R.resolveRoute(join(P, 'static', 'repo'), '/about').file, 'about/index.html');
});

// Unit tests for scripts/lib/renderers.mjs — the pure parts (render decision, delta), browser lookup
// order with an env override, Playwright detection without the package, and renderWithChrome's error
// path on a missing binary. The real Chrome run lives in tests/e2e/snapshot.test.mjs (skipped when absent).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from '../../scripts/lib/html.mjs';
import {
  needsRender, renderDelta, findChrome, playwrightAvailable, playwrightCachePaths, renderWithChrome, PLAYWRIGHT_HINT, CHROME_HINT,
  RENDER_WORD_THRESHOLD, FRAMEWORK_WORD_THRESHOLD,
} from '../../scripts/lib/renderers.mjs';

const doc = (over = {}) => ({
  word_count: 500, headings: [{ level: 1, text: 'Title' }, { level: 2, text: 'Sub' }], anchors: new Array(6).fill({ href: '/x' }),
  markers: { next_data: false, nuxt: false, reactroot: false, next_root_empty: null, app_root_empty: null, angular: false, sveltekit: false, astro: false, remix: false, noscript_js_notice: false, generator: null },
  ...over,
});

test('needsRender: a content-rich static page needs no render', () => {
  const r = needsRender(doc());
  assert.equal(r.needed, false);
  assert.deepEqual(r.signals, []);
  assert.deepEqual(r.markers, []);
  assert.equal(r.word_count, 500);
});

test('needsRender signals: thin text, empty framework roots, hydration markers, no h1 + few links, noscript notice', () => {
  assert.deepEqual(needsRender(doc({ word_count: RENDER_WORD_THRESHOLD - 1 })).signals, ['low_word_count']);
  assert.deepEqual(needsRender(doc({ markers: { ...doc().markers, next_root_empty: true } })).signals, ['next_root_empty']);
  assert.deepEqual(needsRender(doc({ markers: { ...doc().markers, app_root_empty: true } })).signals, ['app_root_empty']);
  const fw = needsRender(doc({ word_count: FRAMEWORK_WORD_THRESHOLD - 1, markers: { ...doc().markers, next_data: true, reactroot: true } }));
  assert.deepEqual(fw.signals, ['hydration_markers']);
  assert.deepEqual(fw.markers, ['next_data', 'reactroot']);
  const ssr = needsRender(doc({ word_count: 1200, markers: { ...doc().markers, next_data: true } }));
  assert.equal(ssr.needed, false, 'a framework marker alone on a text-rich SSR page does not force a render');
  assert.deepEqual(ssr.markers, ['next_data'], 'but the marker is still reported');
  assert.deepEqual(needsRender(doc({ headings: [{ level: 2, text: 'x' }], anchors: [{}, {}] })).signals, ['no_h1_few_anchors']);
  assert.deepEqual(needsRender(doc({ headings: [{ level: 1, text: 'x', aria: true }], anchors: [] })).signals, ['no_h1_few_anchors'], 'aria pseudo-headings do not count as an h1');
  assert.deepEqual(needsRender(doc({ markers: { ...doc().markers, noscript_js_notice: true } })).signals, ['noscript_js_notice']);
  const empty = needsRender(null);
  assert.equal(empty.needed, true);
  assert.ok(empty.signals.includes('low_word_count'));
});

test('needsRender on a real parse: a JS shell is flagged, a static article is not', () => {
  const shell = parseDocument('<html><head><title>App</title></head><body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript><script src="/static/js/main.js"></script></body></html>');
  const r = needsRender(shell);
  assert.equal(r.needed, true);
  assert.ok(r.signals.includes('app_root_empty'), r.signals.join(','));
  assert.ok(r.signals.includes('noscript_js_notice'));
  const words = new Array(300).fill('word').join(' ');
  const article = parseDocument(`<html><body><main><h1>Title</h1><p>${words}</p><a href="/a">a</a><a href="/b">b</a><a href="/c">c</a></main></body></html>`);
  assert.equal(needsRender(article).needed, false);
});

test('renderDelta counts what only the rendered DOM has', () => {
  const raw = parseDocument('<html><head><title>T</title></head><body><h2>Sub</h2><a href="/a">a</a></body></html>', 'https://x.test/');
  const rendered = parseDocument('<html><head><title>T2</title><link rel="canonical" href="/c"></head><body><h1>Hydrated</h1><h2>Sub</h2><a href="/a">a</a><a href="/b">b</a><img src="/i.png"><script type="application/ld+json">{"@type":"Article"}</script><p>more words here now</p></body></html>', 'https://x.test/');
  const d = renderDelta(raw, rendered);
  assert.equal(d.headings, 1);
  assert.equal(d.h1_added, true);
  assert.equal(d.anchors, 1);
  assert.equal(d.images, 1);
  assert.equal(d.jsonld_blocks, 1);
  assert.ok(d.words >= 3, 'words ' + d.words);
  assert.equal(d.title_changed, true);
  assert.equal(d.canonical_changed, true);
  assert.equal(d.meaningful, true);
  const same = renderDelta(raw, raw);
  assert.deepEqual(same, { headings: 0, h1_added: false, anchors: 0, images: 0, jsonld_blocks: 0, words: 0, title_changed: false, canonical_changed: false, meaningful: false });
  assert.equal(renderDelta(null, null).meaningful, false);
});

test('findChrome honours the env override first and only returns existing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cseo-chrome-'));
  const fake = join(dir, 'fake-chrome');
  writeFileSync(fake, '#!/bin/sh\n');
  const hit = findChrome({ env: { CLAUDE_SEO_AI_CHROME: fake, PATH: dir, HOME: dir }, platform: process.platform });
  assert.deepEqual(hit, { path: fake, source: 'env:CLAUDE_SEO_AI_CHROME' });
  const second = findChrome({ env: { CLAUDE_SEO_AI_CHROME: join(dir, 'missing'), CHROME_PATH: fake, PATH: dir, HOME: dir }, platform: process.platform });
  assert.deepEqual(second, { path: fake, source: 'env:CHROME_PATH' }, 'a dangling first override falls through to the next');
  const third = findChrome({ env: { PUPPETEER_EXECUTABLE_PATH: fake, PATH: dir, HOME: dir }, platform: process.platform });
  assert.equal(third.source, 'env:PUPPETEER_EXECUTABLE_PATH');
  assert.equal(typeof CHROME_HINT, 'string');
});

test('playwrightCachePaths enumerates Playwright browser downloads (full browsers before headless shells)', () => {
  const home = mkdtempSync(join(tmpdir(), 'cseo-pw-'));
  const cache = join(home, 'Library', 'Caches', 'ms-playwright');
  const full = join(cache, 'chromium-1234', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS');
  const shell = join(cache, 'chromium_headless_shell-1234', 'chrome-headless-shell-mac-arm64');
  mkdirSync(full, { recursive: true }); mkdirSync(shell, { recursive: true });
  writeFileSync(join(full, 'Google Chrome for Testing'), '');
  writeFileSync(join(shell, 'chrome-headless-shell'), '');
  const paths = playwrightCachePaths({ platform: 'darwin', env: { HOME: home } });
  assert.equal(paths[0], join(full, 'Google Chrome for Testing'));
  assert.ok(paths.includes(join(shell, 'chrome-headless-shell')));
  assert.ok(paths.indexOf(join(full, 'Google Chrome for Testing')) < paths.indexOf(join(shell, 'chrome-headless-shell')));
  const linux = playwrightCachePaths({ platform: 'linux', env: { HOME: home, PLAYWRIGHT_BROWSERS_PATH: cache } });
  assert.ok(linux.some((p) => p.endsWith(join('chrome-mac-arm64', 'chrome'))), 'PLAYWRIGHT_BROWSERS_PATH is honoured');
  assert.deepEqual(playwrightCachePaths({ platform: 'linux', env: { HOME: join(home, 'nothing') } }), []);
});

test('playwrightAvailable is false (with the install hint) when the package is not resolvable — never installs', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cseo-nopw-'));
  const r = playwrightAvailable({ cwd, env: { CLAUDE_PLUGIN_DATA: join(cwd, 'data') } });
  assert.equal(r.available, false);
  assert.equal(r.path, null);
  assert.equal(r.hint, PLAYWRIGHT_HINT);
  assert.match(PLAYWRIGHT_HINT, /npx playwright install chromium/);
  assert.match(PLAYWRIGHT_HINT, /--rendered-file/);
});

test('renderWithChrome reports a missing binary as ok:false without throwing and cleans up its temp profile', async () => {
  const r = await renderWithChrome(join(tmpdir(), 'definitely-not-a-browser-' + Date.now()), 'about:blank', { timeoutMs: 5000 });
  assert.equal(r.ok, false);
  assert.equal(r.html, '');
  assert.match(r.error, /spawn failed/);
  assert.equal(r.exit, 'spawn-error');
  assert.equal(typeof r.ms, 'number');
});

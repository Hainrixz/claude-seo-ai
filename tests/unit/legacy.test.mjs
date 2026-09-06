// The original 30 smoke assertions (v0.1.0 tests/run.mjs), ported unchanged to node:test.
// Each script is spawned as a CLI against tests/fixtures — no network required.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const FIX = resolve(ROOT, 'tests', 'fixtures');
const POST = resolve(FIX, 'blog-post.html');
const ROBOTS = resolve(FIX, 'robots.txt');
const FINDINGS = resolve(FIX, 'sample-findings.json');

function run(script, args) {
  const out = execFileSync(process.execPath, [resolve(ROOT, 'scripts', script), ...args], { encoding: 'utf8' });
  return JSON.parse(out);
}
// Spawn each script once per file, lazily, so a spawn failure fails only the tests that need it.
function memo(fn) { let v, done = false; return () => { if (!done) { v = fn(); done = true; } return v; }; }

const ph = memo(() => run('parse-html.mjs', ['--file', POST]));
const jl = memo(() => run('validate-jsonld.mjs', ['--file', POST]));
const ab = memo(() => run('check-answerblocks.mjs', ['--file', POST]));
const fd = memo(() => run('factdensity.mjs', ['--file', POST]));
const fr = memo(() => run('check-freshness.mjs', ['--file', POST]));
const hf = memo(() => run('hreflang-check.mjs', ['--file', POST, '--url', 'https://example.com/blog/ai-search-2026']));
const lg = memo(() => run('link-graph.mjs', ['--file', POST, '--base', 'https://example.com/blog/ai-search-2026']));
const rs = memo(() => run('parse-robots-sitemap.mjs', ['--file', ROBOTS]));
const sc = memo(() => run('score.mjs', ['--findings', FINDINGS]));

describe('parse-html.mjs', () => {
  it('title length 37', () => assert.equal(ph().title.length, 37));
  it('viewport missing', () => assert.equal(ph().head_hygiene.viewport, false));
  it('1 H1', () => assert.equal(ph().headings.h1_count, 1));
  it('1 missing alt', () => assert.equal(ph().images.missing_alt, 1));
  it('1 generic anchor', () => assert.equal(ph().links.generic_anchors, 1));
  it('og:image null', () => assert.equal(ph().open_graph.image, null));
});

describe('validate-jsonld.mjs', () => {
  it('1 block, valid', () => { assert.equal(jl().blocks_found, 1); assert.equal(jl().invalid_json_blocks, 0); });
  it('BlogPosting present', () => assert.ok(jl().types_present.includes('BlogPosting')));
  it('missing dateModified', () => assert.ok(jl().nodes[0].missing_recommended.includes('BlogPosting.dateModified')));
  it('required all present', () => assert.equal(jl().nodes[0].missing_required.length, 0));
});

describe('check-answerblocks.mjs', () => {
  it('>=1 question heading w/o answer', () => assert.ok(ab().question_headings_without_direct_answer >= 1));
  it('anaphora detected', () => assert.ok(ab().anaphora_openers >= 1));
});

describe('factdensity.mjs', () => {
  it('original-data signal', () => assert.equal(fd().original_data_signal, true));
  it('numeric tokens > 0', () => assert.ok(fd().numeric_tokens > 0));
  it('authority outbound >= 1', () => assert.ok(fd().authoritative_outbound_links >= 1));
});

describe('check-freshness.mjs', () => {
  it('datePublished found', () => assert.equal(fr().schema_datePublished, '2026-01-10'));
  it('no dateModified', () => assert.equal(fr().has_dateModified, false));
});

describe('hreflang-check.mjs', () => {
  it('2 hreflang entries', () => assert.equal(hf().hreflang_count, 2));
  it('no x-default', () => assert.equal(hf().has_x_default, false));
  it('self-referenced', () => assert.equal(hf().self_referenced, true));
});

describe('link-graph.mjs', () => {
  it('2 internal links', () => assert.equal(lg().internal_unique, 2));
  it('1 external link', () => assert.equal(lg().external_unique, 1));
});

describe('parse-robots-sitemap.mjs', () => {
  it('GPTBot blocked', () => assert.equal(rs().ai_posture.training.GPTBot, 'blocked'));
  it('OAI-SearchBot allowed', () => assert.equal(rs().ai_posture.retrieval['OAI-SearchBot'], 'allowed'));
  it('sitemap declared', () => assert.equal(rs().sitemaps_declared.length, 1));
  it('flags blocked render assets', () => assert.equal(rs().may_block_render_assets, true));
});

describe('score.mjs', () => {
  it('search band F', () => assert.equal(sc().search_seo.band, 'F', 'got ' + sc().search_seo.band + ' ' + sc().search_seo.value));
  it('ai band F', () => assert.equal(sc().ai_visibility.band, 'F', 'got ' + sc().ai_visibility.band + ' ' + sc().ai_visibility.value));
  it('1 needs_api in search', () => assert.equal(sc().search_seo.needs_api_count, 1));
  it('AI discovery & agent endpoints (M21) category weight 0', () => assert.equal((sc().ai_visibility.categories.find((c) => c.name === 'AI discovery & agent endpoints') || {}).weight, 0));
});

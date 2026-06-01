#!/usr/bin/env node
// Smoke + assertion tests for the bundled verification scripts. Runs each file-based
// script against tests/fixtures and asserts key outputs. No network required.
//
// Usage: node tests/run.mjs   (from the repo root)

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const FIX = resolve(here, 'fixtures');
const POST = resolve(FIX, 'blog-post.html');
const ROBOTS = resolve(FIX, 'robots.txt');
const FINDINGS = resolve(FIX, 'sample-findings.json');

let pass = 0, fail = 0;
function run(script, args) {
  const out = execFileSync('node', [resolve(ROOT, 'scripts', script), ...args], { encoding: 'utf8' });
  return JSON.parse(out);
}
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

try {
  console.log('parse-html.mjs');
  const ph = run('parse-html.mjs', ['--file', POST]);
  check('title length 37', ph.title.length === 37, 'got ' + ph.title.length);
  check('viewport missing', ph.head_hygiene.viewport === false);
  check('1 H1', ph.headings.h1_count === 1);
  check('1 missing alt', ph.images.missing_alt === 1, 'got ' + ph.images.missing_alt);
  check('1 generic anchor', ph.links.generic_anchors === 1);
  check('og:image null', ph.open_graph.image === null);

  console.log('validate-jsonld.mjs');
  const jl = run('validate-jsonld.mjs', ['--file', POST]);
  check('1 block, valid', jl.blocks_found === 1 && jl.invalid_json_blocks === 0);
  check('BlogPosting present', jl.types_present.includes('BlogPosting'));
  check('missing dateModified', jl.nodes[0].missing_recommended.includes('BlogPosting.dateModified'));
  check('required all present', jl.nodes[0].missing_required.length === 0);

  console.log('check-answerblocks.mjs');
  const ab = run('check-answerblocks.mjs', ['--file', POST]);
  check('>=1 question heading w/o answer', ab.question_headings_without_direct_answer >= 1);
  check('anaphora detected', ab.anaphora_openers >= 1);

  console.log('factdensity.mjs');
  const fd = run('factdensity.mjs', ['--file', POST]);
  check('original-data signal', fd.original_data_signal === true);
  check('numeric tokens > 0', fd.numeric_tokens > 0);
  check('authority outbound >= 1', fd.authoritative_outbound_links >= 1);

  console.log('check-freshness.mjs');
  const fr = run('check-freshness.mjs', ['--file', POST]);
  check('datePublished found', fr.schema_datePublished === '2026-01-10');
  check('no dateModified', fr.has_dateModified === false);

  console.log('hreflang-check.mjs');
  const hf = run('hreflang-check.mjs', ['--file', POST, '--url', 'https://example.com/blog/ai-search-2026']);
  check('2 hreflang entries', hf.hreflang_count === 2);
  check('no x-default', hf.has_x_default === false);
  check('self-referenced', hf.self_referenced === true);

  console.log('link-graph.mjs');
  const lg = run('link-graph.mjs', ['--file', POST, '--base', 'https://example.com/blog/ai-search-2026']);
  check('2 internal links', lg.internal_unique === 2);
  check('1 external link', lg.external_unique === 1);

  console.log('parse-robots-sitemap.mjs');
  const rs = run('parse-robots-sitemap.mjs', ['--file', ROBOTS]);
  check('GPTBot blocked', rs.ai_posture.training.GPTBot === 'blocked');
  check('OAI-SearchBot allowed', rs.ai_posture.retrieval['OAI-SearchBot'] === 'allowed');
  check('sitemap declared', rs.sitemaps_declared.length === 1);
  check('flags blocked render assets', rs.may_block_render_assets === true);

  console.log('score.mjs');
  const sc = run('score.mjs', ['--findings', FINDINGS]);
  check('search band F', sc.search_seo.band === 'F', 'got ' + sc.search_seo.band + ' ' + sc.search_seo.value);
  check('ai band F', sc.ai_visibility.band === 'F', 'got ' + sc.ai_visibility.band + ' ' + sc.ai_visibility.value);
  check('1 needs_api in search', sc.search_seo.needs_api_count === 1);
  check('llms.txt category weight 0', (sc.ai_visibility.categories.find((c) => c.name === 'llms.txt') || {}).weight === 0);
} catch (e) {
  console.error('\nERROR running tests:', e && e.message || e);
  process.exit(1);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

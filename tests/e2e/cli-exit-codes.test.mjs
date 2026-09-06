// End-to-end exit-code taxonomy of the CLI scripts (EXIT.OK=0, USAGE=1, RUNTIME=2).
// Spawns real processes. The only "network" is a connection to a just-closed loopback port,
// which fails immediately with ECONNREFUSED — nothing leaves the machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const S = (name) => join(ROOT, 'scripts', name);
const POST = join(ROOT, 'tests', 'fixtures', 'blog-post.html');

function cli(script, args = [], input = '') {
  const r = spawnSync(process.execPath, [S(script), ...args], { encoding: 'utf8', input });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* leave null */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function closedLoopbackPort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => res(port)); });
  });
}

test('USAGE (1): parse-html with no input', () => {
  const r = cli('parse-html.mjs');
  assert.equal(r.status, 1);
  assert.equal(r.json.error, 'provide --url <u> or --file <path>');
});

test('USAGE (1): parse-html with an unreadable --file', () => {
  const r = cli('parse-html.mjs', ['--file', join(ROOT, 'tests', 'fixtures', 'nope.html')]);
  assert.equal(r.status, 1);
  assert.match(r.json.error, /ENOENT/);
});

test('RUNTIME (2): parse-html --url against a closed loopback port', async () => {
  const port = await closedLoopbackPort();
  const r = cli('parse-html.mjs', ['--url', `http://127.0.0.1:${port}/`]);
  assert.equal(r.status, 2, 'stderr: ' + r.stderr);
  assert.equal(typeof r.json.error, 'string');
});

test('OK (0): parse-html --file reports source file, status null (documented fix)', () => {
  const r = cli('parse-html.mjs', ['--file', POST]);
  assert.equal(r.status, 0);
  assert.equal(r.json.source, 'file');
  assert.equal(r.json.status, null);
});

test('OK (0): --k=v form and repeated --type filter work end to end', () => {
  const r = cli('validate-jsonld.mjs', [`--file=${POST}`, '--type', 'Person', '--type', 'BlogPosting']);
  assert.equal(r.status, 0);
  // Nested nodes are flattened too (defect 13): the BlogPosting root and its Person author both match.
  assert.equal(r.json.nodes.length, 2);
  assert.deepEqual(r.json.nodes.map((n) => [n.path, n.types]), [['BlogPosting', ['BlogPosting']], ['BlogPosting.author', ['Person']]]);
  const none = cli('validate-jsonld.mjs', [`--file=${POST}`, '--type', 'Recipe']);
  assert.equal(none.status, 0);
  assert.equal(none.json.nodes.length, 0);
  assert.equal(none.json.blocks_found, 1, 'top-level counts are unaffected by --type');
});

test('USAGE (1): psi-client without --url reports needs_api', () => {
  const r = cli('psi-client.mjs');
  assert.equal(r.status, 1);
  assert.deepEqual(r.json, { status: 'needs_api', error: 'provide --url' });
});

test('USAGE (1): link-graph --file without --base', () => {
  const r = cli('link-graph.mjs', ['--file', POST]);
  assert.equal(r.status, 1);
  assert.match(r.json.error, /--base/);
});

test('USAGE (1): score with an unreadable --findings, with invalid JSON on stdin, and with empty stdin', () => {
  const missing = cli('score.mjs', ['--findings', join(ROOT, 'tests', 'fixtures', 'nope.json')]);
  assert.equal(missing.status, 1);
  assert.match(missing.json.error, /could not read findings/);
  const bad = cli('score.mjs', [], '{not json');
  assert.equal(bad.status, 1);
  assert.match(bad.json.error, /invalid JSON/);
  const empty = cli('score.mjs', [], '');
  assert.equal(empty.status, 1);
  assert.match(empty.json.error, /no findings input/);
});

test('OK (0): score reads findings from stdin', () => {
  const r = cli('score.mjs', [], '[]');
  assert.equal(r.status, 0);
  assert.equal(r.json.findings_count, 0);
  assert.equal(r.json.search_seo.band, 'unscored'); // no active category => unscored, never a fabricated F
  assert.equal(r.json.search_seo.value, null);
});

test('USAGE (1): parse-robots-sitemap with no target or a scheme-less --url', () => {
  const none = cli('parse-robots-sitemap.mjs');
  assert.equal(none.status, 1);
  assert.match(none.json.error, /provide --url/);
  const bad = cli('parse-robots-sitemap.mjs', ['--url', 'example.com']);
  assert.equal(bad.status, 1);
  assert.match(bad.json.error, /invalid --url/);
});

test('RUNTIME (2): parse-robots-sitemap --robots against a closed loopback port', async () => {
  const port = await closedLoopbackPort();
  const r = cli('parse-robots-sitemap.mjs', ['--robots', `http://127.0.0.1:${port}/robots.txt`]);
  assert.equal(r.status, 2);
  assert.equal(r.json.error, 'fetch failed');
  assert.equal(r.json.status, 0);
});

test('every CLI error result is JSON on stdout with an `error` string', () => {
  for (const [script, args] of [['parse-html.mjs', []], ['check-answerblocks.mjs', []], ['factdensity.mjs', []],
    ['check-freshness.mjs', []], ['hreflang-check.mjs', []], ['validate-jsonld.mjs', []], ['link-graph.mjs', []]]) {
    const r = cli(script, args);
    assert.equal(r.status, 1, script + ' exit');
    assert.equal(typeof (r.json && r.json.error), 'string', script + ' stdout: ' + r.stdout);
  }
});

// Unit tests for the shared CLI plumbing in scripts/lib/util.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const util = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'util.mjs')).href);
const { parseArgs, emit, runCli, isMain, inputFailure, loadInput, credential, EXIT } = util;

/** Run fn with stdout captured and process.exitCode restored afterwards. */
async function captured(fn) {
  const prevExit = process.exitCode;
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  let exitCode;
  try { await fn(); exitCode = process.exitCode; }
  finally { process.stdout.write = orig; process.exitCode = prevExit; }
  return { stdout: chunks.join(''), exitCode };
}

test('parseArgs: legacy forms unchanged (--flag value, bare --flag, positionals)', () => {
  assert.deepEqual(parseArgs(['--file', 'x.html', '--deep', '--url', 'https://e.com', 'pos']),
    { _: ['pos'], file: 'x.html', deep: true, url: 'https://e.com' });
  assert.deepEqual(parseArgs([]), { _: [] });
});

test('parseArgs: --k=v, --no-x, repeated flags -> array, -- terminator', () => {
  const p = parseArgs(['--a=1', '--b=x=y', '--no-persist', '--type', 'A', '--type', 'B', '--type', 'C', '--', '--literal']);
  assert.equal(p.a, '1');
  assert.equal(p.b, 'x=y');
  assert.equal(p.persist, false);
  assert.deepEqual(p.type, ['A', 'B', 'C']);
  assert.deepEqual(p._, ['--literal']);
  assert.equal(parseArgs(['--empty=']).empty, '');
});

test('emit writes pretty JSON, sets process.exitCode, returns the object, never exits', async () => {
  const obj = { a: 1 };
  let ret;
  const r = await captured(() => { ret = emit(obj, 3); });
  assert.equal(ret, obj);
  assert.equal(r.stdout, JSON.stringify(obj, null, 2) + '\n');
  assert.equal(r.exitCode, 3);
});

test('runCli emits result with the returned code', async () => {
  const r = await captured(() => runCli(async (args) => ({ result: { got: args.x }, code: EXIT.THRESHOLD }), ['--x', '7']));
  assert.deepEqual(JSON.parse(r.stdout), { got: '7' });
  assert.equal(r.exitCode, EXIT.THRESHOLD);
});

test('runCli maps a thrown error to {error} with EXIT.RUNTIME', async () => {
  const r = await captured(() => runCli(async () => { throw new Error('boom'); }, []));
  assert.deepEqual(JSON.parse(r.stdout), { error: 'boom' });
  assert.equal(r.exitCode, EXIT.RUNTIME);
});

test('runCli tolerates a main() that returns a bare object (code 0)', async () => {
  const r = await captured(() => runCli(async () => ({ plain: true }), []));
  assert.deepEqual(JSON.parse(r.stdout), { plain: true });
  assert.equal(r.exitCode, 0);
});

test('isMain matches the process entry file exactly (symlink-safe) and never throws', () => {
  // Under node:test's run()/--test each file is argv[1] of its own child process, so
  // isMain(import.meta.url) is legitimately true there and false when imported in-process.
  const entry = process.argv[1] ? realpathSync(process.argv[1]) : null;
  const thisFile = realpathSync(fileURLToPath(import.meta.url));
  assert.equal(isMain(import.meta.url), entry === thisFile);
  if (entry) assert.equal(isMain(pathToFileURL(entry).href), true);
  assert.equal(isMain(pathToFileURL(join(ROOT, 'scripts', 'lib', 'util.mjs')).href), false, 'an imported library is never main');
  assert.equal(isMain('file:///definitely/not/here.mjs'), false);
  assert.equal(isMain(undefined), false);
});

test('credential(): CLAUDE_PLUGIN_OPTION_<KEY> wins over <KEY>, and blanks are not values', () => {
  assert.equal(credential('PSI_API_KEY', { PSI_API_KEY: 'plain' }), 'plain');
  assert.equal(credential('PSI_API_KEY', { CLAUDE_PLUGIN_OPTION_PSI_API_KEY: 'from-plugin', PSI_API_KEY: 'plain' }), 'from-plugin');
  assert.equal(credential('PSI_API_KEY', { CLAUDE_PLUGIN_OPTION_PSI_API_KEY: '   ', PSI_API_KEY: 'plain' }), 'plain',
    'a blank plugin option falls through instead of masking the env var');
  assert.equal(credential('PSI_API_KEY', { PSI_API_KEY: '  spaced  ' }), 'spaced');
  assert.equal(credential('PSI_API_KEY', {}), null);
  assert.equal(credential('PSI_API_KEY', { PSI_API_KEY: 42 }), null, 'a non-string is not a credential');
});

test('EXIT taxonomy is frozen', () => {
  assert.deepEqual({ ...EXIT }, { OK: 0, USAGE: 1, RUNTIME: 2, THRESHOLD: 3 });
  assert.ok(Object.isFrozen(EXIT));
});

test('loadInput --file reports status null and empty headers (no fabricated 200)', async () => {
  const input = await loadInput({ file: join(ROOT, 'tests', 'fixtures', 'blog-post.html') });
  assert.equal(input.source, 'file');
  assert.equal(input.status, null);
  assert.deepEqual(input.headers, {});
  assert.equal(input.error, null);
  assert.ok(input.html.includes('<title>'));
});

test('inputFailure: none/file -> USAGE, url -> RUNTIME, usable -> null', async () => {
  const none = await loadInput({});
  assert.deepEqual(inputFailure(none), { result: { error: 'provide --url <u> or --file <path>' }, code: EXIT.USAGE });
  const missing = await loadInput({ file: join(ROOT, 'tests', 'fixtures', 'does-not-exist.html') });
  assert.equal(inputFailure(missing).code, EXIT.USAGE);
  assert.equal(inputFailure({ source: 'url', html: '', error: 'fetch failed' }).code, EXIT.RUNTIME);
  assert.equal(inputFailure({ source: 'file', html: '<p>x</p>', error: null }), null);
});

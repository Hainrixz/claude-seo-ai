// Every CLI script must be importable as a module with no side effects (no output, no exit,
// no exit code) and must export `main`. Also checks the CLI error contract of score.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = join(ROOT, 'scripts');
// The two PreToolUse hooks read stdin and call process.exit by design — the exit code IS their
// contract with the hook runner, so they export pure helpers instead of main()/runCli().
// tests/unit/guards.test.mjs covers them, including that importing one has no side effects.
const EXCLUDE = new Set(['guard-write.mjs', 'guard-bash.mjs']);
const scripts = readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs') && !EXCLUDE.has(f)).sort();

test('discovers the CLI scripts', () => {
  assert.ok(scripts.length >= 10, 'expected at least the 10 legacy scripts, found ' + scripts.length);
  for (const must of ['parse-html.mjs', 'score.mjs', 'psi-client.mjs', 'check.mjs']) assert.ok(scripts.includes(must), 'missing ' + must);
});

for (const file of scripts) {
  test(`import scripts/${file} has no side effects and exports main()`, async () => {
    const prevExitCode = process.exitCode;
    const written = [];
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk, ...rest) => { written.push(String(chunk)); return true; };
    let mod;
    try {
      mod = await import(pathToFileURL(join(SCRIPTS, file)).href);
    } finally {
      process.stdout.write = origWrite;
    }
    // If we got here the process is still alive: nothing called process.exit at import time.
    assert.equal(typeof mod.main, 'function', file + ' must export async function main(args)');
    assert.equal(mod.main.constructor.name, 'AsyncFunction', file + ' main must be async');
    assert.deepEqual(written, [], file + ' must not write to stdout on import');
    assert.equal(process.exitCode, prevExitCode, file + ' must not set process.exitCode on import');
  });
}

test('lib/util.mjs exports the CLI contract and legacy helpers', async () => {
  const u = await import(pathToFileURL(join(SCRIPTS, 'lib', 'util.mjs')).href);
  for (const name of ['parseArgs', 'emit', 'isMain', 'runCli', 'inputFailure', 'fetchText', 'loadInput', 'stripTags',
    'decodeEntities', 'getTitle', 'getMetaName', 'getMetaProperty', 'getLinkRel', 'getHtmlLang', 'getCharset',
    'getHeadings', 'getImages', 'getLinks', 'getJsonLd', 'isBcp47']) {
    assert.equal(typeof u[name], 'function', 'util.mjs must export ' + name);
  }
  assert.deepEqual({ ...u.EXIT }, { OK: 0, USAGE: 1, RUNTIME: 2, THRESHOLD: 3 });
  // Scripts are never argv[1] when a test imports them, so isMain() must be false for every one of them.
  for (const file of scripts) assert.equal(u.isMain(pathToFileURL(join(SCRIPTS, file)).href), false, file + ' must not think it is main');
  const entry = process.argv[1] ? realpathSync(process.argv[1]) : null;
  assert.equal(u.isMain(import.meta.url), entry === realpathSync(fileURLToPath(import.meta.url)));
});

test('no CLI script calls process.exit (only the guard hook may)', () => {
  for (const file of scripts) {
    const src = readFileSync(join(SCRIPTS, file), 'utf8');
    assert.ok(!/process\.exit\s*\(/.test(src), file + ' must not call process.exit');
    assert.ok(/if \(isMain\(import\.meta\.url\)\) runCli\(main\)/.test(src), file + ' must end with the isMain/runCli guard');
  }
  const util = readFileSync(join(SCRIPTS, 'lib', 'util.mjs'), 'utf8');
  assert.ok(!/process\.exit\s*\(/.test(util), 'lib/util.mjs must not call process.exit');
});
/** Every .mjs under scripts/, recursively. */
function allScriptFiles(dir = SCRIPTS) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allScriptFiles(path));
    else if (entry.name.endsWith('.mjs')) out.push(path);
  }
  return out;
}

/** `psi-key`, `api_key`, `token`, `adminToken`… — a flag name that would carry a secret. */
const CREDENTIAL_SHAPED = (name) =>
  /(?:^|[-_])(?:key|token|secret|password|passwd|credential|credentials|auth)$/i.test(name) ||
  /[a-z0-9](?:Key|Token|Secret|Password)$/.test(name);

test('no script reads a credential from argv — secrets come from the environment only', () => {
  // A secret passed as a flag lands in `ps`, in shell history and in every command log, and these
  // scripts print the command to re-run. The documented path is CLAUDE_PLUGIN_OPTION_<KEY> then
  // <KEY>, read through lib/util.mjs credential(). This asserts the door stays shut.
  const reads = /args\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])|\b(?:str|int|oneOf)\(\s*['"]([^'"]+)['"]/g;
  const offenders = [];
  for (const file of allScriptFiles()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(reads)) {
      const name = m[1] || m[2] || m[3];
      if (name && CREDENTIAL_SHAPED(name)) offenders.push(file.slice(ROOT.length + 1) + ': ' + name);
    }
  }
  assert.deepEqual(offenders, [], 'credential-shaped CLI flags: ' + offenders.join(', '));
  // Guard the guard: the matcher must actually recognise the shapes it is looking for.
  assert.ok(['psi-key', 'api_key', 'token', 'adminToken', 'PSI_API_KEY'].every(CREDENTIAL_SHAPED));
  assert.ok(!['keyword', 'tokens', 'monkey', 'render'].some(CREDENTIAL_SHAPED));
});

test('node scripts/score.mjs with no args exits non-zero with a JSON error on stdout', () => {
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'score.mjs')], { encoding: 'utf8', input: '' });
  assert.notEqual(r.status, 0, 'exit code must be non-zero');
  assert.equal(r.status, 1, 'missing input is a USAGE error (1)');
  let out;
  assert.doesNotThrow(() => { out = JSON.parse(r.stdout); }, 'stdout must be JSON, got: ' + r.stdout);
  assert.equal(typeof out.error, 'string');
  assert.ok(out.error.length > 0);
});

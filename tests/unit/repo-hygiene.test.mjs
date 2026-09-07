// Repo-side contracts that only exist in the *committed* tree, so a green local run cannot vouch
// for them on its own.
//
// The line-ending fix has two halves: the readers are CRLF-tolerant (html.mjs, frontmatter.mjs,
// adapters/instructions.mjs — proven by their own tests on a fully CRLF working tree), and
// `.gitattributes` pins every text file to LF so the GitHub Windows runner never produces one in
// the first place. The second half is inert while the file is untracked: a clone reads
// .gitattributes from the committed tree, not from someone's working copy. The same trap swallowed
// tests/helpers/import-probe.mjs, which the importability suite spawns — an untracked helper is a
// suite that only passes on the machine that wrote it.
//
// Skipped, never failed, outside a git checkout: the plugin also ships as an unpacked directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Run git in the repo root. Returns null when git is missing or this is not a checkout. */
function git(...args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

const IS_CHECKOUT = existsSync(join(ROOT, '.git')) && git('rev-parse', '--git-dir') !== null;

test('.gitattributes pins every text file to LF', () => {
  const file = join(ROOT, '.gitattributes');
  assert.ok(existsSync(file), '.gitattributes is missing; a Windows checkout with autocrlf=true would rewrite every fixture to CRLF');
  const body = readFileSync(file, 'utf8');
  assert.match(body, /^\*\s+text=auto\s+eol=lf$/m, '.gitattributes must set `* text=auto eol=lf`');
  for (const ext of ['mjs', 'md', 'json', 'html', 'txt', 'xml']) {
    assert.match(body, new RegExp('^\\*\\.' + ext + '\\s+text\\s+eol=lf$', 'm'), '*.' + ext + ' must be pinned to LF explicitly');
  }
  for (const ext of ['png', 'jpg', 'gif', 'webp', 'ico', 'pdf', 'gz', 'zip', 'woff', 'woff2']) {
    assert.match(body, new RegExp('^\\*\\.' + ext + '\\s+binary$', 'm'), '*.' + ext + ' must be marked binary so it is never converted');
  }
});

test('.gitattributes is tracked — an untracked one never reaches a CI checkout', (t) => {
  if (!IS_CHECKOUT) return t.skip('not a git checkout');
  assert.notEqual(git('ls-files', '--error-unmatch', '--', '.gitattributes'), null,
    '.gitattributes exists but is untracked: `git add .gitattributes`. A clone reads it from the committed tree, so until it is added the Windows runner still checks out CRLF.');
});

test('nothing the suite or the plugin loads is left untracked', (t) => {
  if (!IS_CHECKOUT) return t.skip('not a git checkout');
  // `--others --exclude-standard` lists files git neither tracks nor ignores. Inside these
  // directories such a file is always a mistake: it runs here and is absent from every clone.
  const out = git('ls-files', '--others', '--exclude-standard', '--', 'scripts', 'tests', 'skills', 'references', 'commands', 'hooks');
  if (out === null) return t.skip('git ls-files unavailable');
  const untracked = out.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(untracked, [], 'untracked files a clone would not get: ' + untracked.join(', ') + ' — `git add` them');
});

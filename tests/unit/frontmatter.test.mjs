// Unit tests for scripts/lib/frontmatter.mjs — the minimal YAML subset, and what it refuses to touch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const F = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'frontmatter.mjs')).href);
const REPOS = join(ROOT, 'tests', 'fixtures', 'repos');

test('parseFrontmatter reads scalars, quoted strings and inline arrays', () => {
  const doc = '---\ntitle: "Rain shadow"\ndraft: false\nweight: 3\nratio: 1.5\nempty: null\ntags: [weather, "wet season"]\n---\n\nBody.\n';
  const p = F.parseFrontmatter(doc);
  assert.equal(p.present, true);
  assert.equal(p.format, 'yaml');
  assert.deepEqual(p.data, { title: 'Rain shadow', draft: false, weight: 3, ratio: 1.5, empty: null, tags: ['weather', 'wet season'] });
  assert.deepEqual(p.order, ['title', 'draft', 'weight', 'ratio', 'empty', 'tags']);
  assert.equal(p.body, '\nBody.\n');
});

test('parseFrontmatter reads block arrays and flags what it cannot parse', () => {
  const doc = '---\ntags:\n  - a\n  - b\nauthor:\n  name: Ada\n  url: https://x\nsummary: |\n  line one\n  line two\nafter: 3\n---\nbody\n';
  const p = F.parseFrontmatter(doc);
  assert.deepEqual(p.data.tags, ['a', 'b']);
  assert.equal(p.data.after, 3);
  assert.deepEqual(p.unsupported.sort(), ['author', 'summary']);
  assert.equal(p.data.author, undefined, 'a nested map is never half-parsed');
});

test('no front matter, an unterminated block and TOML are all reported honestly', () => {
  assert.equal(F.parseFrontmatter('Just text\n').present, false);
  assert.equal(F.parseFrontmatter('---\ntitle: x\nnever closed\n').present, false);
  const toml = F.parseFrontmatter('+++\ntitle = "x"\n+++\nbody\n');
  assert.equal(toml.present, true);
  assert.equal(toml.format, 'toml');
  assert.equal(toml.supported, false);
});

test('comments are stripped outside quotes only', () => {
  const p = F.parseFrontmatter('---\n# a comment line\ntitle: Rain # trailing\nhash: "a # b"\n---\nx');
  assert.equal(p.data.title, 'Rain');
  assert.equal(p.data.hash, 'a # b');
});

test('mergeFrontmatter adds new keys and leaves existing ones alone by default', () => {
  const doc = '---\ntitle: "Rain shadow"\ndate: 2026-01-14\n---\n\nBody.\n';
  const r = F.mergeFrontmatter(doc, { description: 'Why the east side stays dry', title: 'Something else' });
  assert.equal(r.changed, true);
  assert.deepEqual(r.added, ['description']);
  assert.deepEqual(r.skipped, [{ key: 'title', reason: 'exists' }]);
  assert.equal(r.text, '---\ntitle: "Rain shadow"\ndate: 2026-01-14\ndescription: Why the east side stays dry\n---\n\nBody.\n');
  assert.ok(r.text.endsWith('\nBody.\n'), 'the body, including its blank line, is untouched');
});

test('mergeFrontmatter overwrites only when asked, and skips an identical value', () => {
  const doc = '---\ntitle: Old\n---\nbody\n';
  const over = F.mergeFrontmatter(doc, { title: 'New' }, { overwrite: true });
  assert.deepEqual(over.updated, ['title']);
  assert.equal(over.text, '---\ntitle: New\n---\nbody\n');
  const same = F.mergeFrontmatter(over.text, { title: 'New' }, { overwrite: true });
  assert.equal(same.changed, false);
  assert.deepEqual(same.skipped, [{ key: 'title', reason: 'identical' }]);
});

test('mergeFrontmatter creates a block when there is none, and refuses when create is false', () => {
  const created = F.mergeFrontmatter('Body only\n', { title: 'T' });
  assert.equal(created.text, '---\ntitle: T\n---\nBody only\n');
  assert.deepEqual(created.added, ['title']);
  const refused = F.mergeFrontmatter('Body only\n', { title: 'T' }, { create: false });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'no-front-matter');
});

test('mergeFrontmatter never touches TOML front matter or an unsupported key', () => {
  const toml = F.mergeFrontmatter('+++\ntitle = "x"\n+++\nbody\n', { description: 'd' });
  assert.equal(toml.ok, false);
  assert.equal(toml.text, '+++\ntitle = "x"\n+++\nbody\n');
  assert.deepEqual(toml.skipped, [{ key: 'description', reason: 'toml' }]);

  const nested = '---\nauthor:\n  name: Ada\n---\nbody\n';
  const r = F.mergeFrontmatter(nested, { author: 'someone else' }, { overwrite: true });
  assert.equal(r.changed, false);
  assert.deepEqual(r.skipped, [{ key: 'author', reason: 'unsupported' }]);
});

test('mergeFrontmatter replaces a whole block array when overwriting', () => {
  const doc = '---\ntags:\n  - a\n  - b\ntitle: T\n---\nbody\n';
  const r = F.mergeFrontmatter(doc, { tags: ['c'] }, { overwrite: true });
  assert.equal(r.text, '---\ntags: [c]\ntitle: T\n---\nbody\n');
});

test('CRLF documents round-trip with their line endings intact', () => {
  const doc = '---\r\ntitle: A\r\n---\r\nBody\r\n';
  const r = F.mergeFrontmatter(doc, { description: 'D' });
  assert.equal(r.text, '---\r\ntitle: A\r\ndescription: D\r\n---\r\nBody\r\n');
});

test('stringifyScalar quotes exactly what needs quoting', () => {
  assert.equal(F.stringifyScalar('plain'), 'plain');
  assert.equal(F.stringifyScalar('with: colon'), '"with: colon"');
  assert.equal(F.stringifyScalar('true'), '"true"');
  assert.equal(F.stringifyScalar('12'), '"12"');
  assert.equal(F.stringifyScalar(12), '12');
  assert.equal(F.stringifyScalar(true), 'true');
  assert.equal(F.stringifyScalar(null), 'null');
  assert.equal(F.stringifyScalar(''), '""');
  assert.equal(F.stringifyScalar('say "hi"'), '"say \\"hi\\""');
  assert.equal(F.stringifyEntry('tags', ['a', 'b c']), 'tags: [a, "b c"]');
});

test('a value written by this module parses back to the same value', () => {
  const values = { title: 'A: B', tags: ['x', 'y z'], draft: true, weight: 4, note: 'ends with space ' };
  const doc = F.buildDocument(values, 'body\n');
  assert.deepEqual(F.parseFrontmatter(doc).data, values);
});

test('the Hugo and Jekyll fixtures parse into the values the route map relies on', () => {
  const hugo = F.parseFrontmatter(readFileSync(join(REPOS, 'hugo', 'content', 'about.md'), 'utf8'));
  assert.equal(hugo.data.url, '/company/about/');
  const post = F.parseFrontmatter(readFileSync(join(REPOS, 'jekyll', '_posts', '2026-01-14-rain-shadow.md'), 'utf8'));
  assert.equal(post.data.layout, 'post');
  assert.equal(post.data.title, 'Rain shadow');
  assert.equal(F.readFrontmatterValue(readFileSync(join(REPOS, 'hugo', 'content', 'posts', 'rain-shadow.md'), 'utf8'), 'title'), 'Rain shadow');
});

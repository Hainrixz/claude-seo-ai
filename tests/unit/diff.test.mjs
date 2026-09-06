// Unit tests for scripts/lib/diff.mjs — unified diff output and the exact-anchor editors.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const D = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'diff.mjs')).href);

test('splitLines records the EOL and the trailing newline', () => {
  assert.deepEqual(D.splitLines('a\nb\n'), { lines: ['a', 'b'], eol: '\n', trailingNewline: true });
  assert.deepEqual(D.splitLines('a\r\nb'), { lines: ['a', 'b'], eol: '\r\n', trailingNewline: false });
  assert.deepEqual(D.splitLines(''), { lines: [], eol: '\n', trailingNewline: false });
});

test('unifiedDiff produces a standard single-hunk insertion', () => {
  const before = 'a\nb\nc\n';
  const after = 'a\nX\nb\nc\n';
  assert.equal(D.unifiedDiff(before, after, { fromFile: 'a/f.txt', toFile: 'b/f.txt' }),
    ['--- a/f.txt', '+++ b/f.txt', '@@ -1,3 +1,4 @@', ' a', '+X', ' b', ' c', ''].join('\n'));
});

test('unifiedDiff returns "" for identical input (an adapter reads that as already applied)', () => {
  assert.equal(D.unifiedDiff('same\n', 'same\n'), '');
});

test('unifiedDiff on a brand-new file uses the 0,0 range', () => {
  assert.equal(D.unifiedDiff('', 'User-agent: *\nAllow: /\n', { fromFile: '/dev/null', toFile: 'b/robots.txt' }),
    ['--- /dev/null', '+++ b/robots.txt', '@@ -0,0 +1,2 @@', '+User-agent: *', '+Allow: /', ''].join('\n'));
});

test('unifiedDiff splits distant edits into separate hunks with three lines of context', () => {
  const before = Array.from({ length: 20 }, (_, i) => 'line' + (i + 1)).join('\n') + '\n';
  const after = before.replace('line2\n', 'line2\nINSERTED\n').replace('line18\n', 'CHANGED18\n');
  const out = D.unifiedDiff(before, after);
  const hunks = out.split('\n').filter((l) => l.startsWith('@@'));
  assert.equal(hunks.length, 2, 'edits 15 lines apart are two hunks');
  assert.match(hunks[0], /^@@ -1,\d+ \+1,\d+ @@$/);
  assert.ok(out.includes('+INSERTED'));
  assert.ok(out.includes('-line18'));
  assert.ok(out.includes('+CHANGED18'));
});

test('the generated diff is accepted by `git apply` (when git is available)', (t) => {
  let git = true;
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { git = false; }
  if (!git) return t.skip('git not available');
  const dir = mkdtempSync(join(tmpdir(), 'cseo-diff-'));
  try {
    const before = 'one\ntwo\nthree\nfour\nfive\n';
    const after = 'one\ntwo\nTWO-AND-A-HALF\nthree\nfour\nfive-changed\n';
    writeFileSync(join(dir, 'f.txt'), before);
    writeFileSync(join(dir, 'p.diff'), D.unifiedDiff(before, after, { fromFile: 'a/f.txt', toFile: 'b/f.txt' }));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['apply', 'p.diff'], { cwd: dir });
    assert.equal(readFileSync(join(dir, 'f.txt'), 'utf8'), after);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing trailing newline is marked on the right side, and git accepts it', (t) => {
  let git = true;
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { git = false; }
  const cases = [
    ['a\nb', 'a\nb\nc\n'],
    ['a\nb\nc\n', 'a\nb'],
    ['only', 'only line'],
  ];
  for (const [before, after] of cases) {
    const patch = D.unifiedDiff(before, after, { fromFile: 'a/f.txt', toFile: 'b/f.txt' });
    assert.ok(patch.includes('\\ No newline at end of file'), JSON.stringify(patch));
    const lines = patch.split('\n');
    const at = lines.findIndex((l) => l === '\\ No newline at end of file');
    assert.ok(at > 0 && /^[-+ ]/.test(lines[at - 1]), 'the note must follow the line it describes');
    if (!git) continue;
    const dir = mkdtempSync(join(tmpdir(), 'cseo-eof-'));
    try {
      writeFileSync(join(dir, 'f.txt'), before);
      writeFileSync(join(dir, 'p.diff'), patch);
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['apply', 'p.diff'], { cwd: dir });
      assert.equal(readFileSync(join(dir, 'f.txt'), 'utf8'), after, JSON.stringify(patch));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  if (!git) t.diagnostic('git not available: only the format was checked');
});

test('diffStats counts both sides of a modified line', () => {
  assert.deepEqual(D.diffStats('a\nb\n', 'a\nB\nc\n'), { added: 2, removed: 1, changed: true });
  assert.deepEqual(D.diffStats('a\n', 'a\n'), { added: 0, removed: 0, changed: false });
  assert.deepEqual(D.diffStats('a', 'a\n'), { added: 1, removed: 1, changed: true }, 'adding the final newline is a change');
});

test('applyInsertAt inserts after an exact anchor and keeps its indentation', () => {
  const src = '<head>\n    <meta charset="utf-8">\n    <title>x</title>\n</head>\n';
  const out = D.applyInsertAt(src, { anchor: '<meta charset="utf-8">', insert: '<meta name="description" content="d">' });
  assert.equal(out.ok, true);
  assert.equal(out.changed, true);
  assert.equal(out.reason, 'inserted');
  assert.equal(out.text, '<head>\n    <meta charset="utf-8">\n    <meta name="description" content="d">\n    <title>x</title>\n</head>\n');
});

test('applyInsertAt is idempotent: the same snippet, and the marker, both stop a second insertion', () => {
  const src = '<head>\n<title>x</title>\n</head>\n';
  const first = D.applyInsertAt(src, { anchor: '<title>x</title>', insert: '<link rel="canonical" href="/a"> <!-- claude-seo-ai -->', marker: 'claude-seo-ai' });
  assert.equal(first.changed, true);
  const second = D.applyInsertAt(first.text, { anchor: '<title>x</title>', insert: '<link rel="canonical" href="/a"> <!-- claude-seo-ai -->', marker: 'claude-seo-ai' });
  assert.equal(second.changed, false);
  assert.equal(second.reason, 'marker-present');
  assert.equal(second.text, first.text);

  const third = D.applyInsertAt(first.text, { anchor: '<title>x</title>', insert: '<link rel="canonical" href="/a"> <!-- claude-seo-ai -->' });
  assert.equal(third.reason, 'already-present');
  assert.equal(third.changed, false);
});

test('applyInsertAt reports a missing anchor instead of guessing', () => {
  const out = D.applyInsertAt('<p>no head here</p>', { anchor: '<title>', insert: '<meta>' });
  assert.equal(out.ok, false);
  assert.equal(out.changed, false);
  assert.equal(out.reason, 'anchor-not-found');
  assert.equal(out.text, '<p>no head here</p>');
});

test('applyInsertAt: before, inline mode and the nth occurrence', () => {
  assert.equal(D.applyInsertAt('a\nB\n', { anchor: 'B', position: 'before', insert: 'X' }).text, 'a\nX\nB\n');
  assert.equal(D.applyInsertAt('<a></a>', { anchor: '<a>', insert: 'text', mode: 'inline' }).text, '<a>text</a>');
  assert.equal(D.applyInsertAt('x\nx\n', { anchor: 'x', occurrence: 2, insert: 'Y' }).text, 'x\nx\nY\n');
  assert.equal(D.applyInsertAt('a\n', { anchor: 'a', insert: '   ' }).reason, 'empty-insert');
});

test('replaceBetween swaps only what is between the delimiters', () => {
  const src = 'head\n<!-- start -->\nold\n<!-- end -->\ntail\n';
  const out = D.replaceBetween(src, { start: '<!-- start -->', end: '<!-- end -->', replacement: '\nnew\n' });
  assert.equal(out.ok, true);
  assert.equal(out.text, 'head\n<!-- start -->\nnew\n<!-- end -->\ntail\n');
  const inclusive = D.replaceBetween(src, { start: '<!-- start -->', end: '<!-- end -->', replacement: 'GONE', inclusive: true });
  assert.equal(inclusive.text, 'head\nGONE\ntail\n');
  assert.equal(D.replaceBetween(src, { start: '<!-- nope -->', end: '<!-- end -->' }).reason, 'start-not-found');
  assert.equal(D.replaceBetween(src, { start: '<!-- start -->', end: '<!-- nope -->' }).reason, 'end-not-found');
});

test('upsertMarkerBlock inserts once, then refreshes in place', () => {
  const src = '<head>\n<title>t</title>\n</head>\n';
  const first = D.upsertMarkerBlock(src, { marker: 'claude-seo-ai', body: '<meta name="a" content="1">', anchor: '<title>t</title>' });
  assert.equal(first.changed, true);
  assert.ok(first.text.includes('<!-- claude-seo-ai:start -->'));
  assert.ok(first.text.includes('<!-- claude-seo-ai:end -->'));

  const second = D.upsertMarkerBlock(first.text, { marker: 'claude-seo-ai', body: '<meta name="a" content="2">', anchor: '<title>t</title>' });
  assert.equal(second.reason, 'block-updated');
  assert.ok(second.text.includes('content="2"'));
  assert.ok(!second.text.includes('content="1"'));
  assert.equal((second.text.match(/claude-seo-ai:start/g) || []).length, 1, 'no stacked duplicates');
});

test('findHeadAnchor prefers charset, then title, then <head>', () => {
  assert.equal(D.findHeadAnchor('<head><meta charset="utf-8"><title>t</title></head>').name, 'charset');
  assert.equal(D.findHeadAnchor('<head><title>t</title></head>').name, 'title');
  assert.equal(D.findHeadAnchor('<head lang="x"><link rel="me"></head>').name, 'head-open');
  assert.equal(D.findHeadAnchor('<body>nothing</body>'), null);
});

test('insertInHead adds the marker and is idempotent', () => {
  const html = '<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <title>t</title>\n</head>\n<body></body>\n</html>\n';
  const first = D.insertInHead(html, '<meta name="description" content="Rain shadow">');
  assert.equal(first.changed, true);
  assert.equal(first.anchor.name, 'charset');
  assert.match(first.text, /<meta name="description" content="Rain shadow"> <!-- claude-seo-ai -->/);
  const second = D.insertInHead(first.text, '<meta name="description" content="Rain shadow">');
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
  assert.equal(D.insertInHead('<p>x</p>', '<meta>').reason, 'no-head');
});

test('diffLines falls back to a whole-block replacement past the LCS cap', () => {
  const a = Array.from({ length: 2100 }, (_, i) => 'a' + i).join('\n');
  const b = Array.from({ length: 2100 }, (_, i) => 'b' + i).join('\n');
  const ops = D.diffLines(D.splitLines(a).lines, D.splitLines(b).lines);
  assert.equal(ops.filter((o) => o.op === '-').length, 2100);
  assert.equal(ops.filter((o) => o.op === '+').length, 2100);
  assert.equal(ops.filter((o) => o.op === '=').length, 0);
});

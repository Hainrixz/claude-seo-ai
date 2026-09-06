// Unit tests for scripts/lib/store.mjs: keys, slugs, run ids, root resolution, run directories,
// latest/baseline pointers (symlink + latest.json fallback), retention and run references.
// Everything happens inside a fresh temp directory; nothing touches the real ~/.claude-seo-ai.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as store from '../../scripts/lib/store.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'cseo-store-'));
const isWin = process.platform === 'win32';

test('hostKey: lower-cased host with ":" → "_", local paths → local/<basename>-<sha1[:8]>', () => {
  assert.equal(store.hostKey('https://WWW.Example.com/path?q=1'), 'www.example.com');
  assert.equal(store.hostKey('http://127.0.0.1:8080/x'), '127.0.0.1_8080');
  assert.equal(store.hostKey('example.com:3000'), 'example.com_3000');
  assert.equal(store.hostKey('Example.COM'), 'example.com');
  const dir = tmp();
  const key = store.hostKey(dir);
  assert.match(key, /^local\/[a-z0-9._-]+-[0-9a-f]{8}$/);
  assert.ok(key.startsWith('local/' + basename(dir).toLowerCase()), key);
  assert.equal(store.hostKey(dir), key, 'stable for the same path');
  assert.equal(store.hostKey(pathToFileURL(dir).href), key, 'file:// URL keys like the path');
  assert.notEqual(store.hostKey(tmp()), key, 'different paths → different keys');
  assert.equal(store.hostKey('index.html'), store.hostKey('index.html'));
  assert.ok(store.hostKey('index.html').startsWith('local/'), 'a file-looking name is never taken for a host');
  assert.equal(store.keepFor('_gap/x'), store.DEFAULT_KEEP.gap);
  assert.equal(store.keepFor('example.com'), store.DEFAULT_KEEP.default);
});

test('pageSlug: path with "/" → "_" (≤ 60 chars) + "--" + sha1(url)[:8]; root → index--<hash>', () => {
  assert.match(store.pageSlug('https://example.com/'), /^index--[0-9a-f]{8}$/);
  assert.match(store.pageSlug('https://example.com/blog/a'), /^blog_a--[0-9a-f]{8}$/);
  const long = store.pageSlug('https://example.com/' + 'segment/'.repeat(20) + 'end');
  assert.ok(long.split('--')[0].length <= 60, long);
  const a = store.pageSlug('https://example.com/blog/a?page=2'), b = store.pageSlug('https://example.com/blog/a');
  assert.equal(a.split('--')[0], b.split('--')[0], 'same readable part');
  assert.notEqual(a, b, 'query string changes the hash');
  assert.notEqual(store.pageSlug('https://example.com/blog/a/'), b, 'trailing slash is a different URL');
  assert.match(store.pageSlug('blog/a.html'), /^blog_a--[0-9a-f]{8}$/, 'local relative path drops .html');
  assert.match(store.pageSlug('index.html'), /^index--[0-9a-f]{8}$/);
  assert.match(store.pageSlug('https://x.com/art%C3%ADculo/über'), /^[A-Za-z0-9._-]+--[0-9a-f]{8}$/, 'ASCII-safe');
});

test('newRunId is UTC YYYY-MM-DDTHH-mm-ssZ; sanitizeRunId rejects reserved names', () => {
  assert.match(store.newRunId(), store.RUN_ID_RE);
  assert.equal(store.newRunId(new Date('2026-09-05T17:03:09.500Z')), '2026-09-05T17-03-09Z');
  assert.equal(store.sanitizeRunId(' gap-my slug! '), 'gap-my-slug');
  assert.throws(() => store.sanitizeRunId('latest'), /reserved/);
  assert.throws(() => store.sanitizeRunId(''), /invalid run id/);
});

test('resolveRootInfo precedence: --out > CLAUDE_SEO_AI_HOME > CLAUDE_PLUGIN_DATA/runs > ~/.claude-seo-ai/runs', () => {
  const env = { CLAUDE_SEO_AI_HOME: '/h/home', CLAUDE_PLUGIN_DATA: '/h/data' };
  assert.deepEqual(store.resolveRootInfo({ out: 'rel/out' }, env), { root: resolve('rel/out'), source: '--out' });
  assert.deepEqual(store.resolveRootInfo({}, env), { root: resolve('/h/home'), source: 'CLAUDE_SEO_AI_HOME' });
  assert.deepEqual(store.resolveRootInfo({}, { CLAUDE_PLUGIN_DATA: '/h/data' }), { root: resolve('/h/data', 'runs'), source: 'CLAUDE_PLUGIN_DATA' });
  const def = store.resolveRootInfo({}, {});
  assert.equal(def.source, 'default');
  assert.ok(def.root.endsWith(join('.claude-seo-ai', 'runs')), def.root);
  assert.equal(store.resolveRoot({ out: '/abs/x' }, {}), resolve('/abs/x'));
  assert.equal(store.resolveRootInfo({ out: true }, { CLAUDE_SEO_AI_HOME: '  ' }).source, 'default', 'bare --out and blank env are ignored');
});

test('openRun creates <root>/<hostkey>/<run-id>/{site,pages,agents} and registers the run in index.json', () => {
  const root = tmp();
  const run = store.openRun({ root, target: 'https://Example.com/x' });
  assert.equal(run.host_key, 'example.com');
  assert.match(run.run_id, store.RUN_ID_RE);
  assert.equal(run.dir, join(root, 'example.com', run.run_id));
  for (const d of ['site', 'pages', 'agents']) assert.ok(existsSync(join(run.dir, d)), d);
  assert.equal(run.created, true);
  const again = store.openRun({ root, host: 'example.com', runId: run.run_id });
  assert.equal(again.created, false);
  assert.equal(again.dir, run.dir);
  const idx = store.readIndex(root);
  assert.equal(idx.version, store.INDEX_VERSION);
  assert.deepEqual(idx.hosts['example.com'].runs, [run.run_id]);
  assert.equal(idx.hosts['example.com'].target, 'https://Example.com/x');
  assert.equal(idx.hosts['example.com'].kind, 'url');
  const local = store.openRun({ root, target: root, runId: 'gap-my run' });
  assert.equal(local.run_id, 'gap-my-run');
  assert.ok(local.host_key.startsWith('local/'));
  assert.ok(existsSync(join(root, 'local')));
  assert.equal(store.readIndex(root).hosts[local.host_key].kind, 'local');
  assert.throws(() => store.openRun({ root, host: 'example.com', runId: 'latest' }), /reserved/);
  assert.throws(() => store.openRun({}), /root is required/);
});

test('writeJson (atomic), writeText and readJson round-trip and create parent directories', () => {
  const root = tmp();
  const p = store.writeJson(join(root, 'a', 'b', 'x.json'), { k: [1, 2] });
  assert.equal(p, join(root, 'a', 'b', 'x.json'));
  assert.deepEqual(store.readJson(p), { k: [1, 2] });
  assert.ok(readFileSync(p, 'utf8').endsWith('\n'));
  assert.equal(store.readJson(join(root, 'missing.json')), null);
  assert.deepEqual(store.readJson(join(root, 'missing.json'), {}), {});
  assert.equal(readFileSync(store.writeText(join(root, 'c', 't.txt'), 'hi'), 'utf8'), 'hi');
  assert.equal(store.relPath(root, join(root, 'pages', 'x.json')), 'pages/x.json');
  assert.equal(typeof store.pluginVersion(), 'string');
});

test('setLatest writes latest.json always, a symlink when possible, and updates the index', () => {
  const root = tmp();
  const run = store.openRun({ root, host: 'example.com', runId: '2026-01-01T00-00-00Z' });
  const res = store.setLatest(run.host_dir, run.run_id);
  const pointer = store.readJson(res.latest_json);
  assert.equal(pointer.run, run.run_id);
  assert.equal(pointer.path, run.dir);
  assert.match(pointer.updated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(res.symlink, true, res.symlink_error);
  assert.ok(lstatSync(join(run.host_dir, 'latest')).isSymbolicLink());
  if (!isWin) assert.equal(readlinkSync(join(run.host_dir, 'latest')), run.run_id, 'relative symlink target');
  assert.equal(store.readIndex(root).hosts['example.com'].latest, run.run_id);
  // move the pointer to a newer run: the old symlink is replaced
  const run2 = store.openRun({ root, host: 'example.com', runId: '2026-01-02T00-00-00Z' });
  store.setLatest(run2.host_dir, run2.run_id);
  assert.equal(store.readJson(join(run2.host_dir, 'latest.json')).run, run2.run_id);
  assert.equal(store.latestRunId(run2.host_dir), run2.run_id);
});

test('setLatest falls back to latest.json when "latest" cannot be a symlink; resolveRunRef still resolves', () => {
  const root = tmp();
  const run = store.openRun({ root, host: 'example.com', runId: '2026-01-01T00-00-00Z' });
  mkdirSync(join(run.host_dir, 'latest')); // a real directory squatting on the name (EPERM/Windows stand-in)
  const res = store.setLatest(run.host_dir, run.run_id);
  assert.equal(res.symlink, false);
  assert.match(res.symlink_error, /not a symlink/);
  assert.ok(existsSync(join(run.host_dir, 'latest.json')));
  const ref = store.resolveRunRef('latest:example.com', root);
  assert.equal(ref.dir, run.dir);
  assert.equal(ref.kind, 'latest');
  assert.equal(store.latestRunId(run.host_dir), run.run_id);
});

test('setBaseline writes baseline.json and the index; missing runs throw', () => {
  const root = tmp();
  const run = store.openRun({ root, host: 'example.com', runId: '2026-01-01T00-00-00Z' });
  const res = store.setBaseline(run.host_dir, run.run_id, { note: 'release 1' });
  const b = store.readJson(res.baseline_json);
  assert.equal(b.run, run.run_id);
  assert.equal(b.note, 'release 1');
  assert.match(b.set_at, /^\d{4}-/);
  assert.equal(store.readIndex(root).hosts['example.com'].baseline, run.run_id);
  assert.throws(() => store.setBaseline(run.host_dir, 'nope'), /run not found/);
  assert.equal(store.resolveRunRef('baseline:example.com', root).dir, run.dir);
  assert.equal(store.resolveRunRef('baseline', root).run_id, run.run_id);
});

test('prune keeps the newest `keep` runs and never removes latest, baseline or protected ids', () => {
  const root = tmp();
  const ids = ['2026-01-01T00-00-00Z', '2026-01-02T00-00-00Z', '2026-01-03T00-00-00Z', '2026-01-04T00-00-00Z', '2026-01-05T00-00-00Z', '2026-01-06T00-00-00Z'];
  let hostDir;
  for (const id of ids) hostDir = store.openRun({ root, host: 'example.com', runId: id }).host_dir;
  store.setLatest(hostDir, ids[4]);       // latest = 05 (not the newest, on purpose)
  store.setBaseline(hostDir, ids[1]);     // baseline = 02
  assert.deepEqual(store.listRuns(hostDir).map((r) => r.id), [...ids].reverse(), 'newest first');
  const res = store.prune(hostDir, 2, [ids[0]]);
  assert.deepEqual(res.removed.sort(), [ids[2], ids[3]].sort(), 'only 03 and 04 go');
  assert.deepEqual(res.kept.sort(), [ids[0], ids[1], ids[4], ids[5]].sort());
  for (const id of res.removed) assert.equal(existsSync(join(hostDir, id)), false, id + ' removed');
  for (const id of res.kept) assert.ok(existsSync(join(hostDir, id)), id + ' kept');
  assert.ok(existsSync(join(hostDir, 'latest.json')) && existsSync(join(hostDir, 'baseline.json')));
  assert.deepEqual(store.readIndex(root).hosts['example.com'].runs, [ids[0], ids[1], ids[4], ids[5]], 'index follows the pruning');
  // a second prune is a no-op; keep=0 removes everything unprotected
  assert.deepEqual(store.prune(hostDir, 2, [ids[0]]).removed, []);
  const zero = store.prune(hostDir, 0);
  assert.deepEqual(zero.removed.sort(), [ids[0], ids[5]].sort(), 'latest + baseline survive even keep=0');
});

test('resolveRunRef accepts latest, latest:<host>, baseline[:<host>], a run dir, a report.json and <hostkey>/<run-id>', () => {
  const root = tmp();
  const a = store.openRun({ root, host: 'example.com', runId: '2026-01-01T00-00-00Z' });
  const a2 = store.openRun({ root, host: 'example.com', runId: '2026-01-02T00-00-00Z' });
  store.setLatest(a.host_dir, a2.run_id);
  writeFileSync(join(a2.dir, 'report.json'), '{}');
  writeFileSync(join(a2.dir, 'pages', 'index--abcd1234.json'), '{}');
  const latest = store.resolveRunRef('latest', root);
  assert.equal(latest.dir, a2.dir);
  assert.equal(latest.kind, 'latest');
  assert.equal(latest.host_key, 'example.com');
  assert.equal(latest.report_json, join(a2.dir, 'report.json'));
  assert.equal(latest.pages_count, 1);
  assert.equal(store.resolveRunRef('latest:example.com', root).run_id, a2.run_id);
  assert.equal(store.resolveRunRef('latest:https://www.example.com/page', root).run_id, a2.run_id, 'www-insensitive host lookup');
  assert.equal(store.resolveRunRef('LATEST:Example.com', root).run_id, a2.run_id);
  assert.equal(store.resolveRunRef('baseline', root), null, 'no baseline set yet');
  assert.equal(store.resolveRunRef('baseline:example.com', root), null);
  const dir = store.resolveRunRef(a.dir, root);
  assert.equal(dir.kind, 'dir');
  assert.equal(dir.run_id, a.run_id);
  assert.equal(dir.host_key, 'example.com');
  const rep = store.resolveRunRef(join(a2.dir, 'report.json'), root);
  assert.equal(rep.kind, 'report');
  assert.equal(rep.dir, a2.dir);
  assert.equal(store.resolveRunRef(join(a2.dir, 'pages', 'index--abcd1234.json'), root).dir, a2.dir, 'a page snapshot path resolves to its run');
  assert.equal(store.resolveRunRef('example.com/' + a.run_id, root).dir, a.dir);
  assert.equal(store.resolveRunRef('nonsense-ref', root), null);
  assert.equal(store.resolveRunRef('', root), null);
  assert.equal(store.resolveRunRef('latest', null), null);
  // two hosts: bare `latest` picks the most recently updated pointer
  const b = store.openRun({ root, host: 'other.test', runId: '2026-01-03T00-00-00Z' });
  store.setLatest(b.host_dir, b.run_id);
  store.writeJson(join(a.host_dir, 'latest.json'), { run: a2.run_id, path: a2.dir, updated_at: '2020-01-01T00:00:00.000Z' });
  assert.equal(store.resolveRunRef('latest', root).host_key, 'other.test');
  // a host present on disk but absent from the index is still found
  mkdirSync(join(root, 'scanned.test', '2026-01-04T00-00-00Z'), { recursive: true });
  assert.ok(store.listHosts(root).includes('scanned.test'));
  assert.equal(store.resolveRunRef('latest:scanned.test', root).run_id, '2026-01-04T00-00-00Z', 'newest directory when no pointer exists');
});

test('locateRoot finds the root and host key for one- and two-segment host dirs', () => {
  const root = tmp();
  const a = store.openRun({ root, host: 'example.com', runId: '2026-01-01T00-00-00Z' });
  assert.deepEqual(store.locateRoot(a.host_dir), { root, hostKey: 'example.com' });
  const l = store.openRun({ root, target: root, runId: '2026-01-01T00-00-00Z' });
  assert.deepEqual(store.locateRoot(l.host_dir), { root, hostKey: l.host_key });
  rmSync(root, { recursive: true, force: true });
});

test('openRun never reuses a directory another run started in the same second (-2, -3 suffixes)', () => {
  const root = tmp();
  const a = store.openRun({ root, host: 'example.com' });
  const b = store.openRun({ root, host: 'example.com' });
  const c = store.openRun({ root, host: 'example.com' });
  assert.notEqual(a.dir, b.dir);
  assert.notEqual(b.dir, c.dir);
  assert.ok([a, b, c].every((r) => r.created), 'each call creates its own run');
  assert.ok([a, b, c].every((r) => store.RUN_ID_RE.test(r.run_id)), [a, b, c].map((r) => r.run_id).join(','));
  assert.equal(store.runIdTime('2026-01-01T00-00-00Z-3') - store.runIdTime('2026-01-01T00-00-00Z'), 3);
  assert.equal(store.runIdTime('gap-foo'), 0);
  assert.deepEqual(store.listRuns(a.host_dir).map((r) => r.id), [c.run_id, b.run_id, a.run_id], 'newest first even within one second');
  assert.equal(store.readIndex(root).hosts['example.com'].runs.length, 3);
  rmSync(root, { recursive: true, force: true });
});

// Unit tests for scripts/lib/adapter.mjs: the Change record, its status machine, the fix-run
// directory and the confirmation tickets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const A = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'adapter.mjs')).href);

function tempDir(prefix = 'cseo-adapter-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const baseChange = {
  finding_ids: ['M7.title.missing'],
  adapter: 'local-files',
  class: 'auto',
  target: { kind: 'file', locator: 'src/pages/index.astro' },
  op: 'insert',
  strategy: 'html-head',
  preview: { kind: 'diff', body: '--- a\n+++ b\n' },
  requires: { credentials: [], tools: [] },
  live_impact: 'none',
  verify: { method: 'dom_assert', assertion: 'title present' },
  rollback: { kind: 'restore-file' },
};

test('changeId is deterministic on identity and moves when the payload does', () => {
  const seed = { adapter: 'local-files', op: 'insert', target: { kind: 'file', locator: 'a.html' }, finding_ids: ['M7.a', 'M7.b'], payload: { snippet: '<title>x</title>' } };
  const id = A.changeId(seed);
  assert.match(id, /^chg_[0-9a-f]{12}$/);
  assert.equal(id, A.changeId({ ...seed, finding_ids: ['M7.b', 'M7.a'] }), 'finding order must not change the id');
  assert.notEqual(id, A.changeId({ ...seed, payload: { snippet: '<title>y</title>' } }));
  assert.notEqual(id, A.changeId({ ...seed, target: { kind: 'file', locator: 'b.html' } }));
});

test('makeChange fills structural defaults and computes the id', () => {
  const { change, errors } = A.makeChange({ ...baseChange, class: undefined, status: undefined, live_impact: undefined, requires: undefined, rollback: undefined });
  assert.deepEqual(errors, []);
  assert.equal(change.class, 'proposed', 'defaults to the safe side');
  assert.equal(change.status, 'planned');
  assert.equal(change.live_impact, 'none');
  assert.deepEqual(change.requires, { credentials: [], tools: [] });
  assert.deepEqual(change.rollback, { kind: 'none' });
  assert.match(change.id, /^chg_[0-9a-f]{12}$/);
});

test('makeChange throws under node:test on an invalid change, and returns errors in return mode', () => {
  assert.throws(() => A.makeChange({ adapter: 'x' }), /invalid change/);
  const { errors } = A.makeChange({ adapter: 'x' }, { mode: 'return' });
  assert.ok(errors.some((e) => e.includes('target is required')));
  assert.ok(errors.some((e) => e.includes('op must be one of')));
  assert.ok(errors.some((e) => e.includes('verify is required')));
  assert.deepEqual(A.validateChange(null), ['change must be an object']);
});

test('validateChange only demands a preview from the preview phase on', () => {
  const { change } = A.makeChange({ ...baseChange, preview: undefined });
  assert.deepEqual(A.validateChange(change, { phase: 'plan' }), []);
  assert.deepEqual(A.validateChange(change, { phase: 'preview' }), ['preview is required from the preview phase on']);
});

test('status machine: legal moves pass, illegal ones throw, terminal states are terminal', () => {
  const { change } = A.makeChange(baseChange);
  assert.ok(A.canTransition('planned', 'previewed'));
  assert.ok(A.canTransition('confirmed', 'applied'));
  assert.ok(A.canTransition('applied', 'verified'));
  assert.ok(A.canTransition('applied', 'pending_cache'));
  assert.ok(A.canTransition('pending_cache', 'verified'));
  assert.ok(!A.canTransition('planned', 'applied'), 'a change is never applied without being confirmed');
  assert.ok(!A.canTransition('verified', 'applied'));
  for (const terminal of A.TERMINAL_STATUSES) assert.deepEqual(A.STATUS_TRANSITIONS[terminal], []);

  const previewed = A.transition(change, 'previewed');
  assert.equal(previewed.status, 'previewed');
  assert.equal(change.status, 'planned', 'transition does not mutate its input');
  assert.throws(() => A.transition(change, 'applied'), /illegal status transition planned -> applied/);
  assert.throws(() => A.transition(change, 'nonsense'), /unknown change status/);
  const failed = A.transition(change, 'failed', { error: 'boom' });
  assert.equal(failed.error, 'boom');
});

test('ensureConfirmed lifts a planned change and refuses an applied one', () => {
  const { change } = A.makeChange(baseChange);
  assert.equal(A.ensureConfirmed(change).status, 'confirmed');
  const applied = A.transition(A.transition(change, 'confirmed'), 'applied');
  assert.throws(() => A.ensureConfirmed(applied), /cannot be confirmed from status "applied"/);
});

test('resolveDataDir precedence: --data > CLAUDE_SEO_AI_HOME > CLAUDE_PLUGIN_DATA > home', () => {
  const env = { CLAUDE_SEO_AI_HOME: '/home-var', CLAUDE_PLUGIN_DATA: '/plugin-data' };
  assert.equal(A.resolveDataDirInfo({ data: '/flag' }, env).source, '--data');
  assert.equal(A.resolveDataDir({ data: '/flag' }, env), resolve('/flag'));
  assert.equal(A.resolveDataDir({}, env), resolve('/home-var'));
  assert.equal(A.resolveDataDir({}, { CLAUDE_PLUGIN_DATA: '/plugin-data' }), resolve('/plugin-data'));
  assert.match(A.resolveDataDirInfo({}, {}).dir, /\.claude-seo-ai$/);
});

test('safeRelPath refuses to escape and normalizes separators', () => {
  assert.equal(A.safeRelPath('src\\pages\\index.astro'), 'src/pages/index.astro');
  assert.equal(A.safeRelPath('./a/./b.txt'), 'a/b.txt');
  assert.throws(() => A.safeRelPath('../secrets.env'), /must not escape/);
  assert.throws(() => A.safeRelPath('a/../../b'), /must not escape/);
  assert.throws(() => A.safeRelPath('/etc/passwd'), /must not be absolute/);
  assert.throws(() => A.safeRelPath(''), /empty relative path/);
});

test('openFixRun creates the run layout, seeds plan/manifest and appends a redacted log', () => {
  const { dir, cleanup } = tempDir();
  try {
    const run = A.openFixRun(dir, { report: '/r/report.json', profile: '/r/profile.json', target: { kind: 'url', value: 'https://example.test/' }, adapters: ['local-files'] });
    assert.ok(run.dir.startsWith(join(dir, 'fix', 'runs')));
    for (const p of [run.paths.plan, run.paths.manifest, run.paths.preview_dir, run.paths.before_dir, run.paths.after_dir, run.paths.log]) assert.ok(existsSync(p), p + ' should exist');
    const plan = run.readPlan();
    assert.equal(plan.version, A.PLAN_VERSION);
    assert.equal(plan.report, '/r/report.json');
    assert.deepEqual(plan.changes, []);
    assert.deepEqual(run.readManifest().adapters, ['local-files']);

    const { change } = A.makeChange(baseChange);
    run.setChanges([change]);
    assert.equal(run.readPlan().changes[0].id, change.id);

    run.updateManifest((m) => ({ ...m, confirmed: [change.id] }));
    assert.deepEqual(run.readManifest().confirmed, [change.id]);

    run.log({ event: 'apply', command: 'curl -H "Authorization: Bearer sk-live-abcdef123456" https://api.example/x' });
    const log = run.readLog();
    assert.equal(log.length, 1);
    assert.ok(!log[0].command.includes('sk-live-abcdef123456'), 'the token must not reach the log');
    assert.match(log[0].command, /\[redacted\]/);

    assert.equal(run.backupPath('src/pages/index.astro'), join(dir, 'backups', run.id, 'src', 'pages', 'index.astro'));
    assert.throws(() => run.backupPath('../escape.txt'), /must not escape/);

    const reopened = A.loadFixRun(run.dir);
    assert.equal(reopened.id, run.id);
    assert.equal(reopened.data_dir, resolve(dir));
    assert.equal(reopened.readPlan().changes.length, 1);
    assert.ok(A.listFixRuns(dir).includes(run.id));
  } finally { cleanup(); }
});

test('openFixRun never reuses a directory for two runs in the same second', () => {
  const { dir, cleanup } = tempDir();
  try {
    const now = new Date('2026-09-06T10:00:00Z');
    const a = A.openFixRun(dir, { now });
    const b = A.openFixRun(dir, { now });
    assert.notEqual(a.id, b.id);
    assert.equal(b.id, a.id + '-2');
  } finally { cleanup(); }
});

test('tickets: issue, check, one-shot consume, and a 15-minute TTL', () => {
  const { dir, cleanup } = tempDir();
  try {
    const command = 'node scripts/adapters/local-files.mjs   apply --run /r --change chg_abc123456789';
    const t0 = Date.parse('2026-09-06T10:00:00Z');
    const { id, ticket } = A.issueTicket(dir, { command, run: '2026-09-06T10-00-00Z', change: 'chg_abc123456789', now: t0 });
    assert.match(id, /^[0-9a-f]{64}$/);
    assert.equal(Date.parse(ticket.expires_at) - t0, A.TICKET_TTL_MS);

    // whitespace is normalized, so the same command in a different spacing still matches
    const spaced = 'node scripts/adapters/local-files.mjs apply --run /r --change chg_abc123456789';
    assert.equal(A.ticketId(spaced), id);
    assert.equal(A.checkTicket(dir, spaced, { now: t0 + 1000 }).ok, true);

    // one shot: the second consume finds nothing
    assert.equal(A.consumeTicket(dir, spaced, { now: t0 + 1000 }).ok, true);
    const second = A.consumeTicket(dir, spaced, { now: t0 + 1000 });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'missing');

    // TTL
    A.issueTicket(dir, { command, run: 'r', now: t0 });
    const late = A.checkTicket(dir, command, { now: t0 + A.TICKET_TTL_MS + 1 });
    assert.equal(late.ok, false);
    assert.equal(late.reason, 'expired');
    const consumedLate = A.consumeTicket(dir, command, { now: t0 + A.TICKET_TTL_MS + 1 });
    assert.equal(consumedLate.ok, false);
    assert.ok(!existsSync(A.ticketPath(dir, command)), 'an expired ticket file is removed');
  } finally { cleanup(); }
});

test('tickets: a reusable ticket counts its uses instead of vanishing', () => {
  const { dir, cleanup } = tempDir();
  try {
    const cmd = 'shopify theme push --unpublished';
    A.issueTicket(dir, { command: cmd, run: 'r', one_shot: false, now: 1000 });
    assert.equal(A.consumeTicket(dir, cmd, { now: 2000 }).ok, true);
    const again = A.consumeTicket(dir, cmd, { now: 3000 });
    assert.equal(again.ok, true);
    assert.equal(again.ticket.uses, 2);
  } finally { cleanup(); }
});

test('requireTicket binds a ticket to its run and change', () => {
  const { dir, cleanup } = tempDir();
  try {
    const cmd = 'node adapters/local-files.mjs apply';
    const now = 5000;
    const { id } = A.issueTicket(dir, { command: cmd, run: 'run-1', change: 'chg_000000000001', now });
    assert.equal(A.requireTicket(dir, { ticket: id, run: 'run-2', change: 'chg_000000000001', now, consume: false }).reason, 'wrong-run');
    assert.equal(A.requireTicket(dir, { ticket: id, run: 'run-1', change: 'chg_000000000002', now, consume: false }).reason, 'wrong-change');
    assert.equal(A.requireTicket(dir, { ticket: null, run: 'run-1', now, consume: false }).reason, 'no-ticket');
    const ok = A.requireTicket(dir, { ticket: id, run: 'run-1', change: 'chg_000000000001', now });
    assert.equal(ok.ok, true);
    assert.equal(A.requireTicket(dir, { ticket: id, run: 'run-1', now }).reason, 'missing', 'consumed on first use');
    // the command string works as well as the id
    A.issueTicket(dir, { command: cmd, run: 'run-1', now });
    assert.equal(A.requireTicket(dir, { ticket: cmd, run: 'run-1', now }).ok, true);
  } finally { cleanup(); }
});

test('pruneTickets removes only expired files', () => {
  const { dir, cleanup } = tempDir();
  try {
    A.issueTicket(dir, { command: 'a b', now: 0 });
    A.issueTicket(dir, { command: 'c d', now: 10 * 60 * 1000 });
    assert.equal(A.pruneTickets(dir, { now: 16 * 60 * 1000 }), 1);
    assert.equal(A.checkTicket(dir, 'c d', { now: 16 * 60 * 1000 }).ok, true);
  } finally { cleanup(); }
});

test('redactCommand hides env secrets, flag values, headers and basic-auth URLs', () => {
  const env = { SHOPIFY_ADMIN_TOKEN: 'shpat_0123456789abcdef', WP_APP_PASSWORD: 'abcd efgh ijkl mnop' };
  const line = 'curl -H "X-Shopify-Access-Token: shpat_0123456789abcdef" https://s.myshopify.com/admin';
  const red = A.redactCommand(line, { env });
  assert.ok(!red.includes('shpat_0123456789abcdef'));
  assert.match(red, /\[redacted:SHOPIFY_ADMIN_TOKEN\]|\[redacted\]/);

  assert.ok(!A.redactCommand('wp user create bob --user_pass=hunter2secret', { env: {} }).includes('hunter2secret'));
  assert.ok(!A.redactCommand('deploy --token abcdef123456', { env: {} }).includes('abcdef123456'));
  assert.equal(A.redactCommand('curl https://admin:s3cr3tpass@example.com/x', { env: {} }), 'curl https://admin:[redacted]@example.com/x');
  assert.ok(!A.redactCommand('SHOPIFY_CLI_THEME_TOKEN=shptka_zzzz9999 shopify theme push', { env: {} }).includes('shptka_zzzz9999'));
  // a non-secret value is left readable
  assert.match(A.redactCommand('shopify theme list --store my-store.myshopify.com', { env: { SHOPIFY_STORE: 'my-store.myshopify.com' } }), /my-store\.myshopify\.com/);
});

test('canonicalJson sorts keys recursively so hashes are stable', () => {
  assert.equal(A.canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }), '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  assert.equal(A.canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
});

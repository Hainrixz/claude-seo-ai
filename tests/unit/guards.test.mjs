// The two PreToolUse hooks, exercised the way Claude Code runs them: a JSON payload on stdin, a
// JSON decision on stdout, an exit code that means block or not. Everything here is offline and
// uses throwaway directories — no ticket is ever read from the real ~/.claude-seo-ai.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD_WRITE = join(ROOT, 'scripts', 'guard-write.mjs');
const GUARD_BASH = join(ROOT, 'scripts', 'guard-bash.mjs');
const A = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'adapter.mjs')).href);
const GB = await import(pathToFileURL(GUARD_BASH).href);
const GW = await import(pathToFileURL(GUARD_WRITE).href);

function tempDir(prefix = 'cseo-guard-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Run a hook the way the hook runner does. Returns { status, decision, reason, stdout, stderr }. */
function runHook(script, payload, { args = [], env = {} } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: '', CLAUDE_SEO_AI_HOME: '', CLAUDE_PLUGIN_DATA: '', ...env },
  });
  let json = null;
  if (r.stdout && r.stdout.trim()) { try { json = JSON.parse(r.stdout); } catch { /* asserted by the caller */ } }
  const out = json && json.hookSpecificOutput ? json.hookSpecificOutput : null;
  return {
    status: r.status, stdout: r.stdout, stderr: r.stderr, json,
    event: out ? out.hookEventName : null,
    decision: out ? out.permissionDecision : null,
    reason: out ? out.permissionDecisionReason : '',
  };
}

const writePayload = (toolInput, cwd = null) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: cwd || undefined, tool_input: toolInput,
});
const bashPayload = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

// ---------------------------------------------------------------------------
// guard-write

test('guard-write denies the protected paths, whatever tool asked', () => {
  const cases = [
    ['/repo/.env', 'env-file'],
    ['/repo/.env.local', 'env-file'],
    ['/repo/.git/config', 'vcs-internals'],
    ['/repo/config/settings_data.json', 'shopify-settings-data'],
    ['/srv/site/wp-config.php', 'wp-config'],
    ['/home/u/.ssh/id_ed25519', 'ssh-key'],
    ['/repo/certs/server.pem', 'key-material'],
    ['/repo/package-lock.json', 'lockfile'],
  ];
  for (const [path, rule] of cases) {
    const hit = GW.protectedReason(path);
    assert.ok(hit, path + ' must be protected');
    assert.equal(hit.rule, rule, path);
    const r = runHook(GUARD_WRITE, writePayload({ file_path: path }), { env: { CLAUDE_PROJECT_DIR: '/repo' } });
    assert.equal(r.status, 2, path + ' must block with exit 2 — got ' + r.status + ' ' + r.stderr);
    assert.equal(r.event, 'PreToolUse');
    assert.equal(r.decision, 'deny', path);
    assert.match(r.stderr, /claude-seo-ai/);
  }
});

test('guard-write normalizes Windows separators before matching', () => {
  assert.equal(GW.normalizePath('C:\\repo\\.git\\config'), 'C:/repo/.git/config');
  const r = runHook(GUARD_WRITE, writePayload({ file_path: 'C:\\repo\\.env' }));
  assert.equal(r.status, 2);
  assert.equal(r.decision, 'deny');
});

test('guard-write reads notebook_path and MultiEdit-style edits, not just file_path', () => {
  assert.deepEqual(GW.targetPaths({ notebook_path: '/repo/.env' }), ['/repo/.env']);
  assert.deepEqual(GW.targetPaths({ file_path: '/a', edits: [{ file_path: '/repo/.git/HEAD' }] }), ['/a', '/repo/.git/HEAD']);
  const notebook = runHook(GUARD_WRITE, { tool_name: 'NotebookEdit', tool_input: { notebook_path: '/repo/.env' } });
  assert.equal(notebook.status, 2, 'notebook_path must be inspected');
  const multi = runHook(GUARD_WRITE, { tool_name: 'MultiEdit', tool_input: { file_path: '/repo/ok.md', edits: [{ file_path: '/repo/.git/HEAD' }] } });
  assert.equal(multi.status, 2, 'every edit target must be inspected');
});

test('guard-write allows a write inside the project and inside the data dir', () => {
  const { dir, cleanup } = tempDir();
  try {
    const project = join(dir, 'project');
    const data = join(dir, 'data');
    mkdirSync(project, { recursive: true });
    mkdirSync(data, { recursive: true });
    const inside = runHook(GUARD_WRITE, writePayload({ file_path: join(project, 'src', 'index.html') }),
      { args: ['--data', data], env: { CLAUDE_PROJECT_DIR: project } });
    assert.equal(inside.status, 0);
    assert.equal(inside.stdout, '', 'an allowed write produces no output — the hook never emits `allow`');

    const worktree = runHook(GUARD_WRITE, writePayload({ file_path: join(project, '.claude', 'worktrees', 'wt1', 'page.html') }),
      { args: ['--data', data], env: { CLAUDE_PROJECT_DIR: project } });
    assert.equal(worktree.status, 0, '.claude/worktrees is inside the containment');

    const backup = runHook(GUARD_WRITE, writePayload({ file_path: join(data, 'backups', 'run1', 'index.html') }),
      { args: ['--data', data], env: { CLAUDE_PROJECT_DIR: project } });
    assert.equal(backup.status, 0, 'the plugin data dir is a containment root');
  } finally { cleanup(); }
});

test('guard-write asks (never silently allows) for a write outside the project', () => {
  const { dir, cleanup } = tempDir();
  try {
    const project = join(dir, 'project');
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(project, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    const r = runHook(GUARD_WRITE, writePayload({ file_path: join(elsewhere, 'notes.md') }),
      { args: ['--data', join(dir, 'data')], env: { CLAUDE_PROJECT_DIR: project } });
    assert.equal(r.status, 0, 'containment asks, it does not block unrelated work');
    assert.equal(r.decision, 'ask');
    assert.match(r.reason, /outside the project root/);
  } finally { cleanup(); }
});

test('guard-write falls back to the payload cwd and says so when CLAUDE_PROJECT_DIR is unset', () => {
  const { dir, cleanup } = tempDir();
  try {
    const project = join(dir, 'project');
    mkdirSync(project, { recursive: true });
    const roots = GW.allowedRoots({ env: {}, cwd: project, argv: [] });
    assert.equal(roots.source, 'payload.cwd');
    assert.match(roots.warn, /CLAUDE_PROJECT_DIR is not set/);
    const r = runHook(GUARD_WRITE, writePayload({ file_path: join(dir, 'outside.md') }, project), { args: ['--data', join(dir, 'data')] });
    assert.equal(r.decision, 'ask');
    assert.match(r.reason, /CLAUDE_PROJECT_DIR is not set/);
  } finally { cleanup(); }
});

test('guard-write has no opinion on a payload with no path, and never crashes on junk', () => {
  assert.equal(runHook(GUARD_WRITE, { tool_name: 'Bash', tool_input: { command: 'ls' } }).status, 0);
  const junk = spawnSync(process.execPath, [GUARD_WRITE], { encoding: 'utf8', input: 'not json at all' });
  assert.equal(junk.status, 0, 'an unreadable payload must not block every write');
});

// ---------------------------------------------------------------------------
// guard-bash

test('guard-bash always denies a live Shopify theme push, ticket or not', () => {
  const { dir, cleanup } = tempDir();
  try {
    for (const command of [
      'shopify theme push --allow-live --path work',
      'shopify theme push --path work --live',
      'shopify theme push -a',
      'cd work && shopify theme push --publish',
    ]) {
      A.issueTicket(dir, { command, run: 'r1', change: 'chg_1' }); // even a valid ticket must not unlock it
      const r = runHook(GUARD_BASH, bashPayload(command), { args: ['--data', dir] });
      assert.equal(r.status, 2, command);
      assert.equal(r.decision, 'deny', command);
      assert.match(r.reason, /live/i);
    }
  } finally { cleanup(); }
});

test('guard-bash asks when a valid ticket covers the command and denies when none does', () => {
  const { dir, cleanup } = tempDir();
  try {
    const command = 'shopify theme push --path work --unpublished --json';
    const denied = runHook(GUARD_BASH, bashPayload(command), { args: ['--data', dir] });
    assert.equal(denied.status, 2, 'no ticket must block');
    assert.equal(denied.decision, 'deny');
    assert.match(denied.reason, /no valid confirmation ticket/);

    A.issueTicket(dir, { command, run: 'r1', change: 'chg_1' });
    const asked = runHook(GUARD_BASH, bashPayload(command), { args: ['--data', dir] });
    assert.equal(asked.status, 0, 'a covered command is not blocked');
    assert.equal(asked.decision, 'ask', 'a ticket downgrades the block to the user\'s own prompt');
    assert.match(asked.reason, /confirmation ticket/);

    // The hook must not consume the ticket: the adapter needs it a moment later.
    const again = runHook(GUARD_BASH, bashPayload(command), { args: ['--data', dir] });
    assert.equal(again.decision, 'ask', 'guard-bash reads the ticket, it never burns it');
  } finally { cleanup(); }
});

test('guard-bash denies an expired ticket and a consumed one', () => {
  const { dir, cleanup } = tempDir();
  try {
    const command = 'shopify theme publish --theme 123';
    A.issueTicket(dir, { command, run: 'r1', change: 'chg_1', ttlMs: 1000, now: Date.now() - 60_000 });
    const expired = runHook(GUARD_BASH, bashPayload(command), { args: ['--data', dir] });
    assert.equal(expired.status, 2);
    assert.match(expired.reason, /expired|no-ticket/);

    A.issueTicket(dir, { command, run: 'r1', change: 'chg_1' });
    assert.equal(A.consumeTicket(dir, command).ok, true, 'the adapter consumes it');
    const consumed = runHook(GUARD_BASH, bashPayload(command), { args: ['--data', dir] });
    assert.equal(consumed.status, 2, 'a one-shot ticket unlocks exactly one run');
    assert.equal(consumed.decision, 'deny');
  } finally { cleanup(); }
});

test('guard-bash finds the ticket wherever the fix flow put it (CLAUDE_SEO_AI_HOME wins over --data)', () => {
  // hooks.json passes a static --data "${CLAUDE_PLUGIN_DATA}", but lib/adapter.mjs writes tickets to
  // CLAUDE_SEO_AI_HOME when it is set. If the hook looked only at its flag, every confirmed command
  // on such a machine would be denied.
  const home = tempDir();
  const flagged = tempDir();
  try {
    const command = 'shopify theme push --path work --unpublished';
    A.issueTicket(home.dir, { command, run: 'r1', change: 'chg_1' });
    const r = runHook(GUARD_BASH, bashPayload(command), { args: ['--data', flagged.dir], env: { CLAUDE_SEO_AI_HOME: home.dir } });
    assert.equal(r.decision, 'ask', 'the ticket store the fix flow actually used must be consulted');
    assert.ok(GW.dataDirCandidates({ env: { CLAUDE_SEO_AI_HOME: home.dir }, argv: ['--data', flagged.dir] }).length >= 2);
  } finally { home.cleanup(); flagged.cleanup(); }
});

test('guard-bash accepts the ticket id carried by an adapter apply command', () => {
  const { dir, cleanup } = tempDir();
  try {
    const base = 'node /plugin/scripts/adapters/wordpress-rest.mjs apply --run /d/fix/runs/r1 --change chg_1';
    const issued = A.issueTicket(dir, { command: base, run: 'r1', change: 'chg_1' });
    const withTicket = base + ' --ticket ' + issued.id;
    assert.equal(GB.extractTicketArg(withTicket), issued.id);
    assert.equal(GB.stripTicketArg(withTicket), base);
    const r = runHook(GUARD_BASH, bashPayload(withTicket), { args: ['--data', dir] });
    assert.equal(r.decision, 'ask', 'the ticket the fix flow issued covers the command that carries its id');
    assert.equal(r.status, 0);
  } finally { cleanup(); }
});

test('guard-bash denies the ungated remote write surface without a ticket', () => {
  const { dir, cleanup } = tempDir();
  try {
    for (const command of [
      'wp option update blog_public 1',
      'wp post meta update 12 _aioseo_title "Rain shadow"',
      'ssh -o BatchMode=yes deploy@host "cd /srv/wp; wp post update 12 --post_excerpt=hi"',
      'curl -X POST https://shop.myshopify.com/admin/api/2026-07/graphql.json -d @q.json',
      'curl --data @body.json https://example.com/wp-json/wp/v2/posts/12',
      'wget --method=PATCH https://api.hubapi.com/cms/v3/pages/site-pages/1/draft',
      'node /plugin/scripts/adapters/shopify-theme.mjs publish --run /d/fix/runs/r1',
    ]) {
      const r = runHook(GUARD_BASH, bashPayload(command), { args: ['--data', dir] });
      assert.equal(r.status, 2, 'must be gated: ' + command);
      assert.equal(r.decision, 'deny', command);
    }
  } finally { cleanup(); }
});

test('a URL query string does not hide the API host from the write rule', () => {
  // segments() used to split on a bare `&`, so `?x=1&y=2` tore the command in two and the half
  // carrying the Admin API host lost its `-X POST`: the write sailed past the gate.
  const command = 'curl "https://s.myshopify.com/admin/api/2026-07/graphql.json?x=1&y=2" -X POST -d @q.json';
  assert.deepEqual(GB.segments(command), [command], 'a quoted URL is one statement, not two');
  const verdict = GB.classify(command);
  assert.equal(verdict.tier, 'gate');
  assert.equal(verdict.rule, 'platform-api-write');

  const { dir, cleanup } = tempDir();
  try {
    const denied = runHook(GUARD_BASH, bashPayload(command), { args: ['--data', dir] });
    assert.equal(denied.status, 2, 'a write against the Admin API is gated even with a query string');
    assert.equal(denied.decision, 'deny');
    A.issueTicket(dir, { command, run: 'r1', change: 'chg_1' });
    assert.equal(runHook(GUARD_BASH, bashPayload(command), { args: ['--data', dir] }).decision, 'ask');
  } finally { cleanup(); }
});

test('segments splits on unquoted shell operators only', () => {
  assert.deepEqual(GB.segments('a && b'), ['a', 'b']);
  assert.deepEqual(GB.segments('a || b'), ['a', 'b']);
  assert.deepEqual(GB.segments('a; b'), ['a', 'b']);
  assert.deepEqual(GB.segments('a | b'), ['a', 'b']);
  assert.deepEqual(GB.segments('a\nb'), ['a', 'b']);
  // `&` is a query-string separator far more often than a backgrounding operator here, and every
  // rule matches on substrings, so keeping the statement whole costs nothing and misses nothing.
  assert.deepEqual(GB.segments('curl "http://x/y?a=1&b=2"'), ['curl "http://x/y?a=1&b=2"']);
  assert.deepEqual(GB.segments("echo 'a && b'"), ["echo 'a && b'"], 'a quoted operator is text');
  assert.deepEqual(GB.segments('echo "a; b" ; ls'), ['echo "a; b"', 'ls']);
  assert.deepEqual(GB.segments('npm run build 2>&1 | tee out.log'), ['npm run build 2>&1', 'tee out.log']);
  assert.deepEqual(GB.segments(''), []);
  assert.deepEqual(GB.segments(null), []);

  // A remote command whose quotes are now respected is classified as the remote write it is.
  const remote = GB.classify('ssh deploy@host "cd /srv/wp && wp option update blog_public 1"');
  assert.equal(remote.tier, 'gate');
  assert.equal(remote.rule, 'wp-cli-write-remote');
});

test('guard-bash denies a redirect or tee into a protected file', () => {
  const { dir, cleanup } = tempDir();
  try {
    for (const command of [
      'echo "TOKEN=x" > .env',
      'printf x >> /repo/.env.local',
      'cat body | tee /repo/.git/config',
      'echo x | tee -a ~/.ssh/id_ed25519',
    ]) {
      const r = runHook(GUARD_BASH, bashPayload(command), { args: ['--data', dir] });
      assert.equal(r.status, 2, command);
      assert.equal(r.decision, 'deny', command);
      assert.match(r.reason, /redirect|write/i);
    }
  } finally { cleanup(); }
});

test('guard-bash lets ordinary work through without touching the ticket store', () => {
  // --data points at a directory that does not exist: a harmless command must never look there.
  const missing = join(tmpdir(), 'cseo-guard-does-not-exist-' + Date.now());
  for (const command of [
    'ls -la',
    'git status --porcelain',
    'npm run build 2>&1 | tee build.log',
    'wp option get blog_public',
    'wp post meta get 12 _aioseo_title',
    'curl -s https://shop.myshopify.com/admin/api/2026-07/graphql.json',
    'node /plugin/scripts/adapters/local-files.mjs preview --run /d/fix/runs/r1 --change chg_1',
    'node /plugin/scripts/fix-plan.mjs --report r.json --profile p.json',
  ]) {
    const r = runHook(GUARD_BASH, bashPayload(command), { args: ['--data', missing] });
    assert.equal(r.status, 0, 'must be allowed: ' + command + ' -> ' + r.stderr);
    assert.equal(r.stdout, '', 'no decision is emitted for an ordinary command: ' + command);
  }
});

test('guard-bash classify() is pure and importing the hooks has no side effects', () => {
  assert.equal(GB.classify('ls -la').tier, 'none');
  assert.equal(GB.classify('shopify theme push --allow-live').tier, 'deny');
  assert.equal(GB.classify('shopify theme push --unpublished').tier, 'gate');
  assert.equal(GB.touchesLiveFlag('shopify theme push --unpublished'), null);
  assert.equal(GB.touchesLiveFlag('shopify theme push -l'), '-l');
  assert.deepEqual(GB.redirectTargets('echo x > out.txt'), ['out.txt']);
  assert.deepEqual(GB.redirectTargets('npm run build 2>&1'), [], 'a stderr redirect is not a file write');
  assert.equal(GB.wpSubcommand('curl https://x/wp-json/wp/v2/posts'), null, 'a wp-json URL is not a WP-CLI call');
  assert.equal(typeof GW.decide, 'function');
  assert.equal(process.exitCode, undefined, 'importing a hook must not set an exit code');
});

// ---------------------------------------------------------------------------
// contracts the safety model depends on

test('hooks.json wires both guards on PreToolUse with the data dir', () => {
  const wiring = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const entries = wiring.hooks.PreToolUse;
  assert.equal(entries.length, 2);
  const byMatcher = Object.fromEntries(entries.map((e) => [e.matcher, e.hooks[0]]));
  assert.ok(byMatcher['Write|Edit|MultiEdit|NotebookEdit'], 'the file tools matcher must cover MultiEdit and NotebookEdit');
  assert.ok(byMatcher.Bash, 'Bash needs its own guard — the writer holds Bash');
  for (const [matcher, hook] of Object.entries(byMatcher)) {
    assert.equal(hook.type, 'command', matcher);
    assert.match(hook.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/guard-(write|bash)\.mjs/, matcher);
    assert.match(hook.command, /--data "\$\{CLAUDE_PLUGIN_DATA\}"/, matcher + ' must pass the data dir for ticket lookup');
    assert.equal(hook.timeout, 10, matcher + ' must stay fast');
  }
});

test('plugin.json userConfig covers every credential key with matching sensitivity', async () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const C = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'credentials.mjs')).href);
  assert.ok(manifest.userConfig && typeof manifest.userConfig === 'object', 'the manifest must declare userConfig');
  for (const key of C.KEY_NAMES) {
    const entry = manifest.userConfig[key];
    assert.ok(entry, 'userConfig is missing ' + key);
    assert.equal(entry.type, 'string', key + ' must be a string option');
    assert.ok(entry.title && entry.description, key + ' needs a title and a description');
    assert.equal(!!entry.sensitive, C.isSensitive(key), key + ' sensitivity must match KEY_CATALOG');
    assert.notEqual(entry.required, true, key + ' must stay optional — the plugin audits without credentials');
  }
});

test('a ticket binds to its run and change: one confirmation never unlocks another', () => {
  const { dir, cleanup } = tempDir();
  try {
    const command = 'node /plugin/scripts/adapters/wordpress-rest.mjs apply --run /d/r1 --change chg_a';
    A.issueTicket(dir, { command, run: 'r1', change: 'chg_a' });
    assert.equal(A.requireTicket(dir, { ticket: command, run: 'r1', change: 'chg_b', consume: false }).reason, 'wrong-change');
    assert.equal(A.requireTicket(dir, { ticket: command, run: 'r2', change: 'chg_a', consume: false }).reason, 'wrong-run');
    assert.equal(A.requireTicket(dir, { ticket: command, run: 'r1', change: 'chg_a', consume: false }).ok, true);
  } finally { cleanup(); }
});

test('fix-ticket issue/check/consume is the CLI over that same store', () => {
  const { dir, cleanup } = tempDir();
  try {
    const cli = (...args) => {
      const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'fix-ticket.mjs'), ...args, '--data', dir], { encoding: 'utf8' });
      return { status: r.status, out: JSON.parse(r.stdout) };
    };
    const command = 'shopify theme push --unpublished';
    const issued = cli('issue', '--command', command, '--run', 'r1', '--change', 'chg_1');
    assert.equal(issued.status, 0);
    assert.match(issued.out.id, /^[0-9a-f]{64}$/);
    assert.equal(issued.out.one_shot, true);
    assert.equal(issued.out.command_preview, command, 'the preview is redacted, not hidden');

    assert.equal(cli('check', '--command', command).status, 0);
    assert.equal(cli('check', '--id', issued.out.id).out.ok, true);
    assert.equal(cli('consume', '--command', command).out.consumed, true);
    const after = cli('check', '--command', command);
    assert.equal(after.status, 3, 'a consumed one-shot ticket is gone (THRESHOLD)');
    assert.equal(after.out.ok, false);
    assert.ok(after.out.hint, 'a failed check explains what to do');

    const usage = spawnSync(process.execPath, [join(ROOT, 'scripts', 'fix-ticket.mjs'), 'nonsense'], { encoding: 'utf8' });
    assert.equal(usage.status, 1, 'an unknown op is a usage error');
  } finally { cleanup(); }
});

test('fix-ticket redacts a credential-shaped value out of the stored preview', () => {
  const { dir, cleanup } = tempDir();
  try {
    const command = 'curl -H "X-Shopify-Access-Token: shpat_supersecret" https://s.myshopify.com/admin/api/2026-07/graphql.json';
    const issued = A.issueTicket(dir, { command, run: 'r1', change: 'chg_1' });
    const stored = JSON.parse(readFileSync(issued.path, 'utf8'));
    assert.ok(!stored.command_preview.includes('shpat_supersecret'), 'a stored preview must never carry a token');
    assert.match(stored.command_preview, /\[redacted\]/);
    assert.equal(stored.command, undefined, 'the ticket stores the hash, never the command');
  } finally { cleanup(); }
});

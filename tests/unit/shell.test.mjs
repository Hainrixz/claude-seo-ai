// Unit tests for scripts/lib/shell.mjs — quoting, ssh and WP-CLI command construction.
// Nothing here executes a command; the module only builds argv arrays and printable strings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const S = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'shell.mjs')).href);

test('quote leaves safe tokens alone and single-quotes everything else', () => {
  assert.equal(S.quote('blog_public'), 'blog_public');
  assert.equal(S.quote('/srv/www/site'), '/srv/www/site');
  assert.equal(S.quote('user@host'), 'user@host');
  assert.equal(S.quote(''), "''");
  assert.equal(S.quote('two words'), "'two words'");
  assert.equal(S.quote('a;rm -rf /'), "'a;rm -rf /'");
  assert.equal(S.quote('$(whoami)'), "'$(whoami)'");
  assert.equal(S.quote('`id`'), "'`id`'");
});

test("a single quote inside a value cannot end the argument", () => {
  assert.equal(S.quote("it's"), "'it'\\''s'");
  // the classic break-out attempt stays one argument
  const evil = "'; rm -rf / #";
  const quoted = S.quote(evil);
  assert.equal(quoted, "''\\''; rm -rf / #'");
  assert.ok(quoted.startsWith("'") && quoted.endsWith("'"));
});

test('joinCommand renders an argv array as a safe one-liner', () => {
  assert.equal(S.joinCommand(['wp', 'post', 'update', '12', '--post_excerpt=A short summary']),
    "wp post update 12 '--post_excerpt=A short summary'");
});

test('parseSshTarget understands user@host:/path and its shorter forms', () => {
  assert.deepEqual(S.parseSshTarget('deploy@web1.example.com:/srv/wp'),
    { user: 'deploy', host: 'web1.example.com', path: '/srv/wp', target: 'deploy@web1.example.com' });
  assert.deepEqual(S.parseSshTarget('web1:/srv'), { user: null, host: 'web1', path: '/srv', target: 'web1' });
  assert.deepEqual(S.parseSshTarget('deploy@web1'), { user: 'deploy', host: 'web1', path: null, target: 'deploy@web1' });
  assert.equal(S.parseSshTarget(''), null);
  assert.equal(S.parseSshTarget('not a host'), null);
});

test('buildSsh sets BatchMode and ConnectTimeout and quotes the remote command as one argument', () => {
  const out = S.buildSsh({ host: 'deploy@web1:/srv/wp', cmd: ['wp', 'option', 'get', 'blog_public', '--format=json'] });
  assert.deepEqual(out.argv, ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'deploy@web1',
    "cd /srv/wp && wp option get blog_public --format=json"]);
  assert.equal(out.command, "ssh -o BatchMode=yes -o ConnectTimeout=10 deploy@web1 'cd /srv/wp && wp option get blog_public --format=json'");
  assert.equal(out.host, 'deploy@web1');
  assert.equal(out.path, '/srv/wp');
});

test('buildSsh keeps a hostile path inside its quotes', () => {
  const out = S.buildSsh({ host: 'u@h', path: "/srv/'; rm -rf /", cmd: 'wp cli version' });
  assert.equal(out.remote, "cd '/srv/'\\''; rm -rf /' && wp cli version");
  assert.equal(out.argv[out.argv.length - 1], out.remote);
});

test('buildSsh accepts a port, an identity file and extra options, and needs a command', () => {
  const out = S.buildSsh({ host: 'u@h', cmd: 'wp cli version', port: 2222, identity: '/keys/id_ed25519', options: ['StrictHostKeyChecking=yes'] });
  assert.ok(out.argv.includes('-p') && out.argv.includes('2222'));
  assert.ok(out.argv.includes('-i') && out.argv.includes('/keys/id_ed25519'));
  assert.ok(out.command.includes('StrictHostKeyChecking=yes'));
  assert.throws(() => S.buildSsh({ host: 'u@h', cmd: '' }), /cmd is required/);
  assert.throws(() => S.buildSsh({ host: 'not a host', cmd: 'x' }), /invalid host/);
});

test('buildWpCli: local transport adds --path', () => {
  const out = S.buildWpCli({ args: ['option', 'get', 'blog_public'], path: '/srv/wp', format: 'json' });
  assert.equal(out.transport, 'local');
  assert.equal(out.command, 'wp option get blog_public --format=json --path=/srv/wp');
  assert.equal(out.writes, false);
});

test("buildWpCli: ssh transport wraps the command, wp-ssh uses WP-CLI's own flag", () => {
  const viaSsh = S.buildWpCli({ args: ['option', 'update', 'blog_public', '1'], ssh: 'deploy@web1:/srv/wp' });
  assert.equal(viaSsh.transport, 'ssh');
  assert.equal(viaSsh.command, "ssh -o BatchMode=yes -o ConnectTimeout=10 deploy@web1 'cd /srv/wp && wp option update blog_public 1'");
  assert.equal(viaSsh.writes, true, 'option update is a write and must be ticket-gated');

  const viaWp = S.buildWpCli({ args: ['post', 'meta', 'get', '12', '_key'], ssh: 'deploy@web1:/srv/wp', transport: 'wp-ssh', format: 'json' });
  assert.equal(viaWp.command, 'wp post meta get 12 _key --format=json --ssh=deploy@web1:/srv/wp');
  assert.equal(viaWp.writes, false);
});

test('buildWpCli quotes values with spaces and rejects a bad transport target', () => {
  const out = S.buildWpCli({ args: ['post', 'update', '12', '--post_excerpt=Two words here'], path: '/srv' });
  assert.ok(out.command.includes("'--post_excerpt=Two words here'"));
  assert.throws(() => S.buildWpCli({ args: [] }), /args is required/);
  assert.throws(() => S.buildWpCli({ args: ['x'], transport: 'wp-ssh' }), /needs an --ssh target/);
});

test('isWpWrite separates reads from writes', () => {
  assert.equal(S.isWpWrite(['option', 'get', 'blog_public']), false);
  assert.equal(S.isWpWrite(['core', 'version']), false);
  assert.equal(S.isWpWrite(['option', 'update', 'blog_public', '1']), true);
  assert.equal(S.isWpWrite(['post', 'meta', 'update', '12', 'k', 'v']), true);
  assert.equal(S.isWpWrite('db query "DROP TABLE"'), true);
});

test('buildShopifyTheme keeps credentials out of argv', () => {
  const out = S.buildShopifyTheme({ args: ['push', '--unpublished', '--json'], path: '/data/work/theme' });
  assert.deepEqual(out.argv, ['shopify', 'theme', 'push', '--unpublished', '--json', '--path', '/data/work/theme']);
  assert.deepEqual(out.env_from_keys, { SHOPIFY_FLAG_STORE: 'SHOPIFY_STORE', SHOPIFY_CLI_THEME_TOKEN: 'SHOPIFY_THEME_TOKEN' });
  assert.ok(!out.command.includes('TOKEN'), 'no token ever reaches the command line');
});

test('touchesLiveTheme catches every flag that would publish to the live storefront', () => {
  for (const flag of S.SHOPIFY_LIVE_FLAGS) assert.equal(S.touchesLiveTheme(['shopify', 'theme', 'push', flag]), true, flag);
  assert.equal(S.touchesLiveTheme(['shopify', 'theme', 'push', '--unpublished']), false);
  assert.equal(S.touchesLiveTheme('shopify theme push --allow-live'), true);
});

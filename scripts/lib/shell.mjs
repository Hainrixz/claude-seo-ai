// Command construction for the adapters that shell out (WP-CLI over SSH, the Shopify CLI).
//
// Everything here builds *strings and argv arrays*; nothing executes. The adapter passes the argv
// to execFile (no shell), and prints the joined string only as a preview. Two rules:
//   1. Every interpolated value goes through quote() — a post slug with a quote in it must not be
//      able to end an argument and start a new command on someone's production server.
//   2. Secrets never appear in argv (they go in the child's env), so these strings are safe to show.
//
// SSH defaults to BatchMode=yes: an unknown host key or a password prompt fails fast instead of
// hanging a subagent forever, and host-key trust stays the user's decision in their own ssh config.

/** Characters that are safe unquoted in every POSIX shell. */
const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** True when the token needs no quoting at all. */
export function isSafeToken(value) { return SAFE_TOKEN.test(String(value)); }

/**
 * POSIX single-quote one argument. Single quotes inside become `'\''`, which is the only fully
 * general form. An empty string becomes `''` (not nothing).
 */
export function quote(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (s === '') return "''";
  if (isSafeToken(s)) return s;
  return "'" + s.split("'").join("'\\''") + "'";
}

/** Quote every argument. */
export function quoteAll(args) { return (Array.isArray(args) ? args : [args]).map(quote); }

/** Join an argv array into a printable, shell-safe command line. */
export function joinCommand(args) { return quoteAll(args).join(' '); }

/** Default ssh options: fail instead of prompting, and give up on a dead host quickly. */
export const SSH_DEFAULT_OPTIONS = Object.freeze(['BatchMode=yes', 'ConnectTimeout=10']);

/**
 * Parse `user@host:/path`, `host:/path` or a bare `user@host`.
 * @returns {{user: string|null, host: string, path: string|null, target: string}|null}
 */
export function parseSshTarget(target) {
  const s = String(target == null ? '' : target).trim();
  if (!s) return null;
  const m = /^(?:([^@\s:]+)@)?([A-Za-z0-9._-]+|\[[0-9a-fA-F:.]+\])(?::(.*))?$/.exec(s);
  if (!m) return null;
  const [, user, host, path] = m;
  if (!host) return null;
  return { user: user || null, host, path: path && path.trim() ? path.trim() : null, target: user ? user + '@' + host : host };
}

/**
 * Build an ssh invocation that runs `cmd` inside `path` on `host`.
 *
 * `cmd` may be a string (already-quoted command line) or an argv array (quoted here). The remote
 * command is `cd <path> && <cmd>`, single-quoted as one argument, so the local shell never expands
 * anything in it.
 *
 * @param {object} opts
 * @param {string} opts.host              `user@host` or `user@host:/path`
 * @param {string} [opts.path]            remote working directory (overrides the one in `host`)
 * @param {string|string[]} opts.cmd
 * @param {number} [opts.port]
 * @param {string} [opts.identity]        -i key path
 * @param {string[]} [opts.options]       extra `-o Key=value` entries
 * @param {number} [opts.connectTimeout=10]
 * @param {boolean} [opts.batchMode=true]
 * @returns {{argv: string[], command: string, remote: string, host: string, path: string|null}}
 */
export function buildSsh({ host, path = null, cmd, port = null, identity = null, options = [], connectTimeout = 10, batchMode = true } = {}) {
  const parsed = parseSshTarget(host);
  if (!parsed) throw new Error('buildSsh: invalid host ' + JSON.stringify(host));
  const dir = path || parsed.path;
  const body = Array.isArray(cmd) ? joinCommand(cmd) : String(cmd == null ? '' : cmd).trim();
  if (!body) throw new Error('buildSsh: cmd is required');
  const remote = dir ? 'cd ' + quote(dir) + ' && ' + body : body;

  const opts = [];
  if (batchMode) opts.push('BatchMode=yes');
  if (Number.isFinite(Number(connectTimeout)) && Number(connectTimeout) > 0) opts.push('ConnectTimeout=' + Number(connectTimeout));
  for (const o of Array.isArray(options) ? options : [options]) if (o) opts.push(String(o));

  const argv = ['ssh'];
  for (const o of opts) argv.push('-o', o);
  if (port) argv.push('-p', String(Number(port)));
  if (identity) argv.push('-i', String(identity));
  argv.push(parsed.target, remote);
  return { argv, command: joinCommand(argv), remote, host: parsed.target, path: dir };
}

/** WP-CLI subcommands that change state — the ones a ticket must gate. */
export const WP_WRITE_VERBS = Object.freeze([
  'option update', 'option add', 'option delete', 'post update', 'post create', 'post delete',
  'post meta update', 'post meta add', 'post meta delete', 'term update', 'user update',
  'plugin install', 'plugin activate', 'plugin deactivate', 'theme activate', 'db query', 'db import',
  'cache flush', 'rewrite flush', 'media import',
]);

/** True when a WP-CLI argument list writes something (used for previews and the Bash guard). */
export function isWpWrite(args) {
  const line = (Array.isArray(args) ? args : String(args || '').split(/\s+/)).join(' ').toLowerCase();
  return WP_WRITE_VERBS.some((verb) => line.startsWith(verb) || line.includes(' ' + verb));
}

/**
 * Build a `wp` command line, optionally over SSH.
 *
 * Transports:
 *   'local'  — `wp <args> --path=<path>`
 *   'wp-ssh' — `wp <args> --ssh=user@host:/path` (WP-CLI's own transport)
 *   'ssh'    — `ssh -o BatchMode=yes -o ConnectTimeout=10 user@host 'cd /path && wp <args>'`
 *
 * @param {object} opts
 * @param {string[]} opts.args            e.g. ['option', 'get', 'blog_public']
 * @param {string} [opts.ssh]             `user@host:/path`
 * @param {string} [opts.path]            WordPress root
 * @param {'local'|'ssh'|'wp-ssh'} [opts.transport]  defaults to 'ssh' when `ssh` is given
 * @param {string} [opts.format]          `--format=<f>` (use 'json' for machine-readable reads)
 * @param {string} [opts.url]             `--url=<u>` for multisite
 * @param {string[]} [opts.extra]         extra flags, appended verbatim (quoted)
 * @returns {{argv, command, transport, writes, remote?, host?, path?}}
 */
export function buildWpCli({ args, ssh = null, path = null, transport = null, format = null, url = null, extra = [] } = {}) {
  const list = (Array.isArray(args) ? args : String(args || '').trim().split(/\s+/)).filter(Boolean).map(String);
  if (!list.length) throw new Error('buildWpCli: args is required');
  const parsed = ssh ? parseSshTarget(ssh) : null;
  if (ssh && !parsed) throw new Error('buildWpCli: invalid --ssh target ' + JSON.stringify(ssh));
  const mode = transport || (ssh ? 'ssh' : 'local');
  const wpArgs = ['wp', ...list];
  if (format) wpArgs.push('--format=' + String(format));
  if (url) wpArgs.push('--url=' + String(url));
  for (const e of Array.isArray(extra) ? extra : [extra]) if (e) wpArgs.push(String(e));
  const writes = isWpWrite(list);

  if (mode === 'local') {
    const dir = path || (parsed && parsed.path) || null;
    const argv = dir ? [...wpArgs, '--path=' + dir] : wpArgs;
    return { argv, command: joinCommand(argv), transport: 'local', writes, path: dir };
  }
  if (mode === 'wp-ssh') {
    if (!parsed) throw new Error('buildWpCli: transport "wp-ssh" needs an --ssh target');
    const target = parsed.target + (parsed.path || path ? ':' + (parsed.path || path) : '');
    const argv = [...wpArgs, '--ssh=' + target];
    return { argv, command: joinCommand(argv), transport: 'wp-ssh', writes, host: parsed.target, path: parsed.path || path };
  }
  if (!parsed) throw new Error('buildWpCli: transport "ssh" needs an --ssh target');
  const built = buildSsh({ host: parsed.target, path: parsed.path || path, cmd: wpArgs });
  return { ...built, transport: 'ssh', writes };
}

/**
 * Build a Shopify CLI invocation. The store and the theme token travel in the child's environment
 * (SHOPIFY_FLAG_STORE / SHOPIFY_CLI_THEME_TOKEN), never in argv — `env` in the result is a map of
 * variable names to *the catalog key they come from*, so a caller can fill it without this module
 * ever seeing a secret.
 */
export function buildShopifyTheme({ args, path = null, extra = [] } = {}) {
  const list = (Array.isArray(args) ? args : String(args || '').trim().split(/\s+/)).filter(Boolean).map(String);
  if (!list.length) throw new Error('buildShopifyTheme: args is required');
  const argv = ['shopify', 'theme', ...list];
  if (path) argv.push('--path', String(path));
  for (const e of Array.isArray(extra) ? extra : [extra]) if (e) argv.push(String(e));
  return {
    argv, command: joinCommand(argv),
    env_from_keys: { SHOPIFY_FLAG_STORE: 'SHOPIFY_STORE', SHOPIFY_CLI_THEME_TOKEN: 'SHOPIFY_THEME_TOKEN' },
  };
}

/** Flags that publish a Shopify theme to the live storefront — always denied by the Bash guard. */
export const SHOPIFY_LIVE_FLAGS = Object.freeze(['--allow-live', '--live', '--publish', '-a', '-l', '-p']);

/** True when an argv/command line would push straight to the live theme. */
export function touchesLiveTheme(args) {
  const tokens = Array.isArray(args) ? args.map(String) : String(args || '').split(/\s+/);
  return tokens.some((t) => SHOPIFY_LIVE_FLAGS.includes(t));
}

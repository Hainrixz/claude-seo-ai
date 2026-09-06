#!/usr/bin/env node
// wordpress-wpcli — the WordPress write path that works when REST does not: WP-CLI, locally or
// over SSH. It is a *command builder* first and an executor second.
//
//   node scripts/adapters/wordpress-wpcli.mjs <op> --run <fix-run-dir> [--change <id>] [--ticket <t>]
//        [--ssh user@host:/path] [--path /var/www/site] [--transport local|ssh|wp-ssh] [--url <site>] [--json]
//   plan: --report <report.json> [--profile <profile.json>] [--category …] [--include-proposed]
//         [--answers <json|path>] [--plugin yoast|rankmath|seopress]
//   ops: capabilities | plan | preview | apply | verify | rollback
//
// Everything up to `apply` is text: every change carries the exact command line it would run, built
// by `lib/shell.mjs` with real quoting, and the read command that captured the value it is about to
// overwrite. Nothing is executed until a ticket unlocks `apply`, and the reads that build `before`
// are the only commands this adapter runs on its own — `wp … get`, never `update`.
//
// Two honesty notes are structural, not decoration:
//   * `wp_attachment_pages_enabled` is an **UNVERIFIED** option name. Its change says so in the
//     preview and in `payload.unverified`, and it is never planned as `auto`.
//   * AIOSEO keeps its SEO fields in its own database table rather than post meta, so this adapter
//     refuses to fake a `wp post meta update` for it and points at `wordpress-rest` instead.

import { execFile } from 'node:child_process';
import { EXIT, isMain, runCli } from '../lib/util.mjs';
import {
  canTransition, changeId, ensureConfirmed, loadFixRun, makeChange, openFixRun,
  requireTicket, resolveDataDir, transition, updateManifest,
} from '../lib/adapter.mjs';
import { buildWpCli, isWpWrite, parseSshTarget } from '../lib/shell.mjs';
import { explainKeys, redact, redactObject, resolveKey } from '../lib/credentials.mjs';
import { reproduceCommand } from '../lib/finding.mjs';
import { readJson, writeJson, writeText } from '../lib/store.mjs';
import {
  checkPublicUrl, groupByPage, logOpEvent, normalizeAnswers, opThrew, publicUrlFor, renderCommandPreview, slugOf,
  whichOnPath,
} from './_shared.mjs';

export const ADAPTER = 'wordpress-wpcli';
/** The only credential key here is a transport target — never a secret. */
export const KEYS = Object.freeze(['WP_SSH']);
const OPS = ['capabilities', 'plan', 'preview', 'apply', 'verify', 'rollback'];

/** Post-meta keys per SEO plugin. AIOSEO is absent on purpose: it does not use post meta. */
export const META_KEYS = Object.freeze({
  yoast: Object.freeze({ title: '_yoast_wpseo_title', description: '_yoast_wpseo_metadesc' }),
  rankmath: Object.freeze({ title: 'rank_math_title', description: 'rank_math_description' }),
  seopress: Object.freeze({ title: '_seopress_titles_title', description: '_seopress_titles_desc' }),
});

/** Plugins whose meta keys are observed rather than documented. */
export const UNVERIFIED_META_PLUGINS = Object.freeze(['seopress']);

/** The alt-text meta key WordPress core uses on an attachment. */
export const ALT_META_KEY = '_wp_attachment_image_alt';

/** Site options this adapter knows how to change, with the finding ids that ask for them. */
export const OPTION_FIXES = Object.freeze({
  'M2.wordpress.blog_public_off': Object.freeze({
    option: 'blog_public', value: '1', restore: '0', unverified: false,
    why: 'blog_public = 0 makes WordPress emit a site-wide noindex and a Disallow: / robots.txt',
  }),
  'M2.wordpress.attachment_pages_indexable': Object.freeze({
    option: 'wp_attachment_pages_enabled', value: '0', restore: '1', unverified: true,
    why: 'attachment pages are thin duplicates of the media they wrap',
  }),
});

// ---------------------------------------------------------------------------
// Transport

/**
 * How `wp` is reached: an --ssh target (or WP_SSH) wraps every command in ssh, otherwise wp runs
 * locally against --path.
 * @returns {{transport: 'local'|'ssh'|'wp-ssh', ssh: string|null, path: string|null, host: string|null}}
 */
export function transportFor(ctx = {}, options = {}) {
  const env = ctx.env || process.env;
  const ssh = options.ssh || ctx.ssh || resolveKey('WP_SSH', env) || null;
  const parsed = ssh ? parseSshTarget(ssh) : null;
  const path = options.path || ctx.wpPath || (parsed && parsed.path) || null;
  const transport = options.transport || (ssh ? 'ssh' : 'local');
  return { transport, ssh: ssh || null, path, host: parsed ? parsed.target : null };
}

/** Build one `wp` invocation for the current transport. */
export function wpCommand(args, ctx = {}, options = {}, extra = {}) {
  const t = transportFor(ctx, options);
  return buildWpCli({
    args,
    ssh: t.ssh,
    path: t.path,
    transport: t.transport,
    format: extra.format || null,
    url: extra.url || options.url || null,
    extra: extra.extra || [],
  });
}

/** Default executor: execFile, no shell, output captured. Injectable as `ctx.execImpl`. */
export function defaultExec(argv, opts = {}) {
  return new Promise((done) => {
    execFile(argv[0], argv.slice(1), {
      encoding: 'utf8',
      timeout: Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 120000,
      env: opts.env || process.env,
      maxBuffer: 8 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      done({
        code: err && Number.isInteger(err.code) ? err.code : (err ? 1 : 0),
        stdout: String(stdout == null ? '' : stdout),
        stderr: String(stderr == null ? '' : stderr),
        error: err ? String(err.message) : null,
      });
    });
  });
}

/**
 * Run one built command. Real execution needs either an injected `execImpl` (tests) or a run that
 * is not marked offline — `CLAUDE_SEO_AI_OFFLINE=1` refuses rather than reaching a remote host.
 */
export async function runCommand(built, ctx = {}, opts = {}) {
  const env = ctx.env || process.env;
  const exec = ctx.execImpl || null;
  if (!exec && env.CLAUDE_SEO_AI_OFFLINE) {
    return { code: 1, stdout: '', stderr: '', error: 'refusing to run "' + built.command + '": CLAUDE_SEO_AI_OFFLINE=1' };
  }
  const runner = exec || defaultExec;
  try { return await runner(built.argv, { env, timeoutMs: opts.timeoutMs, command: built.command }); }
  catch (e) { return { code: 1, stdout: '', stderr: '', error: String((e && e.message) || e) }; }
}

/** `wp … --format=json` output, or null when the command failed or printed something else. */
export function parseJsonOutput(result) {
  if (!result || result.code !== 0) return null;
  const text = String(result.stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

// ---------------------------------------------------------------------------
// Adapter ops

/** capabilities: `wp core version --format=json` through the chosen transport. */
export async function capabilities(ctx = {}, options = {}) {
  const env = ctx.env || process.env;
  const t = transportFor(ctx, options);
  // Probe the filesystem instead of asserting: an injected exec stands in for the real binaries, but
  // with no injection a `true` this adapter did not verify would be a fabricated capability claim.
  const injected = !!ctx.execImpl;
  const wpLocal = injected || !!whichOnPath('wp', env);
  const sshBinary = injected || !!whichOnPath('ssh', env);
  const out = {
    adapter: ADAPTER,
    ready: false,
    needs: [],
    // over ssh the remote host runs `wp`, so the local probe can only speak for the ssh client
    tools: t.transport === 'local' ? { wp: wpLocal } : { ssh: sshBinary },
    transport: t.transport,
    host: t.host,
    path: t.path,
    command: null,
    writes: 'live WordPress post meta, post fields and site options through WP-CLI',
    notes: [],
  };
  // Building the command needs a transport target, so this check comes before it: without one
  // `buildWpCli` throws, and capabilities has to answer "here is what is missing" instead.
  if (t.transport !== 'local' && !t.ssh) {
    out.needs.push('WP_SSH');
    out.notes.push(...explainKeys(['WP_SSH'], { env }).lines);
    return out;
  }
  const built = wpCommand(['core', 'version'], ctx, options, { format: 'json' });
  out.command = redact(built.command, { env });
  if (t.transport !== 'local' && !sshBinary) {
    out.needs.push('ssh on PATH');
    out.notes.push('no `ssh` on PATH: this adapter shells out to the ssh client for the remote transport');
    return out;
  }
  if (t.transport === 'local' && !wpLocal) {
    out.needs.push('wp-cli on PATH');
    out.notes.push('no `wp` on PATH: install WP-CLI, or point --ssh at the host that has it');
    return out;
  }
  if (t.transport === 'local' && !t.path) {
    out.notes.push('no --path given: wp will run against the current working directory');
  }
  const res = await runCommand(built, ctx);
  if (res.code !== 0) {
    out.needs.push(t.transport === 'local' ? 'a working `wp` on PATH' : 'a working `wp` on ' + (t.host || 'the remote host'));
    out.notes.push('`wp core version` failed: ' + redact(String(res.error || res.stderr || 'exit ' + res.code).trim().split('\n')[0], { env }));
    return out;
  }
  out.version = String(parseJsonOutput(res) || res.stdout).trim();
  out.ready = true;
  return out;
}

/**
 * plan: build the commands, capture `before` with read-only `wp … get` calls.
 * @param {object} options { report, profile, answers, category, includeProposed, plugin, ssh, path, transport, url }
 * @param {object} ctx     { run, dataDir, env, execImpl }
 */
export async function plan(options = {}, ctx = {}) {
  const env = ctx.env || process.env;
  const report = options.report && typeof options.report === 'object' ? options.report
    : (options.report ? readJson(options.report, null) : null);
  const findings = Array.isArray(options.findings) ? options.findings : (report && Array.isArray(report.findings) ? report.findings : []);
  const profile = options.profile && typeof options.profile === 'object' ? options.profile
    : (options.profile ? readJson(options.profile, null) : (report && report.platform) || null);

  const t = transportFor(ctx, options);
  const notes = [];
  const skipped = [];
  const changes = [];
  if (t.transport !== 'local' && !t.ssh) {
    return { adapter: ADAPTER, ready: false, changes, skipped, notes: ['no WP-CLI transport: pass --ssh user@host:/path (or set WP_SSH), or run with --transport local --path <wordpress root>'] };
  }

  const answers = normalizeAnswers(options.answers);
  const plugin = pluginFor(options.plugin, profile);
  if (plugin) notes.push('SEO plugin: ' + plugin);
  else notes.push('no SEO plugin detected: only excerpt, image alt and site options are planned');

  // 1. Site options (no page, no value in the report — the fix *is* the option).
  for (const finding of Array.isArray(findings) ? findings : []) {
    if (!finding || (finding.status !== 'fail' && finding.status !== 'warn')) continue;
    const fix = OPTION_FIXES[finding.id];
    if (!fix) continue;
    const built = await buildOptionChange({ finding, fix, ctx, options });
    if (built.errors && built.errors.length) skipped.push({ finding: finding.id, reason: 'invalid change: ' + built.errors.join('; ') });
    else changes.push(built.change);
  }

  // 2. Per-page field writes.
  const grouped = groupByPage(findings, {
    report, answers: answers.values, category: options.category,
    includeProposed: options.includeProposed !== false,
  });
  skipped.push(...grouped.skipped);
  notes.push(...grouped.notes);

  for (const page of grouped.pages) {
    const resource = await resolvePostId(page, ctx, options, answers.resources);
    if (resource.error) { skipped.push({ finding: page.finding_ids.join(', '), reason: resource.error }); continue; }
    for (const [field, entry] of Object.entries(page.fields)) {
      const route = routeForField({ plugin, field, id: resource.id });
      if (route.error) { skipped.push({ finding: entry.finding, reason: route.error }); continue; }
      const built = await buildFieldChange({ page, field, entry, resource, route, plugin, ctx, options });
      if (built.errors && built.errors.length) skipped.push({ finding: entry.finding, reason: 'invalid change: ' + built.errors.join('; ') });
      else changes.push(built.change);
    }
  }

  if (!changes.length && !skipped.length) notes.push('no WP-CLI-writable findings in this report');
  return { adapter: ADAPTER, ready: true, transport: t.transport, host: t.host, changes, skipped, notes };
}

function pluginFor(override, profile) {
  const known = Object.keys(META_KEYS);
  if (override && known.includes(String(override))) return String(override);
  if (override && String(override) === 'aioseo') return 'aioseo';
  const ids = (profile && Array.isArray(profile.cms_plugins) ? profile.cms_plugins : []).map((p) => (p && p.id ? String(p.id) : null));
  for (const id of ids) if (known.includes(id) || id === 'aioseo') return id;
  return null;
}

/** Which WP-CLI write a field maps to. */
export function routeForField({ plugin, field, id }) {
  if (field === 'alt') return { kind: 'post-meta', key: ALT_META_KEY, args: (value) => ['post', 'meta', 'update', String(id), ALT_META_KEY, value] };
  if (field === 'excerpt') return { kind: 'post-field', key: 'post_excerpt', args: (value) => ['post', 'update', String(id), '--post_excerpt=' + value] };
  if (field !== 'title' && field !== 'description') {
    return { error: 'WP-CLI has no single command for "' + field + '" — that one is a plugin UI or theme edit (instructions adapter)' };
  }
  if (plugin === 'aioseo') {
    return { error: 'AIOSEO stores SEO fields in its own database table, not post meta: use the wordpress-rest adapter (aioseo_meta_data), not a fabricated wp post meta command' };
  }
  const keys = plugin ? META_KEYS[plugin] : null;
  if (!keys) return { error: 'no SEO plugin detected, so there is no meta key to write a ' + field + ' into (WordPress core has none)' };
  const key = keys[field];
  return { kind: 'post-meta', key, args: (value) => ['post', 'meta', 'update', String(id), key, value] };
}

/** The post id behind a page: an answer, the snapshot's REST link, or `wp post list --name=<slug>`. */
export async function resolvePostId(page, ctx = {}, options = {}, resources = {}) {
  const answer = resources[page.path];
  if (answer && Number.isFinite(Number(answer.id))) return { id: Number(answer.id), source: 'answers' };
  const slug = page.slug || slugOf(page.url);
  if (!slug) return { error: 'no slug in ' + page.url + ' to look the post up by' };
  const built = wpCommand(['post', 'list', '--name=' + slug, '--field=ID'], ctx, options, { format: 'json' });
  const res = await runCommand(built, ctx);
  const parsed = parseJsonOutput(res);
  const ids = Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  if (ids.length === 1) return { id: ids[0], source: 'wp post list', command: built.command };
  if (ids.length > 1) return { error: 'slug "' + slug + '" matches ' + ids.length + ' posts — name the id in --answers' };
  return { error: 'could not resolve a post id for ' + page.url + ' (tried `' + built.command + '`)' };
}

async function buildOptionChange({ finding, fix, ctx, options }) {
  const env = ctx.env || process.env;
  const run = ctx.run;
  const read = wpCommand(['option', 'get', fix.option], ctx, options, { format: 'json' });
  const res = await runCommand(read, ctx);
  const current = res.code === 0 ? String(parseJsonOutput(res) == null ? '' : parseJsonOutput(res)).trim() : undefined;
  const write = wpCommand(['option', 'update', fix.option, fix.value], ctx, options);
  const flush = wpCommand(['cache', 'flush'], ctx, options);

  const notes = [
    'why: ' + fix.why,
    'this is a LIVE change to a site option.',
    fix.unverified ? 'UNVERIFIED: the option name "' + fix.option + '" is observed, not documented — confirm it in wp-admin before applying, and expect `wp option update` to create it if it does not exist.' : null,
    'after the write: ' + flush.command,
  ].filter(Boolean);
  const body = renderCommandPreview({
    command: write.command,
    before: current === undefined ? null : { [fix.option]: current },
    notes: [...notes, 'read back with: ' + read.command],
    env,
  });

  const locator = 'option:' + fix.option;
  const id = changeId({
    adapter: ADAPTER, op: 'update-fields', target: { kind: 'option', locator },
    finding_ids: [finding.id], strategy: 'wp-option', payload: { option: fix.option, value: fix.value },
  });
  return makeChange({
    id,
    finding_ids: [finding.id],
    adapter: ADAPTER,
    class: 'proposed',
    target: { kind: 'option', locator, url: (finding.location && finding.location.url) || undefined },
    op: 'update-fields',
    strategy: 'wp-option',
    payload: {
      option: fix.option, value: fix.value,
      argv: write.argv, command: write.command, transport: write.transport, writes: true,
      read_argv: read.argv, read_command: read.command,
      flush_argv: flush.argv, flush_command: flush.command,
      unverified: fix.unverified ? ['option name ' + fix.option] : [],
    },
    preview: { kind: 'command', body },
    before: { option: fix.option, value: current === undefined ? null : current, known: current !== undefined, source: read.command },
    requires: { credentials: transportFor(ctx, options).ssh ? ['WP_SSH'] : [], tools: transportFor(ctx, options).transport === 'local' ? ['wp'] : ['wp', 'ssh'] },
    live_impact: 'live',
    verify: {
      method: 'dom_assert',
      command: reproduceCommand('adapters/wordpress-wpcli.mjs', ['verify', '--run', run ? run.dir : '<run>', '--change', id]),
      assertion: '`' + read.command + '` reports ' + fix.option + ' = ' + fix.value,
      url: (finding.location && finding.location.url) || undefined,
    },
    rollback: current === undefined
      ? { kind: 'none' }
      : { kind: 'restore-fields', data: { argv: wpCommand(['option', 'update', fix.option, current || fix.restore], ctx, options).argv, value: current } },
    status: 'planned',
  }, { mode: 'return', phase: 'preview' });
}

async function buildFieldChange({ page, field, entry, resource, route, plugin, ctx, options }) {
  const env = ctx.env || process.env;
  const run = ctx.run;
  const id = String(resource.id);
  const read = route.kind === 'post-meta'
    ? wpCommand(['post', 'meta', 'get', id, route.key], ctx, options, { format: 'json' })
    : wpCommand(['post', 'get', id, '--field=' + route.key], ctx, options, { format: 'json' });
  const res = await runCommand(read, ctx);
  const parsed = parseJsonOutput(res);
  const current = res.code === 0 ? (parsed == null ? '' : String(parsed)) : undefined;

  const write = wpCommand(route.args(entry.value), ctx, options);
  const flush = wpCommand(['cache', 'flush'], ctx, options);
  const unverified = route.kind === 'post-meta' && UNVERIFIED_META_PLUGINS.includes(plugin)
    ? ['the ' + plugin + ' meta key ' + route.key]
    : [];
  const notes = [
    'writes ' + (route.kind === 'post-meta' ? 'post meta ' + route.key : 'the post field ' + route.key) + ' on post ' + id,
    'this is a LIVE change: WP-CLI has no staging surface.',
    unverified.length ? 'UNVERIFIED: ' + unverified.join(', ') + ' — confirm it against the plugin before applying.' : null,
    'after the write: ' + flush.command,
    'read back with: ' + read.command,
  ].filter(Boolean);
  const body = renderCommandPreview({
    command: write.command,
    before: current === undefined ? null : { [route.key]: current },
    notes,
    env,
  });

  const locator = 'post:' + id + ':' + route.key;
  const changeIdValue = changeId({
    adapter: ADAPTER, op: 'update-fields', target: { kind: 'resource', locator, url: page.url },
    finding_ids: [entry.finding], strategy: route.kind === 'post-meta' ? 'wp-post-meta' : 'wp-post-field',
    payload: { key: route.key, value: entry.value },
  });
  const t = transportFor(ctx, options);
  return makeChange({
    id: changeIdValue,
    finding_ids: [entry.finding],
    adapter: ADAPTER,
    class: 'proposed',
    target: { kind: 'resource', locator, url: page.url },
    op: 'update-fields',
    strategy: route.kind === 'post-meta' ? 'wp-post-meta' : 'wp-post-field',
    payload: {
      post: Number(id), field, key: route.key, value: entry.value, plugin: plugin || null,
      argv: write.argv, command: write.command, transport: write.transport, writes: true,
      read_argv: read.argv, read_command: read.command,
      flush_argv: flush.argv, flush_command: flush.command,
      unverified,
    },
    preview: { kind: 'command', body },
    before: { key: route.key, value: current === undefined ? null : current, known: current !== undefined, source: read.command },
    requires: { credentials: t.ssh ? ['WP_SSH'] : [], tools: t.transport === 'local' ? ['wp'] : ['wp', 'ssh'] },
    live_impact: 'live',
    verify: {
      method: 'dom_assert',
      command: reproduceCommand('adapters/wordpress-wpcli.mjs', ['verify', '--run', run ? run.dir : '<run>', '--change', changeIdValue]),
      assertion: '`' + read.command + '` returns the value that was written, and the public page serves it',
      url: page.url,
    },
    rollback: current === undefined
      ? { kind: 'none' }
      : {
        kind: 'restore-fields',
        data: {
          value: current,
          argv: current === '' && route.kind === 'post-meta'
            ? wpCommand(['post', 'meta', 'delete', id, route.key], ctx, options).argv
            : wpCommand(route.args(current), ctx, options).argv,
        },
      },
    status: 'planned',
  }, { mode: 'return', phase: 'preview' });
}

/** preview: the command, its `before` and the caveats — written to the run's preview/ directory. */
export async function preview(change, ctx = {}) {
  const body = (change.preview && change.preview.body) || '';
  if (ctx.run) writeText(ctx.run.previewPath(change.id, '.sh.txt'), body);
  return { change: canTransition(change.status, 'previewed') ? transition(change, 'previewed') : change, ok: true, body };
}

/** apply: run the write, then flush the cache. The ticket was checked by the caller. */
export async function apply(change, ctx = {}) {
  const env = ctx.env || process.env;
  const payload = change.payload || {};
  if (!Array.isArray(payload.argv) || !payload.argv.length) {
    return { change: transition(change, 'failed', { error: 'the change carries no command to run' }), ok: false };
  }
  if (!isWpWrite(wpArgsOf(payload.argv))) {
    return { change: transition(change, 'failed', { error: 'refusing to run a command that is not a recognised WP-CLI write: ' + payload.command }), ok: false };
  }
  let confirmed;
  try { confirmed = ensureConfirmed(change); }
  catch (e) { return { change, ok: false, error: String((e && e.message) || e) }; }

  const res = await runCommand({ argv: payload.argv, command: payload.command }, ctx);
  if (res.code !== 0) {
    const detail = String(res.error || res.stderr || 'exit ' + res.code).trim().split('\n')[0];
    return { change: transition(confirmed, 'failed', { error: redact(detail, { env }) }), ok: false, stderr: redact(String(res.stderr || ''), { env }) };
  }
  let flush = null;
  if (Array.isArray(payload.flush_argv) && payload.flush_argv.length) {
    flush = await runCommand({ argv: payload.flush_argv, command: payload.flush_command }, ctx);
  }
  if (ctx.run) {
    writeJson(ctx.run.afterPath(confirmed.id), {
      change: confirmed.id, command: redact(payload.command, { env }), exit_code: res.code,
      stdout: redact(String(res.stdout || '').slice(0, 4000), { env }),
      cache_flushed: flush ? flush.code === 0 : null,
      applied_at: new Date().toISOString(),
    });
    ctx.run.log({ event: 'apply', adapter: ADAPTER, change: confirmed.id, command: payload.command, exit_code: res.code });
  }
  return {
    change: transition(confirmed, 'applied'), ok: true,
    stdout: redact(String(res.stdout || '').trim(), { env }),
    cache_flushed: flush ? flush.code === 0 : null,
  };
}

function wpArgsOf(argv) {
  const list = Array.isArray(argv) ? argv.map(String) : [];
  const at = list.indexOf('wp');
  if (at !== -1) return list.slice(at + 1);
  // ssh transport: the remote command is the last argv element ("cd '…' && wp post meta update …")
  const last = list[list.length - 1] || '';
  const m = /\bwp\s+(.*)$/.exec(last);
  return m ? m[1].split(/\s+/) : list;
}

/** verify: re-run the read command, then look at the public page with a cache-buster. */
export async function verify(change, ctx = {}) {
  const env = ctx.env || process.env;
  const payload = change.payload || {};
  const checks = [];
  const wanted = String(payload.value == null ? '' : payload.value);

  if (!Array.isArray(payload.read_argv) || !payload.read_argv.length) {
    checks.push({ name: 'wp-cli', ok: null, detail: 'this change has no read-back command' });
  } else {
    const res = await runCommand({ argv: payload.read_argv, command: payload.read_command }, ctx);
    if (res.code !== 0) {
      checks.push({ name: 'wp-cli', ok: null, detail: 'read-back failed: ' + redact(String(res.error || res.stderr || 'exit ' + res.code).trim().split('\n')[0], { env }) });
    } else {
      const parsed = parseJsonOutput(res);
      const observed = parsed == null ? String(res.stdout || '').trim() : String(parsed);
      const ok = observed.trim() === wanted.trim();
      checks.push({ name: 'wp-cli', ok, detail: ok ? 'the value is stored' : 'still reads ' + JSON.stringify(observed) });
    }
  }

  const url = publicUrlFor(change, ctx);
  let publicCheck = null;
  if (url && wanted && payload.field) {
    publicCheck = await checkPublicUrl(url, [wanted], ctx);
    checks.push({
      name: 'public', ok: publicCheck.ok,
      detail: publicCheck.error ? 'could not fetch ' + publicCheck.url + ': ' + publicCheck.error
        : (publicCheck.ok ? 'the public page serves the new value' : 'the public page still serves the old value'),
    });
  }

  const cli = checks.find((c) => c.name === 'wp-cli');
  if (cli && cli.ok === false) {
    return { change: canTransition(change.status, 'failed') ? transition(change, 'failed', { error: cli.detail }) : change, ok: false, checks };
  }
  if (publicCheck && publicCheck.ok === false) {
    const next = canTransition(change.status, 'pending_cache') ? transition(change, 'pending_cache') : change;
    return {
      change: next, ok: null, checks,
      note: 'stored, but the public page is still cached: run `wp cache flush`, purge the caching plugin, then purge the CDN and re-verify.',
    };
  }
  if (!cli || cli.ok !== true) return { change, ok: null, checks, note: 'not verifiable from here — treat this as unconfirmed' };
  if (!canTransition(change.status, 'verified')) return { change, ok: true, checks, note: 'checks passed; status left at "' + change.status + '"' };
  return { change: transition(change, 'verified'), ok: true, checks };
}

/** rollback: re-apply the value the read captured before the write (or delete the meta it created). */
export async function rollback(change, ctx = {}) {
  const env = ctx.env || process.env;
  const data = (change.rollback && change.rollback.data) || null;
  if (!data || !Array.isArray(data.argv) || !data.argv.length) {
    return { change, ok: false, reason: 'no-before', note: 'the value before the write was never read, so there is nothing to restore' };
  }
  const res = await runCommand({ argv: data.argv, command: data.command || data.argv.join(' ') }, ctx);
  if (res.code !== 0) {
    return { change, ok: false, error: redact(String(res.error || res.stderr || 'exit ' + res.code).trim().split('\n')[0], { env }) };
  }
  if (ctx.run) ctx.run.log({ event: 'rollback', adapter: ADAPTER, change: change.id, exit_code: res.code });
  return { change: canTransition(change.status, 'rolled_back') ? transition(change, 'rolled_back') : change, ok: true };
}

// ---------------------------------------------------------------------------
// CLI

function optionsFromArgs(args) {
  return {
    ssh: args.ssh && args.ssh !== true ? String(args.ssh) : null,
    path: args.path && args.path !== true ? String(args.path) : null,
    transport: args.transport && args.transport !== true ? String(args.transport) : null,
    url: args.url && args.url !== true ? String(args.url) : null,
    plugin: args.plugin && args.plugin !== true ? String(args.plugin) : null,
  };
}

function loadRun(args, dataDir) {
  if (args.run && args.run !== true) return loadFixRun(String(args.run), { dataDir });
  return null;
}

function pickChanges(run, args) {
  const planFile = run ? run.readPlan() : null;
  const all = planFile && Array.isArray(planFile.changes) ? planFile.changes : [];
  const mine = all.filter((c) => c.adapter === ADAPTER);
  if (args.change && args.change !== true) {
    const wanted = new Set((Array.isArray(args.change) ? args.change : [args.change]).map(String));
    return mine.filter((c) => wanted.has(c.id));
  }
  return mine;
}

function persist(run, updated) {
  if (!run || !updated.length) return;
  const planFile = run.readPlan();
  if (!planFile || !Array.isArray(planFile.changes)) return;
  const byId = new Map(updated.map((c) => [c.id, c]));
  run.setChanges(planFile.changes.map((c) => (byId.has(c.id) ? byId.get(c.id) : c)));
}

export async function main(args = {}) {
  const op = String((args._ && args._[0]) || '').trim();
  if (!OPS.includes(op)) {
    return { result: { error: 'usage: wordpress-wpcli <' + OPS.join('|') + '> --run <dir> [--change <id>] [--ticket <t>] [--ssh user@host:/path]' }, code: EXIT.USAGE };
  }
  const dataDir = resolveDataDir(args);
  const options = optionsFromArgs(args);
  const ctx = {
    dataDir, env: process.env, now: () => new Date(),
    devUrl: args['dev-url'] && args['dev-url'] !== true ? String(args['dev-url']) : null,
  };

  if (op === 'capabilities') return { result: await capabilities(ctx, options), code: EXIT.OK };

  if (op === 'plan') {
    if (!args.report || args.report === true) return { result: { error: 'plan needs --report <report.json>' }, code: EXIT.USAGE };
    const report = readJson(String(args.report), null);
    if (!report) return { result: { error: 'cannot read report: ' + args.report }, code: EXIT.USAGE };
    const run = loadRun(args, dataDir) || openFixRun(dataDir, {
      report: String(args.report), profile: args.profile && args.profile !== true ? String(args.profile) : null,
      target: report.target || null, adapters: [ADAPTER],
    });
    ctx.run = run;
    const out = await plan({
      ...options,
      report, profile: args.profile && args.profile !== true ? String(args.profile) : null,
      category: args.category === true ? null : args.category,
      includeProposed: args['include-proposed'] === true,
      answers: args.answers,
    }, ctx);
    if (out.changes.length) {
      const planFile = run.readPlan() || { changes: [] };
      const others = (planFile.changes || []).filter((c) => c.adapter !== ADAPTER);
      run.setChanges([...others, ...out.changes]);
      for (const c of out.changes) if (c.preview && c.preview.body) writeText(run.previewPath(c.id, '.sh.txt'), c.preview.body);
    }
    run.log({ event: 'plan', adapter: ADAPTER, changes: out.changes.length, skipped: out.skipped.length });
    return { result: { ...out, run: run.id, run_dir: run.dir }, code: out.ready ? EXIT.OK : EXIT.USAGE };
  }

  const run = loadRun(args, dataDir);
  if (!run) return { result: { error: op + ' needs --run <fix-run-dir>' }, code: EXIT.USAGE };
  ctx.run = run;
  const changes = pickChanges(run, args);
  if (!changes.length) return { result: { error: 'no ' + ADAPTER + ' changes in ' + run.dir + (args.change ? ' matching --change ' + args.change : '') }, code: EXIT.USAGE };

  const results = [];
  const updated = [];
  for (const change of changes) {
    if (op === 'apply') {
      const gate = requireTicket(dataDir, { ticket: args.ticket, run: run.id, change: change.id });
      if (!gate.ok) {
        results.push({ change: change.id, ok: false, refused: gate.reason, error: op + ' needs a valid confirmation ticket (' + gate.reason + ')' });
        continue;
      }
    }
    const fn = { preview, apply, verify, rollback }[op];
    let out;
    try { out = await fn(change, ctx); }
    catch (e) { out = opThrew(change, e); }
    if (out.change) updated.push(out.change);
    results.push(redactObject({
      change: change.id, status: out.change ? out.change.status : change.status, ok: out.ok,
      ...(out.error ? { error: out.error } : {}),
      ...(out.checks ? { checks: out.checks } : {}),
      ...(out.reason ? { reason: out.reason } : {}),
      ...(out.note ? { note: out.note } : {}),
      ...(out.stdout ? { stdout: out.stdout } : {}),
    }, { env: process.env }));
  }
  persist(run, updated);
  logOpEvent(run, { op, adapter: ADAPTER, results });
  updateManifest(run, { op, adapter: ADAPTER, changes: updated });
  const failed = results.some((r) => r.ok === false);
  return { result: { adapter: ADAPTER, op, run: run.id, run_dir: run.dir, results }, code: failed ? EXIT.RUNTIME : EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);

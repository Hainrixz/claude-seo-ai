#!/usr/bin/env node
// shopify-theme adapter — edits a Shopify Liquid theme through the Shopify CLI.
//
//   node scripts/adapters/shopify-theme.mjs <op> --run <fix-run-dir> [--change <id>] [--ticket <t>]
//                                           [--store <s>] [--project <dir>] [--refresh] [--all] [--json]
//   ops: capabilities | plan | preview | apply | verify | rollback | publish
//
// NOTHING EVER GOES LIVE HERE
// Every write lands on an *unpublished* theme. The first `apply` of a run pushes the edited working
// copy to a new theme named "claude-seo-ai <date>"; later applies push to that same theme id with
// --nodelete, so a store burns one of its 20 theme slots per run at most. `--allow-live`, `--live`,
// `--publish` and their short forms are rejected before any argv reaches the CLI (assertNoLiveFlags),
// and swapping the live theme is a separate `publish` op with its own confirmation ticket.
//
// WHERE THE FILES LIVE
//   <DATA>/work/shopify/<store>/<live_theme_id>/        the pulled working copy this run edits
//   <DATA>/backups/shopify/<store>/<theme_id>/<ts>/     a full copy taken right after the pull
// The pull happens once per run (`--refresh` forces a new one) and the backup is what `rollback`
// restores from. Nothing is ever written into the user's own project directory.
//
// CREDENTIALS
// SHOPIFY_STORE and SHOPIFY_THEME_TOKEN are read from the environment and handed to the child
// process as SHOPIFY_FLAG_STORE / SHOPIFY_CLI_THEME_TOKEN. They never appear in argv, in a preview,
// or in the run log — `theme push --password …` would put a token in `ps` and in every log line
// this tool prints.

import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { EXIT, isMain, runCli } from '../lib/util.mjs';
import {
  ensureConfirmed, loadFixRun, makeChange, openFixRun, requireTicket, resolveDataDir, transition,
  updateManifest,
} from '../lib/adapter.mjs';
import {
  DEFAULT_MARKER, findHeadAnchor, markerBlock, markerComment, replaceBetween, unifiedDiff, upsertMarkerBlock,
} from '../lib/diff.mjs';
import { buildShopifyTheme, joinCommand, touchesLiveTheme } from '../lib/shell.mjs';
import { missingKeys, presence, redact, resolveKey } from '../lib/credentials.mjs';
import { readJson, writeJson, writeText } from '../lib/store.mjs';
import { parseRobots, isAllowed } from '../lib/robots.mjs';
import { reproduceCommand } from '../lib/finding.mjs';
import { fixableFindings, normalizeAnswers, parseFixPreview } from './local-files.mjs';
import { logOpEvent, opThrew, whichOnPath, withheldProposedNote } from './_shared.mjs';
import { snapshotUrl } from '../snapshot.mjs';

// re-exported so callers and tests keep one import site for the PATH probe
export { whichOnPath };

export const ADAPTER = 'shopify-theme';
const OPS = ['capabilities', 'plan', 'preview', 'apply', 'verify', 'rollback', 'publish'];

/** Comment marker every block this adapter writes carries: {% comment %}claude-seo-ai:<block>{% endcomment %}. */
export const MARKER = DEFAULT_MARKER;
/** Staging themes are named "<prefix> <YYYY-MM-DD>" so a store owner can see who made them. */
export const STAGING_PREFIX = DEFAULT_MARKER;
/**
 * Shopify documents 20 themes per store. It is a *store* limit, not something this adapter can read,
 * so capabilities reports the count it observed against this number and says the number is assumed.
 */
export const THEME_LIMIT_DOCUMENTED = 20;
export const THEME_CHECK_FAIL_LEVEL = 'error';
export const CREDENTIAL_KEYS = Object.freeze(['SHOPIFY_STORE', 'SHOPIFY_THEME_TOKEN']);
const PULL_STAMP = '.claude-seo-ai-pull.json';
const DEFAULT_EXEC_TIMEOUT_MS = 300000;

// ---------------------------------------------------------------------------
// Store, URLs, argv

/** `my-store`, `my-store.myshopify.com`, `https://my-store.myshopify.com/x` → `my-store.myshopify.com`. */
export function normalizeStore(value) {
  let s = String(value == null ? '' : value).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  if (!s) return null;
  if (!s.includes('.')) s = s + '.myshopify.com';
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(s) ? s : null;
}

/** Filesystem-safe form of a store domain (used as one path segment under <DATA>/work). */
export function storeSlug(store) {
  return String(store || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'store';
}

/** `<DATA>/work/shopify/<store>/<theme id>` — the pulled working copy. */
export function workDirFor(dataDir, store, themeId) {
  return join(resolve(dataDir), 'work', 'shopify', storeSlug(store), String(themeId || 'live').replace(/[^0-9A-Za-z_-]+/g, '-'));
}

/** `<DATA>/backups/shopify/<store>/<theme id>/<timestamp>` — the full pre-edit copy. */
export function themeBackupDir(dataDir, store, themeId, stamp) {
  return join(resolve(dataDir), 'backups', 'shopify', storeSlug(store), String(themeId || 'live').replace(/[^0-9A-Za-z_-]+/g, '-'), String(stamp));
}

const stampFor = (date) => (date instanceof Date ? date : new Date(date)).toISOString().replace(/[:.]/g, '-');

/** Storefront preview URL for an unpublished theme: `https://<store><path>?preview_theme_id=<id>`. */
export function previewUrl(store, themeId, path = '/') {
  const host = normalizeStore(store);
  if (!host || !themeId) return null;
  let rel = '/';
  const raw = String(path == null ? '/' : path);
  try { const u = new URL(raw, 'https://' + host); rel = u.pathname + u.search; } catch { rel = '/'; }
  const out = new URL(rel, 'https://' + host);
  out.searchParams.set('preview_theme_id', String(themeId));
  return out.href;
}

/** Theme-editor URL in the Shopify admin. */
export function editorUrl(store, themeId) {
  const host = normalizeStore(store);
  return host && themeId ? 'https://' + host + '/admin/themes/' + String(themeId) + '/editor' : null;
}

/**
 * Subcommands that only read the store. `theme pull --live` downloads the published theme into the
 * working copy: `--live` there names what to read, and nothing on the store changes.
 */
export const READ_SUBCOMMANDS = Object.freeze(['pull', 'list', 'check', 'info', 'version']);

/**
 * Throw before anything runs if an argv would write to the live theme.
 * `--allow-live` is refused everywhere (it exists only to let a push overwrite the published theme);
 * the other live flags are refused on every subcommand that is not a plain read.
 */
export function assertNoLiveFlags(argv) {
  const list = (Array.isArray(argv) ? argv : String(argv || '').split(/\s+/)).map(String);
  const sub = list[0] === 'shopify' ? (list[1] === 'theme' ? list[2] : list[1]) : list[0];
  if (list.includes('--allow-live')) {
    throw new Error('refusing to run a Shopify command with --allow-live: ' + joinCommand(list));
  }
  if (!READ_SUBCOMMANDS.includes(String(sub)) && touchesLiveTheme(list)) {
    throw new Error('refusing to run a Shopify command that writes to the live theme: ' + joinCommand(list));
  }
  return argv;
}

/** `shopify theme <args…>` argv + printable command, with the live-theme flags refused. */
export function themeArgv(args, { path = null, extra = [] } = {}) {
  const built = buildShopifyTheme({ args, path, extra });
  assertNoLiveFlags(built.argv);
  return built;
}

/**
 * The environment the Shopify CLI child gets. The two credentials go in here and nowhere else.
 * @returns {object} a copy of `env` plus SHOPIFY_FLAG_STORE / SHOPIFY_CLI_THEME_TOKEN
 */
export function childEnv(env = process.env, { store = null } = {}) {
  const out = { ...env };
  const host = normalizeStore(store || resolveKey('SHOPIFY_STORE', env));
  const token = resolveKey('SHOPIFY_THEME_TOKEN', env);
  if (host) out.SHOPIFY_FLAG_STORE = host;
  if (token) out.SHOPIFY_CLI_THEME_TOKEN = token;
  out.SHOPIFY_CLI_NO_ANALYTICS = '1';
  out.NO_COLOR = '1';
  out.CI = '1'; // the CLI must never open an interactive prompt inside a subagent
  return out;
}

function defaultExec(argv, opts = {}) {
  return new Promise((res) => {
    execFile(argv[0], argv.slice(1), {
      env: opts.env, cwd: opts.cwd, timeout: Number(opts.timeoutMs) || DEFAULT_EXEC_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      res({
        code: err ? (Number.isInteger(err.code) ? err.code : 1) : 0,
        stdout: String(stdout == null ? '' : stdout), stderr: String(stderr == null ? '' : stderr),
        error: err ? String(err.message || err) : null,
      });
    });
  });
}

/**
 * Run one `shopify …` argv through the injectable exec, logging a redacted command line.
 * With no injected exec, `CLAUDE_SEO_AI_OFFLINE` refuses rather than spawning: the flag's contract
 * is that nothing reaches the network unless a test hands the adapter its own runner.
 */
async function runArgv(ctx, built, { timeoutMs = DEFAULT_EXEC_TIMEOUT_MS, label = '' } = {}) {
  const exec = ctx.execImpl || null;
  const env = ctx.env || process.env;
  if (!exec && env.CLAUDE_SEO_AI_OFFLINE) {
    const command = redact(built.command, { env });
    const out = {
      argv: built.argv, command, code: 1, stdout: '', stderr: '',
      error: 'refusing to run "' + command + '": CLAUDE_SEO_AI_OFFLINE=1',
    };
    if (ctx.run) ctx.run.log({ event: 'exec', adapter: ADAPTER, label: label || built.argv[2] || 'shopify', command, code: out.code, skipped: 'offline' });
    return out;
  }
  const res = await (exec || defaultExec)(built.argv, { env: childEnv(env, { store: ctx.store }), timeoutMs });
  const out = {
    argv: built.argv,
    command: redact(built.command, { env }),
    code: Number(res && res.code) || 0,
    stdout: String((res && res.stdout) || ''),
    stderr: String((res && res.stderr) || ''),
    error: (res && res.error) || null,
  };
  if (ctx.run) ctx.run.log({ event: 'exec', adapter: ADAPTER, label: label || built.argv[2] || 'shopify', command: out.command, code: out.code });
  return out;
}

/** `shopify theme <args…>` through the injectable exec. */
function runTheme(ctx, args, { path = null, extra = [], timeoutMs = DEFAULT_EXEC_TIMEOUT_MS, label = '' } = {}) {
  return runArgv(ctx, themeArgv(args, { path, extra }), { timeoutMs, label: label || String(args[0] || '') });
}

/** `shopify version` — the CLI's own version command (not a theme subcommand). */
function runShopifyVersion(ctx, { timeoutMs = 30000 } = {}) {
  const argv = assertNoLiveFlags(['shopify', 'version']);
  return runArgv(ctx, { argv, command: joinCommand(argv) }, { timeoutMs, label: 'version' });
}

// ---------------------------------------------------------------------------
// Parsing the CLI's JSON

/** First JSON value in a stream that may carry log lines around it (null when there is none). */
export function extractJson(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* fall through to a scan */ }
  for (const open of ['[', '{']) {
    const start = s.indexOf(open);
    if (start === -1) continue;
    const close = open === '[' ? ']' : '}';
    for (let end = s.lastIndexOf(close); end > start; end = s.lastIndexOf(close, end - 1)) {
      try { return JSON.parse(s.slice(start, end + 1)); } catch { /* try a shorter slice */ }
    }
  }
  return null;
}

/** `theme list --json` → [{id, name, role}] (null when the output was not JSON). */
export function parseThemeList(stdout) {
  const json = typeof stdout === 'string' ? extractJson(stdout) : stdout;
  const rows = Array.isArray(json) ? json : (json && Array.isArray(json.themes) ? json.themes : null);
  if (!rows) return null;
  return rows
    .map((r) => ({
      id: String((r && (r.id ?? r.theme_id ?? r.themeId)) ?? '').trim(),
      name: String((r && r.name) || '').trim(),
      role: String((r && r.role) || '').trim().toLowerCase(),
    }))
    .filter((t) => t.id);
}

/** The live theme in a `theme list` result (Shopify names the role "main"; older output says "live"). */
export function liveThemeOf(themes) {
  return (Array.isArray(themes) ? themes : []).find((t) => t.role === 'main' || t.role === 'live') || null;
}

/** The reusable staging theme this tool creates, if the store already has one. */
export function stagingThemeOf(themes) {
  const mine = (Array.isArray(themes) ? themes : []).filter((t) => t.name.toLowerCase().startsWith(STAGING_PREFIX) && t.role !== 'main' && t.role !== 'live');
  return mine.length ? mine[mine.length - 1] : null;
}

/** "claude-seo-ai 2026-09-06" */
export function stagingThemeName(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  return STAGING_PREFIX + ' ' + d.toISOString().slice(0, 10);
}

/**
 * `theme check -o json --fail-level error` → the offences that must block a push.
 * Unparseable output is not treated as a pass: a non-zero exit still blocks.
 */
export function parseThemeCheck(stdout, code = 0) {
  const json = extractJson(stdout);
  const exitOk = Number(code) === 0;
  if (!Array.isArray(json)) {
    return { parsed: false, ok: exitOk, errors: [], offenses: 0, raw: String(stdout == null ? '' : stdout).slice(0, 4000) };
  }
  const errors = [];
  let offenses = 0;
  for (const file of json) {
    const path = String((file && (file.path ?? file.file)) || '');
    for (const o of Array.isArray(file && file.offenses) ? file.offenses : []) {
      offenses++;
      const sev = o && o.severity;
      const isError = sev === 0 || String(sev).toLowerCase() === 'error';
      if (isError) {
        errors.push({ path, check: String((o && o.check) || ''), message: String((o && o.message) || ''), line: (o && (o.start_line ?? o.line)) ?? null });
      }
    }
  }
  return { parsed: true, ok: errors.length === 0 && exitOk, errors, offenses };
}

const pickKey = (obj, keys) => {
  for (const src of [obj, obj && obj.theme]) {
    if (!src || typeof src !== 'object') continue;
    for (const k of keys) if (typeof src[k] === 'string' && src[k].trim()) return src[k].trim();
  }
  return null;
};

/**
 * `theme push --json` → {theme_id, preview_url, editor_url}.
 *
 * The exact key names of that JSON are not pinned by Shopify's docs, so several spellings are
 * accepted and the URLs fall back to the documented shapes (`?preview_theme_id=` and
 * `/admin/themes/<id>/editor`). `url_source` says which of the two it was; with no theme id at all
 * the result is `ok: false` and the caller fails the change instead of guessing one.
 */
export function parsePushResult(stdout, { store = null } = {}) {
  const json = extractJson(stdout);
  const node = json && typeof json === 'object' ? (json.theme && typeof json.theme === 'object' ? json.theme : json) : null;
  const id = node ? String((node.id ?? node.theme_id ?? node.themeId) ?? '').trim() : '';
  const fromCli = pickKey(json, ['preview_url', 'previewUrl', 'theme_url', 'themeUrl']);
  const editorFromCli = pickKey(json, ['editor_url', 'editorUrl']);
  return {
    ok: !!id,
    theme_id: id || null,
    name: node && typeof node.name === 'string' ? node.name : null,
    preview_url: fromCli || (id ? previewUrl(store, id) : null),
    editor_url: editorFromCli || (id ? editorUrl(store, id) : null),
    url_source: fromCli ? 'cli' : (id && store ? 'derived' : null),
    parsed: json !== null,
    raw: String(stdout == null ? '' : stdout).slice(0, 4000),
  };
}

// ---------------------------------------------------------------------------
// Fix map (references/platforms/shopify.md §5)

/**
 * Which theme file a finding is fixed in, how, and whether the edit is deterministic enough to be
 * `auto`. First match wins, so the platform-specific ids sit above the generic ones.
 * `needs_snippet` marks a block whose text must come from the audit or from the user — this adapter
 * never invents a description, an image URL or a JSON-LD body.
 */
export const THEME_FIX_MAP = Object.freeze([
  { id: /^M2\.shopify\.(collection_path_duplicate|variant_param_canonical)$/, file: 'layout/theme.liquid', block: 'canonical', strategy: 'liquid-head', cls: 'auto', op: 'insert' },
  { id: /^M2\.canonical\.missing$/, file: 'layout/theme.liquid', block: 'canonical', strategy: 'liquid-head', cls: 'auto', op: 'insert' },
  { id: /^M7\.viewport\.missing$/, file: 'layout/theme.liquid', block: 'viewport', strategy: 'liquid-head', cls: 'auto', op: 'insert' },
  { id: /^M20\.lang\.mismatch$/, file: 'layout/theme.liquid', block: 'html-lang', strategy: 'liquid-html-lang', cls: 'auto', op: 'replace' },
  { id: /^M20\.shopify\.duplicate_hreflang$/, file: 'layout/theme.liquid', block: 'hreflang', strategy: 'manual', cls: 'proposed', op: 'remove' },
  { id: /^M8\.(og|twitter)\./, file: 'layout/theme.liquid', block: 'social', strategy: 'liquid-head', cls: 'auto', op: 'insert', needs_snippet: true },
  // robots.txt.liquid. The only edit this module can make to that template is an APPEND: a marked
  // block after everything else, plus the `default_groups` loop put back when the template dropped
  // it. So the class follows what the edit really is (`robots_kind`):
  //   additive        — a directive that only adds (a `Sitemap:` line, an AI-crawler group the user
  //                     supplied). Deterministic and appendable, so it may be `auto`. It still needs
  //                     the exact line from the report or from --answers; none is ever invented.
  //   restore-defaults— putting Shopify's default groups back. Deterministic, but it re-imposes
  //                     every platform Disallow, which changes what is crawlable: `proposed`.
  //   edit-existing   — removing a Disallow, repairing a broken directive, lowering a Crawl-delay.
  //                     An append cannot perform any of those, so these are `manual`/`proposed` and
  //                     the preview says a person makes the edit.
  { id: /^(M1\.sitemap\.missing_directive|M17\.robots\.no_sitemap_line)$/, file: 'templates/robots.txt.liquid', block: 'robots', strategy: 'liquid-robots', cls: 'auto', op: 'insert', robots_kind: 'additive' },
  { id: /^M1\.shopify\.(tag_combo_urls_crawlable|filter_sort_urls_crawlable)$/, file: 'templates/robots.txt.liquid', block: 'robots', strategy: 'liquid-robots', cls: 'proposed', op: 'insert', robots_kind: 'restore-defaults' },
  { id: /^M1\.(robots|sitemap|crawl_delay)\./, file: 'templates/robots.txt.liquid', block: 'robots', strategy: 'manual', cls: 'proposed', op: 'replace', robots_kind: 'edit-existing' },
  { id: /^M17\.robots\./, file: 'templates/robots.txt.liquid', block: 'robots', strategy: 'manual', cls: 'proposed', op: 'replace', robots_kind: 'edit-existing' },
  // Per-resource markup lives in the section that renders the resource, and rewriting the Liquid
  // that builds it is not an exact-anchor edit — those stay manual.
  { id: /^M5\.shopify\.(theme_jsonld_gaps|duplicate_product_jsonld)$/, file: 'sections/main-product.liquid', block: 'product-jsonld', strategy: 'manual', cls: 'proposed', op: 'replace' },
  { id: /^M5\.(product|jsonld|faqpage)\./, file: 'sections/main-product.liquid', block: 'product-jsonld', strategy: 'manual', cls: 'proposed', op: 'replace' },
  { id: /^M5\.article\./, file: 'sections/main-article.liquid', block: 'article-jsonld', strategy: 'manual', cls: 'proposed', op: 'replace' },
  // Site-wide markup (Organization, WebSite, …) is a new, marked snippet the layout renders.
  { id: /^M5\./, file: 'snippets/seo-structured-data.liquid', block: 'structured-data', strategy: 'liquid-snippet', cls: 'auto', op: 'create', needs_snippet: true },
  { id: /^M21\.llmstxt\./, file: 'templates/llms.txt.liquid', block: 'llms', strategy: 'liquid-create', cls: 'auto', op: 'create', needs_snippet: true },
  { id: /^M21\.agents_md\./, file: 'templates/agents.md.liquid', block: 'agents', strategy: 'liquid-create', cls: 'auto', op: 'create', needs_snippet: true },
]);

/**
 * Ids the Shopify card marks platform-owned, unobservable or advisory-only: the theme adapter must
 * never claim them, so they are not routed to a file at all.
 * `M17.shopify.sitemap_platform_owned` is Shopify's own sitemap (§4),
 * `M1.shopify.robots_liquid_drops_defaults` is emitted as `needs_api` (§10), and
 * `M1.robots.unreachable` reports that /robots.txt does not answer — a server or hosting problem
 * that no theme file can repair, and one that would otherwise fall into the robots routing above.
 */
export const NOT_THEME_FIXABLE = Object.freeze([
  'M17.shopify.sitemap_platform_owned',
  'M1.shopify.robots_liquid_drops_defaults',
  'M1.robots.unreachable',
  'M7.wordpress.plugin_owned_head',
]);

/** The fix-map entry for a finding, or null when the theme is not where this one is fixed. */
export function themeTargetFor(finding) {
  const id = String((finding && finding.id) || '');
  if (!id || NOT_THEME_FIXABLE.includes(id)) return null;
  for (const entry of THEME_FIX_MAP) if (entry.id.test(id)) return entry;
  return null;
}

/** Blocks whose body is fixed by the platform's own documented Liquid (nothing about the site is invented). */
const PLATFORM_BLOCKS = Object.freeze({
  canonical: '<link rel="canonical" href="{{ canonical_url }}">',
  viewport: '<meta name="viewport" content="width=device-width, initial-scale=1">',
});

/** The `lang` value the html-lang block writes: Shopify's own request locale. */
export const HTML_LANG_VALUE = '{{ request.locale.iso_code }}';

/**
 * The platform default robots template. Dropping the `default_groups` loop silently discards every
 * rule Shopify ships (tag combinations, sort/filter parameters, /cart, /checkout, /admin …), so a
 * custom template that lacks it is repaired by putting the loop back above whatever is there.
 */
export const DEFAULT_ROBOTS_TEMPLATE = [
  '{% for group in robots.default_groups %}',
  '  {{- group.user_agent }}',
  '  {% for rule in group.rules -%}',
  '    {{ rule }}',
  '  {% endfor -%}',
  '  {%- if group.sitemap != blank -%}',
  '    {{ group.sitemap }}',
  '  {%- endif %}',
  '{% endfor %}',
  '',
].join('\n');

const DEFAULT_GROUPS_RE = /\{%-?\s*for\s+[A-Za-z_][\w]*\s+in\s+robots\.default_groups\s*-?%\}/;

/** True when a robots template still emits Shopify's default groups. */
export function hasDefaultGroupsLoop(text) { return DEFAULT_GROUPS_RE.test(String(text == null ? '' : text)); }

const ROBOTS_LINE_RE = /^\s*(user-agent|allow|disallow|sitemap|crawl-delay)\s*:/i;

/** Robots directive lines inside a snippet the audit (or the user) supplied. */
export function robotsRulesFrom(snippet) {
  return String(snippet == null ? '' : snippet).split(/\r?\n/).map((l) => l.trim()).filter((l) => ROBOTS_LINE_RE.test(l));
}

/** The block marker for a change: `claude-seo-ai:<block>`. */
export const blockMarker = (block) => MARKER + ':' + String(block || 'block');

/** The `{% render %}` tag that pulls the generated snippet into the head. */
export const RENDER_STRUCTURED_DATA = "{% render 'seo-structured-data' %}";

// ---------------------------------------------------------------------------
// Editing a theme file

/** The text between this marker's start/end comments, or null when the block is not there. */
function blockBodyBetween(text, marker) {
  const src = String(text == null ? '' : text);
  const start = markerComment(marker + ':start', 'liquid');
  const end = markerComment(marker + ':end', 'liquid');
  const s = src.indexOf(start);
  if (s === -1) return null;
  const e = src.indexOf(end, s + start.length);
  return e === -1 ? null : src.slice(s + start.length, e);
}

/** Compare block bodies ignoring the indentation an insertion copies from its anchor line. */
const dedent = (s) => String(s == null ? '' : s).split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '').join('\n');

/**
 * True when the file already carries exactly this block. Inserting indents the body to match the
 * anchor line, so a byte comparison would call an unchanged block "updated" on every run.
 */
export function blockIsCurrent(text, marker, body) {
  const existing = blockBodyBetween(text, marker);
  return existing !== null && dedent(existing) === dedent(body);
}

function upsertOrAppend(text, { marker, body }) {
  const src = String(text == null ? '' : text);
  const start = markerComment(marker + ':start', 'liquid');
  const end = markerComment(marker + ':end', 'liquid');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  if (blockIsCurrent(src, marker, body)) return { ok: true, text: src, changed: false, reason: 'block-unchanged' };
  if (src.includes(start) && src.includes(end)) {
    const r = replaceBetween(src, { start, end, replacement: eol + String(body).replace(/\s+$/, '') + eol });
    return { ok: r.ok, text: r.text, changed: r.changed, reason: r.changed ? 'block-updated' : 'block-unchanged' };
  }
  const block = markerBlock(body, marker, 'liquid', { eol });
  const head = src === '' ? '' : (src.endsWith('\n') ? src : src + eol);
  return { ok: true, text: head + block + eol, changed: true, reason: src === '' ? 'created' : 'appended' };
}

/**
 * Apply a change's payload to the current text of a theme file.
 * @returns {{ok, text, changed, reason, notes?}} `reason: 'manual-edit-required'` means a person or
 *          the writer agent has to make this edit — it is never silently skipped.
 */
export function computeThemeEdit(currentText, change) {
  const payload = (change && change.payload) || {};
  const strategy = (change && change.strategy) || payload.strategy || 'manual';
  const marker = payload.marker || blockMarker(payload.block);
  const text = currentText == null ? '' : String(currentText);
  const body = String(payload.snippet || '');

  if (strategy === 'manual') return { ok: false, text, changed: false, reason: 'manual-edit-required' };

  if (strategy === 'liquid-head') {
    if (!body.trim()) return { ok: false, text, changed: false, reason: 'empty-snippet' };
    if (!text.trim()) return { ok: false, text, changed: false, reason: 'theme-file-missing' };
    if (blockIsCurrent(text, marker, body)) return { ok: true, text, changed: false, reason: 'block-unchanged' };
    const anchor = findHeadAnchor(text);
    if (!anchor) return { ok: false, text, changed: false, reason: 'no-head' };
    const r = upsertMarkerBlock(text, { marker, style: 'liquid', body, anchor: anchor.anchor, position: anchor.position });
    return { ok: r.ok, text: r.text, changed: r.changed, reason: r.reason, anchor: anchor.name };
  }

  if (strategy === 'liquid-html-lang') {
    const tags = text.match(/<html\b[^>]*>/gi) || [];
    if (!tags.length) return { ok: false, text, changed: false, reason: 'no-html-tag' };
    if (tags.length > 1) return { ok: false, text, changed: false, reason: 'ambiguous-html-tag' };
    const tag = tags[0];
    const value = payload.lang || HTML_LANG_VALUE;
    if (new RegExp('lang\\s*=\\s*"' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"').test(tag)) {
      return { ok: true, text, changed: false, reason: 'already-present' };
    }
    const nextTag = /\blang\s*=/.test(tag)
      ? tag.replace(/\blang\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, 'lang="' + value + '"')
      : tag.replace(/^<html\b/i, '<html lang="' + value + '"');
    const at = text.indexOf(tag);
    const next = text.slice(0, at) + nextTag + text.slice(at + tag.length);
    return { ok: true, text: next, changed: next !== text, reason: next !== text ? 'lang-set' : 'already-present' };
  }

  if (strategy === 'liquid-robots') {
    const rules = Array.isArray(payload.rules) ? payload.rules.filter(Boolean) : [];
    const notes = [];
    let next = text;
    let changed = false;
    if (!hasDefaultGroupsLoop(next)) {
      next = next.trim()
        ? DEFAULT_ROBOTS_TEMPLATE + (next.startsWith('\n') ? '' : '\n') + next
        : DEFAULT_ROBOTS_TEMPLATE;
      changed = true;
      notes.push(text.trim()
        ? 'restored the {% for group in robots.default_groups %} loop above the existing template'
        : 'created templates/robots.txt.liquid with the platform default_groups loop');
    }
    if (rules.length) {
      const r = upsertOrAppend(next, { marker, body: rules.join('\n') });
      if (!r.ok) return { ...r, notes };
      if (r.changed) { next = r.text; changed = true; notes.push('custom rules block'); }
    }
    if (!changed) return { ok: true, text, changed: false, reason: 'already-present', notes };
    return { ok: true, text: next, changed: true, reason: 'robots-template-updated', notes };
  }

  if (strategy === 'liquid-snippet' || strategy === 'liquid-create') {
    if (!body.trim()) return { ok: false, text, changed: false, reason: 'empty-snippet' };
    return upsertOrAppend(text, { marker, body });
  }

  return { ok: false, text, changed: false, reason: 'unknown-strategy: ' + strategy };
}

// ---------------------------------------------------------------------------
// Work tree

function readIf(abs) { try { return existsSync(abs) ? readFileSync(abs, 'utf8') : null; } catch { return null; } }

function themeFilePath(workDir, relPath) {
  const parts = String(relPath || '').split('/').filter((p) => p && p !== '.');
  if (!parts.length || parts.includes('..')) throw new Error('unsafe theme path: ' + relPath);
  return join(workDir, ...parts);
}

/** Which store this run is about: --store, the ctx, the profile, then SHOPIFY_STORE. */
export function resolveStore(ctx = {}, options = {}) {
  const fromProfile = options.profile && options.profile.platform && options.profile.platform.store;
  const candidates = [options.store, ctx.store, fromProfile, resolveKey('SHOPIFY_STORE', ctx.env || process.env)];
  for (const c of candidates) { const s = normalizeStore(c); if (s) return s; }
  return null;
}

function manifestShopify(run) {
  const m = run ? run.readManifest() : null;
  return (m && m.shopify && typeof m.shopify === 'object') ? m.shopify : {};
}

function patchShopify(run, patch) {
  if (!run) return null;
  return run.updateManifest((m) => {
    m.shopify = { ...(m.shopify && typeof m.shopify === 'object' ? m.shopify : {}), ...patch };
    return m;
  });
}

/**
 * Pull the live theme into <DATA>/work once per run and take a full backup copy of what came down.
 * `refresh` forces a fresh pull (and a fresh backup). Returns `{ok:false, needs}` when the CLI or a
 * credential is missing — that is a `skipped_unready`, never a pretend success.
 */
export async function ensureWorkTree(ctx = {}, { refresh = false } = {}) {
  const env = ctx.env || process.env;
  const store = ctx.store || resolveStore(ctx);
  if (!store) return { ok: false, reason: 'no-store', needs: ['SHOPIFY_STORE'], store: null };
  const missing = missingKeys(CREDENTIAL_KEYS, env);
  if (missing.length) return { ok: false, reason: 'missing-credentials', needs: missing, store };

  const saved = manifestShopify(ctx.run);
  let liveThemeId = saved.live_theme_id || null;
  if (!liveThemeId) {
    const listed = await runTheme({ ...ctx, store }, ['list', '--json'], { label: 'list' });
    const themes = parseThemeList(listed.stdout);
    if (!themes) {
      return { ok: false, reason: 'theme-list-failed', store, detail: listed.stderr.slice(0, 500) || listed.stdout.slice(0, 500) || ('exit ' + listed.code), needs: [] };
    }
    const live = liveThemeOf(themes);
    if (!live) return { ok: false, reason: 'no-live-theme', store, needs: [], detail: 'theme list returned ' + themes.length + ' themes but none with role main' };
    liveThemeId = live.id;
    patchShopify(ctx.run, { store, live_theme_id: live.id, live_theme_name: live.name });
  }

  const workDir = workDirFor(ctx.dataDir, store, liveThemeId);
  const stampPath = join(workDir, PULL_STAMP);
  const pulledBefore = existsSync(stampPath);
  if (pulledBefore && !refresh) {
    const stamp = readJson(stampPath, {}) || {};
    return { ok: true, store, liveThemeId, workDir, backupDir: stamp.backup || null, pulled: false };
  }

  if (refresh && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const pulled = await runTheme({ ...ctx, store }, ['pull', '--live'], { path: workDir, label: 'pull' });
  if (pulled.code !== 0) {
    return { ok: false, reason: 'theme-pull-failed', store, liveThemeId, workDir, needs: [], detail: (pulled.stderr || pulled.stdout || '').slice(0, 500) };
  }
  const backupDir = themeBackupDir(ctx.dataDir, store, liveThemeId, stampFor(ctx.now ? ctx.now() : new Date()));
  mkdirSync(dirname(backupDir), { recursive: true });
  cpSync(workDir, backupDir, { recursive: true });
  writeJson(stampPath, { store, live_theme_id: liveThemeId, pulled_at: new Date().toISOString(), backup: backupDir });
  patchShopify(ctx.run, { store, live_theme_id: liveThemeId, work_dir: workDir, backup_dir: backupDir, pulled_at: new Date().toISOString() });
  if (ctx.run) ctx.run.log({ event: 'pull', adapter: ADAPTER, store, theme: liveThemeId, backup: backupDir });
  return { ok: true, store, liveThemeId, workDir, backupDir, pulled: true };
}

/** `theme check --path <work> -o json --fail-level error` over the working copy. */
export async function runThemeCheck(ctx, workDir) {
  const res = await runTheme(ctx, ['check', '-o', 'json', '--fail-level', THEME_CHECK_FAIL_LEVEL], { path: workDir, label: 'check' });
  const parsed = parseThemeCheck(res.stdout, res.code);
  return { ...parsed, code: res.code, command: res.command, stderr: res.stderr.slice(0, 2000) };
}

// ---------------------------------------------------------------------------
// capabilities

/**
 * capabilities: is the Shopify CLI usable, are the credentials present, is there a theme slot left,
 * and does the store already carry this tool's staging theme?
 */
export async function capabilities(ctx = {}) {
  const env = ctx.env || process.env;
  const store = resolveStore(ctx);
  const keys = presence(CREDENTIAL_KEYS, env);
  const missing = keys.filter((k) => !k.present).map((k) => k.key);
  const binary = whichOnPath('shopify', env);
  const notes = [];
  const tools = { shopify: { on_path: !!binary, path: binary, version: null } };

  // With the offline flag set and no injected exec nothing may spawn, so the probes below would
  // report "the CLI is not usable" when the truth is that we refused to ask.
  const offline = !ctx.execImpl && !!env.CLAUDE_SEO_AI_OFFLINE;
  if (offline) notes.push('CLAUDE_SEO_AI_OFFLINE=1: the CLI was not run, so its version and the store\'s theme list are unknown');
  if (!binary) notes.push('the Shopify CLI is not on PATH — install it (npm i -g @shopify/cli) so theme pull/push can run');
  if (!offline && (binary || ctx.execImpl)) {
    const v = await runShopifyVersion({ ...ctx, store }).catch((e) => ({ code: 1, stdout: '', stderr: String(e && e.message || e) }));
    const line = String(v.stdout || v.stderr || '').trim().split('\n')[0] || null;
    tools.shopify.version = v.code === 0 ? line : null;
    if (v.code !== 0) notes.push('`shopify version` exited ' + v.code + ' — the CLI is present but not usable here');
  }

  let themes = null;
  let slots = null;
  let staging = null;
  if (!offline && !missing.length && (binary || ctx.execImpl)) {
    const listed = await runTheme({ ...ctx, store }, ['list', '--json'], { label: 'list' });
    themes = parseThemeList(listed.stdout);
    if (!themes) {
      notes.push('`theme list --json` did not return JSON — theme slots and the staging theme are unknown');
    } else {
      const existing = stagingThemeOf(themes);
      staging = existing ? { id: existing.id, name: existing.name } : null;
      slots = {
        used: themes.length,
        limit_documented: THEME_LIMIT_DOCUMENTED,
        remaining_if_limit_is_20: Math.max(0, THEME_LIMIT_DOCUMENTED - themes.length),
        note: 'the 20-theme cap is a store limit this adapter cannot read; the remaining count assumes it',
      };
      if (!existing && themes.length >= THEME_LIMIT_DOCUMENTED) {
        notes.push('the store already has ' + themes.length + ' themes: delete one, or reuse an existing ' + STAGING_PREFIX + ' theme, before a push can create another');
      }
      if (existing) notes.push('reusing the existing staging theme "' + existing.name + '" (id ' + existing.id + ') instead of creating another');
      const live = liveThemeOf(themes);
      if (live) notes.push('live theme: "' + live.name + '" (id ' + live.id + ') — it is pulled read-only and never pushed to');
    }
  }

  const ready = !missing.length && !!(binary || ctx.execImpl) && !!store;
  if (!store) notes.push('no store: pass --store <my-store.myshopify.com> or set SHOPIFY_STORE');
  return {
    adapter: ADAPTER,
    ready,
    needs: [...new Set([...missing, ...(store ? [] : ['SHOPIFY_STORE']), ...(binary || ctx.execImpl ? [] : ['shopify CLI on PATH'])])],
    tools,
    store,
    credentials: keys.map((k) => ({ key: k.key, present: k.present, source: k.source })),
    themes: themes ? themes.length : null,
    slots,
    staging_theme: staging,
    writes: 'an unpublished theme only; publishing the live theme is a separate op with its own ticket',
    notes,
  };
}

// ---------------------------------------------------------------------------
// plan

function verifyMethodFor(block) {
  if (block === 'robots') return 'robots_parse';
  if (block === 'structured-data' || block === 'product-jsonld') return 'schema_validator';
  if (block === 'hreflang' || block === 'llms' || block === 'agents') return 'manual_review';
  return 'dom_assert';
}

function assertionFor(block, file, entry = {}) {
  if (block === 'robots') {
    if (entry.robots_kind === 'additive') return 'robots.txt on the preview theme serves the added directive and still emits Shopify\'s default groups';
    if (entry.robots_kind === 'edit-existing') return 'a person made the edit in ' + file + ' and robots.txt on the preview theme no longer carries the rule this finding named';
  }
  switch (block) {
    case 'canonical': return 'the previewed page carries a single <link rel="canonical"> pointing at the base product URL';
    case 'viewport': return 'the previewed page carries a viewport meta tag';
    case 'html-lang': return 'the previewed page\'s <html> element has a non-empty lang attribute';
    case 'social': return 'the previewed page carries the Open Graph / Twitter tags from the snippet';
    case 'structured-data': return 'the previewed page emits the JSON-LD from ' + file;
    case 'robots': return 'robots.txt on the preview theme keeps Shopify\'s default groups';
    case 'llms': case 'agents': return 'the generated file is served on the preview theme (checked by hand: its wording is yours)';
    default: return 'a person reviewed ' + file + ' on the preview theme';
  }
}

function planPreviewText({ finding, entry, snippet, file, store }) {
  return [
    (entry.strategy === 'manual' ? 'Manual theme edit' : 'Staged theme edit') + ' — ' + file,
    'Store:   ' + (store || '(unset)'),
    'Finding: ' + finding.id + ' — ' + finding.title,
    finding.location && finding.location.url ? 'URL:     ' + finding.location.url : null,
    finding.evidence && finding.evidence.observed ? 'Observed: ' + finding.evidence.observed : null,
    '',
    entry.strategy === 'manual'
      ? 'This one is a removal or a rewrite of theme code, not an exact-anchor insertion, so the tool\nnever does it automatically. Edit it in the pulled working copy:'
      : 'Block written between {% comment %}' + blockMarker(entry.block) + ':start{% endcomment %} markers:',
    snippet || '(the exact text has to come from you — nothing is invented here)',
    '',
    'Nothing goes live: the edit is pushed to an unpublished "' + STAGING_PREFIX + '" theme and previewed at ?preview_theme_id=.',
  ].filter((l) => l !== null).join('\n');
}

/**
 * plan: findings → theme changes. No CLI call happens here; the real diff arrives with `preview`,
 * which is what pulls the theme.
 * @param {object} options { report, profile, store, category, includeProposed, answers, findings, now }
 * @param {object} ctx     { run, dataDir, env, execImpl }
 */
export async function plan(options = {}, ctx = {}) {
  const report = options.report && typeof options.report === 'object' ? options.report
    : (options.report ? readJson(options.report, null) : null);
  const profile = options.profile && typeof options.profile === 'object' ? options.profile
    : (options.profile ? readJson(options.profile, null) : (report && report.platform) || null);
  const findings = Array.isArray(options.findings) ? options.findings : (report && Array.isArray(report.findings) ? report.findings : []);
  const store = resolveStore(ctx, { ...options, profile });

  const changes = [];
  const skipped = [];
  const notes = [];
  if (!store) notes.push('no store resolved: --store or SHOPIFY_STORE is required before preview/apply can run');
  const withheld = withheldProposedNote(findings, { includeProposed: options.includeProposed === true, category: options.category });
  if (withheld) notes.push(withheld);

  const answers = normalizeAnswers(options.answers);
  const runDir = ctx.run ? ctx.run.dir : '<run>';

  for (const finding of fixableFindings(findings, { includeProposed: options.includeProposed, category: options.category })) {
    const entry = themeTargetFor(finding);
    if (!entry) continue;
    const answer = answers[finding.id];
    const parsed = parseFixPreview(finding.fix_preview || answer || '');
    const supplied = parsed.kind === 'none' ? '' : parsed.snippet;
    const snippet = supplied || PLATFORM_BLOCKS[entry.block] || '';

    if (entry.needs_snippet && !supplied) {
      skipped.push({
        finding: finding.id,
        reason: 'needs the exact text for ' + entry.file + ' — the audit gave no fix_preview and no --answers entry, and nothing here is invented',
      });
      continue;
    }
    if (entry.strategy !== 'liquid-robots' && entry.strategy !== 'manual' && !snippet.trim()) {
      skipped.push({ finding: finding.id, reason: 'no snippet to write into ' + entry.file });
      continue;
    }

    const rules = entry.strategy === 'liquid-robots' ? robotsRulesFrom(supplied) : [];
    // An additive robots change IS its directive: with no line to add, appending the marked block
    // would write nothing and the change would report "already-present" — a fix that is not one.
    if (entry.robots_kind === 'additive' && !rules.length) {
      skipped.push({
        finding: finding.id,
        reason: 'needs the exact robots directive to add (e.g. "Sitemap: https://<store>/sitemap.xml") — '
          + 'the audit gave no fix_preview and no --answers entry, and a robots line is never invented',
      });
      continue;
    }
    const url = (finding.location && finding.location.url) || (report && report.target && report.target.kind === 'url' ? report.target.value : null);
    const cls = entry.strategy === 'manual' ? 'proposed' : (finding.fixable === 'auto' ? entry.cls : 'proposed');

    const payload = {
      block: entry.block,
      file: entry.file,
      strategy: entry.strategy,
      marker: blockMarker(entry.block),
      snippet,
      source: supplied ? (answer && !finding.fix_preview ? 'answers' : 'fix_preview') : 'platform-default',
      ...(rules.length ? { rules } : {}),
      ...(entry.robots_kind ? { robots_kind: entry.robots_kind } : {}),
      ...(entry.block === 'html-lang' ? { lang: HTML_LANG_VALUE } : {}),
    };

    const draft = {
      finding_ids: [finding.id],
      adapter: ADAPTER,
      class: cls,
      target: { kind: 'theme-file', locator: entry.file, url: url || undefined },
      op: entry.op,
      strategy: entry.strategy,
      payload,
      requires: { credentials: [...CREDENTIAL_KEYS], tools: ['shopify'] },
      live_impact: 'staged',
      rollback: { kind: 'restore-file', data: { path: entry.file } },
      status: 'planned',
    };
    const id = makeChange(draft, { mode: 'return', phase: 'plan' }).change.id;

    const built = makeChange({
      ...draft,
      id,
      preview: { kind: 'text', body: planPreviewText({ finding, entry, snippet: rules.length ? rules.join('\n') : snippet, file: entry.file, store }) },
      verify: {
        method: verifyMethodFor(entry.block),
        command: reproduceCommand('adapters/shopify-theme.mjs', ['verify', '--run', runDir, '--change', id]),
        assertion: assertionFor(entry.block, entry.file, entry),
        url: url || undefined,
      },
    }, { mode: 'return', phase: 'preview' });
    if (built.errors.length) { skipped.push({ finding: finding.id, reason: 'invalid change: ' + built.errors.join('; ') }); continue; }
    changes.push(built.change);

    // A generated JSON-LD snippet is dead code until the layout renders it: the pair is planned
    // together so a confirmed fix is actually served.
    if (entry.block === 'structured-data') {
      const renderDraft = {
        finding_ids: [finding.id],
        adapter: ADAPTER,
        class: cls,
        target: { kind: 'theme-file', locator: 'layout/theme.liquid', url: url || undefined },
        op: 'insert',
        strategy: 'liquid-head',
        payload: { block: 'structured-data-render', file: 'layout/theme.liquid', strategy: 'liquid-head', marker: blockMarker('structured-data-render'), snippet: RENDER_STRUCTURED_DATA, source: 'platform-default' },
        requires: { credentials: [...CREDENTIAL_KEYS], tools: ['shopify'] },
        live_impact: 'staged',
        rollback: { kind: 'restore-file', data: { path: 'layout/theme.liquid' } },
        status: 'planned',
      };
      const renderId = makeChange(renderDraft, { mode: 'return', phase: 'plan' }).change.id;
      const renderBuilt = makeChange({
        ...renderDraft,
        id: renderId,
        preview: { kind: 'text', body: 'Renders the generated snippet from the layout head:\n\n' + RENDER_STRUCTURED_DATA },
        verify: {
          method: 'schema_validator',
          command: reproduceCommand('adapters/shopify-theme.mjs', ['verify', '--run', runDir, '--change', renderId]),
          assertion: 'the previewed page emits the JSON-LD from snippets/seo-structured-data.liquid',
          url: url || undefined,
        },
      }, { mode: 'return', phase: 'preview' });
      if (!renderBuilt.errors.length) changes.push(renderBuilt.change);
    }
  }

  if (!changes.length && !skipped.length) notes.push('no findings in this report map to a Shopify theme file');
  return { adapter: ADAPTER, ready: !!store, store, changes, skipped, notes };
}

// ---------------------------------------------------------------------------
// preview

/**
 * preview: pull once, back up, write the block into the working copy, run `theme check`, diff.
 * A theme-check error reverts the working file and fails the change — a push never follows one.
 */
export async function preview(change, ctx = {}) {
  const payload = change.payload || {};
  if ((change.strategy || payload.strategy) === 'manual') {
    if (ctx.run) writeText(ctx.run.previewPath(change.id, '.txt'), change.preview.body);
    return { change: transition(change, 'previewed'), ok: true, body: change.preview.body, manual: true };
  }
  const tree = await ensureWorkTree({ ...ctx, store: ctx.store || resolveStore(ctx) }, { refresh: !!ctx.refresh });
  if (!tree.ok) return unready(change, tree);

  const rel = payload.file || change.target.locator;
  const abs = themeFilePath(tree.workDir, rel);
  const before = readIf(abs);
  const edit = computeThemeEdit(before, change);
  if (!edit.ok) return { change: transition(change, 'failed', { error: 'cannot edit ' + rel + ': ' + edit.reason }), ok: false, body: null };
  if (!edit.changed) return { change: transition(change, 'skipped_idempotent'), ok: true, body: '', reason: edit.reason };

  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, edit.text);

  const check = await runThemeCheck({ ...ctx, store: tree.store }, tree.workDir);
  if (!check.ok) {
    if (before === null) rmSync(abs, { force: true }); else writeFileSync(abs, before);
    const detail = check.errors.length
      ? check.errors.slice(0, 5).map((e) => e.path + (e.line ? ':' + e.line : '') + ' ' + e.check + ' — ' + e.message).join('; ')
      : ('theme check exited ' + check.code + (check.parsed ? '' : ' and produced no JSON'));
    return {
      change: transition(change, 'failed', { error: 'theme check failed, so nothing was staged: ' + detail }),
      ok: false, body: null, theme_check: check,
    };
  }

  const body = unifiedDiff(before || '', edit.text, { fromFile: 'a/' + rel, toFile: 'b/' + rel });
  if (ctx.run) writeText(ctx.run.previewPath(change.id, '.diff'), body);
  const next = transition({
    ...change,
    preview: { kind: 'diff', body, lang: 'diff' },
    before: { path: rel, exists: before !== null, bytes: before === null ? 0 : Buffer.byteLength(before) },
    payload: { ...payload, work_dir: tree.workDir, backup_dir: tree.backupDir },
  }, 'previewed');
  return { change: next, ok: true, body, theme_check: check, work_dir: tree.workDir };
}

function unready(change, tree) {
  const why = tree.reason === 'missing-credentials'
    ? 'missing credentials: ' + tree.needs.join(', ')
    : tree.reason + (tree.detail ? ' (' + tree.detail + ')' : '');
  return { change: transition(change, 'skipped_unready', { error: 'the Shopify theme working copy is not available — ' + why }), ok: false, needs: tree.needs || [] };
}

// ---------------------------------------------------------------------------
// apply

/**
 * apply: make sure the working copy carries the block, re-run `theme check`, then push to an
 * unpublished theme. The first push of a run creates "claude-seo-ai <date>"; every later push in the
 * same run targets that theme id with --nodelete. The push is done once per process even when
 * several changes are applied in one invocation.
 */
export async function apply(change, ctx = {}) {
  const payload = change.payload || {};
  if ((change.strategy || payload.strategy) === 'manual') {
    return {
      change: transition(change, 'skipped_unready', { error: 'manual theme edit: make it in the pulled working copy with Edit/Write, then re-run preview' }),
      ok: false, reason: 'manual-edit-required',
    };
  }
  let confirmed;
  try { confirmed = ensureConfirmed(change); }
  catch (e) { return { change, ok: false, error: String(e && e.message || e) }; }

  const tree = await ensureWorkTree({ ...ctx, store: ctx.store || resolveStore(ctx) }, { refresh: false });
  if (!tree.ok) return unready(confirmed, tree);

  const rel = payload.file || confirmed.target.locator;
  const abs = themeFilePath(tree.workDir, rel);
  const before = readIf(abs);
  const edit = computeThemeEdit(before, confirmed);
  if (!edit.ok) return { change: transition(confirmed, 'failed', { error: 'cannot edit ' + rel + ': ' + edit.reason }), ok: false };
  if (edit.changed) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, edit.text); }

  const check = await runThemeCheck({ ...ctx, store: tree.store }, tree.workDir);
  if (!check.ok) {
    if (edit.changed) { if (before === null) rmSync(abs, { force: true }); else writeFileSync(abs, before); }
    const detail = check.errors.length
      ? check.errors.slice(0, 5).map((e) => e.path + (e.line ? ':' + e.line : '') + ' ' + e.check + ' — ' + e.message).join('; ')
      : ('theme check exited ' + check.code + (check.parsed ? '' : ' and produced no JSON'));
    return { change: transition(confirmed, 'failed', { error: 'theme check failed, so nothing was pushed: ' + detail }), ok: false, theme_check: check };
  }

  // The memo lives on the caller's ctx, so several changes applied in one invocation share one push.
  const pushed = await pushOnce(ctx, tree);
  if (!pushed.ok) return { change: transition(confirmed, 'failed', { error: pushed.error }), ok: false, push: pushed };

  if (ctx.run) {
    writeJson(ctx.run.afterPath(confirmed.id), {
      change: confirmed.id, file: rel, store: tree.store,
      theme_id: pushed.theme_id, preview_url: pushed.preview_url, editor_url: pushed.editor_url,
      backup_dir: tree.backupDir, applied_at: new Date().toISOString(),
    });
    ctx.run.log({ event: 'apply', adapter: ADAPTER, change: confirmed.id, file: rel, theme: pushed.theme_id });
  }
  const next = transition({
    ...confirmed,
    payload: { ...payload, work_dir: tree.workDir, backup_dir: tree.backupDir },
    rollback: { kind: 'restore-file', data: { path: rel, backup_dir: tree.backupDir, theme_id: pushed.theme_id } },
  }, 'applied');
  return { change: next, ok: true, push: pushed, theme_check: check };
}

/**
 * Push the working copy to the run's staging theme, at most once per process.
 * First push:  theme push --path <work> --unpublished --theme "claude-seo-ai <date>" --json
 * Later push:  theme push --path <work> --theme <staging id> --nodelete --json
 */
export async function pushOnce(ctx, tree) {
  if (ctx.__push) return ctx.__push;
  const store = ctx.store || tree.store;
  const promise = (async () => {
    const saved = manifestShopify(ctx.run);
    let stagingId = saved.staging_theme_id || null;
    if (!stagingId) {
      const listed = await runTheme({ ...ctx, store }, ['list', '--json'], { label: 'list' });
      const themes = parseThemeList(listed.stdout);
      const existing = themes ? stagingThemeOf(themes) : null;
      if (existing) stagingId = existing.id;
      if (themes && !existing && themes.length >= THEME_LIMIT_DOCUMENTED) {
        return { ok: false, error: 'the store has ' + themes.length + ' themes and no ' + STAGING_PREFIX + ' theme to reuse — free a slot before pushing' };
      }
    }
    const name = saved.staging_theme_name || stagingThemeName(ctx.now ? ctx.now() : new Date());
    const args = stagingId
      ? ['push', '--theme', String(stagingId), '--nodelete', '--json']
      : ['push', '--unpublished', '--theme', name, '--json'];
    const res = await runTheme({ ...ctx, store }, args, { path: tree.workDir, label: 'push' });
    if (res.code !== 0) {
      return { ok: false, error: 'theme push exited ' + res.code + ': ' + (res.stderr || res.stdout || '').slice(0, 500) };
    }
    const parsed = parsePushResult(res.stdout, { store });
    if (!parsed.ok && !stagingId) {
      return { ok: false, error: 'theme push --json did not name a theme id, so there is nothing to preview or roll back; raw output: ' + parsed.raw.slice(0, 300) };
    }
    const themeId = parsed.theme_id || stagingId;
    const out = {
      ok: true,
      theme_id: themeId,
      created: !stagingId,
      name: parsed.name || name,
      preview_url: parsed.preview_url || previewUrl(store, themeId),
      editor_url: parsed.editor_url || editorUrl(store, themeId),
      url_source: parsed.url_source,
    };
    patchShopify(ctx.run, {
      store, staging_theme_id: out.theme_id, staging_theme_name: out.name,
      preview_url: out.preview_url, editor_url: out.editor_url, preview_url_source: out.url_source,
      pushed_at: new Date().toISOString(),
      created_themes: [...new Set([...(manifestShopify(ctx.run).created_themes || []), ...(out.created ? [out.theme_id] : [])])],
    });
    return out;
  })();
  ctx.__push = promise;
  return promise;
}

// ---------------------------------------------------------------------------
// verify

/** The preview URL for a change: the finding's own URL when there is one, otherwise the home page. */
function verifyTargetUrl(change, store, themeId) {
  const block = (change.payload && change.payload.block) || '';
  if (block === 'robots') return previewUrl(store, themeId, '/robots.txt');
  if (block === 'llms') return previewUrl(store, themeId, '/llms.txt');
  if (block === 'agents') return previewUrl(store, themeId, '/agents.md');
  return previewUrl(store, themeId, (change.target && change.target.url) || '/');
}

/** The og:/twitter: tag names a snippet declares (what a rendered page must then carry). */
export function metaNamesIn(snippet) {
  const out = new Set();
  for (const m of String(snippet || '').matchAll(/\b(?:property|name)\s*=\s*"([^"]+)"/gi)) {
    const key = m[1].trim().toLowerCase();
    if (key.startsWith('og:') || key.startsWith('twitter:')) out.add(key);
  }
  return [...out];
}

/** The schema.org @type values a JSON-LD snippet declares. */
export function jsonLdTypesIn(snippet) {
  const out = new Set();
  for (const m of String(snippet || '').matchAll(/"@type"\s*:\s*"([^"]+)"/g)) out.add(m[1].trim());
  return [...out];
}

/** Does the previewed page actually show this block's effect? `null` = could not tell, never a pass. */
export function assertBlock(change, { snapshot = null, robots = null, text = '' } = {}) {
  const block = (change.payload && change.payload.block) || '';
  const parsed = snapshot && snapshot.parsed ? snapshot.parsed : null;
  const html = String(text || '');
  switch (block) {
    case 'canonical': {
      const list = parsed && Array.isArray(parsed.canonicals) ? parsed.canonicals : [];
      if (!list.length) return { ok: false, detail: 'no <link rel="canonical"> on the previewed page' };
      const href = String(list[0].abs || list[0].href || '');
      const want = String((change.target && change.target.url) || '');
      if (!want) return { ok: true, detail: 'canonical present: ' + href };
      let base = want;
      try { const u = new URL(want); base = u.origin + u.pathname.replace(/^\/collections\/[^/]+(?=\/products\/)/, ''); } catch { /* keep want */ }
      const same = href.replace(/\/$/, '') === base.replace(/\/$/, '');
      return { ok: same, detail: same ? 'canonical is ' + href : 'canonical is ' + href + ', expected ' + base };
    }
    case 'viewport': {
      const metas = parsed && Array.isArray(parsed.metas) ? parsed.metas : [];
      const hit = metas.some((m) => m && String(m.name).toLowerCase() === 'viewport' && String(m.content || '').trim());
      return { ok: hit, detail: hit ? 'viewport meta present' : 'no viewport meta on the previewed page' };
    }
    case 'html-lang': {
      const lang = parsed && parsed.lang ? String(parsed.lang) : (/<html\b[^>]*\blang\s*=\s*"([^"]+)"/i.exec(html) || [])[1] || '';
      return { ok: !!lang.trim(), detail: lang ? '<html lang="' + lang + '">' : 'the previewed page has no html lang attribute' };
    }
    case 'social': {
      // The snippet is Liquid, so its literal text is never in the rendered page: check that the
      // tags it declares are present with a value instead.
      const wanted = metaNamesIn(String((change.payload && change.payload.snippet) || ''));
      if (!wanted.length) return { ok: null, detail: 'the snippet declares no og:/twitter: tag to look for — check the previewed page by hand' };
      const metas = parsed && Array.isArray(parsed.metas) ? parsed.metas : [];
      const has = (key) => metas.some((m) => m && String(m.property || m.name || '').toLowerCase() === key && String(m.content || '').trim());
      const missing = wanted.filter((k) => !has(k));
      return { ok: missing.length === 0, detail: missing.length ? 'still missing ' + missing.join(', ') : 'the previewed page carries ' + wanted.join(', ') };
    }
    case 'structured-data': case 'structured-data-render': {
      const blocks = parsed && Array.isArray(parsed.jsonld) ? parsed.jsonld : [];
      if (!blocks.length) return { ok: false, detail: 'the previewed page emits no JSON-LD' };
      const wanted = jsonLdTypesIn(String((change.payload && change.payload.snippet) || ''));
      if (!wanted.length) return { ok: true, detail: blocks.length + ' JSON-LD block(s) on the previewed page' };
      const served = new Set(blocks.flatMap((b) => (Array.isArray(b.type) ? b.type : [b.type]).filter(Boolean).map((t) => String(t))));
      const missing = wanted.filter((t) => !served.has(t));
      return { ok: missing.length === 0, detail: missing.length ? 'no ' + missing.join('/') + ' node on the previewed page' : wanted.join(', ') + ' is served' };
    }
    case 'robots': {
      if (!robots) return { ok: null, detail: 'robots.txt could not be parsed on the preview theme' };
      const kind = (change.payload && change.payload.robots_kind) || null;
      // An `edit-existing` change is made by hand, so there is no marked block to look for and no
      // rule this module can name: the operator says whether the edit landed.
      if (kind === 'edit-existing') {
        return { ok: null, detail: 'this one is a hand edit of robots.txt.liquid — re-read the file and the previewed robots.txt yourself' };
      }
      // What this block guarantees is that Shopify's default groups still emit; the tag-combination
      // rule is the observable proof of that. Literal custom rules are checked too; wildcard ones
      // are named as not asserted rather than counted as a pass.
      let origin = 'https://store.invalid';
      try { origin = new URL(String((change.target && change.target.url) || origin)).origin; } catch { /* keep the placeholder */ }
      const combo = isAllowed(robots, 'Googlebot', origin + '/collections/shoes/blue+wide');
      const kept = !!(combo && combo.allowed === false);
      if (!kept) return { ok: false, detail: 'tag-combination URLs are allowed — the default_groups loop is not emitting' };
      const rules = Array.isArray(change.payload && change.payload.rules) ? change.payload.rules : [];
      // A `Sitemap:` line is the whole point of an additive change: assert the served file declares it.
      const wantedSitemaps = rules.map((r) => /^\s*sitemap\s*:\s*(\S+)\s*$/i.exec(r)).filter(Boolean).map((m) => m[1]);
      const servedSitemaps = new Set((robots.sitemaps || []).map((s) => String(s).trim()));
      const missingSitemaps = wantedSitemaps.filter((s) => !servedSitemaps.has(s));
      if (missingSitemaps.length) return { ok: false, detail: 'robots.txt does not declare ' + missingSitemaps.join(', ') };
      const literal = rules.map((r) => /^\s*disallow\s*:\s*(\S+)\s*$/i.exec(r)).filter(Boolean).map((m) => m[1]).filter((p) => p.startsWith('/') && !/[*$]/.test(p));
      const notBlocked = literal.filter((p) => { const v = isAllowed(robots, 'Googlebot', origin + p); return !v || v.allowed !== false; });
      const unasserted = rules.length - literal.length - wantedSitemaps.length;
      const suffix = unasserted > 0 ? '; ' + unasserted + ' rule(s) (wildcards, Allow, Crawl-delay) were not asserted automatically' : '';
      if (notBlocked.length) return { ok: false, detail: 'still crawlable: ' + notBlocked.join(', ') + suffix };
      const proved = [
        'the default group still disallows tag-combination URLs',
        wantedSitemaps.length ? 'robots.txt declares ' + wantedSitemaps.join(', ') : null,
        literal.length ? literal.join(', ') + ' is blocked' : null,
      ].filter(Boolean);
      return { ok: true, detail: proved.join(' and ') + suffix };
    }
    default:
      return { ok: null, detail: 'no automatic assertion for the "' + block + '" block — review it on the preview theme' };
  }
}

/**
 * verify: fetch the change's page on the preview theme and check the block took effect.
 * Shopify serves themes through its CDN, so "the file has it but the page does not yet" is
 * `pending_cache` — never a pass.
 */
export async function verify(change, ctx = {}) {
  const saved = manifestShopify(ctx.run);
  const store = ctx.store || saved.store || resolveStore(ctx);
  const themeId = saved.staging_theme_id;
  const payload = change.payload || {};
  if (!store || !themeId) {
    return { change, ok: null, checks: [{ name: 'preview-theme', ok: null, detail: 'no staging theme in the run manifest yet — apply first' }] };
  }

  const workDir = payload.work_dir || (saved.live_theme_id ? workDirFor(ctx.dataDir, store, saved.live_theme_id) : null);
  const rel = payload.file || change.target.locator;
  const sourceText = workDir ? readIf(themeFilePath(workDir, rel)) : null;
  const sourceOk = sourceText === null ? null : sourceText.includes(markerComment(blockMarker(payload.block) + ':start', 'liquid'))
    || (payload.block === 'html-lang' && /<html\b[^>]*\blang\s*=/i.test(sourceText))
    || (payload.block === 'robots' && hasDefaultGroupsLoop(sourceText));
  const checks = [{ name: 'theme-source', ok: sourceOk, detail: sourceText === null ? 'working copy for ' + rel + ' not found' : (sourceOk ? 'the block is in ' + rel : 'the block is not in ' + rel) }];

  const url = verifyTargetUrl(change, store, themeId);
  const fetched = await fetchPreview(url, ctx);
  if (!fetched.ok) {
    checks.push({ name: 'preview-url', ok: null, detail: 'could not fetch ' + url + ': ' + fetched.error });
    return { change, ok: null, checks, url };
  }
  const robots = payload.block === 'robots' ? parseRobots(fetched.text) : null;
  const assertion = assertBlock(change, { snapshot: fetched.snapshot, robots, text: fetched.text });
  checks.push({ name: 'preview-url', ok: assertion.ok, detail: assertion.detail + ' (' + url + ')' });

  if (assertion.ok === true) {
    if (change.status === 'verified') return { change, ok: true, checks, url };
    return { change: transition(change, 'verified'), ok: true, checks, url };
  }
  if (assertion.ok === null) return { change, ok: null, checks, url, note: 'no automatic assertion for this block — verify it by hand on ' + url };
  if (sourceOk) {
    const next = change.status === 'applied' || change.status === 'pending_cache' ? transition(change, 'pending_cache') : change;
    return { change: next, ok: null, checks, url, note: 'the theme file has the block but ' + url + ' does not serve it yet — Shopify\'s CDN lags; re-verify shortly' };
  }
  const failed = change.status === 'applied' || change.status === 'pending_cache'
    ? transition(change, 'failed', { error: 'verification failed: ' + assertion.detail })
    : change;
  return { change: failed, ok: false, checks, url };
}

async function fetchPreview(url, ctx = {}) {
  try {
    const opts = { persist: false, artifacts: 'none', render: 'static', env: ctx.env || process.env };
    if (ctx.fetchImpl) opts.fetchImpl = ctx.fetchImpl;
    if (/\/(robots\.txt|llms\.txt|agents\.md)(\?|$)/.test(url)) {
      const raw = await (ctx.fetchImpl || (await import('../lib/fetch.mjs')).fetchRaw)(url, { timeoutMs: 20000, maxHops: 5, maxBytes: 1_000_000 });
      const text = (raw && raw.body && raw.body.text) || '';
      return { ok: !!(raw && Number(raw.status) >= 200 && Number(raw.status) < 400), text, snapshot: null, error: raw && raw.error ? String(raw.error) : null };
    }
    const snap = await snapshotUrl(url, opts);
    if (!snap.ok) return { ok: false, text: '', snapshot: null, error: snap.error || 'snapshot failed' };
    const text = (snap.snapshot && snap.snapshot.html_inline && snap.snapshot.html_inline.raw) || '';
    return { ok: true, text, snapshot: snap.snapshot, error: null };
  } catch (e) {
    return { ok: false, text: '', snapshot: null, error: String(e && e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// rollback

/** rollback (one change): put the file back from the full copy taken after the pull. */
export async function rollback(change, ctx = {}) {
  const payload = change.payload || {};
  const data = (change.rollback && change.rollback.data) || {};
  const saved = manifestShopify(ctx.run);
  const store = ctx.store || saved.store || resolveStore(ctx);
  const backupDir = data.backup_dir || payload.backup_dir || saved.backup_dir;
  const workDir = payload.work_dir || saved.work_dir || (store && saved.live_theme_id ? workDirFor(ctx.dataDir, store, saved.live_theme_id) : null);
  const rel = data.path || payload.file || change.target.locator;
  if (!backupDir || !workDir) {
    return { change: transition(change, 'failed', { error: 'no pulled backup for this run — restore the theme from the store\'s own theme library' }), ok: false };
  }
  const from = themeFilePath(backupDir, rel);
  const to = themeFilePath(workDir, rel);
  if (!existsSync(from)) {
    rmSync(to, { force: true });
    if (ctx.run) ctx.run.log({ event: 'rollback', adapter: ADAPTER, change: change.id, file: rel, action: 'removed (absent in the pulled theme)' });
    return {
      change: transition(change, 'rolled_back'), ok: true, file: rel,
      note: rel + ' did not exist in the pulled theme, so it was removed from the working copy; push again to update the staging theme',
    };
  }
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, readFileSync(from));
  if (ctx.run) ctx.run.log({ event: 'rollback', adapter: ADAPTER, change: change.id, file: rel });
  return {
    change: transition(change, 'rolled_back'), ok: true, file: rel,
    note: 'the working copy is back to the pulled version; the staging theme still holds the old push until you push or delete it (rollback --all deletes it)',
  };
}

/**
 * rollback --all: delete only the staging themes this run created, and republish the theme that was
 * live before a `publish`. Themes this run did not create are never deleted.
 */
export async function rollbackAll(ctx = {}) {
  const saved = manifestShopify(ctx.run);
  const store = ctx.store || saved.store || resolveStore(ctx);
  const results = [];
  if (saved.published && saved.published.previous_live_id) {
    const res = await runTheme({ ...ctx, store }, ['publish', '--theme', String(saved.published.previous_live_id), '--force'], { label: 'publish-rollback' });
    results.push({ action: 'republish', theme: saved.published.previous_live_id, ok: res.code === 0, detail: res.code === 0 ? null : (res.stderr || res.stdout).slice(0, 300) });
  }
  for (const id of saved.created_themes || []) {
    const res = await runTheme({ ...ctx, store }, ['delete', '--theme', String(id), '--force'], { label: 'delete' });
    results.push({ action: 'delete-theme', theme: id, ok: res.code === 0, detail: res.code === 0 ? null : (res.stderr || res.stdout).slice(0, 300) });
  }
  if (!results.length) {
    return { adapter: ADAPTER, ok: true, results, note: 'this run created no theme and published nothing, so there is nothing to undo on the store' };
  }
  patchShopify(ctx.run, { rolled_back_at: new Date().toISOString() });
  return { adapter: ADAPTER, ok: results.every((r) => r.ok), results };
}

// ---------------------------------------------------------------------------
// publish

/**
 * publish: swap the live theme to the staging theme. Its own op, its own ticket, and it records the
 * id of the theme that was live first so `rollback --all` can put it back.
 */
export async function publish(ctx = {}) {
  const saved = manifestShopify(ctx.run);
  const store = ctx.store || saved.store || resolveStore(ctx);
  const themeId = saved.staging_theme_id;
  if (!store) return { adapter: ADAPTER, ok: false, error: 'no store: pass --store or set SHOPIFY_STORE' };
  if (!themeId) return { adapter: ADAPTER, ok: false, error: 'nothing to publish: this run has not pushed a staging theme yet' };

  const listed = await runTheme({ ...ctx, store }, ['list', '--json'], { label: 'list' });
  const themes = parseThemeList(listed.stdout);
  if (!themes) return { adapter: ADAPTER, ok: false, error: 'could not read the theme list before publishing, so the previous live theme id is unknown — refusing to publish' };
  const live = liveThemeOf(themes);
  if (!live) return { adapter: ADAPTER, ok: false, error: 'the theme list named no live theme, so there would be nothing to roll back to — refusing to publish' };
  if (live.id === String(themeId)) {
    return { adapter: ADAPTER, ok: true, published: false, theme_id: themeId, note: 'theme ' + themeId + ' is already the live theme' };
  }
  patchShopify(ctx.run, { published: { previous_live_id: live.id, previous_live_name: live.name, theme_id: String(themeId), at: null } });

  const res = await runTheme({ ...ctx, store }, ['publish', '--theme', String(themeId), '--force'], { label: 'publish' });
  if (res.code !== 0) {
    return { adapter: ADAPTER, ok: false, error: 'theme publish exited ' + res.code + ': ' + (res.stderr || res.stdout).slice(0, 500), previous_live_id: live.id };
  }
  const at = new Date().toISOString();
  patchShopify(ctx.run, { published: { previous_live_id: live.id, previous_live_name: live.name, theme_id: String(themeId), at } });
  if (ctx.run) ctx.run.log({ event: 'publish', adapter: ADAPTER, theme: String(themeId), previous_live_id: live.id });
  return {
    adapter: ADAPTER, ok: true, published: true, theme_id: String(themeId), previous_live_id: live.id, at,
    note: 'the store is now serving theme ' + themeId + '; `rollback --all` republishes ' + live.id,
  };
}

// ---------------------------------------------------------------------------
// CLI

function loadRun(args, dataDir) {
  if (args.run && args.run !== true) return loadFixRun(String(args.run), { dataDir });
  return null;
}

function pickChanges(run, args) {
  const plan = run ? run.readPlan() : null;
  const all = plan && Array.isArray(plan.changes) ? plan.changes : [];
  const mine = all.filter((c) => c.adapter === ADAPTER);
  if (args.change && args.change !== true) {
    const wanted = new Set((Array.isArray(args.change) ? args.change : [args.change]).map(String));
    return mine.filter((c) => wanted.has(c.id));
  }
  return mine;
}

function persist(run, updated) {
  if (!run || !updated.length) return;
  const plan = run.readPlan();
  if (!plan || !Array.isArray(plan.changes)) return;
  const byId = new Map(updated.map((c) => [c.id, c]));
  plan.changes = plan.changes.map((c) => (byId.has(c.id) ? byId.get(c.id) : c));
  run.setChanges(plan.changes);
}

export async function main(args = {}) {
  const op = String((args._ && args._[0]) || '').trim();
  if (!OPS.includes(op)) {
    return { result: { error: 'usage: shopify-theme <' + OPS.join('|') + '> --run <dir> [--change <id>] [--ticket <t>] [--store <s>] [--refresh] [--all]' }, code: EXIT.USAGE };
  }
  const dataDir = resolveDataDir(args);
  const ctx = {
    dataDir, env: process.env, now: () => new Date(),
    store: args.store && args.store !== true ? normalizeStore(String(args.store)) : null,
    refresh: args.refresh === true,
  };
  ctx.store = ctx.store || resolveStore(ctx);

  if (op === 'capabilities') return { result: await capabilities(ctx), code: EXIT.OK };

  if (op === 'plan') {
    if (!args.report || args.report === true) return { result: { error: 'plan needs --report <report.json>' }, code: EXIT.USAGE };
    const report = readJson(String(args.report), null);
    if (!report) return { result: { error: 'cannot read report: ' + args.report }, code: EXIT.USAGE };
    const profilePath = args.profile && args.profile !== true ? String(args.profile) : null;
    const run = loadRun(args, dataDir) || openFixRun(dataDir, { report: String(args.report), profile: profilePath, target: report.target || null, adapters: [ADAPTER] });
    ctx.run = run;
    const out = await plan({
      report, profile: profilePath, store: ctx.store,
      category: args.category === true ? null : args.category,
      includeProposed: args['include-proposed'] === true,
      answers: args.answers,
    }, ctx);
    if (out.changes.length) {
      const planFile = run.readPlan() || { changes: [] };
      const others = (planFile.changes || []).filter((c) => c.adapter !== ADAPTER);
      run.setChanges([...others, ...out.changes]);
      for (const c of out.changes) if (c.preview && c.preview.body) writeText(run.previewPath(c.id, '.txt'), c.preview.body);
    }
    run.log({ event: 'plan', adapter: ADAPTER, changes: out.changes.length, skipped: out.skipped.length });
    return { result: { ...out, run: run.id, run_dir: run.dir }, code: out.ready ? EXIT.OK : EXIT.USAGE };
  }

  const run = loadRun(args, dataDir);
  if (!run) return { result: { error: op + ' needs --run <fix-run-dir>' }, code: EXIT.USAGE };
  ctx.run = run;
  ctx.store = ctx.store || manifestShopify(run).store || null;

  if (op === 'publish') {
    const gate = requireTicket(dataDir, { ticket: args.ticket, run: run.id, change: null });
    if (!gate.ok) {
      return { result: { adapter: ADAPTER, op, error: 'publish needs its own confirmation ticket (' + gate.reason + ')' }, code: EXIT.USAGE };
    }
    const out = await publish(ctx);
    run.log({ event: 'publish', adapter: ADAPTER, ok: out.ok });
    updateManifest(run, { op: 'publish', adapter: ADAPTER, wrote: out.published === true });
    return { result: { ...out, run: run.id, run_dir: run.dir }, code: out.ok ? EXIT.OK : EXIT.RUNTIME };
  }

  if (op === 'rollback' && args.all === true) {
    const out = await rollbackAll(ctx);
    updateManifest(run, { op: 'rollback', adapter: ADAPTER, wrote: !!(out.results && out.results.length) });
    return { result: { ...out, run: run.id, run_dir: run.dir }, code: out.ok ? EXIT.OK : EXIT.RUNTIME };
  }

  const changes = pickChanges(run, args);
  if (!changes.length) {
    return { result: { error: 'no ' + ADAPTER + ' changes in ' + run.dir + (args.change ? ' matching --change ' + args.change : '') }, code: EXIT.USAGE };
  }

  const results = [];
  const updated = [];
  for (const change of changes) {
    if (op === 'apply') {
      const gate = requireTicket(dataDir, { ticket: args.ticket, run: run.id, change: change.id });
      if (!gate.ok) {
        results.push({ change: change.id, ok: false, refused: gate.reason, error: 'apply needs a valid confirmation ticket (' + gate.reason + ')' });
        continue;
      }
    }
    const fn = { preview, apply, verify, rollback }[op];
    let out;
    try { out = await fn(change, ctx); }
    catch (e) { out = opThrew(change, e); }
    if (out.change) updated.push(out.change);
    results.push({
      change: change.id, status: out.change ? out.change.status : change.status, ok: out.ok,
      ...(out.error ? { error: out.error } : {}), ...(out.checks ? { checks: out.checks } : {}),
      ...(out.reason ? { reason: out.reason } : {}), ...(out.note ? { note: out.note } : {}),
      ...(out.url ? { url: out.url } : {}), ...(out.theme_check ? { theme_check: { ok: out.theme_check.ok, errors: out.theme_check.errors } } : {}),
      ...(out.push ? { push: out.push } : {}),
    });
  }
  persist(run, updated);
  logOpEvent(run, { op, adapter: ADAPTER, results });
  updateManifest(run, { op, adapter: ADAPTER, changes: updated });
  const failed = results.some((r) => r.ok === false);
  return { result: { adapter: ADAPTER, op, run: run.id, run_dir: run.dir, store: ctx.store, results }, code: failed ? EXIT.RUNTIME : EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);

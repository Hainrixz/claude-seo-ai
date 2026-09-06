#!/usr/bin/env node
// PreToolUse guard for the file-writing tools (Write, Edit, MultiEdit, NotebookEdit).
//
// Defense in depth, not the primary guarantee. The primary guarantees are the read-only tool
// allowlists on the auditor agents, `fix`'s `disable-model-invocation: true`, and the single-writer
// rule (only `seo-fixer-writer` holds Edit/Write). This hook is what stays true when one of those
// is misconfigured — and it is matcher-agnostic on purpose: it reads every path field the file
// tools use (`file_path`, `notebook_path`, `edits[].file_path`, …) so adding a tool to the matcher
// in hooks/hooks.json never needs a change here.
//
// Two decisions, and they are deliberately different:
//   * a protected path (secrets, VCS internals, lockfiles, wp-config.php, a live Shopify
//     settings_data.json) -> DENY. Hard. No SEO fix ever needs one of these.
//   * a path outside the containment roots (the project, its .claude/worktrees, the plugin data
//     dir) -> ASK, so the write reaches the user's own permission decision instead of being
//     silently accepted under `acceptEdits`. It is not a deny because this hook is installed for
//     the whole session, not just for `fix`: denying every write outside the project would break
//     unrelated work (scratchpads, ~/.claude edits) that has nothing to do with this plugin.
//
// Contract: reads the hook payload on stdin, writes the PreToolUse JSON decision on stdout, and
// exits 2 with the reason on stderr when it denies (the documented fallback for hosts that do not
// read the JSON). Exit 0 and no output means "no opinion" — never an `allow`, which would strip the
// user's own prompt. Every export is pure so tests can call it without spawning.

import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOK_EVENT = 'PreToolUse';

/**
 * Paths no SEO fix may write, wherever they live. Matched against the slash-normalized path, so
 * `C:\repo\.env` and `repo/.env` hit the same rule.
 */
export const PROTECTED_PATTERNS = Object.freeze([
  { rule: 'vcs-internals', re: /(^|\/)\.git(\/|$)/, what: 'Git internals' },
  { rule: 'env-file', re: /(^|\/)\.env([./][^/]*)?$/i, what: 'environment files' },
  { rule: 'env-file', re: /(^|\/)\.envrc$/i, what: 'environment files' },
  { rule: 'ssh-key', re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)([.-][^/]*)?$/i, what: 'SSH private keys' },
  { rule: 'key-material', re: /\.(pem|key|p12|pfx|jks|keystore)$/i, what: 'key material' },
  { rule: 'lockfile', re: /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/i, what: 'dependency lockfiles' },
  { rule: 'ssh-dir', re: /(^|\/)\.ssh(\/|$)/, what: 'the SSH directory' },
  { rule: 'aws-dir', re: /(^|\/)\.aws(\/|$)/, what: 'the AWS credentials directory' },
  { rule: 'gnupg-dir', re: /(^|\/)\.gnupg(\/|$)/, what: 'the GnuPG directory' },
  { rule: 'netrc', re: /(^|\/)\.netrc$/i, what: 'netrc credentials' },
  { rule: 'secrets', re: /(^|\/)secrets?(\/|\.|$)/i, what: 'files named for secrets' },
  // Shopify: settings_data.json is the merchant's live theme content (section order, copy, colors),
  // not SEO markup. The theme adapter edits theme.liquid and snippets; this file is never a fix.
  { rule: 'shopify-settings-data', re: /(^|\/)config\/settings_data\.json$/i, what: 'the live Shopify theme settings (merchant content, not SEO markup)' },
  // WordPress: database credentials, salts and constants. WP fixes go through REST or WP-CLI.
  { rule: 'wp-config', re: /(^|\/)wp-config\.php$/i, what: 'the WordPress configuration file (database credentials and salts)' },
]);

/** Tool-input keys that carry a file path across the file-writing tools. */
export const PATH_FIELDS = Object.freeze(['file_path', 'filePath', 'notebook_path', 'notebookPath', 'path']);

/** `C:\a\b` -> `C:/a/b`, quotes stripped, repeated slashes collapsed. Never resolves. */
export function normalizePath(value) {
  let s = String(value == null ? '' : value).trim();
  if (s.length > 1 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) s = s.slice(1, -1);
  return s.split('\\').join('/').replace(/\/{2,}/g, '/');
}

/** Every path this tool call would write. Order is stable; duplicates are dropped. */
export function targetPaths(toolInput = {}) {
  const out = [];
  const push = (v) => { if (typeof v === 'string' && v.trim() && !out.includes(v)) out.push(v); };
  for (const field of PATH_FIELDS) push(toolInput[field]);
  if (Array.isArray(toolInput.edits)) for (const e of toolInput.edits) if (e && typeof e === 'object') for (const field of PATH_FIELDS) push(e[field]);
  if (Array.isArray(toolInput.files)) for (const e of toolInput.files) { if (typeof e === 'string') push(e); else if (e && typeof e === 'object') for (const field of PATH_FIELDS) push(e[field]); }
  return out;
}

/** The first protected-path rule `path` hits, or null. */
export function protectedReason(path) {
  const norm = normalizePath(path);
  if (!norm) return null;
  for (const p of PROTECTED_PATTERNS) if (p.re.test(norm)) return { rule: p.rule, what: p.what };
  return null;
}

/** Absolute, slash-normalized form of `path`, resolved against `cwd` when relative. */
export function absolutize(path, cwd = null) {
  const norm = normalizePath(path);
  if (!norm) return '';
  const abs = isAbsolute(norm) || /^[A-Za-z]:\//.test(norm) ? norm : resolve(cwd || process.cwd(), norm);
  return normalizePath(resolve(abs));
}

const caseFold = process.platform === 'win32' || process.platform === 'darwin';
const foldCase = (s) => (caseFold ? s.toLowerCase() : s);

/**
 * Real path of `p`, resolving symlinks as far up the tree as actually exists. A file that is about
 * to be created has no realpath of its own, but its directory usually does — and on macOS the temp
 * dir alone is a symlink, so comparing a resolved root against an unresolved target would call
 * every write an escape.
 */
export function realPathish(p) {
  const norm = normalizePath(p);
  if (!norm) return '';
  const parts = norm.split('/');
  for (let cut = parts.length; cut > 0; cut--) {
    const head = parts.slice(0, cut).join('/') || '/';
    try { return normalizePath([realpathSync(head), ...parts.slice(cut)].join('/')); }
    catch { /* try a shorter prefix */ }
  }
  return norm;
}

/** True when `child` is `parent` or sits under it. Symlinks are resolved when they exist. */
export function isInside(child, parent) {
  if (!child || !parent) return false;
  const c = foldCase(realPathish(child));
  const p = foldCase(realPathish(parent)).replace(/\/+$/, '');
  if (!p) return false;
  return c === p || c.startsWith(p + '/');
}

const trimmedValue = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** `--data <dir>` / `--data=<dir>` from a hook's own argv. */
export function dataFlag(argv = []) {
  const i = argv.indexOf('--data');
  if (i !== -1 && typeof argv[i + 1] === 'string' && argv[i + 1].trim() && !argv[i + 1].startsWith('--')) return argv[i + 1].trim();
  const eq = argv.find((a) => typeof a === 'string' && a.startsWith('--data='));
  return trimmedValue(eq ? eq.slice(7) : null);
}

/**
 * Every directory that could be the plugin data dir for this session.
 *
 * lib/adapter.mjs picks exactly one (--data > CLAUDE_SEO_AI_HOME > CLAUDE_PLUGIN_DATA > ~), but a
 * hook's `--data` comes from a static hooks.json template rather than from the user's own choice.
 * If a user sets CLAUDE_SEO_AI_HOME, the fix flow writes its tickets and backups there while the
 * hook's flag still points at CLAUDE_PLUGIN_DATA — so the hook considers all of them. A wider set
 * only ever avoids a wrong deny; the ticket files themselves are what authorize anything.
 */
export function dataDirCandidates({ env = process.env, argv = [] } = {}) {
  const out = [];
  for (const value of [trimmedValue(env.CLAUDE_SEO_AI_HOME), trimmedValue(env.CLAUDE_PLUGIN_DATA), dataFlag(argv), resolve(homedir(), '.claude-seo-ai')]) {
    if (!value) continue;
    const abs = normalizePath(resolve(value));
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

/**
 * Where a write may land: the project root (CLAUDE_PROJECT_DIR, else the payload's cwd with a
 * warning), that project's `.claude/worktrees`, and every candidate plugin data dir.
 * @returns {{list: string[], project: string|null, source: string, warn: string|null}}
 */
export function allowedRoots({ env = process.env, cwd = null, argv = [] } = {}) {
  const list = [];
  const add = (p) => { const a = p && normalizePath(resolve(String(p))); if (a && !list.includes(a)) list.push(a); };

  const projectEnv = trimmedValue(env.CLAUDE_PROJECT_DIR);
  const project = projectEnv || trimmedValue(cwd);
  const source = projectEnv ? 'CLAUDE_PROJECT_DIR' : (project ? 'payload.cwd' : 'none');
  const warn = projectEnv ? null
    : (project ? 'CLAUDE_PROJECT_DIR is not set; containment fell back to the tool call\'s cwd' : 'no project root: CLAUDE_PROJECT_DIR is unset and the payload carries no cwd');
  if (project) { add(project); add(resolve(project, '.claude', 'worktrees')); }
  for (const dir of dataDirCandidates({ env, argv })) add(dir);
  return { list, project: project ? normalizePath(resolve(project)) : null, source, warn };
}

/**
 * The hook decision for one payload.
 * @returns {{decision: 'deny'|'ask'|'allow', rule: string, reason: string, path: string|null}}
 */
export function decide(payload = {}, { env = process.env, argv = [] } = {}) {
  const input = (payload && (payload.tool_input || payload.toolInput)) || {};
  const paths = targetPaths(input);
  if (!paths.length) return { decision: 'allow', rule: 'no-path', reason: '', path: null };

  for (const path of paths) {
    const hit = protectedReason(path);
    if (hit) {
      return {
        decision: 'deny', rule: hit.rule, path: normalizePath(path),
        reason: 'claude-seo-ai: refusing to write ' + normalizePath(path) + ' — ' + hit.what +
          ' are never part of an SEO fix. If this write is unrelated to claude-seo-ai, do it in a session with the plugin disabled.',
      };
    }
  }

  const roots = allowedRoots({ env, cwd: payload && payload.cwd, argv });
  if (!roots.project) return { decision: 'allow', rule: 'no-root', reason: '', path: null };
  for (const path of paths) {
    const abs = absolutize(path, payload && payload.cwd);
    if (roots.list.some((root) => isInside(abs, root))) continue;
    return {
      decision: 'ask', rule: 'outside-project', path: abs,
      reason: 'claude-seo-ai: ' + abs + ' is outside the project root (' + roots.project + ')' +
        (roots.warn ? ' [' + roots.warn + ']' : '') +
        '. SEO fixes stay inside the project, its .claude/worktrees, or the plugin data dir — confirm this write yourself if you meant it.',
    };
  }
  return { decision: 'allow', rule: 'contained', reason: '', path: null };
}

/** The JSON a PreToolUse hook writes on stdout. `allow` is never emitted — see the header. */
export function hookOutput(decision) {
  return { hookSpecificOutput: { hookEventName: HOOK_EVENT, permissionDecision: decision.decision, permissionDecisionReason: decision.reason } };
}

/** Read stdin, decide, print, exit. The exit code is this script's contract with the hook runner. */
export function runHook({ env = process.env, argv = process.argv.slice(2) } = {}) {
  let payload = {};
  try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
  catch { process.exit(0); } // unreadable payload: no opinion, never a blanket block

  let decision;
  try { decision = decide(payload, { env, argv }); }
  catch (e) { process.stderr.write('claude-seo-ai guard-write: ' + String((e && e.message) || e) + '\n'); process.exit(0); }

  if (decision.decision === 'allow') process.exit(0);
  process.stdout.write(JSON.stringify(hookOutput(decision)) + '\n');
  if (decision.decision === 'deny') { process.stderr.write(decision.reason + '\n'); process.exit(2); }
  process.exit(0);
}

function invokedDirectly() {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (invokedDirectly()) runHook();

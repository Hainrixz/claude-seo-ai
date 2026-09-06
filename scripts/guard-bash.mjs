#!/usr/bin/env node
// PreToolUse guard for Bash. Closes the hole guard-write cannot see: the writer agent holds Bash,
// and a shell command can push a theme live, rewrite a WordPress option, POST to an Admin API or
// clobber a .env with a redirect — none of which passes through Write/Edit.
//
// Three tiers, evaluated in this order:
//   1. HARD DENY — `shopify theme push` carrying a live flag (--allow-live/-a/--live/-l/
//      --publish/-p), and shell redirects or `tee` into a protected file (.env*, .git/, keys).
//      No ticket unlocks these: the theme adapter pushes to an *unpublished* theme and publishing
//      is its own ticketed op, so a live push from the shell is always a mistake or a bypass.
//   2. TICKET-GATED — the remote write surface (shopify theme push|publish|delete; wp option/post
//      meta/post/db/plugin/theme/user writes, locally or over ssh; curl/wget/node -e writes against
//      the platform APIs; and the adapters' own apply|publish|rollback ops). With a live
//      confirmation ticket for this command the hook asks; without one it denies.
//   3. everything else — exit 0, no output, no opinion. The regex pre-check below is what keeps
//      that path in the microseconds: nothing is read from disk unless a gated pattern matched.
//
// Honest limit (plan 3f.4): a ticket is procedural hardening, not a capability. Hooks inherit
// Claude Code's environment, so an in-band marker would be self-issuable; the real backstop is
// Claude Code's own Bash permission prompt. Never allowlist `Bash(shopify:*)`, `Bash(wp:*)` or
// `Bash(ssh:*)` — that is what this hook cannot replace.
//
// Contract: hook payload on stdin, PreToolUse JSON decision on stdout, exit 2 + stderr on deny
// (the fallback for hosts that do not read the JSON). `ask` reaches the user's normal permission
// prompt; a host that does not know the value falls back to that same prompt, never to an
// auto-approval, because this hook never emits `allow`.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROTECTED_PATTERNS, dataDirCandidates, normalizePath } from './guard-write.mjs';

export const HOOK_EVENT = 'PreToolUse';

/** Shopify CLI flags that make a push touch the live theme. Mirrors lib/shell.mjs SHOPIFY_LIVE_FLAGS. */
export const SHOPIFY_LIVE_FLAGS = Object.freeze(['--allow-live', '--live', '--publish', '-a', '-l', '-p']);

/** WP-CLI subcommand prefixes that write. Mirrors the intent of lib/shell.mjs WP_WRITE_VERBS. */
export const WP_GATED_PREFIXES = Object.freeze([
  'option update', 'option add', 'option delete', 'option patch', 'option set',
  'post meta update', 'post meta add', 'post meta delete', 'post meta patch',
  'post update', 'post create', 'post delete',
  'term update', 'user ', 'db ', 'plugin ', 'theme ', 'site ', 'search-replace',
]);

/** Hosts and path fragments that identify a platform write API. */
export const API_TARGETS = Object.freeze([
  { re: /\/admin\/api\//i, api: 'the Shopify Admin API' },
  { re: /\/wp-json\//i, api: 'the WordPress REST API' },
  { re: /\bapi\.webflow\.com\b/i, api: 'the Webflow API' },
  { re: /\bwixapis\.com\b/i, api: 'the Wix API' },
  { re: /\/ghost\/api\/admin\//i, api: 'the Ghost Admin API' },
  { re: /\bapi\.hubapi\.com\b/i, api: 'the HubSpot API' },
  { re: /\bapi\.bigcommerce\.com\b/i, api: 'the BigCommerce API' },
]);

// Cheap first pass: when none of these appear the command cannot match any rule below, and the
// hook exits without touching the filesystem.
const MAYBE = /(shopify|wp[\s.]|wp$|curl|wget|node\s+-{1,2}e|adapters[\\/]|\btee\b|>)/i;

/**
 * Split a command line into statements on the shell operators that actually separate them —
 * `&&`, `||`, `;`, `|` and a newline — and only when they are unquoted.
 *
 * A bare `&` is NOT a separator here. It is the character that joins query-string parameters, and
 * splitting on it tore `curl "https://shop.myshopify.com/admin/api/2026-07/x.json?a=1&b=2" -X POST`
 * in half: the piece carrying the API host lost the `-X POST`, so the write went unrecognised.
 * Backgrounding a command with `&` therefore leaves it in the same segment as its neighbour, which
 * costs nothing — every rule below matches on substrings, so a longer segment still fires.
 *
 * Quotes are tracked (single, double, and a backslash escape outside single quotes), so a quoted
 * remote command (`ssh host 'cd /p && wp option update …'`) now stays one segment and is classified
 * as the remote write it is.
 */
export function segments(command) {
  const src = String(command == null ? '' : command);
  const out = [];
  let buf = '';
  let quote = null;
  const cut = () => { out.push(buf); buf = ''; };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < src.length) { buf += ch + src[++i]; continue; }
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '\\' && i + 1 < src.length) { buf += ch + src[++i]; continue; }
    if (ch === '\n' || ch === ';') { cut(); continue; }
    if ((ch === '&' || ch === '|') && src[i + 1] === ch) { cut(); i++; continue; }
    if (ch === '|') { cut(); continue; }
    buf += ch;
  }
  cut();
  return out.map((s) => s.trim()).filter(Boolean);
}

const unquote = (s) => {
  const t = String(s || '').trim();
  if (t.length > 1 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) return t.slice(1, -1);
  return t;
};

/** True when a token in `segment` is a Shopify live-theme flag (including `-alp` style clusters). */
export function touchesLiveFlag(segment) {
  for (const raw of String(segment || '').split(/\s+/)) {
    const token = raw.split('=')[0];
    if (SHOPIFY_LIVE_FLAGS.includes(token)) return token;
    // Clustered short flags: `-ap` is `-a -p`. Only letters we actually gate count.
    if (/^-[A-Za-z]{2,8}$/.test(token) && /[alp]/.test(token.slice(1))) return token;
  }
  return null;
}

/** Files a `>`/`>>`/`tee` in this segment would write. Quoted targets are unquoted. */
export function redirectTargets(segment) {
  const out = [];
  const s = String(segment || '');
  for (const m of s.matchAll(/(?:^|[^0-9&>])>>?\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/g)) out.push(unquote(m[1]));
  for (const m of s.matchAll(/\btee\b((?:\s+-{1,2}[A-Za-z-]+)*)\s+("[^"]*"|'[^']*'|[^\s;&|<>]+)/g)) out.push(unquote(m[2]));
  return out.filter(Boolean);
}

/** The WP-CLI subcommand words of a segment (flags stripped), or null when there is no `wp` call. */
export function wpSubcommand(segment) {
  const m = /(?:^|[\s(])wp(?:\.phar)?\s+(.+)$/i.exec(String(segment || ''));
  if (!m) return null;
  const words = m[1].split(/\s+/)
    .map((w) => unquote(w))
    .filter((w) => w && !w.startsWith('-'))
    .map((w) => w.toLowerCase());
  return words.length ? words.join(' ') + ' ' : null;
}

const hasWriteMethod = (segment) =>
  /(^|\s)(-X|--request)(=|\s+)['"]?(POST|PUT|PATCH|DELETE)\b/i.test(segment) ||
  /(^|\s)(--data|--data-raw|--data-binary|--data-urlencode|-d|--form|-F|--upload-file|-T|--post-data|--post-file)(=|\s)/i.test(segment) ||
  /(^|\s)--method(=|\s+)['"]?(POST|PUT|PATCH|DELETE)\b/i.test(segment) ||
  /\bmethod\s*:\s*['"`](post|put|patch|delete)['"`]/i.test(segment);

/**
 * Classify one command.
 * @returns {{tier: 'deny'|'gate'|'none', rule: string, detail: string, segment: string}}
 */
export function classify(command) {
  const raw = String(command == null ? '' : command);
  const segs = segments(raw);

  // 1. hard denies
  for (const seg of segs) {
    for (const target of redirectTargets(seg)) {
      const norm = normalizePath(target);
      const hit = PROTECTED_PATTERNS.find((p) => p.re.test(norm));
      if (hit) return { tier: 'deny', rule: 'redirect-into-protected', detail: 'a shell redirect would write ' + norm + ' (' + hit.what + ')', segment: seg };
    }
  }
  for (const seg of segs) {
    if (!/\bshopify\b/i.test(seg) || !/\btheme\b/i.test(seg) || !/\bpush\b/i.test(seg)) continue;
    const flag = touchesLiveFlag(seg);
    if (flag) return { tier: 'deny', rule: 'shopify-live-push', detail: '`shopify theme push` with ' + flag + ' writes the live storefront theme', segment: seg };
  }

  // 2. ticket-gated
  for (const seg of segs) {
    if (/\bshopify\s+theme\s+(push|publish|delete)\b/i.test(seg)) {
      const op = /\bshopify\s+theme\s+(push|publish|delete)\b/i.exec(seg)[1].toLowerCase();
      return { tier: 'gate', rule: 'shopify-theme-' + op, detail: '`shopify theme ' + op + '` changes themes on the store', segment: seg };
    }
    const wp = wpSubcommand(seg);
    if (wp && (WP_GATED_PREFIXES.some((p) => wp.startsWith(p)) || /(^| )delete /.test(wp))) {
      const remote = /(?:^|[\s(])ssh\b/i.test(seg);
      return { tier: 'gate', rule: remote ? 'wp-cli-write-remote' : 'wp-cli-write', detail: '`wp ' + wp.trim() + '`' + (remote ? ' over ssh' : '') + ' writes to the WordPress site', segment: seg };
    }
    const isHttpTool = /(?:^|[\s(])(curl|wget)\b/i.test(seg) || /(?:^|[\s(])node\s+(?:-e|--eval)\b/i.test(seg);
    if (isHttpTool && hasWriteMethod(seg)) {
      const target = API_TARGETS.find((t) => t.re.test(seg));
      if (target) return { tier: 'gate', rule: 'platform-api-write', detail: 'a write request against ' + target.api, segment: seg };
    }
    if (/adapters[\\/][a-z0-9._-]+\.mjs/i.test(seg) && /(^|\s)(apply|publish|rollback)(\s|$)/.test(seg)) {
      const op = /(^|\s)(apply|publish|rollback)(\s|$)/.exec(seg)[2];
      return { tier: 'gate', rule: 'adapter-' + op, detail: 'an adapter `' + op + '` op', segment: seg };
    }
  }
  return { tier: 'none', rule: 'none', detail: '', segment: '' };
}

/** The `--ticket <id|command>` value carried by a command, or null. */
export function extractTicketArg(command) {
  const m = /--ticket(?:=|\s+)("[^"]*"|'[^']*'|\S+)/.exec(String(command || ''));
  return m ? unquote(m[1]) : null;
}

/** The same command with its `--ticket …` argument removed (that is what the ticket hashes). */
export function stripTicketArg(command) {
  return String(command || '').replace(/\s*--ticket(?:=|\s+)("[^"]*"|'[^']*'|\S+)/g, '').trim();
}

/**
 * Look for a live confirmation ticket covering `command`. Never consumes one — the adapter's own
 * requireTicket() does that, and a hook that burned the ticket would break the command it just
 * waved through.
 *
 * Two dimensions of candidates. Forms of the command: an explicit `--ticket <id|command>`, the exact
 * command, and the command with its `--ticket` argument stripped (the form the fix flow hashes,
 * since the id cannot be part of what hashes to it). Places to look: every candidate data dir
 * (see guard-write dataDirCandidates) — the hook's `--data` comes from a static template, and a
 * user who set CLAUDE_SEO_AI_HOME would otherwise have every confirmed command denied.
 * @returns {Promise<{ok: boolean, reason: string, id: string|null, expires_at: string|null}>}
 */
export async function findTicket(command, { argv = [], env = process.env, now = Date.now() } = {}) {
  let A;
  try { A = await import('./lib/adapter.mjs'); }
  catch (e) { return { ok: false, reason: 'ticket-store-unavailable: ' + String((e && e.message) || e), id: null, expires_at: null }; }
  const forms = [];
  const explicit = extractTicketArg(command);
  if (explicit) forms.push(explicit);
  forms.push(String(command || '').trim());
  const stripped = stripTicketArg(command);
  if (stripped && stripped !== String(command || '').trim()) forms.push(stripped);

  let reason = 'no-ticket';
  for (const dataDir of dataDirCandidates({ env, argv })) {
    for (const form of forms) {
      if (!form) continue;
      let found;
      try { found = A.requireTicket(dataDir, { ticket: form, now, consume: false }); }
      catch { continue; }
      if (found.ok) return { ok: true, reason: null, id: found.ticket.command_sha256 || null, expires_at: found.ticket.expires_at || null };
      if (found.reason && found.reason !== 'no-ticket' && reason === 'no-ticket') reason = found.reason;
    }
  }
  return { ok: false, reason, id: null, expires_at: null };
}

/** Redact a command before it goes into a reason string. Falls back to naming nothing. */
async function safeExcerpt(command) {
  try {
    const A = await import('./lib/adapter.mjs');
    return A.redactCommand(String(command || '')).slice(0, 200);
  } catch { return '[command withheld]'; }
}

/**
 * The hook decision for one payload.
 * @returns {Promise<{decision: 'deny'|'ask'|'allow', rule: string, reason: string}>}
 */
export async function decide(payload = {}, { env = process.env, argv = [], now = Date.now() } = {}) {
  const input = (payload && (payload.tool_input || payload.toolInput)) || {};
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command.trim() || !MAYBE.test(command)) return { decision: 'allow', rule: 'none', reason: '' };

  const verdict = classify(command);
  if (verdict.tier === 'none') return { decision: 'allow', rule: 'none', reason: '' };

  if (verdict.tier === 'deny') {
    return {
      decision: 'deny', rule: verdict.rule,
      reason: 'claude-seo-ai: blocked — ' + verdict.detail + '. ' + (verdict.rule === 'shopify-live-push'
        ? 'Push to an unpublished theme instead (`shopify theme push --unpublished`) and publish through `node scripts/adapters/shopify-theme.mjs publish`, which takes its own confirmation.'
        : 'Secrets, VCS internals and key material are never part of an SEO fix.'),
    };
  }

  const ticket = await findTicket(command, { argv, env, now });
  const excerpt = await safeExcerpt(verdict.segment || command);
  if (ticket.ok) {
    return {
      decision: 'ask', rule: verdict.rule,
      reason: 'claude-seo-ai: ' + verdict.detail + '. A confirmation ticket issued by /claude-seo-ai:fix covers this command' +
        (ticket.expires_at ? ' (expires ' + ticket.expires_at + ')' : '') + ' — approve it yourself if you asked for it. Command: ' + excerpt,
    };
  }
  return {
    decision: 'deny', rule: verdict.rule,
    reason: 'claude-seo-ai: blocked — ' + verdict.detail + ', and no valid confirmation ticket covers it (' + ticket.reason + '). ' +
      'Writes go through /claude-seo-ai:fix: it previews the change, asks you, then issues a one-shot 15-minute ticket for the exact command. Command: ' + excerpt,
  };
}

/** The JSON a PreToolUse hook writes on stdout. `allow` is never emitted — see the header. */
export function hookOutput(decision) {
  return { hookSpecificOutput: { hookEventName: HOOK_EVENT, permissionDecision: decision.decision, permissionDecisionReason: decision.reason } };
}

/** Read stdin, decide, print, exit. The exit code is this script's contract with the hook runner. */
export async function runHook({ env = process.env, argv = process.argv.slice(2) } = {}) {
  let payload = {};
  try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
  catch { process.exit(0); }

  let decision;
  try { decision = await decide(payload, { env, argv }); }
  catch (e) {
    // Fail closed only for something we already decided is gated; a crash before that is silent.
    process.stderr.write('claude-seo-ai guard-bash: ' + String((e && e.message) || e) + '\n');
    process.exit(0);
  }

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

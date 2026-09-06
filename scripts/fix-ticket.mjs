#!/usr/bin/env node
// Confirmation tickets for the write ops — the CLI over lib/adapter.mjs's ticket helpers.
//
// A ticket says one thing: "the user confirmed *this exact command*, at this time, for this change
// in this run." It is a file at <DATA>/fix/tickets/<sha256(normalized command)>.json holding
// { run, change, issued_at, expires_at (+15 min), one_shot } — never the command itself, only its
// hash and a redacted preview.
//
// Who calls what:
//   issue    the `fix` flow, in the turn right after the user confirmed. Nothing else, ever.
//   check    scripts/guard-bash.mjs (read-only: a hook that consumed the ticket would break the
//            command it just waved through) and anyone debugging a gate.
//   consume  the adapters' apply/publish/rollback, through requireTicket() — this CLI exposes the
//            same thing for adapters that shell out.
//
// The honest limit is in plan 3f.4: hooks inherit Claude Code's environment, so a ticket is
// procedural hardening, not a capability boundary. The real backstop is the user's own Bash
// permission prompt.
//
// Usage:
//   node scripts/fix-ticket.mjs issue   --command "<cmd>|-" [--run <id>] [--change <id>] [--ttl <ms>] [--reusable] [--data <dir>]
//   node scripts/fix-ticket.mjs check   --command "<cmd>|-" | --id <64-hex> [--run <id>] [--change <id>] [--data <dir>]
//   node scripts/fix-ticket.mjs consume --command "<cmd>|-" | --id <64-hex> [--run <id>] [--change <id>] [--data <dir>]
// `--command -` reads the command from stdin, which is the safe way to pass one that carries quotes.
// Exit codes: 0 ok · 1 usage · 3 no valid ticket (check/consume).

import { readFileSync } from 'node:fs';
import { EXIT, isMain, runCli } from './lib/util.mjs';
import {
  TICKET_TTL_MS, isTicketId, issueTicket, redactCommand, requireTicket,
  resolveDataDirInfo, ticketId, ticketPath, ticketPathById,
} from './lib/adapter.mjs';

export const OPS = Object.freeze(['issue', 'check', 'consume']);

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The command to hash: `--command <s>`, the first positional after the op, or stdin on `-`. */
export function readCommand(args) {
  let value = args.command === true ? null : str(args.command);
  if (!value && Array.isArray(args._) && args._.length > 1) value = str(args._.slice(1).join(' '));
  if (value === '-') {
    try { value = readFileSync(0, 'utf8').trim(); } catch (e) { return { command: null, error: 'cannot read the command from stdin: ' + String((e && e.message) || e) }; }
  }
  return { command: value || null, error: null };
}

/** What a ticket may reveal: never the command, never a secret — the hash, the binding, the clock. */
export function describeTicket(ticket, { id = null, now = Date.now() } = {}) {
  if (!ticket) return null;
  const expires = Date.parse(ticket.expires_at);
  return {
    id: id || ticket.command_sha256 || null,
    run: ticket.run || null,
    change: ticket.change || null,
    issued_at: ticket.issued_at || null,
    expires_at: ticket.expires_at || null,
    expires_in_ms: Number.isFinite(expires) ? Math.max(0, expires - now) : null,
    one_shot: ticket.one_shot !== false,
    uses: Number(ticket.uses) || 0,
    command_preview: ticket.command_preview || null,
  };
}

export async function main(args) {
  const op = String((args._ && args._[0]) || '').trim();
  if (!OPS.includes(op)) {
    return { result: { error: 'usage: fix-ticket <' + OPS.join('|') + '> --command "<cmd>|-" | --id <64-hex> [--run <id>] [--change <id>] [--ttl <ms>] [--reusable] [--data <dir>]' }, code: EXIT.USAGE };
  }
  const info = resolveDataDirInfo(args);
  const dataDir = info.dir;
  const run = str(args.run);
  const change = str(args.change);
  const now = Date.now();

  if (op === 'issue') {
    const { command, error } = readCommand(args);
    if (error) return { result: { error }, code: EXIT.USAGE };
    if (!command) return { result: { error: 'issue needs --command "<the exact command the user confirmed>" (or --command - to read it from stdin)' }, code: EXIT.USAGE };
    const ttlRaw = args.ttl === undefined || args.ttl === true ? TICKET_TTL_MS : Number(args.ttl);
    if (!Number.isFinite(ttlRaw) || ttlRaw <= 0) return { result: { error: '--ttl must be a positive number of milliseconds' }, code: EXIT.USAGE };
    const issued = issueTicket(dataDir, { command, run, change, ttlMs: ttlRaw, now, one_shot: args.reusable !== true });
    return {
      result: {
        op: 'issue', data_dir: dataDir, data_dir_source: info.source, path: issued.path,
        ...describeTicket(issued.ticket, { id: issued.id, now }),
        note: 'One-shot unless --reusable. The adapter consumes it on apply; guard-bash only reads it.',
      },
      code: EXIT.OK,
    };
  }

  // check / consume take either the command or the id it hashes to.
  const id = str(args.id);
  const { command, error } = readCommand(args);
  if (error) return { result: { error }, code: EXIT.USAGE };
  const ticketRef = id || command;
  if (!ticketRef) return { result: { error: op + ' needs --command "<cmd>" or --id <64-hex>' }, code: EXIT.USAGE };
  if (id && !isTicketId(id)) return { result: { error: '--id must be 64 hex characters (the sha256 of the normalized command)' }, code: EXIT.USAGE };

  const found = requireTicket(dataDir, { ticket: ticketRef, run, change, now, consume: op === 'consume' });
  const resolvedId = id || ticketId(command);
  const result = {
    op, ok: found.ok, reason: found.reason, data_dir: dataDir, data_dir_source: info.source,
    id: resolvedId, path: id ? ticketPathById(dataDir, id) : ticketPath(dataDir, command),
    consumed: op === 'consume' && found.ok,
    ticket: found.ok ? describeTicket(found.ticket, { id: resolvedId, now }) : null,
  };
  if (!found.ok) {
    result.hint = found.reason === 'no-ticket' || found.reason === 'missing'
      ? 'No ticket for this command. /claude-seo-ai:fix issues one after you confirm the change — tickets are never self-issued by an agent.'
      : found.reason === 'expired' ? 'The ticket expired (they last 15 minutes). Re-confirm the change in /claude-seo-ai:fix.'
        : found.reason === 'wrong-run' || found.reason === 'wrong-change' ? 'That ticket belongs to a different run or change; one confirmation never unlocks another change.'
          : 'The ticket file is unreadable and was removed.';
    if (command) result.command_preview = redactCommand(command).slice(0, 300);
  }
  return { result, code: found.ok ? EXIT.OK : EXIT.THRESHOLD };
}

if (isMain(import.meta.url)) runCli(main);

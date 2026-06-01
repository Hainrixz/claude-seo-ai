#!/usr/bin/env node
// PreToolUse guard (defense in depth). Blocks Write/Edit to protected paths regardless
// of workflow — the primary safety guarantees are the read-only auditor tool allowlists
// and fix's `disable-model-invocation: true`; this is the belt-and-suspenders.
//
// Wired from hooks/hooks.json on the Write|Edit matcher. Reads the hook payload on stdin,
// exits 2 (block) with a message on stderr if the target is protected; exits 0 otherwise.

import { readFileSync } from 'node:fs';

const PROTECTED = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)(id_rsa|id_ed25519)(\.|$)/,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/,
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)secrets?(\/|\.|$)/i,
];

let payload = {};
try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* allow on parse failure */ process.exit(0); }

const input = payload.tool_input || payload.toolInput || {};
const path = input.file_path || input.filePath || input.path || '';
if (!path) process.exit(0);

if (PROTECTED.some((re) => re.test(path))) {
  process.stderr.write(
    'claude-seo-ai: refusing to write to a protected path: ' + path +
    '\nSEO fixes never modify VCS internals, secrets, env files, or lockfiles.\n'
  );
  process.exit(2); // block
}
process.exit(0); // allow

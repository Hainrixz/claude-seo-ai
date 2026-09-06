#!/usr/bin/env node
// Keep the fixture site (tests/helpers/server.mjs) running as its own process and print its URL.
//
// The e2e tests start the server in-process, but two things need it in a separate process: a CI
// smoke run of scripts/audit.mjs, and manual poking with curl. A child process that fetches from a
// server hosted in its own parent would deadlock the parent's event loop, so anything that spawns
// the CLI must use this helper.
//
// Usage:
//   node tests/helpers/serve.mjs [--url-file <path>] [--timeout <seconds>] [--quiet]
//
// Prints the origin as the FIRST line of stdout (`http://127.0.0.1:PORT`) so a shell can do
// `URL=$(node tests/helpers/serve.mjs | head -1)`, and writes the same string to --url-file when
// given (no trailing newline), which is the race-free way for a background job to hand the URL
// over. Shuts down on SIGINT/SIGTERM, or after --timeout seconds (default 600, 0 = never) so a
// forgotten background server cannot outlive a CI job.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from './server.mjs';

function parse(argv) {
  const out = { urlFile: null, timeout: 600, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url-file') out.urlFile = argv[++i] || null;
    else if (a.startsWith('--url-file=')) out.urlFile = a.slice('--url-file='.length);
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a.startsWith('--timeout=')) out.timeout = Number(a.slice('--timeout='.length));
    else if (a === '--quiet') out.quiet = true;
  }
  if (!Number.isFinite(out.timeout) || out.timeout < 0) out.timeout = 600;
  return out;
}

const opts = parse(process.argv.slice(2));
const srv = await startServer();

if (opts.urlFile) {
  try { writeFileSync(resolve(opts.urlFile), srv.url); }
  catch (e) { process.stderr.write('serve.mjs: could not write ' + opts.urlFile + ': ' + String((e && e.message) || e) + '\n'); }
}

process.stdout.write(srv.url + '\n');
if (!opts.quiet) {
  process.stdout.write('fixture site on ' + srv.url + ' (pid ' + process.pid + ') — Ctrl-C to stop' +
    (opts.timeout ? ', auto-stop after ' + opts.timeout + 's' : '') + '\n');
}

let stopping = false;
const stop = async (why) => {
  if (stopping) return;
  stopping = true;
  if (!opts.quiet) process.stdout.write('fixture site stopping (' + why + '); ' + srv.hits.length + ' request(s) served\n');
  clearTimeout(timer);
  await srv.close();
};

// The timer is deliberately NOT unref'd: it is what keeps a --timeout run alive and bounded.
const timer = opts.timeout ? setTimeout(() => { stop('timeout'); }, opts.timeout * 1000) : null;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(sig); });

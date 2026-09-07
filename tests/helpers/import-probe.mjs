#!/usr/bin/env node
// Import one module in a pristine child process and report what happened — without ever writing to
// stdout, because the caller's main assertion is that this child's stdout stayed empty.
//
//   node tests/helpers/import-probe.mjs <module path or file: URL> <report.json path>
//
// Why a child at all: tests/unit/importability.test.mjs used to patch the parent's
// process.stdout.write to detect output during a dynamic import. On Node 18 and 20 the node:test
// reporter writes its own stream through that same patched function, so the patch accumulated the
// entire reporter output into one string and blew up with ERR_STRING_TOO_LONG. A child process
// needs no patch: the OS pipe is the observation.
//
// Writes { ok, main, mainAsync, exitCode, isMain, error } to the report path and exits 0 unless the
// imported module itself set process.exitCode (which is exactly what the caller wants to catch).

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [target, out] = process.argv.slice(2);
const report = { ok: false, main: null, mainAsync: null, exitCode: null, isMain: null, error: null };

if (!target || !out) {
  report.error = 'usage: import-probe.mjs <module> <report.json>';
} else {
  // A real URL scheme is at least two characters long (file:, data:, node:); a single letter followed by
// a colon is a Windows drive (D:\\a\\repo), which the ESM loader rejects unless it becomes a file:// URL.
const href = /^[a-z][a-z0-9+.-]+:/i.test(target) ? target : pathToFileURL(target).href;
  try {
    const mod = await import(href);
    // Imported after the target so nothing about this probe is loaded before the module under test.
    const { isMain } = await import(new URL('../../scripts/lib/util.mjs', import.meta.url).href);
    report.main = typeof mod.main;
    report.mainAsync = typeof mod.main === 'function' ? mod.main.constructor.name === 'AsyncFunction' : null;
    report.exitCode = process.exitCode === undefined ? null : process.exitCode;
    report.isMain = isMain(href);
    report.ok = true;
  } catch (e) {
    report.error = String((e && e.stack) || e);
  }
}

if (out) writeFileSync(out, JSON.stringify(report));

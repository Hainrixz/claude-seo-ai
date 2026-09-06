#!/usr/bin/env node
// Test entry point. Discovers tests/unit/*.test.mjs and tests/e2e/*.test.mjs (no glob needed,
// so it works on Node 18) and runs them through node:test, printing one line per test and a
// final summary. Exit code is 1 when any test fails or when no tests ran.
//
// Usage: node tests/run.mjs
//        node --test                              (node's own discovery; finds *.test.mjs on 18-24)
//        node --test 'tests/**/*.test.mjs'        (Node >= 21 glob form)
//        node --test tests/unit tests/e2e         (directory form: Node 18/20 only — 22+ wants files or globs)

import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { cpus } from 'node:os';
import * as nodeTest from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const SUITES = ['unit', 'e2e'];

function discover() {
  const files = [];
  for (const suite of SUITES) {
    const dir = join(here, suite);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) if (name.endsWith('.test.mjs')) files.push(join(dir, name));
  }
  return files;
}

function firstLines(err, n = 6) {
  const cause = err && err.cause && err.cause.message ? err.cause : err;
  const msg = cause && (cause.message || String(cause)) || String(err);
  return msg.split('\n').slice(0, n).map((l) => '       ' + l).join('\n');
}

/** Preferred path: node:test's run() API (Node >= 18.9) — one child process per file, structured events. */
function runWithApi(files) {
  return new Promise((resolveRun, rejectRun) => {
    const counts = { pass: 0, fail: 0, skip: 0 };
    const failures = [];
    let lastFile = null;
    const stream = nodeTest.run({ files, concurrency: Math.max(1, (cpus() || []).length - 1) });
    const header = (d) => {
      const f = d && d.file;
      if (f && f !== lastFile) { lastFile = f; process.stdout.write(relative(ROOT, f) + '\n'); }
    };
    const isSuite = (d) => !!(d && d.details && d.details.type === 'suite');
    stream.on('test:pass', (d) => {
      if (isSuite(d)) return;
      header(d);
      if (d.skip || d.todo) { counts.skip++; process.stdout.write('  skip ' + d.name + '\n'); return; }
      counts.pass++;
      process.stdout.write('  ok   ' + d.name + '\n');
    });
    stream.on('test:fail', (d) => {
      if (isSuite(d)) return;
      header(d);
      counts.fail++;
      const err = (d.details && d.details.error) || d.error;
      failures.push({ file: d.file, name: d.name, err });
      process.stdout.write('  FAIL ' + d.name + '\n' + firstLines(err) + '\n');
    });
    stream.on('test:stderr', (d) => process.stderr.write(d.message));
    stream.on('test:stdout', (d) => process.stdout.write(d.message));
    stream.on('error', rejectRun);
    stream.on('end', () => resolveRun({ counts, failures }));
    stream.resume();
  });
}

/** Fallback (Node < 18.9, no run()): import the files in-process; node:test reports and sets the exit code itself. */
async function runInProcess(files) {
  for (const f of files) await import(pathToFileURL(f).href);
  return null;
}

const files = discover();
if (!files.length) {
  console.error('tests/run.mjs: no *.test.mjs files found under tests/{unit,e2e}');
  process.exitCode = 1;
} else if (typeof nodeTest.run === 'function') {
  try {
    const { counts, failures } = await runWithApi(files);
    const total = counts.pass + counts.fail + counts.skip;
    console.log('\n' + counts.pass + ' passed, ' + counts.fail + ' failed' + (counts.skip ? ', ' + counts.skip + ' skipped' : '') +
      ' (' + total + ' tests, ' + files.length + ' files)');
    if (failures.length) {
      console.log('\nFailures:');
      for (const f of failures) console.log('  - ' + (f.file ? relative(ROOT, f.file) + ': ' : '') + f.name);
    }
    if (total === 0) { console.error('tests/run.mjs: zero tests executed — treating as failure'); process.exitCode = 1; }
    else process.exitCode = counts.fail ? 1 : 0;
  } catch (e) {
    console.error('tests/run.mjs: runner error:', e && e.stack || e);
    process.exitCode = 1;
  }
} else {
  console.log('node:test run() unavailable on ' + process.version + '; importing test files in-process (summary printed by node:test)');
  await runInProcess(files);
  // node:test sets process.exitCode = 1 on failures when files run directly; nothing more to do.
}

#!/usr/bin/env node
// Repo health check (run before every release and in CI):
//   1. `node --check` every .mjs under scripts/ and tests/  (syntax errors fail the run)
//   2. parse the JSON manifests and assert the three version fields agree
//      (.claude-plugin/plugin.json, .claude-plugin/marketplace.json plugins[0], scripts/package.json)
//   3. lint skills/*/SKILL.md frontmatter: starts with ---, has name + description, warns on
//      `Task` in allowed-tools (use Agent) and on bare `node scripts/` references
//      (skills should use "${CLAUDE_PLUGIN_ROOT}/scripts/…"). Warnings never fail the run.
//
// Usage: node scripts/check.mjs [--root <repo>] [--concurrency 8]
// Exit codes: 0 ok (warnings allowed) · 3 (EXIT.THRESHOLD) syntax/JSON errors or version mismatch · 2 runtime

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, isMain, runCli } from './lib/util.mjs';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'fixtures', 'snapshots']);

function walkMjs(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkMjs(p, out);
    else if (name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

function nodeCheck(file) {
  return new Promise((res) => {
    execFile(process.execPath, ['--check', file], { encoding: 'utf8' }, (err, _stdout, stderr) => {
      res({ file, ok: !err, error: err ? String(stderr || err.message).trim().split('\n').slice(0, 8).join('\n') : null });
    });
  });
}

async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i]); }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

function readJson(path) {
  try { return { value: JSON.parse(readFileSync(path, 'utf8')), error: null }; }
  catch (e) { return { value: null, error: String(e && e.message || e) }; }
}

/** Lint one SKILL.md; returns { name, warnings[] }. */
export function lintSkillMarkdown(text, { dirName = null } = {}) {
  const warnings = [];
  const lines = text.split(/\r?\n/);
  if ((lines[0] || '').trim() !== '---') {
    warnings.push('frontmatter must start on line 1 with ---');
    return { name: null, warnings };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { end = i; break; }
  if (end === -1) { warnings.push('frontmatter is not closed with ---'); return { name: null, warnings }; }

  const fm = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line); // top-level keys only (no indent)
    if (m) fm[m[1]] = m[2].trim();
  }
  if (!fm.name) warnings.push('frontmatter is missing `name`');
  if (!('description' in fm) || fm.description === '' && !lines.slice(1, end).some((l) => /^description:\s*[>|]/.test(l))) {
    if (!('description' in fm)) warnings.push('frontmatter is missing `description`');
  }
  if (fm.name && dirName && fm.name !== dirName) warnings.push('frontmatter name "' + fm.name + '" differs from directory "' + dirName + '"');
  const tools = fm['allowed-tools'] || '';
  if (/(^|[\s,(])Task([\s,)]|$)/.test(tools)) warnings.push('allowed-tools lists `Task` — the subagent tool is `Agent`');

  const body = lines.slice(end + 1);
  body.forEach((l, i) => {
    if (/(^|[^/\w$}])node\s+scripts\//.test(l)) {
      warnings.push('bare `node scripts/` reference at line ' + (end + 2 + i) + ' — use `node "${CLAUDE_PLUGIN_ROOT}/scripts/<x>.mjs"`');
    }
  });
  return { name: fm.name || null, warnings };
}

export async function main(args) {
  const root = args.root && typeof args.root === 'string' ? resolve(args.root) : DEFAULT_ROOT;
  const concurrency = Math.max(1, Number(args.concurrency) || 8);
  const rel = (p) => relative(root, p).split('\\').join('/');

  // 1. syntax
  const files = [...walkMjs(join(root, 'scripts')), ...walkMjs(join(root, 'tests'))];
  const checked = await pool(files, concurrency, nodeCheck);
  const syntaxErrors = checked.filter((c) => !c.ok).map((c) => ({ file: rel(c.file), error: c.error }));

  // 2. JSON manifests + version alignment
  const manifests = {
    plugin: join(root, '.claude-plugin', 'plugin.json'),
    marketplace: join(root, '.claude-plugin', 'marketplace.json'),
    package: join(root, 'scripts', 'package.json'),
  };
  const jsonErrors = [];
  const versions = {};
  for (const [key, path] of Object.entries(manifests)) {
    const { value, error } = readJson(path);
    if (error) { jsonErrors.push({ file: rel(path), error }); versions[key] = null; continue; }
    if (key === 'marketplace') {
      const entry = Array.isArray(value.plugins) ? value.plugins.find((p) => p && p.name === 'claude-seo-ai') || value.plugins[0] : null;
      versions[key] = entry && entry.version ? String(entry.version) : null;
    } else {
      versions[key] = value && value.version ? String(value.version) : null;
    }
  }
  for (const extra of [join(root, 'hooks', 'hooks.json'), ...(existsSync(join(root, 'schema')) ? readdirSync(join(root, 'schema')).filter((f) => f.endsWith('.json')).map((f) => join(root, 'schema', f)) : [])]) {
    if (!existsSync(extra)) continue;
    const { error } = readJson(extra);
    if (error) jsonErrors.push({ file: rel(extra), error });
  }
  const versionValues = Object.values(versions);
  const aligned = versionValues.every((v) => v) && new Set(versionValues).size === 1;

  // 3. skills lint (warnings only)
  const skillsDir = join(root, 'skills');
  const skillWarnings = [];
  let skillsChecked = 0;
  if (existsSync(skillsDir)) {
    for (const dir of readdirSync(skillsDir).sort()) {
      const md = join(skillsDir, dir, 'SKILL.md');
      if (!existsSync(md)) continue;
      skillsChecked++;
      const { warnings } = lintSkillMarkdown(readFileSync(md, 'utf8'), { dirName: dir });
      for (const w of warnings) skillWarnings.push({ skill: dir, message: w });
    }
  }

  const ok = syntaxErrors.length === 0 && jsonErrors.length === 0 && aligned;
  const result = {
    ok,
    root,
    syntax: { checked: files.length, errors: syntaxErrors },
    json: { checked: Object.keys(manifests).length, errors: jsonErrors },
    versions: { ...versions, aligned },
    skills: { checked: skillsChecked, warnings: skillWarnings },
    summary: (ok ? 'OK' : 'FAIL') + ': ' + files.length + ' files syntax-checked (' + syntaxErrors.length + ' errors), ' +
      jsonErrors.length + ' JSON errors, versions ' + (aligned ? 'aligned at ' + versionValues[0] : 'MISALIGNED ' + JSON.stringify(versions)) +
      ', ' + skillsChecked + ' skills linted (' + skillWarnings.length + ' warnings)',
  };
  return { result, code: ok ? EXIT.OK : EXIT.THRESHOLD };
}

if (isMain(import.meta.url)) runCli(main);

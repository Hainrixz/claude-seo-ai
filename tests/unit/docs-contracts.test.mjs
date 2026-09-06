// Contracts between the code and the prose that ships with it.
//
// Two things drift silently and are expensive when they do:
//   1. a finding id the checks emit that no skill or reference documents — a dispatched module agent
//      then meets an id it cannot explain, and the operator has nowhere to read what it means;
//   2. a disclaimer the code emits and a skill paraphrases — the machine line and the model's prose
//      then disagree in the same report.
// Both are asserted here against the real files, so a new id or an edited string fails the suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { knownIds } from '../../scripts/checks/index.mjs';
import { DISCLAIMER } from '../../scripts/probe-report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLS = join(ROOT, 'skills');
const REFERENCES = join(ROOT, 'references');

/** Every SKILL.md body, keyed by skill name. */
function skillDocs() {
  const out = new Map();
  for (const name of readdirSync(SKILLS).sort()) {
    const file = join(SKILLS, name, 'SKILL.md');
    if (existsSync(file)) out.set(name, readFileSync(file, 'utf8'));
  }
  return out;
}

/** references/*.md plus references/platforms/*.md. */
function referenceDocs() {
  const files = readdirSync(REFERENCES).filter((f) => f.endsWith('.md')).map((f) => join(REFERENCES, f));
  const platforms = join(REFERENCES, 'platforms');
  if (existsSync(platforms)) for (const f of readdirSync(platforms)) if (f.endsWith('.md')) files.push(join(platforms, f));
  return files.map((f) => [f, readFileSync(f, 'utf8')]);
}

test('every finding id the registry can emit is documented in a skill or a reference', () => {
  const ids = knownIds();
  assert.ok(ids.length > 100, 'expected the whole registry, got ' + ids.length);
  const corpus = [...skillDocs().values(), ...referenceDocs().map(([, body]) => body)].join('\n');
  const undocumented = ids.filter((id) => !corpus.includes(id));
  assert.deepEqual(undocumented, [], 'undocumented finding ids: ' + undocumented.join(', '));
});

test('the platform-conditional ids are indexed in references/routing.md and pointed at from their skills', () => {
  // They are deliberately absent from the per-module Findings tables (a WordPress id is noise on a
  // Shopify audit), so routing.md is their index and each skill carries a pointer to it.
  const routing = readFileSync(join(REFERENCES, 'routing.md'), 'utf8');
  const conditional = knownIds().filter((id) => /\.(shopify|wordpress|woocommerce|nextjs|nuxt|astro|sveltekit|gatsby|hugo|jekyll|react_router)\./.test(id));
  assert.ok(conditional.length >= 30, 'expected the platform-conditional set, got ' + conditional.length);
  const missing = conditional.filter((id) => !routing.includes(id));
  assert.deepEqual(missing, [], 'not indexed in routing.md: ' + missing.join(', '));

  const skills = skillDocs();
  const owners = {
    M1: 'seo-crawlability', M2: 'seo-indexability', M5: 'seo-schema-jsonld',
    M7: 'seo-meta-onpage', M17: 'seo-sitemaps', M20: 'seo-international',
  };
  for (const module of [...new Set(conditional.map((id) => id.split('.')[0]))]) {
    const skill = owners[module];
    assert.ok(skill, 'no skill owner recorded for ' + module);
    const body = skills.get(skill);
    assert.ok(body, 'missing skills/' + skill + '/SKILL.md');
    assert.match(body, /Platform-conditional ids/, skill + ' must point at the routing.md index');
    assert.match(body, /references\/routing\.md/, skill + ' must name where the index lives');
  }
});

test('the web-search probe disclaimer is one exported constant, quoted verbatim by the geo skill', () => {
  const geo = readFileSync(join(SKILLS, 'geo', 'SKILL.md'), 'utf8');
  assert.ok(DISCLAIMER.length > 80, 'the disclaimer must be the full sentence');
  assert.ok(geo.includes(DISCLAIMER), 'skills/geo/SKILL.md must quote DISCLAIMER verbatim, not paraphrase it');
  assert.match(geo, /`DISCLAIMER` in `scripts\/probe-report\.mjs`/, 'the skill must name the constant it is quoting');
  // No second copy of the claim anywhere else in the shipped prose.
  const copies = [...skillDocs().values(), ...referenceDocs().map(([, b]) => b)]
    .filter((body) => /NOT AI Overview, AI Mode, ChatGPT, or Perplexity citation data/.test(body));
  assert.equal(copies.length, 1, 'the disclaimer is quoted in exactly one document; found ' + copies.length);
});

test('the documented finding-id count matches what the registry exports', () => {
  const status = join(ROOT, 'docs', 'dev', 'v0.2.0-status.md');
  if (!existsSync(status)) return; // the dev status file is not part of the published plugin
  const body = readFileSync(status, 'utf8');
  const m = /knownIds\(\)`?\s*\((\d+) ids/.exec(body);
  assert.ok(m, 'the status file must state the id count');
  assert.equal(Number(m[1]), knownIds().length, 'docs/dev/v0.2.0-status.md states a stale id count');
});

#!/usr/bin/env node
// Compute the two never-blended scores (Search SEO + AI Visibility) from findings.
// Pure logic — fully reproducible. Implements references/scoring-model.md.
//
// Usage:
//   node score.mjs --findings findings.json
//   cat findings.json | node score.mjs
// Input: a JSON array of findings, or { "findings": [...] }, each conforming to
// schema/finding.schema.json.

import { readFileSync } from 'node:fs';
import { parseArgs, emit } from './lib/util.mjs';

const SEARCH = [
  { name: 'Indexability & Crawl', weight: 22, modules: ['M1', 'M2', 'M3'] },
  { name: 'Core Web Vitals / Performance', weight: 16, modules: ['M15'] },
  { name: 'On-Page & Meta', weight: 12, modules: ['M7'] },
  { name: 'Structured Data', weight: 12, modules: ['M5'] },
  { name: 'Rendering', weight: 8, modules: ['M4'] },
  { name: 'Internal Linking & Semantics', weight: 8, modules: ['M10'] },
  { name: 'E-E-A-T', weight: 7, modules: ['M16'] },
  { name: 'Images / Media', weight: 5, modules: ['M9'] },
  { name: 'Sitemaps & Discovery', weight: 5, modules: ['M17'] },
  { name: 'Freshness', weight: 3, modules: ['M13'] },
  { name: 'Social Cards', weight: 2, modules: ['M8'] },
  { name: 'E-commerce', weight: 15, modules: ['M18'], conditional: true },
  { name: 'Local', weight: 10, modules: ['M19'], conditional: true },
  { name: 'International', weight: 8, modules: ['M20'], conditional: true },
];

const AI = [
  { name: 'Answer Extractability', weight: 20, modules: ['M11'] },
  { name: 'Structured Data', weight: 16, modules: ['M5'] },
  { name: 'Fact Density / Original Data', weight: 14, modules: ['M12'] },
  { name: 'AI Crawler Access', weight: 12, modules: ['M14'] },
  { name: 'Rendering (non-JS)', weight: 10, modules: ['M4'] },
  { name: 'Entity / Knowledge-Graph', weight: 10, modules: ['M6'] },
  { name: 'E-E-A-T / Authority', weight: 9, modules: ['M16'] },
  { name: 'Freshness', weight: 6, modules: ['M13'] },
  { name: 'Images / Multimodal', weight: 3, modules: ['M9'] },
  { name: 'llms.txt', weight: 0, modules: ['M21'] },
];

const STATUS_FACTOR = { pass: 1, warn: 0.5, fail: 0 };

// 'M7b' -> 'M7', 'M21' -> 'M21', 'M3' -> 'M3'
const parentModule = (m) => String(m || '').replace(/[a-z]$/, '');

function axisMatches(finding, axis) {
  const a = finding && finding.expected_impact && finding.expected_impact.axis;
  return a === axis || a === 'both';
}

function categoryValue(findings) {
  let num = 0, den = 0, scored = 0, needsApi = 0;
  for (const f of findings) {
    const status = f.status;
    if (status === 'needs_api') { needsApi++; continue; }
    if (status === 'not_applicable') continue;
    const sev = Number(f.severity) || 0;
    const factor = STATUS_FACTOR[status];
    if (factor === undefined || sev <= 0) continue;
    num += factor * sev;
    den += sev;
    scored++;
  }
  return { value: den > 0 ? +(100 * num / den).toFixed(1) : null, scored, needsApi };
}

function band(v) {
  if (v >= 90) return 'A';
  if (v >= 80) return 'B';
  if (v >= 70) return 'C';
  if (v >= 60) return 'D';
  return 'F';
}

function computeScore(categories, findings, axis) {
  const inAxis = findings.filter((f) => axisMatches(f, axis));
  const cats = [];
  for (const c of categories) {
    const fs = inAxis.filter((f) => c.modules.includes(parentModule(f.module)));
    const { value, scored, needsApi } = categoryValue(fs);
    const active = scored > 0;
    cats.push({ name: c.name, weight: c.weight, value: value == null ? 0 : value, active, scored, needsApi, conditional: !!c.conditional });
  }
  const active = cats.filter((c) => c.active && c.weight > 0);
  const totalW = active.reduce((s, c) => s + c.weight, 0);
  let value = totalW > 0 ? active.reduce((s, c) => s + c.value * c.weight, 0) / totalW : 0;
  value = +value.toFixed(1);

  // Severity gating: any severity-5 FAIL in this axis caps the score at 40.
  const gated = inAxis.some((f) => Number(f.severity) === 5 && f.status === 'fail');
  let capped = false;
  if (gated && value > 40) { value = 40; capped = true; }

  const needsApiTotal = cats.reduce((s, c) => s + c.needsApi, 0);
  return {
    value, band: band(value), capped,
    needs_api_count: needsApiTotal,
    categories: cats.map(({ name, weight, value, active }) => ({ name, weight, value, active })),
  };
}

function interpret(search, ai) {
  const hi = (s) => s.value >= 75, lo = (s) => s.value < 60;
  if (hi(search) && lo(ai)) return ['Ranks well, hard to cite by AI engines.', 'Weak classic ranking despite content.'];
  if (lo(search) && hi(ai)) return ['Foundational SEO issues to fix first.', 'Citable by AI, but weak classic ranking.'];
  if (lo(search) && lo(ai)) return ['Foundational issues — fix indexability and structure first.', 'Foundational issues — add structure, schema, and answer blocks.'];
  if (hi(search) && hi(ai)) return ['Strong classic SEO; pursue depth and authority.', 'Strong AI visibility; keep content fresh and original.'];
  return ['Mixed — see the prioritized actions.', 'Mixed — see the prioritized actions.'];
}

function main() {
  const args = parseArgs();
  let raw;
  try {
    raw = args.findings ? readFileSync(args.findings, 'utf8') : readFileSync(0, 'utf8');
  } catch (e) {
    emit({ error: 'could not read findings: ' + String(e && e.message || e), hint: 'pass --findings <file.json> or pipe JSON on stdin' }, 1);
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { emit({ error: 'invalid JSON: ' + String(e && e.message || e) }, 1); }
  const findings = Array.isArray(parsed) ? parsed : ((parsed && parsed.findings) || []);

  const search = computeScore(SEARCH, findings, 'search');
  const ai = computeScore(AI, findings, 'ai');
  const [si, ai2] = interpret(search, ai);
  search.interpretation = si;
  ai.interpretation = ai2;

  emit({ findings_count: findings.length, search_seo: search, ai_visibility: ai });
}

main();

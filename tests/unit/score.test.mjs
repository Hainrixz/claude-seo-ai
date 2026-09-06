// Unit tests for scripts/score.mjs (plan 4e weights, 4f calibration, 4i integrity, 2d site rollup)
// plus the scorer-adjacent libs scripts/lib/bands.mjs and scripts/lib/finding.mjs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX = join(ROOT, 'tests', 'fixtures');
const SCRIPT = join(ROOT, 'scripts', 'score.mjs');
const lib = (name) => import(pathToFileURL(join(ROOT, 'scripts', 'lib', name)).href);
const score = await import(pathToFileURL(SCRIPT).href);
const { scoreFindings, scoreSite, interpret, interpretKeys, message, SEARCH, AI, INTERPRETATIONS, INTERPRETATIONS_ES, ROLE_WEIGHTS, VERTICALS, ENVIRONMENTS } = score;
const { validate } = await lib('schema-lite.mjs');
const bands = await lib('bands.mjs');
const finding = await lib('finding.mjs');
const REPORT = JSON.parse(readFileSync(join(ROOT, 'schema', 'audit-report.schema.json'), 'utf8'));
const load = (n) => JSON.parse(readFileSync(join(FIX, n), 'utf8'));

/** Minimal valid synthetic finding; `module` derived from the id prefix. */
function F(id, over = {}) {
  const module = /^(M[0-9]{1,2}[a-z]?)\./.exec(id)[1];
  return {
    id, module, title: 'Synthetic ' + id, status: 'pass', severity: 3, scope: 'page',
    evidence: { observed: 'synthetic' }, expected: 'expected', recommendation: 'none', fixable: 'advisory',
    verification: { method: 'dom_assert', assertion: 'a', reproduce: 'true' },
    expected_impact: { axis: 'search', confidence: 'directional', magnitude: 'medium', rationale: 'synthetic' },
    ...over,
  };
}
const imp = (axis, confidence = 'directional') => ({ axis, confidence, magnitude: 'medium', rationale: 'synthetic' });
const cat = (axis, name) => axis.categories.find((c) => c.name === name);
const sumW = (table) => table.filter((c) => !c.conditional).reduce((s, c) => s + c.weight, 0);
function validAxis(axis) {
  const r = validate({ $ref: '#/$defs/score' }, axis, { root: REPORT });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
}
function cli(args, input = '') {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', input });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* keep null */ }
  return { status: r.status, json, stdout: r.stdout };
}

describe('weight tables (plan 4e)', () => {
  it('AI always-on weights sum to 100 with the re-normalized values', () => {
    assert.equal(sumW(AI), 100);
    const w = Object.fromEntries(AI.map((c) => [c.modules[0], c.weight]));
    assert.deepEqual({ M11: w.M11, M14: w.M14, M12: w.M12, M5: w.M5, M4: w.M4, M6: w.M6, M16: w.M16, M13: w.M13, M22: w.M22, M9: w.M9, M21: w.M21 },
      { M11: 18, M14: 14, M12: 14, M5: 12, M4: 10, M6: 9, M16: 9, M13: 6, M22: 4, M9: 4, M21: 0 });
  });
  it('AI table names M22 "Agent-readiness" and M21 "AI discovery & agent endpoints"', () => {
    assert.equal(AI.find((c) => c.modules.includes('M22')).name, 'Agent-readiness');
    assert.equal(AI.find((c) => c.modules.includes('M21')).name, 'AI discovery & agent endpoints');
    assert.equal(AI.some((c) => c.name === 'llms.txt'), false);
  });
  it('AI table has the conditional M18 (6) and M19 (5) rows', () => {
    const m18 = AI.find((c) => c.modules.includes('M18')), m19 = AI.find((c) => c.modules.includes('M19'));
    assert.deepEqual([m18.name, m18.weight, m18.conditional, m18.activation], ['Agentic commerce readiness', 6, true, 'vertical:ecommerce']);
    assert.deepEqual([m19.name, m19.weight, m19.conditional, m19.activation], ['Local / place data', 5, true, 'vertical:local-business']);
  });
  it('Search weights are unchanged (always-on 100; conditional 15/10/8)', () => {
    assert.equal(sumW(SEARCH), 100);
    assert.deepEqual(SEARCH.filter((c) => c.conditional).map((c) => [c.name, c.weight, c.activation]),
      [['E-commerce', 15, 'vertical:ecommerce'], ['Local', 10, 'vertical:local-business'], ['International', 8, 'flag:multilingual']]);
    assert.equal(SEARCH[0].weight, 22);
  });
});

describe('legacy fixture after severity recalibration (plan 4f)', () => {
  const fx = load('sample-findings.json');
  const r = scoreFindings(fx);
  it('M11.heading.no_direct_answer is severity 3 in the fixture', () => {
    assert.equal(fx.find((f) => f.id === 'M11.heading.no_direct_answer').severity, 3);
  });
  it('search 56.4 F, ai 29.2 F — neither capped (both provisional: a 7-finding fixture measures under half of each axis)', () => {
    assert.deepEqual([r.search_seo.value, r.search_seo.band, r.search_seo.capped, r.search_seo.state], [56.4, 'F', false, 'partial']);
    assert.deepEqual([r.ai_visibility.value, r.ai_visibility.band, r.ai_visibility.capped, r.ai_visibility.state], [29.2, 'F', false, 'partial']);
    assert.deepEqual([r.search_seo.coverage, r.search_seo.provisional], [39, true]);
    assert.deepEqual([r.ai_visibility.coverage, r.ai_visibility.provisional], [48, true]);
    assert.equal(r.search_seo.raw_value, r.search_seo.value);
    assert.deepEqual(r.ai_visibility.cap_reasons, []);
  });
  it('legacy counters: needs_api 1 on search, 0 on ai; findings_count 7', () => {
    assert.equal(r.findings_count, 7);
    assert.equal(r.search_seo.needs_api_count, 1);
    assert.equal(r.ai_visibility.needs_api_count, 0);
    assert.equal(r.dropped_count, 0);
  });
  it('M21 category is reported at weight 0 and carries no active_weight', () => {
    const c = cat(r.ai_visibility, 'AI discovery & agent endpoints');
    assert.deepEqual([c.weight, c.active_weight, c.active, c.scored, c.modules], [0, 0, true, 1, ['M21']]);
  });
  it('unscored_count: the needs_api finding (search) and the weight-0 M21 finding (ai)', () => {
    assert.equal(r.search_seo.unscored_count, 1);
    assert.equal(r.ai_visibility.unscored_count, 1);
  });
  it('active_weight shares sum to 100 on each axis', () => {
    for (const axis of [r.search_seo, r.ai_visibility]) {
      const sum = axis.categories.reduce((s, c) => s + c.active_weight, 0);
      assert.ok(Math.abs(sum - 100) < 0.2, 'sum ' + sum);
    }
  });
});

describe('severity gating (sev 5 + fail + established + active weighted category)', () => {
  const gated = load('findings-gated.json');
  it('an established sev-5 FAIL in M2 caps search at 40 and reports raw_value + cap_reasons', () => {
    const r = scoreFindings(gated);
    const s = r.search_seo;
    assert.deepEqual([s.value, s.raw_value, s.band, s.state, s.capped], [40, 71.8, 'F', 'capped', true]);
    assert.equal(s.cap_reasons.length, 1);
    assert.deepEqual(s.cap_reasons[0], { id: 'M2.robots.noindex_sitewide', module: 'M2', category: 'Indexability & Crawl', severity: 5, status: 'fail', confidence: 'established', scope: 'site' });
    assert.deepEqual(s.suppressed_caps, []);
  });
  it('a directional sev-5 FAIL (M11) and a weight-0 sev-5 FAIL (M21) never cap the AI axis', () => {
    const a = scoreFindings(gated).ai_visibility;
    assert.deepEqual([a.value, a.raw_value, a.band, a.state, a.capped, a.cap_reasons], [60.9, 60.9, 'D', 'partial', false, []]);
  });
  it('a speculative sev-5 FAIL does not cap', () => {
    const r = scoreFindings([F('M2.robots.noindex_sitewide', { status: 'fail', severity: 5, scope: 'site', expected_impact: imp('search', 'speculative') })]);
    assert.deepEqual([r.search_seo.value, r.search_seo.capped, r.search_seo.state, r.search_seo.cap_reasons], [0, false, 'partial', []]);
  });
  it('a sev-5 established FAIL in an inactive conditional category does not cap', () => {
    const r = scoreFindings([
      F('M18.offer.missing_price', { status: 'fail', severity: 5, scope: 'template', expected_impact: imp('both', 'established') }),
      F('M1.robots.ok', { severity: 5, scope: 'site', expected_impact: imp('search', 'established') }),
    ], { vertical: 'saas' });
    assert.deepEqual([r.search_seo.value, r.search_seo.capped], [100, false]);
    assert.equal(r.ignored_conditional.length, 2);
    assert.equal(r.ignored_conditional[0].id, 'M18.offer.missing_price');
  });
  it('the gate is reported (capped:true, state capped) even when raw_value is already <= 40', () => {
    const r = scoreFindings([F('M2.robots.noindex_sitewide', { status: 'fail', severity: 5, scope: 'site', expected_impact: imp('search', 'established') })]);
    assert.deepEqual([r.search_seo.value, r.search_seo.raw_value, r.search_seo.capped, r.search_seo.state], [0, 0, true, 'capped']);
  });
});

describe('coverage floor and the provisional band', () => {
  // Always-on search weights: M1/M2/M3 22 · M15 16 · M7 12 · M5 12 · M4 8 · M10 8 · M16 7 · M9 5 · M17 5 · M13 3 · M8 2.
  const wide = () => ([
    F('M1.robots.ok', { expected_impact: imp('search', 'established') }),          // 22
    F('M15.lcp.ok', { module: 'M15', expected_impact: imp('search') }),            // 16
    F('M7.title.ok', { expected_impact: imp('search') }),                          // 12
    F('M5.product.ok', { expected_impact: imp('search') }),                        // 12
  ]);

  it('an axis that measured 62 of 100 always-on weight is scored, not provisional, and warns about nothing', () => {
    const s = scoreFindings(wide()).search_seo;
    assert.deepEqual([s.state, s.provisional, s.coverage, s.coverage_weight, s.coverage_total], ['scored', false, 62, 62, 100]);
    assert.ok(!s.warnings.some((w) => /^coverage /.test(w)), JSON.stringify(s.warnings));
  });

  it('an axis built from one category keeps its exact value and band but says only 22% was measured', () => {
    const s = scoreFindings([F('M1.robots.ok', { expected_impact: imp('search', 'established') })]).search_seo;
    assert.deepEqual([s.value, s.raw_value, s.band], [100, 100, 'A'], 'the numbers are never hidden or discounted');
    assert.deepEqual([s.state, s.provisional, s.coverage, s.coverage_weight], ['partial', true, 22, 22]);
    const w = s.warnings.find((x) => /^coverage /.test(x));
    assert.match(w, /only 22 of 100 always-on weight on the search axis/);
    assert.match(w, /provisional/);
    assert.match(w, /Core Web Vitals/, 'the warning names what was not measured');
    validAxis(s);
  });

  it('conditional weight is outside the denominator: declaring a vertical does not inflate coverage', () => {
    const fs = [F('M1.robots.ok', { expected_impact: imp('search', 'established') }), F('M18.offer.missing_price', { status: 'fail', expected_impact: imp('search') })];
    const plain = scoreFindings(fs, { vertical: 'saas' }).search_seo;
    const store = scoreFindings(fs, { vertical: 'ecommerce' }).search_seo;
    assert.equal(plain.coverage, 22);
    assert.equal(store.coverage, 22, 'E-commerce is conditional weight; it cannot raise how much of the always-on model was measured');
    assert.ok(store.categories.find((c) => c.name === 'E-commerce').active, 'the conditional category is still scored');
  });

  it('a capped axis keeps state "capped" (the stronger fact) and still reports the coverage caveat', () => {
    const s = scoreFindings([F('M2.robots.noindex_sitewide', { status: 'fail', severity: 5, scope: 'site', expected_impact: imp('search', 'established') })]).search_seo;
    assert.deepEqual([s.state, s.capped, s.provisional], ['capped', true, true]);
    assert.ok(s.warnings.some((w) => /^coverage /.test(w)));
  });

  it('an unscored axis is never provisional — there is nothing to qualify', () => {
    const a = scoreFindings([F('M1.robots.ok', { expected_impact: imp('search') })]).ai_visibility;
    assert.deepEqual([a.value, a.band, a.state, a.provisional, a.coverage], [null, 'unscored', 'unscored', false, 0]);
    assert.ok(!a.warnings.some((w) => /^coverage /.test(w)));
  });

  it('the site rollup carries the same coverage keys', () => {
    const manifest = { pages: [{ url: 'https://example.test/', role: 'homepage' }, { url: 'https://example.test/b', role: 'target' }] };
    const r = scoreSite(manifest, { findings: [F('M1.robots.ok', { scope: 'site', expected_impact: imp('search', 'established') })] });
    assert.deepEqual([r.search_seo.state, r.search_seo.provisional, r.search_seo.coverage], ['partial', true, 22]);
    validAxis(r.search_seo);
  });
});

describe('environment suppression of noindex/robots caps', () => {
  const gated = load('findings-gated.json');
  for (const env of ['preview', 'staging', 'local']) {
    it(`--environment ${env} suppresses the M2 noindex cap and warns`, () => {
      const s = scoreFindings(gated, { environment: env }).search_seo;
      assert.deepEqual([s.value, s.band, s.capped, s.state, s.cap_reasons], [71.8, 'C', false, 'partial', []]);
      assert.equal(s.suppressed_caps.length, 1);
      assert.equal(s.suppressed_caps[0].id, 'M2.robots.noindex_sitewide');
      assert.equal(s.suppressed_caps[0].environment, env);
      assert.ok(s.warnings.some((w) => /suppressed/.test(w) && w.includes(env)), JSON.stringify(s.warnings));
    });
  }
  it('production (default) never suppresses', () => {
    assert.equal(scoreFindings(gated, { environment: 'production' }).search_seo.capped, true);
    assert.equal(scoreFindings(gated).activation.environment, 'production');
  });
  it('M1.robots.* and M14.ai_eligibility.not_indexable are suppressed on staging; other sev-5 ids still cap', () => {
    const fs = [
      F('M1.robots.blocks_googlebot', { status: 'fail', severity: 5, scope: 'site', expected_impact: imp('search', 'established') }),
      F('M14.ai_eligibility.not_indexable', { status: 'fail', severity: 5, scope: 'site', expected_impact: imp('ai', 'established') }),
      F('M4.render.csr_only_shell', { status: 'fail', severity: 5, scope: 'template', expected_impact: imp('search', 'established') }),
      F('M7.title.ok', { severity: 3, expected_impact: imp('search', 'established') }),
      F('M12.facts.ok', { severity: 3, expected_impact: imp('ai') }),
    ];
    const r = scoreFindings(fs, { environment: 'staging' });
    assert.equal(r.search_seo.suppressed_caps.map((c) => c.id).join(), 'M1.robots.blocks_googlebot');
    assert.equal(r.search_seo.cap_reasons.map((c) => c.id).join(), 'M4.render.csr_only_shell');
    assert.equal(r.search_seo.capped, true);
    assert.equal(r.ai_visibility.suppressed_caps.map((c) => c.id).join(), 'M14.ai_eligibility.not_indexable');
    assert.equal(r.ai_visibility.capped, false);
  });
  it('an unknown environment falls back to production with a warning', () => {
    const r = scoreFindings(gated, { environment: 'nope' });
    assert.equal(r.search_seo.capped, true);
    assert.ok(r.warnings.some((w) => /unknown environment/.test(w)));
  });
});

describe('unscored state', () => {
  it('an empty findings set is unscored on both axes (value null, band unscored), never F', () => {
    const r = scoreFindings(load('findings-empty.json'));
    for (const axis of [r.search_seo, r.ai_visibility]) {
      assert.deepEqual([axis.value, axis.raw_value, axis.band, axis.state, axis.capped], [null, null, 'unscored', 'unscored', false]);
      assert.ok(axis.categories.every((c) => c.active === false && c.active_weight === 0));
    }
    assert.equal(r.findings_count, 0);
    assert.equal(r.search_seo.interpretation, INTERPRETATIONS.unscored.search);
    assert.equal(r.ai_visibility.interpretation, INTERPRETATIONS.unscored.ai);
  });
  it('search-only findings leave the AI axis unscored and interpret the scored axis on its own', () => {
    const r = scoreFindings(load('findings-search-only.json'));
    assert.deepEqual([r.search_seo.value, r.search_seo.band], [82.4, 'B']);
    assert.deepEqual([r.ai_visibility.value, r.ai_visibility.band, r.ai_visibility.state], [null, 'unscored', 'unscored']);
    assert.equal(r.search_seo.interpretation, INTERPRETATIONS.both_high.search);
    assert.equal(r.ai_visibility.interpretation, INTERPRETATIONS.unscored.ai);
  });
  it('a set made only of needs_api findings is unscored with the count reported', () => {
    const r = scoreFindings([F('M15.lcp.field', { status: 'needs_api', severity: 4 })]);
    assert.deepEqual([r.search_seo.value, r.search_seo.state, r.search_seo.needs_api_count], [null, 'unscored', 1]);
  });
});

describe('validation: dropped and unmapped findings', () => {
  const inv = load('findings-invalid.json');
  it('drops the 3 invalid findings, lists them with index/id/errors and scores the valid one', () => {
    const r = scoreFindings(inv);
    assert.equal(r.findings_count, 4);
    assert.equal(r.dropped_count, 3);
    assert.deepEqual(r.dropped_findings.map((d) => [d.index, d.id]), [[0, 'M5.product.missing_offer'], [1, 'M9.alt.missing'], [2, 'X1.not.a.module']]);
    assert.ok(r.dropped_findings[0].errors.some((e) => /"evidence"/.test(e)));
    assert.ok(r.dropped_findings[0].errors.some((e) => /"verification"/.test(e)));
    assert.ok(r.dropped_findings[1].errors.some((e) => /^status: /.test(e)));
    assert.ok(r.dropped_findings[1].errors.some((e) => /^severity: expected integer/.test(e)));
    assert.ok(r.dropped_findings[2].errors.some((e) => /^id: does not match/.test(e)));
    assert.ok(r.dropped_findings[2].errors.some((e) => /unexpected property "page"/.test(e)));
    assert.equal(cat(r.search_seo, 'Structured Data').active, true);
    assert.equal(r.search_seo.dropped_count, 3);
    assert.equal(r.ai_visibility.dropped_count, 3);
    assert.ok(r.warnings.some((w) => /dropped/.test(w)));
  });
  it('a finding whose module has no category on its axis is reported as unmapped, not silently scored', () => {
    const r = scoreFindings([F('M99.foo.bar')]);
    assert.equal(r.unmapped_findings.length, 1);
    assert.deepEqual(r.unmapped_findings[0], { index: 0, id: 'M99.foo.bar', module: 'M99', axis: 'search' });
    assert.equal(r.search_seo.state, 'unscored');
    assert.equal(r.search_seo.unscored_count, 1);
    assert.ok(r.warnings.some((w) => /no category/.test(w)));
  });
  it('a module that exists only on one axis (M15 on ai) is unmapped for that axis', () => {
    const r = scoreFindings([F('M15.lcp.ok', { expected_impact: imp('both', 'established') })]);
    assert.equal(r.unmapped_findings.map((u) => u.axis).join(), 'ai');
    assert.equal(cat(r.search_seo, 'Core Web Vitals / Performance').active, true);
  });
  it('validate:false skips schema validation', () => {
    const f = F('M1.robots.ok'); delete f.evidence;
    assert.equal(scoreFindings([f]).dropped_count, 1);
    assert.equal(scoreFindings([f], { validate: false }).dropped_count, 0);
  });
});

describe('statuses excluded from the score', () => {
  it('manual_review is excluded like needs_api and counted', () => {
    const r = scoreFindings([
      F('M11.answer.language_unknown', { status: 'manual_review', severity: 4, expected_impact: imp('ai') }),
      F('M11.answer.ok', { severity: 3, expected_impact: imp('ai') }),
    ]);
    const a = r.ai_visibility;
    assert.deepEqual([a.value, a.band, a.manual_review_count, a.unscored_count, a.needs_api_count], [100, 'A', 1, 1, 0]);
    assert.equal(cat(a, 'Answer Extractability').manual_review, 1);
    assert.equal(cat(a, 'Answer Extractability').scored, 1);
  });
  it('severity 0 findings are informational: never scored, never activate a category', () => {
    const r = scoreFindings([F('M14.probe.web_presence', { severity: 0, status: 'pass', expected_impact: imp('ai', 'speculative') })]);
    assert.equal(cat(r.ai_visibility, 'AI Crawler Access').active, false);
    assert.deepEqual([r.ai_visibility.state, r.ai_visibility.unscored_count], ['unscored', 1]);
  });
  it('not_applicable is excluded from numerator and denominator', () => {
    const r = scoreFindings([F('M7.title.ok'), F('M7.desc.na', { status: 'not_applicable', severity: 0 })]);
    assert.deepEqual([r.search_seo.value, cat(r.search_seo, 'On-Page & Meta').scored], [100, 1]);
  });
});

describe('interpretation pairing (corrected)', () => {
  it('high search / low AI', () => {
    const t = interpret({ value: 90 }, { value: 30 });
    assert.deepEqual(t, { search: 'Ranks well; classic fundamentals are strong.', ai: 'Hard to cite by AI engines — add extractable structure and verify AI eligibility.' });
  });
  it('low search / high AI', () => {
    const t = interpret({ value: 30 }, { value: 90 });
    assert.deepEqual(t, { search: 'Foundational SEO issues to fix first.', ai: 'Citable by AI, but weak classic ranking limits reach.' });
  });
  it('both low, both high, mixed', () => {
    assert.deepEqual(interpret({ value: 10 }, { value: 59.9 }), { search: 'Foundational issues — fix indexability and structure first.', ai: 'Foundational issues — add structure, schema, and answer blocks.' });
    assert.deepEqual(interpret({ value: 75 }, { value: 100 }), { search: 'Strong classic SEO; pursue depth and authority.', ai: 'Strong AI visibility; keep content fresh and original.' });
    assert.deepEqual(interpret({ value: 70 }, { value: 70 }), INTERPRETATIONS.mixed);
    assert.deepEqual(interpret({ value: 90 }, { value: 65 }), INTERPRETATIONS.mixed);
  });
  it('an unscored axis gets the unscored sentence; the other axis is read alone', () => {
    assert.deepEqual(interpret({ value: null }, { value: 90 }), { search: INTERPRETATIONS.unscored.search, ai: INTERPRETATIONS.both_high.ai });
    assert.deepEqual(interpret({ value: 20 }, { value: null }), { search: INTERPRETATIONS.both_low.search, ai: INTERPRETATIONS.unscored.ai });
    assert.deepEqual(interpret({ value: 65 }, { value: null }), { search: INTERPRETATIONS.mixed.search, ai: INTERPRETATIONS.unscored.ai });
  });
  it('end to end: each axis carries its own sentence', () => {
    const hiLo = scoreFindings([F('M1.robots.ok', { severity: 5, scope: 'site', expected_impact: imp('search', 'established') }), F('M11.heading.no_direct_answer', { status: 'fail', expected_impact: imp('ai') })]);
    assert.equal(hiLo.search_seo.interpretation, 'Ranks well; classic fundamentals are strong.');
    assert.equal(hiLo.ai_visibility.interpretation, 'Hard to cite by AI engines — add extractable structure and verify AI eligibility.');
    const loHi = scoreFindings([F('M1.robots.blocked', { status: 'fail', severity: 5, scope: 'site', expected_impact: imp('search') }), F('M11.answer.ok', { expected_impact: imp('ai') })]);
    assert.equal(loHi.search_seo.interpretation, 'Foundational SEO issues to fix first.');
    assert.equal(loHi.ai_visibility.interpretation, 'Citable by AI, but weak classic ranking limits reach.');
  });
});

describe('conditional activation', () => {
  const m18 = () => F('M18.offer.ok', { scope: 'template', expected_impact: imp('both', 'established') });
  const m1 = () => F('M1.robots.ok', { severity: 5, scope: 'site', expected_impact: imp('search', 'established') });
  it('declared --vertical ecommerce activates M18 on both axes without inference warnings', () => {
    const r = scoreFindings([m18(), m1()], { vertical: 'ecommerce' });
    assert.deepEqual([cat(r.search_seo, 'E-commerce').active, cat(r.search_seo, 'E-commerce').activation], [true, 'vertical:ecommerce']);
    assert.deepEqual([cat(r.ai_visibility, 'Agentic commerce readiness').active, cat(r.ai_visibility, 'Agentic commerce readiness').activation], [true, 'vertical:ecommerce']);
    assert.deepEqual([r.search_seo.value, r.ai_visibility.value], [100, 100]);
    assert.equal(r.activation.source, 'declared');
    assert.deepEqual(r.activation.vertical, { primary: 'ecommerce', also: [], multilingual: false });
    assert.deepEqual(r.ignored_conditional, []);
    assert.ok(!r.warnings.some((w) => /inference/.test(w)));
  });
  it('a comma list activates several verticals', () => {
    const r = scoreFindings([m18(), F('M19.localbusiness.ok', { expected_impact: imp('both', 'established') })], { vertical: 'ecommerce,local-business' });
    assert.equal(cat(r.search_seo, 'Local').activation, 'vertical:local-business');
    assert.equal(cat(r.ai_visibility, 'Local / place data').active, true);
    assert.deepEqual(r.activation.vertical.also, ['local-business']);
  });
  it('declared saas ignores M18 findings (inactive) and lists them', () => {
    const r = scoreFindings([m18(), m1()], { vertical: 'saas' });
    assert.deepEqual([cat(r.search_seo, 'E-commerce').active, cat(r.search_seo, 'E-commerce').activation], [false, 'inactive']);
    assert.equal(r.ignored_conditional.length, 2);
    assert.deepEqual(r.ignored_conditional.map((i) => i.axis), ['search', 'ai']);
    assert.equal(r.search_seo.value, 100);
    assert.equal(r.ai_visibility.state, 'unscored');
    assert.equal(r.search_seo.unscored_count, 1);
  });
  it('without flags, activation is inferred from findings and flagged', () => {
    const r = scoreFindings([m18(), m1()]);
    assert.deepEqual([cat(r.search_seo, 'E-commerce').active, cat(r.search_seo, 'E-commerce').activation], [true, 'vertical:ecommerce']);
    assert.equal(r.activation.source, 'inferred');
    assert.ok(r.activation.inferred_categories.includes('E-commerce'));
    assert.ok(r.search_seo.warnings.some((w) => /activated by inference/.test(w)));
  });
  it('a declared vertical with no findings warns and stays inactive', () => {
    const r = scoreFindings([m1()], { vertical: 'ecommerce' });
    const c = cat(r.search_seo, 'E-commerce');
    assert.deepEqual([c.active, c.activation], [false, 'vertical:ecommerce']);
    assert.ok(r.search_seo.warnings.some((w) => /declared active/.test(w)));
  });
  it('--multilingual activates International; declared mode without it deactivates M20', () => {
    const m20 = F('M20.hreflang.missing_xdefault', { status: 'warn', severity: 2, expected_impact: imp('search', 'established') });
    const on = scoreFindings([m20], { multilingual: true });
    assert.deepEqual([cat(on.search_seo, 'International').activation, on.search_seo.value], ['flag:multilingual', 50]);
    const off = scoreFindings([m20], { vertical: 'saas' });
    assert.deepEqual([cat(off.search_seo, 'International').activation, off.search_seo.state, off.ignored_conditional.length], ['inactive', 'unscored', 1]);
    assert.equal(scoreFindings([m20], { multilingual: false }).ignored_conditional.length, 1);
    assert.equal(scoreFindings([m20]).activation.source, 'inferred');
  });
  it('--vertical-json accepts the detect output object or a legacy string', () => {
    const fs = [m18(), F('M19.localbusiness.ok', { expected_impact: imp('both') }), F('M20.hreflang.ok', { expected_impact: imp('search') })];
    const r = scoreFindings(fs, { verticalJson: { primary: 'ecommerce', also: ['local-business'], multilingual: true, signals: { cart: true } } });
    assert.deepEqual(r.activation.vertical, { primary: 'ecommerce', also: ['local-business'], multilingual: true });
    assert.deepEqual(['E-commerce', 'Local', 'International'].map((n) => cat(r.search_seo, n).active), [true, true, true]);
    assert.equal(cat(scoreFindings(fs, { verticalJson: 'local-business' }).search_seo, 'Local').active, true);
    assert.equal(cat(scoreFindings(fs, { verticalJson: 'local-business' }).search_seo, 'E-commerce').activation, 'inactive');
  });
  it('unknown vertical names are warned about and ignored', () => {
    const r = scoreFindings([m1()], { vertical: 'shoes' });
    assert.ok(r.warnings.some((w) => /unknown vertical "shoes"/.test(w)));
    assert.equal(r.activation.source, 'declared');
  });
});

describe('site rollup (scoreSite)', () => {
  const manifest = load('crawl-manifest-sample.json');
  const r = scoreSite(manifest);
  it('weights pages by role: homepage 3, target 2, first template sample 2, long-tail 1', () => {
    assert.equal(r.pages_count, 5);
    assert.deepEqual(r.pages.map((p) => p.role), ['homepage', 'target', 'template-sample', 'template-sample', 'long-tail']);
    assert.deepEqual(r.pages.map((p) => p.weight), [3, 2, 2, 2, 1]);
    assert.ok(r.pages.every((p) => p.weight_source === 'role'));
    assert.equal(r.method, 'role_weights');
    assert.deepEqual(r.weights, { ...ROLE_WEIGHTS });
  });
  it('assigns page, template and site findings (deduped) to each page', () => {
    assert.deepEqual(r.pages.map((p) => p.findings_count), [3, 3, 4, 3, 4]);
    assert.equal(r.unassigned_count, 1);
    assert.ok(r.warnings.some((w) => /could not be matched/.test(w)));
    assert.equal(r.dropped_count, 0, 'the `page` hint must be stripped before validation');
  });
  it('per-page scores (trailing-slash and slug hints matched)', () => {
    assert.deepEqual(r.pages.map((p) => p.search.value), [97.2, 63.9, 56.1, 95.8, 63.9]);
    assert.deepEqual(r.pages.map((p) => p.search.band), ['A', 'D', 'F', 'A', 'D']);
    assert.deepEqual(r.pages.map((p) => p.ai.value), [null, 0, 0, 100, 0]);
    assert.equal(r.pages[0].ai.band, 'unscored');
  });
  it('rollup = Σ w·value / Σ w over scored pages (78.7 C search, 28.6 F ai)', () => {
    assert.deepEqual([r.search_seo.value, r.search_seo.raw_value, r.search_seo.band, r.search_seo.state, r.search_seo.capped], [78.7, 78.7, 'C', 'scored', false]);
    assert.deepEqual([r.ai_visibility.value, r.ai_visibility.band], [28.6, 'F']);
    assert.equal(r.search_seo.interpretation, 'Ranks well; classic fundamentals are strong.');
    assert.equal(r.ai_visibility.interpretation, 'Hard to cite by AI engines — add extractable structure and verify AI eligibility.');
  });
  it('lists the 3 worst pages per axis', () => {
    assert.equal(r.worst_pages.search[0].url, 'https://example.test/blog/second-post/');
    assert.deepEqual(r.worst_pages.search.map((p) => p.value), [56.1, 63.9, 63.9]);
    assert.deepEqual(r.worst_pages.ai.map((p) => p.value), [0, 0, 0]);
  });
  it('rollup axes and pages validate against audit-report.schema.json', () => {
    validAxis(r.search_seo); validAxis(r.ai_visibility);
    const pr = validate(REPORT.properties.pages, r.pages, { root: REPORT });
    assert.equal(pr.ok, true, JSON.stringify(pr.errors));
    assert.deepEqual([cat(r.search_seo, 'Structured Data').active, cat(r.search_seo, 'Structured Data').value], [true, 0]);
  });
  it('manifest page weights override role weights; opts.findings overrides manifest.findings', () => {
    const m2 = { pages: manifest.pages.map((p) => ({ ...p, weight: 10 })), findings: manifest.findings };
    const r2 = scoreSite(m2);
    assert.ok(r2.pages.every((p) => p.weight === 10 && p.weight_source === 'manifest'));
    const r3 = scoreSite(manifest, { findings: [] });
    assert.deepEqual([r3.search_seo.state, r3.findings_count], ['unscored', 0]);
  });
  it('a site-scoped cap propagates to every page and caps the rollup', () => {
    const m = { pages: [{ url: 'https://s.test/', role: 'homepage' }, { url: 'https://s.test/p', role: 'target' }] };
    const fs = [
      F('M2.robots.noindex_sitewide', { status: 'fail', severity: 5, scope: 'site', expected_impact: imp('search', 'established') }),
      F('M7.title.ok', { location: { url: 'https://s.test/' }, expected_impact: imp('search', 'established') }),
      F('M7.title.ok', { location: { url: 'https://s.test/p' }, expected_impact: imp('search', 'established') }),
    ];
    const rr = scoreSite(m, { findings: fs });
    assert.deepEqual(rr.pages.map((p) => p.search.capped), [true, true]);
    assert.deepEqual([rr.search_seo.value, rr.search_seo.capped, rr.search_seo.state, rr.search_seo.cap_reasons[0].id], [35.3, true, 'capped', 'M2.robots.noindex_sitewide']);
    const sup = scoreSite(m, { findings: fs, environment: 'preview' });
    assert.deepEqual([sup.search_seo.capped, sup.search_seo.suppressed_caps.length], [false, 1]);
  });
  it('a page-only cap does not cap the rollup but is warned about', () => {
    const m = { pages: [{ url: 'https://s.test/', role: 'homepage' }, { url: 'https://s.test/p', role: 'target' }] };
    const fs = [
      F('M1.robots.ok', { severity: 5, scope: 'site', expected_impact: imp('search', 'established') }),
      F('M2.robots.noindex_present', { status: 'fail', severity: 5, location: { url: 'https://s.test/p' }, expected_impact: imp('search', 'established') }),
    ];
    const rr = scoreSite(m, { findings: fs });
    assert.deepEqual(rr.pages.map((p) => p.search.value), [100, 40]);
    assert.deepEqual([rr.search_seo.value, rr.search_seo.band, rr.search_seo.capped], [76, 'C', false]);
    assert.ok(rr.search_seo.warnings.some((w) => /1 of 2 scored pages are capped/.test(w)));
  });
  it('a sampled page that did not answer 2xx is never scored (a 429 must not out-score a real page)', () => {
    const m = { pages: [
      { url: 'https://s.test/', role: 'homepage', status: 200 },
      { url: 'https://s.test/careers', role: 'sample', template: 'pages/*', status: 429 },
      { url: 'https://s.test/about', role: 'sample', template: 'pages/*', status: 200 },
    ] };
    const fs = [
      F('M7.title.missing', { status: 'fail', location: { url: 'https://s.test/' }, expected_impact: imp('search', 'established') }),
      F('M7.title.missing', { status: 'fail', location: { url: 'https://s.test/about' }, expected_impact: imp('search', 'established') }),
    ];
    const rr = scoreSite(m, { findings: fs });
    const careers = rr.pages.find((p) => p.url === 'https://s.test/careers');
    assert.deepEqual([careers.status, careers.scorable, careers.unscored_reason], [429, false, 'non_2xx_status']);
    assert.deepEqual([careers.search.value, careers.search.state, careers.ai.value], [null, 'unscored', null]);
    assert.deepEqual([rr.pages_count, rr.pages_scored], [3, 2]);
    assert.deepEqual(rr.unscored_pages, [{ url: 'https://s.test/careers', status: 429, role: 'template-sample' }]);
    assert.ok(rr.warnings.some((w) => /did not return 2xx/.test(w) && /\/careers \(429\)/.test(w)), rr.warnings.join(' | '));
    assert.equal(rr.worst_pages.search.some((p) => /careers/.test(p.url)), false, 'an unscored page is never a "weakest page"');
    // Both scored pages fail the same check, so the rollup is 0 either way: the 429 page neither
    // lifts it nor takes the template-sample weight away from the page that was measured.
    assert.equal(rr.search_seo.value, 0);
    assert.equal(rr.pages.find((p) => p.url === 'https://s.test/about').weight, ROLE_WEIGHTS['template-sample']);
    const pr = validate(REPORT.properties.pages, rr.pages, { root: REPORT });
    assert.equal(pr.ok, true, JSON.stringify(pr.errors));
  });
  it('a manifest with no status at all (local files) is scored exactly as before', () => {
    assert.equal(r.pages.every((p) => p.scorable === true && p.status === null), true);
    assert.deepEqual([r.pages_count, r.pages_scored, r.unscored_pages.length], [5, 5, 0]);
  });
  it('an empty manifest yields an unscored rollup with a warning', () => {
    const rr = scoreSite({});
    assert.deepEqual([rr.pages_count, rr.search_seo.state], [0, 'unscored']);
    assert.ok(rr.warnings.some((w) => /no pages/.test(w)));
  });
});

describe('score output conforms to audit-report.schema.json $defs.score', () => {
  for (const name of ['sample-findings.json', 'findings-gated.json', 'findings-empty.json', 'findings-search-only.json', 'findings-invalid.json']) {
    it(name, () => {
      const r = scoreFindings(load(name));
      validAxis(r.search_seo); validAxis(r.ai_visibility);
      for (const d of r.dropped_findings) {
        const v = validate({ $ref: '#/$defs/dropped_finding' }, d, { root: REPORT });
        assert.equal(v.ok, true, JSON.stringify(v.errors));
      }
    });
  }
  it('with suppressed caps (environment preview) and declared verticals', () => {
    const r = scoreFindings(load('findings-gated.json'), { environment: 'preview', vertical: 'ecommerce', multilingual: true });
    validAxis(r.search_seo); validAxis(r.ai_visibility);
  });
  it('the schema rejects a score with an unknown key or a bad band', () => {
    const r = scoreFindings(load('findings-empty.json'));
    assert.equal(validate({ $ref: '#/$defs/score' }, { ...r.search_seo, extra: 1 }, { root: REPORT }).ok, false);
    assert.equal(validate({ $ref: '#/$defs/score' }, { ...r.search_seo, band: 'Z' }, { root: REPORT }).ok, false);
  });
});

describe('CLI', () => {
  const INV = join(FIX, 'findings-invalid.json');
  it('--strict exits 2 when findings were dropped; without it exit 0', () => {
    assert.equal(cli(['--findings', INV, '--strict']).status, 2);
    const r = cli(['--findings', INV]);
    assert.deepEqual([r.status, r.json.dropped_count], [0, 3]);
  });
  it('--validate-only reports without scoring', () => {
    const r = cli(['--findings', INV, '--validate-only']);
    assert.deepEqual([r.status, r.json.ok, r.json.valid_count, r.json.dropped_count, 'search_seo' in r.json], [0, false, 1, 3, false]);
    assert.equal(cli(['--findings', INV, '--validate-only', '--strict']).status, 2);
    assert.deepEqual(cli(['--findings', join(FIX, 'sample-findings.json'), '--validate-only']).json.ok, true);
  });
  it('bad flags are USAGE (1) with a JSON error', () => {
    assert.equal(cli(['--findings', INV, '--environment', 'bogus']).status, 1);
    assert.match(cli(['--findings', INV, '--environment', 'bogus']).json.error, /--environment/);
    assert.equal(cli(['--findings', INV, '--vertical', 'bogus']).status, 1);
    assert.equal(cli(['--findings', INV, '--vertical']).status, 1);
    assert.equal(cli(['--findings', INV, '--vertical-json', join(FIX, 'nope.json')]).status, 1);
    assert.equal(cli(['--findings', INV, '--manifest', join(FIX, 'nope.json')]).status, 1);
    assert.equal(cli(['--run']).status, 1);
  });
  it('--run <dir> reads findings.json; --manifest (bare) reads <dir>/crawl.json', () => {
    const dir = mkdtemp('score-run-');
    try {
      writeFileSync(join(dir, 'findings.json'), readFileSync(join(FIX, 'sample-findings.json')));
      writeFileSync(join(dir, 'crawl.json'), readFileSync(join(FIX, 'crawl-manifest-sample.json')));
      const r = cli(['--run', dir]);
      assert.deepEqual([r.status, r.json.findings_count, r.json.search_seo.value], [0, 7, 56.4]);
      const m = cli(['--run', dir, '--manifest']);
      assert.deepEqual([m.status, m.json.pages_count, m.json.method], [0, 5, 'role_weights']);
      assert.equal(m.json.findings_count, 7, '--run findings win over manifest.findings');
      assert.equal(cli(['--run', join(dir, 'missing')]).status, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('--manifest alone uses the findings the manifest carries', () => {
    const r = cli(['--manifest', join(FIX, 'crawl-manifest-sample.json')]);
    assert.deepEqual([r.status, r.json.pages_count, r.json.search_seo.value, r.json.ai_visibility.value], [0, 5, 78.7, 28.6]);
  });
  it('--vertical a,b --multilingual and --vertical-json drive activation; --environment overrides the json', () => {
    const r = cli(['--findings', join(FIX, 'sample-findings.json'), '--vertical', 'ecommerce,local-business', '--multilingual']);
    assert.equal(r.status, 0);
    assert.equal(r.json.activation.source, 'declared');
    assert.deepEqual(r.json.activation.vertical, { primary: 'ecommerce', also: ['local-business'], multilingual: true });
    const dir = mkdtemp('score-vj-');
    try {
      const vj = join(dir, 'profile.json');
      writeFileSync(vj, JSON.stringify({ vertical: { primary: 'ecommerce', also: [] }, environment: { kind: 'staging' } }));
      const a = cli(['--findings', join(FIX, 'findings-gated.json'), '--vertical-json', vj]);
      assert.deepEqual([a.json.activation.environment, a.json.activation.vertical.primary, a.json.search_seo.capped], ['staging', 'ecommerce', false]);
      const b = cli(['--findings', join(FIX, 'findings-gated.json'), '--vertical-json', vj, '--environment', 'production']);
      assert.deepEqual([b.json.activation.environment, b.json.search_seo.capped], ['production', true]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('stdin JSON still works and an empty set is unscored', () => {
    const r = cli([], '[]');
    assert.deepEqual([r.status, r.json.search_seo.band, r.json.search_seo.value], [0, 'unscored', null]);
    const obj = cli([], JSON.stringify({ findings: load('findings-search-only.json') }));
    assert.equal(obj.json.search_seo.value, 82.4);
    assert.equal(cli([], '"nope"').status, 1);
  });
  it('exports the documented API', () => {
    assert.equal(typeof score.main, 'function');
    for (const n of ['scoreFindings', 'scoreSite', 'computeScore', 'interpret', 'band', 'normalizeVerticalInput']) assert.equal(typeof score[n], 'function', n);
    assert.deepEqual([...VERTICALS], ['saas', 'blog-publisher', 'local-business', 'ecommerce', 'docs', 'generic']);
    assert.deepEqual([...ENVIRONMENTS], ['production', 'preview', 'staging', 'local']);
  });
});

function mkdtemp(prefix) { return mkdtempSync(join(tmpdir(), prefix)); }

describe('lib/bands.mjs', () => {
  it('letter bands and the unscored sentinel', () => {
    assert.deepEqual(bands.BANDS, { A: 90, B: 80, C: 70, D: 60 });
    assert.deepEqual([90, 89.9, 80, 79.9, 70, 69.9, 60, 59.9, 0].map(bands.band), ['A', 'B', 'B', 'C', 'C', 'D', 'D', 'F', 'F']);
    assert.deepEqual([null, undefined, NaN, 'x'].map(bands.band), ['unscored', 'unscored', 'unscored', 'unscored']);
  });
  it('title/description length bands (one source of truth)', () => {
    assert.deepEqual([[...bands.TITLE.pass], [...bands.TITLE.recommended]], [[30, 60], [50, 60]]);
    assert.deepEqual([[...bands.DESCRIPTION.pass], [...bands.DESCRIPTION.recommended]], [[70, 160], [150, 160]]);
    assert.deepEqual([20, 40, 55, 61].map((n) => bands.lengthVerdict(n, bands.TITLE)), ['short', 'pass', 'recommended', 'long']);
    assert.deepEqual([69, 100, 155, 161].map((n) => bands.lengthVerdict(n, bands.DESCRIPTION)), ['short', 'pass', 'recommended', 'long']);
  });
});

describe('lib/finding.mjs', () => {
  it('reproduceCommand builds an absolute, quoted node command from import.meta.url', () => {
    const cmd = finding.reproduceCommand('parse-html', ['--snapshot', '/tmp/a b/x.json']);
    assert.ok(cmd.startsWith('node "' + join(ROOT, 'scripts', 'parse-html.mjs') + '"'), cmd);
    assert.ok(cmd.endsWith('--snapshot "/tmp/a b/x.json"'), cmd);
    assert.equal(finding.reproduceCommand('validate-jsonld.mjs', { type: ['A', 'B'], deep: true, url: 'https://e.test/?a=1&b=2', skip: false }),
      'node "' + join(ROOT, 'scripts', 'validate-jsonld.mjs') + '" --type A --type B --deep --url "https://e.test/?a=1&b=2"');
    assert.equal(finding.PLUGIN_ROOT, ROOT);
  });
  it('makeFinding fills structural defaults and validates', () => {
    const { finding: f, errors } = finding.makeFinding({
      id: 'M15.lcp.field', title: 'LCP field data unavailable', status: 'needs_api', evidence: 'no PSI key',
      expected: 'LCP <= 2.5s', recommendation: 'set PSI_API_KEY',
      verification: { method: 'psi_api', assertion: 'p75 <= 2500ms' }, reproduce: { script: 'psi-client', args: { url: 'https://e.test/' } },
      expected_impact: { axis: 'search', confidence: 'established', rationale: 'CWV is a ranking signal' },
    }, { mode: 'return' });
    assert.deepEqual(errors, []);
    assert.deepEqual([f.module, f.scope, f.fixable, f.severity, f.evidence.observed, f.expected_impact.magnitude], ['M15', 'page', 'advisory', 0, 'no PSI key', 'low']);
    assert.equal(f.verification.reproduce, 'node "' + join(ROOT, 'scripts', 'psi-client.mjs') + '" --url https://e.test/');
    assert.equal('reproduce' in f, false);
    const sev4 = finding.makeFinding(F('M5.x.y', { severity: 4, expected_impact: { axis: 'both', confidence: 'established', rationale: 'r' } }), { mode: 'return' });
    assert.equal(sev4.finding.expected_impact.magnitude, 'high');
    assert.equal(finding.makeFinding(F('M5.x.y', { severity: 3, expected_impact: { axis: 'both', confidence: 'established', rationale: 'r' } }), { mode: 'return' }).finding.expected_impact.magnitude, 'medium');
  });
  it('an invalid finding returns errors in return mode and throws in throw mode', () => {
    const bad = { id: 'M5.x.y', title: 'Bad', status: 'fail', expected: 'e', recommendation: 'r', expected_impact: imp('search') };
    const r = finding.makeFinding(bad, { mode: 'return' });
    assert.ok(r.errors.length >= 2, JSON.stringify(r.errors));
    assert.ok(r.errors.some((e) => /"severity"/.test(e)) && r.errors.some((e) => /"evidence"/.test(e)));
    assert.throws(() => finding.makeFinding(bad, { mode: 'throw' }), (e) => Array.isArray(e.errors) && /invalid finding M5\.x\.y/.test(e.message));
  });
  it('test mode is detected from NODE_TEST_CONTEXT (set by node:test children) and defaults to throwing there', () => {
    const expected = !!(process.env.NODE_TEST_CONTEXT || process.env.CLAUDE_SEO_AI_STRICT_FINDINGS);
    assert.equal(finding.isTestMode(), expected);
    if (!expected) return;
    assert.throws(() => finding.makeFinding({ id: 'M5.x.y' }));
  });
});

describe('language: the score chrome follows the report language', () => {
  // One category of the search axis: high enough to band A, narrow enough to trip the coverage floor.
  const narrow = () => [F('M1.robots.ok', { expected_impact: imp('search', 'established') })];

  it('interpret() keys both axes the same way in either language', () => {
    assert.deepEqual(interpretKeys({ value: 90 }, { value: 40 }), { search: 'hi_search_lo_ai', ai: 'hi_search_lo_ai' });
    assert.deepEqual(interpretKeys({ value: null }, { value: 90 }), { search: 'unscored', ai: 'both_high' });
    assert.deepEqual(interpret({ value: 70 }, { value: 70 }, 'es'), INTERPRETATIONS_ES.mixed);
    assert.deepEqual(interpret({ value: 70 }, { value: 70 }), INTERPRETATIONS.mixed, 'English stays the default');
    assert.deepEqual(interpret({ value: 70 }, { value: 70 }, 'fr'), INTERPRETATIONS.mixed, 'an unknown language falls back to English');
  });

  it('lang: "es" writes the interpretation and every score warning in Spanish', () => {
    const es = scoreFindings(narrow(), { lang: 'es', vertical: 'shoes' });
    assert.equal(es.search_seo.interpretation, INTERPRETATIONS_ES.both_high.search);
    assert.equal(es.ai_visibility.interpretation, INTERPRETATIONS_ES.unscored.ai);
    const coverage = es.search_seo.warnings.find((w) => /^cobertura /.test(w));
    assert.match(coverage, /solo 22 de 100 del peso siempre activo del eje búsqueda/);
    assert.match(coverage, /provisional/);
    assert.ok(!es.search_seo.warnings.some((w) => /^coverage /.test(w)), JSON.stringify(es.search_seo.warnings));
    assert.ok(es.warnings.some((w) => /vertical desconocida "shoes"/.test(w)), JSON.stringify(es.warnings));
    validAxis(es.search_seo);
  });

  it('the site rollup translates its own warnings too, and English is untouched', () => {
    const manifest = { pages: [{ url: 'https://example.test/', role: 'homepage' }, { url: 'https://example.test/gone', role: 'target', status: 429 }] };
    const fs = [F('M1.robots.ok', { scope: 'site', expected_impact: imp('search', 'established') })];
    const es = scoreSite(manifest, { findings: fs, lang: 'es' });
    assert.ok(es.warnings.some((w) => /no respondieron 2xx/.test(w)), JSON.stringify(es.warnings));
    assert.equal(es.search_seo.interpretation, INTERPRETATIONS_ES.both_high.search);
    const en = scoreSite(manifest, { findings: fs });
    assert.ok(en.warnings.some((w) => /did not return 2xx/.test(w)), JSON.stringify(en.warnings));
    assert.equal(en.search_seo.interpretation, INTERPRETATIONS.both_high.search);
  });

  it('message() falls back to the English builder for a language it does not ship', () => {
    assert.equal(message('de', 'no_pages'), message('en', 'no_pages'));
    assert.equal(message('es', 'no_pages'), 'el manifiesto no tiene páginas; el agregado del sitio está vacío');
  });
});

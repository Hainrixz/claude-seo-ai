---
name: seo-score
description: Compute the two never-blended 0-100 scores (Search SEO and AI Visibility / GEO-AEO) from a set of findings, with severity-weighted category values, dynamic re-normalization of conditional modules, severity gating, and letter bands. Used by seo-orchestrator and the `score` command.
allowed-tools: Read, Bash
---

# seo-score

Turns findings (conforming to `schema/finding.schema.json`) into the two scores. Full model in `references/scoring-model.md` — follow it exactly.

## Steps
1. Group findings by the category each module maps to, per score. A finding contributes only to the score(s) in `expected_impact.axis` (`search`, `ai`, or `both`).
2. **Category value** = `100 × Σ(status_factor × severity for scored findings) / Σ(severity)`, where `status_factor`: pass 1.0, warn 0.5, fail 0.0. Exclude `needs_api` and `not_applicable` from both sums.
3. **Active weights**: drop conditional categories (e-commerce/local/international) whose modules produced no findings; re-normalize remaining weights to sum to their active total.
4. **Score** = `Σ(category_value × weight) / Σ(active weight)` for each of Search SEO and AI Visibility.
5. **Severity gating**: if any finding has `severity: 5` and `status: fail`, cap the affected score at 40 and set `capped: true`.
6. Assign bands (A≥90, B≥80, C≥70, D≥60, F<60) and a one-line interpretation from the Search×AI quadrant.
7. M21 (llms.txt) weight is 0 — report it, never let it move the AI score.

## Determinism
Prefer `scripts/score.mjs` (run via Bash with the findings JSON) so the number is reproducible and CI-checkable; if Node is unavailable, compute by hand following the same formula and note the fallback. Either way the math must match `references/scoring-model.md`.

## Output
```json
{ "search_seo": { "value": 78, "band": "C", "capped": false, "interpretation": "...", "categories": [ {"name":"Indexability & Crawl","weight":22,"value":91,"active":true}, ... ] },
  "ai_visibility": { "value": 64, "band": "D", "capped": false, "interpretation": "Citable structure missing; add answer blocks and schema.", "categories": [ ... ] } }
```

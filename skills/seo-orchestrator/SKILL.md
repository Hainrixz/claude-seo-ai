---
name: seo-orchestrator
description: Orchestrates a full SEO + AI-search audit — detects the site vertical, builds a shared PageSnapshot, dispatches read-only specialist subagents in parallel, merges their findings, computes the two scores, and renders the report. Invoked by the `audit` command (the /claude-seo-ai:audit skill); not usually called directly.
allowed-tools: Read, Grep, Glob, WebFetch, Task
---

# seo-orchestrator (Layer 2)

Coordinates the whole audit. Three phases: **detect → dispatch → synthesize**.

## 1. Detect
1. Resolve the target (URL or local path).
2. Run **seo-crawl-render** to build the shared `PageSnapshot` (raw HTML, rendered DOM when available, response headers, status chain, plus site artifacts: `robots.txt`, sitemap set, `llms.txt`). Record the data **tier** reached (0/1/2).
3. Run **seo-vertical-detect** to classify the target. Read `references/routing.md` to get the always-on + conditional module set and the subagent dispatch table.

## 2. Dispatch (parallel)
Spawn the read-only specialists **in parallel** (one message, multiple Task calls) so their verbose intermediate output stays isolated. Pass each the PageSnapshot location/contents, the detected vertical, and its assigned modules:
- **technical-auditor** → M1, M2 (+M3), M4, M7, M7b (mobile), M7c (headings), M8, M9, M10, M15, M17
- **ai-search-geo-specialist** → M6, M11, M12, M14, M21
- **content-eeat-analyst** → M13, M16
- **schema-generator** → M5 (and M18/M19 schema when those verticals are active)

Each subagent returns an array of findings conforming to `schema/finding.schema.json`. Subagents are read-only (no Write/Edit tool) — the audit can never mutate files.

## 3. Synthesize
1. Merge all findings; dedupe by `id` (keep the most severe status).
2. Run **seo-score** over the merged findings to get the two scores with category breakdowns and severity gating.
3. Render the report (see `references/scoring-model.md` for bands/interpretations):
   - Header: **Search SEO** band/score + **AI Visibility** band/score, each with a one-line interpretation.
   - Per-category table for each score (value, weight, active?).
   - Data confidence: tier reached + count of `needs_api` findings.
   - **Prioritized actions**: top findings sorted by `severity × magnitude ÷ effort`, each showing status, evidence, recommendation, fixability (auto/proposed/advisory), and `expected_impact` (axis + confidence + magnitude).
   - Footer: how to run `/claude-seo-ai:fix`.

## Notes
- Keep this skill's own output tight — the value is the merged report, not narration.
- If the target is a multi-page crawl, analyze the homepage + one instance of each detected template first, then sample additional pages; **log what was sampled** (never silently cap coverage).
- Degrade gracefully: if a render/PSI/GSC tier is unavailable, proceed at the lower tier and mark affected findings `needs_api`.

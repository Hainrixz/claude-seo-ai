# Architecture

`claude-seo-ai` is a Claude Code plugin that audits and (opt-in) fixes classic **Search SEO** and **AI-search visibility (GEO/AEO)** for any website or web codebase. This document describes the **current** design.

## Entry points: four command skills

There is no root skill and no subcommand router. The plugin exposes **four command skills** directly under `skills/`, each invoked as a namespaced slash command (the plugin name `claude-seo-ai` is the namespace):

| Command | Skill | Purpose | Writes? |
|---|---|---|---|
| `/claude-seo-ai:audit` | `audit` | Full read-only SEO + AI-search audit → two scores + prioritized report | No |
| `/claude-seo-ai:geo` | `geo` | AI-search (GEO/AEO) subset → AI Visibility score + citability breakdown | No |
| `/claude-seo-ai:score` | `score` | Recompute/redisplay the two scores from the latest (or a saved) findings JSON, no re-crawl | No |
| `/claude-seo-ai:fix` | `fix` | Apply safe, deterministic fixes after explicit per-change confirmation | Yes (gated) |

`fix` carries **`disable-model-invocation: true`** in its frontmatter — the model can **never** auto-trigger it. It runs only when the user types `/claude-seo-ai:fix`. The other three are read-only and may be model-invoked.

## Three-layer model

```
Layer 1  DIRECTIVE      audit · geo · score · fix              (the four command skills)
                                   |
                                   v
Layer 2  ORCHESTRATION   seo-orchestrator
            detect vertical -> dispatch read-only subagents (parallel)
            -> merge findings -> seo-score -> render report
                                   |
                                   v
Layer 3  EXECUTION       ~21 seo-* audit modules (M1..M21)
            + seo-crawl-render (PageSnapshot), seo-vertical-detect, seo-score
            + optional zero-dependency Node scripts (scripts/*.mjs)
```

**Layer 1 — Directive.** The command skills are thin. `audit` and `geo` hand the target and flags to `seo-orchestrator`; `score` re-runs `seo-score` over existing findings; `fix` runs the fixer workflow. Each maps a user intent to the work, then renders results in the user's language (EN/ES).

**Layer 2 — Orchestration.** `seo-orchestrator` coordinates the whole audit in three phases — **detect → dispatch → synthesize**:
1. Resolve the target (URL or local path), call `seo-crawl-render` to build the shared **PageSnapshot**, then `seo-vertical-detect` to classify the site (see `references/routing.md`).
2. Dispatch the read-only specialist subagents **in parallel** (one message, multiple `Task` calls) so verbose intermediate output stays isolated; each gets the PageSnapshot, the detected vertical, and its assigned modules.
3. Merge all findings, dedupe by `id` (keep most severe status), run `seo-score`, and render the report.

**Layer 3 — Execution.** ~21 `seo-*` audit modules (M1..M21) each evaluate one concern and emit findings. Supporting skills `seo-crawl-render`, `seo-vertical-detect`, and `seo-score` are also Layer 3. Modules may shell out to **optional, zero-dependency Node scripts** under `scripts/` (e.g. `validate-jsonld.mjs`, `check-answerblocks.mjs`, `factdensity.mjs`, `hreflang-check.mjs`, `link-graph.mjs`, `parse-robots-sitemap.mjs`, `psi-client.mjs`, `score.mjs`) for reproducible, CI-checkable results. The audit still works offline (Tier 0) without them.

## Shared PageSnapshot

`seo-crawl-render` builds **one** `PageSnapshot`, fetched once, that every module reads. Building it a single time is what makes the offline (Tier 0) audit possible.

```
PageSnapshot {
  target:       { kind: "url"|"path", value }
  status_chain: [ { url, status, location? } ]      // redirects + final status
  headers:      { ... }                              // incl. X-Robots-Tag, content-type, hreflang Link
  raw_html:     "..."                                // pre-JS HTML the crawler/AI sees first
  rendered_dom: "..." | null                         // post-JS DOM, null if no render MCP
  render:       { needed, used, confidence }         // confidence: high | reduced
  artifacts:    { robots_txt, sitemaps[], llms_txt }
  tier:         0 | 1 | 2
}
```

**Render decision:** `--render static` never renders; `--render js` always tries; `--render auto` (default) flags client-side rendering when `raw_html` is near-empty, has hydration markers (`__NEXT_DATA__`, `window.__NUXT__`, `data-reactroot`, single root `<div id="app">`), or is missing primary content. If rendering is needed and a render MCP (Playwright/Firecrawl) is available, it captures `rendered_dom` (`confidence: high`); if not, it leaves `rendered_dom: null`, sets `confidence: reduced`, and emits an honest M4 finding rather than pretending it saw rendered content.

**Tiers:** `0` = WebFetch only · `1` = render MCP and/or PageSpeed available · `2` = Search Console / Merchant available. Downstream modules mark a finding `needs_api` when it requires a higher tier than was reached — never a silent pass.

## Subagents

Five subagents, defined in `agents/`. Four are strictly **read-only** (no `Write`/`Edit`), so an audit can never mutate files. Only `seo-fixer-writer` can write, and only via the `fix` skill after confirmation.

| Subagent | Tools | Role | Modules |
|---|---|---|---|
| `technical-auditor` | Read, Grep, Glob, Bash, WebFetch | Technical SEO | M1, M2 (+M3), M4, M7/M7b/M7c, M8, M9, M10, M15, M17 |
| `content-eeat-analyst` | Read, Grep, Glob, WebFetch | E-E-A-T + freshness | M13, M16 |
| `ai-search-geo-specialist` | Read, Grep, Glob, WebFetch | GEO/AEO | M6, M11, M12, M14, M21 |
| `schema-generator` | Read, Grep, Glob, Bash | Validate + propose JSON-LD (diffs only) | M5 (+ M18/M19 schema when active) |
| `seo-fixer-writer` | Read, Edit, Write, Bash | **The only writer** — applies AUTO fixes | used by `fix` after confirmation |

`schema-generator` proposes diffs but does not write; the actual write always goes through `seo-fixer-writer`.

## Vertical routing

`seo-vertical-detect` classifies the target as `ecommerce`, `local-business`, `blog-publisher`, `saas`, `docs`, or `generic` (a site may match several). The orchestrator then runs the **always-on** modules (M1–M17, M21) plus any **conditional** modules the vertical unlocks — M18 (e-commerce), M19 (local), M20 (international, when >1 locale or `hreflang`) — and the scorer re-normalizes weights so an inactive category never penalizes the site. Full table in `references/routing.md`.

## Two scores, never blended

`seo-score` produces **two independent 0–100 scores** that are never averaged: **Search SEO** and **AI Visibility (GEO/AEO)**. A page can rank well yet be uncitable by AI, or vice versa — surfacing both is the product thesis.

- **Category value** = `100 × Σ(status_factor × severity) / Σ(severity)` over scored findings, where `status_factor` is pass `1.0`, warn `0.5`, fail `0.0`. `needs_api` and `not_applicable` are excluded from both sums.
- **Score** = `Σ(category_value × weight) / Σ(active weight)`; conditional categories enter the denominator only when active, then weights re-normalize.
- A finding contributes only to the score(s) named in its `expected_impact.axis` (`search`, `ai`, or `both`).
- **Bands:** A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F < 60.
- **Severity gating:** any `severity: 5` finding with `status: fail` (e.g. site-wide `noindex`, robots blocking all crawlers) **caps the affected score at ≤ 40** and sets `capped: true`.

The number is computed deterministically by `scripts/score.mjs` (CI-checkable); a by-hand fallback follows the same formula in `references/scoring-model.md`.

## Finding contract

Every module emits findings conforming to `schema/finding.schema.json`. The schema is falsifiability-first: each finding is independently observable and re-checkable. Required fields include `id` (module-prefixed, e.g. `M5.article.missing_datemodified`), `module`, `title`, `status` (`pass`/`warn`/`fail`/`not_applicable`/`needs_api`), `severity` (0–5), `scope`, `evidence.observed` (verbatim), `expected`, `recommendation`, `fixable`, `verification` (`method` + `assertion` + a runnable `reproduce`), and `expected_impact` (`axis` + `confidence` + `magnitude` + `rationale`).

`fixable` drives the `fix` workflow:
- **auto** — deterministic, additive, machine-verifiable (meta viewport/charset/lang, Tier-1 JSON-LD, robots AI presets, hreflang, sitemaps, OG/Twitter cards, image dimensions, canonical, `llms.txt`).
- **proposed** — changes prose/meaning; requires per-item accept (titles, meta descriptions, answer-block rewrites, generated alt text).
- **advisory** — never written by the tool (content/E-E-A-T rewrites, CWV/performance, redirects, link-building, backend data).

## Honesty guardrails

- **`llms.txt` is scored 0** — reported (M21) but excluded from the AI Visibility score, because vendor support is partial and impact uncertain. It never moves the number.
- **FAQ/HowTo** structured data is recommended for machine understanding, not for rich results Google has retired.
- **No fabrication** — never invent statistics, citations, dates (no backdating `dateModified`), credentials, or identity links; real-world inputs (`sameAs` URLs, locale maps) are asked for, never guessed.
- **Confidence tiers** — `expected_impact.confidence` is `established`, `directional`, or `speculative`; speculative findings never cap a score below a band. Impact is banded, never a naked fabricated percentage.
- **`needs_api`** is never a silent pass; the report lists the data tier reached and the `needs_api` count so the user knows the score's confidence.

## Fix safety (opt-in writer)

`fix` defaults to a **dry-run** that prints diffs and writes nothing. Writing requires the user to drop `--dry-run` and confirm. It is **git-aware** (refuses a dirty tree without `--force`, prefers a branch), **backs up** every file before first modification, is **idempotent** (re-running produces no new diffs), and **re-verifies** each change by re-running the finding's `verification.assertion`. It never touches `.git/`, secrets, lockfiles, or files outside the project root.

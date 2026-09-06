---
name: audit
description: Audit a website or web codebase for SEO and AI-search (GEO/AEO) — produces two independent 0-100 scores (Search SEO + AI Visibility) plus a prioritized, evidence-backed report persisted on disk. Read-only; never writes to the project. Use when the user asks to audit, analyze, check, or score a site's SEO, structured data/schema, meta tags, Core Web Vitals, robots.txt, sitemaps, or AI discovery files, or how it ranks in Google and is cited by AI engines (ChatGPT, Perplexity, Google AI Overviews, Gemini, Claude).
argument-hint: "<url|path> [--pages N] [--max N] [--render auto|static|js] [--ua default|googlebot|gptbot] [--vertical auto|saas|blog-publisher|local-business|ecommerce|docs] [--out <dir>]"
allowed-tools: Read, Grep, Glob, WebFetch, Bash, Agent
---

# /claude-seo-ai:audit

A full, **read-only** SEO + AI-search audit. Never writes to the user's project; artifacts go to `${CLAUDE_PLUGIN_DATA}/runs` (or `--out`).

`$ARGUMENTS` = `<url|path> [flags]`. The target is a URL (`https://…`) or a local web project / built HTML. If no target is given, ask for one. Flags (`--pages`, `--max`, `--render`, `--ua`, `--vertical`, `--out`) are forwarded verbatim to the orchestrator. <!-- reconcile-flags-v0.2 -->

## What to do
1. Invoke the **seo-orchestrator** skill with the target and all flags. It acquires the site with the bundled scripts (crawl/snapshot → PageSnapshot v2), detects platform + vertical (**seo-vertical-detect**, `references/routing.md`), runs the deterministic checks, dispatches the read-only specialist subagents in parallel with a dispatch envelope, merges everything with `report.mjs`, and scores.
2. Present, from `report.json`:
   - The two scores — **Search SEO** and **AI Visibility** — each with a band (A–F) and a one-line interpretation. Never blended.
   - A per-category breakdown for each score; **coverage mode** (full vs deterministic-only), the data **tier** reached, and the `needs_api` / `manual_review` counts (score confidence).
   - The **sampling table**: pages crawled by role, templates discovered vs sampled, and every skip with its reason.
   - The **platform profile** (platform/framework/plugins, environment — e.g. "noindex expected on preview").
   - A **prioritized action list** sorted by impact ÷ effort: status, evidence, recommendation, fixability (auto/proposed/advisory), `expected_impact` (axis + confidence + magnitude).
   - The absolute **report path** (`<run_dir>/report.md`).
3. End by offering: "Run `/claude-seo-ai:fix <target>` to apply the safe, deterministic fixes — you'll confirm each change" and "`/claude-seo-ai:compare --baseline latest --against <target>` after you deploy".

Every finding conforms to `schema/finding.schema.json` with reproducible evidence. Respond in the user's language (EN/ES).

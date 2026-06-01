---
name: audit
description: Audit a website or web codebase for SEO and AI-search (GEO/AEO) — produces two independent 0-100 scores (Search SEO + AI Visibility) plus a prioritized, evidence-backed report. Read-only; never writes files. Use when the user asks to audit, analyze, check, or score a site's SEO, structured data/schema, meta tags, Core Web Vitals, robots.txt, sitemaps, or llms.txt, or how it ranks in Google and is cited by AI engines (ChatGPT, Perplexity, Google AI Overviews, Gemini, Claude).
argument-hint: "<url|path> [--render auto|static|js] [--vertical auto|saas|blog-publisher|local-business|ecommerce|docs]"
allowed-tools: Read, Grep, Glob, WebFetch, Bash, Task
---

# /claude-seo-ai:audit

A full, **read-only** SEO + AI-search audit. Never writes files.

`$ARGUMENTS` = `<url|path> [flags]`. The target is a URL (`https://…`) or a local web project / built HTML. If no target is given, ask for one.

## What to do
1. Invoke the **seo-orchestrator** skill with the target and any flags. It builds the shared PageSnapshot (via **seo-crawl-render**), detects the vertical (**seo-vertical-detect**, see `references/routing.md`), dispatches the read-only specialist subagents in parallel, merges findings, and runs **seo-score**.
2. Present:
   - The two scores — **Search SEO** and **AI Visibility** — each with a band (A–F) and a one-line interpretation.
   - A per-category breakdown for each score, the data **tier** reached, and the count of `needs_api` checks (score confidence).
   - A **prioritized action list** sorted by impact ÷ effort: each item with status, evidence, recommendation, fixability (auto/proposed/advisory), and `expected_impact` (axis + confidence + magnitude).
3. End by offering: "Run `/claude-seo-ai:fix` to apply the safe, deterministic fixes — you'll confirm each change."

Two scores, never blended. Every finding conforms to `schema/finding.schema.json` with reproducible evidence. Respond in the user's language (EN/ES).

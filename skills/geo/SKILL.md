---
name: geo
description: Analyze and score only a page's AI-search visibility (GEO/AEO) — answer extractability, fact density, AI-crawler access and snippet eligibility, entity linking, AI discovery files, and agent-readiness — and report an AI Visibility score with a citability breakdown. Read-only. Use for "will AI engines cite this?", GEO/AEO, or ChatGPT/Perplexity/Google AI Overviews/Gemini optimization.
argument-hint: "<url|path> [--pages N] [--render auto|static|js] [--probe \"<question>\"] [--gsc-ai-export <csv>]"
allowed-tools: Read, Grep, Glob, WebFetch, WebSearch, Bash, Agent
---

# /claude-seo-ai:geo

The AI-search (GEO/AEO) subset of the audit. **Read-only.**

`$ARGUMENTS` = `<url|path> [flags]`. `--pages`/`--render` are forwarded to the orchestrator. Two flags are probes, never scored: <!-- reconcile-flags-v0.2 -->
- `--probe "<question>"` (repeatable; future) — runs `WebSearch` for the question and reports whether the host appears in the results: a **web-search presence proxy, not AI citation data** (severity 0, shown with that disclaimer).
- `--gsc-ai-export <csv>` (future) — imports a **manual Search Console generative-AI export, impressions only** (the Search Analytics API exposes no AI data); severity 0.

## What to do
1. Invoke **seo-orchestrator** with the target and flags and the instruction "AI path only": it acquires the snapshot with the scripts (never WebFetch), runs the deterministic checks, and dispatches **ai-search-geo-specialist** with **M6** (seo-entity-linking), **M11** (seo-geo-answerblocks), **M12** (seo-geo-factdensity), **M14** (seo-ai-crawlers — access + snippet eligibility), **M21** (seo-ai-discovery — llms.txt, agents.md, UCP, agentic sitemap), **M22** (seo-agent-readiness); plus **M5** (seo-schema-jsonld, via schema-generator) and **M4** (seo-rendering, via technical-auditor) because they feed AI visibility.
2. Present from `report.json`: the **AI Visibility** score (band + interpretation), the citability breakdown by category, `needs_api`/`manual_review` counts, the prioritized GEO/AEO actions, and the `report.md` path.
3. Remind the user that **M21 — llms.txt and the other AI discovery files — is reported but scored 0** (Google Search ignores llms.txt; vendor support is partial). Never writes files; offer `/claude-seo-ai:fix` for the safe AUTO fixes (e.g. the AI-crawler robots.txt preset).

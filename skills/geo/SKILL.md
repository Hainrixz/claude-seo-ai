---
name: geo
description: Analyze and score only a page's AI-search visibility (GEO/AEO) — answer extractability, fact density, AI-crawler access, entity linking, and llms.txt — and report an AI Visibility score with a citability breakdown. Read-only. Use for "will AI engines cite this?", GEO/AEO, or ChatGPT/Perplexity/Google AI Overviews/Gemini optimization.
argument-hint: "<url|path>"
allowed-tools: Read, Grep, Glob, WebFetch, Bash, Task
---

# /claude-seo-ai:geo

The AI-search (GEO/AEO) subset of the audit. **Read-only.**

`$ARGUMENTS` = `<url|path>`.

## What to do
1. Build the PageSnapshot via **seo-crawl-render**, then run the AI-visibility path — you may dispatch the **ai-search-geo-specialist** subagent: **seo-geo-answerblocks** (M11), **seo-geo-factdensity** (M12), **seo-ai-crawlers** (M14/M21), **seo-entity-linking** (M6), plus **seo-schema-jsonld** (M5) and **seo-rendering** (M4) as they feed AI visibility.
2. Run **seo-score** and report the **AI Visibility** score (band + interpretation), a citability breakdown by category, and the prioritized GEO/AEO actions.
3. Remind the user that **llms.txt is reported but scored 0** (low/uncertain impact — partial vendor support). Never writes files; offer `/claude-seo-ai:fix` for the safe AUTO fixes (e.g. AI-crawler robots.txt preset).

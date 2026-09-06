---
name: geo
description: Analyze and score only a page's AI-search visibility (GEO/AEO) — answer extractability, fact density, AI-crawler access and Google AI-feature snippet eligibility, entity linking, AI discovery files, and agent-readiness — and report an AI Visibility score with a citability breakdown, plus optional unscored probes (web-search presence, Search Console generative-AI impressions). Read-only. Use for "will AI engines cite this?", GEO/AEO, or ChatGPT/Perplexity/Google AI Overviews/Gemini optimization.
argument-hint: "<url|path> [--pages N] [--render static|auto|js] [--feed <path>] [--probe \"<question>\"] [--gsc-ai-export <csv>]"
allowed-tools: Read, Grep, Glob, WebFetch, WebSearch, Bash, Agent
---

# /claude-seo-ai:geo

The AI-search (GEO/AEO) subset of the audit. **Read-only.**

`$ARGUMENTS` = `<url|path> [flags]`. `--pages N`, `--render static|auto|js` (default `static`) and `--feed <path>` (the Agentic Commerce Protocol product feed; it only does anything when the e-commerce vertical is active, and without it `M18.agentic.acp_feed_errors` stays `needs_api` — an unread feed is never a clean feed) are forwarded to the orchestrator and reach `audit.mjs` unchanged. `--probe` and `--gsc-ai-export` are handled here, not by `audit.mjs`: they are **probes — reported, never scored** (severity 0, excluded from the AI Visibility score and from every cap).

## What to do
1. Invoke **seo-orchestrator** with the target and flags and the instruction "AI path only": it acquires the snapshot with the scripts (never WebFetch), runs the deterministic checks, and dispatches **ai-search-geo-specialist** with **M6** (seo-entity-linking), **M11** (seo-geo-answerblocks), **M12** (seo-geo-factdensity), **M14** (seo-ai-crawlers — access + Google AI-feature eligibility), **M21** (seo-ai-discovery — llms.txt, agents.md, UCP, agentic sitemap), **M22** (seo-agent-readiness); plus **M5** (seo-schema-jsonld, via schema-generator) and **M4** (seo-rendering, via technical-auditor) because they feed AI visibility.
2. Run the probe flows below **only** when their flag is present.
3. Present from `report.json`: the **AI Visibility** score (band + interpretation), the citability breakdown by category, `needs_api` / `manual_review` counts, the prioritized GEO/AEO actions, any `probes` section (clearly separated from the score), and the `report.md` path.
4. Lead with the one thing Google documents: a page reaches AI Overviews / AI Mode by being **indexed and snippet-eligible** in Search (M14 `ai_eligibility`). Remind the user that **M21 — llms.txt and the other discovery files — is reported at weight 0** (Google Search ignores llms.txt; vendor support is partial). Never write files; offer `/claude-seo-ai:fix` for the safe AUTO fixes (e.g. the AI-crawler robots.txt preset).

## `--probe "<question>"` — web-search presence (repeatable)
A rough proxy for "does this site show up when someone asks this?", built from one search engine at one moment. It is **not** citation data.
1. For each `--probe` question, call **WebSearch** with the question verbatim. Do not rewrite it, do not add the brand name, and do not run extra queries the user did not ask for.
2. Read the organic results in order and build one JSON object — `rank` is the 1-based position in that result list, `url` and `title` are copied verbatim, and `host` is the audited site's hostname:
   ```json
   { "host": "example.com",
     "queries": [ { "query": "best sustainable running shoes",
                    "results": [ { "rank": 1, "url": "https://…", "title": "…" } ] } ] }
   ```
3. Pipe it to the reporter over stdin (nothing is written to the user's project); `--out` saves the probe inside the run directory, which is where `report.mjs` picks it up as `probes.web_search`:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/probe-report.mjs" --host <host> \
     --out "<run_dir>/probes/web-search.json" [--history <dir>] <<'JSON'
   { "host": "…", "queries": [ … ] }
   JSON
   ```
   `--results <file.json>` reads the same JSON from a file instead of stdin.
4. It returns presence rate (queries where the host appears), best rank, the competitor-host tally, and a trend against earlier probe runs stored for that host. Report it under **`probes.web_search`** and quote its `disclaimer` field verbatim — echo the string the script emits (`DISCLAIMER` in `scripts/probe-report.mjs`, also written into `report.json` and `report.md`), never a paraphrase of it, so the model's prose and the machine-generated line beside it cannot disagree. Today that string reads: *"Web-search presence for these questions. This is NOT AI Overview, AI Mode, ChatGPT, or Perplexity citation data — no vendor exposes that. Indexing/retrievability is a documented precondition for Google AI features; presence here is necessary, not sufficient."*
5. The finding is `M14.probe.web_presence`, **severity 0**, method `web_search_probe`. Never let a probe change the AI Visibility score, and never describe a rank as a ranking measurement — WebSearch results are personalized, localized, and volatile.

## `--gsc-ai-export <csv>` — Search Console generative-AI import
1. The user exports the **Generative AI** performance report from Search Console by hand; there is no API for it. Pass the file:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/gsc-ai-import.mjs" --csv <file.csv> [--host <host>] [--history <dir>] \
     > "<run_dir>/probes/gsc-generative-ai.json"
   ```
   The script prints the import and writes nothing itself, so redirect it into the run's `probes/` directory — that is what makes `report.mjs` report it under `probes.gsc_generative_ai` at data tier 2.
2. English and Spanish column headers are both recognized. The report carries **impressions only** — no clicks, no citations, no per-answer attribution — so the import reports impressions and nothing more.
3. Report it under **`probes.gsc_generative_ai`**. Findings, all **severity 0**: `M14.gsc_ai.impressions_present` (the export shows generative-AI impressions for this property), `M14.gsc_ai.zero_impressions` (the export parsed but contains none), `M14.gsc_ai.unavailable` (`needs_api` — no export supplied, or the file could not be parsed; the default state).
4. Say plainly what the number is not: impressions in Google's generative-AI surfaces are not citations, not clicks, and not a score input.

Both probe sections live beside the score, never inside it. If the user asks "did my AI visibility go up?", the honest answer is that these are proxies and the score is a structural assessment — the two are reported separately for exactly that reason. Respond in the user's language (EN/ES).

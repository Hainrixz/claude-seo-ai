---
name: seo-ai-crawlers
description: Audit AI crawler access and citability for a page — confirm retrieval/citation bots (OAI-SearchBot, Claude-SearchBot, PerplexityBot) are allowed and the Googlebot vs Google-Extended split is correct, classify training vs search/retrieval vs user-fetch user-agents, check the page is server-rendered enough for non-JS AI crawlers, and generate a choice-gated robots.txt preset. Module M14. Feeds the AI Visibility score.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-ai-crawlers (M14)

Controls whether AI search engines can crawl and cite the page, and whether they can read it without JS. The training-vs-search-vs-fetch distinction is everything. Reference: `references/ai-crawlers.md`. AI discovery files (llms.txt, agents.md, /.well-known/ucp, agentic sitemap) are module M21 — see `seo-ai-discovery`.

## Inputs
Work from the PageSnapshot named in your dispatch envelope: read `parsed` from `<run_dir>/pages/<slug>.json` plus `robots_directives`, `headers` (`x-robots-tag`), and `render{needed,used,delta}`; the parsed robots file with per-bot verdicts for the audited URL is `<run_dir>/site/robots.json`; Grep `pages/<slug>.html` for verbatim evidence. Deterministic findings already emitted by `audit.mjs` are listed in `<run_dir>/findings.deterministic.json` — do not re-emit those ids; add model-judged findings only. If invoked directly with a URL/path and no snapshot exists, first run `node "${CLAUDE_PLUGIN_ROOT}/scripts/snapshot.mjs" <target> --out "${CLAUDE_PLUGIN_DATA}/runs"` and use the printed snapshot path. <!-- reconcile-flags-v0.2 -->

## Audits
Working from the PageSnapshot (`parsed_rendered` when `render.used` is not `none`, else `parsed`) plus `site/robots.json`:
1. **Citation access**: are retrieval/citation bots — `OAI-SearchBot`, `Claude-SearchBot`, `PerplexityBot`, `Bingbot` — actually allowed (not caught by a broad `Disallow: /` or a wildcard block)? Confirm `Googlebot` is not blocked and the `Googlebot` (search) vs `Google-Extended` (Gemini training control) split is correct.
2. **User-agent classification**: bucket every AI agent in `robots.txt` into **training** (GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, CCBot), **search/retrieval** (OAI-SearchBot, Claude-SearchBot, PerplexityBot), and **user-triggered fetch** (ChatGPT-User, Claude-User, Perplexity-User). Match user-agents case-insensitively; treat the table in `references/ai-crawlers.md` as a starting set, not exhaustive.
3. **Renderability for non-JS crawlers**: use the M4 `render` block — most AI crawlers do not execute JS. If primary content only appears in `rendered_html_path` and is absent from `raw_html_path`, flag it as invisible to AI retrieval.

## Fixes
- **AUTO** (`fixable: auto`): a citation-friendly `robots.txt` preset, **choice-gated** — the user picks `allow-citations` (default: allow search/retrieval, opt out of training), `allow-all`, or `block-all`. Deterministic, additive, verifiable; emitted as a diff for `fix`.
- **ADVISORY** (`fixable: advisory`): edge/WAF block for bots that ignore `robots.txt` (e.g. Bytespider) — the tool never writes infra config.
**Never fabricate** sitemap URLs, contact emails, or link targets — ask the user or leave a clearly-marked `TODO` placeholder.

## Verification
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/parse-robots-sitemap.mjs" --snapshot <pages/<slug>.json>` (or `--url <u>`) (`robots_parse`) — parses `robots.txt`, resolves the effective directive for each AI user-agent against the audited path, and confirms it. <!-- reconcile-flags-v0.2 -->
- `dom_assert` against the M4 render result for the renderability check (content present in `raw_html_path`).
- When the required data tier is unavailable (e.g. `robots.txt` unfetchable, no M4 render result), status is `needs_api` — **never** a false `pass`.

## Findings
Findings conform to `schema/finding.schema.json`. `evidence.observed` quotes the page/robots line; `verification.reproduce` is the runnable command above; `expected_impact` is banded + confidence-tagged (no naked %). Examples:
- `M14.citation_bots.blocked` — `Disallow: /` reaches `OAI-SearchBot`/`Claude-SearchBot`/`PerplexityBot` (status `fail`, severity 4, `fixable: auto`, axis `ai`, confidence `established`).
- `M14.render.content_js_only` — primary content in `rendered_html_path` but absent from `raw_html_path`, invisible to non-JS AI crawlers (status `warn`, severity 4, `fixable: advisory`, axis `ai`, confidence `directional`).

## Honesty
- Blocking a **training** bot does NOT block the matching **search** bot — they are separate user-agents (`GPTBot` ≠ `OAI-SearchBot`, `ClaudeBot` ≠ `Claude-SearchBot`). Many "block AI" guides get this wrong.
- `Bytespider` and some agents frequently ignore `robots.txt`; a robots rule is best-effort. Real enforcement needs an edge rule / WAF (advisory).
- `robots.txt` controls **crawling**, not **indexing** — to keep a page out, use a `noindex` meta tag and don't also `Disallow` it.
- llms.txt and the other discovery files are not part of this module and never move the M14 category — they are reported under M21 at weight 0.

---
name: seo-ai-crawlers
description: Audit AI crawler access and citability for a page — confirm retrieval/citation bots (OAI-SearchBot, Claude-SearchBot, PerplexityBot) are allowed and the Googlebot vs Google-Extended split is correct, classify training vs search/retrieval vs user-fetch user-agents, check the page is server-rendered enough for non-JS AI crawlers, validate llms.txt / llms-full.txt (also covers M21), and generate a choice-gated robots.txt preset. Module M14. Feeds the AI Visibility score.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-ai-crawlers (M14)

Controls whether AI search engines can crawl and cite the page, and whether they can read it without JS. The training-vs-search-vs-fetch distinction is everything. Reference: `references/ai-crawlers.md`.

## Audits
Working from the PageSnapshot (`rendered_dom` if present, else `raw_html`) plus the site `robots.txt`:
1. **Citation access**: are retrieval/citation bots — `OAI-SearchBot`, `Claude-SearchBot`, `PerplexityBot`, `Bingbot` — actually allowed (not caught by a broad `Disallow: /` or a wildcard block)? Confirm `Googlebot` is not blocked and the `Googlebot` (search) vs `Google-Extended` (Gemini training control) split is correct.
2. **User-agent classification**: bucket every AI agent in `robots.txt` into **training** (GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, CCBot), **search/retrieval** (OAI-SearchBot, Claude-SearchBot, PerplexityBot), and **user-triggered fetch** (ChatGPT-User, Claude-User, Perplexity-User). Match user-agents case-insensitively; treat the table in `references/ai-crawlers.md` as a starting set, not exhaustive.
3. **Renderability for non-JS crawlers**: pull the M4 (seo-crawl-render) render result — most AI crawlers do not execute JS. If primary content only appears in `rendered_dom` and is absent from `raw_html`, flag it as invisible to AI retrieval.
4. **llms.txt / llms-full.txt** (also covers M21): presence at the site root, valid Markdown structure (H1 title, summary blockquote, sectioned link lists), and that linked URLs resolve. Follow `references/ai-crawlers.md`.

## Fixes
- **AUTO** (`fixable: auto`): a citation-friendly `robots.txt` preset, **choice-gated** — the user picks `allow-citations` (default: allow search/retrieval, opt out of training), `allow-all`, or `block-all`. Deterministic, additive, verifiable; emitted as a diff for `fix`.
- **AUTO** (`fixable: auto`), **disclosure-gated** and **scored 0**: `llms.txt` / `llms-full.txt`, generated from the site's own structure only on explicit request (`fix --category llms`), shown as a diff before writing. Additive and deterministic, but never sold as proven ranking value — the disclosure that it is low/uncertain impact is shown every time.
- **ADVISORY** (`fixable: advisory`): edge/WAF block for bots that ignore `robots.txt` (e.g. Bytespider) — the tool never writes infra config.
**Never fabricate** sitemap URLs, contact emails, or link targets — ask the user or leave a clearly-marked `TODO` placeholder.

## Verification
- `node ${CLAUDE_SKILL_DIR}/../../scripts/parse-robots-sitemap.mjs --url <u>` (`robots_parse`) — parses `robots.txt`, resolves the effective directive for each AI user-agent, and confirms it.
- `dom_assert` against the M4 render result for the renderability check (content present in `raw_html`).
- When the required data tier is unavailable (e.g. `robots.txt` unfetchable, no M4 render result), status is `needs_api` — **never** a false `pass`.

## Findings
Findings conform to `schema/finding.schema.json`. `evidence.observed` quotes the page/robots line; `verification.reproduce` is the runnable command above; `expected_impact` is banded + confidence-tagged (no naked %). Examples:
- `M14.citation_bots.blocked` — `Disallow: /` reaches `OAI-SearchBot`/`Claude-SearchBot`/`PerplexityBot` (status `fail`, severity 4, `fixable: auto`, axis `ai`, confidence `established`).
- `M14.render.content_js_only` — primary content in `rendered_dom` but absent from `raw_html`, invisible to non-JS AI crawlers (status `warn`, severity 4, `fixable: advisory`, axis `ai`, confidence `directional`).
- `M14.llmstxt.missing` — no `/llms.txt` at site root (status `warn`, severity 1, `fixable: auto`, axis `ai`, confidence `speculative`, scored 0).

## Honesty
- Blocking a **training** bot does NOT block the matching **search** bot — they are separate user-agents (`GPTBot` ≠ `OAI-SearchBot`, `ClaudeBot` ≠ `Claude-SearchBot`). Many "block AI" guides get this wrong.
- `Bytespider` and some agents frequently ignore `robots.txt`; a robots rule is best-effort. Real enforcement needs an edge rule / WAF (advisory).
- `robots.txt` controls **crawling**, not **indexing** — to keep a page out, use a `noindex` meta tag and don't also `Disallow` it.
- `llms.txt` has only **partial** vendor support (Anthropic and Perplexity honor it in retrieval; Google does not use it for AI Overviews/AI Mode; OpenAI uncommitted) and is also useful as IDE/coding-agent context. Still low/uncertain — scored 0, never presented as proven ranking value.

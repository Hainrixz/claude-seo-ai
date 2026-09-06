# AI crawlers, robots.txt control & AI-feature eligibility (2026)

The key distinction: **training bots** (used to train models) vs **search/retrieval bots** (fetch pages to answer live queries and may cite you) vs **user-triggered fetchers** (fetch a page because a user pasted/asked about it). You can allow citations while controlling training — but only if you target the right user-agents. Separate from all of that: **what gates Google's own AI features is Search eligibility, not any AI-specific file or token.**

## What actually gates Google AI features (M14 — the only `established` AI findings)

Google's documentation (developers.google.com/search/docs/appearance/ai-features, "AI features and your website", 2025-12-10; developers.google.com/search/docs/fundamentals/ai-optimization-guide, "Optimizing your website for generative AI features", updated 2026-07-10) states:

- A page can appear in **AI Overviews / AI Mode** only if it is **indexed and eligible to be shown in Google Search with a snippet**. That is the whole gate.
- The snippet controls limit the input to those features directly: `noindex` (and `none`), `nosnippet`, `max-snippet:0` (any low `max-snippet:N` shrinks it), `data-nosnippet` on the primary content, and a robots.txt `Disallow` that reaches `Googlebot`.
- **`Google-Extended` does NOT affect AI Overviews or AI Mode.** It is a product token that limits use of your content for training future Gemini models and for grounding in Gemini Apps / Vertex AI; blocking it leaves Search-based AI features untouched.
- **Google Search ignores `llms.txt`.** No special schema.org type, no chunking, no "AI-specific rewriting" is required; Google recommends the same fundamentals (indexable, semantic HTML, JS-SEO best practices, Merchant Center / Business Profile data, agent-friendly UI).
- Search Console has a Generative AI performance report (impressions only); the Search Analytics API exposes no AI dimensions as of 2026-08 — the tool never claims API-level AI data.

Finding ids: `M14.ai_eligibility.nosnippet`, `.max_snippet_zero`, `.max_snippet_low`, `.data_nosnippet_primary`, `.not_indexable`, `.ok`, and `M14.google_extended.blocked_info` (pass, informational). Everything else on the AI axis is `directional` or `speculative`.

## User-agent reference

Purpose classes: **training** · **retrieval** (search index / live answers, may cite) · **user** (user-triggered fetch) · **search** (classic engine) · **ads**. Strings drift; match case-insensitively and re-check the vendor page before making strong claims. Note the current OpenAI UA versions `GPTBot/1.4` and `OAI-SearchBot/1.4`; Anthropic publishes its crawler IP ranges at `https://claude.com/crawling/bots.json`.

| User-agent | Operator | Purpose | robots.txt | Source |
|---|---|---|---|---|
| `Googlebot` | Google | Search index (feeds AI Overviews / AI Mode) | Don't block | developers.google.com/search/docs/crawling-indexing/overview-google-crawlers |
| `Google-Extended` | Google | Gemini training / grounding control token — **not** AI Overviews | Yes | developers.google.com/search/docs/crawling-indexing/overview-google-crawlers |
| `Google-CloudVertexBot` | Google | retrieval — Vertex AI Agents crawl on site-owner request | Yes | developers.google.com/search/docs/crawling-indexing/overview-google-crawlers |
| `Bingbot` | Microsoft | Search (feeds Copilot) | Don't block | bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0 |
| `GPTBot` (`GPTBot/1.4`) | OpenAI | training | Yes | developers.openai.com/api/docs/bots |
| `OAI-SearchBot` (`OAI-SearchBot/1.4`) | OpenAI | retrieval — ChatGPT search (citations) | Yes — allow for citations | developers.openai.com/api/docs/bots |
| `ChatGPT-User` | OpenAI | user | Yes (limited effect) | developers.openai.com/api/docs/bots |
| `OAI-AdsBot` | OpenAI | ads validation (landing-page checks for ChatGPT ads) | Yes | developers.openai.com/api/docs/bots |
| `ClaudeBot` | Anthropic | training | Yes | support.claude.com crawler article ("Does Anthropic crawl data from the web…") + claude.com/crawling/bots.json |
| `Claude-SearchBot` | Anthropic | retrieval — Claude search (citations) | Yes — allow for citations | support.claude.com crawler article |
| `Claude-User` | Anthropic | user | Yes | support.claude.com crawler article |
| `Claude-Web` | Anthropic | user (legacy token; still seen in logs) | Yes | support.claude.com crawler article — TO-VERIFY current status |
| `PerplexityBot` | Perplexity | retrieval (citations) | Yes — allow for citations | docs.perplexity.ai/guides/bots |
| `Perplexity-User` | Perplexity | user | Yes (limited effect) | docs.perplexity.ai/guides/bots |
| `Applebot` | Apple | search — Siri / Spotlight / Safari suggestions | Don't block if you want Apple surfaces | support.apple.com/en-us/119829 |
| `Applebot-Extended` | Apple | Apple Intelligence training control | Yes | support.apple.com/en-us/119829 |
| `Meta-ExternalAgent` | Meta | training | Yes | developers.facebook.com/docs/sharing/webmasters/web-crawlers |
| `Meta-ExternalFetcher` | Meta | user — may bypass robots.txt per Meta's own docs | Limited | developers.facebook.com/docs/sharing/webmasters/web-crawlers |
| `Amazonbot` | Amazon | retrieval — Alexa / Amazon answer surfaces | Yes | developer.amazon.com/amazonbot |
| `DuckAssistBot` | DuckDuckGo | retrieval — DuckAssist answers | Yes | duckduckgo.com/duckduckgo-help-pages/results/duckassistbot |
| `MistralAI-User` | Mistral | user — Le Chat fetch | Yes | docs.mistral.ai/robots — TO-VERIFY exact page |
| `cohere-ai` | Cohere | training | Yes | TO-VERIFY — no vendor page located |
| `CCBot` | Common Crawl | training corpus (feeds many models) | Yes | commoncrawl.org/ccbot |
| `Bytespider` | ByteDance | training + search; **often ignores robots.txt** | Unreliable — edge/WAF block | TO-VERIFY — no vendor page located |

The script-side table (`scripts/lib/bots.mjs`, Phase 1f/4c) mirrors these rows and emits `ua_table_version`; a row here without a source may be listed but must never back an `established` finding.

## Content-Signal (robots.txt)

**Syntax.** A single line, comma-separated `key=value` pairs, values `yes` or `no`:

```
Content-Signal: search=yes, ai-input=no, ai-train=no
```

**Semantics** (contentsignals.org; IETF `draft-romm-aipref-contentsignals`):
- `search` — building a search index and showing results (links + short excerpts). Explicitly excludes AI-generated summaries.
- `ai-input` — feeding content into a model at answer time (RAG, grounding, live AI search answers).
- `ai-train` — training or fine-tuning models.
An absent key expresses **no preference** (not `yes`). Keys are independent: `search=yes, ai-input=no` says "index me, do not summarize me".

**Placement.** *Global*: a standalone line outside every `User-agent` group (Cloudflare's managed robots.txt appends it after all groups) applies to every crawler. *Group*: a line inside a `User-agent` group applies to that group only and overrides the global line for those agents. Both forms are parsed (`content_signals{placement, global, by_group[]}`).

**Cloudflare.** Cloudflare ships the line by default for customers on its managed robots.txt (3.8M+ domains; initial default `search=yes, ai-train=no`, `ai-input` unset). Cloudflare announced a **three-tier default change effective 2026-09-15** — TO-VERIFY the exact tier values before quoting them to a user. Cloudflare enforces the signals **for its own customers at the edge**; on other hosts the line is a published preference only.

**Interaction with Allow/Disallow.** `Disallow` controls *access*; `Content-Signal` states how *accessible* content may be *used*. A `Disallow: /` for GPTBot still blocks GPTBot regardless of `ai-train=yes`; `ai-train=no` on an allowed path does not stop a crawler from fetching it. Never present a Content-Signal line as a substitute for a Disallow.

**Honesty.** The IETF draft **expired in 2026-04** and defines vocabulary only — no enforcement, no reporting. **No AI vendor documents compliance** with Content-Signal (OpenAI, Anthropic, Google, Perplexity, Meta, and Apple all document robots.txt user-agent tokens instead). Findings `M14.content_signal.*` are therefore `directional` at most, never `established`, and `ai-train=no` earns only an informational pass.

## Presets the fixer can generate (choice-gated, opt-in)

Each preset ends with a `Content-Signal:` line stating the same intent in the signals vocabulary. The line is honest metadata, not enforcement (see above) — the `User-agent` groups do the work.

**1. Allow citations, control training (recommended default for most sites):**
```
# Search engines — required for ranking
User-agent: Googlebot
User-agent: Bingbot
Disallow:

# AI search/retrieval — allow so engines can cite you
User-agent: OAI-SearchBot
User-agent: Claude-SearchBot
User-agent: PerplexityBot
User-agent: DuckAssistBot
User-agent: Amazonbot
Disallow:

# AI training — opt out
User-agent: GPTBot
User-agent: ClaudeBot
User-agent: Google-Extended
User-agent: Applebot-Extended
User-agent: Meta-ExternalAgent
User-agent: CCBot
Disallow: /

Sitemap: https://example.com/sitemap.xml

Content-Signal: search=yes, ai-input=yes, ai-train=no
```

**2. Allow all** (maximum visibility, includes training): `Disallow:` for everything, then `Content-Signal: search=yes, ai-input=yes, ai-train=yes`.

**3. Block all AI** (retrieval + training; reduces AI citations to ~zero): `Disallow: /` for every AI agent above except the classic search engines, then `Content-Signal: search=yes, ai-input=no, ai-train=no`. Tell the user this also kills AI-search visibility — and that Google's AI features still follow Googlebot, so this preset does not remove a page from AI Overviews (only snippet controls do).

## AI discovery & agent endpoints (M21, weight 0)

Probed once per run into `site/discovery.json` and reported by `seo-ai-discovery`; **none of them moves either score**:

| Endpoint | What it is | Why weight 0 |
|---|---|---|
| `/llms.txt`, `/llms-full.txt` | llmstxt.org Markdown index of a site for LLM consumption | Google ignores it; ~10% adoption and 97% of files received zero bot requests (Ahrefs, 2026-05); no major vendor documents honoring it for retrieval |
| `/agents.md` | Human/agent-readable "how to interact with this site" note (Shopify generates one per store) | No engine documents consuming it |
| `/.well-known/ucp` | Universal Commerce Protocol merchant profile (Google + Shopify, 2026-01) declaring `ucp.version`, services, capabilities, payment handlers | Real for agentic checkout, but readiness is an **M18** e-commerce concern; M21 only reports presence/format. Not a search or citation signal |
| `/.well-known/ai-catalog.json` | Agentic Resource Discovery catalog (Google + Linux Foundation, v0.9 draft 2026-05) | Draft spec, near-zero adoption — report-only |
| `/sitemap_agentic_discovery.xml` | Shopify's agent-facing sitemap of the discovery endpoints | Platform-generated; no engine documents consuming it |

Findings `M21.llmstxt.*`, `M21.agents_md.*`, `M21.ucp.*` (only when e-commerce is inactive), `M21.ai_catalog.*`, `M21.agentic_sitemap.*` are informational (severity ≤ 2, `speculative`/`directional`), plus one cross-check that these files are not `Disallow`ed to their own audience. `fix --category ai-discovery` (alias `llms`) can generate `llms.txt` from the site's own structure, disclosure-gated — never sold as ranking value.

## Honesty notes

- Blocking a **training** bot does NOT block the matching **retrieval** bot — they are separate user-agents (`GPTBot` ≠ `OAI-SearchBot`, `ClaudeBot` ≠ `Claude-SearchBot`). Many "block AI" guides get this wrong.
- `Bytespider` and `Meta-ExternalFetcher` may ignore `robots.txt`; a robots rule is best-effort. Real enforcement needs an edge rule / WAF (advisory).
- `robots.txt` controls **crawling**, not **indexing**. To keep a page out of an index use a `noindex` robots meta tag (and don't also `Disallow` it, or the crawler can't see the `noindex`).
- A UA-spoofed fetch (`--ua googlebot|gptbot`) that gets a different page is `directional` evidence of cloaking or a challenge page, never proof — a CDN may legitimately refuse a spoofed Googlebot from a non-Google IP.

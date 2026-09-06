---
name: seo-ai-crawlers
description: Audit AI crawler access and Google AI-feature eligibility for a page — check the snippet controls that actually gate AI Overviews and AI Mode (noindex, nosnippet, max-snippet, data-nosnippet), resolve per-bot effective access from robots.txt for the audited path (training vs retrieval vs user-fetch tokens), read Content-Signal posture, diff what different user-agents are served, confirm non-JS crawlers can read the page, and generate a choice-gated robots.txt preset. Module M14. Feeds the AI Visibility score.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-ai-crawlers (M14)

Two separate questions live in this module, and only one of them has vendor documentation behind it:

1. **Google's AI features.** A page can appear in AI Overviews / AI Mode only if it is indexed and eligible to be shown in Google Search **with a snippet**. Those gates are documented, so `M14.ai_eligibility.*` carries the only `established` findings here.
2. **Third-party AI crawlers.** Who may fetch and cite the page — OpenAI, Anthropic, Perplexity, Apple, Amazon, Meta, Mistral, DuckDuckGo, Cohere. Access is documented per user-agent; the citation *effect* is not, so those findings stay `directional`.

The training-vs-retrieval-vs-user-fetch distinction decides every robots recommendation. Reference: `references/ai-crawlers.md` (UA table with sources, Content-Signal, eligibility gates, presets). AI discovery files (llms.txt, agents.md, `/.well-known/ucp`, agentic sitemap) are module M21 — see `seo-ai-discovery`; agentic-commerce readiness is M18 (`seo-ecommerce`).

## Inputs
Work from the PageSnapshot named in your dispatch envelope: read `parsed` from `<run_dir>/pages/<slug>.json` plus `robots_directives`, `headers` (`x-robots-tag`), and `render{needed,used,delta}`; Grep `pages/<slug>.html` for verbatim evidence. `<run_dir>/site/robots.json` carries, for the **audited path**, `verdicts`, `effective_access{[bot]:{class, fetch, url_allowed, via, rule, signals, doc_url, robots_reliability}}`, `content_signals{present, placement, global, by_group[], malformed[], cloudflare_managed_hint}`, `groups`, and `ua_table_version`. When the run included a user-agent diff, `<run_dir>/ua-diff.json` holds per-UA status/title/h1/word_count/canonical/robots/jsonld. Deterministic findings already emitted by `audit.mjs` are listed in `<run_dir>/findings.deterministic.json` — do not re-emit those ids; add model-judged findings only. If invoked directly with a URL/path and no snapshot exists, first run `node "${CLAUDE_PLUGIN_ROOT}/scripts/snapshot.mjs" <target> --out "${CLAUDE_PLUGIN_DATA}/runs"` and use the printed snapshot path.

## Audits
Working from the PageSnapshot (`parsed_rendered` when `render.used` is not `none`, else `parsed`) plus `site/robots.json`:

1. **Google AI-feature eligibility (the established gate).** Collect **every** `<meta name="robots">` / `<meta name="googlebot">` tag *and* every `X-Robots-Tag` header value (header and meta both count; the most restrictive wins). Read `noindex`/`none`, `nosnippet`, `max-snippet:N`, and the `data-nosnippet` attributes — for `data-nosnippet`, measure how much of the main content it covers and specifically whether it wraps the H1 or the lead passage. Also confirm Googlebot itself is not disallowed for this path. Record the **scope**: a directive coming from a template or a site-wide header is `scope: template|site`; one hand-written into a single document is `scope: page`.
2. **Effective per-bot access.** Read `effective_access` for the audited path — not for `/`. A site can allow `/` and disallow `/blog/`, so root-level posture is not an answer. Check the retrieval/citation bots (`OAI-SearchBot`, `Claude-SearchBot`, `PerplexityBot`, `Amazonbot`, `DuckAssistBot`, `Google-CloudVertexBot`), the classic engines (`Googlebot`, `Bingbot`, `Applebot`), the training tokens (`GPTBot`, `ClaudeBot`, `Google-Extended`, `Applebot-Extended`, `CCBot`, `Meta-ExternalAgent`, `cohere-ai`, `Bytespider`), the user-fetch tokens (`ChatGPT-User`, `Claude-User`, `Claude-Web`, `Perplexity-User`, `Meta-ExternalFetcher`, `MistralAI-User`), and `OAI-AdsBot`. Current OpenAI tokens ship as `GPTBot/1.4` and `OAI-SearchBot/1.4`; match user-agents case-insensitively on the token, never on the full UA string. Anthropic publishes its crawler IP ranges at `claude.com/crawling/bots.json`. Quote `ua_table_version` in the report so a stale table is visible.
3. **Content-Signal posture.** `content_signals` reports the `search` / `ai-input` / `ai-train` keys, whether the line is global (Cloudflare's managed robots.txt appends it after all groups) or inside a `User-agent` group, and any malformed pairs. A group line overrides the global line for that group. **A `Disallow` always wins over a signal**: `Disallow: /` blocks the bot whatever `ai-train` says, and `Allow` + `ai-input=no` means the page is still fetchable while consent is withheld — say exactly that, never "blocked".
4. **User-agent divergence.** Compare what the origin serves to `default`, `googlebot`, `gptbot`, `oai-searchbot`, and `claude-searchbot`: differing status, title, H1, word count, canonical, robots directives, or JSON-LD. Separate a *bot challenge* (403/429/503, interstitial, CAPTCHA markup, near-zero word count) from a genuine content difference. The search-axis cloaking judgment — Googlebot vs a browser being served different content — belongs to **M2** (`M2.cloaking.ua_content_divergence`); M14 owns only the AI-bot access side.
5. **Renderability for non-JS crawlers.** Use the M4 `render` block. If the H1, the primary body, or the JSON-LD exists only in `rendered_html_path` and is absent from `raw_html_path`, the page is not reliably readable by AI crawlers that do not execute JavaScript.
6. **Google-Extended sanity.** If `Google-Extended` is disallowed, state plainly that this does **not** remove the site from AI Overviews or AI Mode — it limits Gemini training and grounding only.

## Fixes
- **AUTO** (`fixable: auto`): a citation-friendly `robots.txt` preset, **choice-gated** — the user picks `allow-citations` (allow search/retrieval, opt out of training), `allow-all`, or `block-all`. Presets in `references/ai-crawlers.md`; each ends with a `Content-Signal:` line that restates the same intent in that vocabulary. Deterministic, additive, verifiable; emitted as a diff for `fix`.
- **PROPOSED** (`fixable: proposed`): removing a `nosnippet` / `max-snippet:0` / `noindex` that the user confirms is unintended, and lifting `data-nosnippet` off the primary content. Never auto-written: a snippet control is often deliberate (paywall, licensing).
- **ADVISORY** (`fixable: advisory`): edge/WAF rules — unblocking a challenged AI bot, or blocking an agent that ignores `robots.txt` (e.g. `Bytespider`). The tool never writes infrastructure config.
**Never fabricate** sitemap URLs, contact emails, or link targets — ask the user or leave a clearly-marked `TODO` placeholder.

## Verification
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/parse-robots-sitemap.mjs" --url <final_url> --path <audited path>` (method `robots_parse`) — resolves the effective directive per user-agent **against the audited path** and returns `content_signals`, `effective_access`, and `ua_table_version`. Use `--robots <robots_url>` or `--file <path>` for an offline robots file.
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/ai-eligibility.mjs" --snapshot <pages/<slug>.json>` (or `--url <u>`) — every meta-robots/`X-Robots-Tag` directive, `max-snippet` value, and the `data-nosnippet` coverage share, including whether it wraps the H1/lead (methods `dom_assert` + `header_check`).
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/ua-diff.mjs" --url <final_url> --ua default,googlebot,gptbot,oai-searchbot,claude-searchbot` (method `ua_diff`) — per-UA response fields plus challenge detection.
- `render_diff` against the M4 result for the renderability check (primary content present in `raw_html_path`).
- When the required tier is unavailable (`robots.txt` unfetchable, no M4 render result, no UA diff run), status is `needs_api` or `manual_review` — **never** a false `pass`.

## Findings
Findings conform to `schema/finding.schema.json`. `evidence.observed` quotes the page, header, or robots line verbatim; `verification.reproduce` is one of the runnable commands above; `expected_impact` is banded + confidence-tagged (no naked %). **Severity policy**: 5 is reserved for catastrophic, eligibility-killing facts at site/template scope; 4 major · 3 moderate · 2 minor · 1 cosmetic · 0 informational — and only an `established` severity-5 `fail` in an active category can cap a score (`references/scoring-model.md`).

**Google AI-feature eligibility** — axis `ai`, confidence `established` except where noted; sources: Google *AI features and your website* and the robots-meta / `X-Robots-Tag` spec:
- `M14.ai_eligibility.not_indexable` — `noindex`/`none`, or Googlebot disallowed for this path (`fail`, severity **5** at site/template scope, **4** for a single page, `fixable: proposed`).
- `M14.ai_eligibility.nosnippet` — `nosnippet` in a meta tag or header (`fail`, severity **5** site/template, **4** single page, `fixable: proposed`).
- `M14.ai_eligibility.max_snippet_zero` — `max-snippet:0` (`fail`, severity **5** site/template, **4** single page, `fixable: proposed`).
- `M14.ai_eligibility.max_snippet_low` — a positive `max-snippet:N` below our **50-word** cutoff (`warn`, severity 2, `fixable: advisory`, confidence `directional` — the cutoff is ours, Google publishes no threshold).
- `M14.ai_eligibility.data_nosnippet_primary` — `data-nosnippet` wraps the H1 or the lead passage (`fail`, severity 4, `fixable: proposed`).
- `M14.ai_eligibility.data_nosnippet_partial` — `data-nosnippet` present but only around ancillary blocks (`pass`, severity 1).
- `M14.ai_eligibility.ok` — indexable and snippet-eligible, no suppressing directive (`pass`, severity 3).
- `M14.google_extended.blocked_info` — `Google-Extended` disallowed; informational, because it does not affect AI Overviews or AI Mode (`pass`, severity 1).

**Third-party crawler access** — axis `ai`:
- `M14.citation_bots.blocked` — a `Disallow` reaches `OAI-SearchBot` / `Claude-SearchBot` / `PerplexityBot` (or another retrieval bot) on the audited path (`fail`, severity 4, `fixable: auto`). Confidence is `established` only when at least one blocked token is vendor-documented *including* its robots.txt behaviour (`lib/bots.mjs` `robots_reliability: 'documented'` with a `doc_url`); when the block reaches only legacy or undocumented tokens (`Claude-Web`, `MistralAI-User`, or a `limited` one like `Meta-ExternalFetcher`) they are still listed as evidence, marked as such, and the confidence drops to `directional`. The citation loss itself is stated as `directional` in `rationale` either way.
- `M14.retrieval.allowed` — every retrieval/citation bot may fetch the audited path (`pass`, severity 4, confidence `directional`).
- `M14.render.content_js_only` — primary content, H1, or JSON-LD only in `rendered_html_path` (`warn`, severity 4, `fixable: advisory`, confidence `directional`).
- `M14.access.ai_bot_challenged` — an AI user-agent gets a challenge/interstitial or a near-empty body where the default UA gets the page (`warn`, severity 4, `fixable: advisory`, confidence `directional`).
- `M14.access.googlebot_blocked_at_edge` — the spoofed `Googlebot` UA is refused at the edge (`warn`, severity 2, `fixable: advisory`, confidence `speculative` — refusing an unverified spoof is legitimate defence; verify with reverse DNS before acting).

**Content-Signal** — axis `ai`, **never `established`** (no vendor documents compliance; the IETF draft expired 2026-04 and defines vocabulary only):
- `M14.content_signal.ai_input_no` — `ai-input=no` (`warn`, severity 3, `fixable: advisory`, `directional`): consent withheld for answer-engine input while the page stays fetchable.
- `M14.content_signal.search_no` — `search=no` (`warn`, severity 3, `fixable: advisory`, `directional`).
- `M14.content_signal.ai_train_no` — `ai-train=no` (`pass`, severity 1): a legitimate, low-cost preference that costs no citations.
- `M14.content_signal.malformed` — unknown key, non-`yes|no` value, or an unparseable pair (`warn`, severity 2, `fixable: auto`).
- `M14.content_signal.absent` — no `Content-Signal` line (`not_applicable`, severity 0 — absence is not a defect).

**Probes** (owned by the `geo` command, listed here because they carry the M14 prefix): `M14.probe.web_presence` and `M14.gsc_ai.impressions_present|zero_impressions|unavailable` are **severity 0**, live under `report.json.probes`, and never move or cap a score.

## Honesty
Google's own statements bound every claim in this module:
- A page reaches AI Overviews / AI Mode by being **indexed and snippet-eligible** in Search. There is no AI-specific file, token, schema type, or rewriting step that adds eligibility.
- **`Google-Extended` does not affect AI Overviews or AI Mode.** It limits training and Gemini/Vertex grounding. Blocking it is a training choice, not an AI-visibility choice.
- **Google Search ignores `llms.txt`.** It is reported under M21 at weight 0 and never moves the M14 category.
- Search Console's generative-AI report exposes **impressions only**, and the Search Analytics API exposes no AI dimensions (checked 2026-08) — the tool never claims API-level AI citation data.

Further caveats:
- **Content-Signal is metadata, not enforcement.** No AI vendor documents compliance with it; every `M14.content_signal.*` finding is `directional` at most. A `Disallow` line does the work — never present a signal as a substitute, and never call an `ai-input=no` page "blocked" when it is still served.
- **UA-diff results are spoofed-UA results.** We send the token, not a verified crawler: a site may legitimately refuse an unverified `Googlebot` string, and a CDN may serve a challenge to any unknown client. Treat divergence as a lead to verify (reverse DNS, server logs, Search Console URL Inspection), never as proof of cloaking. That is why `M14.access.googlebot_blocked_at_edge` is `speculative`.
- Blocking a **training** bot does not block the matching **search** bot — `GPTBot` ≠ `OAI-SearchBot`, `ClaudeBot` ≠ `Claude-SearchBot`. Most "block AI" guides get this wrong and cost the site citations.
- `Bytespider` and some user-fetchers (Meta documents that `Meta-ExternalFetcher` may bypass robots.txt) do not reliably honor `robots.txt`; a robots rule is best-effort and real enforcement needs an edge rule (advisory).
- `robots.txt` controls **crawling**, not **indexing** — to keep a page out of the index use `noindex` and do *not* also `Disallow` it, or the crawler never sees the directive.

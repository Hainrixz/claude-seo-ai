# AI crawlers & robots.txt control (2026)

The key distinction: **training bots** (used to train models) vs **search/retrieval bots** (fetch pages to answer live queries and may cite you) vs **user-triggered fetchers** (fetch a page because a user pasted/asked about it). You can allow citations while controlling training — but only if you target the right user-agents.

## User-agent reference

| User-agent | Operator | Purpose | Controllable via robots.txt |
|---|---|---|---|
| `Googlebot` | Google | Classic search index (also feeds AI Overviews) | Don't block |
| `Google-Extended` | Google | Gemini / Vertex training control | Yes |
| `Bingbot` | Microsoft | Bing search (feeds Copilot) | Don't block |
| `GPTBot` | OpenAI | Model **training** | Yes |
| `OAI-SearchBot` | OpenAI | ChatGPT **search/retrieval** (citations) | Yes — allow for citations |
| `ChatGPT-User` | OpenAI | **User-triggered** fetch | Yes (limited effect) |
| `ClaudeBot` | Anthropic | Model **training** | Yes |
| `Claude-SearchBot` | Anthropic | Claude **search/retrieval** (citations) | Yes — allow for citations |
| `Claude-User` / `Claude-Web` | Anthropic | User-triggered fetch | Yes |
| `PerplexityBot` | Perplexity | Crawl for retrieval (citations) | Yes — allow for citations |
| `Perplexity-User` | Perplexity | User-triggered fetch | Yes |
| `Applebot-Extended` | Apple | Apple Intelligence training control | Yes |
| `Meta-ExternalAgent` | Meta | Training | Yes |
| `Amazonbot` | Amazon | Indexing | Yes |
| `CCBot` | Common Crawl | Public dataset (feeds many models) | Yes |
| `Bytespider` | ByteDance | Training + search; **often ignores robots.txt** | Unreliable — recommend edge/WAF block |

User-agent strings drift; match case-insensitively and treat the table as a starting set. Verify a bot's current docs before making strong claims to a user.

## Presets the fixer can generate (choice-gated, opt-in)

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
Disallow:

# AI training — opt out
User-agent: GPTBot
User-agent: ClaudeBot
User-agent: Google-Extended
User-agent: Applebot-Extended
User-agent: CCBot
Disallow: /

Sitemap: https://example.com/sitemap.xml
```

**2. Allow all** (maximum visibility, includes training): `Disallow:` for everything.

**3. Block all AI** (search + training; reduces AI citations to ~zero): `Disallow: /` for every AI agent above. Tell the user this also kills AI-search visibility.

## Honesty notes

- Blocking a **training** bot does NOT block the matching **search** bot — they are separate user-agents. Many "block AI" guides get this wrong.
- `Bytespider` frequently ignores `robots.txt`; a robots rule is best-effort. Real enforcement needs an edge rule / WAF (advisory).
- `robots.txt` controls **crawling**, not **indexing**. To keep a page out of an index use a `noindex` robots meta tag (and don't also `Disallow` it, or the crawler can't see the `noindex`).

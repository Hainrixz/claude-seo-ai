# MCP & Data Tiers

claude-seo-ai is designed to work with **zero MCP servers and zero API keys**. Everything beyond that is opt-in. When a higher tier is unavailable, findings degrade to `needs_api` honestly — the tool never fabricates a measured value or returns a false `pass`.

## The three data tiers

| Tier | Requires | Unlocks | If unavailable |
|---|---|---|---|
| **0 — offline (default)** | Nothing — `WebFetch` + the bundled scripts | Raw-HTML audit: status/redirect chain, headers, `robots.txt`, sitemaps, `llms.txt`, and lab heuristics | This is the floor — always available |
| **1 — render + field CWV** | A render MCP (Playwright/Firecrawl) and/or a PageSpeed API key | Rendered DOM for SPA/CSR pages; real field Core Web Vitals (CrUX p75) via `scripts/psi-client.mjs` | Render-dependent and field-CWV findings → `needs_api` |
| **2 — authenticated** | Search Console / Merchant OAuth MCP (you add it yourself) | Real query/coverage/merchant data | Tier-2 findings → `needs_api` |

The `seo-crawl-render` skill builds one shared `PageSnapshot` and records the `tier` it actually reached. Downstream skills annotate any finding `needs_api` when it requires a higher tier than was reached.

## Tier 0 — what works with no setup

Building the `PageSnapshot` once is what makes the offline audit possible. At Tier 0 the crawler fetches with `WebFetch` only (`rendered_dom = null`) and you still get:

- Status and redirect chain, final response headers (incl. `X-Robots-Tag`, content-type, hreflang `Link`).
- `robots.txt`, referenced sitemap(s), and `/llms.txt`.
- The raw, pre-JS HTML the crawler and AI bots see first.
- **Lab heuristics** for Core Web Vitals — render-blocking resource count, missing image dimensions (CLS risk), large bundles (INP/LCP risk). These are clearly labeled **"lab data — not what Google ranks on"** and never drive the Search score on their own.

For a CSR-only page with no render MCP, the snapshot keeps `rendered_dom = null`, sets `render.confidence = reduced`, and emits a finding noting that the page was audited from raw HTML — it never pretends it saw rendered content it didn't.

## Tier 1a — opt into a render MCP

Render MCPs are **optional** and we **never auto-start them**. Enabling the plugin never forces a download or a credential prompt. To enable JavaScript rendering for SPA/CSR sites, copy the relevant entry from [`.mcp.json.example`](../../.mcp.json.example) into your project `.mcp.json` (or `mcpServers` in `~/.claude.json`) and approve it:

```jsonc
{
  "mcpServers": {
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    },
    "firecrawl": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": { "FIRECRAWL_API_KEY": "${FIRECRAWL_API_KEY}" }
    }
  }
}
```

When a render is needed **and** a render MCP is available, the crawler discovers it via tool search, captures the `rendered_dom`, and sets `render.confidence = high`. You only need one of the two; Firecrawl additionally needs `FIRECRAWL_API_KEY` in your environment.

## Tier 1b — real Core Web Vitals via `PSI_API_KEY`

Field CWV (the CrUX p75 data Google actually ranks on) comes from `scripts/psi-client.mjs`, which calls the Google PageSpeed Insights API. The key is **optional but recommended** — without a key or network, the client returns `status: "needs_api"` rather than guessing.

Set the key once in your environment:

```bash
export PSI_API_KEY="<your-free-pagespeed-key>"
```

Then run the client (it reads `PSI_API_KEY` from env if `--key` is omitted):

```bash
node scripts/psi-client.mjs --url https://example.com
node scripts/psi-client.mjs --url https://example.com --strategy desktop
node scripts/psi-client.mjs --url https://example.com --key "$PSI_API_KEY"
```

Flags: `--url` (required), `--strategy mobile|desktop` (default `mobile`), `--key` (overrides the env var). It reports field metrics rated against p75 thresholds, with lab data returned separately and explicitly marked **"NOT what Google ranks on."**

Field p75 thresholds (`references/cwv-thresholds.md`):

| Metric | Good | Needs improvement | Poor |
|---|---|---|---|
| **LCP** | ≤ 2.5 s | 2.5–4.0 s | > 4.0 s |
| **INP** (replaced FID) | ≤ 200 ms | 200–500 ms | > 500 ms |
| **CLS** | ≤ 0.1 | 0.1–0.25 | > 0.25 |

All three must pass at p75 for a "good" rating. Without a PSI key, every field-CWV finding is emitted as `needs_api` (severity 4, `fixable: advisory`) — never a false `pass`. CWV is a real but modest tie-breaker: it weighs heavily on the Search score and minimally on the AI Visibility score, so don't expect a green score to override relevance or content quality.

## Tier 2 — Search Console / Merchant OAuth

Tier 2 covers authenticated data sources (Search Console, Merchant) behind OAuth. These are **separate MCPs you add yourself** — they are not bundled and not in `.mcp.json.example`. Until you connect one, any finding that needs query, coverage, or merchant data degrades to `needs_api`.

## Graceful degradation, summarized

- **Tier 0 is always enough to run an audit.** No MCP, no key, no network OAuth required.
- Missing render MCP → CSR pages audited from raw HTML, `render.confidence = reduced`, with a finding telling you to install Playwright/Firecrawl for full coverage.
- Missing PSI key → field CWV reported as `needs_api`, accompanied only by clearly-labeled lab heuristics.
- Missing Tier-2 MCP → authenticated findings reported as `needs_api`.
- When the required tier is unavailable, the status is **`needs_api`** — never a fabricated metric and never a false `pass`.

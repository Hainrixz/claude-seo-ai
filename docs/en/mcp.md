# MCP & data tiers

`claude-seo-ai` is designed to work with **zero MCP servers and zero API keys**. Everything beyond
that is opt-in. When a higher tier is unavailable, findings degrade to `needs_api` honestly — the
tool never fabricates a measured value and never returns a false `pass`.

## The three data tiers

| Tier | Requires | Unlocks | If unavailable |
|---|---|---|---|
| **0 — default** | Nothing. The bundled zero-dependency Node scripts are the acquisition layer. | Real fetches: status/redirect chain, response headers, robots.txt, sitemaps (index recursion + gzip), AI discovery endpoints, the pre-JS HTML, and every static-HTML check | This is the floor — always available |
| **1 — rendered DOM and/or field CWV** | An installed Chrome/Chromium/Edge/Brave (auto-detected), or `playwright` already resolvable, or a DOM you captured yourself; and/or `PSI_API_KEY` | The post-JS DOM for SPA/CSR pages; real field Core Web Vitals (CrUX p75) | Render-dependent findings note `render.confidence = reduced`; field-CWV findings → `needs_api` |
| **2 — authenticated** | Search Console / Merchant Center (an MCP you add yourself), or a manual Search Console generative-AI export | Query/coverage/merchant data; the generative-AI impressions import | Tier-2 findings → `needs_api` |

The tier is **measured, not declared**: `report.mjs` sets tier 1 when at least one page was actually
rendered or PSI was actually used, and tier 2 when a Search Console import is present. It appears in
`report.json` as `tier` and in the audit summary.

## Tier 0 — what works with no setup at all

There is no `WebFetch` in the acquisition path. Inside Claude Code, `WebFetch` returns a small-model
markdown summary — never raw HTML, headers or status codes — so `scripts/snapshot.mjs` and
`scripts/crawl.mjs` do the fetching with Node's own `fetch`. At Tier 0 you already get:

- The full status and redirect chain, with loops and truncation flagged.
- Response headers, including `X-Robots-Tag`, content type and the parsed `Link:` header (canonical
  and hreflang alternates).
- `robots.txt` parsed with Google's REP precedence rules — plus `Content-Signal`, in both its global
  and per-group placements.
- Sitemaps, following index files and gzip.
- The AI discovery endpoints: `/llms.txt`, `/llms-full.txt`, `/agents.md`, `/.well-known/ucp`,
  `/.well-known/ai-catalog.json`, `/sitemap_agentic_discovery.xml` — reported at **weight 0**.
- The raw, pre-JS HTML that a crawler and an AI fetcher see first, fully parsed.
- Platform detection across four layers, and every deterministic check the registry can run on
  static HTML.
- **Lab heuristics** for Core Web Vitals — render-blocking resource count, missing image dimensions
  (CLS risk), heavy bundles (INP/LCP risk). These are clearly labeled **"lab data — not what Google
  ranks on"** and never drive the Search score on their own.

For a CSR-only page with no renderer, the snapshot keeps `rendered_html_path: null`, sets
`render.confidence = reduced`, records the hint, and emits an M4 finding saying the page was audited
from raw HTML. It never pretends it saw rendered content.

## Tier 1a — rendering

Rendering is opt-in twice over: you pass `--render auto` or `--render js` (the default is `static`,
so a headless run never launches a browser), **and** a renderer has to already exist. This project
installs nothing.

`findChrome()` looks, in order, at:

1. `$CLAUDE_SEO_AI_CHROME`, `$CHROME_PATH`, `$PUPPETEER_EXECUTABLE_PATH`
2. `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `chrome`, `msedge`,
   `brave-browser` on `PATH`
3. a Playwright browser cache (`$PLAYWRIGHT_BROWSERS_PATH`, `~/Library/Caches/ms-playwright`,
   `%LOCALAPPDATA%\ms-playwright`, `~/.cache/ms-playwright`)

If none is found you get the hint verbatim: *"No Chrome/Chromium/Edge/Brave found. Install one, set
`CLAUDE_SEO_AI_CHROME=<path to the browser binary>`, or pass `--rendered-file <dom.html>`."*

Playwright is used only when the `playwright` package already resolves from the working directory or
`$CLAUDE_PLUGIN_DATA/node_modules`; otherwise you get
*"Install with: `npm i -D playwright && npx playwright install chromium` (~150 MB). Or pass
`--rendered-file`."* Nothing downloads on your behalf.

```bash
node scripts/snapshot.mjs https://example.com --render auto            # detect a browser, render if needed
node scripts/snapshot.mjs https://example.com --render js --renderer chrome
node scripts/audit.mjs   https://example.com --render auto --pages 5
```

### `--rendered-file` — bring your own DOM (this is where a render MCP fits)

There is no MCP client inside the scripts. If you prefer a render MCP (Playwright, Firecrawl) or your
own headless script, capture the DOM with it and hand the file over:

```bash
node scripts/snapshot.mjs https://example.com --url https://example.com --rendered-file ./dom.html
```

The snapshot treats that file as the rendered pass: it is parsed into `parsed_rendered`, the render
delta is computed against the static HTML, and every rendering-sensitive check reads it. This is the
supported bridge between an MCP-captured DOM and the deterministic pipeline.

Render MCPs are **optional** and are **never auto-started** — enabling the plugin never forces a
download or a credential prompt. To add one, copy the relevant entry from
[`.mcp.json.example`](../../.mcp.json.example) into your project `.mcp.json` (or `mcpServers` in
`~/.claude.json`) and approve it:

```jsonc
{
  "mcpServers": {
    "playwright": { "type": "stdio", "command": "npx", "args": ["-y", "@playwright/mcp@latest"] },
    "firecrawl":  { "type": "stdio", "command": "npx", "args": ["-y", "firecrawl-mcp"],
                    "env": { "FIRECRAWL_API_KEY": "${FIRECRAWL_API_KEY}" } }
  }
}
```

You only need one. Firecrawl additionally needs `FIRECRAWL_API_KEY` in your environment.

## Tier 1b — real Core Web Vitals via `PSI_API_KEY`

Field CWV — the CrUX p75 data Google actually ranks on — comes from `scripts/psi-client.mjs`, which
calls the PageSpeed Insights API. The key is **optional**: without a key or without network, the
client returns `status: "needs_api"` rather than guessing.

The client reads `CLAUDE_PLUGIN_OPTION_PSI_API_KEY` first (what a plugin `userConfig` prompt
exports), then `PSI_API_KEY`:

```bash
export PSI_API_KEY="<your-free-pagespeed-key>"
node scripts/psi-client.mjs --url https://example.com
node scripts/psi-client.mjs --url https://example.com --strategy desktop
PSI_API_KEY="<key>" node scripts/psi-client.mjs --url https://example.com     # one-off
```

There is deliberately **no `--key` flag**, here or on `audit.mjs`: a secret on a command line lands in
`ps`, in shell history and in any command log — and these scripts print the command to re-run.

Field p75 thresholds ([`references/cwv-thresholds.md`](../../references/cwv-thresholds.md)):

| Metric | Good | Needs improvement | Poor |
|---|---|---|---|
| **LCP** | ≤ 2.5 s | 2.5–4.0 s | > 4.0 s |
| **INP** (replaced FID) | ≤ 200 ms | 200–500 ms | > 500 ms |
| **CLS** | ≤ 0.1 | 0.1–0.25 | > 0.25 |

All three must pass at p75 for a "good" rating. Without a key, every field-CWV finding is emitted as
`needs_api` — never a false `pass`. When PSI falls back to origin-level data because the URL has too
little traffic, that `origin_fallback` is surfaced rather than presented as the page's own numbers.

CWV is a real but modest tie-breaker: it weighs heavily on the Search score and minimally on AI
Visibility, so a green CWV score does not override relevance or content quality.

## Tier 2 — Search Console / Merchant Center

Tier 2 covers authenticated sources behind OAuth. These are **separate MCPs you add yourself** — they
are not bundled and not in `.mcp.json.example`. Until you connect one, any finding needing query,
coverage or merchant data degrades to `needs_api`.

The one Tier-2 path that works with no MCP at all is the **manual** generative-AI import: Google's
Search Analytics API exposes no AI dimensions, and no export separates AI surfaces from ordinary
search, so you download the Search Console **Generative AI** report by hand and pass the CSV:

```bash
node scripts/gsc-ai-import.mjs --csv ./search-console.csv --host example.com \
  > "<run_dir>/probes/gsc-generative-ai.json"
```

English and Spanish column headers are both accepted (with or without a BOM, quotes, or a semicolon
delimiter). **Impressions are the only figure treated as usable** — clicks and position are not
exposed per AI surface — and every finding it produces is **severity 0**, excluded from the score.
Redirecting it into the run's `probes/` directory is what makes `report.mjs` report it under
`probes.gsc_generative_ai` at tier 2.

## The optional Shopify docs oracle

[`.mcp.json.example`](../../.mcp.json.example) also carries `@shopify/dev-mcp`:

```jsonc
{ "shopify-dev": { "type": "stdio", "command": "npx", "args": ["-y", "@shopify/dev-mcp@latest"] } }
```

It is a **documentation and GraphQL schema oracle**, not a write path. Use it to answer "does this
field exist in this API version" before writing to a store. It never touches your store and holds no
credentials, and the Shopify adapters never require it — they fall back to their pinned API-version
constant. There is no official Shopify MCP that writes.

## Graceful degradation, summarized

- **Tier 0 is always enough to run an audit.** No MCP, no key, no OAuth.
- No renderer → CSR pages are audited from raw HTML with `render.confidence = reduced` and a finding
  that names the missing renderer and how to supply one.
- No PSI key → field CWV is `needs_api`, accompanied only by clearly-labeled lab heuristics.
- No Tier-2 source → authenticated findings are `needs_api`.
- Whenever the required tier is unavailable, the status is **`needs_api`** — never a fabricated
  metric, never a false `pass`, and never silently absent from the report.

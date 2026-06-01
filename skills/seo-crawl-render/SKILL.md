---
name: seo-crawl-render
description: Fetch a page (or local files) and build the shared PageSnapshot every audit module reads — raw HTML, rendered DOM when a render MCP is available, response headers, status/redirect chain, and site artifacts (robots.txt, sitemaps, llms.txt). Decides whether JavaScript rendering is needed and records the data tier.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-crawl-render

Produces ONE `PageSnapshot` consumed by all other skills. Building it once is what makes the offline (Tier 0) audit possible.

## PageSnapshot shape
```
{
  target: { kind: "url"|"path", value },
  status_chain: [ {url, status, location?} ],   // redirects, final status
  headers: { ... },                              // final response headers (incl. X-Robots-Tag, content-type, hreflang Link)
  raw_html: "...",                               // pre-JS HTML the crawler/AI sees first
  rendered_dom: "..."|null,                      // post-JS DOM (null if no render available)
  render: { needed: bool, used: "webfetch"|"playwright"|"firecrawl"|"none", confidence: "high"|"reduced" },
  artifacts: { robots_txt: "..."|null, sitemaps: [...], llms_txt: "..."|null },
  tier: 0|1|2
}
```

## Acquisition
1. **Local path**: read files directly (`Read`/`Glob`); treat built HTML as `raw_html`. For framework source (Next/Nuxt/etc.), note the framework and that rendered output may differ from source.
2. **URL**: fetch with `WebFetch` (HTTPS-upgrade; if it returns a cross-host redirect, re-fetch the target). Capture status chain and headers. Fetch `robots.txt`, referenced sitemap(s), and `/llms.txt`.

## Render decision
- `--render static` → never render. `--render js` → always try to render.
- `--render auto` (default): flag CSR when the raw HTML body is near-empty, has hydration markers (`__NEXT_DATA__`, `window.__NUXT__`, `data-reactroot`, a single root `<div id="app">`), or primary content/headings/links/JSON-LD are absent from `raw_html`.
- If rendering is needed AND a render MCP is available (Playwright/Firecrawl — discover via tool search), get the `rendered_dom`; set `render.confidence = high`.
- If needed but no render MCP: keep `rendered_dom = null`, set `render.confidence = reduced`, and emit an M4 finding: "CSR-only; audited from raw HTML; install a Playwright/Firecrawl MCP for full coverage." Never pretend you saw rendered content you didn't.

## Tier
Set `tier = 0` (WebFetch only), `1` (render MCP and/or PageSpeed available), `2` (Search Console / Merchant available). Downstream skills annotate findings `needs_api` when they require a higher tier than reached.

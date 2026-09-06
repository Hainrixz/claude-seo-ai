---
name: seo-crawl-render
description: Acquire a page or site into the shared PageSnapshot every audit module reads — real HTTP status chain, headers, robots directives, raw HTML on disk, parsed document, optional headless-Chrome render with a raw-vs-rendered delta, and once-per-run site artifacts (robots, sitemaps, AI discovery files). Acquisition is done by the bundled scripts (snapshot.mjs / crawl.mjs), never by WebFetch. Records the data tier reached.
allowed-tools: Read, Grep, Glob, Bash
---

# seo-crawl-render

Produces the `PageSnapshot` (v2) consumed by every module. The **scripts** fetch, parse, render, and persist; this skill decides which command to run and reads only its compact stdout summary. Claude Code's `WebFetch` returns a lossy model summary with no headers, status codes, or raw HTML and does not follow cross-host redirects — it is never the acquisition path.

## Acquisition
- Single page or local path: `node "${CLAUDE_PLUGIN_ROOT}/scripts/snapshot.mjs" <url|path> --out "${CLAUDE_PLUGIN_DATA}/runs" [--render auto|static|js] [--ua default|googlebot|bingbot|gptbot|oai-searchbot|claude-searchbot] [--renderer auto|chrome|playwright|none] [--rendered-file <dom.html>] [--max-bytes 5000000] [--json]` — a non-default `--ua` writes `pages/<slug>.ua-<preset>.json`.
- Multi-page: `node "${CLAUDE_PLUGIN_ROOT}/scripts/crawl.mjs" <url> [--pages 12] [--max 40] [--per-template 2] [--depth 3] --out "${CLAUDE_PLUGIN_DATA}/runs"` — homepage + target always, then at most `--per-template` pages per detected template, robots respected; every skip is logged in `crawl.json.sampling`. Also takes `--concurrency`, `--delay`, `--include`/`--exclude`, `--seeds`, `--sitemap-sample`, `--link-status` and `--no-robots`.
- Read the stdout summary only (run dir, slugs, counts, render verdict, warnings). **Never paste HTML into the conversation** — modules `Read` `pages/<slug>.json` and `Grep` `pages/<slug>.html`.
- Local directories are read as built HTML (`status: null`, empty headers). Framework source with no built output exits 2: build first or give the deployed URL.

## Render decision (lives in the script)
`--render auto` marks a render as needed on word count <150, hydration markers (`__NEXT_DATA__`, `__NUXT_DATA__`, `self.__next_f`, empty `#app`/`#__next` root) on a still-thin page, no h1 with <3 anchors, or a `<noscript>` JS notice. `--render static` never renders; `--render js` always tries. **The default differs by entry point**: `snapshot.mjs` defaults to `auto`, while `crawl.mjs` and `audit.mjs` default to `static` — a headless or multi-page run never launches a browser unless it is asked to.
- `--renderer auto` (the default) auto-detects headless Chrome/Chromium/Edge/Brave (`$CLAUDE_SEO_AI_CHROME` → `$CHROME_PATH` → `$PUPPETEER_EXECUTABLE_PATH` → PATH → default app paths → Playwright caches); `--renderer playwright` is opt-in and used only when already installed — **never auto-installed**; `--renderer none` disables rendering entirely; `--rendered-file <html>` accepts a DOM captured by a Playwright/Firecrawl MCP or by the user.
- When `render.needed && render.used === "none"`: the snapshot carries `confidence: reduced` and `render.hint`; emit `M4.render.not_rendered` as `needs_api` (severity 3, axis `both`, `fixable: advisory`) quoting the hint ("install Chrome, or pass `--rendered-file` from a render MCP"). Never pretend to have seen rendered content.

## PageSnapshot v2 — `<run_dir>/pages/<slug>.json`
```
{ target: {kind: "url"|"path", value},  request: {ua, accept_language, timeout_ms},
  status_chain: [{url, status, location, ms}],  redirects: {http_to_https, host_changed, www_normalized, trailing_slash_changed, hops},
  headers: {…},                                   // final response; set-cookie → cookie names only
  robots_directives: {header, meta: [], effective},
  body: {bytes, truncated, charset, sha256},  timing: {ttfb_ms, download_ms},
  raw_html_path, rendered_html_path,              // files beside the JSON; rendered is null when not rendered
  render: {needed, signals: [], used: "chrome"|"playwright"|"external"|"none", confidence: "high"|"reduced", available: [], hint, delta},
  parsed: {…},  parsed_rendered: {…}|null,         // parseDocument(): title, metas, robots_meta, canonicals, hreflang, anchors, headings, images, scripts, jsonld, landmarks, markers, word_count, text_sample …
  site: {robots: "site/robots.json", sitemaps: "site/sitemaps.json", discovery: "site/discovery.json"},
  tier: 0|1|2 }
```
Site artifacts are built once per run: `site/robots.json` (parsed REP + per-bot verdicts), `site/sitemaps.json` (index BFS, gzip, lastmod stats) + `site/sitemap-urls.txt`, `site/discovery.json` (probes for `/llms.txt`, `/llms-full.txt`, `/agents.md`, `/.well-known/ucp`, `/.well-known/ai-catalog.json`, `/sitemap_agentic_discovery.xml`, `/api/ucp/mcp`, and `http://` → HTTPS enforcement).

## Tiers
- **0 — scripts**: real status chain, headers, raw HTML, parsed document, site artifacts. Every audit reaches this; no render, no field data.
- **1 — plus a renderer and/or PSI**: auto-detected headless Chrome or opt-in Playwright (or `--rendered-file`), and/or a PageSpeed Insights key for field CWV.
- **2 — plus account data**: Search Console / Merchant Center access and a manual Search Console generative-AI export.
Modules mark a finding `needs_api` when it requires a higher tier than the snapshot's `tier` — never a silent pass.

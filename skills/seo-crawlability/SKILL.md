---
name: seo-crawlability
description: Audit and generate robots.txt and general crawl access for a page — verify robots.txt reachability and syntax, detect Disallow rules that block CSS/JS or important content, sanity-check crawl-delay, confirm a Sitemap directive, and assert overall crawl access for Googlebot/Bingbot. Module M1. Feeds the Search SEO score.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-crawlability (M1)

Crawl access is the precondition for every other search signal: if Googlebot/Bingbot can't fetch the page and its assets, nothing else ranks. This module covers general-purpose crawl access only. AI-specific bot directives (GPTBot, Claude-SearchBot, etc.) and `llms.txt` live in `seo-ai-crawlers` (M14/M21); see `references/ai-crawlers.md` for that boundary.

## Audits
Working from the PageSnapshot (`rendered_dom` if present, else `raw_html`) plus a fetch of `/robots.txt`:
1. **Reachability**: `/robots.txt` returns 200 (a 404 means "allow all" but is worth flagging; a 5xx can suspend crawling).
2. **Syntax**: each line is a valid directive (`User-agent`, `Disallow`, `Allow`, `Sitemap`, `Crawl-delay`); flag unknown tokens, missing `User-agent` group headers, and BOM/encoding issues.
3. **Asset blocking**: any `Disallow` that blocks CSS/JS, fonts, or `/wp-includes/`-style paths — this breaks rendering and is a leading cause of "page looks broken to Google" (cross-check with M-render).
4. **Content blocking**: `Disallow` rules that hide important indexable paths from `Googlebot`/`Bingbot`.
5. **Crawl-delay sanity**: a large `Crawl-delay` (or one applied to the global group) can starve crawl budget; note that Googlebot ignores `Crawl-delay` but Bingbot honors it.
6. **Sitemap directive**: presence of at least one absolute `Sitemap:` URL.
7. **Overall access**: resolve the effective ruleset for `Googlebot` and `Bingbot` against the audited URL — does it end up allowed?

## Fixes
Generated edits are a diff for `fix`, mapped to the schema `fixable` field:
- **AUTO**: remove an accidental `Disallow` of CSS/JS or a key content path (additive un-block, verifiable); add a missing absolute `Sitemap:` line; repair malformed syntax (e.g. `Dissallow` typo, missing colon, group with no `User-agent` header).
- **PROPOSED**: tightening `Crawl-delay` or restructuring `User-agent` groups — drafted, requires per-item accept because intent may be deliberate.
- **ADVISORY**: changing what is *intentionally* disallowed (private/staging paths) — never written by the tool.
Never fabricate a sitemap URL or path: if the canonical sitemap location is unknown, emit a clearly-marked `TODO` placeholder for the user to fill, or ask.

## Verification
- `node ${CLAUDE_SKILL_DIR}/../../scripts/parse-robots-sitemap.mjs --url <u>` — fetches and parses `/robots.txt`, resolves the effective allow/deny for the named agent + URL, and checks for the `Sitemap:` directive (method `robots_parse`).
- When `/robots.txt` cannot be fetched (network/auth/edge block) the status is `needs_api`, never a false `pass`.

## Findings
Emit findings per `schema/finding.schema.json`. Examples:
- `M1.robots.blocks_css_js` — a `Disallow` matches CSS/JS the rendered page loads (severity 5, fail, `fixable: auto`, axis `search`, confidence `established`).
- `M1.robots.blocks_googlebot` — effective ruleset disallows the audited URL for `Googlebot` (severity 5, fail, `fixable: proposed`, axis `search`, confidence `established`).
- `M1.sitemap.missing_directive` — no `Sitemap:` line in robots.txt (severity 5, warn, `fixable: auto`, axis `search`, confidence `directional`).
Each finding: `evidence.observed` quotes the offending robots.txt line (or the resolved verdict) verbatim; `verification.reproduce` is the runnable command above; `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
- `robots.txt` controls **crawling**, not **indexing**: a `Disallow`-ed page can still be indexed (URL-only) from external links. To keep a page out of the index use a `noindex` meta tag and do *not* also `Disallow` it, or the crawler can't see the `noindex`.
- A missing or 404 `robots.txt` is *not* a defect — it means "crawl everything." Don't report it as a fail; flag only as informational.
- `Crawl-delay` is ignored by Googlebot; recommending it as a Google ranking/crawl lever is a myth — scope advice to Bingbot and other honoring agents.

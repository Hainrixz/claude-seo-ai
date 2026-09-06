---
name: seo-crawlability
description: Audit and generate robots.txt and general crawl access for a page — verify robots.txt reachability and syntax, detect Disallow rules that block CSS/JS or important content, sanity-check crawl-delay, confirm a Sitemap directive, and assert overall crawl access for Googlebot/Bingbot. Module M1. Feeds the Search SEO score.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-crawlability (M1)

Crawl access is the precondition for every other search signal: if Googlebot/Bingbot can't fetch the page and its assets, nothing else ranks. This module covers general-purpose crawl access only. AI-specific bot directives (GPTBot, Claude-SearchBot, etc.) live in `seo-ai-crawlers` (M14) and AI discovery files (`llms.txt`, `agents.md`, UCP) in `seo-ai-discovery` (M21); see `references/ai-crawlers.md` for that boundary.

## Inputs
Work from the PageSnapshot named in your dispatch envelope: read `parsed` from `<run_dir>/pages/<slug>.json` plus `status_chain` and `headers`, and the parsed robots file in `<run_dir>/site/robots.json` (syntax, groups, Googlebot/Bingbot verdicts for the audited URL, `Sitemap:` lines); Grep `pages/<slug>.html` for verbatim evidence. Deterministic findings already emitted by `audit.mjs` are listed in `<run_dir>/findings.deterministic.json` — do not re-emit those ids; add model-judged findings only. If invoked directly with a URL/path and no snapshot exists, first run `node "${CLAUDE_PLUGIN_ROOT}/scripts/snapshot.mjs" <target> --out "${CLAUDE_PLUGIN_DATA}/runs"` and use the printed snapshot path.

## Audits
Working from the PageSnapshot (`parsed_rendered` when `render.used` is not `none`, else `parsed`) plus `site/robots.json`:
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
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/parse-robots-sitemap.mjs" --url <final_url> --path <audited path>` — fetches and parses `/robots.txt`, resolves the effective allow/deny for `Googlebot`/`Bingbot` **against the audited path** (not the root), and checks for the `Sitemap:` directive (method `robots_parse`). Use `--robots <robots_url>` or `--file <path>` for an offline robots file.
- When `/robots.txt` cannot be fetched (network/auth/edge block) the status is `needs_api`, never a false `pass`.

## Findings
Emit findings per `schema/finding.schema.json`; axis `search`. **Severity policy**: 5 is reserved for catastrophic, eligibility-killing facts at site/template scope; 4 major · 3 moderate · 2 minor · 1 cosmetic · 0 informational — and only an `established` severity-5 `fail` in an active category can cap a score (`references/scoring-model.md`).
- `M1.robots.blocks_googlebot` — the effective ruleset disallows the audited URL for `Googlebot` (`fail`, severity **5**, `fixable: proposed`, confidence `established`). Site-wide, this is the single most destructive robots defect there is; it stays at 5.
- `M1.robots.blocks_css_js` — a `Disallow` matches CSS/JS the rendered page loads, degrading how Google renders it (`fail`, severity **4**, `fixable: auto`, confidence `established`).
- `M1.robots.unreachable` — `/robots.txt` returns 5xx, which suspends crawling until it recovers (`fail`, severity 5 at site scope, `fixable: advisory`, confidence `established`).
- `M1.robots.syntax_error` — malformed directive, missing `User-agent` group header, or a BOM (`warn`, severity 3, `fixable: auto`, confidence `established`).
- `M1.sitemap.missing_directive` — no `Sitemap:` line in robots.txt (`warn`, severity **2**, `fixable: auto`, confidence `directional` — sitemaps are also discovered from Search Console and `/sitemap.xml`, so a missing directive is a convenience gap, not an access failure).
- `M1.crawl_delay.excessive` — a large `Crawl-delay` in the global group that starves honoring crawlers (`warn`, severity 2, `fixable: proposed`, confidence `directional`).
**Platform-conditional ids.** This module also emits 6 ids that fire only when `profile.json` names the platform (`shopify`, `wordpress`, `nextjs`). They are indexed in `references/routing.md` § Platform-conditional finding ids and specified in `references/platforms/<id>.md` §10.

Each finding: `evidence.observed` quotes the offending robots.txt line (or the resolved verdict) verbatim; `verification.reproduce` is the runnable command above; `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
- `robots.txt` controls **crawling**, not **indexing**: a `Disallow`-ed page can still be indexed (URL-only) from external links. To keep a page out of the index use a `noindex` meta tag and do *not* also `Disallow` it, or the crawler can never see the `noindex`.
- A missing or 404 `robots.txt` is *not* a defect — it means "crawl everything". Don't report it as a fail; flag it as informational. A **5xx** is different: it is treated as a full disallow while it lasts.
- `Crawl-delay` is ignored by Googlebot; recommending it as a Google crawl lever is a myth — scope the advice to Bingbot and other honoring agents.
- Resolve every verdict against the **audited path**, not `/`. A site that allows the root and disallows `/blog/` is a common shape, and a root-only check reports the wrong answer.
- On a preview or staging host a blanket `Disallow: /` is the expected configuration; the scorer suppresses `M1.robots.*` caps when `--environment preview|staging|local` is set (see `references/scoring-model.md`).

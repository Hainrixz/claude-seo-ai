---
name: seo-sitemaps
description: Audit and generate sitemaps and discovery files — validate XML sitemap presence/size/extensions/lastmod, check robots.txt referencing and sitemap-to-canonical consistency, reconcile orphans against the link graph, and produce repaired sitemap entries plus a robots.txt Sitemap line. Module M17. Feeds the Search SEO score.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-sitemaps (M17)

Sitemaps are the discovery contract you hand the crawler — they should list exactly the canonical, indexable URLs and nothing else. Schema rules for related markup: `references/schema-tier1.md`.

## Audits
Working from the PageSnapshot (`rendered_dom` if present, else `raw_html`) plus fetched `/sitemap.xml` and `/robots.txt`:
1. **Presence & validity**: locate XML sitemap(s) (`/sitemap.xml`, robots `Sitemap:` lines, sitemap index); parse as well-formed XML against the sitemaps.org schema.
2. **Size limits**: each sitemap `<=50,000` URLs and `<=50MB` uncompressed; if exceeded, expect a sitemap index splitting the set.
3. **Extensions**: where relevant, validate `image:`, `video:`, and `news:` namespace entries (correct namespace declared, required child elements present).
4. **lastmod accuracy**: `<lastmod>` is valid ISO 8601 and reflects real last-modified time — not a build-time stamp on every URL (which trains crawlers to ignore it).
5. **robots referencing**: at least one absolute `Sitemap:` line in `robots.txt`.
6. **Sitemap-to-canonical consistency**: no URL in the sitemap is `noindex`, redirected, 4xx/5xx, or non-canonical (self-referencing canonical only). Cross-check indexability with M-indexability.
7. **Orphan reconciliation**: diff sitemap URLs against the internal link graph — flag indexable pages absent from the sitemap and sitemap URLs unreachable by internal links.

## Fixes
- **AUTO**: generate or repair XML sitemap entries (correct `<loc>`, accurate `<lastmod>` from observed last-modified data, valid `image:`/`video:` extension children where media exists) and add an absolute `Sitemap:` line to `robots.txt`. These are additive/deterministic diffs for `fix`.
- **PROPOSED**: removing or splitting entries (e.g. dropping non-canonical/noindex URLs, sharding into a sitemap index) — drafted, accepted per-item.
- **ADVISORY**: changing site-wide lastmod strategy or canonical decisions — described, never written by the tool.
- **Never fabricate** lastmod times, media URLs, or canonical targets — pull from observed data, ask the user, or leave a clearly-marked `TODO` placeholder per the schema `fixable` contract.

## Verification
- Offline: `node ${CLAUDE_SKILL_DIR}/../../scripts/parse-robots-sitemap.mjs --url <u>` — method `xml_parse`: parses robots.txt + sitemap XML, checks well-formedness, size caps, namespace/extension validity, and the canonical/noindex consistency assertion.
- When the required data tier (live fetch of sitemap/robots, or the resolved link graph) is unavailable, status is `needs_api` — never a false `pass`.

## Findings
Emit findings per `schema/finding.schema.json`. Examples:
- `M17.sitemap.missing` — no XML sitemap found at `/sitemap.xml` or in robots.txt (status `fail`, severity 3, `fixable: auto`, axis `search`, confidence `established`).
- `M17.robots.no_sitemap_line` — sitemap exists but no `Sitemap:` line in robots.txt (status `warn`, severity 3, `fixable: auto`, axis `search`, confidence `established`).
- `M17.sitemap.noindex_url` — a `<loc>` in the sitemap points to a `noindex`/non-canonical URL (status `fail`, severity 3, `fixable: proposed`, axis `search`, confidence `established`).
Each finding: `evidence.observed` quotes the page/sitemap verbatim; `verification.reproduce` is the runnable command above; `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
- A sitemap is a discovery aid, not a ranking signal or an indexing guarantee — Google treats `<lastmod>`, `<priority>`, and `<changefreq>` as hints, and `<priority>`/`<changefreq>` are largely ignored, so don't promise ranking lift from tuning them (label any such tactic low-magnitude/directional).
- Submitting a sitemap won't force indexing of low-quality or non-canonical pages; orphan and canonical hygiene matters more than sitemap size.

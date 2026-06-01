---
name: seo-indexability
description: Audit a page's indexability and site health — canonical presence/validity (self vs cross-domain vs chain, canonical to redirect/404, the lethal canonical+noindex pair), robots meta and X-Robots-Tag noindex/nofollow, duplicate clusters, pagination signals, plus redirect chains/loops, 4xx/5xx and soft-404 internal links, mixed content, HTTP-to-HTTPS enforcement, orphan pages and click-depth — and generate self-referential canonical / noindex-removal fixes. Module M2 (covers M3 site health). Feeds the Search SEO score.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-indexability (M2)

If a page can't be crawled, indexed, or canonicalized correctly, every other signal is wasted — this is the floor under the Search score. Schema-side context: `references/schema-tier1.md`.

## Audits
Working from the PageSnapshot (`rendered_dom` if present, else `raw_html`) plus response headers:
1. **Canonical**: exactly one `<link rel="canonical">`; absolute HTTPS URL; classify self-referential vs cross-domain vs chained (canonical points to a URL that itself canonicalizes elsewhere). Flag canonical that resolves to a redirect or 4xx.
2. **Canonical + noindex**: the lethal combination on the *same* URL (a noindex page used as a canonical target, or a canonicalized page also carrying noindex) — contradictory signals that drop the page.
3. **Robots directives**: `<meta name="robots">` and the `X-Robots-Tag` header for `noindex`/`nofollow`/`none`; reconcile header vs meta (header wins).
4. **Duplicate clusters**: near-identical title/H1/body across URLs with no consolidating canonical.
5. **Pagination**: paginated series signals (self-canonical per page; do not canonicalize page 2+ to page 1 — that delists deep items).
6. **Site health (covers M3)**: redirect chains/loops (>1 hop = warn, >3 hops or loop = fail), internal links returning 4xx/5xx, soft-404 (200 status on an empty/"not found" page), mixed content (HTTP subresources on HTTPS), HTTP-to-HTTPS enforcement, orphan pages (no internal inlinks), and click-depth from the homepage.

## Fixes
- **AUTO** (`fixable: auto`): inject a single self-referential absolute-HTTPS `<link rel="canonical">` when absent; remove an accidental `noindex` on a page the user has confirmed should be indexed. Both are deterministic, additive/removal-only diffs for `fix`.
- **ADVISORY** (`fixable: advisory`): redirect chains/loops, status codes, HTTP-to-HTTPS, and mixed-content origin fixes live in server/CDN config — the tool never writes these; it reports the exact change.
- **PROPOSED** (`fixable: proposed`): duplicate-cluster consolidation (which URL is canonical is an editorial call) — draft a per-cluster canonical plan for the user to accept.
- Never fabricate which URL "should" win or whether a page is intentionally noindexed — ask the user or leave a clearly-marked TODO placeholder.

## Verification
- `dom_assert`: parse the rendered DOM for canonical/robots presence and value.
- `header_check`: fetch headers to read `X-Robots-Tag` and follow the redirect chain (status + `Location` per hop).
- When the required data tier is unavailable (no live fetch / no crawl graph for orphan & depth), status is `needs_api` — never a false `pass`.

## Findings
Findings conform to `schema/finding.schema.json`. Each carries `evidence.observed` quoting the page/header and a runnable `verification.reproduce`. Examples:
- `M2.canonical.noindex_conflict` — page is both canonical target and `noindex` (status `fail`, severity 4, `fixable: proposed`, axis `search`, confidence `established`).
- `M2.canonical.missing` — no `<link rel="canonical">` on an indexable page (status `warn`→`fail` if duplicates exist, severity 4, `fixable: auto`, axis `search`, confidence `established`).
- `M2.redirect.chain` — internal link traverses >1 hop before 200 (status `warn`, severity 4, `fixable: advisory`, axis `search`, confidence `established`).
- `M2.robots.unintended_noindex` — `X-Robots-Tag: noindex` on a page the user wants indexed (status `fail`, severity 4, `fixable: auto`, axis `search`, confidence `established`).

## Honesty
- A canonical is a *hint*, not a directive — Google may pick a different canonical; report it as strong consolidation, not a guarantee.
- `rel=next/prev` is no longer used by Google for pagination; don't recommend adding it as a ranking tactic — keep self-canonical per page instead.
- Click-depth and orphan status correlate with crawl priority but are not a documented ranking factor — flag as `directional`, never as an established score cap.

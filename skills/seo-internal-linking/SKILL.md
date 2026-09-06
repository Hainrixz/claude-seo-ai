---
name: seo-internal-linking
description: Audit and improve a site's internal-linking topology and semantic HTML — map pillar/cluster structure, count and grade contextual in-body links and anchor text, surface orphan pages and nav-heavy templates, and propose specific source→target link insertions. Module M10. Feeds the Search SEO score.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-internal-linking (M10)

Internal links distribute crawl priority and topical authority and tell search engines (and AI crawlers) how your pages relate. Reference: `references/schema-tier1.md` for the entity/`@id` linkage this topology should mirror; M6/seo-entity-linking owns external `sameAs`.

## Inputs
Work from the PageSnapshot named in your dispatch envelope: read `parsed` from `<run_dir>/pages/<slug>.json` (`anchors[]` with `region`/`internal`/`anchor`, `landmarks`) and the crawl graph in `<run_dir>/crawl.json` (`graph.edges`, `pages[].inlinks`, `templates[]`); Grep `pages/<slug>.html` for verbatim evidence; site artifacts live in `<run_dir>/site/{robots.json,sitemaps.json,discovery.json}`. Deterministic findings already emitted by `audit.mjs` are listed in `<run_dir>/findings.deterministic.json` — do not re-emit those ids; add model-judged findings only. If invoked directly with a URL/path and no snapshot exists, first run `node "${CLAUDE_PLUGIN_ROOT}/scripts/snapshot.mjs" <target> --out "${CLAUDE_PLUGIN_DATA}/runs"` and use the printed snapshot path.

## Audits
Working from the PageSnapshot (`parsed_rendered` when `render.used` is not `none`, else `parsed`):
1. **Pillar/cluster topology**: classify each URL (pillar hub vs. cluster page) and confirm clusters link up to their pillar and the pillar links down to its cluster — gaps break the hub-and-spoke model.
2. **Contextual in-body links**: count links inside `<main>`/`<article>` prose (target ~3-5 descriptive in-content links per page); flag pages with zero in-body internal links.
3. **Anchor-text descriptiveness**: flag generic anchors ("click here", "read more", "learn more", bare URLs) and over-optimized exact-match repetition; anchors should describe the destination.
4. **Orphan pages**: list URLs in the sitemap/crawl with no incoming internal links from other crawled pages.
5. **Nav-vs-in-content ratio**: flag templates where boilerplate nav/footer links overwhelm contextual links, diluting per-page link signal.
6. **Semantic HTML**: check for `<main>`, `<article>`, `<nav>`, `<header>`, `<footer>`, one `<h1>`, and a logical heading order — semantic structure helps both parsers and accessibility.

## Fixes
- **PROPOSED** (`fixable: proposed`): concrete internal-link insertions — a specific source page, the target URL, the suggested anchor text, and the sentence/selector to attach it to — emitted as a unified diff for `fix`. These require per-item accept because auto-injecting body links can alter meaning, tone, or reading flow.
- **ADVISORY** (`fixable: advisory`): wrapping content in semantic tags (`<main>`/`<article>`/`<nav>`) and heading-order corrections — described, never written by the tool, since they touch template structure.
- Never invent target URLs, anchor wording, or topology you cannot observe in the snapshot/crawl — ask the user or leave a clearly-marked TODO placeholder. (Severity for this module's findings: 3.)

## Verification
- Per page: `node "${CLAUDE_PLUGIN_ROOT}/scripts/link-graph.mjs" --snapshot <pages/<slug>.json>` (or `--url <u>` / `--file <path> --base <origin>`) returns that page's link profile (`verification.method: link_graph`): `total_links`, `internal_unique`, `external_unique`, `in_content_target`, `generic_anchors`, `empty_anchors`, `dropped`. It does **not** compute topology from one page.
- Site topology: read `<run_dir>/crawl.json` (`graph.edges`, `pages[].inlinks`, `templates[]`) — the crawl already built it. `--crawl [--max 25] [--max-depth 3] [--no-robots] [--ua <preset>]` runs a fresh shallow same-site crawl and adds a `crawl` block with `potential_orphans` (a crawled page with no inbound internal link from another crawled page; the start page is never one, and the script itself calls the list non-authoritative). Pillar/cluster judgement is model work on top of those edges, not a script output.
- The full topology/orphan check needs a site-wide crawl tier. When that crawl data is unavailable, status is `needs_api` — never a false `pass`.

## Findings
Emit findings per `schema/finding.schema.json`. Examples:
- `M10.contextual.too_few_inbody_links` — fewer than ~3 contextual in-body links (status `warn`, severity 3, `fixable: proposed`, axis `search`, confidence `directional`).
- `M10.anchor.generic_text` — anchor reads "click here"/"read more" (status `warn`, severity 3, `fixable: proposed`, axis `search`, confidence `directional`).
- `M10.orphan.no_incoming_links` — page has no internal inlinks from the crawl (status `fail`, severity 3, `fixable: advisory`, axis `search`, confidence `established`).
- `M10.semantic.missing_main` — no `<main>`/`<article>` landmark around primary content (status `warn`, severity 3, `fixable: advisory`, axis `search`, confidence `directional`).
Each finding: `evidence.observed` quotes the page (the anchor text, the link count, the offending element); `verification.reproduce` is the runnable `link-graph.mjs` command above; `expected_impact` is banded + confidence-tagged (no naked percentages).

## Honesty
- A fixed "3-5 links per page" is a usability/structure heuristic, not a ranking law — treat the count as directional and never cap a score on it alone.
- Exact-match anchor stuffing and "more links = more authority" are myths: relevance and editorial context matter more than raw count, and excess can look manipulative. Recommend links only where they genuinely help the reader.

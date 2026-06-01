---
name: seo-headings-structure
description: Audit and propose fixes for a page's heading hierarchy and semantic outline — verify exactly one H1, logical H2-H6 nesting with no skipped levels, descriptive heading text, and HTML5 landmarks (article/section/nav/main/footer) — so the document outline is extractable. Module M7c. Feeds the Search SEO score (clean headings also support AI answer-block extraction, which is scored separately under M11).
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-headings-structure (M7c)

A clean, single-rooted heading tree and proper semantic landmarks make a page's outline machine-readable — the same structure that AI engines use to extract answer blocks and that search engines use to understand content scope. Schema/entity context: `references/schema-tier1.md`.

## Audits
Working from the PageSnapshot (`rendered_dom` if present, else `raw_html`):
1. **Single H1**: exactly one `<h1>` per page. Zero H1s, or multiple H1s, are both findings.
2. **No skipped levels**: nesting descends one level at a time (an `<h2>` may be followed by `<h3>`, not directly by `<h4>`). Build the outline and flag any jump.
3. **Descriptive text**: each heading names its section in human terms — flag empty headings, headings used purely for visual styling, and generic placeholders ("Section 1", "Welcome").
4. **Semantic landmarks**: detect `<main>`, `<article>`, `<section>`, `<nav>`, `<header>`, `<footer>`; flag when headings live inside non-semantic `<div>` soup or when more than one `<main>` exists.
5. **Outline ↔ landmark agreement**: sectioning elements should carry their own heading; orphan landmarks and headings outside any landmark are findings.

Good heading structure feeds AI answer-block extraction: clear H2/H3 boundaries map to candidate quotable passages.

## Fixes
- **Heading-level restructuring** — re-leveling H2-H6 to remove skips or to nest correctly (fixable: **proposed**). This alters the visual hierarchy, so it requires per-item accept; emit a `fix_preview` diff, never an auto-write.
- **Add a single missing H1** — when the page has no H1, propose one sourced from the populated `<title>`/`og:title` or the obvious page-title element (fixable: **proposed**, per-item accept — adding a visible heading is editorial). Never fabricate H1 text from thin content; ask the user if the source is ambiguous.
- **Wrap in semantic landmarks** — recommending `<main>`/`<article>` adoption is **advisory** (structural refactor the tool does not write).

Mark each finding's `fixable` field consistent with `schema/finding.schema.json` (`auto` / `proposed` / `advisory`). Never fabricate a heading's text or invent an H1 from thin content — ask the user or leave a clearly-marked `TODO` placeholder.

## Verification
- Method: `dom_assert`. Re-parse the snapshot, rebuild the outline, and assert the specific condition (one H1, no level skip, landmark present).
- Offline reproduce: `node ${CLAUDE_SKILL_DIR}/../../scripts/parse-html.mjs --url <u>` (or `--file <path>`) — returns the `headings` block (`counts` per level, `h1_count`, and `skipped_levels`), which counts H1s and walks the H1-H6 tree for skipped levels.
- When the rendered DOM tier is required but unavailable (heading injected client-side and only `raw_html` is present), status is `needs_api`, never a false `pass`.

## Findings
Emit findings per `schema/finding.schema.json`. Examples:
- `M7c.h1.multiple` — more than one `<h1>` on the page (status `fail`, severity 3, `fixable: proposed`, axis `search`, confidence `established`). `evidence.observed` quotes each H1's text and selector; `verification.reproduce` is the `parse-html.mjs` command above (inspect `h1_count`).
- `M7c.outline.skipped_level` — an `<h2>` followed directly by an `<h4>` (status `fail`, severity 3, `fixable: proposed`, axis `search`, confidence `directional`). `evidence.observed` quotes the two adjacent headings and their levels.
- `M7c.landmark.no_main` — no `<main>` element; primary content sits in `<div>`s (status `warn`, severity 3, `fixable: advisory`, axis `search`, confidence `directional`).

Each finding carries `evidence.observed` quoting the page verbatim and a runnable `verification.reproduce`; `expected_impact` is banded + confidence-tagged (no naked percentages).

## Honesty
- Heading **keyword stuffing** does not buy ranking — write headings for the reader; clarity is the signal, not keyword density. Don't recommend cramming terms into H1/H2.
- Multiple H1s are valid HTML5 and modern parsers/AI tolerate them; the real cost is a muddied outline, so treat as severity 3 `directional`, not a critical failure. Skipped heading levels are primarily an **accessibility/structure** concern — frame impact honestly (directional) rather than promising a ranking lift.

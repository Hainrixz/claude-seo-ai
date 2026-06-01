---
name: seo-mobile
description: Audit mobile-friendliness of a page from the PageSnapshot — verify the viewport meta, no horizontal-scroll/fixed-width layouts, adequate tap targets, legible base font, and mobile/desktop content parity — and generate the viewport meta when missing. Module M7b. Feeds the Search SEO score.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-mobile (M7b)

Google indexes mobile-first: the mobile rendering of a page is the canonical one for ranking. This module checks that a page is usable on a small viewport. Layout problems that hurt mobile usability often surface as CLS — cross-check `references/cwv-thresholds.md`.

## Audits
Working from the PageSnapshot (`rendered_dom` if present, else `raw_html`):
1. **Viewport meta**: a `<meta name="viewport">` exists with `width=device-width` and `initial-scale=1`. Flag missing, fixed-width (`width=1024`), or zoom-blocking (`user-scalable=no`, `maximum-scale=1`) values — the last also harms accessibility.
2. **No horizontal scroll**: detect fixed-width containers / large absolute widths that force the viewport wider than the device (content overflowing a ~360 px small viewport).
3. **Tap-target size**: interactive elements (links, buttons, form controls) should be large enough and spaced so adjacent targets are not easily mis-tapped.
4. **Legible base font**: body text rendered at a readable base size, not a desktop-only small size that forces pinch-zoom on mobile.
5. **Content parity**: the mobile DOM must contain the same primary content, headings, structured data, and links as desktop — mobile-first indexing ranks what is in the mobile render, so hidden/stripped mobile content is a ranking risk.

## Fixes
- **AUTO** (`fixable: auto`): inject `<meta name="viewport" content="width=device-width, initial-scale=1">` into `<head>` when absent. Deterministic, additive, verifiable — emitted as a diff for `fix`.
- **ADVISORY** (`fixable: advisory`): fixed-width/overflow layouts, tap-target sizing, base-font, and parity gaps depend on CSS, design system, and JS — high breakage risk. The tool diagnoses and prioritizes but does **not** auto-edit layout code. **Never invent** breakpoint values or pixel sizes — report observed values or leave a clearly-marked TODO for the user.

## Verification
- Method `dom_assert`: assert against the snapshot (viewport meta presence/content, computed widths, target geometry).
- Reproduce the deterministic part (viewport meta presence/content) offline: `node ${CLAUDE_SKILL_DIR}/../../scripts/parse-html.mjs --url <u>` (or `--file <path>`) — inspect `head_hygiene.viewport`. Tap-target/overflow geometry is a `manual_review` pass over the rendered snapshot.
- Tap-target and overflow checks need the **rendered** snapshot (computed layout). When only `raw_html` is available and layout cannot be resolved, status is `needs_api`, never a false `pass`.

## Findings
Emit findings per `schema/finding.schema.json`. Examples:
- `M7b.viewport.missing` — no viewport meta (status `fail`, severity 3, `fixable: auto`, axis `search`, confidence `established`).
- `M7b.viewport.user_scalable_no` — viewport disables zoom (status `warn`, severity 3, `fixable: advisory`, axis `search`, confidence `established`).
- `M7b.layout.horizontal_scroll` — content overflows the small viewport (status `fail`, severity 3, `fixable: advisory`, axis `search`, confidence `directional`).
- `M7b.taptarget.too_small` — interactive targets too small/close (status `warn`, severity 3, `fixable: advisory`, axis `search`, confidence `directional`).

Each finding: `evidence.observed` quotes the page (the meta tag string, the overflowing selector/width, the target geometry); `verification.reproduce` is the runnable command above; `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
- Mobile-friendliness is a usability baseline, not a strong positive ranking lever — a fast, well-built desktop-only site does not get a ranking *boost* for adding a viewport tag; it removes a usability liability. Frame fixes as removing risk, not gaining rank.
- Google retired the standalone "Mobile-Friendly Test" tool and the page-experience badge; there is no single mobile-friendly ranking flag to "win." Don't ship that myth.
- A present viewport meta does not prove the layout is actually responsive — confirm with the rendered snapshot, don't infer responsiveness from the tag alone.

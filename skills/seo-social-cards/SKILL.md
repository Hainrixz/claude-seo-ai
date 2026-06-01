---
name: seo-social-cards
description: Audit and generate Open Graph and Twitter/X social-card tags for a page — check og:title/description/url/type, og:image presence/size/reachability, and twitter:card/title/description/image, then inject complete card tags inferred from the page. Module M8. Feeds the Search SEO score.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-social-cards (M8)

Social cards control how a URL renders when shared on social, chat, and AI assistants — a CTR/sharing signal, not a ranking one (see Honesty). Open Graph metadata is the same `<head>`-level hygiene tier as the structured-data work in `references/schema-tier1.md`, so audit it alongside that module.

## Audits
Working from the PageSnapshot (`rendered_dom` if present, else `raw_html`):
1. **OG content**: `og:title`, `og:description`, `og:url`, `og:type` present and non-empty; `og:url` matches the canonical; `og:type` sane for the page (e.g. `article` vs `website`).
2. **OG image**: `og:image` present, ~1200x630 (1.91:1) and >=200x200, and **reachable** (HTTP 200, image content-type, absolute URL).
3. **Twitter/X**: `twitter:card` (prefer `summary_large_image`); `twitter:title`, `twitter:description`, `twitter:image`. Twitter falls back to OG when these are absent — note when it is relying on OG.
4. **Fallback behavior**: when OG is absent entirely, record what crawlers would derive (`<title>`, meta description, first content `<img>`) so the finding shows the actual degraded card, not a guess.

## Fixes
- **AUTO** (`fixable: auto`): inject a complete OG + Twitter card block derived from the page's `<title>`/`<h1>`, meta description, canonical URL, and first in-content image. Additive, deterministic, emitted as a diff for `fix`.
- The tool **cannot create an image asset**. It wires `og:image`/`twitter:image` once a real path exists; until then it leaves a clearly-marked `TODO` placeholder (no invented URL or dimensions). Never fabricate title/description text — derive from on-page content or leave the user a `TODO`.

## Verification
- `dom_assert`: the required `<meta property="og:*">` / `<meta name="twitter:*">` tags exist and are non-empty.
- `header_check`: `og:image` returns 200 with an image content-type, and dimensions are ~1200x630.
- When the image fetch or dimension probe is blocked (no network/egress), status is `needs_api`, never a false `pass`.

## Findings
Emit findings per `schema/finding.schema.json`. Examples:
- `M8.og.missing_image` — no `og:image` (status `fail`, severity 2, `fixable: auto`, axis `search`, confidence `established`).
- `M8.og.image_unreachable` — `og:image` set but returns non-200 / wrong type (status `fail`, severity 2, `fixable: proposed`, axis `search`, confidence `established`).
- `M8.twitter.no_card` — no `twitter:card`, page falls back to OG only (status `warn`, severity 2, `fixable: auto`, axis `search`, confidence `directional`).
Each finding: `evidence.observed` quotes the tag(s) (or their absence) on the page; `verification.reproduce` is a runnable `dom_assert`/`header_check` command; `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
Social cards are a sharing / click-through signal with **near-zero direct ranking impact** — Google does not use OG tags as a ranking factor. They improve how shared links and AI-assistant previews render, not where the page ranks. Fix them for CTR and brand consistency; do not over-invest expecting SERP movement.

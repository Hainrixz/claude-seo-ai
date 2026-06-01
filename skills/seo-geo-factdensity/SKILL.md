---
name: seo-geo-factdensity
description: Audit fact density and sourcing on a page — measure statistic/number density per passage, detect proprietary/original data, count outbound citations to authoritative sources, and flag claims made without a supporting stat or source. Module M12. Feeds the AI Visibility score. Advisory-only; never fabricates statistics or sources.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-geo-factdensity (M12)

Generative engines preferentially cite passages that are concrete, quantified, and attributable. This module measures how "citable" the page's prose is — facts, numbers, original data, and authoritative outbound links — not vocabulary. AI retrieval/citation context: `references/ai-crawlers.md`.

## Audits
Working from the PageSnapshot (`rendered_dom` if present, else `raw_html`):
1. **Statistic/number density** per passage: tokenize the main content into passages (paragraph / `<li>` / heading-bounded block) and count numeric tokens — figures, percentages, dates, quantities, ranges. Flag long passages of pure assertion with zero numeric support.
2. **Proprietary/original data**: detect first-party-data signals — patterns like "our study", "our survey", "our data", "we analyzed", "we surveyed", "in our test", "internal data" — and note whether such claims are backed by a method/sample, a table, or a chart.
3. **Outbound citations**: count outbound links from the main content to authoritative sources (standards bodies, primary research, official docs, `.gov`/`.edu`, named publications); distinguish them from internal/nav/affiliate links.
4. **Claim-without-source flags**: detect strong factual or comparative claims ("the most", "fastest", "studies show", superlatives, hard numbers) that carry no inline citation or data reference, and mark each as a candidate for sourcing.

## Fixes (fixable: advisory)
ADVISORY only — this module proposes nothing it would write. It produces a list of (a) claims that should carry a statistic or citation, (b) passages where an original-data callout (table, "our data" box, methodology note) would raise citability, and (c) unsupported superlatives to soften or source. The tool will **NOT** fabricate statistics, sample sizes, study results, or source URLs. Where a value is missing, it emits a clearly-marked `TODO` placeholder for the user to fill — never an invented number. (Findings here are `fixable: advisory` per the finding schema.)

## Verification
- Heuristic: `manual_review` plus deterministic counts — numeric-token density per passage and outbound-authority link count — computed from the snapshot. Report the raw counts so a human can re-derive them.
- Judgment calls (is this claim "strong"? is this source "authoritative"?) require `manual_review`; do not auto-`pass` them.
- When the content tier or rendered DOM needed to count passages reliably is unavailable, status is `needs_api`, never a false `pass`.

## Findings
Emit findings per `schema/finding.schema.json`. Examples:
- `M12.density.low_numeric_passages` — multiple main-content passages with zero numeric support (status `warn`, severity 4, `fixable: advisory`, axis `ai`, confidence `directional`).
- `M12.citations.no_outbound_authority` — main content makes factual claims but links to zero authoritative outbound sources (status `warn`, severity 4, `fixable: advisory`, axis `ai`, confidence `directional`).
- `M12.claim.unsourced_superlative` — a superlative/comparative claim with no inline citation or data (status `warn`, severity 1, `fixable: advisory`, axis `ai`, confidence `speculative`).
Each finding: `evidence.observed` quotes the exact passage/claim from the page; `verification.reproduce` is the runnable count (e.g. `node scripts/factdensity.mjs --url <u>`); `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
- Refuse "AI-specific keyword" rewrites — there is no magic vocabulary that wins citations. Citability comes from extractable structure, **verifiable** facts, and demonstrable authority, not phrasing tricks.
- Never invent a statistic, sample size, or source to "fill" a flagged claim. Quantification only helps if it is true and attributable; a fabricated number is a liability, not a win.
- Density is a means, not an end — flag stuffing numbers into prose that doesn't warrant them as its own anti-pattern.

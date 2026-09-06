---
name: seo-geo-factdensity
description: Audit fact density and sourcing on a page — measure statistic/number density per passage, detect proprietary/original data, count outbound citations to authoritative sources, and flag claims made without a supporting stat or source. Module M12. Feeds the AI Visibility score. Advisory-only; never fabricates statistics or sources.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-geo-factdensity (M12)

Generative engines preferentially cite passages that are concrete, quantified, and attributable. This module measures how "citable" the page's prose is — facts, numbers, original data, and authoritative outbound links — not vocabulary. AI retrieval/citation context: `references/ai-crawlers.md`.

## Inputs
Work from the PageSnapshot named in your dispatch envelope: read `parsed` from `<run_dir>/pages/<slug>.json` (`anchors[]` for outbound links, `text_sample`) and the HTML file for passage-level counts; Grep `pages/<slug>.html` for verbatim evidence; site artifacts live in `<run_dir>/site/{robots.json,sitemaps.json,discovery.json}`. Deterministic findings already emitted by `audit.mjs` are listed in `<run_dir>/findings.deterministic.json` — do not re-emit those ids; add model-judged findings only. If invoked directly with a URL/path and no snapshot exists, first run `node "${CLAUDE_PLUGIN_ROOT}/scripts/snapshot.mjs" <target> --out "${CLAUDE_PLUGIN_DATA}/runs"` and use the printed snapshot path.

## Audits
Working from the PageSnapshot (`parsed_rendered` when `render.used` is not `none`, else `parsed`):
1. **Statistic/number density** per passage: tokenize the main content into passages (paragraph / `<li>` / heading-bounded block) and count numeric tokens — figures, percentages, dates, quantities, ranges. Flag long passages of pure assertion with zero numeric support.
2. **Proprietary/original data**: detect first-party-data signals — patterns like "our study", "our survey", "our data", "we analyzed", "we surveyed", "in our test", "internal data" — and note whether such claims are backed by a method/sample, a table, or a chart.
3. **Outbound citations**: count outbound links from the main content to authoritative sources (standards bodies, primary research, official docs, `.gov`/`.edu`, named publications); distinguish them from internal/nav/affiliate links.
4. **Claim-without-source flags**: detect strong factual or comparative claims ("the most", "fastest", "studies show", superlatives, hard numbers) that carry no inline citation or data reference, and mark each as a candidate for sourcing.

## Fixes (fixable: advisory)
ADVISORY only — this module proposes nothing it would write. It produces a list of (a) claims that should carry a statistic or citation, (b) passages where an original-data callout (table, "our data" box, methodology note) would raise citability, and (c) unsupported superlatives to soften or source. The tool will **NOT** fabricate statistics, sample sizes, study results, or source URLs. Where a value is missing, it emits a clearly-marked `TODO` placeholder for the user to fill — never an invented number. (Findings here are `fixable: advisory` per the finding schema.)

## Verification
- Deterministic counts plus `manual_review`: `node "${CLAUDE_PLUGIN_ROOT}/scripts/factdensity.mjs" --snapshot <pages/<slug>.json> [--lang en|es|auto]` (or `--url <u>`) returns numeric-token density per passage — split into `all` / `years` / `prices` / `substantive` — and the outbound-authority link count. Report the raw counts so a human can re-derive them; a page whose only "numbers" are a copyright year and a price is **not** fact-dense, which is why `substantive` is the count that matters.
- **Language coverage**: authority-host rules, superlative lexicons, and original-data phrases ship for EN and ES (including `.gob.mx`, `.gov.uk`, `scielo.org`). Outside those languages the language-dependent fields come back `null`, never 0, and the finding is `manual_review`.
- Judgment calls (is this claim "strong"? is this source "authoritative"?) require `manual_review`; do not auto-`pass` them.
- When the content tier or rendered DOM needed to count passages reliably is unavailable, status is `needs_api`, never a false `pass`.

## Findings
Emit findings per `schema/finding.schema.json`; axis `ai`; `fixable: advisory` throughout. **Severity policy**: 5 is reserved for catastrophic, eligibility-killing facts at site/template scope; 4 major · 3 moderate · 2 minor · 1 cosmetic · 0 informational — and only an `established` severity-5 `fail` in an active category can cap a score (`references/scoring-model.md`). Nothing in M12 is `established`, so nothing here ever caps.
- `M12.density.low_numeric_passages` — multiple main-content passages with zero substantive numeric support (`warn`, severity **3**, confidence `directional`).
- `M12.citations.no_outbound_authority` — the main content makes factual claims and links to no authoritative outbound source (`warn`, severity **3**, confidence `directional`).
- `M12.original_data.missing` — a topic that invites first-party evidence (benchmark, survey, pricing study) carries none (`warn`, severity **3**, confidence `directional`).
- `M12.original_data.present` — a first-party data claim backed by a method, sample, table, or chart (`pass`, severity 3, confidence `directional`).
- `M12.claim.unsourced_superlative` — a superlative/comparative claim with no inline citation or data (`warn`, severity 1, confidence `speculative`).
- `M12.lang.unsupported` — the page language is outside the EN/ES lexicons, so density and authority scoring cannot decide (`manual_review`, severity 0; language-dependent fields `null`).
Each finding: `evidence.observed` quotes the exact passage/claim from the page; `verification.reproduce` is the runnable count above; `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
- **What Google actually asks for is unique, non-commodity content** — information that is not already available on every other page on the topic, produced by people with first-hand experience. Numeric density and outbound citations are our **proxies** for that, not the thing itself; they are `directional` and they are never `established`. A page can be dense with numbers and still be commodity content.
- Refuse "AI-specific keyword" rewrites — there is no magic vocabulary that wins citations. Citability comes from extractable structure, **verifiable** facts, and demonstrable authority, not phrasing tricks.
- Never invent a statistic, sample size, or source to "fill" a flagged claim. Quantification only helps if it is true and attributable; a fabricated number is a liability, not a win.
- Density is a means, not an end — stuffing numbers into prose that does not warrant them is its own anti-pattern, and this module flags it as one.
- Outside EN/ES the honest answer is `manual_review`, not a pass: a zero count in a language we cannot tokenize is a gap in the tool, not a finding about the page.

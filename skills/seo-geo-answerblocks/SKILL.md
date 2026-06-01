---
name: seo-geo-answerblocks
description: Audit and generate answer-extractable content — verify each question heading is followed by a ~40-60 word direct answer, passages are self-contained (~134-167 words, no unresolved anaphora), and lists/tables/definitions/TL;DR blocks exist; draft answer-block and summary rewrites for the user to accept. Module M11. Feeds the AI Visibility score.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-geo-answerblocks (M11)

AI engines cite passages they can lift whole, without surrounding context — so passage structure is the highest-leverage on-page AI signal. This module checks extractability; for who is allowed to fetch and cite the page, see `references/ai-crawlers.md`.

## Audits
Working from the PageSnapshot (`rendered_dom` if present, else `raw_html`):
1. **Heading → direct answer**: for each H2/H3 that reads as a question (or implies one), is the first paragraph a direct, ~40-60 word answer — not a windup ("In this section we'll explore…")?
2. **Self-contained passages**: are top-level passages ~134-167 words and answerable on their own? Flag unresolved anaphora ("as mentioned above", "this", "the latter") that needs prior context to parse.
3. **Structured forms**: presence of lists, comparison tables, and explicit term **definitions** where the content warrants them — these are disproportionately quoted.
4. **Question-shaped headings**: do headings phrase real user questions (how/what/why/when), matching likely prompts?
5. **TL;DR / summary blocks**: an up-front summary or key-takeaways block the engine can extract verbatim.
6. **Semantic completeness**: can each passage answer its heading with zero external context — the strongest single correlate of AI citation. This is the check that gates the score.

## Fixes
- **PROPOSED**: answer-block rewrites (heading → tight 40-60 word lead) and TL;DR drafts, generated from existing page content, surfaced one item at a time for the user to accept/edit. Each becomes a `fix_preview` diff only after acceptance.
- **ADVISORY**: structural suggestions ("split this 400-word passage", "add a definition list here") where intent is editorial.
- **Never** silently rewrite published prose, and never invent facts to fill a passage — if a claim is missing leave a clearly-marked `TODO` placeholder for the user. No finding here is `auto`.

## Verification
- Method is `manual_review`. The deterministic part is reproducible offline: word-count windows (answer 40-60w; passage 134-167w), question-heading detection, anaphora openers, and TL;DR presence via `node ${CLAUDE_SKILL_DIR}/../../scripts/check-answerblocks.mjs --url <u>` (or `--file <path>`). Use `manual_review` as the finding's `verification.method` (the enum has no `heuristic` value); the script is the `verification.reproduce` command.
- Semantic completeness and anaphora resolution still require a judgment pass; when that pass or the rendered DOM is unavailable, status is `needs_api` (or `warn`), **never** a false `pass`.

## Findings
Findings conform to `schema/finding.schema.json`. Examples:
- `M11.heading.no_direct_answer` — a question H2 followed by a windup, not an answer (status `fail`, severity 5, `fixable: proposed`, axis `ai`, confidence `directional`).
- `M11.passage.unresolved_anaphora` — passage opens with "As mentioned above…" and is not self-contained (status `warn`, severity 5, `fixable: proposed`, axis `ai`, confidence `directional`).
- `M11.summary.missing_tldr` — no up-front summary/key-takeaways block on a long-form page (status `warn`, severity 2, `fixable: proposed`, axis `ai`, confidence `directional`).
Each finding's `evidence.observed` quotes the page (heading text + first sentence, or the offending clause) and `verification.reproduce` is the runnable command above; `expected_impact` is banded + confidence-tagged with no naked percentage.

## Honesty
- Word-count windows are heuristics from observed AI-citation patterns, not engine-published thresholds — they are `directional`, not `established`; flag a passage, don't hard-fail purely on length.
- Adding a "TL;DR" label or stuffing question headings does nothing if the passage still can't answer standalone — semantic completeness is what carries weight, formatting alone is a myth this tool does not ship.

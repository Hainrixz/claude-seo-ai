---
name: seo-geo-answerblocks
description: Audit and generate answer-extractable content — verify each question heading is followed by a ~40-60 word direct answer, passages are self-contained (~134-167 words, no unresolved anaphora), and lists/tables/definitions/TL;DR blocks exist; draft answer-block and summary rewrites for the user to accept. Module M11. Feeds the AI Visibility score.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-geo-answerblocks (M11)

AI engines cite passages they can lift whole, without surrounding context — so passage structure is the highest-leverage on-page AI signal. This module checks extractability; for who is allowed to fetch and cite the page, see `references/ai-crawlers.md`.

## Inputs
Work from the PageSnapshot named in your dispatch envelope: read `parsed` from `<run_dir>/pages/<slug>.json` (`headings[]`, `text_sample`, `word_count`) — passages come from the HTML file, not from a summary; Grep `pages/<slug>.html` for verbatim evidence; site artifacts live in `<run_dir>/site/{robots.json,sitemaps.json,discovery.json}`. Deterministic findings already emitted by `audit.mjs` are listed in `<run_dir>/findings.deterministic.json` — do not re-emit those ids; add model-judged findings only. If invoked directly with a URL/path and no snapshot exists, first run `node "${CLAUDE_PLUGIN_ROOT}/scripts/snapshot.mjs" <target> --out "${CLAUDE_PLUGIN_DATA}/runs"` and use the printed snapshot path.

## Audits
Working from the PageSnapshot (`parsed_rendered` when `render.used` is not `none`, else `parsed`):
1. **Heading → direct answer**: for each H2/H3 that reads as a question (or implies one), is the first paragraph a direct, ~40-60 word answer — not a windup ("In this section we'll explore…")?
2. **Self-contained passages**: are top-level passages ~134-167 words and answerable on their own? Flag unresolved anaphora ("as mentioned above", "this", "the latter") that needs prior context to parse.
3. **Structured forms**: presence of lists, comparison tables, and explicit term **definitions** where the content warrants them — these are disproportionately quoted.
4. **Question-shaped headings**: do headings phrase real user questions (how/what/why/when), matching likely prompts?
5. **TL;DR / summary blocks**: an up-front summary or key-takeaways block the engine can extract verbatim.
6. **Semantic completeness**: can each passage answer its heading with zero external context — the strongest single correlate of AI citation, and the heaviest check in this module (it carries the most weight, but it never caps the score — see Findings).

## Fixes
- **PROPOSED**: answer-block rewrites (heading → tight 40-60 word lead) and TL;DR drafts, generated from existing page content, surfaced one item at a time for the user to accept/edit. Each becomes a `fix_preview` diff only after acceptance.
- **ADVISORY**: structural suggestions ("split this 400-word passage", "add a definition list here") where intent is editorial.
- **Never** silently rewrite published prose, and never invent facts to fill a passage — if a claim is missing leave a clearly-marked `TODO` placeholder for the user. No finding here is `auto`.

## Verification
- Method is `manual_review`. The deterministic part is reproducible offline: word-count windows (answer 40-60w; passage 134-167w), question-heading detection, anaphora openers, and TL;DR presence via `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-answerblocks.mjs" --snapshot <pages/<slug>.json> [--lang en|es|auto]` (or `--url <u>` / `--file <path>`). Use `manual_review` as the finding's `verification.method` (the enum has no `heuristic` value); the script is the `verification.reproduce` command.
- **Language coverage**: the heuristics ship EN and ES lexicons (question words including `¿`, windup openers, anaphora, TL;DR/`Resumen` markers). When the detected language is neither, the language-dependent fields come back `null` — never 0 — and the finding is `manual_review`, so a page in an unsupported language is never scored as a clean pass.
- Semantic completeness and anaphora resolution still require a judgment pass; when that pass or the rendered DOM is unavailable, status is `needs_api` (or `manual_review`), **never** a false `pass`.

## Findings
Findings conform to `schema/finding.schema.json`; axis `ai`. **Severity policy**: 5 is reserved for catastrophic, eligibility-killing facts at site/template scope; 4 major · 3 moderate · 2 minor · 1 cosmetic · 0 informational — and only an `established` severity-5 `fail` in an active category can cap a score (`references/scoring-model.md`). Nothing in M11 is `established`, so nothing here ever caps.
- `M11.heading.no_direct_answer` — a question H2/H3 followed by a windup instead of an answer (`fail`, severity **3**, `fixable: proposed`, confidence `directional`).
- `M11.passage.unresolved_anaphora` — a passage opens with "As mentioned above…" / "Esto…" and cannot be read standalone (`warn`, severity **2**, `fixable: proposed`, confidence `directional`).
- `M11.passage.overlong` — a passage runs well past the extractable window (>167 words) with no internal structure to lift (`warn`, severity 2, `fixable: proposed`, confidence `directional`).
- `M11.summary.missing_tldr` — no up-front summary / key-takeaways block on a long-form page (`warn`, severity 2, `fixable: proposed`, confidence `directional`).
- `M11.answers.ok` — question headings are answered directly and passages are self-contained (`pass`, severity 3, confidence `directional`).
- `M11.lang.unsupported` — the page language is outside the EN/ES lexicons, so the passage heuristics cannot decide (`manual_review`, severity 0; language-dependent fields `null`).
Each finding's `evidence.observed` quotes the page (heading text + first sentence, or the offending clause) and `verification.reproduce` is the runnable command above; `expected_impact` is banded + confidence-tagged with no naked percentage.

## Honesty
- **Google does not ask for AI-specific rewriting or chunking.** Its generative-AI guidance points back at the same fundamentals — indexable, snippet-eligible, well-structured pages written for people — and it publishes no passage length, no "chunk size", and no answer-block format. Everything in this module is a *readability and extractability* argument that also helps human readers; say that, and never sell a rewrite as an engine requirement.
- Word-count windows are heuristics from observed citation patterns, not engine-published thresholds — they are `directional`, never `established`; flag a passage, don't hard-fail purely on length.
- Adding a "TL;DR" label or bolting question marks onto headings does nothing if the passage still cannot answer standalone. Semantic completeness is what carries weight; formatting theatre is a myth this tool does not ship.
- The heuristics are language-bound. On an unsupported language the honest output is `manual_review`, not a pass — a silent zero would read as "no problems found".

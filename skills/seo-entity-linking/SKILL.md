---
name: seo-entity-linking
description: Audit and generate entity & knowledge-graph linkage for a page — verify sameAs identity links (Wikidata/Wikipedia/LinkedIn/Crunchbase/official profiles) on Organization/Person, check NAP/entity consistency for local, confirm a defined primary entity, and measure entity density, then propose ready-to-inject sameAs/about/mentions references. Module M6. Feeds the AI Visibility score.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-entity-linking (M6)

Entity linkage tells search engines and AI systems *which real-world thing* a page is about and ties it to the Knowledge Graph. Reference: `references/schema-tier1.md` (the `sameAs`/`@id`/Person+Organization rules). This module owns the `sameAs` detail M5 defers here.

## Inputs
Work from the PageSnapshot named in your dispatch envelope: read `parsed` from `<run_dir>/pages/<slug>.json` (`jsonld[]`, `anchors[]`); Grep `pages/<slug>.html` for verbatim evidence; site artifacts live in `<run_dir>/site/{robots.json,sitemaps.json,discovery.json}`. Deterministic findings already emitted by `audit.mjs` are listed in `<run_dir>/findings.deterministic.json` — do not re-emit those ids; add model-judged findings only. If invoked directly with a URL/path and no snapshot exists, first run `node "${CLAUDE_PLUGIN_ROOT}/scripts/snapshot.mjs" <target> --out "${CLAUDE_PLUGIN_DATA}/runs"` and use the printed snapshot path.

## Audits
Working from the PageSnapshot (`parsed_rendered` when `render.used` is not `none`, else `parsed`):
1. **sameAs identity links**: for `Organization`/`Person` entities, check for `sameAs[]` resolving to canonical identities — Wikidata QID, Wikipedia, LinkedIn, Crunchbase, official social/company profiles. Wikidata is the strongest Knowledge Graph target.
2. **Primary entity defined**: confirm exactly one clear primary entity per page (via `@id` + `mainEntity`/`mainEntityOfPage`), not an ambiguous or missing subject.
3. **Entity consistency (local)**: for `LocalBusiness`, verify NAP (name, address, telephone) in schema matches visible on-page NAP and is internally consistent across blocks.
4. **Entity density**: count distinct linked/marked entities (`@id`d nodes, `sameAs` targets, `about`/`mentions`) — flag thin pages with no resolvable entity references.

## Fixes
- **AUTO** (`fixable: auto`): inject a `sameAs[]` array on `Organization`/`Person` using **only user-confirmed URLs**, and add `about`/`mentions` entity references to existing schema. Additive, deterministic diffs for `fix`. **Never invent** identity links — if a URL is unconfirmed, leave a clearly-marked `TODO` placeholder the user fills.
- **PROPOSED** (`fixable: proposed`): a candidate Wikidata/LinkedIn match found by lookup — drafted for per-item human accept, never auto-written.
- **ADVISORY** (`fixable: advisory`): "establish a Wikidata entity / claim profiles" when none exist — guidance only, the tool writes nothing.

## Verification
- `dom_assert`: confirm `sameAs`/`@id`/`mainEntity` present and well-formed in the parsed JSON-LD.
- Resolve each `sameAs` URL (Tier 1 Wikidata lookup) to confirm it is live and refers to the asserted entity — a dead or mismatched link is a fail, not a pass.
- When the live lookup tier is unavailable, status is `needs_api`, never a false `pass`.

## Findings
Emit findings per `schema/finding.schema.json`; axis `ai`; confidence `directional` throughout — none of these is documented by a vendor. **Severity policy**: 5 is reserved for catastrophic, eligibility-killing facts at site/template scope; 4 major · 3 moderate · 2 minor · 1 cosmetic · 0 informational — and only an `established` severity-5 `fail` in an active category can cap a score (`references/scoring-model.md`).
- `M6.organization.missing_sameas` — `Organization` with no `sameAs[]` (`fail`, severity **3**, `fixable: proposed`).
- `M6.page.no_primary_entity` — no single defined primary entity (`@id` / `mainEntity`) on the page (`warn`, severity **3**, `fixable: advisory`).
- `M6.entity.thin_density` — no resolvable entity reference anywhere in the markup on a page that names real organizations, people, or products (`warn`, severity **3**, `fixable: advisory`).
- `M6.person.no_wikidata_link` — an author `Person` with no Wikidata/LinkedIn identity link (`warn`, severity 2, `fixable: proposed`).
- `M6.sameas.unresolvable` — a declared `sameAs` URL that 404s or points at a different entity (`fail`, severity 3, `fixable: proposed`).
Each finding: `evidence.observed` quotes the page (the entity block or its absence); `verification.reproduce` is a runnable assertion/lookup; `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
- A `sameAs` link does **not** force entry into the Knowledge Graph and produces no guaranteed ranking lift — it is a disambiguation signal, so impact stays `directional`, never `established`.
- Never fabricate, guess, or "best-effort" an identity URL to inflate entity density — a wrong `sameAs` actively misleads engines and is worse than an empty array. Confirmed-only, or leave it as a `TODO`.
- Entity density is a proxy for "this page is about something specific and resolvable", not a metric any engine publishes; do not chase the number for its own sake.

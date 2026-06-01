---
name: seo-entity-linking
description: Audit and generate entity & knowledge-graph linkage for a page — verify sameAs identity links (Wikidata/Wikipedia/LinkedIn/Crunchbase/official profiles) on Organization/Person, check NAP/entity consistency for local, confirm a defined primary entity, and measure entity density, then propose ready-to-inject sameAs/about/mentions references. Module M6. Feeds the AI Visibility score.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-entity-linking (M6)

Entity linkage tells search engines and AI systems *which real-world thing* a page is about and ties it to the Knowledge Graph. Reference: `references/schema-tier1.md` (the `sameAs`/`@id`/Person+Organization rules). This module owns the `sameAs` detail M5 defers here.

## Audits
Working from the PageSnapshot (`rendered_dom` if present, else `raw_html`):
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
Emit findings per `schema/finding.schema.json`. Examples:
- `M6.organization.missing_sameas` — `Organization` has no `sameAs[]` (status `fail`, severity 4, `fixable: proposed`, axis `ai`, confidence `directional`).
- `M6.person.no_wikidata_link` — author `Person` lacks a Wikidata/LinkedIn identity link (status `warn`, severity 2, `fixable: proposed`, axis `ai`, confidence `directional`).
- `M6.page.no_primary_entity` — no single defined primary entity (`@id`/`mainEntity`) on the page (status `warn`, severity 4, `fixable: advisory`, axis `ai`, confidence `directional`).
Each finding: `evidence.observed` quotes the page (the entity block or its absence); `verification.reproduce` is a runnable assertion/lookup; `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
- A `sameAs` link does **not** force entry into the Knowledge Graph and produces no guaranteed ranking lift — it is a disambiguation signal, so impact is `directional`/`ai`, not `established`.
- Never fabricate, guess, or "best-effort" an identity URL to inflate entity density — a wrong `sameAs` actively misleads engines. Confirmed-only, or leave it as a TODO.

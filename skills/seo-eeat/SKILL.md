---
name: seo-eeat
description: Audit and strengthen E-E-A-T and trust signals on a page — verify author identity/credentials (Person schema, byline, author page, sameAs), Organization about/contact/policies, visible experience/expertise markers, and transparency (sourcing, disclosures), and generate Person/Organization trust JSON-LD. Module M16. Feeds both the Search SEO and AI Visibility scores.
allowed-tools: Read, Grep, Glob, WebFetch, Bash
---

# seo-eeat (M16)

Experience, Expertise, Authoritativeness, and Trust are how both Google's quality systems and AI answer engines decide whether to rely on a page. Trust is foundational and now applies beyond YMYL. Schema details: `references/schema-tier1.md`.

## Inputs
Work from the PageSnapshot named in your dispatch envelope: read `parsed` from `<run_dir>/pages/<slug>.json` (`jsonld[]`, `anchors[]`, `text_sample`); Grep `pages/<slug>.html` for verbatim evidence; site artifacts live in `<run_dir>/site/{robots.json,sitemaps.json,discovery.json}`. Deterministic findings already emitted by `audit.mjs` are listed in `<run_dir>/findings.deterministic.json` — do not re-emit those ids; add model-judged findings only. If invoked directly with a URL/path and no snapshot exists, first run `node "${CLAUDE_PLUGIN_ROOT}/scripts/snapshot.mjs" <target> --out "${CLAUDE_PLUGIN_DATA}/runs"` and use the printed snapshot path.

## Audits
Working from the PageSnapshot (`parsed_rendered` when `render.used` is not `none`, else `parsed`):
1. **Author identity & credentials**: is there a visible byline? A `Person` schema with `name`, `jobTitle`, `knowsAbout`, and `sameAs[]` (LinkedIn/Wikidata)? Does the byline link to an author/bio page? Are credentials/experience stated, not just a name?
2. **Organization trust**: discoverable About and Contact pages; an `Organization` block with `name`, `url`, `logo`, `contactPoint`, `sameAs[]`; visible editorial/privacy/returns policies appropriate to the vertical.
3. **Experience & expertise markers**: first-hand signals (original photos, "we tested", dates, methodology) and topical depth — not just generic prose.
4. **Transparency**: sourcing/citations for claims, author disclosures (affiliate, sponsored, AI-assisted), last-reviewed dates. Defer the `sameAs` identity-graph detail to M6/seo-entity-linking.

## Fixes
- **AUTO** (`fixable: auto`): inject `Person` (author) and `Organization` trust JSON-LD built **only from confirmed inputs** — name, jobTitle, contactPoint, policy URLs the user supplies. The block is a diff for `fix`.
- **PROPOSED** (`fixable: proposed`): draft a byline link or a `sameAs` set for per-item accept.
- **ADVISORY** (`fixable: advisory`): writing real author bios, About/contact pages, or editorial policies — the tool never authors these. **Never fabricate** names, credentials, dates, or identity links — ask the user or leave a clearly-marked `TODO` placeholder.

## Verification
- Offline: `node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-jsonld.mjs" --snapshot <pages/<slug>.json>` (or `--url <u>`) plus `dom_assert` for visible byline/links/policy pages.
- When confirming an identity link or a live About/contact page requires a fetch that is unavailable, status is `needs_api` — never a false `pass`.

## Findings
Emit findings per `schema/finding.schema.json`; axis `both`. **Severity policy**: 5 is reserved for catastrophic, eligibility-killing facts at site/template scope; 4 major · 3 moderate · 2 minor · 1 cosmetic · 0 informational — and only an `established` severity-5 `fail` in an active category can cap a score (`references/scoring-model.md`). Examples:
- `M16.author.missing_person_schema` — an editorial page with a byline but no `Person` schema (`fail`, severity **3**, `fixable: auto`, confidence `established` — the markup requirement is documented; the ranking effect is not, and belongs in `rationale` as `directional`).
- `M16.author.no_bio_page` — the byline does not link to an author/bio page (`warn`, severity 3, `fixable: proposed`, confidence `directional`).
- `M16.org.no_contact_page` — no discoverable About/Contact and no `contactPoint` (`warn`, severity 3, `fixable: advisory`, confidence `directional`).
- `M16.transparency.no_disclosure` — affiliate, sponsored, or AI-assisted content with no visible disclosure (`warn`, severity 3, `fixable: advisory`, confidence `directional`).
Each finding: `evidence.observed` quotes what is on the page; `verification.reproduce` is the runnable command above; `expected_impact` is banded + confidence-tagged (no naked %).

## Honesty
- **E-E-A-T is not a score Google exposes, and Google's own framing is "people-first content".** Its guidance asks who, how, and why: is there a real author with real experience, was the content made for readers rather than for engines. Everything this module measures is a *visible proxy* for that judgment, so every finding here is `directional` — adding a `Person` block or an author bio is not a ranking lever, and must never be presented as one.
- Trust is the foundational element and now applies well beyond YMYL, but a page does not become trustworthy by acquiring markup. Report missing signals as "a reader (or an AI system) cannot tell who stands behind this", not as points lost.
- A fabricated author, an invented credential, or fake review markup is worse than nothing — it is a trust risk in Search and in AI answers alike. The tool only emits trust signals the user can substantiate, and leaves a clearly-marked `TODO` where it cannot.

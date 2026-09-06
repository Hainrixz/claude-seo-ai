# Contributing to claude-seo-ai

Thanks for helping build the community SEO + AI-search toolkit. This is an open, MIT-licensed project — all original work; please don't paste branding, copy, or names from other projects.

## Ground rules (non-negotiable)

1. **Falsifiability.** Every finding a skill or script emits must conform to [`schema/finding.schema.json`](schema/finding.schema.json): observed `evidence`, a runnable `verification.reproduce` (an **absolute** command — `node "<plugin_root>/scripts/<x>.mjs" --snapshot "<run_dir>/pages/<slug>.json"`, never a bare `node scripts/…`), and a banded `expected_impact` with a `confidence` tier. No naked percentages — cite published numbers only inside `rationale`.
2. **No fabrication.** Never generate statistics, citations, dates (no backdating `dateModified`), author credentials, or `sameAs` identity links. When a value is unknown, leave a clearly-marked `TODO:<field>` placeholder (the convention used by `schema/jsonld-templates/`).
3. **Honesty over hype.** If a tactic has weak or unproven impact (llms.txt, FAQ/HowTo rich results, Content-Signal, keyword density), say so in the skill's `## Honesty` section and weight/score it accordingly. Only findings a search engine documents may be `established`; on the AI axis that is M14 eligibility only.
4. **Fixer discipline.** Only deterministic, additive, machine-verifiable, low-semantic-risk artifacts may be `auto`. Concretely, **only the `html-head`, `front-matter`, `config-file`, and `liquid` insertion strategies may produce AUTO changes**; every JSX/TS-object strategy (`metadata-object` without a literal anchor, `next-head-jsx` create, `use-seo-meta`, `meta-export-array`, `gatsby-head-export`) and every remote/live write is `proposed`. Anything touching prose, runtime, or facts is `proposed` or `advisory`. Auditor agents are read-only by tool allowlist; only `seo-fixer-writer` writes, and only after the user confirms.

## Adding or editing a skill

- Skills live in `skills/<name>/SKILL.md`. Mirror the structure/tone of the exemplar [`skills/seo-schema-jsonld/SKILL.md`](skills/seo-schema-jsonld/SKILL.md): frontmatter (`name`, task-oriented `description`, `allowed-tools`; `user-invocable: false` for support skills) then `## Inputs`, `## Audits`, `## Fixes`, `## Verification`, `## Findings`, `## Honesty`.
- Keep the body under ~120 lines; push deep reference material to `references/`.
- Module skills are preloaded into their agent via the agent's `skills:` list — add a new module to the right agent in `agents/*.md` and to the dispatch table in `references/routing.md`.
- The subagent tool is `Agent` (never `Task`). `allowed-tools` pre-approves tools; it does not restrict them.
- Use module-prefixed finding ids (`M5.article.missing_datemodified`). The scorer maps a finding to a category by its module — see [`references/scoring-model.md`](references/scoring-model.md).

## Adding a verification script or a check

- Scripts in `scripts/` are **zero-dependency** Node ESM (`.mjs`, Node ≥ 18) so they run with no install step. Every script is importable: `export async function main(args) → {result, code}` plus `if (isMain(import.meta.url)) runCli(main)`; exit codes `0` ok · `1` usage · `2` runtime · `3` threshold. Reuse `scripts/lib/*`.
- A script must **degrade gracefully** (emit `needs_api` or a clear error, never crash the audit) and accept `--url`, `--file`, or `--snapshot <pages/<slug>.json>`.
- **Checks registry.** Cross-URL and deterministic checks live in `scripts/checks/<name>.mjs` and export `{ module, ids, scope, run(ctx) }` where `module` is the `Mn` owner, `ids` lists every finding id the check can emit, `scope` is `page | template | site`, and `run(ctx)` receives `{ page, parsed, rendered, site, crawl, pages, options, root }` and returns findings built with `lib/finding.mjs makeFinding()` (which fills the absolute `reproduce` and validates the shape). `audit.mjs` discovers checks by walking that directory — no registration list to edit.
- Wire the script as the `verification.reproduce` command in the relevant skill's findings.

## Adding a platform knowledge card

Cards live in `references/platforms/<id>.md` and follow a fixed 12-section template so the detector, the conditional checks, and `fix` can rely on them: header `Status: stable | beta | instructions-only` + `Last verified: <date>`, then **1** Detection recap · **2** Generated automatically (don't re-add) · **3** URL surfaces & duplicate risks · **4** Platform-owned — do not fix (+ where the user changes it) · **5** Fix map (class → location → adapter → AUTO/PROPOSED/ADVISORY → live_impact) · **6** Write method & credentials · **7** Preview/publish · **8** Verification · **9** Rollback · **10** Check ids · **11** Manual paths EN/ES · **12** Honesty/UNVERIFIED. Add the platform's detection rules to `scripts/detect-platform.mjs` with a synthetic fixture under `tests/fixtures/platforms/<id>/`, and a row to the Platform layer table in `references/routing.md`. Mark anything you could not verify against official docs `UNVERIFIED`.

## Tests

- Harness: `node:test` + `node:assert/strict` (built in on Node 18/20/22). Unit tests in `tests/unit/*.test.mjs`, end-to-end tests (against the local fixture server in `tests/helpers/server.mjs`) in `tests/e2e/*.test.mjs`.
- `tests/run.mjs` is the entry point and auto-discovers every `*.test.mjs` under `tests/unit` and `tests/e2e` (Node 18 has no glob), so both `node tests/run.mjs` and `node --test tests/` work.
- Fixtures are synthetic only (`tests/fixtures/**`) — never saved copies of real sites' content. Network is never required; adapters take an injectable `fetchImpl`, and `CLAUDE_SEO_AI_OFFLINE=1` makes a real fetch throw.

## Before you open a PR

```
# syntax-check every script, lint skill/agent frontmatter, verify version alignment
node scripts/check.mjs
# run the test suite
node tests/run.mjs        # or: node --test tests/
# validate the plugin manifest (if you have the CLI)
claude plugin validate .
```

Please describe what you changed, why, and how you verified it. Bilingual docs (`docs/en` + `docs/es`) stay in sync when you change user-facing behavior; the three version locations (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `scripts/package.json`) move together.

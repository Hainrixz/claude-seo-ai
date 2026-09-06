# Contributing to claude-seo-ai

Thanks for helping build the community SEO + AI-search toolkit. This is an open, MIT-licensed project — all original work; please don't paste branding, copy, or names from other projects.

## Ground rules (non-negotiable)

1. **Falsifiability.** Every finding a skill or script emits must conform to [`schema/finding.schema.json`](schema/finding.schema.json): observed `evidence`, a runnable `verification.reproduce` (an **absolute** command — `node "<plugin_root>/scripts/<x>.mjs" --snapshot "<run_dir>/pages/<slug>.json"`, never a bare `node scripts/…`), and a banded `expected_impact` with a `confidence` tier. No naked percentages — cite published numbers only inside `rationale`.
2. **No fabrication.** Never generate statistics, citations, dates (no backdating `dateModified`), author credentials, or `sameAs` identity links. When a value is unknown, leave a clearly-marked `TODO:<field>` placeholder (the convention used by `schema/jsonld-templates/`).
3. **Honesty over hype.** If a tactic has weak or unproven impact (llms.txt, FAQ/HowTo rich results, Content-Signal, keyword density), say so in the skill's `## Honesty` section and weight/score it accordingly. Only findings a search engine documents may be `established`; on the AI axis that is M14 eligibility only, and only an `established` failure may cap a score. A fact you could not observe becomes `needs_api` or `manual_review` — never a silent pass, and never an override of a check that did decide.
4. **Fixer discipline.** Only deterministic, additive, machine-verifiable, low-semantic-risk artifacts may be `auto`. Concretely, **only the `html-head`, `front-matter`, `config-file`, and `liquid` insertion strategies may produce AUTO changes** — that list is `AUTO_STRATEGIES` in `scripts/lib/route-map.mjs`, and `classFor(strategy)` is the only thing that decides. Every JSX/TS strategy (`metadata-object` without a literal anchor, `next-head-jsx` create, `use-seo-meta`, `svelte-head`, `meta-export-array`, `gatsby-head-export`) and every remote/live write is `proposed`. Anything touching prose, runtime, or facts is `proposed` or `advisory`. Auditor agents are read-only by tool allowlist; only `seo-fixer-writer` writes, and only after the user confirms.
5. **Never live by default.** A new write path must land somewhere the public cannot see it — an unpublished theme, a draft, a file on disk — or, when the platform has no such surface, badge the change `live_impact: 'live'` so the user is told before they confirm. "It writes straight to production but we ask first" is only acceptable when the platform leaves no alternative, and the card must say so.

## Adding or editing a skill

- Skills live in `skills/<name>/SKILL.md`. Mirror the structure/tone of the exemplar [`skills/seo-schema-jsonld/SKILL.md`](skills/seo-schema-jsonld/SKILL.md): frontmatter (`name`, task-oriented `description`, `allowed-tools`; `user-invocable: false` for support skills) then `## Inputs`, `## Audits`, `## Fixes`, `## Verification`, `## Findings`, `## Honesty`.
- Keep the body under ~120 lines; push deep reference material to `references/`.
- Module skills are preloaded into their agent via the agent's `skills:` list — add a new module to the right agent in `agents/*.md` and to the dispatch table in `references/routing.md`.
- The subagent tool is `Agent` (never `Task`). `allowed-tools` pre-approves tools; it does not restrict them.
- Use module-prefixed finding ids (`M5.article.missing_datemodified`). The scorer maps a finding to a category by its module — see [`references/scoring-model.md`](references/scoring-model.md).
- **Every id must be documented.** `tests/unit/docs-contracts.test.mjs` fails when an id the checks registry can emit appears in no skill and no reference. Platform-conditional ids are indexed in `references/routing.md` instead of the per-module tables (a WordPress id is noise on a Shopify audit), and each owning skill carries a `Platform-conditional ids` pointer to that index.
- **Never paraphrase a machine-emitted disclaimer.** Quote the exported constant verbatim and name it — the same test asserts that the probe disclaimer exists in exactly one shipped document, so the model's prose and the line printed beside it cannot disagree.

## Adding a verification script or a check

- Scripts in `scripts/` are **zero-dependency** Node ESM (`.mjs`, Node ≥ 18) so they run with no install step. Every script is importable: `export async function main(args) → {result, code}` plus `if (isMain(import.meta.url)) runCli(main)`; exit codes `0` ok · `1` usage · `2` runtime · `3` threshold. No `process.exit` outside the two hook scripts. Reuse `scripts/lib/*`.
- A script must **degrade gracefully** (emit `needs_api` or a clear error, never crash the audit) and accept `--url`, `--file`, or `--snapshot <pages/<slug>.json>`.
- There is no `--help`. The comment block at the top of the file is the contract, and running the script with no arguments must print a usage line.
- **Checks registry.** Cross-URL and deterministic checks live in `scripts/checks/<name>.mjs` and export `{ module, ids, scope, run(ctx) }` where `module` is the `Mn` owner, `ids` lists **every** finding id the check can emit, `scope` is `page | template | site`, and `run(ctx)` receives `{ page, parsed, rendered, site, crawl, pages, options, root }` and returns findings. `index.mjs` discovers checks by walking that directory — no registration list to edit — and `knownIds()` is built from the `ids` arrays, so an id you forget to declare is an id nobody can document.
- Build findings only through `scripts/checks/_shared.mjs`, which is the single path to `lib/finding.mjs makeFinding()` (it fills the absolute `reproduce` and validates the shape). A check must never throw: `runChecks` isolates per-page errors, and an error you swallow silently is worse than one it records.
- Wire the script as the `verification.reproduce` command in the relevant skill's findings.

## Adding an adapter

Adapters live in `scripts/adapters/<id>.mjs` (page-API providers in `scripts/adapters/providers/<id>.mjs`) and are how a fix reaches a real surface.

- **One contract, six ops:** `capabilities | plan | preview | apply | verify | rollback`, exposed as a CLI (`node scripts/adapters/<id>.mjs <op> --run <fix-run-dir> [--change <id>] [--ticket <t>] [--json]`) and as exports. `capabilities`, `plan`, `preview` and `verify` are read-only; `apply`, `publish` and `rollback` require a ticket via `requireTicket()`.
- **Injectable I/O.** Take `fetchImpl` / `execImpl` so tests never touch the network or the shell. `CLAUDE_SEO_AI_OFFLINE=1` must make a real fetch throw.
- **Changes are records, not side effects.** Build every change with `makeChange()` from `lib/adapter.mjs` and respect the status machine (`STATUS_TRANSITIONS`) — a change never moves backwards. Use `opThrew()` for the op-dispatch catch so a throw marks the change `failed` and persists the message.
- **`updateManifest()` is the only reporting path** for `apply`, `publish` and `rollback`. Do not hand-edit `manifest.json`: that function is what keeps `dry_run`, the applied/rolled_back/failed lists, the per-change `results` map, `last_op` and the `<op>_at` stamps consistent.
- **Capture `before` first.** `before/<change-id>.json` (or a backup under `<DATA>/backups/<run>/`) is what `rollback` restores. An op with no recoverable prior state must say so in its `rollback_kind`.
- **Credentials by key name only.** Register the key in `lib/credentials.mjs` (and mirror it in `.claude-plugin/plugin.json` `userConfig`), resolve it with `resolveKey()`, report gaps with `missingKeys()` / `explainKeys()`, and redact anything you log. Never accept a secret as a flag; never echo a value.
- **A missing credential downgrades, it does not fail.** The target falls back to `instructions`, and `fix-plan.mjs` reports it in `coverage.by_adapter` rather than dropping it.
- **Be honest about what you did not verify.** If a field name or endpoint is not confirmed against vendor documentation, do not write it: report `needs_api`, or plan the change `skipped_unready` with the payload printed, and list it in the card's §12.

## Adding a platform knowledge card

Cards live in `references/platforms/<id>.md` and follow a fixed 12-section template so the detector, the conditional checks, and `fix` can rely on them: header `Status: stable | beta | instructions-only` + `Last verified: <date>` + `Detector id` + `Layer`, then **1** Detection recap · **2** Generated automatically (don't re-add) · **3** URL surfaces & duplicate risks · **4** Platform-owned — do not fix (+ where the user changes it) · **5** Fix map (class → location → adapter → AUTO/PROPOSED/ADVISORY → live_impact) · **6** Write method & credentials · **7** Preview/publish · **8** Verification · **9** Rollback · **10** Check ids · **11** Manual paths EN/ES · **12** Honesty/UNVERIFIED.

Cards are read by agents, not by users: keep them short, imperative and specific. A sentence that does not change what an auditor emits or what a writer does has no business in a card.

Also: add the platform's detection rules to `scripts/lib/platform-rules.mjs` with a synthetic fixture under `tests/fixtures/platforms/<id>/`, a row to the Platform layer table in `references/routing.md`, and a row to the support matrix in `docs/{en,es}/platforms.md`. Mark anything you could not verify against official docs **UNVERIFIED** — an old `Last verified` date is not a bug; a wrong one is.

## Tests

- Harness: `node:test` + `node:assert/strict` (built in on Node 18/20/22). Unit tests in `tests/unit/*.test.mjs`, end-to-end tests (against the local fixture server in `tests/helpers/server.mjs`) in `tests/e2e/*.test.mjs`.
- `tests/run.mjs` is the entry point and auto-discovers every `*.test.mjs` under `tests/unit` and `tests/e2e` (Node 18 has no glob), so both `node tests/run.mjs` and `node --test tests/` work. There is no list to register a new file in.
- Fixtures are synthetic only (`tests/fixtures/**`) — never saved copies of real sites' content. **Network is never required**: e2e tests run against the local fixture server, adapters take an injectable `fetchImpl`, and `CLAUDE_SEO_AI_OFFLINE=1` makes a real fetch throw.
- A test that depends on something the machine may not have (a headless browser, for instance) must **report itself as skipped**, not fail.
- Every bug fix ships with the regression test that would have caught it, in the suite that owns that area.

## Before you open a PR

```
# syntax-check every script, lint skill/agent frontmatter, verify the three versions align
node scripts/check.mjs
# run the test suite
node tests/run.mjs        # or: node --test tests/
# validate the plugin manifest (if you have the CLI)
claude plugin validate . --strict
```

`scripts/check.mjs` is the cheap gate: it `node --check`s every `.mjs`, parses every shipped JSON, lints skill and agent frontmatter, and fails when `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and `scripts/package.json` disagree about the version. Run it before the tests — it catches the class of mistake that would otherwise fail 40 test files at once.

Please describe what you changed, why, and how you verified it. Bilingual docs (`docs/en` + `docs/es`) stay in sync when you change user-facing behavior; the three version locations (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `scripts/package.json`) move together.

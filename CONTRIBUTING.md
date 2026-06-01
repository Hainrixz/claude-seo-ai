# Contributing to claude-seo-ai

Thanks for helping build the community SEO + AI-search toolkit. This is an open, MIT-licensed project — all original work; please don't paste branding, copy, or names from other projects.

## Ground rules (non-negotiable)

1. **Falsifiability.** Every finding a skill emits must conform to [`schema/finding.schema.json`](schema/finding.schema.json): observed `evidence`, a runnable `verification.reproduce`, and a banded `expected_impact` with a `confidence` tier. No naked percentages — cite published numbers only inside `rationale`.
2. **No fabrication.** Never generate statistics, citations, dates (no backdating `dateModified`), author credentials, or `sameAs` identity links. When a value is unknown, leave a clearly-marked `TODO` for the user.
3. **Honesty over hype.** If a tactic has weak or unproven impact (e.g. llms.txt, FAQ/HowTo rich results, keyword density), say so in the skill's `## Honesty` section and weight/score it accordingly.
4. **Fixer discipline.** Only deterministic, additive, machine-verifiable, low-semantic-risk artifacts may be `auto`. Anything touching prose, runtime, or facts is `proposed` or `advisory`. Auditor agents are read-only by tool allowlist; only `seo-fixer-writer` writes.

## Adding or editing a skill

- Skills live in `skills/<name>/SKILL.md`. Mirror the structure/tone of the exemplar [`skills/seo-schema-jsonld/SKILL.md`](skills/seo-schema-jsonld/SKILL.md): frontmatter (`name`, task-oriented `description`, `allowed-tools`) then `## Audits`, `## Fixes`, `## Verification`, `## Findings`, `## Honesty`.
- Keep the body under ~120 lines; push deep reference material to `references/`.
- Use module-prefixed finding ids (`M5.article.missing_datemodified`). The scorer maps a finding to a category by its module — see [`references/scoring-model.md`](references/scoring-model.md).

## Adding a verification script

- Scripts in `scripts/` are **zero-dependency** Node ESM (`.mjs`, Node ≥ 18) so they run with no install step. Reuse `scripts/lib/util.mjs`.
- A script must **degrade gracefully** (emit `needs_api` or a clear error, never crash the audit) and accept `--url` or `--file`.
- Wire it as the `verification.reproduce` command in the relevant skill's findings.

## Before you open a PR

```
# syntax-check every script
for f in scripts/*.mjs scripts/lib/*.mjs; do node --check "$f"; done
# run the script self-test against the fixtures
node tests/run.mjs
# validate the plugin manifest (if you have the CLI)
claude plugin validate .
```

Please describe what you changed, why, and how you verified it. Bilingual docs (`docs/en` + `docs/es`) should stay in sync when you change user-facing behavior.

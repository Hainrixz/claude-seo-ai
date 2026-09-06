# Changelog

All notable changes to claude-seo-ai are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/); this project uses semantic versioning.

## [0.2.0] — Unreleased

The "works on any site" release: deterministic acquisition, persistence, crawl, platform awareness, platform-aware `fix`, `compare`, and a GEO layer aligned with Google's 2026 guidance. Six phases; each leaves the plugin working.

### Added
- **Phase 0 — wiring**
  - `schema/jsonld-templates/` — one JSON-LD template per Tier-1 type (Organization, WebSite, Article, BlogPosting, NewsArticle, Person, BreadcrumbList, Product+Offer, Review/AggregateRating, LocalBusiness, VideoObject, Event, SoftwareApplication) with stable `@id` patterns and `TODO:<field>` placeholders; backs `validate-jsonld` and the fixer's AUTO JSON-LD generation. Closes the dead reference from `references/schema-tier1.md` and `seo-schema-jsonld`.
  - `skills/seo-fix-apply/SKILL.md` (hidden, `user-invocable: false`) — the writer protocol preloaded by `seo-fixer-writer` (git pre-flight → backup → Edit/Write → adapter CLI or `skipped_unready` → re-verify → publish only on a second confirmation → findings-array contract). Created in Phase 0 so the agent's `skills:` preload resolves; Phase 3h extends it with the adapter flow.
  - Agents: `skills:` preload lists on all five agents (module skills load at startup instead of being triggered at runtime); an `## Envelope` section on each agent documenting the dispatch envelope (`plugin_root`, `run_dir`, `pages[]`, `site`, `vertical`, `platform`, `modules[]`, `deterministic_findings`, `return`) and the absolute-path script rule (`node "<plugin_root>/scripts/<x>.mjs" --snapshot "<run_dir>/pages/<slug>.json"`).
  - `references/routing.md`: M7b/M7c and M22 in the always-on list; M20 in the conditional table (owner `technical-auditor`, active when `vertical.multilingual`); M18 agentic-commerce readiness note; "Platform layer" stub table (platform → knowledge card → default `--target` → adapters), "Environment layer" note, and the SiteProfile shape.
  - `references/ai-crawlers.md`: "What actually gates Google AI features" (indexed + snippet-eligible; `Google-Extended` does not affect AI Overviews/AI Mode; Google ignores `llms.txt`), "Content-Signal (robots.txt)" section with the compliance caveat, UA table with a Source column and new rows (Amazonbot, Claude-Web, Applebot, Google-CloudVertexBot, DuckAssistBot, Meta-ExternalFetcher, MistralAI-User, cohere-ai, OAI-AdsBot), `Content-Signal:` lines on all three presets, and an "AI discovery & agent endpoints (M21, weight 0)" section.
- **Phase 1 — deterministic acquisition + persistence** (in progress): `scripts/snapshot.mjs` (PageSnapshot v2 on disk: status chain, headers, robots directives, render decision, site artifacts), `scripts/lib/*` split (tokenizer, fetch with redirect chain, Google-REP robots matcher, sitemap index recursion, store), `--snapshot` on every legacy script.
- **Phase 2 — crawl, cross-URL checks, headless runner, CI** (in progress): `scripts/crawl.mjs`, `scripts/checks/*` registry, `scripts/audit.mjs` (exit codes 0/1/2/3), `scripts/report.mjs`, site rollup, `action.yml` + CI workflows, `scripts/check.mjs`.
- **Phase 3 — platform & framework awareness + platform-aware `fix`** (in progress): `scripts/detect-platform.mjs` + `profile.json`, `references/platforms/<id>.md` knowledge cards, platform-conditional check ids, route→file mapping, adapters (local-files, shopify-theme, shopify-admin, wordpress-rest, wordpress-wpcli, page-api providers, instructions), `guard-bash.mjs` + tickets, the adapter flow in `skills/seo-fix-apply`, `userConfig` credentials.
- **Phase 4 — GEO 2026 + scoring integrity** (in progress): `scripts/ai-eligibility.mjs`, `scripts/ua-diff.mjs`, `scripts/ai-discovery.mjs` + `skills/seo-ai-discovery` (M21), `scripts/agent-readiness.mjs` + `skills/seo-agent-readiness` (M22), M18 agentic-commerce readiness + `acp-feed-lint.mjs`, `--probe` / `--gsc-ai-export` (never scored), EN/ES language coverage, `manual_review` status, `unscored` state.
- **Phase 5 — `compare` command** (in progress): `scripts/compare.mjs` + `skills/compare` (baseline, staging vs production, competitor matrix, content gap).
- **Phase 6 — tests, docs, release hygiene** (in progress): `node:test` layout (`tests/unit`, `tests/e2e`, `tests/run.mjs`), fixture server, EN+ES docs incl. `docs/*/platforms.md`.

### Changed
- **Phase 0**
  - Agents run `model: inherit`; `technical-auditor` also owns M20 (when multilingual); `ai-search-geo-specialist` owns M6, M11, M12, M14, M21, M22 and gains `Bash`; `content-eeat-analyst` gains `Bash`; `schema-generator` gains `WebFetch`; `seo-fixer-writer` gains `Grep`/`Glob`, `skills: [seo-fix-apply]`, `maxTurns: 80`, and an envelope (`RUN_DIR`, `SCRIPTS_DIR`, `DATA`, confirmed change ids, publish intent).
  - M21 is now "AI discovery & agent endpoints" everywhere (weight 0); M6 is the only entity module.
  - Subagent tool named `Agent` (not the legacy `Task`) in skills and docs; orchestrator pre-approves `Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/*")`.
  - `seo-orchestrator` also pre-approves the agent-output save into `${CLAUDE_PLUGIN_DATA}/runs/*` (`mkdir -p` / `cat >`; TO-VERIFY that heredoc saves match); the `reconcile-flags-v0.2` marker sits on every script command line in skills and agents.
  - Support skills (`seo-orchestrator`, `seo-score`, `seo-vertical-detect`) become `user-invocable: false`; module skills gain an `## Inputs` section.
  - `references/cwv-thresholds.md`: CrUX History marked TO-VERIFY / not implemented; PSI `origin_fallback` must be surfaced.
  - `.claude-plugin/plugin.json` description and keywords mention platform coverage (Shopify, WordPress, Next.js, Webflow, Wix…), `geo-ai`, `agentic-commerce`; version 0.2.0 in both manifests.
- Phases 1–6 (in progress): see the plan; notable — `seo-crawl-render` becomes a thin wrapper over `snapshot.mjs`/`crawl.mjs` (WebFetch is no longer an acquisition layer), AI weights re-normalized (M11 18 · M14 14 · M12 14 · M5 12 · M4 10 · M6 9 · M16 9 · M13 6 · M22 4 · M9 4 · M21 0; conditional M18 6, M19 5), severity calibration table.

### Fixed
- **Phase 0**
  - `seo-fixer-writer` no longer reports unapplied changes with a non-schema `status: skipped`; a change that is not applied keeps its pre-fix `status` and states `skipped_<reason>` in `evidence.observed`.
  - `seo-fixer-writer` no longer instructs itself to "trigger the fix skill" (`fix` is `disable-model-invocation` and can neither be invoked nor preloaded by a model); it receives approved changes in its envelope.
  - Bare `node scripts/…` commands in agents replaced by the absolute command carried in each finding's `verification.reproduce`.
  - M21 double definition (entity linkage vs llms.txt) removed from `ai-search-geo-specialist`.
  - M20 (hreflang) is no longer orphaned: dispatched to `technical-auditor` when the vertical detector reports `multilingual: true`.
  - CHANGELOG 0.1.0 entry: removed the non-existent router claim; corrected the skill count.
  - (Phase 3, in progress) `hooks/hooks.json` matcher will cover `Write|Edit|MultiEdit|NotebookEdit`; `guard-write.mjs` will gain project-root containment and Windows path normalization.
- Phases 1–6 (in progress): `M14.llmstxt.*` score leak (llms.txt moves to M21 structurally), self-canonical+noindex false "lethal pair", seed URL reported as orphan, nested JSON-LD nodes never validated, sitemap `<loc>` entities undecoded, apostrophes truncating attribute values, English-only heuristics scoring Spanish pages as zero, `interpret()` sentence pairing, gating ignoring `confidence`, `totalW === 0` → `unscored` instead of F.

## [0.1.0] — 2026-06-01

Initial release — the complete v1 suite.

### Added
- **Plugin scaffold**: `.claude-plugin/plugin.json` + in-repo `marketplace.json`, MIT license.
- **Four command skills**: `/claude-seo-ai:audit`, `/claude-seo-ai:geo`, `/claude-seo-ai:score`, `/claude-seo-ai:fix`.
- **Dual scoring**: independent Search SEO and AI Visibility (GEO/AEO) 0–100 scores with letter bands, severity gating, and dynamic re-normalization of conditional verticals (`references/scoring-model.md`, `scripts/score.mjs`).
- **Falsifiable finding contract**: `schema/finding.schema.json` + `schema/audit-report.schema.json` (evidence + runnable `verification.reproduce` + banded `expected_impact` with confidence tiers).
- **29 skills**: 4 command skills + 4 support skills (`seo-orchestrator`, `seo-vertical-detect`, `seo-crawl-render`, `seo-score`) + 21 module skills covering M1–M21: crawl/index/render, structured data + entities, on-page/meta/headings/mobile/social/images/links, GEO/AEO (answer blocks, fact density, AI crawlers, llms.txt), E-E-A-T, freshness, Core Web Vitals, sitemaps, and the e-commerce/local/international verticals.
- **5 subagents**: 4 read-only auditors (technical, content/E-E-A-T, AI-search/GEO, schema) + 1 writer (`seo-fixer-writer`).
- **Opt-in fixer** with hard safety: `disable-model-invocation`, dry-run default, git-awareness, backups, idempotency, post-write re-verification, and a `PreToolUse` write guard against protected paths.
- **Optional zero-dependency Node helpers** (`scripts/`): HTML/meta parsing, JSON-LD validation, robots/sitemap parsing, hreflang reciprocity, link graph, PageSpeed Insights client, answer-block and fact-density heuristics, freshness, and scoring.
- **Honesty guardrails**: llms.txt scored 0, FAQ/HowTo flagged deprecated-for-rich-results, no keyword-density optimization, no fabrication, confidence labeling throughout.
- **Bilingual docs** (`docs/en`, `docs/es`) and test fixtures (`tests/fixtures`).

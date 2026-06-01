# Changelog

All notable changes to claude-seo-ai are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/); this project uses semantic versioning.

## [0.1.0] — Unreleased

Initial release — the complete v1 suite.

### Added
- **Plugin scaffold**: `.claude-plugin/plugin.json` + in-repo `marketplace.json`, MIT license.
- **Router**: `/claude-seo-ai` command with `audit`, `geo`, `score`, `fix` subcommands.
- **Dual scoring**: independent Search SEO and AI Visibility (GEO/AEO) 0–100 scores with letter bands, severity gating, and dynamic re-normalization of conditional verticals (`references/scoring-model.md`, `scripts/score.mjs`).
- **Falsifiable finding contract**: `schema/finding.schema.json` + `schema/audit-report.schema.json` (evidence + runnable `verification.reproduce` + banded `expected_impact` with confidence tiers).
- **~25 skills**: orchestrator, vertical-detect, crawl-render, score, opt-in fix-apply, plus audit modules M1–M21 covering crawl/index/render, structured data + entities, on-page/meta/headings/mobile/social/images/links, GEO/AEO (answer blocks, fact density, AI crawlers, llms.txt), E-E-A-T, freshness, Core Web Vitals, sitemaps, and the e-commerce/local/international verticals.
- **5 subagents**: 4 read-only auditors (technical, content/E-E-A-T, AI-search/GEO, schema) + 1 writer (`seo-fixer-writer`).
- **Opt-in fixer** with hard safety: `disable-model-invocation`, dry-run default, git-awareness, backups, idempotency, post-write re-verification, and a `PreToolUse` write guard against protected paths.
- **Optional zero-dependency Node helpers** (`scripts/`): HTML/meta parsing, JSON-LD validation, robots/sitemap parsing, hreflang reciprocity, link graph, PageSpeed Insights client, answer-block and fact-density heuristics, freshness, and scoring.
- **Honesty guardrails**: llms.txt scored 0, FAQ/HowTo flagged deprecated-for-rich-results, no keyword-density optimization, no fabrication, confidence labeling throughout.
- **Bilingual docs** (`docs/en`, `docs/es`) and test fixtures (`tests/fixtures`).

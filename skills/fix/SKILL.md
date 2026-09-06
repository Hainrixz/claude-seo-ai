---
name: fix
description: Opt-in fixer (the /claude-seo-ai:fix command). Applies the safe, deterministic SEO/AI-search fixes from a persisted audit to the user's site — meta viewport/charset/lang, JSON-LD, robots.txt AI directives, hreflang, sitemaps, OG/Twitter cards, image dimensions, canonical, AI discovery files — through the adapter that matches the platform (local files, Shopify theme/Admin, WordPress REST/WP-CLI, page APIs, or step-by-step instructions). Dry-run preview by default; writes only after explicit per-change confirmation. Runs only when the user invokes it — never auto-triggered.
disable-model-invocation: true
argument-hint: "<url|path> [--target auto|local|shopify-theme|shopify-admin|wordpress-rest|wordpress-wpcli|page-api|instructions] [--category schema|meta|robots|sitemap|hreflang|alt|canonical|social|ai-discovery] [--include-proposed] [--store <shop>] [--theme <id>] [--site <id>] [--wp-url <u>] [--ssh user@host:/path] [--project <dir>] [--dev-url <u>] [--run <run_id|latest>] [--report <path>] [--lang en|es] [--dry-run] [--publish] [--rollback <run_id>] [--force]"
allowed-tools: Read, Grep, Glob, Bash, Agent
---

# fix (opt-in writer)

`disable-model-invocation: true` means the model can **never** trigger this on its own — only the user running `/claude-seo-ai:fix`. Writes happen only through the **seo-fixer-writer** subagent (the one agent with Write/Edit) and only after explicit confirmation. `--category` takes a pipe list (`schema|meta|robots|sitemap|hreflang|alt|canonical|social|ai-discovery`; `llms` is an alias of `ai-discovery`). <!-- reconcile-flags-v0.2 -->

## Fixability classes (from each finding's `fixable` field — see `schema/finding.schema.json`)
- **AUTO** — deterministic, additive, machine-verifiable, low-semantic-risk. May be written (with diff + confirmation):
  meta `viewport`/`charset`/`<html lang>`; Tier-1 JSON-LD blocks; `sameAs`/`@id`/`dateModified` (from confirmed inputs only); robots.txt AI-crawler presets + `Sitemap:` line; self-referential canonical; hreflang link sets; OG/Twitter cards; image `width`/`height`; XML sitemap entries; `llms.txt` (disclosure-gated, scored 0).
- **PROPOSED** — changes prose/meaning or is editorial; generate a draft diff and require per-item accept: generated `<title>` and meta description, answer-block/TL;DR rewrites, internal-link insertions, heading restructuring, **generated image alt text** (titles, descriptions, and image alt are editorial messaging, not deterministic).
- **ADVISORY** — never written: content/E-E-A-T rewrites, adding stats/citations/original data, Core Web Vitals/performance, rendering strategy, redirects/status codes, link-building, Merchant Center/GBP backend data.

## Workflow
1. **Load the latest report from `${CLAUDE_PLUGIN_DATA}/runs/<host>/latest` (or `--run` / `--report`) — never fix from memory.** If it is missing or older than 24 h, offer to re-run `/claude-seo-ai:audit` first. Read `report.json` for findings and `profile.json` for the platform profile; confirm the profile with the user when confidence is below high or `--target auto` is ambiguous.
2. Filter to `fixable: auto` (+ `proposed` with `--include-proposed`). Honor `--category`. Resolve any required real-world inputs (e.g. `sameAs` URLs, locale map, publish dates) by **asking the user** — never invent them.
3. Choose the write path from the profile and `--target`: a local path → file diffs (plus platform adapters for per-resource fields); Shopify → theme + Admin; WordPress → REST when credentials and the SEO plugin allow it, else WP-CLI over `--ssh`, else instructions; other hosted builders → page API when credentials exist, else instructions. List missing credential **key names** only. <!-- phase3-adapters: TODO — detailed adapter flow (capabilities, fix-plan.mjs, preview, tickets, publish, verify, rollback) lands in the Phase 3 pass. -->
4. For each change, build a **unified diff** (or the adapter payload) with the exact insertion point and a `live_impact` badge.
5. **Dry-run (default)**: print every diff grouped by target. Write nothing. Summarize what `fix` (without `--dry-run`) would change.
6. On explicit confirmation (and only then): delegate to **seo-fixer-writer** with the run dir, plugin root, and the confirmed change ids. Per-change or batch confirmation is the user's choice. `--publish` (Shopify theme publish, live REST writes) requires a **second** confirmation.
7. Re-verify and report: re-snapshot the preview/live/`--dev-url` target and re-run each finding's `verification.reproduce`; print a summary table, cache caveats, and the `--rollback <run_id>` command.

## Safety (hard rules)
- **Dry-run is the default**; writing requires the user to drop `--dry-run` and confirm.
- **Git-aware**: refuse to write to a dirty working tree unless `--force`; prefer creating/using a branch. Detect via `git status --porcelain`.
- **Backup** every file before first modification to `${CLAUDE_PLUGIN_DATA}/backups/<timestamp>/<path>`; remote writes store a `before.json` per resource for `--rollback`.
- **Idempotent**: detect existing tags/blocks; update in place, never duplicate (re-running `fix` produces no new diffs once applied).
- **Re-verify**: after writing, re-run the finding's `verification.assertion` (e.g. `node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-jsonld.mjs" --snapshot <pages/<slug>.json>`) and report pass/fail per change. <!-- reconcile-flags-v0.2 -->
- **Never touch** `.git/`, `.env`/secrets, lockfiles, or files outside the project root. Never put a credential in argv — env indirection only.
- **No fabrication**: never write invented statistics, citations, dates (no backdating `dateModified`), credentials, or identity links.

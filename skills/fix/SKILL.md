---
name: fix
description: Opt-in fixer (the /claude-seo-ai:fix command). Applies the safe, deterministic SEO/AI-search fixes from an audit to the user's code — meta viewport/charset/lang, JSON-LD, robots.txt AI directives, hreflang, sitemaps, OG/Twitter cards, image dimensions, canonical, llms.txt. Dry-run preview by default; writes only after explicit per-change confirmation. Runs only when the user invokes it — never auto-triggered.
disable-model-invocation: true
argument-hint: "<url|path> [--category schema|meta|robots|sitemap|hreflang|alt|canonical|social|llms] [--dry-run]"
allowed-tools: Read, Grep, Glob, Bash, Task
---

# fix (opt-in writer)

`disable-model-invocation: true` means the model can **never** trigger this on its own — only the user running `/claude-seo-ai:fix`. Writes happen only through the **seo-fixer-writer** subagent (the one agent with Write/Edit) and only after explicit confirmation.

## Fixability classes (from each finding's `fixable` field — see `schema/finding.schema.json`)
- **AUTO** — deterministic, additive, machine-verifiable, low-semantic-risk. May be written (with diff + confirmation):
  meta `viewport`/`charset`/`<html lang>`; Tier-1 JSON-LD blocks; `sameAs`/`@id`/`dateModified` (from confirmed inputs only); robots.txt AI-crawler presets + `Sitemap:` line; self-referential canonical; hreflang link sets; OG/Twitter cards; image `width`/`height`; XML sitemap entries; `llms.txt` (disclosure-gated).
- **PROPOSED** — changes prose/meaning or is editorial; generate a draft diff and require per-item accept: generated `<title>` and meta description, answer-block/TL;DR rewrites, internal-link insertions, heading restructuring, **generated image alt text** (titles, descriptions, and image alt are editorial messaging, not deterministic).
- **ADVISORY** — never written: content/E-E-A-T rewrites, adding stats/citations/original data, Core Web Vitals/performance, rendering strategy, redirects/status codes, link-building, Merchant Center/GBP backend data.

## Workflow
1. Take the findings (from the last audit or a fresh one). Filter to `fixable: auto` (+ `proposed` if the user opts in). Honor `--category` to scope (schema|meta|robots|sitemap|hreflang|alt|canonical|social|llms).
2. For each, locate the exact insertion point in the user's files and build a **unified diff** (or new-file content). Resolve any required real-world inputs (e.g. `sameAs` URLs, locale map, publish dates) by **asking the user** — never invent them.
3. **Dry-run (default)**: print every diff grouped by file. Write nothing. Summarize what `fix` (without `--dry-run`) would change.
4. On explicit confirmation (and only then): delegate to **seo-fixer-writer** to apply. Per-change or batch confirmation is the user's choice.

## Safety (hard rules)
- **Dry-run is the default**; writing requires the user to drop `--dry-run` and confirm.
- **Git-aware**: refuse to write to a dirty working tree unless `--force`; prefer creating/using a branch. Detect via `git status --porcelain`.
- **Backup** every file before first modification to `${CLAUDE_PLUGIN_DATA}/backups/<timestamp>/<path>`.
- **Idempotent**: detect existing tags/blocks; update in place, never duplicate (re-running `fix` produces no new diffs once applied).
- **Re-verify**: after writing, re-run the finding's `verification.assertion` (e.g. `scripts/validate-jsonld.mjs`) and report pass/fail per change.
- **Never touch** `.git/`, `.env`/secrets, lockfiles, or files outside the project root.
- **No fabrication**: never write invented statistics, citations, dates (no backdating `dateModified`), credentials, or identity links.

---
name: seo-fix-apply
description: Writer protocol preloaded into the seo-fixer-writer agent — how confirmed SEO/AI-search fixes are applied (git pre-flight, backup, Edit/Write for local diffs, adapter CLIs for remote targets, re-verify, publish only on a second confirmation) and the findings-array output contract. Used only by the fix flow after the user has confirmed changes; never invoked on its own.
user-invocable: false
allowed-tools: Read, Grep, Glob
---

# seo-fix-apply (writer protocol)

Created in Phase 0 so the `seo-fixer-writer` `skills:` preload resolves; Phase 3h extends it with the adapter flow (capabilities → plan → preview → ticketed apply → verify → publish → rollback). This file is the authoritative protocol and `agents/seo-fixer-writer.md` carries the in-context summary — keep the two in sync. Edit, Write and Bash are deliberately **not** pre-approved here: Claude Code's native diff and command prompts must reach the user for every write.

## Inputs
The `fix` command dispatches the writer with a JSON envelope: `RUN_DIR` (fix run dir `<DATA>/fix/runs/<id>/` holding `plan.json`, `manifest.json` with `confirmed[]`, `preview/`, `before/`, `after/`, `log.ndjson`), `SCRIPTS_DIR` (absolute `<plugin_root>/scripts/`), `DATA` (plugin data root — backups live there, never in the project), `PROJECT_ROOT` (local targets only), `confirmed_change_ids[]`, `publish` (default `false`), `force` (default `false`), `return: "JSON array of findings only"`. Scripts run as `node "<SCRIPTS_DIR>/<x>.mjs" …` with the literal absolute path — never `${...}` tokens or a relative `scripts/` path. <!-- reconcile-flags-v0.2 -->

## Protocol (per confirmed change, in order)
1. **Git pre-flight** — `git status --porcelain` in `PROJECT_ROOT`; a dirty tree means refuse to write (`status: warn`, reason in `evidence.observed`) unless the envelope carries `force: true`. Never `stash`, `checkout`, or `reset`.
2. **Backup** — before the first edit of any file, copy it to `<DATA>/backups/<run-id>/<relative path>`; one backup dir per run, recorded in `manifest.json`.
3. **Apply exactly the preview** — Edit/Write for local diffs so the native diff prompt and the `guard-write` hook engage. AUTO strategies: `html-head`, `front-matter`, `config-file`, `liquid`; every other strategy must have been individually accepted by the user. No reformatting, no extra content; `TODO:<field>` placeholders preserved verbatim.
4. **Remote targets** — a change whose `target.kind` is not `file` goes through the adapter CLIs under `<SCRIPTS_DIR>/adapters/` (Phase 3: `apply` requires a ticket; `publish` is a separate op with its own ticket). Until the adapter exists, do not apply: keep the finding's pre-fix `status`, put `skipped_unready` plus the manual path from `preview` in `evidence.observed`, and never emulate an adapter with ad-hoc `curl`.
5. **Idempotent** — if the change is already present, make no edit and report `status: pass` with `skipped_idempotent` in `evidence.observed`. Re-runs never duplicate or corrupt content.
6. **Re-verify** — run the finding's `verification.reproduce` verbatim (an absolute `node "<SCRIPTS_DIR>/…" --snapshot …` command) and record the assertion's pass/fail. A stale CDN or cache is `pending_cache` in `evidence.observed` with `status: warn` — never a claimed `pass`. <!-- reconcile-flags-v0.2 -->
7. **Publish** — only when the envelope carries `publish: true` (the user's **second** confirmation); otherwise leave the change staged and say so.
8. **Log** — append one line per change to `<RUN_DIR>/log.ndjson` (change id, files, result); redact any credential-looking value.

## Output contract
Return a JSON array of findings conforming to `schema/finding.schema.json` for the confirmed changes only. `status` uses the schema enum (`pass` when re-verification succeeds, else `fail`/`warn`; `needs_api` when verification needs an unavailable API) — there is no `skipped` status: a change that was not applied keeps its pre-fix `status` and states `skipped_<reason>` (`skipped_unconfirmed`, `skipped_unready`, `skipped_idempotent`) in `evidence.observed`. Quote what changed and name the backup path. Do not render the report — the `fix` flow does.

## Hard rules
- Apply only `confirmed_change_ids`; write only inside `PROJECT_ROOT` (or `<DATA>`); never touch `.env*`, `.git/`, lockfiles, CI configs, or anything `guard-write` protects.
- Never fabricate values (prices, dates, ratings, `sameAs` links); never backdate `dateModified`.
- Back up before the first write, re-verify after every write, refuse a dirty tree without `force`, publish only with `publish: true`.

---
name: fix
description: Opt-in fixer (the /claude-seo-ai:fix command). Applies the safe, deterministic SEO/AI-search fixes from a persisted audit to the user's site — meta viewport/charset/lang, JSON-LD, robots.txt AI directives, hreflang, sitemaps, OG/Twitter cards, image dimensions, canonical, AI discovery files — through the adapter that matches the platform (local files, Shopify theme/Admin, WordPress REST/WP-CLI, page APIs, or step-by-step instructions). Dry-run preview by default; writes only after explicit per-change confirmation. Runs only when the user invokes it — never auto-triggered.
disable-model-invocation: true
argument-hint: "<url|path> [--target auto|local|shopify|shopify-theme|shopify-admin|wordpress|wordpress-rest|wordpress-wpcli|page-api|webflow|wix|ghost|hubspot|bigcommerce|instructions] [--category M5 --category auto] [--include-proposed] [--store <shop>] [--provider <webflow|wix|ghost|hubspot|bigcommerce>] [--site <id>] [--wp-url <u>] [--ssh user@host:/path] [--project <dir>] [--dev-url <u>] [--run <run_id|latest>] [--report <path>] [--lang en|es] [--dry-run] [--publish] [--rollback <run_id>] [--force]"
allowed-tools: Read, Grep, Glob, Bash, Agent
---

# fix (opt-in writer)

`disable-model-invocation: true` means the model can **never** trigger this on its own — only the
user running `/claude-seo-ai:fix`. Writes happen only through the **seo-fixer-writer** subagent (the
one agent with Write/Edit) and only after explicit confirmation.

`--category` filters the report's findings and matches on a finding's **module id** (`M5`, `M7`, `M17`, …),
its **axis** (`search`, `ai`, or `both` — which matches both of the other two), its **fixable class**
(`auto`, `proposed`, `advisory`), or its **scope** (`page`, `site`, …), case-insensitively. It is **not**
a topic vocabulary and it does **not** split on commas: repeat the flag to widen the filter
(`--category M5 --category M17`). Translate what the user asks for into those words — "fix my schema"
is `--category M5`, "just the safe ones" is `--category auto` — and say which filter you applied.
`--target` accepts the adapter ids plus the aliases `local`, `shopify`, `wordpress`, `manual`, and the
provider names `webflow`/`wix`/`ghost`/`hubspot`/`bigcommerce` (each expands to `page-api`).

Two absolutes, before anything else:
- **Never fix from memory.** Every change comes from a persisted `report.json` on disk. If there is
  no report for this target, run the audit first — do not reconstruct findings from the transcript.
- **You never write.** This thread runs read-only ops (`capabilities`, `plan`, `preview`, `verify`).
  `apply`, `publish` and `rollback` belong to the writer subagent, and each needs a ticket.

## Fixability classes (from each finding's `fixable` field — see `schema/finding.schema.json`)
- **AUTO** — deterministic, additive, machine-verifiable, low-semantic-risk. May be written (with
  diff + confirmation): meta `viewport`/`charset`/`<html lang>`; Tier-1 JSON-LD blocks; `sameAs`/
  `@id`/`dateModified` (from confirmed inputs only); robots.txt AI-crawler presets + `Sitemap:`
  line; self-referential canonical; hreflang link sets; OG/Twitter cards; image `width`/`height`;
  XML sitemap entries; `llms.txt` (disclosure-gated, scored 0).
- **PROPOSED** — changes prose or meaning; draft the diff and require a per-item accept: generated
  `<title>` and meta description, answer-block/TL;DR rewrites, internal-link insertions, heading
  restructuring, **generated image alt text**.
- **ADVISORY** — never written: content/E-E-A-T rewrites, added stats or citations, Core Web Vitals,
  rendering strategy, redirects/status codes, link-building, Merchant Center/GBP backend data.

## Setup for every step
```
DATA="${CLAUDE_SEO_AI_HOME:-${CLAUDE_PLUGIN_DATA:-$HOME/.claude-seo-ai}}"
SCRIPTS="${CLAUDE_PLUGIN_ROOT}/scripts"
```
Every command below is `node "${CLAUDE_PLUGIN_ROOT}/scripts/<x>.mjs" …` with `--data "$DATA"`.
Credentials are **never** passed as flags: adapters read `CLAUDE_PLUGIN_OPTION_<KEY>` then `<KEY>`
from the environment. If a key is missing, name the key — never ask the user to paste a value here.

## Flow

**0. Resolve and short-circuit.** Resolve `DATA` and `SCRIPTS`. If `--rollback <run_id>` was given,
skip everything else: read `<DATA>/fix/runs/<run_id>/manifest.json`, show what would be restored
(files from `<DATA>/backups/<run_id>/`, `before/*.json` payloads, `previous_live_id` for a published
theme), confirm, then have the **writer** run each adapter's `rollback --all`. Report and stop.

**1. Load the report — never from memory.** Take `--report <path>`, else `--run <id>`, else the
latest run for this target under `<DATA>/runs/<host>/latest`. Read `report.json` (findings, scores,
target) and the `profile.json` beside it. If the report is missing, or `generated_at` is more than
24 h old, say so and offer to re-run `/claude-seo-ai:audit` first. Do not proceed on a stale report
without the user saying to.

**2. Confirm the platform profile.** Read `profile.platform`, `profile.framework`,
`profile.capabilities`, `profile.write_targets`. When platform confidence is below `high`, or
`--target auto` leaves more than one plausible write path, show what was detected (with the signals)
and ask the user to confirm or override with `--target`. A wrong profile writes to the wrong surface.

**3. Choose adapters and check readiness.** Selection rules, in this order:
- a local path target (or `--project <dir>`) ⇒ `local-files`, plus a platform adapter for
  per-resource fields the source tree does not own;
- shopify ⇒ `shopify-theme` + `shopify-admin`;
- wordpress ⇒ `wordpress-rest` when its credentials exist and the SEO plugin exposes writes, else
  `wordpress-wpcli` when `--ssh`/`WP_SSH` is set, else `instructions`;
- webflow / wix / ghost / hubspot / bigcommerce ⇒ `page-api` when the key exists, else `instructions`;
- squarespace / framer / unknown ⇒ `instructions`.

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/adapters/<adapter>.mjs" capabilities --data "$DATA"` for
each. List missing keys **by name only**, with the hint: run `/plugin` for claude-seo-ai to enter
them, or export them in the shell that starts Claude Code. A missing key downgrades that target to
`instructions`; it never stops the run.

**4. Plan.** One call builds the whole plan:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/fix-plan.mjs" --report <report.json> --profile <profile.json> \
  --targets <a,b> --run <run_id> [--category …] [--include-proposed] [--answers <json>] \
  [--project <dir>] [--dev-url <u>] [--lang en|es] --data "$DATA"
```
It writes `plan.json` + `manifest.json` into `<DATA>/fix/runs/<run_id>/` and returns a grouped
summary. Unresolved real-world inputs — a locale map, `sameAs` profile URLs, the robots preset, a
redirect's destination, a publication date — are **asked in chat and passed back via `--answers`**.
Never invent them, and never let a `TODO:<field>` placeholder reach a write.

**5. Preview.** For each change, `preview --run <dir> --change <id>`. Group the output by target and
badge every change with its `live_impact`: `[none]` (a file or a staged theme), `[staged]` (written
to a draft/unpublished surface, invisible to visitors), `[LIVE]` (visible immediately). Show the
unified diff for files, the request + variables + `before` values for API payloads, and the exact
command for CLI ops. Shopify theme changes also carry their `theme check` result — an error there
blocks apply.

**6. Stop on `--dry-run`.** Print the summary, say plainly that nothing was written, and end.
Dry-run is the default posture: if the user did not clearly ask to apply, treat it as a dry run.

**7. Confirm, then issue tickets.** Ask per change, or in one batch the user can accept as a whole —
their choice. Confirmation must name the `live_impact` of what they are accepting. For each
confirmed change, in the same turn as the confirmation:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/fix-ticket.mjs" issue --command "<the exact apply command>" \
  --run <run_id> --change <chg_id> --data "$DATA"
```
A ticket is one-shot and expires in 15 minutes. Record the confirmed ids in
`manifest.json.confirmed`. Never issue a ticket for a change the user has not just accepted, and
never for a command you have not shown them.

**8. Dispatch the writer — once.** One `Agent(seo-fixer-writer)` call with a JSON envelope:
`RUN_DIR`, `SCRIPTS_DIR` (the absolute `${CLAUDE_PLUGIN_ROOT}/scripts`), `DATA`, `PROJECT_ROOT`
(local targets), `confirmed_change_ids[]`, `tickets` (id per change), `publish` (default `false`),
`force`, `lang`, and `return: "JSON array of findings only"`. `--publish` requires a **second**
confirmation and its **own** ticket for the publish command — publishing is what makes staged work
visible, so it is never bundled with the apply confirmation.

**9. Verify.** For each applied change: `verify --run <dir> --change <id> [--dev-url <u>]`, plus the
finding's own `verification.reproduce`. Read the result honestly — a stale CDN or page cache is
`pending_cache`, never a pass. A local framework target with no dev server verifies at source level
only: say "source verified; re-audit after deploy" rather than claiming the live page is fixed.

**10. Report.** A table of change · target · live_impact · status · verification, then: what is
staged and not yet public, cache caveats, the rollback command
(`/claude-seo-ai:fix --rollback <run_id>`), and the next steps (publish, re-audit, remaining
`instructions` items the user has to click through).

## Target shapes
- **URL only** (no `--project`): never selects `local-files` — there is no source tree to edit. A
  framework site gets its per-resource fixes through the platform adapter and everything else
  through `instructions`, plus an offer to re-run with `--project <dir>` for source edits.
- **Local framework project**: the audit may have run against `http://localhost:3000` or built
  output, while the fix edits **source** through `route-map` (the route → file mapping), and
  `--dev-url` re-fetches the running dev server to verify. Say which of the three you verified.
- **Hosted builder with no API key**: `instructions` renders the exact click path in `--lang en|es`,
  with the values already filled in. That is a real outcome, not a failure.

## Safety (hard rules)
- **Dry-run is the default.** Writing requires the user to ask for it and confirm the change.
- **Git-aware**: refuse to write into a dirty working tree unless `--force`; check with
  `git status --porcelain` and prefer a `seo-fix/<date>` branch.
- **Backups first**: local files to `<DATA>/backups/<run_id>/<relpath>`, remote resources to
  `<RUN_DIR>/before/<change_id>.json`, Shopify to a full theme copy. `--rollback <run_id>` restores
  from exactly these.
- **Idempotent**: every change carries a marker or an existence check; re-running produces
  `skipped_idempotent`, never a duplicate block.
- **Never live by default**: Shopify pushes to an unpublished theme, Webflow/HubSpot stay staged,
  WordPress never touches `status` or post content, Wix sets `publish:false` unless the endpoint
  requires otherwise. Anything `[LIVE]` says so before you ask.
- **Never touch** `.git/`, `.env*`, lockfiles, key material, `wp-config.php`, or a Shopify
  `config/settings_data.json`. The `guard-write` and `guard-bash` hooks enforce this independently.
- **Credentials**: environment only, never in argv, never echoed, never written to a file in the
  repo. Commands in the log are redacted.
- **No fabrication**: no invented statistics, citations, prices, ratings or identity links, and no
  backdated `dateModified`.

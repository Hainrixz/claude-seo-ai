---
name: seo-orchestrator
description: Orchestrates a full SEO + AI-search audit — acquires the site with the bundled scripts (crawl/snapshot), detects platform and vertical, runs the deterministic checks, dispatches the read-only specialist subagents in parallel with a dispatch envelope, merges their findings into a persisted report, and presents the two scores. Invoked by the `audit` and `geo` commands; not called directly.
user-invocable: false
allowed-tools: Read, Grep, Glob, WebFetch, Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/*"), Bash(mkdir -p "${CLAUDE_PLUGIN_DATA}/runs/*"), Bash(cat > "${CLAUDE_PLUGIN_DATA}/runs/*"), Agent
---

# seo-orchestrator (Layer 2)

Coordinates the whole audit in three phases: **detect → dispatch → synthesize**. The scripts are the acquisition layer; the model only judges. Read the compact stdout summaries and the JSON files they name — **never paste HTML into the conversation**. Nothing is written to the user's project; every artifact lives under `${CLAUDE_PLUGIN_DATA}/runs/<host>/<run-id>/`.

## 1. Detect — one call
1. Resolve the target and the flags forwarded by the command (`--pages`, `--max`, `--render`, `--ua`, `--vertical`, `--environment`, `--feed`, `--out`; default `--out "${CLAUDE_PLUGIN_DATA}/runs"`).
2. Run the whole deterministic pipeline **in one command**. `audit.mjs` acquires the target (it calls `crawl.mjs` for a URL, `snapshot.mjs` for `--pages 1` or a local path, and skips acquisition entirely when handed a run directory), writes `profile.json` (platform / framework / cms plugins / hosting / environment / capabilities / write_targets / `vertical_hints`, plus a vertical guess), runs the checks registry, and calls `report.mjs` for a first deterministic-only report:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/audit.mjs" <url|path> \
  --out "${CLAUDE_PLUGIN_DATA}/runs" --checks deterministic --format json \
  [--pages N] [--max N] [--render static|auto|js] [--ua <preset>] \
  [--vertical <ids>] [--environment production|preview|staging|local] [--feed <path>]
```
   Read only the JSON summary it prints: `run_dir`, `mode`, `platform`, `vertical`, `coverage`, `tier`, `scores`, `findings`, `checks`, `report_json`, `report_md`, `findings_json`, `warnings`. `--render` defaults to **static** here — pass `--render auto` when the target looks client-rendered. Exit 2 means the target could not be acquired; exit 3 only means a `--fail-under` / `--fail-on-*` gate tripped, which is a CI concern, not a failed audit.
3. Read `<run_dir>/crawl.json` (pages with `slug`/`url`/`role`, templates, sampling, warnings) and `<run_dir>/profile.json`.
4. Vertical: run **seo-vertical-detect** over the homepage `parsed` (`<run_dir>/pages/<homepage-slug>.json`) plus `profile.vertical_hints`. The script only *guesses* — `profile.vertical.source` is `"inferred"` unless `--vertical` was passed. If your reading adds or changes a vertical, re-run the deterministic pass over the same run (no re-crawl) so the conditional checks actually fire:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/audit.mjs" <run_dir> --checks deterministic --format json --vertical <ids>
```
   `references/routing.md` maps vertical → conditional modules (M18 e-commerce, M19 local, M20 hreflang on `multilingual`).
5. The run now holds `<run_dir>/findings.deterministic.json` (the deterministic findings the agents must not re-emit) and `<run_dir>/checks.json` (checks run, errors, `needs_api`, `manual_review`, dropped).

## 2. Dispatch (parallel — one message, four `Agent` calls)
Spawn the four read-only specialists in **one message** so their verbose intermediate output stays isolated. Each prompt = the envelope block + that agent's module list. Agents never rely on `${…}` substitution: pass absolute paths.

```
ENVELOPE
plugin_root: <absolute ${CLAUDE_PLUGIN_ROOT}>
run_dir: <absolute run dir>
pages: [{slug, url, role}, …]              # <run_dir>/pages/<slug>.json (+ <slug>.html, + <slug>.rendered.html when rendered)
site: robots=<run_dir>/site/robots.json  sitemaps=<run_dir>/site/sitemaps.json  discovery=<run_dir>/site/discovery.json
vertical: {primary: <v>, also: [<v>…], multilingual: <bool>}
platform: <run_dir>/profile.json           # one line: <platform>/<framework>, env=<kind>, head_owner=<…>
platform_cards: [<plugin_root>/references/platforms/<id>.md, …]   # omit when the platform is unknown
modules: [<M-ids for this agent>]
deterministic_findings: <run_dir>/findings.deterministic.json — do not re-emit these ids; add model-judged findings only
return: JSON array only — findings per schema/finding.schema.json, no prose
```

| Agent | Modules |
|---|---|
| `technical-auditor` | M1, M2 (+M3), M4, M7, **M7b** (mobile), **M7c** (headings), M8, M9, M10, M15, M17 — plus **M20** (hreflang) when `vertical.multilingual` |
| `ai-search-geo-specialist` | M6, M11, M12, M14, **M21** (AI discovery & agent endpoints, weight 0), **M22** (agent-readiness) |
| `content-eeat-analyst` | M13, M16 |
| `schema-generator` | M5 — plus **M18** when `ecommerce` ∈ vertical, **M19** when `local-business` ∈ vertical |

Subagents have no Write/Edit — the audit can never mutate files. If an agent returns prose around the array, keep only the array.

## 3. Synthesize
1. Save each returned array verbatim to `<run_dir>/agents/<agent>.json` via a Bash heredoc (`mkdir -p "<run_dir>/agents" && cat > "<run_dir>/agents/<agent>.json" <<'EOF' … EOF`) — into the plugin data dir, never the project. This is the one Bash call outside the `node` pattern; the `mkdir -p` / `cat >` entries in `allowed-tools` pre-approve it for paths under `${CLAUDE_PLUGIN_DATA}/runs/` (TO-VERIFY in the smoke — a heredoc body containing `;`, `|` or `&&` may still prompt).
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs" <run_dir> --merge "agents/*.json" --lang <en|es> [--vertical <ids>] [--environment <kind>] [--out-md <path>]` — re-reads `findings.deterministic.json`, merges the agent arrays (dedupe by id + normalized location, most severe wins; `needs_api` / `manual_review` never override a scored status), drops schema-invalid findings into `report.dropped_findings`, scores per page and as a site rollup, and rewrites `findings.json`, `report.json`, `report.md`. Pass the same `--vertical` / `--environment` you used in step 1. `--merge` is repeatable and accepts a file, a directory, or a `*`/`?` glob on the file name only.
3. Present from `report.json` (bands/interpretations per `references/scoring-model.md`):
   - **Search SEO** and **AI Visibility** — band + score + one-line interpretation, never blended; per-category table for each (value, weight, active).
   - Coverage: `coverage.mode` (full vs deterministic), tier reached, `needs_api` / `manual_review` counts.
   - **Sampling table** from `crawl.json`: templates discovered vs sampled, pages by role, every skip and its reason.
   - Platform profile line (platform/framework/plugins, environment; "expected on preview" notes when non-production).
   - **Top actions** sorted by impact ÷ effort: status, evidence, recommendation, fixability (auto/proposed/advisory), `expected_impact`.
   - The absolute `report.md` path, then offers: `/claude-seo-ai:fix <target>` (safe AUTO fixes, confirmed per change) and `/claude-seo-ai:compare --baseline latest --against <target>` after changes.

## Degraded mode
If `node` is missing, or a skills-only install ships no `scripts/` directory: say so first. Fall back to `WebFetch` summaries only; mark every header/status/render/robots-dependent finding `needs_api`; skip persistence; label the report **"prompt-only mode — not comparable to a scripted run"**. Never present a WebFetch summary as raw HTML or as a measured status/header.

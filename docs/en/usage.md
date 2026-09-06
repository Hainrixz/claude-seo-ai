# Usage

A practical guide to running `claude-seo-ai` — installing it, running the five commands, finding the
reports it persists, and applying fixes safely on whatever platform your site runs on.

## Install

**As a Claude Code plugin (recommended):**

```
/plugin marketplace add Hainrixz/claude-seo-ai
/plugin install claude-seo-ai@claude-seo-ai
/reload-plugins
```

**Cross-agent (Cursor, Codex, Gemini CLI, Windsurf…) via Vercel Skills:**

```
npx skills add Hainrixz/claude-seo-ai
```

> Published at `github.com/Hainrixz/claude-seo-ai`. The plugin works fully offline (Tier 0) — no keys
> required. `npx skills add` installs the **Markdown skills only**; the `scripts/` acquisition layer,
> the subagents and the hooks are part of the plugin channel. See
> [`distribution.md`](distribution.md).

## The five commands

`claude-seo-ai` ships **five command skills** — `audit`, `geo`, `score`, `compare` and `fix`. There is
no root router and no subcommand parsing: each is its own top-level command. Claude Code namespaces
plugin skills, so every command is invoked as `/claude-seo-ai:<command>`. The target is either a URL
(`https://…`) or a local path (a web project or built HTML).

```
/claude-seo-ai:audit   <url|path> [--pages N] [--max N] [--render static|auto|js]
                                  [--ua default|googlebot|bingbot|gptbot|oai-searchbot|claude-searchbot]
                                  [--vertical ecommerce,docs] [--environment production|preview|staging|local]
                                  [--feed <path>] [--out <dir>]

/claude-seo-ai:geo     <url|path> [--pages N] [--render static|auto|js] [--feed <path>]
                                  [--probe "<question>"] [--gsc-ai-export <csv>]

/claude-seo-ai:score   [findings.json | run-dir | latest[:host]]

/claude-seo-ai:compare <urlA> <urlB> [<urlC>…]
                     | --baseline [latest] --against <url|run>
                     | --staging <url> --prod <url>
                     | <url> --gap "<query>"

/claude-seo-ai:fix     <url|path> [--target auto|local|shopify|wordpress|page-api|webflow|wix|ghost|hubspot|bigcommerce|instructions]
                                  [--category M5 --category auto] [--include-proposed]
                                  [--project <dir>] [--dev-url <u>] [--run <run_id|latest>] [--report <path>]
                                  [--lang en|es] [--dry-run] [--publish] [--rollback <run_id>] [--force]
```

| Command | What it does | Writes files? |
|---|---|---|
| `audit` | Full read-only audit on both axes; persists a run and a report. | No — never |
| `geo` | AI-search (GEO/AEO) subset → AI Visibility score + citability report, plus unscored probes. | No |
| `score` | Recompute/show the two scores from a persisted run or a findings file. | No |
| `compare` | Baseline, staging vs production, competitor matrix, or content gap — from persisted runs. | No |
| `fix` | Opt-in fixer; previews everything, writes only after you confirm each change. | Only on confirm |

`audit`, `geo`, `score` and `compare` are read-only and can be triggered by description. `fix` is
`disable-model-invocation: true` — only **you** can invoke it, and the model never auto-triggers it.

Every artifact lives under the plugin data directory, never in your project.

### `audit`

Read-only. It invokes `seo-orchestrator`, which runs the whole deterministic pipeline in one command
(`scripts/audit.mjs`), detects platform and vertical, dispatches the four read-only specialist
subagents in parallel, merges their findings into the persisted run, and scores.

```
# A live site, sampling 12 pages (the default)
/claude-seo-ai:audit https://example.com

# One page only
/claude-seo-ai:audit https://example.com --pages 1

# A client-rendered SPA — render is opt-in, never automatic
/claude-seo-ai:audit https://example.com --render auto

# A local project or built output
/claude-seo-ai:audit ./dist

# Declare the vertical instead of letting the run infer it
/claude-seo-ai:audit https://shop.example.com --vertical ecommerce --feed ./products.jsonl

# A preview deployment: the expected noindex/robots caps are suppressed
/claude-seo-ai:audit https://pr-42.vercel.app --environment preview
```

Flags, as `audit.mjs` reads them:

| Flag | Default | Meaning |
|---|---|---|
| `--pages N` | 12 | How many pages to sample. `--pages 1` snapshots instead of crawling. |
| `--max N` | 40 | Upper bound on the URL frontier the crawler will consider. |
| `--render static\|auto\|js` | `static` | **A headless audit never launches a browser unless asked.** `auto` renders when the static HTML looks JS-dependent; `js` always tries. |
| `--ua <preset>` | our own token | `default`, `googlebot`, `bingbot`, `gptbot`, `oai-searchbot`, `claude-searchbot`, or a literal UA string. |
| `--vertical <ids>` | inferred | Comma list of `saas,blog-publisher,local-business,ecommerce,docs,generic`. Declaring it is what activates the conditional categories deterministically. |
| `--environment <kind>` | `production` | `production`, `preview`, `staging`, `local`. |
| `--feed <path>` | — | A product feed for the Agentic Commerce Protocol lint (e-commerce vertical only). |
| `--out <dir>` | the data dir | Runs root. |

You get: both scores with bands and one-line interpretations, per-category tables, the sampling table
(templates discovered vs sampled, and every skip with its reason), the data tier reached, the
`needs_api` / `manual_review` counts, the detected platform profile, and the prioritized actions
sorted by impact ÷ effort. It ends by offering `fix` and `compare`.

### `geo`

The AI-search subset only — answer extractability (M11), fact density (M12), AI-crawler access and
Google AI-feature eligibility (M14), AI discovery endpoints (M21, weight 0), agent readiness (M22),
entity linking (M6), plus schema (M5) and rendering (M4) because they feed AI visibility.

```
/claude-seo-ai:geo https://example.com
/claude-seo-ai:geo https://example.com --probe "best sustainable running shoes"
/claude-seo-ai:geo https://example.com --gsc-ai-export ./search-console-generative-ai.csv
```

`--pages`, `--render` and `--feed` are forwarded to `audit.mjs` unchanged. `--probe` and
`--gsc-ai-export` are handled by the skill: they are **probes — reported, never scored** (severity 0,
excluded from the AI Visibility score and from every cap). See
["Probes"](#probes-reported-never-scored) below.

### `score`

Recomputes the two scores from a persisted run without re-crawling, by running `scripts/score.mjs`
for a reproducible number.

```
# The most recent run for a host
/claude-seo-ai:score latest:example.com

# A specific run directory
/claude-seo-ai:score ~/.claude-seo-ai/runs/example.com/2026-09-06T10-14-33Z

# A saved findings file
/claude-seo-ai:score ./findings.json
```

Directly:

```bash
node scripts/score.mjs --run <run-dir>                       # reads <run-dir>/findings.json
node scripts/score.mjs --findings findings.json --vertical ecommerce --multilingual
node scripts/score.mjs --findings findings.json --environment staging
cat findings.json | node scripts/score.mjs
```

> `score.mjs --run` takes a **directory or a findings file — it does not understand the word
> `latest`**. The skill resolves the pointer for you; if you are scripting it yourself, read
> `<root>/<host>/latest.json` (`{ run, path, updated_at }`) and pass its `path`.

`--strict` exits 2 when any finding was dropped as schema-invalid, instead of dropping it quietly.
`--validate-only` checks the findings and reports without scoring.

### `compare`

Four comparisons, one script, all from persisted runs. A URL with no run is audited first
(deterministically, `--pages 3 --render static`), never silently skipped.

```
# Did this deploy make anything worse?
/claude-seo-ai:compare --baseline latest --against https://example.com

# Staging vs production
/claude-seo-ai:compare --staging https://staging.example.com --prod https://example.com

# Up to five sites side by side
/claude-seo-ai:compare https://example.com https://rival-a.com https://rival-b.com

# What do the pages that already answer this query have that we don't?
/claude-seo-ai:compare https://example.com --gap "how to choose running shoes"
```

Directly:

```bash
node scripts/compare.mjs --baseline latest --against <url|run-dir> [--mode auto|baseline|staging|competitor|gap]
node scripts/compare.mjs --prod <ref> --staging <ref>
node scripts/compare.mjs <refA> <refB> [<refC>…]
node scripts/compare.mjs --subject <ref> --set <ref,…> --query "<q>" --mode gap
```

A `<ref>` is a run directory, a `report.json`, `latest[:<host>]`, `baseline[:<host>]`, or a URL.

| Mode | When `--mode auto` picks it | What you get |
|---|---|---|
| `baseline` | both refs resolve to the same host | score/category deltas plus a findings diff: fixed, new, regressed, improved, unchanged |
| `staging` | two hosts joined by `--map`, or one that looks like a staging deployment (`staging.`, `preview`, `.vercel.app`, `.myshopify.com`) | the same diff, with hosts normalized so a URL change is not read as a new finding |
| `competitor` | two or more different hosts and no `--map` | score/category table, a presence matrix and "subject vs best-in-set" gaps — **no findings diff across sites** |
| `gap` | set explicitly with `--subject` / `--set` / `--query` | heading topics present in ≥2 rivals and absent from you, schema types, fact frequencies, word counts, answer blocks, agentic endpoints |

Useful flags: `--map staging.example.com=example.com` (repeatable) · `--format json|md` ·
`--fail-on-regression` (exit 3 on any regressed finding or an axis dropping more than 2 points) ·
`--set-baseline` (writes `runs/<host>/baseline.json`, which is exempt from pruning) · `--data`
(print the whole comparison document instead of the summary).

Transitions involving `needs_api` / `manual_review` are listed separately and are **never** counted
as fixed or regressed — losing an API key is not a regression in your site.

The same rule covers the page sample. When a page one run scored is unscored in the other — it came
back 429 or 404, or that crawl never sampled it — the two site scores are means over different page
sets. Those pages are listed in `page_coverage`, their per-page rows are marked `coverage_change`
instead of carrying a delta, the axis deltas stop counting towards the verdict, and a warning says
why. A rate-limited re-crawl can never read as an improvement.

Honesty notes the skill repeats to you: `WebSearch` in gap mode is one engine at one moment, not rank
tracking; competitor scores describe structure, not predicted rankings; and a deterministic-only run
is labeled as such.

### `fix`

Opt-in writer — covered in full below.

## Where reports live

Nothing is written into your project. Runs live under a root resolved in this order:

```
--out <dir>  ›  $CLAUDE_SEO_AI_HOME  ›  $CLAUDE_PLUGIN_DATA/runs  ›  ~/.claude-seo-ai/runs
```

```text
<root>/index.json                       every host, its runs, its latest and baseline ids
<root>/<host>/latest.json               { run, path, updated_at }  ← the portable pointer
<root>/<host>/latest                    a symlink to the same run (best effort; Windows-tolerant)
<root>/<host>/baseline.json             set by `compare --set-baseline`; exempt from pruning
<root>/<host>/<run-id>/
    crawl.json                          pages, roles, templates, the sampling table, warnings
    profile.json                        platform / framework / plugins / hosting / environment
                                        + capabilities + write_targets + vertical
    pages/<slug>.json                   one PageSnapshot per page (+ .html, + .rendered.html)
    site/robots.json  site/robots.txt   the parsed robots.txt and the bytes it came from
    site/sitemaps.json                  sitemap index recursion, gzip handled
    site/discovery.json                 llms.txt, agents.md, /.well-known/ucp, agentic sitemap…
    checks.json                         checks run, per-module counts, errors, dropped findings
    findings.deterministic.json         what the scripts proved
    agents/<agent>.json                 what each subagent judged
    findings.json                       the merged, deduplicated, schema-valid set
    report.json                         conforms to schema/audit-report.schema.json
    report.md                           the human report (EN/ES)
<root>/compare/<a>__<b>/compare.json    comparisons
```

`<host>` is the lower-cased host with `:` → `_` (so a port survives on every filesystem); local
targets become `local/<basename>-<hash>`. Run ids are UTC timestamps, so they sort chronologically.
Retention keeps the last 20 runs per host (5 for gap-analysis hosts); the baseline is never pruned.

`--lang en|es` sets the language of `report.md` and of everything written around the numbers:
headings, table labels, the interpretation line and every warning. Finding text — title, evidence,
recommendation — stays English, because it comes from the checks.

The fix flow uses a second tree under the data directory:

```text
<DATA>/fix/runs/<run-id>/plan.json      every planned Change, with its coverage accounting
<DATA>/fix/runs/<run-id>/manifest.json  dry_run, confirmed ids, per-change results, timestamps
<DATA>/fix/runs/<run-id>/preview/…      the rendered diff / payload / command / instructions
<DATA>/fix/runs/<run-id>/before/…       pre-write state, which is what a rollback restores
<DATA>/fix/runs/<run-id>/after/…        post-write state, which is what verify reads
<DATA>/fix/runs/<run-id>/log.ndjson     append-only audit log (commands redacted)
<DATA>/backups/<run-id>/<relpath>       byte-for-byte copies of every edited local file
<DATA>/fix/tickets/<sha256>.json        one-shot confirmation tickets, 15-minute TTL
```

## Reading the dual-score report

Two **independent** 0–100 scores, never blended into one. A page can rank well in Google yet be
uncitable by AI engines, or the reverse.

| Score | Weighted toward |
|---|---|
| **Search SEO** | indexability & crawl, Core Web Vitals, on-page, structured data, rendering, internal linking |
| **AI Visibility (GEO/AEO)** | answer extractability, AI-crawler access & eligibility, fact density, schema, rendering, entities |

Each score has a letter band (A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F below) plus a one-line
interpretation. Full weights and formulas: [`scoring.md`](scoring.md) and
[`references/scoring-model.md`](../../references/scoring-model.md).

Four states an axis can be in, and they mean different things:

- **`scored`** — enough of the always-on weight carried a scored finding.
- **`partial`** (*provisional*) — coverage is below 50 % of the always-on weight, so the band is
  labeled provisional and the report names the unmeasured categories. A one-page run that only
  measured two categories does not get to look like an A.
- **`capped`** — a **severity-5, `established`, failing** finding inside an active category caps the
  axis at 40. Only `established` confidence can cap: a `directional` severity-5 failure never does.
- **`unscored`** — no scored finding in any active category on that axis. Never an F, because a
  missing score is not a bad score.

### What `needs_api` and `manual_review` mean

Some checks cannot be verified from static HTML. A check that needs a higher data tier (a renderer,
`PSI_API_KEY`, Search Console) is `needs_api`; one that needs a human judgment (is this claim
"strong"? is this source authoritative?) is `manual_review`. Both are **excluded from the score
math** and counted separately as score confidence, so a high score backed by many unverifiable checks
is reported honestly rather than inflated. Neither is ever a silent pass.

## Probes — reported, never scored

Two optional inputs sit **beside** the score and never inside it.

**`--probe "<question>"`** (repeatable) runs one `WebSearch` per question, reads the organic results
in order, and feeds them to `scripts/probe-report.mjs`, which returns presence rate, best rank, a
competitor-host tally, and a trend against earlier probes for that host. The finding is
`M14.probe.web_presence`, **severity 0**. The script emits a disclaimer that the skill quotes
verbatim rather than paraphrasing: this is web-search presence, not AI Overview / AI Mode / ChatGPT /
Perplexity citation data, because no vendor exposes that. Indexing is a documented *precondition* for
Google's AI features — presence here is necessary, not sufficient.

**`--gsc-ai-export <csv>`** imports a Search Console **Generative AI** performance export you
downloaded by hand (there is no API for it). English and Spanish column headers are both recognized.
The report carries **impressions only** — no clicks, no citations, no per-answer attribution —
because that is all Google exposes. Findings `M14.gsc_ai.impressions_present`, `.zero_impressions`,
`.unavailable`, all **severity 0**.

If you ask "did my AI visibility go up?", the honest answer is that these are proxies and the score
is a structural assessment. They are reported separately for exactly that reason.

## The opt-in fixer

`fix` is `disable-model-invocation: true` — the model can **never** trigger it. Only you, by running
`/claude-seo-ai:fix`, do. Writes go through the single `seo-fixer-writer` subagent (the only agent
with Write/Edit; every auditor is read-only by tool allowlist).

**Dry-run is the default posture.** If you did not clearly ask to apply, it is treated as a dry run.

### The flow

1. **Load the report — never from memory.** Every change comes from a persisted `report.json` on
   disk (`--report <path>`, else `--run <id>`, else the latest run for that target). If the report is
   missing or more than 24 h old, you are told and offered a re-audit first. Findings are never
   reconstructed from the conversation.
2. **Confirm the platform profile.** When platform confidence is below `high`, or `--target auto`
   leaves more than one plausible write path, you see what was detected — with the signals — and
   confirm or override. A wrong profile writes to the wrong surface.
3. **Check readiness.** Credentials are re-checked **against the environment the fix is running in**,
   not against the `ready` flag the audit froze into `profile.json`: export the keys (or fill the
   `/plugin` prompts) and `--target auto` picks the adapter up on the next run, without re-auditing.
   The plan prints one line per adapter — ready / not ready, the keys it needs, and the ones still
   missing, **by name only**. Each adapter's `capabilities` op then reports what it can do. A missing
   key downgrades that target to `instructions`; it never stops the run. (Tool detection — a
   `shopify` or `wp` binary on `PATH` — still comes from the audit-time profile.)
4. **Plan.** One `fix-plan.mjs` call groups the report's fixable findings by the adapter that owns
   each surface and writes `plan.json` + `manifest.json`. Unresolved real-world inputs — a locale
   map, `sameAs` profile URLs, the robots preset, a redirect destination, a publication date — are
   asked in chat and passed back with `--answers`. Never invented, and a `TODO:<field>` placeholder
   never reaches a write.
5. **Preview.** Every change is rendered and badged with its live impact: `[none]` (a file or a
   staged theme), `[staged]` (a draft surface, invisible to visitors), `[LIVE]` (visible
   immediately). Files get a unified diff; API changes get the request, the variables and the
   `before` values; CLI ops get the exact command. Shopify theme changes also carry their
   `theme check` result, and an error there blocks apply.
6. **Stop on `--dry-run`.** The summary prints, nothing is written, done.
7. **Confirm, then tickets.** You accept per change or as a batch — your choice — and the
   confirmation names the live impact of what you are accepting. Each accepted change gets a
   one-shot, 15-minute confirmation ticket issued in the same turn as your yes.
8. **The writer runs once.** One dispatch to `seo-fixer-writer` with the confirmed ids and their
   tickets. `--publish` needs a **second** confirmation and its **own** ticket, because publishing is
   what makes staged work visible.
9. **Verify.** Each applied change is re-verified, plus the finding's own `verification.reproduce`. A
   stale CDN or page cache is reported as `pending_cache`, **never** as a pass. A local project with
   no dev server is verified at source level only, and says so.
10. **Report.** Change · target · live impact · status · verification, then what is still staged,
    cache caveats, the rollback command, and the remaining `instructions` items you have to click
    through yourself.

### Coverage — nothing is dropped quietly

The plan accounts for **every** finding in the report, so a plan can never print "2 changes" over a
report of 30 findings and say nothing about the other 28:

```
findings 127 · actionable 86 · considered 11 · planned 11 (auto 0 · proposed 11)
skipped proposed 37   → re-run with --include-proposed to plan them
advisory 6            → never written by this tool; a person decides
unroutable 0          → considered but owned by no adapter
by adapter: local-files 7 considered / 0 planned · instructions 11 considered / 11 planned
```

`planned ⊆ considered`, and `unroutable = considered − planned`. The same object is in the CLI
result, in `plan.json` as `plan.coverage`, on each group, and in `manifest.counts`.

### `--category` is module ids, not topics

`--category` matches a finding's **module id** (`M5`, `M7`, `M17`, …), its **axis** (`search`, `ai`,
or `both`, which matches both of the others), its **fixable class** (`auto`, `proposed`,
`advisory`), or its **scope** (`page`, `site`, …), case-insensitively. It does **not** split on
commas — repeat the flag to widen the filter:

```
/claude-seo-ai:fix https://example.com --category M5 --category M17   # schema + sitemaps
/claude-seo-ai:fix https://example.com --category auto                # only the safe class
```

### What it can and can't write

| Class | Examples | Behavior |
|---|---|---|
| **AUTO** | meta `viewport`/`charset`/`<html lang>`, Tier-1 JSON-LD, robots.txt AI presets + `Sitemap:`, self-referential canonical, hreflang sets, OG/Twitter cards, image `width`/`height`, XML sitemap entries, `llms.txt` (disclosure-gated, scored 0) | Written after diff + confirmation |
| **PROPOSED** | generated `<title>` / meta description, answer-block and TL;DR rewrites, internal-link insertions, heading restructuring, generated image alt text | Per-item accept required; withheld entirely without `--include-proposed` |
| **ADVISORY** | content and E-E-A-T rewrites, added stats or citations, Core Web Vitals, rendering strategy, redirects and status codes, link-building, Merchant Center / Business Profile backend data | **Never written** |

Only the `html-head`, `front-matter`, `config-file` and `liquid` insertion strategies can produce an
AUTO change. Every JSX/TS strategy is PROPOSED, and nothing in this tool regex-rewrites JSX.

### Never live by default

Per platform, and enforced by the adapters rather than by prose — see
[`platforms.md`](platforms.md#what-never-goes-live-by-default) for the full list. In short: Shopify
pushes to an unpublished theme and a live push from the shell is a hard deny in the `guard-bash`
hook; Webflow and HubSpot changes stay staged until a separately-ticketed publish; Ghost never flips
`status` or touches the body; WordPress never touches `status` or post content; Wix and BigCommerce
have no staging surface, so their changes are badged `[LIVE]` before you are asked.

### Rollback

```
/claude-seo-ai:fix --rollback <run_id>
```

It reads `<DATA>/fix/runs/<run_id>/manifest.json`, shows what would be restored — local files from
`<DATA>/backups/<run_id>/`, remote resources from `before/*.json`, and `previous_live_id` for a
published theme — asks, and only then restores. A change never moves backwards through its status
machine, so the manifest can be replayed honestly.

### Other safety guarantees

- **Git-aware** (*writer protocol, not code*) — `skills/seo-fix-apply` instructs the writer subagent
  to run `git status --porcelain` first, refuse a dirty working tree unless `--force`, and prefer a
  `seo-fix/<date>` branch. No adapter runs git: this one holds because the writer follows its
  protocol, unlike the guarantees below it, which hold whatever the model does.
- **Idempotent** — every change carries a marker or an existence check, so re-running produces
  `skipped_idempotent`, never a duplicate block.
- **Never touches** `.git/`, `.env*`, lockfiles, key material, `wp-config.php`, or a Shopify
  `config/settings_data.json`. Two PreToolUse hooks (`guard-write` for the file tools, `guard-bash`
  for the shell) enforce this independently of the model.
- **Credentials** are environment-only: never in `argv`, never echoed, never written into the repo,
  and redacted in the fix log.
- **No fabrication** — no invented statistics, citations, prices, ratings or identity links, and no
  backdated `dateModified`.

> The confirmation tickets are procedural hardening, not a capability boundary: hooks inherit Claude
> Code's environment. The real backstop is your own Bash permission prompt — never allowlist
> `Bash(shopify:*)`, `Bash(wp:*)` or `Bash(ssh:*)`.

## Credentials

Adapters read `CLAUDE_PLUGIN_OPTION_<KEY>` first (what a plugin `userConfig` prompt exports), then
the bare `<KEY>` from the environment. So either:

- run **`/plugin`** → claude-seo-ai and fill in the prompts, or
- `export` the keys in the shell that starts Claude Code.

There is deliberately **no `--key` flag** anywhere: a secret on a command line lands in `ps`, in
shell history and in every command log, and these scripts print the command to re-run. Per-platform
keys and what each one is for: [`platforms.md`](platforms.md#credentials).

## The scripts, directly

The zero-dependency Node helpers (Node ≥ 18, no install step) are the acquisition layer, and every
one of them is also runnable by hand. This is what makes each finding's `verification.reproduce` a
real command.

```bash
# Acquire one page into a run directory
node scripts/snapshot.mjs https://example.com --out ./runs --render auto --json

# Crawl a site (robots-respecting, template-sampled)
node scripts/crawl.mjs https://example.com --out ./runs --pages 12 --per-template 2 --depth 3

# The whole deterministic pipeline: acquire → profile → checks → report
node scripts/audit.mjs https://example.com --out ./runs --pages 5 --format json

# Re-run the checks over an existing run without re-crawling
node scripts/audit.mjs <run-dir> --checks deterministic --format md

# Score and compare
node scripts/score.mjs   --run <run-dir>
node scripts/compare.mjs --baseline latest --against <run-dir> --format md

# Point checks at anything
node scripts/detect-platform.mjs --url https://example.com --probe
node scripts/validate-jsonld.mjs --snapshot <run>/pages/<slug>.json
node scripts/ai-eligibility.mjs  --snapshot <run>/pages/<slug>.json
node scripts/acp-feed-lint.mjs   --feed ./products.jsonl --strict
```

None of the scripts has a `--help` flag. Run one with no arguments and it prints its usage line; the
comment block at the top of each file is the full contract.

**Exit codes are uniform:** `0` ok · `1` usage · `2` runtime · `3` a threshold or gate tripped.

## CI

`action.yml` at the repository root is a composite GitHub Action running the same deterministic
subset (the model-judged modules need Claude Code, so the two scores in CI describe what a script can
prove — not everything the full audit covers).

```yaml
- id: seo
  uses: Hainrixz/claude-seo-ai@v0.2.0
  with:
    url: https://example.com
    pages: '5'
    render: static
    lang: en
    fail-under-search: '70'
    fail-under-ai: '60'
    fail-on-gated: 'true'

- run: echo "Search ${{ steps.seo.outputs.search-score }} (${{ steps.seo.outputs.search-band }})"
```

Inputs: `url` (required), `pages`, `max`, `render`, `lang`, `environment`, `vertical`,
`fail-under-search`, `fail-under-ai`, `fail-on-gated`, `fail-on-severity`, `out`, `node-version`,
`upload-artifact`, `artifact-name`.
Outputs: `search-score`, `ai-score`, `search-band`, `ai-band`, `report-json`, `report-md`, `run-dir`,
`exit-code`.

The job summary is written to `$GITHUB_STEP_SUMMARY`, the run directory is uploaded as an artifact by
default, and a tripped gate exits 3 and emits a `::error` annotation per gate. A ready-to-copy
workflow is in [`.github/workflows/seo-audit-example.yml`](../../.github/workflows/seo-audit-example.yml).

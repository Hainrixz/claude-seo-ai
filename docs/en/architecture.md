# Architecture

`claude-seo-ai` is a Claude Code plugin that audits and (opt-in) fixes classic **Search SEO** and
**AI-search visibility (GEO/AEO)** for any website or web codebase. This document describes the
**current** design.

The one sentence that explains every other decision: **the scripts acquire and prove; the model
judges.** Nothing that a deterministic script can measure is left to a language model, and nothing a
language model guesses is allowed to look like a measurement.

## Entry points: five command skills

There is no root skill and no subcommand router. The plugin exposes five command skills directly
under `skills/`, each invoked as a namespaced slash command (the plugin name `claude-seo-ai` is the
namespace):

| Command | Skill | Purpose | Writes? |
|---|---|---|---|
| `/claude-seo-ai:audit` | `audit` | Full read-only SEO + AI-search audit → two scores + a persisted report | No |
| `/claude-seo-ai:geo` | `geo` | AI-search (GEO/AEO) subset → AI Visibility + citability breakdown, plus unscored probes | No |
| `/claude-seo-ai:score` | `score` | Recompute/redisplay the two scores from a persisted run, no re-crawl | No |
| `/claude-seo-ai:compare` | `compare` | Baseline · staging vs production · competitor matrix · content gap | No |
| `/claude-seo-ai:fix` | `fix` | Apply safe, deterministic fixes after explicit per-change confirmation | Yes (gated) |

`fix` carries **`disable-model-invocation: true`** — the model can never auto-trigger it. It runs only
when the user types `/claude-seo-ai:fix`. The other four are read-only and may be model-invoked.

## Three layers

```
Layer 1  DIRECTIVE     audit · geo · score · compare · fix         (the five command skills)
                                    |
                                    v
Layer 2  ORCHESTRATION  seo-orchestrator
             audit.mjs (acquire → profile → checks → first report)
             -> dispatch four read-only subagents in parallel (one message, four Agent calls)
             -> report.mjs (merge, score, render)
                                    |
                                    v
Layer 3  EXECUTION     23 seo-* module skills (M1..M22), preloaded into their agent
             + the zero-dependency Node scripts that are the acquisition and proof layer
```

**Layer 1 — Directive.** The command skills are thin: they parse `$ARGUMENTS`, hand the target and
flags to the orchestrator (or, for `score` / `compare`, straight to the script), and render results
in the user's language (EN/ES).

**Layer 2 — Orchestration.** `seo-orchestrator` runs **detect → dispatch → synthesize**. It never
pastes HTML into the conversation: it reads the compact stdout summaries and the JSON files they
name.

**Layer 3 — Execution.** Each `seo-*` module skill evaluates one concern and emits findings. Module
skills are `user-invocable: false` and are **preloaded into their agent** through the agent's
`skills:` list, so they cost context only inside the subagent that needs them.

## The subagent tool is `Agent`

The orchestrator dispatches with the **`Agent`** tool — not the legacy `Task` name — in one message
carrying four calls, so the specialists run in parallel and their verbose intermediate output stays
isolated in their own contexts.

Agents never rely on `${…}` substitution: the dispatch envelope carries **absolute** paths.

```
ENVELOPE
plugin_root: <absolute ${CLAUDE_PLUGIN_ROOT}>
run_dir: <absolute run dir>
pages: [{slug, url, role}, …]        # <run_dir>/pages/<slug>.json (+ .html, + .rendered.html)
site: robots=…/site/robots.json  sitemaps=…/site/sitemaps.json  discovery=…/site/discovery.json
vertical: {primary, also: […], multilingual}
platform: <run_dir>/profile.json
platform_cards: [<plugin_root>/references/platforms/<id>.md, …]
modules: [<M-ids for this agent>]
deterministic_findings: <run_dir>/findings.deterministic.json   # do not re-emit these ids
return: JSON array only — findings per schema/finding.schema.json, no prose
```

`deterministic_findings` is what keeps the model from re-deriving what a script already proved. An
agent adds model-judged findings on top; it never restates the deterministic set.

Every script command an agent runs is absolute:
`node "<plugin_root>/scripts/<x>.mjs" --snapshot "<run_dir>/pages/<slug>.json"` — which is exactly
the string each finding carries in `verification.reproduce`.

## Acquisition: PageSnapshot v2 on disk

`scripts/snapshot.mjs` fetches one URL (or reads one local file) and writes a **PageSnapshot** to
`<run>/pages/<slug>.json`, with the bytes beside it as `<slug>.html`. `WebFetch` is not an
acquisition layer — inside Claude Code it returns a small-model markdown summary, never raw HTML,
headers or status codes — so every header-, status-, render- or robots-dependent check reads the
script's output instead.

```
PageSnapshot {
  snapshot_version, plugin_version, generated_at, run_id
  target        { kind, value, requested_url, final_url, host, origin, slug, path }
  request       { ua_preset, user_agent, accept_language, timeout_ms, max_hops, max_bytes }
  status_chain  [ { url, status, location? } ]        // every hop, in order
  status, ok
  redirects     { hops, loop, truncated, http_to_https, host_changed, www_normalized, … }
  headers       { … }                                  // incl. X-Robots-Tag and content-type
  cookie_names  [ … ]                                  // names only — never values
  header_links  { all[], canonical, alternates[] }     // parsed Link: header
  robots_directives { header, meta[], effective, sources[] }
  body          { bytes, truncated, charset, content_encoding, gunzipped, sha256 }
  timing        { ttfb_ms, download_ms, total_ms }
  raw_html_path, rendered_html_path
  render        { needed, signals[], markers[], mode, renderer, used, confidence, hint, delta }
  parsed        { title, metas[], robots_meta[], lang, canonicals[], hreflang[], anchors[],
                  headings[], images[], scripts[], jsonld[], forms[], iframes[], landmarks,
                  markers, word_count, text_sample, … }
  parsed_rendered                                      // the same shape over the rendered DOM
  site          { robots, sitemaps, sitemap_urls, discovery, robots_txt }   // paths, shared per run
  warnings[], tier
}
```

Notes that matter downstream:

- **`status_chain` is the whole chain**, so a 301→302→200 is a fact, not an inference. Loops and
  truncation are flagged rather than followed forever.
- **Cookie names only, never values.** Nothing secret enters a run directory.
- **`--ua <preset>`** writes a parallel `pages/<slug>.ua-<preset>.json`, which is how `ua-diff.mjs`
  compares what a bot sees against what a browser sees.
- **`--max-bytes`** truncation is recorded in `body.truncated` and raised as a warning, so partial
  parses never masquerade as complete ones.
- **Site artifacts are fetched once per run** into `<run>/site/`, not once per page.

### The render decision

`--render` defaults to **`static`**: a headless run never launches a browser unless asked.

- `needsRender()` looks at the static HTML for: fewer than 150 words in content regions, an empty
  framework mount point (`next_root_empty`, `app_root_empty`), hydration markers with fewer than 400
  words, no `<h1>` and fewer than 3 links, or a "please enable JavaScript" notice.
- `--render auto` renders when those signals fire; `--render js` always tries.
- The renderer is found, never installed: `findChrome()` looks for an already-installed
  Chrome/Chromium/Edge/Brave (honoring `CLAUDE_SEO_AI_CHROME`, `CHROME_PATH`,
  `PUPPETEER_EXECUTABLE_PATH`, then a Playwright browser cache), and `renderWithPlaywright()` runs
  only when the `playwright` package already resolves.
- **`--rendered-file <dom.html>`** takes a DOM captured elsewhere — a render MCP, your own headless
  script — and treats it as the rendered pass.
- When no renderer is available the snapshot keeps `rendered_html_path: null`, sets
  `render.confidence = reduced`, records the hint, and the checks emit an honest M4 finding. It never
  pretends it saw rendered content.

`scripts/crawl.mjs` builds on this: robots-aware discovery (sitemaps → URL-template patterns →
breadth-first over internal anchors to `--depth`), then **template sampling** — the homepage and the
target always, then at most `--per-template` pages per template, then a round-robin fill until
`--pages`. Every skip is logged with its reason in the sampling table, so "we looked at 12 of 4,000
pages" is visible rather than implied.

## Persistence

Everything is on disk, keyed by host and run id, under
`--out` › `$CLAUDE_SEO_AI_HOME` › `$CLAUDE_PLUGIN_DATA/runs` › `~/.claude-seo-ai/runs`. Nothing is
ever written into the user's project. `latest.json` is the portable pointer (a symlink is written
too, best effort, and a Windows `EPERM` is tolerated); `baseline.json` marks the comparison baseline
and is exempt from pruning. Full layout in [`usage.md`](usage.md#where-reports-live).

This is what makes `score`, `compare` and `fix` honest: none of them works from "the last audit this
session". They all read a persisted `report.json`.

## The site profile

`scripts/detect-platform.mjs` writes `<run>/profile.json` before any check runs. Four **independent**
layers are scored — `platform`, `framework`, `plugins`, `hosting` — so a headless WordPress behind
Next.js resolves as both instead of one shadowing the other. A layer with too little evidence is
omitted rather than guessed.

```
profile {
  platform   { id, confidence, signals[] } | null
  framework  { id, confidence, signals[] } | null
  plugins    [ { id, confidence, signals[] } ]
  hosting    { id, … } | null
  environment: production | preview | staging | local
  capabilities  { theme_files, admin_api, rest_api, page_api, robots_editable, redirects, head_owner }
  write_targets [ { adapter, ready, needs: [<KEY names>] } ]
  vertical      { primary, also[], multilingual, source: declared|inferred, signals }
  vertical_hints[], cards[]
}
```

`cards[]` names the knowledge cards (`references/platforms/<id>.md`) the orchestrator passes to every
subagent as `platform_cards`. A card is the only place a subagent may learn what a platform generates
by itself, what it refuses to let anyone change, and how a fix would actually be written — which is
what stops an auditor from "fixing" something the platform owns. `write_targets[].needs` lists
credential **key names**, never values.

## The checks registry

`scripts/checks/*.mjs` is the deterministic half of the audit: 25 checks emitting 151 finding ids
across M1–M22. Each module exports the same tiny contract:

```js
export const module = 'M7';                 // the Mn owner
export const ids = ['M7.title.missing', …]; // every id this check can emit
export const scope = 'page';                // page | template | site
export function run(ctx) { … }              // -> findings[]
```

`ctx` carries `{ page, parsed, rendered, site, crawl, pages, options, root }`. `index.mjs` discovers
checks by walking the directory — there is no registration list to edit — and exports `CHECKS`
(frozen), `knownIds()`, `loadRunContext()` and `runChecks(ctx)`.

`runChecks` **never throws**. A check that fails is isolated per page, its error is recorded, and the
run continues; the returned `stats` carries per-module counts plus `needs_api`, `manual_review`,
`not_applicable`, `dropped` (with `dropped_findings[]`) and `errors`. That block is persisted as
`<run>/checks.json`, so "which checks ran and which blew up" is auditable rather than folklore.

Findings are built only through `scripts/lib/finding.mjs makeFinding()`, which fills the absolute
`reproduce` command and validates the shape against `schema/finding.schema.json` before it can leave
a check.

## The runner

```
audit.mjs  <url|path|run-dir>
   ├─ acquire      crawl.mjs (a URL) · snapshot.mjs (--pages 1, --no-crawl, or a local path)
   │               · nothing at all when handed an existing run directory
   ├─ profile      detect-platform.mjs -> profile.json
   ├─ checks       runChecks() -> findings.deterministic.json + checks.json
   └─ report       report.mjs -> findings.json, report.json, report.md
```

`report.mjs` is the merge point. It validates every finding against the schema (invalid ones are
**dropped into `report.dropped_findings`**, never silently ignored), dedupes by id plus normalized
location keeping the most severe status, scores per page and as a site rollup, and renders the
bilingual markdown report with the top 15 actions ranked by severity × magnitude ÷ effort.

One merge rule carries the whole honesty posture: **`needs_api` and `manual_review` never override a
scored status.** An agent that could not decide must not erase a check that did. The precedence is
`fail (5) > warn (4) > pass (3) > needs_api (2) > manual_review (1) > not_applicable (0)`.

Exit codes are uniform across every script: `0` ok · `1` usage · `2` runtime · `3` a threshold or
gate tripped. `--fail-under search=70,ai=60`, `--fail-on-gated` and `--fail-on-severity N` are what
CI gates on; a tripped gate is exit 3, which is a CI concern, not a failed audit.

## Subagents

Five subagents in `agents/`. Four are strictly **read-only** — no `Write`/`Edit` in their tool
allowlist — so an audit can never mutate files. Only `seo-fixer-writer` can write, and only through
`fix`, after confirmation, with a ticket.

| Subagent | Tools | `skills:` preloaded | Modules |
|---|---|---|---|
| `technical-auditor` | Read, Grep, Glob, Bash, WebFetch | seo-crawlability, seo-indexability, seo-rendering, seo-core-web-vitals, seo-mobile, seo-meta-onpage, seo-headings-structure, seo-social-cards, seo-images-media, seo-internal-linking, seo-sitemaps, seo-international | M1, M2 (+M3), M4, M7/M7b/M7c, M8, M9, M10, M15, M17 — plus M20 when `vertical.multilingual` |
| `ai-search-geo-specialist` | Read, Grep, Glob, WebFetch, Bash | seo-geo-answerblocks, seo-geo-factdensity, seo-ai-crawlers, seo-entity-linking, seo-ai-discovery, seo-agent-readiness | M6, M11, M12, M14, M21 (weight 0), M22 |
| `content-eeat-analyst` | Read, Grep, Glob, WebFetch, Bash | seo-eeat, seo-freshness | M13, M16 |
| `schema-generator` | Read, Grep, Glob, Bash, WebFetch | seo-schema-jsonld, seo-entity-linking, seo-ecommerce, seo-local | M5 — plus M18 when `ecommerce`, M19 when `local-business` |
| `seo-fixer-writer` | Read, Grep, Glob, **Edit, Write**, Bash | seo-fix-apply | The only writer; used by `fix` after confirmation (`maxTurns: 80`) |

All five run `model: inherit`. `schema-generator` proposes JSON-LD diffs but does not write them; the
write always goes through `seo-fixer-writer`.

## Vertical routing

`seo-vertical-detect` classifies the target as `ecommerce`, `local-business`, `blog-publisher`,
`saas`, `docs` or `generic` (a site may match several), taking `profile.vertical_hints` as input
signals. The always-on modules run everywhere; the vertical unlocks the conditional ones — M18
(e-commerce), M19 (local), M20 (international, when `multilingual`) — and the scorer re-normalizes
weights so an inactive category never penalizes the site. Full table in
[`references/routing.md`](../../references/routing.md).

The detector only **guesses**: `profile.vertical.source` stays `"inferred"` unless `--vertical` was
passed. Declaring it is what makes the conditional checks fire deterministically.

## Two scores, never blended

`scripts/score.mjs` produces **two independent 0–100 scores** that are never averaged: **Search SEO**
and **AI Visibility (GEO/AEO)**. A page can rank well yet be uncitable by AI, or the reverse —
surfacing both is the product thesis.

- **Category value** = `100 × Σ(status_factor × severity) / Σ(severity)` over scored findings, where
  `status_factor` is pass `1.0`, warn `0.5`, fail `0.0`. `needs_api`, `manual_review` and
  `not_applicable` are excluded from both sums.
- **Score** = `Σ(category_value × weight) / Σ(active weight)`; conditional categories enter the
  denominator only when active, then weights re-normalize.
- A finding contributes only to the axis named in its `expected_impact.axis` (`search`, `ai`, or
  `both`).
- **Bands:** A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F below.
- **Severity gating:** a `severity: 5`, **`established`**, failing finding inside an active weighted
  category caps that axis at **40** and sets `capped: true`, listing its `cap_reasons`. Confidence is
  part of the gate on purpose — a `directional` severity-5 failure never caps.
- **Coverage floor:** when less than **50 %** of the always-on weight on an axis carried a scored
  finding, the axis is `state: "partial"`, `provisional: true`, and the report names the unmeasured
  categories. A one-page run that measured two categories cannot look like an A.
- **`unscored`:** no scored finding in any active category → `state: "unscored"`, not F. A missing
  score is not a bad score.

The whole model, including the weights and the calibration table, is in
[`scoring.md`](scoring.md) and [`references/scoring-model.md`](../../references/scoring-model.md).

## Finding contract

Every finding conforms to `schema/finding.schema.json`. The schema is falsifiability-first: each
finding must be independently observable and re-checkable. Required fields include `id`
(module-prefixed, e.g. `M5.article.missing_datemodified`), `module`, `title`, `status`
(`pass`/`warn`/`fail`/`not_applicable`/`needs_api`/`manual_review`), `severity` (0–5), `scope`,
`evidence.observed` (verbatim), `expected`, `recommendation`, `fixable`, `verification` (`method` +
`assertion` + a runnable absolute `reproduce`), and `expected_impact` (`axis` + `confidence` +
`magnitude` + `rationale`).

`fixable` drives the fixer:

- **auto** — deterministic, additive, machine-verifiable, low semantic risk.
- **proposed** — changes prose or meaning; per-item accept required.
- **advisory** — never written by this tool.

## The fix flow

```
report.json + profile.json
   -> fix-plan.mjs           groups findings by the adapter that owns each surface
   -> plan.json + manifest.json + coverage accounting
   -> <adapter> preview      (read-only, per change)
   -> the user confirms
   -> fix-ticket.mjs issue   one-shot, 15-minute ticket bound to the exact command
   -> seo-fixer-writer       Edit/Write for local diffs · ticketed adapter apply for remote
   -> <adapter> verify       or pending_cache — never a pass on a stale cache
   -> <adapter> rollback     from before/*.json and <DATA>/backups/<run-id>/
```

### Adapters

Every adapter in `scripts/adapters/` implements the same six ops —
`capabilities | plan | preview | apply | verify | rollback` — as a CLI
(`node scripts/adapters/<id>.mjs <op> --run <fix-run-dir> [--change <id>] [--ticket <t>]`), with
`fetchImpl` / `execImpl` injectable so tests never touch the network.

| Adapter | Surface |
|---|---|
| `local-files` | a source tree on disk (any framework, or plain HTML), through the route map |
| `shopify-theme` | Shopify CLI: pull → edit → `theme check` → push to an **unpublished** theme |
| `shopify-admin` | Admin GraphQL for per-resource SEO fields and redirects |
| `wordpress-rest` | Application Passwords over HTTPS Basic auth |
| `wordpress-wpcli` | `wp` over SSH, when REST is unavailable |
| `page-api` | multiplexes the read-only providers: `webflow`, `wix`, `ghost`, `hubspot`, `bigcommerce` |
| `instructions` | the exact click path, in EN or ES, values filled in — the honest fallback |

`instructions` is always appended last, so **every finding has somewhere to go**. A missing
credential downgrades a target to `instructions`; it never fails the run and it is never dropped from
the summary.

Three invariants across all of them:

1. **Never write live by default.** Shopify pushes to an unpublished theme; Webflow and HubSpot stay
   staged; Ghost never flips `status`; WordPress never touches `status` or post content. Where a
   platform has no staging surface (Wix, BigCommerce), the change is badged `[LIVE]` before the user
   is asked. Per-platform detail: [`platforms.md`](platforms.md).
2. **`updateManifest()` is the one reporting path** for every apply, publish and rollback. It
   maintains `dry_run` (false only once a write actually landed), the `applied` / `rolled_back` /
   `failed` id lists, a per-change `results` map, `last_op` and a `<op>_at` timestamp — so a manifest
   can be replayed honestly.
3. **A change never moves backwards** through its status machine
   (`planned → previewed → confirmed → applied → verified | pending_cache | failed | rolled_back`,
   plus `skipped_idempotent` and `skipped_unready`). A throw marks the change `failed` and persists
   the message rather than leaving a half-state.

### Coverage accounting

Without it, an adapter silently dropping every `proposed` finding could print "2 changes" over a
30-finding report. `fix-plan.mjs` therefore buckets **every** finding: `actionable`, `considered`,
`planned` (auto + proposed), `skipped_proposed` (with the ids and the `--include-proposed` hint),
`advisory`, and `unroutable` (considered but owned by no adapter), plus a per-adapter breakdown.
`planned ⊆ considered`, `unroutable = considered − planned`. The same object appears in the CLI
result, in `plan.coverage`, on each group, in the printed summary and in `manifest.counts`.

## The guard model

Four mechanisms, in order of how much they actually guarantee:

1. **Tool allowlists.** The four auditor agents have no `Write`/`Edit`. This is the strongest
   guarantee here: an audit cannot mutate files because the tools are not in the agent's list.
2. **`disable-model-invocation: true` on `fix`.** The model cannot start a write flow at all.
3. **`guard-write.mjs`** — a `PreToolUse` hook on `Write|Edit|MultiEdit|NotebookEdit`. It reads every
   path field the file tools use, so adding a tool to the matcher never needs a change here. Two
   deliberately different decisions:
   - a **protected path** (`.git/`, `.env*`, `.envrc`, SSH/GnuPG/AWS directories, private keys,
     `.pem`/`.key`/`.p12`…, lockfiles, `wp-config.php`, a live Shopify `settings_data.json`) →
     **deny**. No SEO fix ever needs one of these.
   - a path **outside the containment roots** (the project, its `.claude/worktrees`, the plugin data
     dir) → **ask**, so it reaches the user's own permission decision instead of being silently
     accepted under `acceptEdits`. It is not a deny because the hook is installed for the whole
     session, not only for `fix` — denying every write outside the project would break unrelated
     work.
4. **`guard-bash.mjs`** — the same hook event on `Bash`, closing what `guard-write` cannot see: the
   writer holds `Bash`, and a shell command can push a theme live, rewrite a WordPress option, POST
   to an Admin API, or clobber a `.env` with a redirect. Three tiers:
   - **hard deny** — `shopify theme push` carrying a live flag (`--allow-live`, `--live`,
     `--publish`, `-a`, `-l`, `-p`), and shell redirects or `tee` into a protected file. No ticket
     unlocks these.
   - **ticket-gated** — the remote write surface (Shopify theme push/publish/delete; WP-CLI option
     and post-meta writes, local or over SSH; `curl`/`wget`/`node -e` writes against the platform
     APIs; and the adapters' own `apply`/`publish`/`rollback`). With a live ticket for that exact
     command it **asks**; without one it **denies**.
   - **everything else** — exit 0, no opinion. A regex pre-check keeps that path in microseconds;
     nothing is read from disk unless a gated pattern matched.

Neither hook ever emits `allow`. Exit 0 with no output means "no opinion", which falls through to the
user's own prompt — it never strips it.

**The honest limit.** Hooks inherit Claude Code's environment, so a confirmation ticket is
*procedural hardening, not a capability boundary*: anything the model can read, it can also write.
The real backstop is the user's own Bash permission prompt. Never allowlist `Bash(shopify:*)`,
`Bash(wp:*)` or `Bash(ssh:*)` — that is precisely what these hooks cannot replace.

## Honesty guardrails

- **M21 (AI discovery: `llms.txt`, `agents.md`, `/.well-known/ucp`, `ai-catalog.json`, the agentic
  sitemap) is weight 0 on both axes.** It is reported, never scored. Google Search ignores
  `llms.txt`; no engine documents consuming the others for retrieval.
- **Only what a search engine documents may be `established`.** On the AI axis that is M14
  eligibility and nothing else. Everything else is `directional` or `speculative`, and only
  `established` failures can cap a score.
- **Probes are never scored.** `--probe` (web-search presence) and `--gsc-ai-export` (a manual Search
  Console generative-AI export) are severity 0, excluded from the score and from every cap, and they
  carry their disclaimer verbatim from the script rather than in the model's own words.
- **`needs_api` / `manual_review` are never a silent pass**, never override a scored status, and are
  reported as score confidence.
- **Language-dependent checks are gated by language.** The heuristics ship EN and ES lexicons; on a
  page in any other language that part is skipped and the reason is stated
  (`language_dependent_checks: manual_review`) rather than scored as clean. An English-only heuristic
  must never score a Spanish page as zero.
- **Lab vs field Core Web Vitals** are clearly distinguished; only CrUX field p75 drives the score.
- **No fabrication** — never invent statistics, citations, dates (no backdating `dateModified`),
  credentials or `sameAs` identity links. Unknown values are asked for, or left as a clearly-marked
  `TODO:<field>` placeholder.
- **A page that did not answer 2xx is never scored.** The on-page checks skip a non-content page, so a
  404 or a 429 interstitial would collect almost no negative findings and out-score a real page. Such
  a page stays in `report.json` `pages[]` with its `status` and `scorable: false`, is listed in
  `site_rollup.unscored_pages`, is named in a warning, and carries no weight in the rollup; `compare`
  reports the 200 → 429 flip as a coverage change, never as an improvement.
- **A 200 that serves HTML at a machine endpoint is a soft 404.** `/llms.txt`, `/llms-full.txt`,
  `/agents.md`, `/.well-known/ucp`, `/.well-known/ai-catalog.json` and the agentic sitemap are not
  HTML documents: a catch-all app shell there means the file is not published. Those paths are moved
  from `discovery.summary.found` to `discovery.summary.soft_404` (their status is still recorded), so
  neither the report nor the competitor presence matrix claims a site publishes a file it does not.
- **No naked percentages.** Impact is banded, and published numbers appear only inside `rationale`.

## Degraded mode

If `node` is missing, or a skills-only install ships no `scripts/` directory, the orchestrator says so
**first**, falls back to `WebFetch` summaries, marks every header/status/render/robots-dependent
finding `needs_api`, skips persistence, and labels the report **"prompt-only mode — not comparable to
a scripted run"**. It never presents a `WebFetch` summary as raw HTML or as a measured status.

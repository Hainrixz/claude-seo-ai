# Changelog

All notable changes to claude-seo-ai are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/); this project uses semantic versioning.

## [0.2.0] — 2026-09-06

The **"works on any site"** release. v0.1.0 was a prompt-only suite: it asked `WebFetch` for pages it
could not actually get (inside Claude Code that tool returns a small-model markdown summary, never
raw HTML, headers or status codes), it persisted nothing, and it had no idea what platform it was
looking at. v0.2.0 replaces the acquisition layer with deterministic Node scripts, puts every run on
disk, adds a checks registry that runs with no model in the loop, teaches the tool 24 platforms and
frameworks, and gives `fix` a real write path per platform — staged by default, ticketed,
reversible.

### Added

**Acquisition & persistence**
- `scripts/snapshot.mjs` — PageSnapshot v2 written to disk: full status/redirect chain (loops and
  truncation flagged), response headers, cookie **names** only, parsed `Link:` header (canonical +
  hreflang alternates), robots directives from header and meta with their `effective` resolution,
  body metadata (`bytes`, `truncated`, `charset`, `gunzipped`, `sha256`), timings, and a fully
  parsed document. `--ua <preset>` writes a parallel bot-view snapshot; `--rendered-file` accepts a
  DOM captured elsewhere.
- `scripts/crawl.mjs` — robots-aware discovery (sitemaps → URL-template patterns → breadth-first
  over internal anchors), **template sampling** (`--per-template`, `--pages`, `--max`, `--depth`),
  crawl-delay support, link-status probing, and a sampling table that logs every skip with its
  reason. Backed by `scripts/lib/templates.mjs` (URL template patterns, JSON-LD/body-class typing,
  grouping).
- `scripts/lib/store.mjs` — the run store: `<root>/<host>/<run-id>/` with `latest.json` (portable
  pointer), a best-effort `latest` symlink, `baseline.json` (exempt from pruning), an `index.json`
  of every host, retention (20 runs per host, 5 for gap hosts), and root resolution
  `--out` › `$CLAUDE_SEO_AI_HOME` › `$CLAUDE_PLUGIN_DATA/runs` › `~/.claude-seo-ai/runs`.
- `scripts/lib/*` split into a real library: `html` (tokenizer), `entities`, `fetch` (redirect
  chain), `robots` (Google REP precedence + Content-Signal), `sitemaps` (index recursion + gzip),
  `urlnorm`, `hreflang`, `jsonld`, `schema-lite`, `renderers`, `site`, `pool`, `lang`, `passages`,
  `bots`, `bands`, `imgsize`, `finding`, `validate-finding`, `util`.
- `scripts/lib/renderers.mjs` — `needsRender()` signal detection, `findChrome()` over an
  already-installed Chrome/Chromium/Edge/Brave (env overrides, `PATH`, then a Playwright browser
  cache), `renderWithChrome()` (with the `--virtual-time-budget` hang worked around),
  `renderWithPlaywright()` only when the package already resolves, and `renderDelta()`. **Nothing is
  ever installed on the user's behalf.**
- `--snapshot <pages/<slug>.json>` on every legacy script, so each one reads a persisted run.

**Runner, checks & CI**
- `scripts/checks/` — a registry of **25 checks emitting 151 finding ids** on the
  `{ id, module, ids[], scope, run(ctx) }` contract, discovered by walking the directory.
  `runChecks()` never throws: per-page error isolation, and `stats` with per-module counts plus
  `needs_api` / `manual_review` / `not_applicable` / `dropped` (with `dropped_findings[]`) and
  `errors`, persisted as `checks.json`. Includes cross-URL, platform-conditional and GEO checks.
  `_shared.mjs` is the only path to `makeFinding()`.
- `scripts/audit.mjs` — the one-command pipeline (acquire → profile → checks → report) with exit
  codes `0/1/2/3`, `--format json|ndjson|md`, `--summary-md`, `--merge`, `--validate`, and the CI
  gates `--fail-under search=70,ai=60`, `--fail-on-gated`, `--fail-on-severity N`.
- `scripts/report.mjs` — schema-validated merge of deterministic and agent findings, dedupe by id +
  normalized location keeping the most severe status, per-page scores plus a site rollup, bilingual
  `report.md` (`--lang` covers the headings, the interpretation line and every warning; finding text
  stays English because it comes from the checks), and the top-15 actions ranked by severity ×
  magnitude ÷ effort.
- `scripts/check.mjs` — the cheap gate: `node --check` over every `.mjs`, JSON parse over every
  shipped manifest, skill/agent frontmatter lint, and version alignment across the three version
  locations.
- `action.yml` — a composite GitHub Action running the deterministic subset, with a job summary, the
  scores as step outputs, artifact upload, and exit 3 plus a `::error` annotation per tripped gate.
- `.github/workflows/ci.yml` (Node 18/20/22 × ubuntu/macos/windows) and
  `.github/workflows/seo-audit-example.yml` (a copy-paste audit workflow).

**Platform & framework awareness**
- `scripts/detect-platform.mjs` + `scripts/lib/platform-rules.mjs` — four **independent** layers
  (platform / framework / CMS plugins / hosting), so a headless WordPress behind Next.js resolves as
  both. Every verdict carries its signals; a layer with too little evidence is omitted, never
  guessed. Writes `profile.json` with `capabilities`, `write_targets`, `vertical_hints` and the
  knowledge cards to load. `--probe` is limited to four endpoints; `--path` is the only way repo
  signals are consulted.
- `references/platforms/*.md` — **24 knowledge cards** on a fixed 12-section template (what the
  platform generates, what it owns, the fix map, the write method, preview/publish, verification,
  rollback, check ids, EN/ES manual paths, and an explicit UNVERIFIED section), plus a
  `README.md` documenting the template.
- `skills/seo-platform-detect/SKILL.md` (hidden) and the Platform-layer table in
  `references/routing.md`.

**The fix flow**
- `scripts/lib/adapter.mjs` — the Change record and its frozen status machine, deterministic change
  ids, the fix-run directory (`plan.json`, `manifest.json`, `preview/`, `before/`, `after/`,
  backups, a redacting `log.ndjson`), and the TTL confirmation tickets
  (`issueTicket`/`checkTicket`/`consumeTicket`/`requireTicket`/`pruneTickets`).
- `scripts/lib/credentials.mjs` — a 16-key catalog with aliases, `resolveKey`/`presence`/
  `missingKeys`/`keysForAdapter`, and `redact`/`redactObject`/`explainKeys`.
- `scripts/lib/{route-map,http,diff,frontmatter,shell}.mjs` — route → file mapping for every
  supported framework, the shared HTTP layer, unified diffs and marker-aware insertion, front-matter
  merge, and the guarded shell.
- Adapters on one six-op contract (`capabilities | plan | preview | apply | verify | rollback`) with
  injectable `fetchImpl`/`execImpl`: `local-files`, `shopify-theme`, `shopify-admin`,
  `wordpress-rest`, `wordpress-wpcli`, `page-api` (multiplexing read-only providers `webflow`,
  `wix`, `ghost`, `hubspot`, `bigcommerce`), and `instructions` — always appended last, so every
  finding has somewhere to go.
- `scripts/fix-plan.mjs` and `scripts/fix-ticket.mjs` drive the run end to end
  (report → plan → ticket → preview/apply/verify/rollback), with **coverage accounting** so no
  finding is ever dropped quietly: `classifyFindings`, `buildCoverage`, `renderCoverage`, and a
  `coverage` object reporting considered / planned (auto + proposed) / skipped-proposed with ids /
  advisory / unroutable plus a per-adapter breakdown, mirrored into `plan.coverage`,
  `manifest.counts`, each group and the printed summary.
- `.claude-plugin/plugin.json` `userConfig` — 17 credential prompts (Shopify, WordPress, Webflow,
  Wix, Ghost, HubSpot, BigCommerce, `PSI_API_KEY`), each marked `sensitive` where it is a secret.
- `skills/seo-fix-apply/SKILL.md` — the full writer protocol (hidden, preloaded by
  `seo-fixer-writer`), and a rewritten `skills/fix/SKILL.md` flow.

**GEO / AI-search 2026**
- `scripts/ai-eligibility.mjs` (M14) — the observable facts behind Google's documented gate:
  indexable **and** snippet-eligible. Reads every meta robots/googlebot/bingbot tag, the
  `X-Robots-Tag` header including its UA-scoped form, the `data-nosnippet` share of the page, and
  the robots.txt verdict for Googlebot.
- `scripts/ua-diff.mjs` (M14) — one URL fetched once per UA preset, diffed on status, title/H1, word
  count, canonical, robots meta and JSON-LD types, with bot-challenge detection.
- `scripts/ai-discovery.mjs` + `skills/seo-ai-discovery` (M21, **weight 0**) — `/llms.txt`,
  `/llms-full.txt`, `/agents.md`, `/.well-known/ucp`, `/.well-known/ai-catalog.json`,
  `/sitemap_agentic_discovery.xml`: presence, parse validity, and whether robots.txt blocks them for
  the very agents they are written for.
- `scripts/agent-readiness.mjs` + `skills/seo-agent-readiness` (M22) — can a scripted agent operate
  this page from the HTML alone. Capped at severity 3, and what static HTML cannot answer is listed
  verbatim in `not_checkable_static`.
- `scripts/acp-feed-lint.mjs` (M18) — Agentic Commerce Protocol product-feed lint: the nine required
  fields, the `"79.99 USD"` price form, the availability enum, GTIN check digits, absolute URLs,
  length caps and duplicate item ids.
- `scripts/probe-report.mjs` (`--probe`) and `scripts/gsc-ai-import.mjs` (`--gsc-ai-export`) —
  **probes, reported and never scored** (severity 0, excluded from the score and from every cap),
  each carrying its own disclaimer as an exported constant the skills quote verbatim. The Search
  Console import accepts English and Spanish headers and treats impressions as the only usable
  figure.
- Content-Signal parsing in `lib/robots.mjs` (global and in-group placements) and a UA table in
  `lib/bots.mjs` with a source per row.

**`compare` (new command)**
- `scripts/compare.mjs` + `skills/compare/SKILL.md` — four comparisons from persisted runs: own
  baseline, staging vs production (`--map`, plus staging-host heuristics), a competitor matrix of up
  to five sites, and a content gap against the pages that already answer a query. Emits score,
  category, finding and structure deltas; `--fail-on-regression` exits 3; `--set-baseline` pins a
  baseline. Transitions involving `needs_api` / `manual_review` are listed separately and never
  counted as fixed or regressed.

**Docs & tests**
- New `docs/{en,es}/platforms.md` — the support matrix, credential setup, per-platform quick starts,
  what never goes live by default, and the full UNVERIFIED list.
- `tests/` restructured into `tests/unit/` + `tests/e2e/` with `tests/run.mjs` as an
  auto-discovering entry point, a local fixture server (`tests/helpers/server.mjs`) and synthetic
  fixtures only — from 30 assertions to **1000+**, with no network anywhere.

### Changed

- **`WebFetch` is no longer an acquisition layer.** `seo-crawl-render` is a thin wrapper over
  `snapshot.mjs` / `crawl.mjs`; the orchestrator reads compact stdout summaries and the JSON files
  they name, and never pastes HTML into the conversation. Prompt-only mode still exists, but it is
  labeled *"not comparable to a scripted run"* and marks every header/status/render/robots-dependent
  finding `needs_api`.
- **The subagent tool is `Agent`**, not the legacy `Task`, everywhere in skills, agents and docs.
- **Agents preload their module skills** through a `skills:` list instead of triggering them at
  runtime, and each carries an `## Envelope` section documenting the dispatch envelope
  (`plugin_root`, `run_dir`, `pages[]`, `site`, `vertical`, `platform`, `platform_cards`,
  `modules[]`, `deterministic_findings`, `return`) and the absolute-path script rule. All five run
  `model: inherit`.
- Agent ownership: `technical-auditor` also owns M20 when the site is multilingual;
  `ai-search-geo-specialist` owns M6, M11, M12, M14, M21, M22 and gains `Bash`; `content-eeat-analyst`
  gains `Bash`; `schema-generator` gains `WebFetch`; `seo-fixer-writer` gains `Grep`/`Glob`,
  `skills: [seo-fix-apply]` and `maxTurns: 80`.
- **M21 is now "AI discovery & agent endpoints"** (weight 0) rather than llms.txt-only, and M6 is the
  only entity module. `llms.txt` moved to M21 structurally, which is what closes the score leak.
- **Support skills are hidden** (`user-invocable: false` on `seo-orchestrator`, `seo-score`,
  `seo-vertical-detect`, `seo-crawl-render`, `seo-platform-detect`, `seo-fix-apply`), and every
  module skill gained an `## Inputs` section.
- **`--render` defaults to `static`** on every entry point: a headless run never launches a browser
  unless asked.
- **Scoring integrity**: AI weights re-normalized (M11 18 · M14 14 · M12 14 · M5 12 · M4 10 · M6 9 ·
  M16 9 · M13 6 · M22 4 · M9 4 · M21 0; conditional M18 6, M19 5), a published severity-calibration
  table, and three new axis states — `capped` (only an `established` severity-5 failure caps, at 40),
  `partial` / `provisional` (a **coverage floor of 50 %** of always-on weight, with the unmeasured
  categories named), and `unscored` (no scored finding in any active category → never F).
- **Merge precedence is explicit**: `fail > warn > pass > needs_api > manual_review > not_applicable`.
  An agent that could not decide never overrides a check that did.
- **Bilingual heuristics**: the answer-block, fact-density and freshness heuristics ship EN and ES
  lexicons and report `language_dependent_checks: manual_review` on any other language, instead of
  scoring an unreadable page as clean.
- `references/ai-crawlers.md` rewritten around what actually gates Google AI features (indexed +
  snippet-eligible; `Google-Extended` does not affect AI Overviews/AI Mode; Google ignores
  `llms.txt`), with a Content-Signal section, a UA table carrying a source per row and nine new rows,
  `Content-Signal:` lines on all three robots presets, and an M21 weight-0 section.
- `references/routing.md` gained M7b/M7c/M22 in the always-on list, M20 in the conditional table, the
  Platform layer table, an Environment layer note, the SiteProfile shape, and the
  platform-conditional id index.
- `.claude-plugin/plugin.json` description and keywords mention platform coverage; version 0.2.0
  across `plugin.json`, `marketplace.json` and `scripts/package.json` (alignment now enforced by
  `check.mjs`).
- `schema/finding.schema.json` gained the `manual_review` status and the `ua_diff` /
  `web_search_probe` verification methods; `schema/audit-report.schema.json` gained the vertical
  object, the new score fields, and `coverage` / `pages` / `site_rollup` / `data_sources` /
  `platform` / `probes` / `site`.
- `hooks/hooks.json` now carries two matchers (`Write|Edit|MultiEdit|NotebookEdit` and `Bash`).
- Docs rewritten end to end (`README`, `docs/{en,es}/{usage,architecture,scoring,mcp,distribution}`)
  and `CONTRIBUTING.md` gained the checks-registry, adapter and knowledge-card conventions plus the
  AUTO-strategy rule.

### Fixed

- `M14.llmstxt.*` leaked into the AI Visibility score — llms.txt is now structurally part of M21 at
  weight 0.
- A self-canonical page carrying `noindex` was reported as the "lethal pair" it is not.
- The seed URL was reported as an orphan by the internal-link graph.
- Nested JSON-LD nodes were never validated (`flattenNodes` now walks them).
- Sitemap `<loc>` entities were left undecoded, and gzipped child sitemaps were not followed.
- An apostrophe inside an HTML attribute truncated the attribute value in the tokenizer.
- English-only heuristics scored Spanish pages as zero.
- `interpret()` paired the wrong sentence with a score combination.
- Severity gating ignored `confidence`, so a `directional` severity-5 failure could cap a score.
- `totalW === 0` produced an F instead of `unscored`.
- PSI honesty: an `origin_fallback` response was presented as the page's own field data.
- The content-type gate accepted non-HTML responses into the HTML parser.
- Undocumented sitemap finding ids, and `M2.shopify.seo_hidden_detected`, which no check could emit
  (the registry now exports 151 ids, one below the original plan, on purpose).
- Round-2 fixes across `audit`, `report`, `score`, `psi-client`, `ai-discovery`, `agent-readiness`,
  `lib/util` and thirteen checks, each with regression coverage.
- **False claims about correct product markup.** "Which nodes declare a product here?" is now one
  rule in `lib/jsonld.mjs` (`isProductDeclaration` / `classifyProductNodes`), shared by M5, M18 and
  the Shopify platform check. A `ProductGroup` with url-only `hasVariant` stubs is one product, not
  one per variant: it no longer produces `M5.product.missing_offer_price`,
  `M5.shopify.duplicate_product_jsonld` ("29 Product nodes on …"), `M5.shopify.theme_jsonld_gaps`
  ("ProductGroup.hasVariant[0] lacks brand, sku, gtin") or a failing `M18.agentic.catalog_eligibility`.
  A ProductGroup is judged with its variants, and priced from their offers when it carries none.
- **One product priced from another product's offer.** Two sibling root `ProductGroup`s — a theme
  and an app each emitting one, the case `M5.shopify.duplicate_product_jsonld` exists to report —
  are both named `"ProductGroup"` by the flattener, so matching variants by path text handed each
  group the other's: `M18.agentic.catalog_eligibility` quoted the neighbour's cheapest price as this
  product's, and `M5.shopify.theme_jsonld_gaps` let a neighbour's `gtin` clear a group that had none
  while claiming a `brand` that was not there — both at `established` confidence. Variant membership
  is now object identity (`lib/jsonld.mjs` `variantNodeSet`), and repeated root paths are named apart
  in evidence (`ProductGroup[1]`, `disambiguateRootPaths`). `theme_jsonld_gaps` also counts a group's
  variants instead of its nodes: 83 variants were reported as "97 variant nodes".
- **Evidence that quoted markup the page does not ship.** `M9.alt.missing` printed `src=""` for an
  `<img>` with no `src` attribute — a framework-bound `<img :src=… :alt=…>` in the live theme. The
  tag is now quoted from the attributes it actually carries, `lib/html.mjs` records `images[].bound`
  (`:src`, `v-bind:alt`, `x-bind:src`, `[src]`), and the evidence names the binding so the
  static-render caveat is visible; the claim itself — no `alt` in the HTML a non-JS consumer reads —
  stands. `M14.citation_bots.blocked` takes the singular verb when one token is excluded.
- **`M17.wordpress.duplicate_sitemaps` called one sitemap three.** `lib/sitemaps.mjs` now records
  each file's `final_url` and marks a path that resolves onto an already-fetched document as
  `alias_of` it — so `/wp-sitemap.xml` -> `/sitemap_index.xml` -> `/sitemap.xml` is walked once
  instead of three times (which also spent the 50-file budget). The check claims duplication only
  when two different documents serve materially different URL sets, and reports `pass` with the
  evidence otherwise; when only one of the two URL lists was collected the claim is `directional`.
- **`M14.citation_bots.blocked` rested an `established` claim on undocumented tokens.** The
  confidence is `established` only when a blocked token is vendor-documented including its robots.txt
  behaviour; a block reaching only legacy tokens (`Claude-Web`, `MistralAI-User`) is still reported,
  marked as such in the evidence, at `directional`.
- **`fix --target auto` ignored exported credentials.** `resolveTargets()` re-checks the keys against
  the environment the fix runs in (through `lib/credentials.mjs`, names only) instead of trusting the
  `ready` flag `detect-platform.mjs` froze at audit time, and the plan prints ready/needs per adapter.
- `lib/platform-rules.mjs` `needs[]` and `PAGE_API_KEYS` now name the catalog/`userConfig` keys
  (`SHOPIFY_THEME_TOKEN`, `WP_URL`, `GHOST_ADMIN_KEY`, …) rather than the longer historical spellings,
  which still resolve as aliases everywhere, including in `detect-platform.mjs`'s presence check.
- `loadRunContext()` no longer re-adds the snapshots `crawl.mjs` deliberately dropped as non-HTML, so
  the checks context and `crawl.json` agree on how many pages a run has.
- Round-3 fixes across the adapter layer: `updateManifest()` is now the single reporting path for
  every apply/rollback/publish (previously each adapter hand-rolled its own manifest edits, so
  `dry_run` and the result lists could disagree); `loadFixRun(ref)` accepts a run id **or** a
  directory and names every place it looked when it fails; `opThrew()` makes a throw mark the change
  `failed` with the message persisted, instead of leaving a silent half-state; `logOpEvent()` logs a
  `refused` op when a ticket refusal covers every row; and `withheldProposedNote()` gives one
  wording for the proposed findings an adapter never saw.
- `seo-fixer-writer` no longer reports unapplied changes with a non-schema `status: skipped` — a
  change that is not applied keeps its pre-fix status and states `skipped_<reason>` in
  `evidence.observed`.
- `seo-fixer-writer` no longer instructed itself to "trigger the fix skill", which
  `disable-model-invocation` makes impossible; it receives approved changes in its envelope.
- Bare `node scripts/…` commands in agents replaced by the absolute command each finding carries in
  `verification.reproduce`.
- The M21 double definition (entity linkage vs llms.txt) removed from `ai-search-geo-specialist`.
- M20 (hreflang) was orphaned — it is now dispatched to `technical-auditor` when the vertical
  detector reports `multilingual: true`.
- Two `lib/site.mjs` bugs from the acquisition stage, and thirteen issues found by the cross-cutting
  verification of the checks registry and runners.
- CHANGELOG 0.1.0: removed the non-existent router claim and corrected the skill count.

### Security

- **Two PreToolUse guards, not one.** `guard-write.mjs` covers `Write|Edit|MultiEdit|NotebookEdit`
  and is matcher-agnostic (it reads every path field the file tools use). `guard-bash.mjs` covers
  `Bash`, closing what the first cannot see — the writer holds `Bash`, and a shell command can push a
  theme live, rewrite a WordPress option, POST to an Admin API or clobber a `.env` with a redirect.
- **Protected paths are denied outright**: `.git/`, `.env*`, `.envrc`, `.ssh`/`.gnupg`/`.aws`
  directories, private keys and `.pem`/`.key`/`.p12`/`.pfx`/`.jks` material, dependency lockfiles,
  `wp-config.php`, and a live Shopify `config/settings_data.json`.
- **Containment**: a write outside the project, its `.claude/worktrees` or the plugin data dir is
  **asked**, not silently accepted under `acceptEdits`. Neither hook ever emits `allow`, so a hook
  that has no opinion falls through to the user's own prompt rather than stripping it.
- **`guard-bash` hard-denies a live Shopify theme push** (`--allow-live`, `--live`, `--publish`,
  `-a`, `-l`, `-p`) and shell redirects into a protected file. No ticket unlocks these.
- **Confirmation tickets** gate every remote write: one-shot, 15-minute TTL, bound to the sha256 of
  the exact normalized command, storing only the hash and a redacted preview — never the command
  itself. Documented honestly as *procedural hardening, not a capability boundary*: hooks inherit
  Claude Code's environment, so the real backstop is the user's own Bash permission prompt, and
  `Bash(shopify:*)` / `Bash(wp:*)` / `Bash(ssh:*)` must never be allowlisted.
- **Credentials never reach a command line, a log or the repository.** Adapters read
  `CLAUDE_PLUGIN_OPTION_<KEY>` then `<KEY>` from the environment; there is deliberately no `--key`
  flag anywhere; the fix log redacts commands; and `write_targets[].needs` reports missing keys by
  **name only**.
- **Snapshots store cookie names, never cookie values**, so nothing secret enters a run directory.
- **Path containment in the adapters**: `local-files` refuses any path escaping `--project`
  (resolving symlinks on the parent directory), and `safeRelPath()` rejects `..`, absolute paths and
  NUL bytes when building backup and preview names.
- **Tests never touch the network.** E2E runs against a local fixture server, adapters take an
  injectable `fetchImpl`, and `CLAUDE_SEO_AI_OFFLINE=1` makes a real fetch throw.

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

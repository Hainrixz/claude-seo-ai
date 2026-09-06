<p align="center">
  <img src="https://raw.githubusercontent.com/Hainrixz/claude-seo-ai/main/assets/hero.png" alt="claude-seo-ai — SEO + AI-search toolkit for Claude Code, with the Claude pixel mascot (an orange blocky creature)" width="840">
</p>

<h1 align="center">claude-seo-ai</h1>

<p align="center">
  <strong>The SEO + AI-search optimization toolkit for Claude Code.</strong><br>
  Audit any website on <strong>two independent axes</strong> — classic <strong>Search SEO</strong> and <strong>AI Visibility (GEO/AEO)</strong> — and optionally apply the safe fixes for you.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-000000.svg" alt="MIT License">
  <img src="https://img.shields.io/badge/Claude%20Code-plugin-da7756.svg" alt="Claude Code plugin">
  <img src="https://img.shields.io/badge/cross--agent-Vercel%20Skills-000000.svg" alt="Vercel Skills">
  <img src="https://img.shields.io/badge/SEO%20%2B%20AI%20Search-GEO%2FAEO-7c5cff.svg" alt="GEO / AEO">
  <img src="https://img.shields.io/badge/works-offline%20(Tier%200)-2ea44f.svg" alt="Works offline">
</p>

> **Two scores, never blended.** A page can rank well in Google yet be uncitable by ChatGPT, Perplexity, Google AI Overviews, Gemini, and Claude — or the reverse. `claude-seo-ai` measures both and tells you exactly what to fix.

🇪🇸 *Resumen en español al final · guías completas en [`docs/es/`](docs/es/).*

---

## Why

AI answer engines now sit beside classic search as a primary discovery channel, and the rules for being *cited* differ from the rules for *ranking*. Most SEO tools treat AI search as a footnote and never write fixes back into your code. This one is built for 2026–2027: honest, agent-native, and able to both **diagnose** and (opt-in) **fix**.

It is original work — *inspired by* the patterns of community SEO tooling but copies **no** branding, text, or names from any other project. MIT-licensed.

## Install

**As a Claude Code plugin (recommended):**

```text
/plugin marketplace add Hainrixz/claude-seo-ai
/plugin install claude-seo-ai@claude-seo-ai
/reload-plugins
```

**Cross-agent** (Cursor, Codex, Gemini CLI, Windsurf…) via [Vercel Skills](https://vercel.com/docs/agent-resources/skills):

```text
npx skills add Hainrixz/claude-seo-ai
```

The plugin works **fully offline** (Tier 0, no keys). See [Data tiers](#data-tiers) for optional rendering and API integrations. The skills-only channel ships the Markdown but not the `scripts/` acquisition layer — see [`docs/en/distribution.md`](docs/en/distribution.md).

## Usage

```text
/claude-seo-ai:audit   <url|path> [--pages N] [--max N] [--render static|auto|js]
                                  [--ua default|googlebot|bingbot|gptbot|oai-searchbot|claude-searchbot]
                                  [--vertical ecommerce,docs] [--environment production|preview|staging|local]
                                  [--feed <path>] [--out <dir>]

/claude-seo-ai:geo     <url|path> [--pages N] [--render static|auto|js] [--feed <path>]
                                  [--probe "<question>"] [--gsc-ai-export <csv>]

/claude-seo-ai:score   [findings.json | run-dir | latest[:host]]

/claude-seo-ai:compare <urlA> <urlB> [<urlC>…] | --baseline [latest] --against <url|run>
                     | --staging <url> --prod <url> | <url> --gap "<query>"

/claude-seo-ai:fix     <url|path> [--target auto|local|shopify|wordpress|webflow|wix|ghost|hubspot|bigcommerce|instructions]
                                  [--category M5 --category auto] [--include-proposed]
                                  [--project <dir>] [--dev-url <u>] [--run <id>] [--lang en|es]
                                  [--dry-run] [--publish] [--rollback <run_id>] [--force]
```

`audit`, `geo`, `score` and `compare` are **read-only** and never touch your files. `fix` previews everything by default and writes only after you confirm each change. `--render` defaults to **`static`**, so a run never launches a browser unless you ask. Power users can call any module directly, e.g. `/claude-seo-ai:seo-schema-jsonld`.

Every audit is **persisted** under `${CLAUDE_PLUGIN_DATA}/runs/<host>/<run-id>/` — which is why `score`, `compare` and `fix` work from a report on disk instead of "the last audit this session". Full flags and the run layout: [`docs/en/usage.md`](docs/en/usage.md).

## Works on any site

<p align="center">
  <img src="https://raw.githubusercontent.com/Hainrixz/claude-seo-ai/main/assets/how-it-works.png" alt="Three-step pixel flow: the Claude mascot → magnifying glass over code → report with green checkmarks" width="760">
</p>

The audit is the same everywhere. What changes per platform is what the platform already generates for you, what it refuses to let anyone change, and whether a fix can be written back at all — so a four-layer detector (platform · framework · CMS plugins · hosting) writes a `profile.json` for every run, and the fixer routes each finding to the adapter that owns that surface.

**Status** is the header of each platform's [knowledge card](references/platforms/): `stable` = exercised end to end with a rollback · `beta` = implemented but thinly exercised, changes stay PROPOSED · `instructions-only` = no write API exists, so every fix is a click path for a human.

| Platform | Detected | Extra checks | Apply method | Preview/staging | Credentials | Status |
|---|---|---|---|---|---|---|
| **Shopify** | yes | 11 | `shopify-theme` (CLI) + `shopify-admin` (GraphQL) | **unpublished theme**; Admin API is live | `SHOPIFY_STORE`, `SHOPIFY_THEME_TOKEN`, `SHOPIFY_ADMIN_TOKEN` | beta |
| **WordPress** | yes | 10 | `wordpress-rest` or `wordpress-wpcli` | none — live on apply | `WP_URL`, `WP_USER`, `WP_APP_PASSWORD` · or `WP_SSH` | beta |
| **WooCommerce** | yes | via WordPress | same as WordPress | none | same as WordPress | beta |
| **Webflow** | yes | — | `page-api` | **staged** until published | `WEBFLOW_TOKEN`, `WEBFLOW_SITE_ID` | beta |
| **HubSpot** | yes | — | `page-api` | **staged** — draft, then push-live | `HUBSPOT_TOKEN` | beta |
| **Ghost** | yes | — | `page-api` | drafts stay drafts; published posts are live | `GHOST_URL`, `GHOST_ADMIN_KEY` | beta |
| **Wix** | yes | — | `page-api` | none you can rely on | `WIX_API_KEY`, `WIX_SITE_ID` | beta |
| **BigCommerce** | yes | — | `page-api` | none — live on write | `BIGCOMMERCE_STORE_HASH`, `BIGCOMMERCE_TOKEN` | beta |
| **Next.js · Nuxt · Astro · SvelteKit · React Router · Gatsby** | yes | 3 · 1 · 1 · — · 1 · 2 | `local-files` (source tree, via the route map) | none — a file edit; your deploy publishes it | — | beta |
| **Hugo · Jekyll · Eleventy · Docusaurus · Payload** | yes | 1 · 1 · — · — · — | `local-files` | none | — | beta |
| **Plain static HTML** | yes | 1 | `local-files` | none | — | **stable** |
| **Squarespace · Framer · Magento · Drupal** | yes | — | `instructions` (+ `local-files` with a checkout, for Magento/Drupal) | the platform's own publish flow | none | instructions-only |

Anything the detector cannot name still gets the full audit — it simply routes every fix to `instructions`, which renders the exact snippet and the panel or file it belongs in, in EN or ES. That is a real outcome, not a failure.

**Credential setup, per-platform quick starts, what never goes live by default, and the full UNVERIFIED list: [`docs/en/platforms.md`](docs/en/platforms.md).**

## Two scores, never blended

<p align="center">
  <img src="https://raw.githubusercontent.com/Hainrixz/claude-seo-ai/main/assets/dual-score.png" alt="Two pixel-art scoreboards — SEARCH and AI — with the Claude mascot between them" width="720">
</p>

Every audit reports two **0–100** scores with letter bands (A–F) and a one-line interpretation ([details](references/scoring-model.md)):

- **Search SEO** — weighted toward indexability, Core Web Vitals, on-page, schema.
- **AI Visibility (GEO/AEO)** — weighted toward answer extractability, schema, fact density, AI-crawler access, entities.

Severity gating caps an axis at **40** when a `severity: 5`, **`established`**, failing finding lands in an active category (e.g. site-wide `noindex`) — a `directional` failure never caps. Conditional verticals re-normalize so a blog isn't penalized for lacking Product schema. `needs_api` and `manual_review` checks are excluded from the math and counted separately as score confidence. An axis with no scored finding reports `unscored`, never F.

## How it works

A skill-first, three-layer design — the scripts acquire and prove, the model judges:

1. **Directive** — one of the five command skills (`audit`/`geo`/`score`/`compare`/`fix`).
2. **Orchestration** — `seo-orchestrator` runs the deterministic pipeline in one command (crawl → platform profile → 25 checks → first report), then dispatches four read-only specialist subagents in parallel with an absolute-path envelope, and merges everything into a persisted, schema-validated report.
3. **Execution** — 23 focused `seo-*` module skills, preloaded into their agent, each emitting findings that conform to [`schema/finding.schema.json`](schema/finding.schema.json) — with observed evidence and a runnable `verification.reproduce` command.

See [`docs/en/architecture.md`](docs/en/architecture.md).

## What it audits

A complete 2026 suite, grouped:

| Area | Modules |
|---|---|
| **Crawl & index** | crawlability/robots (M1), indexability + canonical + site health (M2/M3), rendering CSR/SSR/SSG (M4), sitemaps (M17) |
| **Structured data** | Tier-1 JSON-LD validate + generate (M5), entity/Knowledge-Graph `sameAs` (M6) |
| **On-page & meta** | title/meta/head (M7), mobile (M7b), headings (M7c), social cards (M8), images & alt (M9), internal linking (M10) |
| **AI search (GEO/AEO)** | answer extractability (M11), fact density & original data (M12), AI-crawler access + Google AI-feature eligibility (M14), AI discovery & agent endpoints (M21, weight 0), agent readiness (M22) |
| **Content & trust** | E-E-A-T (M16), freshness (M13) |
| **Performance** | Core Web Vitals — LCP/INP/CLS (M15) |
| **Verticals (conditional)** | e-commerce + agentic commerce (M18), local (M19), international/hreflang (M20) |

The deterministic half of that is a registry of **25 checks emitting 151 finding ids**, which run with no model in the loop and never throw: a check that fails is isolated per page and its error is recorded in `checks.json`.

## Get cited by AI engines

<p align="center">
  <img src="https://raw.githubusercontent.com/Hainrixz/claude-seo-ai/main/assets/ai-citations.png" alt="The Claude mascot beside a webpage being cited by pixel AI chat bubbles and robots" width="760">
</p>

The GEO/AEO modules score how *citable* your content is — and they lead with the one thing a vendor actually documents.

- **Google's eligibility gate is Search eligibility.** Per Google's *"AI features and your website"* documentation, a page can appear in **AI Overviews / AI Mode** only if it is **indexed and eligible to be shown with a snippet**. That is the whole gate. `noindex`, `nosnippet`, `max-snippet:0` and `data-nosnippet` on the primary content remove you; **`Google-Extended` does not** — it is a training/grounding token that leaves Search-based AI features untouched. These `M14.ai_eligibility.*` findings are the only `established` ones on the AI axis.
- **AI-crawler access.** Whether retrieval bots (`OAI-SearchBot`, `Claude-SearchBot`, `PerplexityBot`, `Amazonbot`, `DuckAssistBot`…) can reach and render your page, with a per-vendor source for every user-agent row. See [`references/ai-crawlers.md`](references/ai-crawlers.md).
- **Content-Signal** in `robots.txt` (`search` / `ai-input` / `ai-train`) is parsed in both its global and per-group placements. It is a *preference*, not an enforcement: the IETF draft expired in 2026-04 and **no AI vendor documents compliance**, so those findings are `directional` at most — and a Content-Signal line is never presented as a substitute for a `Disallow`.
- **Agentic commerce readiness** for stores (M18): the UCP merchant profile at `/.well-known/ucp`, an Agentic Commerce Protocol product feed linted against the nine required fields, the `"79.99 USD"` price form, GTIN check digits and duplicate item ids, plus feed-vs-page price and availability consistency.
- **Agent readiness** (M22): can a scripted agent understand and operate this page from the HTML alone — named controls, labeled form fields, real links instead of `href="javascript:"`. Directional by construction, capped at severity 3, and what static HTML cannot answer is listed verbatim rather than skipped.
- **`--probe "<question>"`** runs a `WebSearch` and reports presence rate, best rank and the competitor tally. It is **severity 0 and never scored**, and it carries the script's own disclaimer verbatim: this is web-search presence, *not* AI Overview / AI Mode / ChatGPT / Perplexity citation data — no vendor exposes that. Indexing is a documented precondition; presence here is necessary, not sufficient.
- **`--gsc-ai-export <csv>`** imports the Search Console **Generative AI** report you exported by hand (there is no API for it). **Impressions only** — no clicks, no citations, no per-answer attribution — and also severity 0.

## The opt-in fixer

<p align="center">
  <img src="https://raw.githubusercontent.com/Hainrixz/claude-seo-ai/main/assets/fixer.png" alt="The Claude mascot with a pixel wrench fixing a code window showing a green-plus diff line" width="760">
</p>

The fixer ([`skills/fix`](skills/fix/SKILL.md)) is `disable-model-invocation: true` — Claude can **never** trigger writes on its own. Only `/claude-seo-ai:fix` does, and only the one writer subagent (`seo-fixer-writer`) has Write/Edit; every auditor is read-only by tool allowlist.

- **AUTO** (deterministic, additive, verifiable): meta viewport/charset/lang, Tier-1 JSON-LD, robots.txt AI directives, canonical, hreflang sets, OG/Twitter cards, image dimensions, XML sitemaps, llms.txt (disclosure-gated).
- **PROPOSED** (per-item accept): generated `<title>`/meta description, answer-block/TL;DR rewrites, internal-link insertions, heading restructuring, generated image alt text.
- **ADVISORY** (never written): content rewrites, Core Web Vitals/performance, rendering strategy, redirects, link-building, Merchant Center/GBP backend.

Dry-run by default · previews everything (unified diff for files, the request + variables + `before` values for APIs, the exact command for CLI ops) · every change badged `[none]` / `[staged]` / `[LIVE]` · one-shot confirmation tickets that expire in 15 minutes · backups under `${CLAUDE_PLUGIN_DATA}` · idempotent · re-verifies each change (a stale cache is `pending_cache`, never a pass) · rollback from the captured `before` state · never writes to `.git`/secrets/lockfiles (enforced by two PreToolUse hooks, one for the file tools and one for Bash).

One guarantee is **writer protocol rather than code**, and this repo does not blur that line: being **git-aware** — `git status --porcelain` first, refuse a dirty working tree unless `--force`, prefer a `seo-fix/<date>` branch — is instructed in [`skills/seo-fix-apply`](skills/seo-fix-apply/SKILL.md) and [`skills/fix`](skills/fix/SKILL.md), and no adapter runs git. Everything else in the list above is enforced by code: the adapters, the ticket TTL and the two PreToolUse hooks.

**Nothing goes live by default:** Shopify pushes to an unpublished theme and a live push from the shell is a hard deny; Webflow and HubSpot stay staged until a separately-confirmed publish; Ghost never flips a draft; WordPress never touches post status or content. Where a platform has no staging surface, you are told before you confirm, not after.

And nothing is dropped quietly: the plan accounts for **every** finding in the report — considered, planned, held back for want of `--include-proposed` (with the ids), advisory, and the ones no adapter owns.

## Honesty guardrails

This tool refuses to ship SEO myths:

- **llms.txt and the other AI discovery files (M21) are scored 0** — reported, never counted. Google Search ignores `llms.txt`; adoption is ~10 % and no major vendor documents honoring it for retrieval (it is still useful as IDE-agent context).
- **Only what a search engine documents may be `established`** — on the AI axis, that is M14 eligibility and nothing else. And **only an `established` failure can cap a score**: a severity-5 `directional` finding never does.
- **Probes are never scored.** `--probe` and `--gsc-ai-export` are severity 0, excluded from the score and from every cap, and reported beside it rather than inside it.
- **A thin run says so.** When less than 50 % of an axis's always-on weight carried a scored finding, the band is marked **provisional** and the unmeasured categories are named. A one-page run cannot look like an A.
- **Unknown-language pages are `manual_review`, not a pass.** The heuristics ship EN and ES lexicons; on a page in any other language the language-dependent checks are skipped and say so, instead of scoring an unreadable page as clean.
- **FAQPage/HowTo** flagged as deprecated-for-Google-rich-results (still valid for AI extraction) — never counted as a rich-result win.
- **Keyword density** is not optimized for; stuffing is flagged as a negative.
- No "AI-specific keyword" magic — citation comes from extractable structure, verifiable facts, and authority.
- **Lab vs field** Core Web Vitals are clearly distinguished (only CrUX field p75 drives the score).
- **`needs_api` / `manual_review` are never a silent pass** and never override a check that did decide.
- **No fabrication**, ever — never invents statistics, citations, dates (no backdating), credentials, or `sameAs` identity links; and no naked percentages.
- Every finding carries a `confidence` tier (`established` / `directional` / `speculative`); leaked/inferred guidance (e.g. NavBoost) ships only as `directional`.

## Data tiers

| Tier | Needs | Adds |
|---|---|---|
| **0** (default) | nothing | the full deterministic audit — the bundled zero-dependency Node scripts do the fetching, parsing, robots/sitemap/discovery work and every static-HTML check |
| **1** | an already-installed Chrome/Chromium/Edge/Brave (auto-detected), or `playwright` if you have it, or a DOM you captured yourself via `--rendered-file`; and/or `PSI_API_KEY` | the post-JS DOM for SPA/CSR pages; real Core Web Vitals (CrUX field p75) |
| **2** | Search Console / Merchant Center (an MCP you add yourself), or a manual Search Console generative-AI CSV export | indexation state, impressions, feed consistency |

Tier 0 is not a degraded mode — it is the acquisition layer. `WebFetch` is deliberately *not* used to acquire pages: inside Claude Code it returns a small-model summary, never raw HTML, headers or status codes. Nothing is ever installed on your behalf, and the tier is measured from what actually happened, not declared.

See [`.mcp.json.example`](.mcp.json.example) for opt-in render MCPs (plus `@shopify/dev-mcp`, a docs oracle that never writes) and [`docs/en/mcp.md`](docs/en/mcp.md).

## Acquisition layer, CI action & headless runner

The skills are Markdown, but the [`scripts/`](scripts/) are what make the audit real: zero-dependency Node ESM (Node ≥ 18, no install step), each with `main(args) → {result, code}`, uniform exit codes (`0` ok · `1` usage · `2` runtime · `3` gate tripped), and no `--help` — run one with no arguments and it prints its usage line.

```bash
# Acquire one page (status chain, headers, robots directives, parsed DOM) into a run
node scripts/snapshot.mjs https://example.com --out ./runs --render auto --json

# Crawl: robots-aware discovery, URL-template detection, sampled by template
node scripts/crawl.mjs https://example.com --out ./runs --pages 12 --per-template 2 --depth 3

# The whole deterministic pipeline: acquire → profile → 25 checks → report.json + report.md
node scripts/audit.mjs https://example.com --out ./runs --pages 5 --format json

# Re-score a persisted run, and diff two of them
node scripts/score.mjs   --run ./runs/example.com/<run-id>
node scripts/compare.mjs --baseline latest --against ./runs/example.com/<run-id> --format md

# Gates and tests
node scripts/check.mjs        # syntax + JSON + skill frontmatter + version alignment
node tests/run.mjs            # 1000+ assertions over synthetic fixtures, no network
```

Run it headless in CI with the bundled composite GitHub Action — same deterministic subset, a job summary, the scores as step outputs, and exit 3 when a gate trips:

```yaml
- id: seo
  uses: Hainrixz/claude-seo-ai@v0.2.0
  with:
    url: https://example.com
    pages: '5'
    render: static
    fail-under-search: '70'
    fail-under-ai: '60'
```

A ready-to-copy workflow is in [`.github/workflows/seo-audit-example.yml`](.github/workflows/seo-audit-example.yml).

## Project structure

```text
.claude-plugin/   plugin.json (+ userConfig credential prompts) + marketplace.json
skills/           34 skills — 5 commands (audit, geo, score, compare, fix)
                  + 23 seo-* audit modules (M1–M22)
                  + orchestrator, vertical-detect, crawl-render, seo-score, platform-detect, fix-apply
agents/           5 subagents (4 read-only auditors + 1 writer), each preloading its module skills
hooks/            two PreToolUse guards: guard-write (file tools) + guard-bash (shell)
scripts/          zero-dep Node acquisition layer + runner
  ├─ lib/         html, fetch, robots, sitemaps, store, renderers, route-map, adapter, credentials…
  ├─ checks/      25 deterministic checks emitting 151 finding ids
  └─ adapters/    local-files, shopify-theme/admin, wordpress-rest/wpcli, page-api (+providers), instructions
references/       scoring model, AI crawlers, schema, CWV, routing + 24 platform knowledge cards
schema/           finding + report JSON Schemas, JSON-LD templates
action.yml        composite GitHub Action for CI
docs/en, docs/es  bilingual guides (usage, architecture, scoring, mcp, distribution, platforms)
assets/           pixel-art images
tests/            node:test suites (unit + e2e) over synthetic fixtures
```

## About

<p align="center">
  <img src="https://raw.githubusercontent.com/Hainrixz/claude-seo-ai/main/assets/about.png" alt="Pixel-art Claude mascot — an orange blocky creature" width="300">
</p>

Built by **Enrique Rocha** — I help teams ship AI: consulting, automations, and agents. This is a community, MIT-licensed project: use it, fork it, open issues and PRs (see [`CONTRIBUTING.md`](CONTRIBUTING.md)).

- 🌐 **[tododeia.com](https://tododeia.com)**
- 📸 Instagram **[@soyenriquerocha](https://instagram.com/soyenriquerocha)**

## License

[MIT](LICENSE) · *Claude mascot artwork generated for this project in pixel-art style.*

---

## 🇪🇸 Resumen (Español)

`claude-seo-ai` es la herramienta open-source de **SEO + búsqueda con IA** para Claude Code. Audita cualquier sitio en **dos puntajes independientes** — **Search SEO** clásico y **Visibilidad en IA (GEO/AEO)** — con hallazgos reproducibles, y opcionalmente **aplica** las correcciones seguras por ti (meta tags, JSON-LD, robots.txt para crawlers de IA, hreflang, sitemaps…), siempre con confirmación previa.

- **Instalar:** `/plugin marketplace add Hainrixz/claude-seo-ai` → `/plugin install claude-seo-ai@claude-seo-ai`. Multiagente: `npx skills add Hainrixz/claude-seo-ai` (solo las skills en Markdown; la capa `scripts/` va en el canal de plugin).
- **Usar:** `/claude-seo-ai:audit <url>` · `:geo` · `:score` · `:compare` · `:fix`. Los cuatro primeros son de solo lectura; `fix` previsualiza todo y escribe solo tras tu confirmación cambio por cambio.
- **Cada auditoría se persiste** en `${CLAUDE_PLUGIN_DATA}/runs/<host>/<run-id>/`, así que `score`, `compare` y `fix` trabajan sobre un informe en disco, no sobre «la última auditoría de esta sesión».
- **Funciona en cualquier sitio:** un detector de cuatro capas (plataforma · framework · plugins · hosting) enruta cada corrección al adaptador dueño de esa superficie — Shopify, WordPress, Webflow, Wix, Ghost, HubSpot, BigCommerce, árboles de código o `instructions`. **Nada se publica en vivo por defecto.**
- **Honestidad:** llms.txt y el resto de M21 se informan pero puntúan 0; las sondas (`--probe`, `--gsc-ai-export`) tienen severidad 0 y nunca entran en la puntuación; una ejecución delgada marca su banda como provisional; `needs_api` / `manual_review` nunca son un aprobado silencioso; nunca inventa estadísticas, fechas ni enlaces de identidad.
- **Sin claves funciona** (Tier 0: los scripts de Node sin dependencias son la capa de adquisición). Render de SPAs y Core Web Vitals reales son opcionales (Tier 1+).

Guías completas en español: [`docs/es/`](docs/es/) — [uso](docs/es/usage.md) · [arquitectura](docs/es/architecture.md) · [puntuación](docs/es/scoring.md) · [plataformas](docs/es/platforms.md) · [MCP](docs/es/mcp.md) · [distribución](docs/es/distribution.md). Hecho con cariño por [tododeia.com](https://tododeia.com).

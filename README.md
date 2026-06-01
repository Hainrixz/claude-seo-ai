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

The plugin works **fully offline** (Tier 0, no keys). See [Data tiers](#data-tiers) for optional rendering and API integrations.

## Usage

```text
/claude-seo-ai:audit  <url|path> [--render auto|static|js] [--vertical auto|saas|blog-publisher|local-business|ecommerce|docs]
/claude-seo-ai:geo    <url|path>            # AI-search (GEO/AEO) subset → AI Visibility score
/claude-seo-ai:score                         # recompute/show scores from the last audit
/claude-seo-ai:fix    <url|path> [--category schema|meta|robots|sitemap|hreflang|alt|canonical|social|llms] [--dry-run]
```

`audit` is **read-only** and never touches your files. `fix` previews diffs by default and writes only after you confirm each change. Power users can call any module directly, e.g. `/claude-seo-ai:seo-schema-jsonld`.

## Two scores, never blended

<p align="center">
  <img src="https://raw.githubusercontent.com/Hainrixz/claude-seo-ai/main/assets/dual-score.png" alt="Two pixel-art scoreboards — SEARCH and AI — with the Claude mascot between them" width="720">
</p>

Every audit reports two **0–100** scores with letter bands (A–F) and a one-line interpretation ([details](references/scoring-model.md)):

- **Search SEO** — weighted toward indexability, Core Web Vitals, on-page, schema.
- **AI Visibility (GEO/AEO)** — weighted toward answer extractability, schema, fact density, AI-crawler access, entities.

Severity gating caps a score at **F** if something critical fails (e.g. site-wide `noindex`). Conditional verticals re-normalize so a blog isn't penalized for lacking Product schema. `needs_api` checks are excluded from the math and counted separately as score confidence.

## How it works

<p align="center">
  <img src="https://raw.githubusercontent.com/Hainrixz/claude-seo-ai/main/assets/how-it-works.png" alt="Three-step pixel flow: the Claude mascot → magnifying glass over code → report with green checkmarks" width="760">
</p>

A skill-first, three-layer design (Claude is the runtime; the Node helpers are optional):

1. **Directive** — one of the four command skills (`audit`/`geo`/`score`/`fix`).
2. **Orchestration** — `seo-orchestrator` builds a shared **PageSnapshot**, detects the site vertical, and dispatches read-only specialist subagents in parallel.
3. **Execution** — ~20 focused `seo-*` modules each emit findings conforming to [`schema/finding.schema.json`](schema/finding.schema.json) — with observed evidence and a runnable `verification.reproduce` command. See [`docs/en/architecture.md`](docs/en/architecture.md).

## What it audits

A complete 2026 suite, grouped:

| Area | Modules |
|---|---|
| **Crawl & index** | crawlability/robots (M1), indexability + canonical + site health (M2/M3), rendering CSR/SSR/SSG (M4), sitemaps (M17) |
| **Structured data** | Tier-1 JSON-LD validate + generate (M5), entity/Knowledge-Graph `sameAs` (M6) |
| **On-page & meta** | title/meta/head (M7), mobile (M7b), headings (M7c), social cards (M8), images & alt (M9), internal linking (M10) |
| **AI search (GEO/AEO)** | answer extractability (M11), fact density & original data (M12), AI-crawler access + llms.txt (M14/M21) |
| **Content & trust** | E-E-A-T (M16), freshness (M13) |
| **Performance** | Core Web Vitals — LCP/INP/CLS (M15) |
| **Verticals (conditional)** | e-commerce/Product (M18), local (M19), international/hreflang (M20) |

## Get cited by AI engines

<p align="center">
  <img src="https://raw.githubusercontent.com/Hainrixz/claude-seo-ai/main/assets/ai-citations.png" alt="The Claude mascot beside a webpage being cited by pixel AI chat bubbles and robots" width="760">
</p>

The GEO/AEO modules score how *citable* your content is: self-contained answer blocks, fact density, original data, entity linking, and whether retrieval bots (`OAI-SearchBot`, `Claude-SearchBot`, `PerplexityBot`) can actually reach and render your page. See [`references/ai-crawlers.md`](references/ai-crawlers.md).

## The opt-in fixer

<p align="center">
  <img src="https://raw.githubusercontent.com/Hainrixz/claude-seo-ai/main/assets/fixer.png" alt="The Claude mascot with a pixel wrench fixing a code window showing a green-plus diff line" width="760">
</p>

The fixer ([`skills/fix`](skills/fix/SKILL.md)) is `disable-model-invocation: true` — Claude can **never** trigger writes on its own. Only `/claude-seo-ai:fix` does, and only the one writer subagent (`seo-fixer-writer`) has Write/Edit; every auditor is read-only by tool allowlist.

- **AUTO** (deterministic, additive, verifiable): meta viewport/charset/lang, Tier-1 JSON-LD, robots.txt AI directives, canonical, hreflang sets, OG/Twitter cards, image dimensions, XML sitemaps, llms.txt (disclosure-gated).
- **PROPOSED** (per-item accept): generated `<title>`/meta description, answer-block/TL;DR rewrites, internal-link insertions, heading restructuring, generated image alt text.
- **ADVISORY** (never written): content rewrites, Core Web Vitals/performance, rendering strategy, redirects, link-building, Merchant Center/GBP backend.

Dry-run by default · unified-diff preview · git-aware (refuses a dirty tree) · backups under `${CLAUDE_PLUGIN_DATA}` · idempotent · re-verifies each change · never writes to `.git`/secrets/lockfiles (enforced by a PreToolUse hook).

## Honesty guardrails

This tool refuses to ship SEO myths:

- **llms.txt** is generated but **scored 0** and labeled low/uncertain impact (~10% adoption; partial vendor support — Anthropic and Perplexity honor it in retrieval, Google does not use it for AI Overviews/AI Mode, OpenAI uncommitted — also useful as IDE-agent context).
- **FAQPage/HowTo** flagged as deprecated-for-Google-rich-results (still valid for AI extraction) — never counted as a rich-result win.
- **Keyword density** is not optimized for; stuffing is flagged as a negative.
- No "AI-specific keyword" magic — citation comes from extractable structure, verifiable facts, and authority.
- **Lab vs field** Core Web Vitals are clearly distinguished (only CrUX field p75 drives the score).
- **No fabrication**, ever — never invents statistics, citations, dates (no backdating), credentials, or `sameAs` identity links.
- Every finding carries a `confidence` tier (`established` / `directional` / `speculative`); leaked/inferred guidance (e.g. NavBoost) ships only as `directional`.

## Data tiers

| Tier | Needs | Adds |
|---|---|---|
| **0** (default) | nothing | full offline audit via WebFetch + bundled scripts |
| **1** | a render MCP (Playwright/Firecrawl) and/or `PSI_API_KEY` | JS rendering for SPAs; real Core Web Vitals (CrUX field data) |
| **2** | Search Console / Merchant Center (OAuth) | indexation state, impressions, feed consistency |

See [`.mcp.json.example`](.mcp.json.example) for opt-in render MCPs and [`docs/en/mcp.md`](docs/en/mcp.md).

## Optional scripts

The skills work as pure Markdown; the zero-dependency Node helpers in [`scripts/`](scripts/) sharpen accuracy and make `verification.reproduce` runnable (Node ≥ 18, no install step):

```bash
node scripts/parse-html.mjs           --file tests/fixtures/blog-post.html
node scripts/validate-jsonld.mjs      --url  https://example.com
node scripts/parse-robots-sitemap.mjs --url  https://example.com
node scripts/score.mjs                --findings findings.json
node tests/run.mjs                    # 30 assertions over the fixtures
```

## Project structure

```text
.claude-plugin/   plugin.json + marketplace.json
skills/           4 command skills (audit, geo, score, fix → /claude-seo-ai:audit …)
                  + orchestrator, vertical-detect, crawl-render, seo-score + ~20 audit modules
agents/           5 subagents (4 read-only auditors + 1 writer)
hooks/            PreToolUse write guard
scripts/          optional zero-dep Node helpers (+ verification)
references/       scoring model, AI crawlers, schema, CWV, routing
schema/           finding + report JSON Schemas, JSON-LD templates
docs/en, docs/es  bilingual guides
assets/           pixel-art images
tests/fixtures    sample sites for verification
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

- **Instalar:** `/plugin marketplace add Hainrixz/claude-seo-ai` → `/plugin install claude-seo-ai@claude-seo-ai`. Cross-agente: `npx skills add Hainrixz/claude-seo-ai`.
- **Usar:** `/claude-seo-ai:audit <url>` · `:geo` · `:score` · `:fix` (vista previa por defecto; nunca escribe sin tu confirmación).
- **Honestidad:** llms.txt se genera pero puntúa 0; FAQ/HowTo marcados como sin rich results; nunca inventa estadísticas, fechas ni enlaces de identidad.
- **Sin claves funciona** (Tier 0, offline). Render de SPAs y Core Web Vitals reales son opcionales (Tier 1+).

Guías completas en español: [`docs/es/`](docs/es/) · hecho con cariño por [tododeia.com](https://tododeia.com).

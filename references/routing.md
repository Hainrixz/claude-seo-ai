# Vertical detection & module routing

`seo-vertical-detect` classifies the target, `scripts/detect-platform.mjs` (Phase 3) profiles the platform, then the orchestrator runs the always-on modules plus the conditional ones the vertical unlocks, dispatches the agents with envelopes, and reweights the scores.

## Verticals & signals

| Vertical | Detection signals |
|---|---|
| `ecommerce` | `Product`/`Offer` schema, cart/checkout routes, price elements, add-to-cart, `og:type=product`, `/.well-known/ucp` declaring a catalog service |
| `local-business` | `LocalBusiness` schema, NAP (name/address/phone), maps embed, opening hours, store-locator |
| `blog-publisher` | `Article`/`BlogPosting` schema, bylines/author pages, RSS/Atom feed, post archives, dates |
| `saas` | pricing/signup/login routes, `SoftwareApplication`, feature/integration pages, docs subdomain |
| `docs` | docs/reference routes, sidebar nav, version selectors, code blocks, llms.txt presence |
| `generic` | none of the above clearly dominates |

A site can match several (e.g. SaaS + docs + blog). Run the union of unlocked modules; let conditional scoring re-normalize. The detector also emits `multilingual: true|false` (hreflang, >1 locale, language switcher) — consumed by the M20 rule below.

## Always-on modules (every audit)

M1 crawlability · M2/M3 indexability · M4 rendering · M5 schema · M6 entities · M7 meta · M7b mobile · M7c headings · M8 social · M9 images · M10 internal linking · M11 answer blocks · M12 fact density · M13 freshness · M14 AI crawlers & AI-feature eligibility · M15 CWV · M16 E-E-A-T · M17 sitemaps · M21 AI discovery & agent endpoints (**weight 0 — reported, never scored**) · M22 agent-readiness.

## Conditional modules (unlocked by vertical / profile)

| Condition | Adds | Owner | Emphasis shift |
|---|---|---|---|
| `ecommerce` | M18 (Product/Offer/Review, faceted nav, feed↔page consistency) + M18 agentic-commerce readiness (`/.well-known/ucp` validity, Shopify Catalog eligibility, ACP feed lint when a feed is supplied) | schema-generator | Schema + CWV weigh more; M18 also enters the AI score (conditional weight) |
| `local-business` | M19 (LocalBusiness, NAP, hours, geo) | schema-generator | Entities + LocalBusiness schema; M19 also enters the AI score (conditional weight) |
| `multilingual: true` (any vertical) | M20 (hreflang reciprocity, x-default, BCP-47, `<html lang>` agreement) | technical-auditor | Search only; International category activates |
| `blog-publisher` | — | — | E-E-A-T (M16), freshness (M13), answer blocks (M11) weigh more |
| `docs` | — | — | Answer blocks (M11), internal linking (M10); M21 reported with the docs-site framing |

When a condition is off, its module emits nothing (or `not_applicable`) and its category leaves the denominator — a blog is never penalized for lacking Product schema, a monolingual site never for lacking hreflang.

## Subagent dispatch (parallel, one message, `Agent` tool)

| Agent | Modules |
|---|---|
| `technical-auditor` | M1, M2 (+M3), M4, M7, M7b, M7c, M8, M9, M10, M15, M17, M20* (*only when `vertical.multilingual`) |
| `ai-search-geo-specialist` | M6, M11, M12, M14, M21, M22 |
| `content-eeat-analyst` | M13, M16 |
| `schema-generator` | M5 (+ M18 / M19 schema and readiness when the vertical is active) |

M21 is **AI discovery & agent endpoints** (`/llms.txt`, `/llms-full.txt`, `/agents.md`, `/.well-known/ucp`, `/.well-known/ai-catalog.json`, `/sitemap_agentic_discovery.xml`) — not entity linkage; M6 is the only entity module.

Each agent receives a **dispatch envelope** (`plugin_root`, `run_dir`, `pages[]`, `site`, `vertical`, `platform` profile path + cards, `modules[]`, `deterministic_findings`, `return`) and returns a findings array conforming to `schema/finding.schema.json`. Agents never depend on `${...}` substitution: every script call is `node "<plugin_root>/scripts/<x>.mjs" --snapshot "<run_dir>/pages/<slug>.json"`. <!-- reconcile-flags-v0.2 --> The orchestrator saves each array to `<run_dir>/agents/<agent>.json`, then `report.mjs <run_dir> --merge "agents/*.json"` merges, dedupes by `id` + location (keeping the most severe), scores, and renders.

## Platform layer (Phase 3 — `scripts/detect-platform.mjs` + `references/platforms/<id>.md`)

Orthogonal to the vertical: the same modules run, but the profile decides which platform-conditional check ids fire, what is `not_applicable` because the platform owns it, and which fix adapter `fix` selects by default. Stub table; each card is created in Phase 3b.

| Platform id | Knowledge card | Default `--target` | Adapters |
|---|---|---|---|
| `shopify` | `references/platforms/shopify.md` | `shopify-theme` (+ `shopify-admin` for per-resource SEO fields) | shopify-theme, shopify-admin, instructions |
| `wordpress` (+ `woocommerce`, SEO plugin ids) | `references/platforms/wordpress.md`, `woocommerce.md` | `wordpress-rest` if credentials and the SEO plugin exposes REST writes, else `wordpress-wpcli` if `--ssh`, else `instructions` | wordpress-rest, wordpress-wpcli, local-files (classic theme + repo), instructions |
| `wix` / `webflow` / `ghost` / `hubspot` / `bigcommerce` | `references/platforms/<id>.md` | `page-api` if credentials, else `instructions` | page-api (provider), instructions |
| `squarespace` / `framer` | `references/platforms/<id>.md` | `instructions` (no SEO API) | instructions |
| `magento` / `drupal` / `payload` | `references/platforms/<id>.md` | `instructions` (Payload: `page-api`, field names UNVERIFIED) | instructions, page-api |
| `nextjs` / `nuxt` / `astro` / `sveltekit` / `remix` / `gatsby` / `hugo` / `jekyll` / `eleventy` / `docusaurus` / `static` | `references/platforms/<id>.md` | `local` when `--project` is given, else `instructions` (framework snippet) | local-files (route→file map), instructions |
| unknown | — | `instructions` | instructions |

URL-only targets never select `local`. Only `html-head`, `front-matter`, `config-file`, and `liquid` insertion strategies may be AUTO; every JSX/TS-object strategy is PROPOSED.

### SiteProfile shape (produced by `scripts/detect-platform.mjs`, Phase 3; merged with `seo-vertical-detect` output into `<run_dir>/profile.json`)

```json
{
  "version": 1,
  "platform":  { "id": "shopify", "confidence": "high", "score": 14, "signals": [{ "kind": "header", "value": "x-shopid", "weight": 5 }] },
  "framework": { "id": "nextjs", "flavor": "app-router", "router": "app", "confidence": "medium", "signals": [] },
  "cms_plugins": [{ "id": "yoast", "confidence": "high" }],
  "hosting": { "id": "vercel" },
  "environment": { "kind": "production | preview | staging | local" },
  "capabilities": {
    "local_files": false, "theme_files": true, "rest_api": false, "wp_cli": false, "admin_api": true,
    "page_api": false, "instructions_only": false, "sitemap_editable": false,
    "robots_editable": "theme-template | physical | plugin | file | none",
    "redirects": "admin-api | plugin | file | none",
    "head_owner": "theme | seo-plugin | framework | builder"
  },
  "write_targets": [{ "adapter": "shopify-theme", "for": ["head", "jsonld", "robots", "llms"], "ready": false, "needs": ["SHOPIFY_STORE", "SHOPIFY_THEME_TOKEN"], "tools": {} }],
  "candidates": { "platform": [], "framework": [] },
  "vertical_hints": ["ecommerce"]
}
```

`needs` lists credential **key names only**; presence is checked for `CLAUDE_PLUGIN_OPTION_<KEY>` / `<KEY>` without reading values. Confidence: high ≥ 8 with ≥ 2 signal kinds, medium ≥ 5, low ≥ 2, else omitted.

## Environment layer

`environment.kind` comes from the profile (`noindex` + `*.vercel.app`, `*--*.netlify.app`, `*.myshopify.com?preview_theme_id`, `*.wpengine.com`, `staging.` → `preview`/`staging`; `localhost` → `local`). The orchestrator passes it to the scorer (`score.mjs --environment preview|staging|local`), which **suppresses noindex-type severity-5 caps** and reports them as "expected on a non-production host" instead of gating the Search score at F. The finding `M2.hosting.preview_environment_audited` (warn, severity 1) records that the run was not against production.

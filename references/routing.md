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

Each agent receives a **dispatch envelope** (`plugin_root`, `run_dir`, `pages[]` as `{slug, url, role}`, `site`, `vertical`, `platform` profile path + `platform_cards[]`, `modules[]`, `deterministic_findings`, `return`) and returns a findings array conforming to `schema/finding.schema.json`. Agents never depend on `${...}` substitution: every call is `node "<plugin_root>/scripts/<x>.mjs" …` with absolute paths. Page-level scripts (`parse-html`, `validate-jsonld`, `check-answerblocks`, `factdensity`, `check-freshness`, `hreflang-check`, `link-graph`, `ai-eligibility`, `agent-readiness`) take `--snapshot "<run_dir>/pages/<slug>.json"`; the site-level and live-only ones do not — `parse-robots-sitemap` takes `--url`/`--robots`/`--sitemap`/`--file`, `ua-diff` and `psi-client` take `--url`, `acp-feed-lint` takes `--feed`, and `ai-discovery` takes `--snapshot` or `--run-dir`. The orchestrator saves each array to `<run_dir>/agents/<agent>.json`, then `report.mjs <run_dir> --merge "agents/*.json"` merges, dedupes by `id` + normalized location (keeping the most severe), scores, and renders.

## Platform layer (`scripts/detect-platform.mjs` + `references/platforms/<id>.md`)

Orthogonal to the vertical: the same modules run, but the profile decides which platform-conditional
check ids fire, what is `not_applicable` because the platform owns it, and which fix adapter `fix`
selects by default. Four layers are scored independently (platform · framework · cms plugins ·
hosting), so a site can legitimately match a row from each of the three groups below at once — a
headless WordPress behind Next.js, or a Hydrogen storefront on Shopify.

### Platform layer (a CMS or hosted builder owns the pages)

| Platform id | Knowledge card | Default `--target` | Adapters |
|---|---|---|---|
| `shopify` | `platforms/shopify.md` | `shopify-theme` (+ `shopify-admin` for per-resource SEO fields) | shopify-theme, shopify-admin, instructions |
| `wordpress` | `platforms/wordpress.md` | `wordpress-rest` when credentials exist and the SEO plugin exposes REST writes, else `wordpress-wpcli` with `--ssh`, else `instructions` | wordpress-rest, wordpress-wpcli, local-files (classic theme + repo), instructions |
| `woocommerce` (plugin layer) | `platforms/woocommerce.md` | as `wordpress` | wordpress-rest, wordpress-wpcli, instructions |
| `wix` | `platforms/wix.md` | `page-api` with credentials, else `instructions` | page-api, instructions |
| `squarespace` | `platforms/squarespace.md` | `instructions` (no SEO API) | instructions |
| `webflow` | `platforms/webflow.md` | `page-api` with credentials, else `instructions` | page-api, instructions |
| `framer` | `platforms/framer.md` | `instructions` (no SEO API) | instructions |
| `ghost` | `platforms/ghost.md` | `page-api` with credentials, else `instructions` | page-api, local-files (self-hosted theme), instructions |
| `hubspot` | `platforms/hubspot.md` | `page-api` with credentials, else `instructions` | page-api, instructions |
| `bigcommerce` | `platforms/bigcommerce.md` | `page-api` with credentials, else `instructions` | page-api, local-files (Stencil theme), instructions |
| `magento` | `platforms/magento.md` | `instructions` | instructions, local-files (theme repo) |
| `drupal` | `platforms/drupal.md` | `instructions` | instructions, local-files (theme repo) |
| `payload` | `platforms/payload.md` | `page-api` with credentials, else the Next.js rules (field names UNVERIFIED) | page-api, local-files, instructions |

### Framework layer (code owns the `<head>`)

| Framework id | Knowledge card | Default `--target` | Adapters |
|---|---|---|---|
| `nextjs` | `platforms/nextjs.md` | `local` with `--project`, else `instructions` | local-files (route→file map), instructions |
| `nuxt` | `platforms/nuxt.md` | `local` with `--project`, else `instructions` | local-files, instructions |
| `astro` | `platforms/astro.md` | `local` with `--project`, else `instructions` | local-files, instructions |
| `sveltekit` | `platforms/sveltekit.md` | `local` with `--project`, else `instructions` | local-files, instructions |
| `react-router` (Remix / RR7 / Hydrogen) | `platforms/react-router.md` | `local` with `--project`, else `instructions` | local-files, instructions (+ shopify-admin on Hydrogen) |
| `gatsby` | `platforms/gatsby.md` | `local` with `--project`, else `instructions` | local-files, instructions |
| `hugo` | `platforms/hugo.md` | `local` with `--project`, else `instructions` | local-files, instructions |
| `jekyll` | `platforms/jekyll.md` | `local` with `--project`, else `instructions` | local-files, instructions |
| `eleventy` | `platforms/eleventy.md` | `local` with `--project`, else `instructions` | local-files, instructions |
| `docusaurus` | `platforms/docusaurus.md` | `local` with `--project`, else `instructions` | local-files, instructions |
| `static` | `platforms/static.md` | `local` with `--project`, else `instructions` | local-files, instructions |
| unknown | — | `instructions` | instructions |

URL-only targets never select `local`. Only `html-head`, `front-matter`, `config-file`, and `liquid`
insertion strategies may be AUTO; every JSX/TS-object strategy is PROPOSED. When a platform card and
a framework card disagree about the head, `capabilities.head_owner` settles it.

### SiteProfile shape (produced by `scripts/detect-platform.mjs`; merged with `seo-vertical-detect` output into `<run_dir>/profile.json`)

```json
{
  "version": "detect-platform/1",
  "target":    { "url": "https://example.com/", "host": "example.com", "project_root": null },
  "platform":  { "id": "shopify", "confidence": "high", "score": 14, "signals": [{ "kind": "header", "value": "x-shopid", "weight": 5 }] },
  "framework": { "id": "nextjs", "flavor": "app-router", "router": "app", "confidence": "medium", "score": 6, "signals": [] },
  "cms_plugins": [{ "id": "yoast", "confidence": "high", "score": 13, "signals": [] }],
  "hosting":   { "id": "vercel", "confidence": "high", "signals": [] },
  "environment": { "kind": "production | preview | staging | local", "signals": [] },
  "capabilities": {
    "local_files": false, "theme_files": true, "rest_api": false, "wp_cli": false, "admin_api": true,
    "page_api": false, "instructions_only": false, "sitemap_editable": false,
    "robots_editable": "theme-template | physical | plugin | file | none",
    "redirects": "admin-api | plugin | file | none",
    "head_owner": "theme | seo-plugin | framework | builder"
  },
  "write_targets": [{ "adapter": "shopify-theme", "for": ["head", "jsonld", "robots", "llms"], "ready": false, "needs": ["SHOPIFY_STORE", "SHOPIFY_THEME_TOKEN"], "tools": { "shopify": false } }],
  "candidates": { "platform": [], "framework": [] },
  "vertical_hints": ["ecommerce"],
  "cards": ["references/platforms/shopify.md"],
  "sources": { "html": true, "headers": true, "cookies": true, "probes": [], "repo": null, "repo_files": 0 },
  "notes": ["repo signals not consulted: no --path given (repo/pkg rules were skipped)"]
}
```

Signals are `{ kind, value, weight }` with `kind` one of `header · cookie · generator · asset_host ·
path · dom · link_rel · probe · repo · pkg`, weights 1-5. Confidence: high ≥ 8 with ≥ 2 signal kinds,
medium ≥ 5, low ≥ 2, else the layer is `null` — an unresolved platform is a result, not a gap.
`needs` lists credential **key names only**; presence is checked for `CLAUDE_PLUGIN_OPTION_<KEY>` /
`<KEY>` without reading values, and CLI tools (`shopify`, `wp`, `ssh`) are checked for presence on
PATH, never executed. `repo`/`pkg` signals require `--path`; `probe` signals require `--probe`;
`notes[]` says when either was unavailable.

### Platform-conditional finding ids

These 31 ids are emitted **only** when `profile.json` names the matching platform or framework (a
`low` confidence verdict does not count). They are not in any module skill's Findings table on
purpose — a WordPress id would be noise on a Shopify audit — so this is their index. Each one is
specified in full in `references/platforms/<id>.md` §10, which is the card the dispatched agent
already receives.

| Module (skill) | Emitted when | Ids |
|---|---|---|
| M1 (`seo-crawlability`) | `nextjs` | `M1.nextjs.robots_conflict` |
| M1 (`seo-crawlability`) | `shopify` | `M1.shopify.filter_sort_urls_crawlable` · `M1.shopify.robots_liquid_drops_defaults` · `M1.shopify.tag_combo_urls_crawlable` |
| M1 (`seo-crawlability`) | `wordpress` | `M1.wordpress.physical_robots_shadowing` · `M1.wordpress.replytocom_crawlable` |
| M2 (`seo-indexability`) | `shopify` | `M2.shopify.collection_path_duplicate` · `M2.shopify.collections_all_indexable` · `M2.shopify.variant_param_canonical` |
| M2 (`seo-indexability`) | `wordpress` | `M2.wordpress.attachment_pages_indexable` · `M2.wordpress.blog_public_off` · `M2.wordpress.thin_archives_indexable` |
| M5 (`seo-schema-jsonld`) | `shopify` | `M5.shopify.duplicate_product_jsonld` · `M5.shopify.theme_jsonld_gaps` |
| M5 (`seo-schema-jsonld`) | `wordpress` | `M5.wordpress.duplicate_schema_sources` · `M5.wordpress.plugin_schema_incomplete` |
| M7 (`seo-meta-onpage`) | `gatsby` · `jekyll` · `nextjs` · `react-router` | `M7.gatsby.head_in_non_page` · `M7.jekyll.seo_tag_present` · `M7.nextjs.metadata_base_missing` · `M7.react_router.meta_replaces_parent` |
| M7 (`seo-meta-onpage`) | `shopify` · `wordpress` | `M7.shopify.description_is_body_fallback` · `M7.wordpress.plugin_owned_head` |
| M17 (`seo-sitemaps`) | `astro` · `gatsby` · `hugo` · `nextjs` · `nuxt` | `M17.astro.site_missing` · `M17.gatsby.site_url_missing` · `M17.hugo.baseurl_missing` · `M17.nextjs.sitemap_missing_source` · `M17.nuxt.site_url_missing` |
| M17 (`seo-sitemaps`) | `shopify` · `wordpress` | `M17.shopify.sitemap_platform_owned` · `M17.wordpress.duplicate_sitemaps` · `M17.wordpress.no_sitemap_any` |
| M20 (`seo-international`) | `shopify` | `M20.shopify.duplicate_hreflang` |

Ids use the framework id with `-` replaced by `_` (`react-router` → `M7.react_router.*`). A
platform-conditional check never fires on a site whose profile does not name that platform, so an
audit of a static site emits none of them.

## Environment layer

`environment.kind` comes from the profile (`noindex` + `*.vercel.app`, `*--*.netlify.app`, `*.myshopify.com?preview_theme_id`, `*.wpengine.com`, `staging.` → `preview`/`staging`; `localhost` → `local`). The orchestrator passes it to the scorer (`score.mjs --environment preview|staging|local`), which **suppresses noindex-type severity-5 caps** and reports them as "expected on a non-production host" instead of gating the Search score at F. The finding `M2.hosting.preview_environment_audited` (warn, severity 1) records that the run was not against production.

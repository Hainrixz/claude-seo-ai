# shopify

**Status:** beta · **Last verified:** 2026-09-05 · **Detector id:** `shopify` · **Layer:** platform

Liquid themes (Online Store 2.0) plus the Admin GraphQL API. The theme owns the `<head>`; the Admin
API owns the per-resource SEO fields. Hydrogen storefronts are a different animal — when
`framework.flavor = hydrogen`, read `react-router.md` for the head and use this card only for §6's
Admin API and §3's URL surfaces.

## 1. Detection recap

Headers `x-shopid` / `x-shopify-stage` (5), cookies `_shopify_y` / `_shopify_s` (4),
`cdn.shopify.com` asset host (4), `/cdn/shop/` paths (3), `Shopify.theme =` (4),
`id="shopify-section-` (3), `window.ShopifyAnalytics` (3), probes `/.well-known/ucp` (3) and
`/products.json` (2); with `--path`, `config/settings_schema.json` and `layout/theme.liquid` (5 each).
`@shopify/hydrogen` in `package.json` (5) means a Hydrogen storefront, not a Liquid theme.

A `medium` verdict from CDN paths alone happens on sites that merely host images on Shopify's CDN —
require a header, cookie or `Shopify.theme` signal before selecting a Shopify write path.

## 2. Generated automatically — do not re-add

- `sitemap.xml` and its children (products, collections, pages, blogs). Not editable. Resources with
  the `seo.hidden` metafield are excluded from it.
- The default `robots.txt` groups (tag-combination paths `/collections/*+*` and the `%2B` encoding,
  `*sort_by*`, `/cart`, `/checkout`, `/orders`, `/admin`, `/search`).
- `hreflang` alternates for every published market/locale, emitted by `content_for_header`. Themes
  that also hand-write hreflang produce duplicates — remove the theme's, never Shopify's.
- `canonical_url`, which collapses the collection-scoped product path and `?variant=` to the base
  product URL.
- Title and meta description from the Admin **Search engine listing** fields (metafields
  `global.title_tag` / `global.description_tag`), when the theme renders `page_title` /
  `page_description`.
- Dawn and most OS 2.0 themes emit Product / BreadcrumbList JSON-LD from
  `sections/main-product.liquid` and `sections/main-article.liquid`.

## 3. URL surfaces & duplicate risks

| Surface | Shape | Risk |
|---|---|---|
| Product, canonical | `/products/<handle>` | — |
| Product, collection-scoped | `/collections/<c>/products/<handle>` | Duplicate; canonical must point at `/products/<handle>` |
| Variant | `/products/<handle>?variant=<id>` | Duplicate; canonical must drop the parameter |
| Tag combinations | `/collections/<c>/<t1>+<t2>` (and `%2B`) | Combinatorial explosion; robots disallows by default |
| Filters / sorting | `?filter.*`, `?sort_by=`, `?pf_*` | Facet duplication |
| Catch-all collection | `/collections/all` | Thin, usually indexable |
| Pagination | `?page=N` | Fine; canonical must stay self-referential |
| Agent surfaces | `/llms.txt`, `/agents.md`, `/.well-known/ucp`, `/sitemap_agentic_discovery.xml` | Present only if templates exist |

Probe these six on every Shopify audit: a collection-scoped product URL, the same product with
`?variant=`, `/collections/all`, one tag combination, one `?filter.*`, one `?sort_by=`.

## 4. Platform-owned — do not fix

| Thing | Owner | Where a human changes it |
|---|---|---|
| `sitemap.xml` | Shopify | Not changeable. Exclude a resource with `seo.hidden`, or unpublish it |
| hreflang alternates | Shopify markets | Settings → Markets. Fix the *theme's* duplicates only |
| Domains, HTTPS, redirect-to-primary | Shopify | Settings → Domains |
| `settings_data.json` | Theme editor | Editing it by hand overwrites merchant choices — never touch it |
| Prices, inventory, availability | Admin | Products |
| Checkout markup | Shopify | Not editable outside Plus |

Emit these as `not_applicable` with `evidence.observed` naming Shopify as the owner, never as a pass.

## 5. Fix map

| Class | Location | Adapter | Class | live_impact |
|---|---|---|---|---|
| `<html lang>`, canonical, title template, OG/Twitter block | `layout/theme.liquid` head | `shopify-theme` | AUTO | staged |
| Organization / WebSite JSON-LD | `snippets/seo-structured-data.liquid` (created, marked) | `shopify-theme` | AUTO | staged |
| Product / Article JSON-LD gaps (brand, sku, gtin, offers.url) | `sections/main-product.liquid`, `sections/main-article.liquid` | `shopify-theme` | PROPOSED | staged |
| Duplicate hreflang emitted by the theme | `layout/theme.liquid` | `shopify-theme` | PROPOSED | staged |
| robots rules | `templates/robots.txt.liquid` | `shopify-theme` | AUTO | staged |
| `/llms.txt`, `/agents.md` | `templates/llms.txt.liquid`, `templates/agents.md.liquid` | `shopify-theme` | AUTO (disclosure-gated) | staged |
| Per-resource SEO title/description | `productUpdate`, `collectionUpdate`, `pageUpdate`, `articleUpdate` | `shopify-admin` | PROPOSED | **live** |
| Hide a resource from index + sitemap | `metafieldsSet` `seo.hidden = 1` | `shopify-admin` | PROPOSED | **live** |
| Redirect | `urlRedirectCreate(path, target)` | `shopify-admin` | PROPOSED | **live** |
| Anything in §4 | — | — | ADVISORY | none |

`templates/robots.txt.liquid` **must keep** the `{% for group in robots.default_groups %}` loop — a
custom template that drops it silently discards every Shopify default rule. The liquid `robots`
object exposes `robots`, `group`, `rule`, `user_agent`, `sitemap`, `request`.

## 6. Write method & credentials

**Theme** — Shopify CLI. `shopify theme pull` → edit → `shopify theme check --path <work> -o json
--fail-level error` → `shopify theme push --path <work> --unpublished --theme "<name>" --json`.
Credential key names: `SHOPIFY_STORE`, `SHOPIFY_THEME_TOKEN` (a Theme Access token). The CLI reads
it as `SHOPIFY_CLI_THEME_TOKEN`, which the toolkit sets in the child process `env`, never on argv.
The older `SHOPIFY_CLI_THEME_TOKEN` spelling still resolves if it is what you exported. `shopify`
must be on PATH.

**Admin GraphQL** — `https://<store>/admin/api/2026-07/graphql.json` with an
`X-Shopify-Access-Token` header. Credential key names: `SHOPIFY_STORE`, `SHOPIFY_ADMIN_TOKEN`.
Scopes: `write_products` for product/collection SEO, `write_online_store_navigation` for
`urlRedirectCreate`. Page and article scopes are `UNVERIFIED` (§12).

`productUpdate(input: { id, seo: { title, description } })` writes the same values as the
`global.title_tag` / `global.description_tag` metafields. Resolve a handle to a GID with
`productByIdentifier` (2026-07), falling back to `productByHandle`. `metafieldsSet` upserts, so
`seo.hidden` needs no prior metafield id; a raw metafield **update** does need one, so read first.

There is no official Shopify MCP that writes. `@shopify/dev-mcp` is a docs/schema oracle — use it to
confirm a field exists, never as a write path.

## 7. Preview & publish

Theme edits go to an **unpublished** theme (one reusable `claude-seo-ai <date>` staging theme;
stores have a 20-theme limit, so reuse it and say so). Preview at
`?preview_theme_id=<id>`, including `robots.txt?preview_theme_id=<id>`. Publishing is a separate op
with its own ticket and second confirmation; it records `previous_live_id` first. `--live` /
`--allow-live` are never used.

Admin API writes have no staging surface: they are live on apply. Print the query, the variables and
the `before` values, then ask.

## 8. Verification

Snapshot the `preview_url` (or the live URL for Admin writes) and re-run the module scripts. Shopify
serves theme assets and pages through its CDN: when the fetched HTML still shows the old value but
the theme file contains the new one, answer `pending_cache`, never `pass`. Admin SEO fields are
verified by re-querying the resource **and** by a public snapshot — the storefront can lag.

## 9. Rollback

Theme: delete only the staging themes recorded in the run manifest, or republish `previous_live_id`.
The full pre-edit copy of the pulled theme lives under the run's backup directory. Admin: restore the
`before` values with the same mutation; `urlRedirectDelete` removes a created redirect.
Not recoverable: a published theme's editor state after a merchant edits it post-publish.

## 10. Check ids

Unlocked by this card:

- `M2.shopify.collection_path_duplicate` — fail · 4 · search · established · auto(theme)
- `M2.shopify.variant_param_canonical` — fail · 3 · search · established · auto(theme)
- `M1.shopify.tag_combo_urls_crawlable` — warn · 3 · search · directional · auto(theme)
- `M1.shopify.filter_sort_urls_crawlable` — warn · 2 · search · directional · proposed
- `M1.shopify.robots_liquid_drops_defaults` — `needs_api` only, until the theme sources are readable:
  the audit cannot see `templates/robots.txt.liquid` from the storefront. When robots.txt *was*
  parsed, the observable symptoms of a dropped `{% for group in robots.default_groups %}` loop are
  reported as `M1.shopify.tag_combo_urls_crawlable` and `M1.shopify.filter_sort_urls_crawlable`
  instead — there is no observable `warn` variant of this id.
- `M2.shopify.collections_all_indexable` — warn · 1 · search · directional · advisory
- `M20.shopify.duplicate_hreflang` — fail · 3 · search · established · proposed(theme)
- `M5.shopify.theme_jsonld_gaps` — warn · 3 · both · established · proposed(theme). Judged per
  DECLARATION, and a ProductGroup is judged together with its `hasVariant` entries: the group carries
  brand, the variants carry sku/gtin and the variant URLs, and Google documents the inheritance.
- `M5.shopify.duplicate_product_jsonld` — warn · 3 · both · established · proposed. Counts declared
  Product/ProductGroup nodes only (`lib/jsonld.mjs` `classifyProductNodes`): variant members, review
  back-references and url-only stubs are pointers at one product, not extra Product blocks.
- `M7.shopify.description_is_body_fallback` — warn · 2 · search · directional · proposed(admin)

Not implemented: `M2.shopify.seo_hidden_detected`. From the storefront, a resource hidden with the
`seo.hidden` metafield is indistinguishable from any other `noindex`, so claiming the metafield as
the cause would be a guess; the noindex itself is reported by the generic M2 indexability ids. The id
is deliberately absent from `check.ids[]`, so `knownIds()` stays an inventory of what the registry
can actually produce.

Suppressed: `M17.shopify.sitemap_platform_owned` (`not_applicable`, owner Shopify) replaces every
M17 sitemap fix. Theme-duplicate hreflang aside, M20 fixes are `not_applicable` too.

## 11. Manual paths (EN / ES)

- SEO title & description — EN: Admin → Products → *product* → Search engine listing → Edit.
  ES: Panel → Productos → *producto* → Vista previa del motor de búsqueda → Editar.
- Redirect — EN: Admin → Content → Menus → URL redirects → Create.
  ES: Panel → Contenido → Menús → Redirecciones de URL → Crear.
- Hide from search — EN: set the resource's `seo.hidden` metafield to 1 (products: Shopify
  recommends the Unlisted status instead). ES: define el metacampo `seo.hidden` en 1 (en productos,
  Shopify recomienda el estado *No listado*).
- Markets / hreflang — EN: Settings → Markets. ES: Configuración → Mercados.
- Theme file — EN: Online Store → Themes → … → Edit code. ES: Tienda online → Temas → … → Editar código.

## 12. Honesty & UNVERIFIED

- `pageUpdate` / `articleUpdate` `seo` input and the exact scopes they need: **UNVERIFIED**. Confirm
  against the 2026-07 schema (`@shopify/dev-mcp`) before writing pages or articles.
- The 20-theme limit is a store limit; treat "how many themes are left" as a `capabilities` question,
  not an assumption.
- The API version `2026-07` is pinned in one constant. Re-check it quarterly.
- `/.well-known/ucp` and `/sitemap_agentic_discovery.xml` exist only when the merchant has enabled
  the corresponding surface. Their absence is reported (M21, weight 0), never scored.
- Interactive `shopify` login cannot be completed inside a subagent: require a Theme Access token, or
  a login already performed in the user's own shell.
- Password-protected storefronts return the password page — the audit is `needs_api`, not a pass.

# Platforms

`claude-seo-ai` audits any site the same way — one deterministic acquisition layer, one checks
registry, two scores. What changes per platform is **what it already generates for you**, **what it
refuses to let anyone change**, and **whether a fix can be written back at all**.

This document is the user-facing map of that. The agent-facing version is one card per platform in
[`references/platforms/`](../../references/platforms/), and the machine-readable version is
`profile.json`, written into every run by `scripts/detect-platform.mjs`.

## The detector

Four **independent** layers are scored, so a headless WordPress behind Next.js resolves as both
instead of one shadowing the other:

| Layer | Ids it can return |
|---|---|
| `platform` | `shopify`, `wordpress`, `wix`, `squarespace`, `webflow`, `framer`, `ghost`, `hubspot`, `bigcommerce`, `magento`, `drupal`, `payload` |
| `framework` | `nextjs`, `nuxt`, `astro`, `sveltekit`, `react-router`, `gatsby`, `hugo`, `jekyll`, `eleventy`, `docusaurus`, `static` |
| `plugins` | `woocommerce`, `yoast`, `rankmath`, `aioseo`, `seopress` |
| `hosting` | `vercel`, `netlify`, `github-pages`, `cloudflare-pages`, `cloudflare`, `wpengine`, `shopify` |

Everything is evidence-based: every verdict carries the signals that produced it, and a layer with
too little evidence is **omitted rather than guessed**. An unknown platform is `null`, never
"probably WordPress".

```bash
# From a persisted run (no extra network)
node scripts/detect-platform.mjs --snapshot <run>/pages/<slug>.json

# Live, plus the four opt-in endpoint probes (/wp-json/, /.well-known/ucp, /products.json, /wp-sitemap.xml)
node scripts/detect-platform.mjs --url https://example.com --probe

# From a checked-out project (the only way repo/package signals are consulted)
node scripts/detect-platform.mjs --path ./my-site
```

`--path` is also what upgrades a verdict: Payload, for instance, is detectable only from the repo —
audited by URL alone the profile honestly says `nextjs` and stops there.

## Support matrix

**Status** is the header of each platform's knowledge card: `stable` = the write path has been
exercised end to end and has a rollback · `beta` = the write path is implemented but thinly
exercised, so changes stay PROPOSED · `instructions-only` = no write API exists and every fix is a
click-path for a human.

**Extra checks** counts the platform-conditional finding ids the registry adds on top of the 119
platform-neutral ones. They are deliberately absent from the per-module findings tables — a
WordPress id is noise on a Shopify audit — so their index is
[`references/routing.md`](../../references/routing.md).

### Platform layer

| Platform | Detected | Extra checks | Apply method | Preview/staging | Credentials | Status |
|---|---|---|---|---|---|---|
| **Shopify** | yes | 11 (M1, M2, M5, M7, M17, M20) | `shopify-theme` (Shopify CLI) + `shopify-admin` (Admin GraphQL) | theme → **unpublished** theme, previewed with `?preview_theme_id=`; Admin API has none | `SHOPIFY_STORE`, `SHOPIFY_THEME_TOKEN`, `SHOPIFY_ADMIN_TOKEN` | beta |
| **WordPress** | yes | 10 (M1, M2, M5, M7, M17) | `wordpress-rest` (Application Passwords) or `wordpress-wpcli` (SSH) | none — live on apply | `WP_URL`, `WP_USER`, `WP_APP_PASSWORD` · or `WP_SSH` | beta |
| **WooCommerce** | yes (plugin layer) | via WordPress | same as WordPress | none | same as WordPress | beta |
| **Webflow** | yes | — | `page-api` (Data API v2) | **staged** — writes land unpublished; `publish` is its own op | `WEBFLOW_TOKEN`, `WEBFLOW_SITE_ID` | beta |
| **HubSpot** | yes | — | `page-api` (CMS API v3) | **staged** — draft `PATCH`, separate push-live | `HUBSPOT_TOKEN` | beta |
| **Ghost** | yes | — | `page-api` (Admin API) | drafts stay drafts (`live_impact: none`); a published post changes live | `GHOST_URL`, `GHOST_ADMIN_KEY` | beta |
| **Wix** | yes | — | `page-api` (Item SEO Tags) | none you can rely on — static pages need `publish: true`, dynamic items apply at once | `WIX_API_KEY`, `WIX_SITE_ID` | beta |
| **BigCommerce** | yes | — | `page-api` (Catalog/Content API) | none for catalog fields — live on write | `BIGCOMMERCE_STORE_HASH`, `BIGCOMMERCE_TOKEN` | beta |
| **Payload** | repo only | — | `local-files` for the Next.js routes; document fields are **not written** | drafts when the collection enables them | — | beta |
| **Squarespace** | yes | — | `instructions` | the user's own draft/publish flow | none | instructions-only |
| **Framer** | yes | — | `instructions` | the user's own publish flow | none | instructions-only |
| **Magento** | yes | — | `instructions` (+ `local-files` with a checkout) | operator's cache flush / static-content deploy | none | instructions-only |
| **Drupal** | yes | — | `instructions` (+ `local-files` with a checkout) | operator's revision + cache rebuild | none | instructions-only |

### Framework layer (source-tree fixes)

Every framework below is fixed the same way — `local-files` edits the **source**, no credentials,
nothing goes live until the user (or CI) deploys. Without `--project <dir>` there is no source tree
to edit, so the profile offers `instructions` instead.

| Framework | Detected | Extra checks | Apply method | Preview/staging | Credentials | Status |
|---|---|---|---|---|---|---|
| **Next.js** | yes | 3 (`M1.nextjs.robots_conflict`, `M7.nextjs.metadata_base_missing`, `M17.nextjs.sitemap_missing_source`) | `local-files` | none — a file edit; the deploy publishes it | — | beta |
| **Nuxt** | yes | 1 (`M17.nuxt.site_url_missing`) | `local-files` | none | — | beta |
| **Astro** | yes | 1 (`M17.astro.site_missing`) | `local-files` | none | — | beta |
| **Gatsby** | yes | 2 (`M17.gatsby.site_url_missing`, `M7.gatsby.head_in_non_page`) | `local-files` | none | — | beta |
| **Hugo** | yes | 1 (`M17.hugo.baseurl_missing`) | `local-files` | none | — | beta |
| **Jekyll** | yes | 1 (`M7.jekyll.seo_tag_present`) | `local-files` | none | — | beta |
| **React Router** | yes | 1 (`M7.react_router.meta_replaces_parent`) | `local-files` | none | — | beta |
| **SvelteKit** | yes | — | `local-files` | none | — | beta |
| **Eleventy** | yes | — | `local-files` | none | — | beta |
| **Docusaurus** | yes | — | `local-files` | none | — | beta |
| **Plain static** | yes | 1 (`M22.static.not_checkable`) | `local-files` (`/<path>/` → `<root>/<path>/index.html`) | none | — | **stable** |

Anything the detector cannot name still gets a full audit. It simply routes every fix to
`instructions`, which is a real outcome — the exact snippet and the file or panel it belongs in —
not a failure.

## What never goes live by default

This is the promise the fix flow keeps on every platform, and it is enforced by the adapters, not by
prose:

- **Dry-run is the posture.** `fix` runs `capabilities`, `plan`, `preview` and `verify` — all
  read-only. `apply`, `publish` and `rollback` belong to the single writer subagent and each needs a
  confirmation ticket issued in the same turn as your yes.
- **Shopify** pushes to an **unpublished** theme (one reusable `claude-seo-ai <date>` staging theme;
  stores have a 20-theme limit, so it is reused and said so). `shopify theme push` carrying a live
  flag (`--allow-live`, `--live`, `--publish`, `-a`, `-l`, `-p`) is a **hard deny** in the
  `guard-bash` hook — no ticket unlocks it. Publishing is a separate op with its own second
  confirmation, and it records `previous_live_id` first so a rollback can republish the old theme.
- **Webflow** writes land in the project's unpublished state; `publish` is a separate ticketed op.
  `verify` on a staged change says *"saved, not published"* rather than claiming the page is fixed.
- **HubSpot** patches the page **draft**; push-live is its own op. `--live` switches to the direct
  patch and the preview says so before you are asked.
- **Ghost** never sends `status`, `html`, `lexical` or the post title — changing metadata must never
  publish a draft or touch the body. Updating a draft is `live_impact: none`.
- **WordPress** never touches `status` or post content; only SEO fields and options.
- **Wix** and **BigCommerce** have no reliable staging surface, so their changes are badged
  **`[LIVE]`** in the preview and you are told that before you confirm, not after.
- **Local files** are backed up byte-for-byte to `<DATA>/backups/<run-id>/<relpath>` before the first
  modification, and inside Claude Code the writer applies the diff with Edit/Write so you get the
  native diff prompt and the `guard-write` hook. The adapter's own `apply` exists for `--yes`/CI runs
  and refuses any path that escapes `--project`.

Every change carries a `live_impact` of `none` (a file or a staged theme), `staged` (written to a
draft surface, invisible to visitors) or `live` (visible immediately), and the preview badges it
`[none]` / `[staged]` / `[LIVE]`. A confirmation that does not name the impact is not a valid
confirmation.

## Credentials

Credentials are **environment-only**. They never appear in `argv`, never in the append-only fix log
(commands there are redacted), and never in a file inside your repository. A missing key is named by
its key name — the tool asks you to set it, never to paste a value into the chat.

Two ways to provide them:

1. **`/plugin`** → claude-seo-ai → the plugin's `userConfig` prompts. Claude Code exports each one as
   `CLAUDE_PLUGIN_OPTION_<KEY>`, which the adapters read first.
2. **Your shell**, before starting Claude Code: `export SHOPIFY_ADMIN_TOKEN=…`. The adapters fall
   back to the bare `<KEY>` name.

A few longer spellings from an earlier build (`WORDPRESS_URL`, `SHOPIFY_CLI_THEME_TOKEN`,
`GHOST_ADMIN_API_KEY`, `HUBSPOT_ACCESS_TOKEN`, `BIGCOMMERCE_ACCESS_TOKEN`, …) still resolve as
aliases; the catalog name above wins.

A missing key **downgrades that target to `instructions`**. It never fails the run, and it is never
silently dropped from the plan summary.

### Shopify — custom app + Theme Access

Two separate credentials, because they are two separate write paths. Create both in your Shopify
admin; the vendor's current menu path is in Shopify's own documentation, and the values are what
matter here.

1. **Admin API** — a **custom app** whose Admin API access token goes into `SHOPIFY_ADMIN_TOKEN`. It
   is sent as the `X-Shopify-Access-Token` header against
   `https://<store>/admin/api/2026-07/graphql.json`. Scopes: `write_products` for product and
   collection SEO, `write_online_store_navigation` for `urlRedirectCreate`. Page and article scopes
   are **UNVERIFIED** in this build (see the table at the end).
2. **Theme Access** — a **Theme Access** password for the theme you want to work on. That value is
   `SHOPIFY_THEME_TOKEN`; it reaches the Shopify CLI through the child process environment as
   `SHOPIFY_CLI_THEME_TOKEN`, never on a command line.
3. `SHOPIFY_STORE` is the `my-store.myshopify.com` domain (also exported to the CLI as
   `SHOPIFY_FLAG_STORE`).

The `shopify` CLI must be on `PATH` for the theme adapter. Interactive `shopify` login cannot be
completed inside a subagent — use a Theme Access token, or log in yourself in the shell that starts
Claude Code.

> There is no official Shopify MCP that writes. [`@shopify/dev-mcp`](../../.mcp.json.example) is a
> docs/schema oracle: use it to confirm a field exists in the pinned API version, never as a write
> path. The adapters do not require it.

### WordPress — application passwords

WordPress admin → **Users → Profile → Application Passwords** → name it → generate. Spaces in the
generated value are preserved; it is never your account password.

```bash
export WP_URL="https://example.com"     # https only — Basic auth over http puts the password on the wire
export WP_USER="editor-account"
export WP_APP_PASSWORD="abcd efgh ijkl mnop qrst uvwx"
```

Some hosts disable Application Passwords entirely. That is a `needs_api`, not a failure to try
harder — set `WP_SSH="user@host:/path/to/wordpress"` instead and the `wordpress-wpcli` adapter takes
over (needs `wp` and `ssh` on `PATH`; every command is printed before it runs).

### Webflow

A **site API token** with the `pages:write` scope, used against the Data API v2
(`PUT /v2/pages/{page_id}`).

```bash
export WEBFLOW_TOKEN="…"          # sent as a Bearer token
export WEBFLOW_SITE_ID="…"        # also readable from the page markup as data-wf-site
```

Page ids come from the site's page list, not from the URL.

### Wix

An **API key** with the permissions for item SEO tags, plus the site id.

```bash
export WIX_API_KEY="…"            # sent as the Authorization header
export WIX_SITE_ID="…"            # sent as the wix-site-id header
```

Two Wix specifics worth knowing before you confirm anything: **tags replace in full**, so every write
is read → merge → write-the-whole-set (a partial payload deletes the tags it omits, and the captured
set *is* the rollback); and item type and item id cannot be derived from a URL, so they come from
`--answers`:

```json
{"resources": {"https://site/page": {"itemType": "STATIC_PAGE", "itemId": "…"}}}
```

Nothing is invented when they are absent.

### Ghost

An **Admin API key** from a custom integration, in the `<id>:<hex secret>` form, plus the site URL
(the Admin API lives under `/ghost/api/admin/`).

```bash
export GHOST_URL="https://blog.example.com"
export GHOST_ADMIN_KEY="6…:9…"
```

The secret signs a short-lived JWT locally with `node:crypto` and never leaves the machine. A post
update must carry the post's current `updated_at` — Ghost uses it for collision detection — so the
adapter re-reads the post right before writing and refuses when it no longer matches the plan.

### HubSpot

A **private app token** with the CMS scopes.

```bash
export HUBSPOT_TOKEN="…"          # sent as a Bearer token
```

Page ids come from the pages listing, not from the URL. Blog posts live on a different endpoint from
site pages; one payload does not work for both.

### BigCommerce

A **store-scoped API account token** with the catalog and content scopes, plus the store hash from
the API base path.

```bash
export BIGCOMMERCE_STORE_HASH="abc123"
export BIGCOMMERCE_TOKEN="…"      # sent as X-Auth-Token
```

Writes are channel-aware. Confirm which channel the audited storefront belongs to before writing, or
a change can land on a channel nobody is looking at. BigCommerce also caps `page_title` at 70
characters and `meta_description` at 160 and rejects anything longer, so a too-long value is
truncated **at a word boundary** and the preview says it was truncated and by how much.

### PageSpeed Insights (any platform)

`PSI_API_KEY` is the one credential that has nothing to do with writing — it raises the PSI quota for
field Core Web Vitals. There is deliberately **no `--key` flag**: a secret on a command line lands in
`ps`, in shell history and in every command log, and these scripts print the command to re-run.

## Quick starts

Every flow is the same three steps — audit, plan, confirm — with a different `--target`.

### Shopify store

```bash
# 1. Audit (read-only). The profile detects shopify and fills write_targets.
/claude-seo-ai:audit https://my-store.com --pages 12

# 2. Preview the fix plan. Nothing is written; theme changes are staged by construction.
/claude-seo-ai:fix https://my-store.com --target shopify --dry-run

# 3. Confirm the changes you want. Publishing the staging theme is a separate second confirmation.
/claude-seo-ai:fix https://my-store.com --target shopify
```

Under the hood: `shopify theme pull` → edit → `shopify theme check --fail-level error` (an error
there blocks apply) → `shopify theme push --unpublished`. Admin GraphQL writes
(`productUpdate(input: { seo: … })`, `urlRedirectCreate`) have no staging surface — the preview
prints the query, the variables and the `before` values, then asks.

### WordPress site

```bash
/claude-seo-ai:audit https://example.com --pages 12
/claude-seo-ai:fix   https://example.com --target wordpress --dry-run
/claude-seo-ai:fix   https://example.com --target wordpress
```

REST is preferred when `WP_URL` / `WP_USER` / `WP_APP_PASSWORD` are present; WP-CLI takes over when
only `WP_SSH` is. `before` is captured from `GET /wp/v2/posts/<id>?context=edit` and shown next to
the proposed value. If the site has a staging environment, run the whole flow there and promote with
your host's own tooling.

### Next.js (or any framework) repository

```bash
# Audit the built output or the running dev server
/claude-seo-ai:audit http://localhost:3000 --pages 8

# Fix the *source*, verified against the dev server
/claude-seo-ai:fix http://localhost:3000 --project . --dev-url http://localhost:3000 --dry-run
```

The audit may have run against `localhost:3000` or built HTML while the fix edits **source** through
the route map (`app/(group)/[slug]/page.tsx` → the route it serves). `--dev-url` re-fetches the
running dev server to verify. The report says which of the three it verified — a green diff is not a
fixed site until you deploy.

Only the `html-head`, `front-matter`, `config-file` and `liquid` insertion strategies can produce
AUTO changes. Every JSX/TS strategy (`metadata-object` without a literal anchor, `next-head-jsx`
create, `use-seo-meta`, `svelte-head`, `meta-export-array`, `gatsby-head-export`) is PROPOSED and
left for the writer's Edit — nothing here regex-rewrites JSX.

### Webflow / Wix / Ghost / HubSpot / BigCommerce

```bash
/claude-seo-ai:audit https://example.com
/claude-seo-ai:fix   https://example.com --target webflow --dry-run   # or wix | ghost | hubspot | bigcommerce
```

Each provider name expands to the `page-api` adapter with that provider selected. Without its key the
target downgrades to `instructions` and you get the exact click path with the values already filled
in.

### Squarespace / Framer / anything unknown

```bash
/claude-seo-ai:audit https://example.com
/claude-seo-ai:fix   https://example.com --target instructions --lang en
```

`instructions` renders the panel path and the exact value to paste, in `--lang en|es`. That is the
honest outcome for a platform with no SEO write API — claiming otherwise would invent a capability.

## UNVERIFIED — what this build does not claim

Each knowledge card ends with a §12 listing what could not be confirmed against official vendor
documentation. Anything marked there is **not written**: the adapter reports `needs_api` or plans the
change as `skipped_unready` with the payload printed for a human to check. The current list:

| Platform | Not verified in this build |
|---|---|
| **Shopify** | `pageUpdate` / `articleUpdate` `seo` input and the scopes they need — confirm against the pinned `2026-07` schema before writing pages or articles. The API version lives in one constant; re-check quarterly. |
| **WordPress** | `blog_public` over the REST settings endpoint (WP-CLI only until confirmed); the `wp_attachment_pages_enabled` option name; SEOPress `title-description-metas` on the free tier; AIOSEO REST writes without Pro; the SEOPress sitemap path. |
| **Webflow** | The field names inside `openGraph`, and the custom-code API's request shape. OG fields are sent only when a finding supplies them and the preview says they are unverified; custom code, redirects and staging-indexing are not written at all. |
| **Wix** | The endpoint path, request body and publish semantics of the Item SEO Tags API. `capabilities` probes it; until the probe answers, every change is planned `skipped_unready` with the payload shown. |
| **Ghost** | The Admin API version path and the JWT signing dance. |
| **HubSpot** | The draft→live push path segment and the `headHtml` field name — head HTML is not written. |
| **BigCommerce** | The catalog/content endpoint paths and the channel-assignment payload. Also the `SHOP_SESSION_TOKEN` cookie and the `stencil-utils` marker, which are observed rather than documented (detection never rests on either alone). |
| **Payload** | `@payloadcms/plugin-seo` field names and the REST payload shape. |
| **Magento** | Every REST endpoint and attribute code for SEO fields. Nothing is written. |
| **Drupal** | JSON:API field names for Metatag, and which SEO modules are installed (unreadable from HTML alone). Nothing is written. |
| **Squarespace** | No SEO-tag write API we can cite exists. The status stays `instructions-only`. |
| **Framer** | No public SEO write API is documented. The status stays `instructions-only`. |

Two related honesty rules that apply everywhere: a password-protected storefront returns the password
page, so the audit is `needs_api`, not a pass; and a plugin that is active but configured to output
nothing looks identical to no plugin from the outside — the missing title is the finding, not the
plugin id.

## See also

- [`docs/en/usage.md`](usage.md) — the five commands and their real flags.
- [`docs/en/architecture.md`](architecture.md) — how the profile, the adapters and the guards fit
  together.
- [`references/platforms/README.md`](../../references/platforms/README.md) — the 12-section card
  template, if you want to add a platform.

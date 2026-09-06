# wordpress

**Status:** beta · **Last verified:** 2026-09-05 · **Detector id:** `wordpress` · **Layer:** platform

WordPress core generates a modest amount of SEO output; an SEO plugin, when present, takes the whole
head away from the theme. Which plugin it is decides whether a fix is a REST write, a WP-CLI command,
or a click-path. Read `woocommerce.md` alongside this card when WooCommerce is detected, and the
framework card instead of §5 when `capabilities.head_owner = framework` (headless).

## 1. Detection recap

`<link rel="https://api.w.org/">` or the equivalent `Link` header (5), `x-powered-by: WordPress VIP`
(5), `x-pingback` (3), `/wp-content/` and `/wp-includes/` asset paths (4 each), the generator meta
(4), `<link rel="alternate" type="application/json" href=…/wp/v2/posts/<id>>` (4 — it also yields the
post id), `wp-block-` classes (2); with `--probe`, `/wp-json/` returning `namespaces[]` (5) and
`/wp-sitemap.xml` (2); with `--path`, `wp-config.php` (5) and `wp-content/themes/` (4).

**The `/wp-json/` namespace list is the reliable plugin signal.** HTML comment sniffing finds a
plugin that printed a comment; the namespace list finds a plugin that is actually active. Run the
detector with `--probe` before trusting a plugin verdict, and say so when you could not.

`theme.json` plus `templates/*.html` in the project means a **block theme**: there is no `header.php`,
so head edits go through `wp_head` or the SEO plugin.

## 2. Generated automatically — do not re-add

- `<title>` (core title tag support), and the singular canonical link.
- `wp_robots` output, including `noindex` on search results and, when `blog_public = 0`,
  a site-wide `noindex` **and** a `Disallow: /` in the virtual robots.txt.
- `/wp-sitemap.xml` (core), unless a plugin replaces it.
- The REST discovery links, RSS/Atom feed links, oEmbed links, and the shortlink.
- With an SEO plugin active: title, meta description, canonical, robots meta, Open Graph, Twitter
  cards, the JSON-LD graph and the XML sitemap. **All of it.**

## 3. URL surfaces & duplicate risks

| Surface | Shape | Risk |
|---|---|---|
| Comment reply | `?replytocom=<id>` | Crawlable duplicate of the post |
| Attachment pages | `/<post>/<image-slug>/` | Thin duplicates; controlled by `wp_attachment_pages_enabled` (UNVERIFIED name) |
| Date archives | `/2026/01/`, `/2026/01/14/` | Thin, often indexable |
| Author archives | `/author/<name>/` | Thin on single-author sites |
| Tag / category archives | `/tag/<t>/`, `/category/<c>/` | Thin when a tag has one post |
| Search | `?s=<q>` | Core sets noindex; still crawlable |
| Paged archives | `/page/2/` | Fine; canonical must stay self-referential |
| Sitemaps | `/wp-sitemap.xml` (core) vs `/sitemap_index.xml` (Yoast, Rank Math) vs `/sitemap.xml` (AIOSEO) vs `/sitemaps.xml` (SEOPress, UNVERIFIED) | Both answering 200 is a duplicate-source problem |

robots.txt is **virtual** — generated through the `robots_txt` filter — unless a physical file exists
at the web root, in which case the file silently wins and every plugin robots editor becomes a
no-op that still looks like it saved.

## 4. Platform-owned — do not fix

| Thing | Owner | Where a human changes it |
|---|---|---|
| The whole head (title/description/canonical/robots/OG/JSON-LD/sitemap) when an SEO plugin is active | The plugin | The plugin's own fields |
| `/wp-sitemap.xml` contents | Core | Not directly editable; disable it if the plugin owns sitemaps |
| Permalink structure | Core | Settings → Permalinks (changing it moves every URL — advisory only) |
| Feed markup | Core | — |
| Theme markup on a block theme | The block theme | Site Editor |

Never inject head tags or JSON-LD into a theme when `capabilities.head_owner = seo-plugin`: the
plugin will emit its own next to yours and you have manufactured a duplicate. Emit those findings as
`not_applicable` with the plugin named in `evidence.observed`.

## 5. Fix map

| Class | Location | Adapter | Class | live_impact |
|---|---|---|---|---|
| Post/page title, excerpt, slug | `POST /wp/v2/posts/<id>` (`title`, `excerpt`, `slug`) | `wordpress-rest` | PROPOSED | **live** |
| SEO title/description — AIOSEO | `aioseo_meta_data { title, description }` on the post resource (free since 4.9.8) | `wordpress-rest` | PROPOSED | **live** |
| SEO title/description — SEOPress | `PUT /seopress/v1/posts/<id>/title-description-metas` | `wordpress-rest` | PROPOSED | **live** |
| SEO title/description — Yoast | read-only over REST (`yoast_head_json`); needs a `register_post_meta(… show_in_rest)` shim, else WP-CLI | `wordpress-wpcli` | PROPOSED | **live** |
| SEO title/description — Rank Math | `rank_math_*` meta needs a `show_in_rest` shim, else WP-CLI | `wordpress-wpcli` | PROPOSED | **live** |
| Universal meta fallback | `wp post meta update <id> _yoast_wpseo_title "<v>"` over SSH | `wordpress-wpcli` | PROPOSED | **live** |
| Image alt text | `POST /wp/v2/media/<id>` (`alt_text`) | `wordpress-rest` | PROPOSED | **live** |
| Site-wide noindex off | `wp option update blog_public 1` (REST settings `blog_public` UNVERIFIED) | `wordpress-wpcli` | PROPOSED | **live** |
| Attachment pages off | option toggle (name UNVERIFIED) | `wordpress-wpcli` | PROPOSED | **live** |
| Head tags / JSON-LD, classic theme **without** an SEO plugin and with the project checked out | `header.php`, `functions.php` (`wp_head`) | `local-files` | AUTO | none |
| Thin archives, `?replytocom=`, duplicate sitemaps, physical robots.txt | — | — | ADVISORY | none |

`status` and `content` are never sent. A REST write that includes them can publish a draft or
overwrite a post body — the adapter's payload builder must refuse both keys.

## 6. Write method & credentials

REST: Application Passwords over HTTPS Basic auth. Credential key names: `WP_URL`, `WP_USER`,
`WP_APP_PASSWORD` (the longer `WORDPRESS_*` spellings still resolve). Some hosts disable Application
Passwords entirely — that is a `needs_api`, not a failure to try harder.

WP-CLI: `WP_SSH` (an ssh target), with `wp` and `ssh` on PATH. Every command is printed
before it runs.

Official MCP: `WordPress/mcp-adapter` (Abilities API). `Automattic/wordpress-mcp` is deprecated. A
WordPress.com connector also exists. None of them is assumed present — the profile's `write_targets`
say what is actually ready.

## 7. Preview & publish

There is no staging surface: REST and WP-CLI writes are live on apply. Capture `before` from
`GET /wp/v2/posts/<id>?context=edit` (which requires the authenticated user) and show it next to the
proposed value. On a site with a staging environment, prefer running the whole flow there and
promoting through the host's own tooling.

## 8. Verification

Re-fetch the post over REST **and** snapshot the public URL. Page caching (host-level, or a caching
plugin) routinely serves the old head for minutes: when REST shows the new value and the public HTML
shows the old one, answer `pending_cache`. When an SEO plugin owns the head, verify the plugin's
field, not the raw post meta.

## 9. Rollback

Restore the `before` values through the same route (REST field, or `wp post meta update`).
`wp option update blog_public 0` restores a site-wide noindex. Not recoverable: anything a plugin
regenerated as a side effect (sitemap caches, schema caches) — those rebuild on their own.

## 10. Check ids

Unlocked by this card:

- `M17.wordpress.duplicate_sitemaps` — warn · 3 · search · established · advisory, when two DIFFERENT
  documents both serve a usable sitemap and their URL sets differ (`directional` when only one of the
  two URL lists was collected). A legacy path that redirects onto the plugin sitemap, or a second path
  serving the same URL set, is one source under two names and is reported `pass`.
- `M17.wordpress.no_sitemap_any` — fail · 3 · search · established · advisory
- `M2.wordpress.blog_public_off` — fail · 5 · search · established · proposed(wpcli)
- `M1.wordpress.replytocom_crawlable` — warn · 1 · search · directional · advisory
- `M2.wordpress.attachment_pages_indexable` — warn · 2 · search · directional · proposed
- `M2.wordpress.thin_archives_indexable` — warn · 2 · search · directional · advisory
- `M1.wordpress.physical_robots_shadowing` — warn · 2 · search · established · advisory; `needs_api` without local or SSH access
- `M5.wordpress.plugin_schema_incomplete` — warn · 3 · both · established · advisory
- `M5.wordpress.duplicate_schema_sources` — warn · 3 · both · established · advisory (theme **and** plugin both emit Organization)

Suppressed: `M7.wordpress.plugin_owned_head` (`not_applicable`, owner = the detected plugin) — every
M7 AUTO head fix becomes a plugin-field PROPOSED write instead.

## 11. Manual paths (EN / ES)

- SEO title & description — EN: Posts → *post* → the SEO plugin's box below the editor → Edit
  snippet. ES: Entradas → *entrada* → el cuadro del plugin SEO debajo del editor → Editar fragmento.
- Site visibility — EN: Settings → Reading → uncheck "Discourage search engines…".
  ES: Ajustes → Lectura → desmarcar «Disuade a los motores de búsqueda…».
- robots.txt — EN: the plugin's tools/file editor; delete a physical `robots.txt` at the web root
  first, or the editor does nothing. ES: el editor de archivos del plugin; borra antes un
  `robots.txt` físico en la raíz o el editor no tendrá efecto.
- Image alt — EN: Media → *image* → Alternative Text. ES: Medios → *imagen* → Texto alternativo.
- Permalinks — EN: Settings → Permalinks (changing this moves every URL; plan redirects first).
  ES: Ajustes → Enlaces permanentes (cambia todas las URLs; planifica las redirecciones antes).

## 12. Honesty & UNVERIFIED

- `blog_public` exposed in the REST settings endpoint: **UNVERIFIED**. Until confirmed, the fix is
  WP-CLI only.
- `wp_attachment_pages_enabled` as the option name: **UNVERIFIED**.
- SEOPress's `title-description-metas` endpoint being available on the free tier: **UNVERIFIED**.
- AIOSEO write capability over REST without their Pro add-on: **UNVERIFIED** beyond the 4.9.8
  release note.
- SEOPress sitemap path `/sitemaps.xml`: **UNVERIFIED** — probe both it and `/sitemap.xml`.
- Without `--probe`, a plugin verdict rests on HTML comments and CSS class names. Say which evidence
  you had; do not upgrade a comment into a certainty.
- A plugin that is active but configured to output nothing looks identical to no plugin from the
  outside. When the head has no title/description at all, that is the finding — not the plugin id.

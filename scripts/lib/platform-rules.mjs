// Platform / framework / plugin / hosting detection rules for scripts/detect-platform.mjs.
//
// Four INDEPENDENT layers are scored, so a headless WordPress behind a Next.js front end
// resolves both (platform=wordpress, framework=nextjs) instead of one shadowing the other.
//
// A rule is `{ kind, match, weight }` plus optional refinements:
//   kind    header | cookie | generator | asset_host | path | dom | link_rel | probe | repo | pkg
//   match   string (case-insensitive substring / exact name, depending on the kind) or RegExp
//   weight  1-5   5 vendor-proprietary and not reproducible by accident (own header, own config file)
//                 4 vendor-owned host, global, cookie or generator string
//                 3 strong path / markup convention
//                 2 weak convention, shared with look-alikes
//                 1 corroborating only
//   value   RegExp applied to the matched header/probe body (header and probe kinds)
//   scope   'page' restricts an asset_host/path rule to the audited page's own host/URL
//   note    short provenance string; "UNVERIFIED" marks a signal not confirmed against vendor docs
//
// Haystacks per kind: header -> response headers · cookie -> Set-Cookie names · generator ->
// <meta name="generator"> · asset_host -> the page host plus every host in src/href/srcset/content
// · path -> the path+query of every such URL (page URL included) · dom -> the raw HTML · link_rel ->
// every raw <link> tag plus the Link response header · probe -> a supplied probe body · repo ->
// project-relative file paths · pkg -> package.json dependency names.
//
// Nothing here fetches. `repo`/`pkg` rules only ever fire when the caller passed a project path;
// `probe` rules only when a probe result was supplied (CLI `--probe`, or `--probes <json>`).

/** Confidence bands shared by every layer: high >= 8 with >= 2 signal kinds, medium >= 5, low >= 2. */
export function confidenceOf(score, kindCount) {
  if (score >= 8 && kindCount >= 2) return 'high';
  if (score >= 5) return 'medium';
  if (score >= 2) return 'low';
  return null;
}

export const CONFIDENCE_ORDER = Object.freeze({ high: 3, medium: 2, low: 1 });

const R = (kind, match, weight, extra) => ({ kind, match, weight, ...(extra || {}) });

// ---------------------------------------------------------------------------
// Layer 1 — platform (the system that owns the pages)

export const PLATFORM_RULES = Object.freeze({
  shopify: [
    R('header', 'x-shopid', 5),
    R('header', 'x-shopify-stage', 5),
    R('cookie', /^(_shopify_[ysd]|_shopify_sa_[pt]|_secure_session_id)$/i, 4),
    R('asset_host', 'cdn.shopify.com', 4),
    R('path', '/cdn/shop/', 3),
    R('dom', /Shopify\.theme\s*=/, 4),
    R('dom', /id=["']shopify-section-/, 3),
    R('dom', /window\.ShopifyAnalytics/, 3),
    R('probe', '/.well-known/ucp', 3, { value: /"version"\s*:/ }),
    R('probe', '/products.json', 2, { value: /"products"\s*:/ }),
    R('repo', /^config\/settings_schema\.json$/, 5),
    R('repo', /^layout\/theme\.liquid$/, 5),
    R('pkg', '@shopify/hydrogen', 5),
  ],
  wordpress: [
    R('link_rel', /https:\/\/api\.w\.org\//, 5),
    R('header', 'x-powered-by', 5, { value: /WordPress\s*VIP/i }),
    R('header', 'x-pingback', 3),
    R('path', '/wp-content/', 4),
    R('path', '/wp-includes/', 4),
    R('generator', /WordPress/i, 4),
    R('link_rel', /\/wp\/v2\/posts\/(\d+)/, 4),
    R('dom', /\bwp-block-/, 2),
    R('probe', '/wp-json', 5, { value: /"namespaces"\s*:/ }),
    R('probe', '/wp-sitemap.xml', 2),
    R('repo', /^wp-config\.php$/, 5),
    R('repo', /^wp-content\/themes\//, 4),
  ],
  wix: [
    R('header', 'x-wix-request-id', 5),
    R('dom', /wixBiSession/, 4),
    R('asset_host', 'static.wixstatic.com', 4),
    R('asset_host', 'parastorage.com', 4),
    R('generator', /Wix\.com/i, 4),
  ],
  squarespace: [
    R('asset_host', 'static1.squarespace.com', 4),
    R('dom', /Static\.SQUARESPACE_CONTEXT/, 4),
    R('header', 'server', 4, { value: /Squarespace/i, note: 'UNVERIFIED: Server header value not confirmed against vendor docs' }),
    R('generator', /Squarespace/i, 4),
  ],
  webflow: [
    R('asset_host', 'website-files.com', 4),
    R('generator', /Webflow/i, 4),
    R('dom', /data-wf-site=["']([A-Za-z0-9]+)["']/, 4),
    R('dom', /data-wf-page=/, 2),
  ],
  framer: [
    R('asset_host', 'framerusercontent.com', 4),
    R('generator', /Framer/i, 4),
    R('dom', /__framer_events|data-framer-name=/, 2),
  ],
  ghost: [
    R('header', 'x-ghost-cache-status', 5),
    R('path', '/ghost/api/content/', 4),
    R('generator', /Ghost/i, 4),
    R('dom', /ghost-portal|data-ghost=/, 2),
  ],
  hubspot: [
    R('asset_host', 'js.hs-scripts.com', 4),
    R('path', '/_hcms/', 3),
    R('path', '/hs-fs/hubfs/', 3),
    R('cookie', /^(__hstc|hubspotutk)$/i, 4),
    R('generator', /HubSpot/i, 4),
  ],
  bigcommerce: [
    R('asset_host', 'cdn11.bigcommerce.com', 4),
    R('cookie', /^SHOP_SESSION_TOKEN$/i, 4, { note: 'UNVERIFIED: cookie name observed in the wild, not documented' }),
    R('dom', /stencil-utils|stencilBootstrap/, 2, { note: 'UNVERIFIED: Stencil bundle name' }),
    R('path', '/stencil/', 2),
  ],
  magento: [
    R('header', 'x-magento-*', 5),
    R('path', /\/static\/version\d+\/frontend\//, 4),
    R('cookie', /^form_key$/i, 2),
    R('dom', /Magento_[A-Z]|data-mage-init=|mage\/cookies/, 3),
  ],
  drupal: [
    R('header', 'x-generator', 5, { value: /Drupal/i }),
    R('header', 'x-drupal-cache', 5),
    R('header', 'x-drupal-dynamic-cache', 4),
    R('path', '/sites/default/files/', 4),
    R('generator', /Drupal/i, 4),
  ],
  payload: [
    R('repo', /^(src\/)?payload\.config\.(ts|js|mjs)$/, 5),
    R('pkg', 'payload', 4),
    R('pkg', '@payloadcms/plugin-seo', 3),
  ],
});

// ---------------------------------------------------------------------------
// Layer 2 — framework (the code that renders the head)

export const FRAMEWORK_RULES = Object.freeze({
  nextjs: [
    R('header', 'x-powered-by', 5, { value: /Next\.js/i }),
    R('path', '/_next/', 4),
    R('dom', /__NEXT_DATA__/, 4),
    R('dom', /self\.__next_f\.push/, 4),
    R('dom', /next-head-count/, 3),
    R('repo', /^(src\/)?next\.config\.(js|cjs|mjs|ts)$/, 5),
    R('pkg', 'next', 4),
  ],
  nuxt: [
    R('path', '/_nuxt/', 4),
    R('dom', /id=["']__nuxt["']/, 4),
    R('dom', /__NUXT_DATA__|window\.__NUXT__/, 4),
    R('generator', /Nuxt/i, 3),
    R('repo', /^nuxt\.config\.(js|mjs|ts)$/, 5),
    R('pkg', 'nuxt', 4),
  ],
  astro: [
    R('generator', /Astro/i, 4),
    R('dom', /<astro-island|<astro-slot|data-astro-/, 4),
    R('path', '/_astro/', 4),
    R('repo', /^astro\.config\.(js|cjs|mjs|ts)$/, 5),
    R('pkg', 'astro', 4),
  ],
  sveltekit: [
    R('path', '/_app/immutable/', 4),
    R('dom', /data-sveltekit-/, 3),
    R('dom', /__sveltekit_/, 3),
    R('repo', /^svelte\.config\.(js|cjs|mjs|ts)$/, 4),
    R('repo', /^src\/routes\//, 2),
    R('pkg', '@sveltejs/kit', 5),
  ],
  'react-router': [
    R('dom', /__remixContext/, 4),
    R('dom', /__reactRouterContext/, 4),
    R('repo', /^react-router\.config\.(js|mjs|ts)$/, 5),
    R('repo', /^remix\.config\.(js|mjs|ts)$/, 5),
    R('pkg', '@remix-run/react', 4),
    R('pkg', '@shopify/hydrogen', 5),
    R('pkg', 'react-router', 3),
  ],
  gatsby: [
    R('dom', /id=["']___gatsby["']/, 4),
    R('path', '/page-data/', 4),
    R('generator', /Gatsby/i, 4),
    R('repo', /^gatsby-config\.(js|mjs|ts)$/, 5),
    R('pkg', 'gatsby', 4),
  ],
  hugo: [
    R('generator', /Hugo/i, 4),
    R('repo', /^(hugo|config)\.(toml|yaml|yml|json)$/, 4),
    R('repo', /^config\/_default\//, 3),
    R('repo', /^archetypes\//, 2),
    R('repo', /^layouts\/(partials|_default)\//, 2),
  ],
  jekyll: [
    R('generator', /Jekyll/i, 4),
    R('dom', /Begin Jekyll SEO tag/i, 3),
    R('repo', /^_config\.yml$/, 4),
    R('repo', /^_posts\//, 3),
    R('repo', /^_layouts\//, 2),
  ],
  eleventy: [
    R('generator', /Eleventy/i, 4),
    R('repo', /^(\.eleventy|eleventy\.config)\.(js|cjs|mjs)$/, 5),
    R('pkg', '@11ty/eleventy', 5),
  ],
  docusaurus: [
    R('generator', /Docusaurus/i, 4),
    R('dom', /__docusaurus|docusaurus\.theme/, 3),
    R('repo', /^docusaurus\.config\.(js|cjs|mjs|ts)$/, 5),
    R('pkg', '@docusaurus/core', 5),
  ],
  // `static` is scored like the others but suppressed by detect() as soon as any build
  // framework clears `low` — "no build config" is the whole point of the classification.
  static: [
    R('repo', /^index\.html$/, 3),
    R('repo', /^[^/]+\/index\.html$/, 2),
    R('repo', /^(assets|css|js|img|images|styles)\//, 2),
  ],
});

/** Repo paths that disqualify `static`. */
export const BUILD_CONFIG_FILES = Object.freeze([
  /^(src\/)?next\.config\./, /^nuxt\.config\./, /^astro\.config\./, /^svelte\.config\./,
  /^gatsby-config\./, /^remix\.config\./, /^react-router\.config\./, /^docusaurus\.config\./,
  /^(\.eleventy|eleventy\.config)\./, /^_config\.yml$/, /^(hugo|config)\.(toml|yaml|yml|json)$/,
  /^vite\.config\./, /^webpack\.config\./, /^(src\/)?payload\.config\./, /^wp-config\.php$/,
]);

// ---------------------------------------------------------------------------
// Layer 3 — CMS plugins (WordPress SEO plugins + WooCommerce; they own the head)

export const PLUGIN_RULES = Object.freeze({
  woocommerce: [
    R('probe', '/wp-json', 5, { value: /"wc\\?\/(v3|store\\?\/v1)"/ }),
    R('cookie', /^woocommerce_cart_hash$/i, 4),
    R('path', '/plugins/woocommerce/', 4),
    R('dom', /class=["'][^"']*\bwoocommerce\b|woocommerce-page/, 3),
    R('repo', /^wp-content\/plugins\/woocommerce\//, 5),
  ],
  yoast: [
    R('probe', '/wp-json', 5, { value: /"yoast\\?\/v1"/ }),
    R('dom', /This site is optimized with the Yoast SEO plugin/i, 4),
    R('dom', /yoast-schema-graph/, 4),
    R('repo', /^wp-content\/plugins\/wordpress-seo\//, 5),
  ],
  rankmath: [
    R('probe', '/wp-json', 5, { value: /"rankmath\\?\/v1"/ }),
    R('dom', /rank-math-schema/, 4),
    R('dom', /Rank Math (WordPress )?SEO/i, 3),
    R('repo', /^wp-content\/plugins\/seo-by-rank-math\//, 5),
  ],
  aioseo: [
    R('probe', '/wp-json', 5, { value: /"aioseo\\?\/v1"/ }),
    R('dom', /aioseo-schema|aioseo-head-start/, 4),
    R('dom', /All in One SEO/i, 3),
    R('repo', /^wp-content\/plugins\/all-in-one-seo-pack\//, 5),
  ],
  seopress: [
    R('probe', '/wp-json', 5, { value: /"seopress\\?\/v1"/ }),
    R('path', '/plugins/wp-seopress/', 4),
    R('dom', /SEOPress/i, 3),
    R('repo', /^wp-content\/plugins\/wp-seopress\//, 5),
  ],
});

// ---------------------------------------------------------------------------
// Layer 4 — hosting (who serves the bytes; drives the environment layer and cache expectations)

export const HOSTING_RULES = Object.freeze({
  vercel: [
    R('header', 'x-vercel-id', 5),
    R('header', 'x-vercel-cache', 4),
    R('asset_host', /\.vercel\.app$/, 3, { scope: 'page' }),
  ],
  netlify: [
    R('header', 'x-nf-request-id', 5),
    R('asset_host', /\.netlify\.app$/, 3, { scope: 'page' }),
  ],
  'github-pages': [
    R('header', 'x-github-request-id', 5),
    R('header', 'server', 3, { value: /GitHub\.com/i }),
    R('asset_host', /\.github\.io$/, 3, { scope: 'page' }),
  ],
  'cloudflare-pages': [
    R('asset_host', /\.pages\.dev$/, 4, { scope: 'page' }),
    R('header', 'cf-ray', 2, { note: 'cf-ray alone only proves Cloudflare is in front of the origin' }),
  ],
  cloudflare: [
    R('header', 'cf-ray', 2, { note: 'CDN only — never a hosting verdict on its own' }),
    R('header', 'cf-cache-status', 2),
  ],
  wpengine: [
    R('asset_host', /\.wpengine\.com$/, 4, { scope: 'page' }),
    R('header', 'x-powered-by', 3, { value: /WP Engine/i, note: 'UNVERIFIED: header value not confirmed against vendor docs' }),
  ],
  shopify: [
    R('header', 'x-shopid', 3),
    R('header', 'x-shopify-stage', 3),
  ],
});

export const RULES = Object.freeze({
  platform: PLATFORM_RULES,
  framework: FRAMEWORK_RULES,
  plugins: PLUGIN_RULES,
  hosting: HOSTING_RULES,
});

// ---------------------------------------------------------------------------
// Environment layer. Ordered: the first rule that matches wins (local > preview > staging).
// A `noindex` on a non-production host is recorded as a corroborating signal, never as the
// only reason to call a host non-production — plenty of production pages carry noindex.

export const ENVIRONMENT_RULES = Object.freeze([
  { env: 'local', kind: 'asset_host', match: /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i, weight: 5, scope: 'page' },
  { env: 'local', kind: 'asset_host', match: /\.(local|localhost|test|internal)$/i, weight: 4, scope: 'page' },
  { env: 'preview', kind: 'path', match: /[?&]preview_theme_id=/i, weight: 5, scope: 'page' },
  { env: 'preview', kind: 'asset_host', match: /--[^.]+\.netlify\.app$/i, weight: 5, scope: 'page' },
  { env: 'preview', kind: 'asset_host', match: /^deploy-preview-\d+--/i, weight: 5, scope: 'page' },
  { env: 'preview', kind: 'asset_host', match: /\.vercel\.app$/i, weight: 4, scope: 'page' },
  { env: 'preview', kind: 'asset_host', match: /^(preview|pr-\d+)[.-]/i, weight: 4, scope: 'page' },
  { env: 'staging', kind: 'asset_host', match: /^(staging|stage|dev|test|uat|qa)\./i, weight: 4, scope: 'page' },
  { env: 'staging', kind: 'asset_host', match: /\.(staging|stage|dev|test|uat|qa)\./i, weight: 3, scope: 'page' },
  { env: 'staging', kind: 'asset_host', match: /\.wpengine\.com$/i, weight: 4, scope: 'page' },
  { env: 'staging', kind: 'asset_host', match: /\.myshopify\.dev$/i, weight: 4, scope: 'page' },
]);

/** Order in which a non-production verdict wins. */
export const ENVIRONMENT_ORDER = Object.freeze(['local', 'preview', 'staging', 'production']);

// ---------------------------------------------------------------------------
// Capability defaults per platform. `null` = "decide from the framework/local files instead".
// robots_editable: theme-template | physical | plugin | file | none
// redirects:       admin-api | plugin | file | none
// head_owner:      theme | seo-plugin | framework | builder

const CAP = (o) => Object.freeze({
  theme_files: false, rest_api: false, wp_cli: false, admin_api: false, page_api: false,
  sitemap_editable: false, robots_editable: 'none', redirects: 'none', head_owner: 'builder',
  instructions_only: false, ...o,
});

export const PLATFORM_CAPABILITIES = Object.freeze({
  shopify: CAP({ theme_files: true, admin_api: true, robots_editable: 'theme-template', redirects: 'admin-api', head_owner: 'theme' }),
  wordpress: CAP({ theme_files: true, rest_api: true, robots_editable: 'plugin', redirects: 'plugin', head_owner: 'theme' }),
  wix: CAP({ page_api: true, redirects: 'admin-api' }),
  squarespace: CAP({ instructions_only: true }),
  webflow: CAP({ page_api: true, redirects: 'admin-api' }),
  framer: CAP({ instructions_only: true }),
  ghost: CAP({ page_api: true, robots_editable: 'none', redirects: 'admin-api' }),
  hubspot: CAP({ page_api: true, redirects: 'admin-api' }),
  bigcommerce: CAP({ page_api: true, redirects: 'admin-api' }),
  magento: CAP({ instructions_only: true, head_owner: 'theme' }),
  drupal: CAP({ instructions_only: true, head_owner: 'theme' }),
  payload: CAP({ page_api: true, head_owner: 'framework' }),
});

/**
 * Adapter catalogue: credential KEY NAMES only (values are never read) and required CLI tools.
 *
 * The names are the CATALOG names — the ones `lib/credentials.mjs` KEY_CATALOG declares and
 * `.claude-plugin/plugin.json` `userConfig` prompts for. They travel into profile.json and into the
 * fix plan's "missing …" note, so a longer historical spelling here asked the operator for a
 * variable the plugin prompt and the docs no longer offer. Both spellings still RESOLVE (the
 * catalog carries them as aliases), and the Shopify CLI still receives its token as
 * SHOPIFY_CLI_THEME_TOKEN through the child env — see lib/shell.mjs `env_from_keys`.
 */
export const ADAPTERS = Object.freeze({
  'shopify-theme': { for: ['head', 'jsonld', 'robots', 'llms', 'hreflang'], needs: ['SHOPIFY_STORE', 'SHOPIFY_THEME_TOKEN'], tools: ['shopify'] },
  'shopify-admin': { for: ['seo-fields', 'redirects', 'seo-hidden'], needs: ['SHOPIFY_STORE', 'SHOPIFY_ADMIN_TOKEN'], tools: [] },
  'wordpress-rest': { for: ['title', 'description', 'slug', 'excerpt', 'image-alt', 'options'], needs: ['WP_URL', 'WP_USER', 'WP_APP_PASSWORD'], tools: [] },
  'wordpress-wpcli': { for: ['seo-meta', 'options', 'redirects'], needs: ['WP_SSH'], tools: ['wp', 'ssh'] },
  'page-api': { for: ['title', 'description', 'og', 'canonical'], needs: [], tools: [] },
  'local-files': { for: ['head', 'jsonld', 'robots', 'sitemap', 'config', 'front-matter'], needs: [], tools: [] },
  instructions: { for: ['*'], needs: [], tools: [] },
});

/** Per-platform credential keys for the generic `page-api` adapter (catalog names, as above). */
export const PAGE_API_KEYS = Object.freeze({
  webflow: ['WEBFLOW_TOKEN', 'WEBFLOW_SITE_ID'],
  wix: ['WIX_API_KEY', 'WIX_SITE_ID'],
  ghost: ['GHOST_URL', 'GHOST_ADMIN_KEY'],
  hubspot: ['HUBSPOT_TOKEN'],
  bigcommerce: ['BIGCOMMERCE_STORE_HASH', 'BIGCOMMERCE_TOKEN'],
  // Payload has no catalog entry yet: these two names are the adapter's own, and resolve unchanged.
  payload: ['PAYLOAD_URL', 'PAYLOAD_API_KEY'],
});

/** Vertical hints the platform layer can contribute (signals for seo-vertical-detect, never verdicts). */
export const VERTICAL_HINTS = Object.freeze({
  shopify: ['ecommerce'],
  bigcommerce: ['ecommerce'],
  magento: ['ecommerce'],
  woocommerce: ['ecommerce'],
  ghost: ['blog-publisher'],
  wordpress: ['blog-publisher'],
  docusaurus: ['docs'],
});

/** Knowledge card for a detected id (references/platforms/<id>.md). */
export const CARD_IDS = Object.freeze([
  'shopify', 'wordpress', 'woocommerce', 'wix', 'squarespace', 'webflow', 'framer', 'ghost',
  'hubspot', 'bigcommerce', 'magento', 'drupal', 'nextjs', 'nuxt', 'astro', 'sveltekit',
  'react-router', 'gatsby', 'hugo', 'jekyll', 'eleventy', 'docusaurus', 'payload', 'static',
]);

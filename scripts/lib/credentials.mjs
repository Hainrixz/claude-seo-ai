// Credential resolution for the write adapters.
//
// Three rules, and they are the whole module:
//   1. Values come from the environment only — `CLAUDE_PLUGIN_OPTION_<KEY>` (what a plugin
//      `userConfig` prompt exports) first, then `<KEY>`. Never from argv, never from a file in the
//      repo: a value on the command line lands in `ps`, in shell history and in every log the run
//      touches, and these scripts print the commands they would re-run.
//   2. Planning asks "is it there?", not "what is it?" — `presence()`/`hasKey()` never read a value.
//   3. Anything that might reach a log, a preview or the transcript goes through `redact()`.
//
// KEY_CATALOG is the contract with `.claude-plugin/plugin.json` `userConfig`: same names, same
// sensitivity. `aliases` exist because `lib/platform-rules.mjs` shipped a longer spelling for a few
// keys (WORDPRESS_URL, SHOPIFY_CLI_THEME_TOKEN …); both spellings resolve, the catalog name wins.

const CATALOG = {
  SHOPIFY_STORE: {
    sensitive: false, adapters: ['shopify-theme', 'shopify-admin'],
    description: 'Shopify store domain, e.g. my-store.myshopify.com (also exported to the CLI as SHOPIFY_FLAG_STORE).',
    aliases: ['SHOPIFY_FLAG_STORE'],
  },
  SHOPIFY_THEME_TOKEN: {
    sensitive: true, adapters: ['shopify-theme'],
    description: 'Shopify Theme Access token (Theme Access app). Passed to the CLI as SHOPIFY_CLI_THEME_TOKEN via the child env, never on the command line.',
    aliases: ['SHOPIFY_CLI_THEME_TOKEN'],
  },
  SHOPIFY_ADMIN_TOKEN: {
    sensitive: true, adapters: ['shopify-admin'],
    description: 'Shopify Admin API access token, sent as the X-Shopify-Access-Token header.',
    aliases: ['SHOPIFY_ACCESS_TOKEN'],
  },
  WP_URL: {
    sensitive: false, adapters: ['wordpress-rest'],
    description: 'WordPress site URL (https:// only — Basic auth over http would send the application password in clear).',
    aliases: ['WORDPRESS_URL'],
  },
  WP_USER: {
    sensitive: false, adapters: ['wordpress-rest'],
    description: 'WordPress user name the application password belongs to.',
    aliases: ['WORDPRESS_USER'],
  },
  WP_APP_PASSWORD: {
    sensitive: true, adapters: ['wordpress-rest'],
    description: 'WordPress application password (Users -> Profile -> Application Passwords). Spaces are allowed and preserved.',
    aliases: ['WORDPRESS_APP_PASSWORD'],
  },
  WP_SSH: {
    sensitive: false, adapters: ['wordpress-wpcli'],
    description: 'WP-CLI transport target, user@host:/path/to/wordpress.',
    aliases: ['WORDPRESS_SSH'],
  },
  WEBFLOW_TOKEN: {
    sensitive: true, adapters: ['page-api'],
    description: 'Webflow site API token (Bearer).',
    aliases: [],
  },
  WEBFLOW_SITE_ID: {
    sensitive: false, adapters: ['page-api'],
    description: 'Webflow site id (also readable from the page markup as data-wf-site).',
    aliases: [],
  },
  WIX_API_KEY: {
    sensitive: true, adapters: ['page-api'],
    description: 'Wix API key (Authorization header).',
    aliases: [],
  },
  WIX_SITE_ID: {
    sensitive: false, adapters: ['page-api'],
    description: 'Wix site id, sent as wix-site-id.',
    aliases: [],
  },
  GHOST_URL: {
    sensitive: false, adapters: ['page-api'],
    description: 'Ghost site URL, e.g. https://blog.example.com (the Admin API lives under /ghost/api/admin/).',
    aliases: ['GHOST_ADMIN_API_URL'],
  },
  GHOST_ADMIN_KEY: {
    sensitive: true, adapters: ['page-api'],
    description: 'Ghost Admin API key in <id>:<secret> form; the secret signs a short-lived JWT.',
    aliases: ['GHOST_ADMIN_API_KEY'],
  },
  HUBSPOT_TOKEN: {
    sensitive: true, adapters: ['page-api'],
    description: 'HubSpot private-app access token (Bearer) with CMS pages write scope.',
    aliases: ['HUBSPOT_ACCESS_TOKEN'],
  },
  BIGCOMMERCE_STORE_HASH: {
    sensitive: false, adapters: ['page-api'],
    description: 'BigCommerce store hash from the API path /stores/<hash>/v3/.',
    aliases: [],
  },
  BIGCOMMERCE_TOKEN: {
    sensitive: true, adapters: ['page-api'],
    description: 'BigCommerce API account token, sent as X-Auth-Token.',
    aliases: ['BIGCOMMERCE_ACCESS_TOKEN'],
  },
};

for (const [name, spec] of Object.entries(CATALOG)) {
  spec.key = name;
  Object.freeze(spec.adapters);
  Object.freeze(spec.aliases);
  Object.freeze(spec);
}

/** Every credential key the adapters understand: name -> { key, sensitive, description, adapters[], aliases[] }. */
export const KEY_CATALOG = Object.freeze(CATALOG);
/** Catalog key names in declaration order. */
export const KEY_NAMES = Object.freeze(Object.keys(CATALOG));

const ALIAS_TO_KEY = new Map();
for (const [name, spec] of Object.entries(CATALOG)) for (const alias of spec.aliases) ALIAS_TO_KEY.set(alias, name);

/** Catalog entry for a key or one of its aliases (null when unknown). */
export function keySpec(name) {
  const n = String(name || '');
  if (CATALOG[n]) return CATALOG[n];
  const canonical = ALIAS_TO_KEY.get(n);
  return canonical ? CATALOG[canonical] : null;
}

/** Canonical catalog name for a key or alias; unknown names are returned unchanged. */
export function canonicalKey(name) {
  const spec = keySpec(name);
  return spec ? spec.key : String(name || '');
}

/** True when the key is a secret (its value must never be printed). Unknown keys are treated as secret. */
export function isSensitive(name) {
  const spec = keySpec(name);
  return spec ? spec.sensitive : true;
}

/** Names the resolver tries, in order, for `name`: CLAUDE_PLUGIN_OPTION_<K> then <K>, catalog name before aliases. */
export function lookupOrder(name) {
  const spec = keySpec(name);
  const names = spec ? [spec.key, ...spec.aliases] : [String(name || '')];
  const out = [];
  for (const n of names) out.push('CLAUDE_PLUGIN_OPTION_' + n, n);
  return out;
}

/**
 * Resolve a credential value from the environment.
 * @returns {string|null} the trimmed value, or null when unset/blank everywhere
 */
export function resolveKey(name, env = process.env) {
  for (const varName of lookupOrder(name)) {
    const v = env ? env[varName] : undefined;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** Presence + provenance for one key, with no value in the result. */
export function resolveKeyInfo(name, env = process.env) {
  const spec = keySpec(name);
  const key = canonicalKey(name);
  for (const varName of lookupOrder(name)) {
    const v = env ? env[varName] : undefined;
    if (typeof v === 'string' && v.trim()) {
      return {
        key, present: true, source: varName, alias: varName.replace(/^CLAUDE_PLUGIN_OPTION_/, '') !== key,
        sensitive: isSensitive(key), description: spec ? spec.description : null, known: !!spec,
      };
    }
  }
  return { key, present: false, source: null, alias: false, sensitive: isSensitive(key), description: spec ? spec.description : null, known: !!spec };
}

/** True when a value for `name` exists in the environment (value never read by the caller). */
export function hasKey(name, env = process.env) { return resolveKeyInfo(name, env).present; }

/** Presence report for several keys: [{key, present, source, sensitive, description, known}] — never any values. */
export function presence(names, env = process.env) {
  return (Array.isArray(names) ? names : [names]).map((n) => resolveKeyInfo(n, env));
}

/** The subset of `names` that has no value in the environment. */
export function missingKeys(names, env = process.env) {
  return (Array.isArray(names) ? names : [names]).map((n) => canonicalKey(n)).filter((n) => !hasKey(n, env));
}

/** Catalog key names an adapter can use. */
export function keysForAdapter(adapter) {
  return KEY_NAMES.filter((n) => CATALOG[n].adapters.includes(String(adapter)));
}

const MIN_REDACT_LENGTH = 6;

/** The secret values currently visible in `env` (values of sensitive catalog keys), longest first. */
export function secretValues(env = process.env, extra = []) {
  const out = [];
  for (const name of KEY_NAMES) {
    if (!CATALOG[name].sensitive) continue;
    const v = resolveKey(name, env);
    if (typeof v === 'string' && v.length >= MIN_REDACT_LENGTH) out.push({ key: name, value: v });
  }
  for (const v of Array.isArray(extra) ? extra : [extra]) {
    if (typeof v === 'string' && v.length >= MIN_REDACT_LENGTH) out.push({ key: null, value: v });
  }
  return out.sort((a, b) => b.value.length - a.value.length);
}

/**
 * Replace every known secret value in `text` with a marker. Values shorter than 6 characters are
 * left alone: masking them would corrupt unrelated output without protecting anything.
 * Non-sensitive keys (a store domain, a site id) are never redacted — they are not secrets, and
 * blanking them would make previews unreadable.
 */
export function redact(text, { env = process.env, extra = [] } = {}) {
  let s = String(text == null ? '' : text);
  if (!s) return s;
  for (const { key, value } of secretValues(env, extra)) {
    const marker = key ? '[redacted:' + key + ']' : '[redacted]';
    if (s.includes(value)) s = s.split(value).join(marker);
    // an application password may appear URL-encoded (spaces -> %20 or +) in a Basic-auth header
    for (const encoded of [encodeURIComponent(value), value.split(' ').join('+')]) {
      if (encoded !== value && s.includes(encoded)) s = s.split(encoded).join(marker);
    }
  }
  return s;
}

/** Redact every value in a JSON-able structure (keys are kept, sensitive-looking fields blanked). */
const SECRET_FIELD_RE = /(token|secret|password|passwd|api[-_]?key|authorization|credential)/i;
export function redactObject(value, { env = process.env, extra = [] } = {}) {
  const walk = (v, keyName) => {
    if (typeof v === 'string') {
      if (keyName && SECRET_FIELD_RE.test(keyName) && v) return '[redacted]';
      return redact(v, { env, extra });
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, keyName));
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val, k);
      return out;
    }
    return v;
  };
  return walk(value, null);
}

const TEXT = {
  en: {
    missing: 'Missing credential',
    set: 'Set it in the environment before running the fix',
    hint: 'These are plugin options: re-run `/plugin` for claude-seo-ai to enter them, or export the variable in the shell that starts Claude Code.',
  },
  es: {
    missing: 'Falta la credencial',
    set: 'Defínela en el entorno antes de ejecutar la corrección',
    hint: 'Son opciones del plugin: vuelve a ejecutar `/plugin` para claude-seo-ai e introdúcelas, o exporta la variable en la terminal donde arranca Claude Code.',
  },
};

/**
 * Human-readable lines for the keys an adapter still needs. Names and descriptions only —
 * a value is never echoed, not even partially.
 * @returns {{lines: string[], missing: string[], hint: string}}
 */
export function explainKeys(names, { env = process.env, lang = 'en' } = {}) {
  const t = TEXT[lang === 'es' ? 'es' : 'en'];
  const missing = missingKeys(names, env);
  const lines = missing.map((key) => {
    const spec = keySpec(key);
    return t.missing + ': ' + key + (spec ? ' — ' + spec.description : '') + ' (' + t.set + ')';
  });
  return { lines, missing, hint: t.hint };
}

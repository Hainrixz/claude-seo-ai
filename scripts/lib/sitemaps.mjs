// XML sitemap parsing and recursive discovery (sitemaps.org protocol + image/video/news/xhtml
// extensions). Regex-based on purpose: zero dependencies, tolerant of the sloppy XML CMSs emit.

import { gunzipSync, constants as Z } from 'node:zlib';

export const SITEMAP_LIMITS = Object.freeze({ urls: 50000, bytes: 52428800 });
export const WELL_KNOWN_SITEMAPS = Object.freeze(['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/wp-sitemap.xml', '/sitemap.xml.gz']);
const CHANGEFREQ = new Set(['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never']);
const MAX_ERRORS = 100;

/** Decode XML character references and the five predefined entities. */
export function xmlDecode(s = '') {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function safeChar(cp) { try { return String.fromCodePoint(cp); } catch { return ''; } }

const W3C_DATE = /^\d{4}(-\d{2}(-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?)?)?)?$/;
/** Parse a W3C datetime (sitemaps `<lastmod>`) → ISO string or null. */
export function parseW3cDate(s) {
  if (!s) return null;
  const v = String(s).trim();
  if (!W3C_DATE.test(v)) return null;
  const t = Date.parse(v.replace(' ', 'T'));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function isGzip(buf) { return buf && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b; }
/** Gunzip when the buffer starts with the gzip magic; returns { buf, gz }. Tolerates truncated streams. */
export function maybeGunzip(buf) {
  if (!isGzip(buf)) return { buf, gz: false, error: null };
  try { return { buf: gunzipSync(buf, { finishFlush: Z.Z_SYNC_FLUSH }), gz: true, error: null }; }
  catch (e) { return { buf, gz: true, error: String(e && e.message || e) }; }
}

function text(block, tag) {
  const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>\\s*([\\s\\S]*?)\\s*</' + tag + '\\s*>', 'i').exec(block);
  if (!m) return null;
  return xmlDecode(m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim());
}
// `<loc>` must not match `<image:loc>` / `<video:...loc>`: require the tag to open exactly as `<loc`.
function ownLoc(block) {
  const m = /(?:^|[^:\w])<loc(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/loc\s*>/i.exec(block);
  return m ? xmlDecode(m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim()) : null;
}

/**
 * Parse a sitemap or sitemap index.
 * @param {string|Buffer} xml  text, or a Buffer (gunzipped automatically when it is gzip)
 */
export function parseSitemap(xml) {
  let src;
  if (Buffer.isBuffer(xml) || xml instanceof Uint8Array) src = maybeGunzip(Buffer.from(xml)).buf.toString('utf8');
  else src = xml == null ? '' : String(xml);
  if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
  const errors = [];
  const empty = { count: 0, min: null, max: null, distinct: 0, invalid: 0 };
  const root = /<(sitemapindex|urlset)\b([^>]*)>/i.exec(src);
  if (!root) {
    const reasons = ['no <urlset> or <sitemapindex> root element'];
    if (/^\s*(<!doctype html|<html)/i.test(src)) reasons.push('body looks like an HTML page (soft 404 or redirect to a page?)');
    else if (!src.trim()) reasons.push('empty body');
    return { kind: 'invalid', entries: [], namespaces: [], errors: reasons, url_count: 0, lastmod: empty };
  }
  const kind = root[1].toLowerCase();
  const namespaces = [];
  for (const m of root[2].matchAll(/xmlns(?::([\w-]+))?\s*=\s*["']([^"']+)["']/g)) namespaces.push({ prefix: m[1] || null, uri: m[2] });
  if (!namespaces.some((n) => n.prefix === null && /sitemaps\.org\/schemas\/sitemap/i.test(n.uri))) errors.push('missing default xmlns http://www.sitemaps.org/schemas/sitemap/0.9');
  if (!new RegExp('</' + kind + '\\s*>', 'i').test(src)) errors.push('unclosed <' + kind + '>');
  if (kind === 'sitemapindex' && /<url[\s>]/i.test(src)) errors.push('<url> entries inside a <sitemapindex>');
  if (kind === 'urlset' && /<sitemap[\s>]/i.test(src)) errors.push('<sitemap> entries inside a <urlset>');

  const tag = kind === 'sitemapindex' ? 'sitemap' : 'url';
  const blockRe = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '\\s*>', 'gi');
  const entries = [];
  const lastmodRaw = [];
  let lastmodInvalid = 0;
  const push = (msg) => { if (errors.length < MAX_ERRORS) errors.push(msg); };
  let m;
  let n = 0;
  while ((m = blockRe.exec(src))) {
    n++;
    const block = m[1];
    const loc = ownLoc(block);
    const lastmod = text(block, 'lastmod');
    const changefreq = text(block, 'changefreq');
    const priorityRaw = text(block, 'priority');
    const priority = priorityRaw == null ? null : Number(priorityRaw);
    const alternates = [];
    for (const l of block.matchAll(/<xhtml:link\b([^>]*?)\/?>/gi)) {
      const attrs = l[1];
      if (!/rel\s*=\s*["']alternate["']/i.test(attrs)) continue;
      const hl = /hreflang\s*=\s*["']([^"']+)["']/i.exec(attrs), hr = /href\s*=\s*["']([^"']+)["']/i.exec(attrs);
      if (hl && hr) alternates.push({ hreflang: hl[1], href: xmlDecode(hr[1]) });
    }
    const images = (block.match(/<image:image[\s>]/gi) || []).length;
    const videos = (block.match(/<video:video[\s>]/gi) || []).length;
    const news = (block.match(/<news:news[\s>]/gi) || []).length;
    const entry = { loc, lastmod, changefreq, priority, alternates, images, videos, news };
    if (!loc) push('entry #' + n + ': missing <loc>');
    else if (!/^https?:\/\/\S+$/i.test(loc)) push('entry #' + n + ': <loc> is not an absolute http(s) URL: ' + loc.slice(0, 120));
    if (lastmod != null) {
      lastmodRaw.push(lastmod);
      const iso = parseW3cDate(lastmod);
      if (!iso) { lastmodInvalid++; push('entry #' + n + ': <lastmod> is not a W3C datetime: ' + lastmod.slice(0, 40)); }
      else entry.lastmod_iso = iso;
    }
    if (changefreq != null && !CHANGEFREQ.has(changefreq.toLowerCase())) push('entry #' + n + ': invalid <changefreq> ' + changefreq.slice(0, 40));
    if (priorityRaw != null && (Number.isNaN(priority) || priority < 0 || priority > 1)) push('entry #' + n + ': <priority> outside 0.0–1.0: ' + priorityRaw.slice(0, 40));
    if (kind === 'sitemapindex' && (images || videos || news || alternates.length)) push('entry #' + n + ': extension elements are not valid inside a <sitemapindex>');
    entries.push(entry);
  }
  if (n === 0) errors.push('no <' + tag + '> entries');
  if (errors.length >= MAX_ERRORS) errors.push('… error list truncated at ' + MAX_ERRORS);

  const valid = entries.map((e) => e.lastmod_iso).filter(Boolean).sort();
  const lastmod = { count: lastmodRaw.length, min: valid[0] || null, max: valid[valid.length - 1] || null, distinct: new Set(lastmodRaw).size, invalid: lastmodInvalid };
  return { kind, entries, namespaces, errors, url_count: entries.length, lastmod };
}

function bodyBuffer(r) {
  if (!r) return Buffer.alloc(0);
  if (r.body && r.body.buffer) return Buffer.isBuffer(r.body.buffer) ? r.body.buffer : Buffer.from(r.body.buffer);
  if (r.buffer) return Buffer.isBuffer(r.buffer) ? r.buffer : Buffer.from(r.buffer);
  const t = r.body && typeof r.body.text === 'string' ? r.body.text : typeof r.text === 'string' ? r.text : '';
  return Buffer.from(t, 'utf8');
}

/**
 * Discover and walk every sitemap of an origin: robots `Sitemap:` lines ∪ well-known paths, then a
 * breadth-first walk over sitemap indexes. `fetchImpl(url, opts)` must resolve to a fetchRaw-shaped
 * object ({ status, ok, body:{ text | buffer } , error }); it is called with { returnBuffer: true }
 * so gzip files can be inflated here even when the fetcher did not.
 * Each file records `final_url` (after redirects) and, when another requested path resolved to the
 * same document first, `alias_of` — an alias contributes no URLs, no children and no `found` count.
 * @returns {Promise<{origin:string, declared:string[], files:Array, urls:Array<{loc,lastmod,sitemap}>, truncated:boolean, truncated_files:boolean, truncated_urls:boolean, found:number}>}
 */
export async function discoverSitemaps(origin, robots, fetchImpl, { maxFiles = 50, maxUrls = 100000, wellKnown = true, fetchOpts = {}, onParsed = null } = {}) {
  let base;
  try { base = new URL(origin).origin; } catch { return { origin: String(origin), declared: [], files: [], urls: [], truncated: false, truncated_files: false, truncated_urls: false, found: 0, error: 'invalid origin: ' + origin }; }
  const parsed = robots && robots.mode ? robots.robots : robots;
  const declared = (parsed && Array.isArray(parsed.sitemaps) ? parsed.sitemaps : []).slice();
  const queue = [];
  const seen = new Set();
  const enqueue = (u, source, parent = null, depth = 0) => {
    let abs;
    try { abs = new URL(u, base + '/').href; } catch { return; }
    if (seen.has(abs)) return;
    seen.add(abs);
    queue.push({ url: abs, source, parent, depth });
  };
  for (const s of declared) enqueue(s, 'robots');
  if (wellKnown) for (const p of WELL_KNOWN_SITEMAPS) enqueue(base + p, 'well-known');

  const files = [], urls = [];
  // Two well-known paths that redirect to the same file are ONE sitemap. Recording the requested URL
  // beside the post-redirect status made /wp-sitemap.xml -> /sitemap_index.xml -> /sitemap.xml look
  // like three live sources on a WordPress site that has one, walked the same index three times and
  // spent the file budget doing it. The alias is still recorded (with `alias_of`), so a caller can
  // say what each path serves — it just does not contribute URLs or children a second time.
  const finalSeen = new Map();
  let truncatedFiles = false, truncatedUrls = false;
  while (queue.length) {
    if (files.length >= maxFiles) { truncatedFiles = true; break; }
    const item = queue.shift();
    let r;
    try { r = await fetchImpl(item.url, { returnBuffer: true, ...fetchOpts }); }
    catch (e) { r = { ok: false, status: 0, error: String(e && e.message || e) }; }
    const raw = bodyBuffer(r);
    const inflated = maybeGunzip(raw);
    const gz = inflated.gz || !!(r && r.body && r.body.gunzipped);
    const finalUrl = (r && typeof r.final_url === 'string' && r.final_url) || item.url;
    const file = {
      url: item.url, final_url: finalUrl, redirected: finalUrl !== item.url, alias_of: null,
      source: item.source, parent: item.parent, depth: item.depth, status: r ? r.status : 0, bytes: inflated.buf.length, gz,
      kind: null, url_count: 0, over_50k: false, over_50mb: false, errors: [], lastmod: null, error: null,
    };
    if (!r || !(r.status >= 200 && r.status < 300)) {
      file.error = (r && r.error) || ('HTTP ' + (r ? r.status : 0));
      files.push(file);
      continue;
    }
    if (inflated.error) file.errors.push('gunzip failed: ' + inflated.error);
    const sm = parseSitemap(inflated.buf.toString('utf8'));
    file.kind = sm.kind;
    file.url_count = sm.url_count;
    file.over_50k = sm.url_count > SITEMAP_LIMITS.urls;
    file.over_50mb = inflated.buf.length > SITEMAP_LIMITS.bytes;
    file.errors.push(...sm.errors);
    file.lastmod = sm.lastmod;
    file.namespaces = sm.namespaces;
    const alias = finalSeen.get(finalUrl);
    if (alias !== undefined && alias !== item.url) {
      // The same document under a second name: describe it, then stop.
      file.alias_of = alias;
      files.push(file);
      continue;
    }
    finalSeen.set(finalUrl, item.url);
    files.push(file);
    if (typeof onParsed === 'function') { try { onParsed(file, sm); } catch { /* observer errors never abort discovery */ } }
    if (sm.kind === 'sitemapindex') {
      for (const e of sm.entries) if (e.loc) enqueue(e.loc, 'index', item.url, item.depth + 1);
    } else if (sm.kind === 'urlset') {
      for (const e of sm.entries) {
        if (!e.loc) continue;
        if (urls.length >= maxUrls) { truncatedUrls = true; break; }
        urls.push({ loc: e.loc, lastmod: e.lastmod_iso || e.lastmod || null, sitemap: item.url });
      }
    }
  }
  // An alias is not a second sitemap: it is the same document reached by another name.
  const found = files.filter((f) => f.kind && f.kind !== 'invalid' && !f.alias_of).length;
  return { origin: base, declared, files, urls, truncated: truncatedFiles || truncatedUrls, truncated_files: truncatedFiles, truncated_urls: truncatedUrls, found };
}

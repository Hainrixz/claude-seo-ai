#!/usr/bin/env node
// M21 — AI discovery & agent endpoints (plan 4b). Weight 0 on both axes on purpose: no engine
// documents that any of these files changes retrieval or citation. This script only reports whether
// the files exist, whether they parse, and whether robots.txt blocks them for the very agents they
// are written for. Every finding built from this output is speculative or directional.
//
// Usage: node ai-discovery.mjs --url https://example.com          (probes the origin)
//        node ai-discovery.mjs --run-dir <run>                    (reads <run>/site/discovery.json)
//        node ai-discovery.mjs --snapshot <run>/pages/<slug>.json
//        …[--deep] [--ucp-file ./ucp.json] [--llms-file ./llms.txt] [--timeout 8000]
// --deep GETs at most 25 links listed in llms.txt and reports their status.
// Exit codes: 0 ok · 1 usage (no input, unreadable file) · 2 runtime (probing failed)

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT, isMain, runCli, readSnapshot } from './lib/util.mjs';
import { fetchRaw } from './lib/fetch.mjs';
import { fetchSiteArtifacts, DISCOVERY_PROBES, isSoftHtml404 } from './lib/site.mjs';
import { parseSitemap } from './lib/sitemaps.mjs';
import { isAllowed } from './lib/robots.mjs';
import { BOTS } from './lib/bots.mjs';
import { normalizeRobots } from './ai-eligibility.mjs';
import { readJson } from './lib/store.mjs';

export const DISCOVERY_PATHS = Object.freeze(DISCOVERY_PROBES.map((p) => p.path));
/** Bots that would fetch these files while answering a user; training-only crawlers are not the audience. */
export const AUDIENCE_CLASSES = Object.freeze(['retrieval', 'user', 'search']);
export const DISCOVERY_AUDIENCE = Object.freeze(BOTS.filter((b) => AUDIENCE_CLASSES.includes(b.class)).map((b) => b.name));
export const UCP_TRANSPORTS = Object.freeze(['mcp', 'rest', 'embedded']);
export const SHOPIFY_CATALOG_KEY = 'dev.shopify.catalog';
export const DEEP_LINK_BUDGET = 25;
/** Reverse-DNS service key, e.g. `dev.shopify.catalog`. */
const REVERSE_DNS = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;
const HTTPS_URL = /^https:\/\/[^\s]+$/i;
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0)$/i;
/** Inline code spans: a URL inside backticks is an example being quoted, never a link. */
const CODE_SPAN = /`[^`]*`/g;
/** `- ` / `* ` bullet marker. */
const BULLET = /^[-*][ \t]+/;
/** A short leading label — bold or plain — closed by `:`, `—` or `–`, as in `- Docs: <url>`. */
const LABEL = /^[^:—–]{0,60}[:—–][ \t]*/;
/** What a link looks like once it sits in link position: a Markdown link, or a URL. */
const LINK_HEAD = /^(?:\[|<https?:\/\/|https?:\/\/\S)/i;

/**
 * Did this bullet try to be a link and fail, or is it prose?
 *
 * llmstxt.org allows any Markdown except headings inside a section, so a sentence in a bullet is
 * legal and must not be reported as a defect. Link intent has to sit in LINK POSITION to count:
 *   - a broken `](` pair anywhere in the bullet, or
 *   - a URL/`[` at the head of the bullet, or at the head of what follows a short `Label:` prefix
 *     (`- Docs: https://…` is the classic un-bracketed link, not a sentence).
 * A URL that merely appears inside a sentence — or inside a backticked code span, which is how
 * documentation quotes an example request — is prose, and stays exempt.
 */
export function looksLikeBrokenLink(line) {
  const bare = String(line == null ? '' : line).replace(CODE_SPAN, ' ');
  if (bare.includes('](')) return true;
  const rest = bare.replace(BULLET, '').trim();
  // Before the label strip, because a bare URL carries a `:` of its own ("https:").
  if (LINK_HEAD.test(rest)) return true;
  return LINK_HEAD.test(rest.replace(LABEL, '').trim());
}

/**
 * `null` when the value is a valid https URL, 'local_http' for plain http on a loopback host
 * (a development origin — reported as a warning, not a defect), 'invalid' otherwise.
 */
function urlIssue(value) {
  const s = String(value == null ? '' : value).trim();
  if (HTTPS_URL.test(s)) return null;
  try { const u = new URL(s); if (u.protocol === 'http:' && LOOPBACK_HOST.test(u.hostname)) return 'local_http'; } catch { /* not a URL */ }
  return 'invalid';
}

const NOTE = 'None of these files is documented by any engine as changing retrieval, ranking or citation. They are reported so an operator can see what agents can find, and to catch the case where robots.txt blocks a file written for those same agents.';

const text = (v) => (typeof v === 'string' ? v : '');
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------
// llms.txt (structure per llmstxt.org: H1 title, optional > summary, then H2 sections of links)

export function validateLlmsTxt(body, { origin = null } = {}) {
  const src = text(body);
  const out = {
    present: src.length > 0, bytes: Buffer.byteLength(src), looks_like_html: /^\s*(<!doctype\s+html|<html[\s>])/i.test(src),
    title: null, summary: null, sections: [], links: [], links_total: 0, prose_items: 0, errors: [], warnings: [],
  };
  if (!out.present) return out;
  if (out.looks_like_html) { out.errors.push({ line: 1, reason: 'html_instead_of_markdown' }); return out; }
  const lines = src.split(/\r?\n/);
  let h1 = 0;
  let section = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    const no = i + 1;
    if (!line) continue;
    if (/^#\s+/.test(line)) {
      h1++;
      if (h1 === 1) out.title = line.replace(/^#\s+/, '').trim();
      else out.errors.push({ line: no, reason: 'multiple_h1' });
      continue;
    }
    if (/^##\s+/.test(line)) { section = { name: line.replace(/^##\s+/, '').trim(), links: 0, prose: 0, line: no }; out.sections.push(section); continue; }
    if (/^#{3,}\s+/.test(line)) { out.warnings.push({ line: no, reason: 'heading_deeper_than_h2' }); continue; }
    if (/^>\s?/.test(line)) { if (out.summary === null) out.summary = line.replace(/^>\s?/, '').trim(); continue; }
    if (/^[-*]\s+/.test(line)) {
      const m = /^[-*]\s+\[([^\]]*)\]\(([^)\s]+)\)\s*(?::\s*(.*))?$/.exec(line);
      if (!m) {
        // llmstxt.org allows "zero or more markdown sections … of any type except headings", so a
        // prose bullet is legal, not a defect. Only a bullet whose link position holds a link that
        // did not parse is a structural problem — see looksLikeBrokenLink().
        if (looksLikeBrokenLink(line)) out.errors.push({ line: no, reason: 'malformed_list_item' });
        else { out.prose_items++; if (section) section.prose++; }
        continue;
      }
      let abs = null;
      try { abs = origin ? new URL(m[2], origin).href : new URL(m[2]).href; } catch { abs = null; }
      if (!abs) out.warnings.push({ line: no, reason: 'unresolvable_link' });
      out.links.push({ name: m[1].trim(), url: m[2], abs, note: m[3] ? m[3].trim() : null, section: section ? section.name : null, line: no });
      if (section) section.links++;
      continue;
    }
  }
  out.links_total = out.links.length;
  if (h1 === 0) out.errors.push({ line: 1, reason: 'missing_h1_title' });
  if (!out.sections.length) out.errors.push({ line: 1, reason: 'no_h2_sections' });
  if (!out.links_total) out.errors.push({ line: 1, reason: 'no_links' });
  for (const s of out.sections) if (s.links === 0 && !s.prose) out.warnings.push({ line: s.line, reason: 'section_without_links' });
  out.ok = out.errors.length === 0;
  return out;
}

// ---------------------------------------------------------------------------
// agents.md

export function validateAgentsMd(body) {
  const src = text(body);
  const out = { present: src.length > 0, bytes: Buffer.byteLength(src), headings: [], mentions_shop_app: false, mentions_skill_md: false, shopify_default_hint: false, errors: [], warnings: [] };
  if (!out.present) return out;
  if (/^\s*(<!doctype\s+html|<html[\s>])/i.test(src)) { out.errors.push({ line: 1, reason: 'html_instead_of_markdown' }); return out; }
  for (const line of src.split(/\r?\n/)) {
    const m = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (m && out.headings.length < 20) out.headings.push({ level: m[1].length, text: m[2].trim() });
  }
  out.mentions_shop_app = /shop\.app/i.test(src);
  out.mentions_skill_md = /SKILL\.md/.test(src);
  out.shopify_default_hint = out.mentions_shop_app || out.mentions_skill_md;
  if (!out.headings.length) out.warnings.push({ line: 1, reason: 'no_headings' });
  return out;
}

// ---------------------------------------------------------------------------
// /.well-known/ucp

function checkUcpSection(sectionName, value, out, originHost) {
  const section = { count: 0, keys: [], entries: 0 };
  if (value === undefined) return section;
  if (!isPlainObject(value)) { out.errors.push({ path: sectionName, reason: 'not_an_object' }); return section; }
  for (const [key, list] of Object.entries(value)) {
    section.count++;
    section.keys.push(key);
    if (!REVERSE_DNS.test(key)) out.errors.push({ path: sectionName + '.' + key, reason: 'key_not_reverse_dns' });
    if (!Array.isArray(list)) { out.errors.push({ path: sectionName + '.' + key, reason: 'not_an_array' }); continue; }
    list.forEach((entry, i) => {
      const at = sectionName + '.' + key + '[' + i + ']';
      section.entries++;
      if (!isPlainObject(entry)) { out.errors.push({ path: at, reason: 'entry_not_an_object' }); return; }
      if (typeof entry.version !== 'string' || !entry.version.trim()) out.errors.push({ path: at + '.version', reason: 'missing_version' });
      if (typeof entry.spec !== 'string' || !entry.spec.trim()) out.errors.push({ path: at + '.spec', reason: 'missing_spec' });
      else {
        const issue = urlIssue(entry.spec);
        if (issue === 'invalid') out.errors.push({ path: at + '.spec', reason: 'spec_not_https_url' });
        else if (issue === 'local_http') out.warnings.push({ path: at + '.spec', reason: 'not_https_local_origin' });
      }
      const transport = entry.transport === undefined ? null : String(entry.transport).toLowerCase();
      if (transport !== null && !UCP_TRANSPORTS.includes(transport)) out.errors.push({ path: at + '.transport', reason: 'transport_not_in_enum' });
      if (transport === 'mcp' || transport === 'rest') {
        const issue = typeof entry.endpoint === 'string' && entry.endpoint.trim() ? urlIssue(entry.endpoint) : 'missing';
        if (issue === 'missing') out.errors.push({ path: at + '.endpoint', reason: 'missing_endpoint_for_transport' });
        else if (issue === 'invalid') out.errors.push({ path: at + '.endpoint', reason: 'endpoint_not_https_url' });
        else {
          if (issue === 'local_http') out.warnings.push({ path: at + '.endpoint', reason: 'not_https_local_origin' });
          let host = null;
          try { host = new URL(entry.endpoint.trim()).host.toLowerCase(); } catch { host = null; }
          out.endpoints.push({ section: sectionName, key, transport, endpoint: entry.endpoint.trim(), host });
          if (transport === 'mcp' && host && originHost && host !== originHost) out.mcp_endpoint_host_differs = true;
        }
      }
      if (entry.schema !== undefined) {
        const issue = typeof entry.schema === 'string' ? urlIssue(entry.schema) : 'invalid';
        if (issue === 'invalid') out.errors.push({ path: at + '.schema', reason: 'schema_not_https_url' });
        else if (issue === 'local_http') out.warnings.push({ path: at + '.schema', reason: 'not_https_local_origin' });
      }
    });
  }
  return section;
}

export function validateUcp(doc, { origin = null, status = null, public_ok = null } = {}) {
  let originHost = null;
  try { originHost = origin ? new URL(origin).host.toLowerCase() : null; } catch { originHost = null; }
  const out = {
    present: doc !== null && doc !== undefined, status, publicly_readable: public_ok,
    json_valid: isPlainObject(doc) || Array.isArray(doc), version: null, version_valid: null, version_source: null,
    services: { count: 0, keys: [], entries: 0 }, capabilities: { count: 0, keys: [], entries: 0 },
    supported_versions: null, payment_handlers_declared: false, shopify_catalog_declared: false,
    mcp_endpoint_host_differs: originHost ? false : null, endpoints: [], errors: [], warnings: [],
  };
  if (!out.present) return out;
  if (!isPlainObject(doc)) { out.errors.push({ path: '$', reason: 'root_not_an_object' }); return out; }
  const meta = isPlainObject(doc.ucp) ? doc.ucp : null;
  if (meta && typeof meta.version === 'string') { out.version = meta.version.trim(); out.version_source = 'ucp.version'; }
  else if (typeof doc.version === 'string') { out.version = doc.version.trim(); out.version_source = 'version'; out.warnings.push({ path: 'version', reason: 'version_outside_ucp_object' }); }
  if (out.version === null) out.errors.push({ path: 'ucp.version', reason: 'missing_version' });
  else { out.version_valid = /^\d{4}-\d{2}-\d{2}$/.test(out.version); if (!out.version_valid) out.errors.push({ path: out.version_source, reason: 'version_not_yyyy_mm_dd' }); }

  const services = doc.services !== undefined ? doc.services : (meta ? meta.services : undefined);
  const capabilities = doc.capabilities !== undefined ? doc.capabilities : (meta ? meta.capabilities : undefined);
  if (services === undefined && capabilities === undefined) out.errors.push({ path: '$', reason: 'no_services_or_capabilities' });
  out.services = checkUcpSection('services', services, out, originHost);
  out.capabilities = checkUcpSection('capabilities', capabilities, out, originHost);

  const sv = doc.supported_versions !== undefined ? doc.supported_versions : (meta ? meta.supported_versions : undefined);
  if (sv !== undefined) {
    if (Array.isArray(sv)) out.supported_versions = sv.filter((x) => typeof x === 'string');
    else out.errors.push({ path: 'supported_versions', reason: 'not_an_array' });
  }
  const ph = doc.payment_handlers !== undefined ? doc.payment_handlers : (meta ? meta.payment_handlers : undefined);
  if (ph !== undefined) {
    out.payment_handlers_declared = true;
    if (!Array.isArray(ph) && !isPlainObject(ph)) out.errors.push({ path: 'payment_handlers', reason: 'not_an_object_or_array' });
  }
  out.shopify_catalog_declared = out.services.keys.includes(SHOPIFY_CATALOG_KEY) || out.capabilities.keys.includes(SHOPIFY_CATALOG_KEY);
  if (public_ok === false) out.errors.push({ path: '$', reason: 'not_publicly_readable' });
  out.ok = out.errors.length === 0;
  return out;
}

// ---------------------------------------------------------------------------
// /.well-known/ai-catalog.json (Agentic Retail Discovery draft — report only, keys never values)

export function validateAiCatalog(doc, { status = null } = {}) {
  const out = { present: doc !== null && doc !== undefined, status, json_valid: isPlainObject(doc) || Array.isArray(doc), keys: [], errors: [], warnings: [] };
  if (!out.present) return out;
  if (Array.isArray(doc)) { out.keys = ['[array:' + doc.length + ']']; return out; }
  if (!isPlainObject(doc)) { out.errors.push({ path: '$', reason: 'root_not_an_object' }); return out; }
  out.keys = Object.keys(doc).slice(0, 50);
  return out;
}

// ---------------------------------------------------------------------------
// /sitemap_agentic_discovery.xml

/**
 * @param {string} xml  the probe body
 * @param {{looks_like_html?: boolean, content_type?: string|null}} [probe]  what the probe recorded.
 *   A catch-all HTML page served at this path is a soft 404: the file is NOT published, so it is
 *   reported as absent rather than as a published-but-broken sitemap (the llms.txt branch above
 *   makes the same distinction).
 */
export function validateAgenticSitemap(xml, { looks_like_html = false, content_type = null } = {}) {
  const src = text(xml);
  const html = looks_like_html === true
    || /^\s*(<!doctype\s+html|<html[\s>])/i.test(src)
    || (typeof content_type === 'string' && /\btext\/html\b/i.test(content_type));
  const out = { present: src.length > 0 && !html, kind: null, url_count: 0, locs: [], looks_like_html: html, errors: [], warnings: [] };
  if (html) { out.warnings.push({ path: 'http', reason: 'html_response_not_xml' }); return out; }
  if (!out.present) return out;
  const parsed = parseSitemap(src);
  out.kind = parsed.kind;
  out.url_count = parsed.url_count;
  out.locs = parsed.entries.slice(0, 50).map((e) => e.loc);
  for (const e of parsed.errors.slice(0, 10)) out.errors.push({ path: 'xml', reason: String(e && e.message ? e.message : e) });
  if (parsed.kind !== 'urlset') out.errors.push({ path: 'xml', reason: parsed.kind === 'sitemapindex' ? 'sitemapindex_not_urlset' : 'not_a_urlset' });
  else if (out.url_count === 0) out.errors.push({ path: 'xml', reason: 'urlset_empty' });
  out.ok = out.errors.length === 0;
  return out;
}

// ---------------------------------------------------------------------------
// robots cross-check: is a file written for agents blocked for those agents?

export function discoveryRobotsCheck(paths, robots, origin) {
  const norm = normalizeRobots(robots);
  if (!norm) return { checked: false, reason: 'no robots.txt available', discovery_paths_blocked_for: [], audience: DISCOVERY_AUDIENCE };
  const rows = [];
  for (const path of paths) {
    const target = origin ? origin.replace(/\/+$/, '') + path : path;
    const blocked = [];
    for (const bot of DISCOVERY_AUDIENCE) {
      const v = isAllowed(norm, bot, target);
      if (!v.allowed) blocked.push({ bot, via: v.via, rule: v.rule });
    }
    if (blocked.length) rows.push({ path, blocked_for: blocked.map((b) => b.bot), detail: blocked });
  }
  return { checked: true, audience: DISCOVERY_AUDIENCE, discovery_paths_blocked_for: rows };
}

// ---------------------------------------------------------------------------
// analysis

const bodyOf = (probe) => (probe && typeof probe.text === 'string' ? probe.text : (probe && probe.text_head) || '');
const parseJsonBody = (probe) => { try { return JSON.parse(bodyOf(probe)); } catch { return undefined; } };

/**
 * Fill every probe's `text` from the body `lib/site.mjs` saved under `<run>/site/<saved_as>`.
 *
 * site/discovery.json only carries `text_head`, a 4096-char preview. Validating that preview instead
 * of the file produces a fabricated negative — a 4121-byte UCP profile stops being JSON at the cut,
 * so `JSON.parse` fails and the store looks like it publishes no profile. Every reader of a run
 * directory must hydrate first so the two paths (this CLI and the checks registry) cannot disagree.
 * Mutates and returns `discovery`; a probe whose body was not saved keeps its `text_head`.
 *
 * @param {object|null} discovery  parsed site/discovery.json
 * @param {string} runDir
 */
export function hydrateDiscovery(discovery, runDir) {
  if (!discovery || !discovery.probes || !runDir) return discovery;
  for (const p of DISCOVERY_PROBES) {
    const entry = discovery.probes[p.path];
    if (!entry || !entry.saved_as) continue;
    try { entry.text = readFileSync(join(runDir, 'site', entry.saved_as), 'utf8'); } catch { /* keep text_head */ }
  }
  return discovery;
}

/**
 * Read `<runDir>/site/discovery.json` with the saved bodies hydrated. `null` when the run has none.
 * @param {string} runDir
 */
export function loadDiscovery(runDir) {
  if (!runDir) return null;
  const discovery = readJson(join(runDir, 'site', 'discovery.json'), null);
  return discovery ? hydrateDiscovery(discovery, runDir) : null;
}

/**
 * Pure analysis of a site/discovery.json artifact.
 * @param {object} discoveryJson  lib/site.mjs discovery shape ({ origin, probes, https_enforcement, summary }).
 *   Probe entries may carry a full `text` (hydrated from site/<saved_as>); otherwise `text_head` is used
 *   and `truncated` is reported so a caller knows the validation saw only the first bytes.
 * @param {object|null} robots  site/robots.json, robotsFromFetch result, parseRobots object or robots.txt text
 */
export function analyzeDiscovery(discoveryJson, robots = null) {
  const d = discoveryJson && typeof discoveryJson === 'object' ? discoveryJson : { probes: {} };
  const probes = d.probes && typeof d.probes === 'object' ? d.probes : {};
  const origin = d.origin || null;
  const at = (p) => probes[p] || null;
  const statusOf = (p) => (at(p) ? at(p).status : null);
  const okOf = (p) => !!(at(p) && at(p).ok);
  const truncatedOf = (p) => {
    const e = at(p);
    if (!e) return false;
    if (typeof e.text === 'string') return false;
    return !!e.truncated || (typeof e.bytes === 'number' && typeof e.text_head === 'string' && e.bytes > Buffer.byteLength(e.text_head));
  };
  const sourceBytesOf = (p) => { const e = at(p); return e && typeof e.bytes === 'number' ? e.bytes : null; };
  /** Stamp every validated block with how much of the response the parser actually read. */
  const provenance = (block, p) => {
    block.truncated_source = truncatedOf(p);
    block.parsed_bytes = at(p) ? Buffer.byteLength(bodyOf(at(p))) : 0;
    block.source_bytes = sourceBytesOf(p);
    return block;
  };

  const llms = validateLlmsTxt(okOf('/llms.txt') ? bodyOf(at('/llms.txt')) : '', { origin });
  llms.status = statusOf('/llms.txt');
  provenance(llms, '/llms.txt');
  const llmsFull = {
    present: okOf('/llms-full.txt'), status: statusOf('/llms-full.txt'),
    bytes: at('/llms-full.txt') ? at('/llms-full.txt').bytes : 0,
    looks_like_html: !!(at('/llms-full.txt') && at('/llms-full.txt').looks_like_html),
  };
  const agentsMd = validateAgentsMd(okOf('/agents.md') ? bodyOf(at('/agents.md')) : '');
  agentsMd.status = statusOf('/agents.md');
  provenance(agentsMd, '/agents.md');
  const ucpProbe = at('/.well-known/ucp');
  const ucpDoc = okOf('/.well-known/ucp') ? parseJsonBody(ucpProbe) : null;
  const ucp = validateUcp(ucpDoc, {
    origin, status: statusOf('/.well-known/ucp'), public_ok: ucpProbe ? ucpProbe.ok === true : null,
  });
  provenance(ucp, '/.well-known/ucp');
  // A body we only read the head of is UNKNOWN, not absent. Without this flag a profile larger than
  // the saved-body limit parses to `undefined` and the store looks like it publishes none — a
  // fabricated negative with the probe's own "HTTP 200" sitting next to it in the evidence.
  ucp.body_unread = !!(ucpProbe && ucpProbe.ok && ucpDoc === undefined && ucp.truncated_source);
  // Same soft-404 rule: a catch-all HTML page at /.well-known/ucp means no profile is published,
  // not a broken one. Only a body that was meant to be JSON earns an invalid_json error.
  if (ucpProbe && ucpProbe.ok && ucpProbe.json_valid === false && !ucpProbe.looks_like_html) ucp.errors.push({ path: '$', reason: 'invalid_json' });
  const catalog = validateAiCatalog(okOf('/.well-known/ai-catalog.json') ? parseJsonBody(at('/.well-known/ai-catalog.json')) : null, { status: statusOf('/.well-known/ai-catalog.json') });
  const agenticProbe = at('/sitemap_agentic_discovery.xml');
  const agenticSitemap = validateAgenticSitemap(okOf('/sitemap_agentic_discovery.xml') ? bodyOf(agenticProbe) : '', {
    looks_like_html: !!(agenticProbe && agenticProbe.looks_like_html), content_type: agenticProbe ? agenticProbe.content_type : null,
  });
  agenticSitemap.status = statusOf('/sitemap_agentic_discovery.xml');

  // 200 + an HTML body at a machine endpoint is a catch-all page, not a published file (lib/site.mjs
  // isSoftHtml404). It is reported under soft_404 with its status, never counted as found.
  const softHtml = DISCOVERY_PATHS.filter((p) => isSoftHtml404(at(p)));
  const found = DISCOVERY_PATHS.filter((p) => okOf(p) && !softHtml.includes(p));
  const cross = discoveryRobotsCheck(found.length ? found : DISCOVERY_PATHS.filter((p) => statusOf(p) !== null), robots, origin);
  const errors_total = llms.errors.length + agentsMd.errors.length + ucp.errors.length + catalog.errors.length + agenticSitemap.errors.length;

  return {
    origin,
    source: d.source || null,
    fetched_at: d.fetched_at || null,
    statuses: Object.fromEntries(DISCOVERY_PATHS.map((p) => [p, statusOf(p)])),
    llms_txt: llms,
    llms_full_txt: llmsFull,
    agents_md: agentsMd,
    ucp,
    ai_catalog: catalog,
    agentic_sitemap: agenticSitemap,
    mcp_probe: at('/api/ucp/mcp') ? { status: statusOf('/api/ucp/mcp'), looks_like_html: !!at('/api/ucp/mcp').looks_like_html, content_type: at('/api/ucp/mcp').content_type } : null,
    https_enforcement: d.https_enforcement || null,
    robots_cross_check: cross,
    summary: {
      found, soft_404: softHtml, missing: DISCOVERY_PATHS.filter((p) => !okOf(p) || softHtml.includes(p)),
      errors_total, blocked_paths: cross.discovery_paths_blocked_for.map((r) => r.path),
    },
    note: NOTE,
  };
}

// ---------------------------------------------------------------------------
// CLI

const flagValue = (v) => (Array.isArray(v) ? v[v.length - 1] : v);

function injectFile(discovery, path, file, kind) {
  const abs = resolve(file);
  const body = readFileSync(abs, 'utf8');
  discovery.probes = discovery.probes || {};
  discovery.probes[path] = {
    url: 'file://' + abs, status: 200, ok: true, final_url: 'file://' + abs, redirected: false,
    content_type: kind === 'json' ? 'application/json' : 'text/plain', bytes: Buffer.byteLength(body), truncated: false,
    sha256: null, text: body, text_head: body.slice(0, 4096), looks_like_html: false,
    json_valid: kind === 'json' ? (() => { try { JSON.parse(body); return true; } catch { return false; } })() : null,
    parsed_keys: null, saved_as: null, error: null, source: 'file',
  };
  return discovery;
}

/** --deep: GET the links listed in llms.txt (budget 25) and report their status. */
export async function checkLlmsLinks(links, { fetchImpl = fetchRaw, budget = DEEP_LINK_BUDGET, timeoutMs = 8000 } = {}) {
  const targets = links.filter((l) => l.abs).slice(0, budget);
  const checked = [];
  for (const l of targets) {
    let r;
    try { r = await fetchImpl(l.abs, { timeoutMs, retries: 0, maxBytes: 65536 }); }
    catch (e) { r = { status: 0, ok: false, error: String(e && e.message || e) }; }
    checked.push({ url: l.abs, name: l.name, status: r.status, ok: !!r.ok, error: r.error || null });
  }
  return { checked: checked.length, skipped: Math.max(0, links.length - targets.length), links: checked, broken: checked.filter((c) => !c.ok) };
}

export async function main(args, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetchRaw;
  const runDirFlag = flagValue(args['run-dir']);
  const snapFlag = flagValue(args.snapshot);
  const urlFlag = flagValue(args.url);
  let discovery = null;
  let runDir = null;
  let robots = null;
  let source = null;

  if (typeof snapFlag === 'string' && snapFlag.trim()) {
    const rs = readSnapshot(snapFlag.trim());
    if (rs.error) return { result: { error: rs.error }, code: EXIT.USAGE };
    runDir = rs.run_dir;
    source = 'snapshot';
  } else if (typeof runDirFlag === 'string' && runDirFlag.trim()) {
    runDir = resolve(runDirFlag.trim());
    source = 'run-dir';
  }
  if (runDir) {
    discovery = loadDiscovery(runDir);
    robots = readJson(join(runDir, 'site', 'robots.json'));
    if (!discovery) return { result: { error: 'no site/discovery.json in ' + runDir, hint: 'run snapshot.mjs against the site first, or pass --url' }, code: EXIT.USAGE };
  } else if (typeof urlFlag === 'string' && urlFlag.trim()) {
    let origin;
    try { origin = new URL(urlFlag.trim()).origin; }
    catch { return { result: { error: 'invalid --url ' + urlFlag, hint: 'include the scheme, e.g. https://example.com' }, code: EXIT.USAGE }; }
    source = 'http';
    const site = await fetchSiteArtifacts(origin, { fetchImpl, artifacts: ['robots', 'discovery'], timeoutMs: Number(flagValue(args.timeout)) || 20000 });
    discovery = site.discovery;
    robots = site.robots;
    if (!discovery) return { result: { error: 'discovery probing failed for ' + origin, warnings: site.warnings }, code: EXIT.RUNTIME };
  } else {
    return { result: { error: 'provide --url <origin>, --run-dir <run> or --snapshot <pages/x.json>' }, code: EXIT.USAGE };
  }

  const ucpFile = flagValue(args['ucp-file']);
  const llmsFile = flagValue(args['llms-file']);
  try {
    if (typeof ucpFile === 'string' && ucpFile.trim()) injectFile(discovery, '/.well-known/ucp', ucpFile.trim(), 'json');
    if (typeof llmsFile === 'string' && llmsFile.trim()) injectFile(discovery, '/llms.txt', llmsFile.trim(), 'text');
  } catch (e) { return { result: { error: String(e && e.message || e) }, code: EXIT.USAGE }; }

  const result = { source, run_dir: runDir, ...analyzeDiscovery(discovery, robots) };
  if (args.deep) {
    result.llms_txt.link_check = await checkLlmsLinks(result.llms_txt.links, { fetchImpl, timeoutMs: Number(flagValue(args.timeout)) || 8000 });
    result.summary.broken_llms_links = result.llms_txt.link_check.broken.length;
  } else {
    result.llms_txt.link_check = null;
  }
  return { result, code: EXIT.OK };
}

if (isMain(import.meta.url)) runCli(main);

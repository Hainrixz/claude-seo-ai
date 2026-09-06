// robots.txt parser + matcher implementing the Robots Exclusion Protocol as Google applies it
// (RFC 9309 + Google's documented extensions), plus the Content-Signal extension
// (contentsignals.org). Own implementation; no third-party code.
//
// Matching rules (Google REP):
//   - rules are matched against pathname + query of the URL, case-sensitively;
//   - `*` matches any sequence, a trailing `$` anchors the end of the URL;
//   - the most specific (longest pattern) matching rule wins; on a tie, Allow wins;
//   - an empty `Disallow:` (or `Allow:`) imposes nothing;
//   - the crawler uses the group whose User-agent token equals its product token
//     (case-insensitive), merging every group that names that token; `*` is the fallback;
//     no group at all → everything is allowed.
// Fetch semantics (robotsFromFetch): 2xx → parse · 4xx → allow-all · 5xx/429/network → disallow-all.

import { AI_BOTS, BOT_CLASSES, botInUaString } from './bots.mjs';

const SIGNAL_KEYS = ['search', 'ai-input', 'ai-train'];

/** Extract the product token from a robots.txt `User-agent:` value (Google: leading token, `*` is global). */
export function agentToken(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (v[0] === '*') return '*';
  const m = /^[A-Za-z0-9_-]+/.exec(v);
  return m ? m[0] : v;
}

const NOISE = new Set(['mozilla', 'applewebkit', 'khtml', 'gecko', 'chrome', 'safari', 'firefox', 'mobile', 'version', 'edg',
  'edge', 'opr', 'like', 'compatible', 'msie', 'trident', 'linux', 'android', 'windows', 'macintosh', 'x11']);

/** Product token of a crawler given either a bot name ("GPTBot") or a full User-Agent header value. */
export function uaToken(ua) {
  if (ua == null || ua === '') return '*';
  const s = String(ua).trim();
  if (s === '*') return '*';
  const known = botInUaString(s);
  if (known) return known.name;
  const compat = /compatible;\s*([A-Za-z][A-Za-z0-9_-]*)/i.exec(s);
  if (compat && !NOISE.has(compat[1].toLowerCase())) return compat[1];
  const products = [...s.matchAll(/([A-Za-z][A-Za-z0-9_-]*)\/[\w.]+/g)].map((m) => m[1]).filter((t) => !NOISE.has(t.toLowerCase()));
  if (products.length) return products[products.length - 1];
  const lead = /^[A-Za-z0-9_-]+/.exec(s);
  return lead ? lead[0] : s;
}

function parseDelay(value) {
  const n = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : String(value).trim();
}

function normalizeRulePath(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (v[0] === '/' || v[0] === '*') return v;
  if (/^https?:\/\//i.test(v)) { try { const u = new URL(v); return u.pathname + u.search; } catch { /* fall through */ } }
  return '/' + v; // lenient: "Disallow: admin" is read as "/admin"
}

function emptySignals() { return { search: null, 'ai-input': null, 'ai-train': null }; }

/** Parse the value of one `Content-Signal:` line → { signals, malformed[] }. */
export function parseContentSignalValue(value, line = null) {
  const signals = emptySignals();
  const malformed = [];
  const v = String(value || '').trim();
  if (!v) { malformed.push({ line, reason: 'empty Content-Signal value' }); return { signals, malformed }; }
  for (const part of v.split(',')) {
    const p = part.trim();
    if (!p) { malformed.push({ line, reason: 'empty pair (stray comma)' }); continue; }
    const eq = p.indexOf('=');
    if (eq === -1) { malformed.push({ line, reason: 'missing "=" in "' + p + '"' }); continue; }
    const k = p.slice(0, eq).trim().toLowerCase();
    const val = p.slice(eq + 1).trim().toLowerCase();
    if (!SIGNAL_KEYS.includes(k)) { malformed.push({ line, reason: 'unknown key "' + k + '" (expected search|ai-input|ai-train)' }); continue; }
    if (val !== 'yes' && val !== 'no') { malformed.push({ line, reason: 'invalid value "' + val + '" for ' + k + ' (expected yes|no)' }); continue; }
    if (signals[k] !== null) malformed.push({ line, reason: 'duplicate key "' + k + '"' });
    signals[k] = val;
  }
  return { signals, malformed };
}

function mergeSignals(a, b) {
  const out = a ? { ...a } : emptySignals();
  for (const k of SIGNAL_KEYS) if (b && b[k] != null) out[k] = b[k];
  return out;
}

/**
 * Parse robots.txt text.
 * @returns {{groups:Array<{agents:string[],rules:Array<{type:'allow'|'disallow',path:string,line:number}>,crawlDelay:number|string|null,contentSignal:object|null,line:number}>,
 *   sitemaps:string[], host:string|null, cleanParam:string[], contentSignals:object, unknownDirectives:Array, invalidLines:Array, hasBom:boolean, lines:number}}
 */
export function parseRobots(text) {
  let src = text == null ? '' : String(text);
  const hasBom = src.charCodeAt(0) === 0xFEFF;
  if (hasBom) src = src.slice(1);
  const rawLines = src.split(/\r\n|\r|\n/);

  const groups = [], sitemaps = [], cleanParam = [], unknownDirectives = [], invalidLines = [];
  let host = null;
  const contentSignals = { present: false, placement: null, global: null, by_group: [], malformed: [], cloudflare_managed_hint: false };
  let cur = null;             // current group; rules attach to it even across blank lines (RFC 9309)
  let expectingAgent = false; // consecutive User-agent lines share one group
  let contiguous = false;     // inside the unbroken block that started with a User-agent line
  let sawSignalComment = false;
  let globalRaw = [];

  rawLines.forEach((rawLine, i) => {
    const lineNo = i + 1;
    const hash = rawLine.indexOf('#');
    const comment = hash !== -1 ? rawLine.slice(hash + 1) : null;
    const line = (hash !== -1 ? rawLine.slice(0, hash) : rawLine).trim();
    if (comment && /contentsignals\.org/i.test(comment)) sawSignalComment = true;
    if (!line) { contiguous = false; return; } // blank or comment-only line separates blocks
    const idx = line.indexOf(':');
    if (idx === -1) { invalidLines.push({ line: lineNo, text: line.slice(0, 120), reason: 'no ":" separator' }); return; }
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    switch (field) {
      case 'user-agent':
        if (!expectingAgent || !cur) { cur = { agents: [], rules: [], crawlDelay: null, contentSignal: null, line: lineNo }; groups.push(cur); }
        cur.agents.push(value);
        expectingAgent = true; contiguous = true;
        return;
      case 'allow':
      case 'disallow':
        expectingAgent = false;
        if (!cur) { invalidLines.push({ line: lineNo, text: line.slice(0, 120), reason: 'rule before any User-agent line (ignored)' }); return; }
        cur.rules.push({ type: field, path: normalizeRulePath(value), line: lineNo });
        return;
      case 'crawl-delay':
        expectingAgent = false;
        if (cur) cur.crawlDelay = parseDelay(value);
        else invalidLines.push({ line: lineNo, text: line.slice(0, 120), reason: 'Crawl-delay before any User-agent line (ignored)' });
        return;
      case 'sitemap':
        expectingAgent = false; contiguous = false;
        if (value) sitemaps.push(value);
        return;
      case 'host':
        expectingAgent = false; contiguous = false;
        if (host == null) host = value;
        return;
      case 'clean-param':
        expectingAgent = false; contiguous = false;
        cleanParam.push(value);
        return;
      case 'content-signal': {
        expectingAgent = false;
        const parsed = parseContentSignalValue(value, lineNo);
        contentSignals.present = true;
        contentSignals.malformed.push(...parsed.malformed);
        if (sawSignalComment) contentSignals.cloudflare_managed_hint = true;
        if (cur && contiguous) {
          cur.contentSignal = mergeSignals(cur.contentSignal, parsed.signals);
          contentSignals.by_group.push({ agents: cur.agents.slice(), signals: parsed.signals, raw: value, line: lineNo, group_index: groups.indexOf(cur) });
        } else {
          contentSignals.global = mergeSignals(contentSignals.global, parsed.signals);
          globalRaw.push(value);
        }
        return;
      }
      default:
        expectingAgent = false;
        unknownDirectives.push({ line: lineNo, field, value });
    }
  });

  if (contentSignals.global) contentSignals.global.raw = globalRaw.join(' | ');
  if (contentSignals.present) {
    const g = !!contentSignals.global, grp = contentSignals.by_group.length > 0;
    contentSignals.placement = g && grp ? 'both' : g ? 'global' : grp ? 'group' : null;
  }
  return { groups, sitemaps, host, cleanParam, contentSignals, unknownDirectives, invalidLines, hasBom, lines: rawLines.length };
}

/**
 * Classify a robots.txt fetch the way Google does.
 * @param {{status:number, text?:string, body?:{text:string}, error?:string|null}} r
 * @returns {{mode:'parsed'|'allow-all'|'disallow-all', robots:object, status:number, reason:string|null}}
 */
export function robotsFromFetch(r) {
  const status = r && Number.isInteger(r.status) ? r.status : 0;
  const text = r ? (r.text != null ? r.text : r.body && r.body.text) || '' : '';
  if (!r || status === 0) {
    return { mode: 'disallow-all', robots: parseRobots(''), status, reason: r && r.error ? 'network: ' + r.error : 'no response' };
  }
  if (status >= 500 || status === 429) {
    return { mode: 'disallow-all', robots: parseRobots(''), status, reason: 'HTTP ' + status + ' — Google treats a 5xx/429 robots.txt as fully disallowed until it recovers' };
  }
  if (status >= 200 && status < 300) return { mode: 'parsed', robots: parseRobots(text), status, reason: null };
  return { mode: 'allow-all', robots: parseRobots(''), status, reason: 'HTTP ' + status + ' — treated as "no robots.txt" (no restrictions)' };
}

/** Merge groups that name the same token into one effective group. */
export function mergeGroups(list) {
  const agents = [], rules = [];
  let crawlDelay = null, contentSignal = null;
  const indexes = [];
  for (const g of list) {
    for (const a of g.agents) if (!agents.includes(a)) agents.push(a);
    rules.push(...g.rules);
    if (crawlDelay == null && g.crawlDelay != null) crawlDelay = g.crawlDelay;
    if (g.contentSignal) contentSignal = mergeSignals(contentSignal, g.contentSignal);
    if (g.line != null) indexes.push(g.line);
  }
  return { agents, rules, crawlDelay, contentSignal, lines: indexes };
}

/**
 * Pick the effective group for a crawler.
 * @returns {{group:object|null, via:'explicit'|'wildcard'|'no-group', token:string}}
 */
export function selectGroup(robots, ua) {
  const token = uaToken(ua);
  const lc = token.toLowerCase();
  const groups = (robots && robots.groups) || [];
  const explicit = lc === '*' ? [] : groups.filter((g) => g.agents.some((a) => agentToken(a).toLowerCase() === lc));
  if (explicit.length) return { group: mergeGroups(explicit), via: 'explicit', token };
  const star = groups.filter((g) => g.agents.some((a) => agentToken(a) === '*'));
  if (star.length) return { group: mergeGroups(star), via: 'wildcard', token };
  return { group: null, via: 'no-group', token };
}

const matcherCache = new Map();

/** Compile a robots.txt path pattern (`*` wildcard, trailing `$` anchor) into a predicate over pathname+query. */
export function pathMatcher(pattern) {
  const key = String(pattern);
  if (matcherCache.has(key)) return matcherCache.get(key);
  let p = key;
  let anchored = false;
  if (p.endsWith('$')) { anchored = true; p = p.slice(0, -1); }
  // Non-ASCII (and spaces) in the pattern are compared in percent-encoded form, like URL.pathname.
  p = p.replace(/[^\x21-\x7e]+/g, (s) => encodeURI(s));
  const re = new RegExp('^' + p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''));
  const fn = (target) => re.test(target);
  matcherCache.set(key, fn);
  return fn;
}

/** pathname + query of a URL or path string, as the matcher expects it. */
export function targetPath(urlOrPath) {
  const s = String(urlOrPath == null || urlOrPath === '' ? '/' : urlOrPath).trim();
  try {
    if (/^https?:\/\//i.test(s)) { const u = new URL(s); return u.pathname + u.search; }
    if (s[0] === '/') { const u = new URL('http://x' + s); return u.pathname + u.search; }
    const u = new URL('http://' + s); return u.pathname + u.search; // "example.com/x?y"
  } catch { return s.split('#')[0] || '/'; }
}

/**
 * Is `ua` allowed to fetch `urlOrPath`? Accepts a parsed robots object or a robotsFromFetch() result.
 * @returns {{allowed:boolean, via:'explicit'|'wildcard'|'no-group'|'status-5xx'|'status-4xx', rule:{type,path,line}|null, path:string, token:string|null}}
 */
export function isAllowed(robots, ua, urlOrPath) {
  const path = targetPath(urlOrPath);
  let parsed = robots;
  if (robots && robots.mode) {
    if (robots.mode === 'allow-all') return { allowed: true, via: 'status-4xx', rule: null, path, token: uaToken(ua) };
    if (robots.mode === 'disallow-all') return { allowed: false, via: 'status-5xx', rule: null, path, token: uaToken(ua) };
    parsed = robots.robots;
  }
  const sel = selectGroup(parsed, ua);
  if (!sel.group) return { allowed: true, via: 'no-group', rule: null, path, token: sel.token };
  let best = null;
  for (const r of sel.group.rules) {
    if (!r.path) continue; // empty Disallow/Allow = no restriction
    if (!pathMatcher(r.path)(path)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.type === 'allow' && best.rule.type === 'disallow')) best = { rule: r, len };
  }
  return {
    allowed: !best || best.rule.type === 'allow', via: sel.via,
    rule: best ? { type: best.rule.type, path: best.rule.path, line: best.rule.line } : null, path, token: sel.token,
  };
}

/** Content-Signal that applies to `ua`: its effective group's line, else the global line, else 'unset'. */
export function signalsFor(robots, ua) {
  const parsed = robots && robots.mode ? robots.robots : robots;
  if (!parsed || !parsed.contentSignals || !parsed.contentSignals.present) return 'unset';
  const sel = selectGroup(parsed, ua);
  if (sel.group && sel.group.contentSignal) return stripRaw(sel.group.contentSignal);
  if (parsed.contentSignals.global) return stripRaw(parsed.contentSignals.global);
  return 'unset';
}
function stripRaw(sig) { const { raw, ...rest } = sig; return rest; }

/**
 * Per-class AI bot posture: { class: { Bot: { root_allowed, url_allowed, via, rule, signals } } }.
 * `url_allowed` is null when no URL is given. Accepts a parsed robots object or a robotsFromFetch() result.
 */
export function aiPosture(robots, url) {
  const out = {};
  for (const cls of BOT_CLASSES) {
    out[cls] = {};
    for (const name of AI_BOTS[cls]) {
      const root = isAllowed(robots, name, '/');
      const page = url ? isAllowed(robots, name, url) : null;
      const pick = page || root;
      out[cls][name] = { root_allowed: root.allowed, url_allowed: page ? page.allowed : null, via: pick.via, rule: pick.rule, signals: signalsFor(robots, name) };
    }
  }
  return out;
}

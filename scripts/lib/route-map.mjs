// URL -> source file mapping for the local-files adapter.
//
// The question this module answers is the one that decides whether `fix` can work on a framework
// site at all: "the audit found a problem on /blog/rain-shadow — which file in this repo produces
// that page, and where in it does a head tag go?"
//
// Everything is filesystem evidence: the route files that exist, the layout that wraps them, the
// config file that owns the site URL. Nothing is inferred from the HTML, and a path that matches no
// route file returns `confidence: 'none'` with `file: null` — an honest "I don't know" instead of a
// guess that would write a tag into the wrong template.
//
// CLASS RULE (plan 3d): only `html-head`, `front-matter`, `config-file` and `liquid` are AUTO.
// Those four are deterministic text edits with exact anchors. Every JSX/TS-object strategy
// (`metadata-object`, `next-head-jsx`, `use-seo-meta`, `svelte-head`, `meta-export-array`,
// `gatsby-head-export`) is PROPOSED — a human accepts the draft before it is written. The plan's
// per-framework table hints that some of those could be AUTO with a literal anchor; where the two
// readings disagree this module takes the stricter one and records what it found (`anchor`) so a
// later adapter can use the evidence without the class rule moving.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { parseFrontmatter } from './frontmatter.mjs';

/** Strategies that may produce an `auto` change. Everything else is `proposed`. */
export const AUTO_STRATEGIES = Object.freeze(['html-head', 'front-matter', 'config-file', 'liquid']);

/** Every strategy a route can resolve to. */
export const STRATEGIES = Object.freeze([
  'html-head', 'front-matter', 'config-file', 'liquid',
  'metadata-object', 'next-head-jsx', 'use-seo-meta', 'svelte-head', 'meta-export-array', 'gatsby-head-export',
  'manual',
]);

/** auto | proposed for a strategy (see CLASS RULE in the module header). */
export function classFor(strategy) { return AUTO_STRATEGIES.includes(strategy) ? 'auto' : 'proposed'; }

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.next', '.nuxt', '.output',
  '.svelte-kit', '.astro', '.cache', '.vercel', '.netlify', 'coverage', 'vendor', '.venv',
  'public/build', '_site', 'tmp', '.turbo', '.parcel-cache', 'themes',
]);
const MAX_FILES = 20000;
const MAX_DEPTH = 12;

/**
 * Repo-relative, forward-slash paths of every file under `root` (build output and dependencies
 * skipped). `themes/` is skipped on purpose: a Hugo fix copies a theme partial into the project,
 * it never edits the theme itself.
 */
export function scanProject(root, { maxFiles = MAX_FILES, maxDepth = MAX_DEPTH } = {}) {
  const base = resolve(root);
  const out = [];
  const walk = (dir, rel, depth) => {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const name = e.name;
      if (name.startsWith('.') && name !== '.eleventy.js' && !name.startsWith('.eleventy') && name !== '.claude') continue;
      const childRel = rel ? rel + '/' + name : name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(name) || SKIP_DIRS.has(childRel)) continue;
        walk(join(dir, name), childRel, depth + 1);
      } else if (e.isFile()) {
        out.push(childRel);
      }
    }
  };
  walk(base, '', 0);
  return out.sort();
}

const has = (files, re) => files.some((f) => re.test(f));
const find = (files, re) => files.find((f) => re.test(f)) || null;
const findAll = (files, re) => files.filter((f) => re.test(f));

const CONFIG_PATTERNS = Object.freeze({
  nextjs: /^next\.config\.(js|cjs|mjs|ts)$/,
  nuxt: /^nuxt\.config\.(js|mjs|ts)$/,
  astro: /^astro\.config\.(js|cjs|mjs|ts)$/,
  sveltekit: /^svelte\.config\.(js|cjs|mjs|ts)$/,
  'react-router': /^(react-router\.config\.(js|mjs|ts)|remix\.config\.(js|mjs|cjs))$/,
  gatsby: /^gatsby-config\.(js|mjs|ts)$/,
  hugo: /^(hugo|config)\.(toml|yaml|yml|json)$/,
  jekyll: /^_config\.ya?ml$/,
  eleventy: /^(\.eleventy\.js|eleventy\.config\.(js|cjs|mjs))$/,
  payload: /^payload\.config\.(js|ts)$/,
});

/**
 * Framework id for a project. The platform profile wins when it names one (the detector saw the
 * live page); otherwise the config files on disk decide.
 * @returns {{id: string|null, router: string|null, source: 'profile'|'files'|'none', confidence: string}}
 */
export function detectFramework(files, profile = null) {
  const fromProfile = profile && profile.framework && profile.framework.id ? String(profile.framework.id) : null;
  const routerFromProfile = profile && profile.framework && profile.framework.router ? String(profile.framework.router) : null;
  const platform = profile && profile.platform && profile.platform.id ? String(profile.platform.id) : null;

  const fileGuess = () => {
    for (const [id, re] of Object.entries(CONFIG_PATTERNS)) if (has(files, re)) return id;
    if (has(files, /^src\/routes\/.*\+page\./)) return 'sveltekit';
    if (has(files, /^app\/routes(\.ts|\/)/)) return 'react-router';
    if (has(files, /^(src\/)?app\/.*\/page\.(jsx?|tsx?|mdx)$/) || has(files, /^(src\/)?app\/page\.(jsx?|tsx?|mdx)$/)) return 'nextjs';
    if (has(files, /^(src\/)?pages\/.*\.(jsx?|tsx?)$/)) return 'nextjs';
    if (has(files, /^src\/pages\/.*\.astro$/)) return 'astro';
    if (has(files, /^content\/.*\.md$/) && has(files, /^layouts\//)) return 'hugo';
    if (has(files, /^_posts\/.*\.(md|markdown|html)$/)) return 'jekyll';
    if (has(files, /^index\.html$/)) return 'static';
    return null;
  };

  const guess = fileGuess();
  if (fromProfile && fromProfile !== 'static') {
    const agrees = guess === fromProfile;
    return { id: fromProfile, router: routerFromProfile || nextRouter(files), platform, source: 'profile', confidence: agrees || !guess ? 'high' : 'medium' };
  }
  if (guess) return { id: guess, router: guess === 'nextjs' ? (routerFromProfile || nextRouter(files)) : routerFromProfile, platform, source: 'files', confidence: 'high' };
  if (fromProfile) return { id: fromProfile, router: routerFromProfile, platform, source: 'profile', confidence: 'low' };
  return { id: null, router: null, platform, source: 'none', confidence: 'none' };
}

/** 'app' | 'pages' | null for a Next.js project, from the directories that exist. */
export function nextRouter(files) {
  const app = has(files, /^(src\/)?app\/(.*\/)?(page|layout)\.(jsx?|tsx?|mdx)$/);
  const pages = has(files, /^(src\/)?pages\/.*\.(jsx?|tsx?|mdx)$/);
  if (app && !pages) return 'app';
  if (pages && !app) return 'pages';
  if (app && pages) return 'app';
  return null;
}

// ---------------------------------------------------------------------------
// URL paths and route patterns

/** '/a/b/' or 'https://h/a/b?x=1' -> ['a','b'] (empty array for the home page). */
export function pathSegments(urlOrPath) {
  let p = String(urlOrPath == null ? '' : urlOrPath).trim();
  if (/^https?:\/\//i.test(p)) { try { p = new URL(p).pathname; } catch { /* keep the raw value */ } }
  p = p.split('#')[0].split('?')[0];
  try { p = decodeURIComponent(p); } catch { /* keep the raw value */ }
  return p.split('/').filter((s) => s !== '' && s !== '.');
}

/** Normalized '/a/b' form of a URL or path ('/' for the root). */
export function normalizePath(urlOrPath) {
  const segs = pathSegments(urlOrPath);
  return segs.length ? '/' + segs.join('/') : '/';
}

const seg = (kind, value, name = null) => ({ kind, value, name });

/**
 * Match a route pattern (array of segments) against URL segments.
 * @returns {{ok: boolean, params: object, score: number}} higher score = more specific
 */
export function matchPattern(pattern, segments) {
  const params = {};
  let i = 0;
  let score = 0;
  for (let p = 0; p < pattern.length; p++) {
    const part = pattern[p];
    if (part.kind === 'static') {
      if (segments[i] !== part.value) return { ok: false, params: {}, score: 0 };
      i++; score += 10;
      continue;
    }
    if (part.kind === 'dynamic') {
      if (i >= segments.length) return { ok: false, params: {}, score: 0 };
      params[part.name || 'param'] = segments[i];
      i++; score += 5;
      continue;
    }
    if (part.kind === 'optional') {
      // an optional static/dynamic segment: consume one when it is there
      if (i < segments.length && (part.value === null || segments[i] === part.value)) {
        if (part.name) params[part.name] = segments[i];
        i++; score += 3;
      } else score += 1;
      continue;
    }
    if (part.kind === 'catchall' || part.kind === 'optional-catchall') {
      const rest = segments.slice(i);
      if (part.kind === 'catchall' && rest.length === 0) return { ok: false, params: {}, score: 0 };
      if (p !== pattern.length - 1) return { ok: false, params: {}, score: 0 };
      params[part.name || 'slug'] = rest;
      i = segments.length;
      score += 2;
      return { ok: true, params, score };
    }
  }
  if (i !== segments.length) return { ok: false, params: {}, score: 0 };
  return { ok: true, params, score };
}

/** Pick the best-scoring candidate; ties break on the shortest file path (the least nested route). */
function bestMatch(candidates, segments) {
  let best = null;
  for (const c of candidates) {
    const m = matchPattern(c.pattern, segments);
    if (!m.ok) continue;
    const score = m.score + (c.bonus || 0);
    if (!best || score > best.score || (score === best.score && c.file.length < best.candidate.file.length)) {
      best = { candidate: c, params: m.params, score };
    }
  }
  return best;
}

/** Human-readable route pattern, e.g. '/blog/[slug]'. */
export function patternToString(pattern) {
  if (!pattern.length) return '/';
  return '/' + pattern.map((p) => {
    if (p.kind === 'static') return p.value;
    if (p.kind === 'dynamic') return '[' + (p.name || 'param') + ']';
    if (p.kind === 'optional') return '[[' + (p.name || p.value || 'opt') + ']]';
    if (p.kind === 'optional-catchall') return '[[...' + (p.name || 'slug') + ']]';
    return '[...' + (p.name || 'slug') + ']';
  }).join('/');
}

// ---------------------------------------------------------------------------
// Per-framework route file parsing

const bracketSegment = (raw) => {
  const s = String(raw);
  let m = /^\[\[\.\.\.(.+)\]\]$/.exec(s);
  if (m) return seg('optional-catchall', null, m[1]);
  m = /^\[\.\.\.(.+)\]$/.exec(s);
  if (m) return seg('catchall', null, m[1]);
  m = /^\[\[(.+)\]\]$/.exec(s);
  if (m) return seg('optional', null, m[1]);
  m = /^\[(.+)\]$/.exec(s);
  if (m) return seg('dynamic', null, m[1].split('=')[0]);
  return seg('static', s);
};

/** Next.js App Router: app/**\/page.* with (groups), @slots, [slug], [...slug], [[...slug]]. */
export function nextAppCandidates(files) {
  const out = [];
  for (const root of ['app', 'src/app']) {
    for (const file of findAll(files, new RegExp('^' + root + '/(.*/)?page\\.(jsx?|tsx?|mdx)$'))) {
      const rel = file.slice(root.length + 1).replace(/\/?page\.(jsx?|tsx?|mdx)$/, '');
      const raw = rel ? rel.split('/') : [];
      if (raw.some((s) => s.startsWith('_'))) continue; // private folder: not a route
      const pattern = [];
      for (const s of raw) {
        if (/^\(.+\)$/.test(s)) continue;   // route group: not in the URL
        if (s.startsWith('@')) continue;    // parallel-route slot: not in the URL
        pattern.push(bracketSegment(s));
      }
      out.push({ file, pattern, root, dir: file.slice(0, file.lastIndexOf('/')) });
    }
  }
  return out;
}

/** Nearest `layout.*` walking up from a page's directory, plus the root layout. */
export function nearestLayout(files, dir, root, names = /^layout\.(jsx?|tsx?)$/) {
  let cur = dir;
  while (cur && cur.length >= root.length) {
    const candidate = files.find((f) => f.startsWith(cur + '/') && !f.slice(cur.length + 1).includes('/') && names.test(basename(f)));
    if (candidate) return candidate;
    const cut = cur.lastIndexOf('/');
    if (cut < 0) break;
    cur = cur.slice(0, cut);
  }
  return files.find((f) => f === root + '/layout.tsx' || f === root + '/layout.jsx' || f === root + '/layout.js' || f === root + '/layout.ts') || null;
}

/** Next.js Pages Router: pages/** minus _app/_document/_error and pages/api. */
export function nextPagesCandidates(files) {
  const out = [];
  for (const root of ['pages', 'src/pages']) {
    for (const file of findAll(files, new RegExp('^' + root + '/.*\\.(jsx?|tsx?|mdx)$'))) {
      const rel = file.slice(root.length + 1);
      if (rel.startsWith('api/')) continue;
      const noExt = rel.replace(/\.(jsx?|tsx?|mdx)$/, '');
      const parts = noExt.split('/');
      const last = parts[parts.length - 1];
      if (/^_(app|document|error|middleware)$/.test(last)) continue;
      if (last === 'index') parts.pop();
      out.push({ file, pattern: parts.map(bracketSegment), root, dir: file.slice(0, file.lastIndexOf('/')) });
    }
  }
  return out;
}

/** Nuxt: pages/**\/*.vue (Nuxt 4 keeps them under app/pages/). */
export function nuxtCandidates(files) {
  const out = [];
  for (const root of ['pages', 'src/pages', 'app/pages']) {
    for (const file of findAll(files, new RegExp('^' + root + '/.*\\.vue$'))) {
      const parts = file.slice(root.length + 1).replace(/\.vue$/, '').split('/');
      if (parts[parts.length - 1] === 'index') parts.pop();
      out.push({ file, pattern: parts.map(bracketSegment), root, dir: file.slice(0, file.lastIndexOf('/')) });
    }
  }
  return out;
}

/** Astro: src/pages/**\/*.{astro,md,mdx,html}. */
export function astroCandidates(files) {
  const root = 'src/pages';
  return findAll(files, /^src\/pages\/.*\.(astro|md|mdx|html)$/).map((file) => {
    const parts = file.slice(root.length + 1).replace(/\.(astro|md|mdx|html)$/, '').split('/');
    if (parts[parts.length - 1] === 'index') parts.pop();
    return { file, pattern: parts.map(bracketSegment), root, dir: file.slice(0, file.lastIndexOf('/')) };
  });
}

/** SvelteKit: src/routes/**\/+page.svelte with (groups), [slug], [...rest], [[opt]]. */
export function svelteKitCandidates(files) {
  const root = 'src/routes';
  return findAll(files, /^src\/routes\/(.*\/)?\+page(@[^./]*)?\.(svelte|md|svx)$/).map((file) => {
    const rel = file.slice(root.length + 1).replace(/\/?\+page(@[^./]*)?\.(svelte|md|svx)$/, '');
    const raw = rel ? rel.split('/') : [];
    const pattern = [];
    for (const s of raw) {
      if (/^\(.+\)$/.test(s)) continue; // group
      pattern.push(bracketSegment(s));
    }
    return { file, pattern, root, dir: file.slice(0, file.lastIndexOf('/')) };
  });
}

/** Split a Remix flat-route name on '.' while keeping `[escaped.literals]` together. */
export function splitFlatSegments(name) {
  const out = [];
  let current = '';
  let depth = 0;
  for (const ch of String(name)) {
    if (ch === '[') { depth++; current += ch; continue; }
    if (ch === ']') { depth = Math.max(0, depth - 1); current += ch; continue; }
    if (ch === '.' && depth === 0) { out.push(current); current = ''; continue; }
    current += ch;
  }
  out.push(current);
  return out.filter((s) => s !== '');
}

/** Remix v2 / React Router 7 flat routes (app/routes/products.$handle.tsx, _index, $, (optional)). */
export function remixFlatCandidates(files, appDir = 'app') {
  const root = appDir + '/routes';
  const out = [];
  const seen = new Set();
  for (const file of findAll(files, new RegExp('^' + root + '/'))) {
    const rel = file.slice(root.length + 1);
    let routeName = null;
    if (/^[^/]+\.(jsx?|tsx?|mdx)$/.test(rel)) routeName = rel.replace(/\.(jsx?|tsx?|mdx)$/, '');
    else {
      const m = /^([^/]+)\/(route|index)\.(jsx?|tsx?|mdx)$/.exec(rel);
      if (m) routeName = m[1];
    }
    if (routeName === null || seen.has(routeName)) continue;
    seen.add(routeName);
    const parts = splitFlatSegments(routeName);
    const pattern = [];
    let skip = false;
    for (let i = 0; i < parts.length; i++) {
      let part = parts[i];
      if (part === '_index') continue;                    // index route: no extra segment
      if (part.startsWith('_')) continue;                 // pathless layout segment
      if (part.endsWith('_')) part = part.slice(0, -1);   // opts out of layout nesting, same URL
      const optional = /^\(.+\)$/.test(part);
      if (optional) part = part.slice(1, -1);
      if (part === '$') { pattern.push(seg('catchall', null, 'splat')); continue; }
      if (part.startsWith('$')) {
        pattern.push(optional ? seg('optional', null, part.slice(1)) : seg('dynamic', null, part.slice(1)));
        continue;
      }
      const literal = part.replace(/\[(.+?)\]/g, '$1');
      pattern.push(optional ? seg('optional', literal, null) : seg('static', literal));
    }
    if (skip) continue;
    out.push({ file, pattern, root, dir: file.slice(0, file.lastIndexOf('/')) });
  }
  return out;
}

const ROUTE_CALLS = new Set(['route', 'index', 'layout', 'prefix']);

/**
 * Parse a React Router 7 `app/routes.ts` config into [{path, file, kind}].
 * A deliberately small scanner: it tracks strings, parentheses and brackets so that
 * `prefix("blog", [route(":slug", "routes/post.tsx")])` nests correctly, and ignores everything
 * else in the file. Anything it cannot read simply produces no candidates (never a wrong one).
 */
export function parseRoutesConfig(source) {
  const src = String(source == null ? '' : source);
  const frames = [];
  const results = [];
  let i = 0;

  // A frame's URL prefix is computed when a *child* opens, not when the frame closes: children
  // close first, and by the time one opens its parent's path argument has already been scanned.
  const childPathOf = (frame) => (frame.name === 'route' || frame.name === 'prefix'
    ? joinRoutePath(frame.inherited, frame.args[0] || '')
    : frame.inherited);

  const pushResult = (frame) => {
    const inherited = frame.inherited;
    if (frame.name === 'index') {
      if (frame.args[0]) results.push({ path: inherited || '/', file: frame.args[0], kind: 'index' });
    } else if (frame.name === 'route') {
      if (frame.args[1]) results.push({ path: joinRoutePath(inherited, frame.args[0] || ''), file: frame.args[1], kind: 'route' });
    } else if (frame.name === 'layout') {
      if (frame.args[0]) results.push({ path: inherited || '/', file: frame.args[0], kind: 'layout' });
    }
  };

  while (i < src.length) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl; continue; }
    if (ch === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i); i = end === -1 ? src.length : end + 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      let value = '';
      while (j < src.length) {
        if (src[j] === '\\') { value += src[j + 1] || ''; j += 2; continue; }
        if (src[j] === quote) break;
        value += src[j];
        j++;
      }
      const top = frames[frames.length - 1];
      if (top && top.inner === 0) top.args.push(value);
      i = j + 1;
      continue;
    }
    const idMatch = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i));
    if (idMatch) {
      const name = idMatch[0];
      let j = i + name.length;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === '(' && ROUTE_CALLS.has(name)) {
        const parent = frames.length ? frames[frames.length - 1] : null;
        const frame = { name, args: [], inner: 0, parent, inherited: parent ? childPathOf(parent) : '' };
        // the frame's own '(' does not count as inner nesting
        if (parent) parent.inner++;
        frames.push(frame);
        i = j + 1;
        continue;
      }
      i += name.length;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      const top = frames[frames.length - 1];
      if (top) top.inner++;
      i++;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      const top = frames[frames.length - 1];
      if (top && top.inner > 0) { top.inner--; i++; continue; }
      if (top && ch === ')') {
        frames.pop();
        if (top.parent) top.parent.inner--;
        pushResult(top);
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (ch === ',' ) {
      const top = frames[frames.length - 1];
      if (top && top.inner === 0 && top.args.length === 0 && top.name === 'index') { /* keep */ }
      i++;
      continue;
    }
    i++;
  }
  // close anything the scanner never saw a ')' for, so a truncated file still yields what it can
  while (frames.length) {
    const f = frames.pop();
    if (f.parent) f.parent.inner = Math.max(0, f.parent.inner - 1);
    pushResult(f);
  }
  return results;
}

function joinRoutePath(parent, child) {
  const c = String(child || '').trim();
  if (c.startsWith('/')) return c === '/' ? '/' : c.replace(/\/+$/, '');
  const p = String(parent || '').replace(/\/+$/, '');
  if (!c) return p || '/';
  return (p ? p : '') + '/' + c;
}

/** Route-config entries as match candidates (`:param` -> dynamic, `*` -> catch-all). */
export function routesConfigCandidates(entries, appDir = 'app') {
  const out = [];
  for (const entry of entries) {
    if (entry.kind === 'layout') continue;
    const parts = String(entry.path || '/').split('/').filter(Boolean);
    const pattern = parts.map((p) => {
      if (p === '*') return seg('catchall', null, 'splat');
      if (p.startsWith(':')) return p.endsWith('?') ? seg('optional', null, p.slice(1, -1)) : seg('dynamic', null, p.slice(1));
      return seg('static', p);
    });
    const file = entry.file.startsWith(appDir + '/') ? entry.file : appDir + '/' + entry.file.replace(/^\.\//, '');
    out.push({ file, pattern, root: appDir, dir: file.slice(0, file.lastIndexOf('/')), bonus: 1, kind: entry.kind });
  }
  return out;
}

/** Gatsby: src/pages/** (templates are a low-confidence fallback, matched by slug elsewhere). */
export function gatsbyCandidates(files) {
  const root = 'src/pages';
  return findAll(files, /^src\/pages\/.*\.(jsx?|tsx?|mdx?|markdown)$/).map((file) => {
    const parts = file.slice(root.length + 1).replace(/\.(jsx?|tsx?|mdx?|markdown)$/, '').split('/');
    if (parts[parts.length - 1] === 'index') parts.pop();
    return { file, pattern: parts.map((p) => (p.startsWith('{') ? seg('dynamic', null, p) : bracketSegment(p))), root, dir: file.slice(0, file.lastIndexOf('/')) };
  });
}

/** A Gatsby `Head` export only takes effect in a page or a template component. */
export function isGatsbyHeadCapable(file) {
  return /^src\/(pages|templates)\//.test(String(file || ''));
}

// ---------------------------------------------------------------------------
// Content-file frameworks (front matter decides the URL)

const MAX_FM_READS = 400;

function readFrontmatterFor(projectRoot, file) {
  try {
    const text = readFileSync(join(projectRoot, file.split('/').join(sep)), 'utf8');
    return parseFrontmatter(text);
  } catch { return { present: false, data: {} }; }
}

/** Hugo: content/<section>/<slug>.md, page bundles (index.md) and section indexes (_index.md). */
export function hugoCandidates(projectRoot, files) {
  const out = [];
  const contentFiles = findAll(files, /^content\/.*\.(md|markdown|html)$/).slice(0, MAX_FM_READS);
  for (const file of contentFiles) {
    const rel = file.slice('content/'.length).replace(/\.(md|markdown|html)$/, '');
    const parts = rel.split('/');
    const last = parts[parts.length - 1];
    if (last === '_index' || last === 'index') parts.pop();
    let pattern = parts.map((p) => seg('static', p));
    const fm = readFrontmatterFor(projectRoot, file);
    const url = fm.present && typeof fm.data.url === 'string' ? fm.data.url : null;
    const slug = fm.present && typeof fm.data.slug === 'string' ? fm.data.slug : null;
    if (url) pattern = pathSegments(url).map((p) => seg('static', p));
    else if (slug && parts.length) { parts[parts.length - 1] = slug; pattern = parts.map((p) => seg('static', p)); }
    out.push({ file, pattern, root: 'content', dir: file.slice(0, file.lastIndexOf('/')), frontmatter: fm });
  }
  return out;
}

/** Jekyll: _posts/YYYY-MM-DD-slug.md, top-level pages, _pages/, honouring a `permalink:`. */
export function jekyllCandidates(projectRoot, files) {
  const out = [];
  const list = findAll(files, /^(_posts|_pages)\/.*\.(md|markdown|html)$/).concat(
    findAll(files, /^[^/]+\.(md|markdown|html)$/).filter((f) => !/^(README|LICENSE|CONTRIBUTING|CHANGELOG)\./i.test(f)),
    findAll(files, /^[^_.][^/]*\/.*\.(md|markdown|html)$/).filter((f) => !/^(_site|node_modules|assets|vendor)\//.test(f)),
  ).slice(0, MAX_FM_READS);
  for (const file of list) {
    const fm = readFrontmatterFor(projectRoot, file);
    const permalink = fm.present && typeof fm.data.permalink === 'string' ? fm.data.permalink : null;
    let pattern;
    if (permalink) {
      pattern = pathSegments(permalink.replace(/:title/g, '').replace(/:[a-z_]+/g, '')).map((p) => seg('static', p));
    } else if (file.startsWith('_posts/')) {
      const m = /^_posts\/(\d{4})-(\d{2})-(\d{2})-(.+)\.(md|markdown|html)$/.exec(file);
      if (!m) continue;
      const slug = (fm.present && typeof fm.data.slug === 'string' ? fm.data.slug : m[4]);
      // default permalink is /:categories/:year/:month/:day/:title; the slug is what a URL is matched on
      pattern = [seg('static', m[1]), seg('static', m[2]), seg('static', m[3]), seg('static', slug)];
      out.push({ file, pattern, root: '_posts', dir: '_posts', frontmatter: fm, alt: [[seg('static', slug)]] });
      continue;
    } else {
      const rel = file.replace(/^_pages\//, '').replace(/\.(md|markdown|html)$/, '');
      const parts = rel.split('/');
      if (parts[parts.length - 1] === 'index') parts.pop();
      pattern = parts.map((p) => seg('static', p));
    }
    out.push({ file, pattern, root: file.split('/')[0], dir: file.slice(0, file.lastIndexOf('/')), frontmatter: fm });
  }
  return out;
}

/** Eleventy input directory from the config (default: the project root). */
export function eleventyInputDir(projectRoot, files) {
  const config = find(files, CONFIG_PATTERNS.eleventy);
  if (!config) return has(files, /^src\//) ? 'src' : '.';
  try {
    const text = readFileSync(join(projectRoot, config), 'utf8');
    const m = /input\s*:\s*["'`]([^"'`]+)["'`]/.exec(text);
    if (m) return m[1].replace(/^\.\//, '').replace(/\/$/, '') || '.';
  } catch { /* fall through */ }
  return has(files, /^src\//) ? 'src' : '.';
}

/** Eleventy: template files under the input dir, honouring a `permalink:` in front matter. */
export function eleventyCandidates(projectRoot, files, inputDir) {
  const prefix = inputDir && inputDir !== '.' ? inputDir + '/' : '';
  const re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?!_includes/|_data/|_site/)(.*)\\.(md|njk|liquid|html|11ty\\.js)$');
  const out = [];
  for (const file of files) {
    const m = re.exec(file);
    if (!m) continue;
    const fm = readFrontmatterFor(projectRoot, file);
    const permalink = fm.present && typeof fm.data.permalink === 'string' ? fm.data.permalink : null;
    const parts = permalink ? pathSegments(permalink) : (() => {
      const p = m[1].split('/');
      if (p[p.length - 1] === 'index') p.pop();
      return p;
    })();
    out.push({ file, pattern: parts.map((p) => seg('static', p)), root: inputDir, dir: file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '', frontmatter: fm });
  }
  return out.slice(0, MAX_FM_READS);
}

/** Plain HTML: <path>/index.html or <path>.html under the project root (or a docroot). */
export function staticCandidates(files, docroot = '') {
  const prefix = docroot ? docroot.replace(/\/$/, '') + '/' : '';
  return files.filter((f) => f.startsWith(prefix) && /\.x?html?$/i.test(f)).map((file) => {
    const rel = file.slice(prefix.length).replace(/\.x?html?$/i, '');
    const parts = rel.split('/');
    if (parts[parts.length - 1] === 'index') parts.pop();
    return { file, pattern: parts.map((p) => seg('static', p)), root: docroot || '.', dir: file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '' };
  });
}

// ---------------------------------------------------------------------------
// Site-wide files

const siteFile = (files, patterns) => {
  for (const p of patterns) {
    const hit = typeof p === 'string' ? (files.includes(p) ? p : null) : find(files, p);
    if (hit) return { path: hit, exists: true };
  }
  // nothing on disk: name the conventional location (the first plain-string pattern) so a caller can
  // offer to create it, and say plainly that it is not there yet.
  const convention = patterns.find((p) => typeof p === 'string');
  return convention ? { path: convention, exists: false } : null;
};

/**
 * Where the site-wide knobs live for a framework: the file that owns `<html lang>`, robots,
 * the sitemap and the site config. `exists: false` means "this is the conventional location and it
 * is not there" — a caller may create it, but it must say so.
 */
export function siteWideFor(framework, files, { appDir = 'app', inputDir = '.' } = {}) {
  switch (framework) {
    case 'nextjs': {
      const appRoot = has(files, /^src\/app\//) ? 'src/app' : 'app';
      const pagesRoot = has(files, /^src\/pages\//) ? 'src/pages' : 'pages';
      const router = nextRouter(files);
      return {
        lang_file: router === 'pages'
          ? siteFile(files, [new RegExp('^' + pagesRoot + '/_document\\.(jsx?|tsx?)$'), pagesRoot + '/_document.tsx'])
          : siteFile(files, [new RegExp('^' + appRoot + '/layout\\.(jsx?|tsx?)$'), appRoot + '/layout.tsx']),
        robots: siteFile(files, [new RegExp('^' + appRoot + '/robots\\.(js|ts)$'), 'public/robots.txt']),
        sitemap: siteFile(files, [new RegExp('^' + appRoot + '/sitemap\\.(js|ts)$'), 'public/sitemap.xml']),
        config: siteFile(files, [CONFIG_PATTERNS.nextjs, 'next.config.mjs']),
      };
    }
    case 'nuxt':
      return {
        lang_file: siteFile(files, [CONFIG_PATTERNS.nuxt, /^(app\/)?app\.vue$/, 'nuxt.config.ts']),
        robots: siteFile(files, ['public/robots.txt']),
        sitemap: siteFile(files, ['public/sitemap.xml']),
        config: siteFile(files, [CONFIG_PATTERNS.nuxt, 'nuxt.config.ts']),
      };
    case 'astro':
      return {
        lang_file: siteFile(files, [/^src\/layouts\/[^/]+\.astro$/, /^src\/pages\/index\.astro$/, 'src/layouts/Layout.astro']),
        robots: siteFile(files, ['public/robots.txt']),
        sitemap: siteFile(files, ['public/sitemap.xml']),
        config: siteFile(files, [CONFIG_PATTERNS.astro, 'astro.config.mjs']),
      };
    case 'sveltekit':
      return {
        lang_file: siteFile(files, ['src/app.html']),
        robots: siteFile(files, ['static/robots.txt', /^src\/routes\/robots\.txt\/\+server\.(js|ts)$/]),
        sitemap: siteFile(files, [/^src\/routes\/sitemap\.xml\/\+server\.(js|ts)$/, 'static/sitemap.xml']),
        config: siteFile(files, [CONFIG_PATTERNS.sveltekit, 'svelte.config.js']),
      };
    case 'react-router':
      return {
        lang_file: siteFile(files, [new RegExp('^' + appDir + '/root\\.(jsx?|tsx?)$'), appDir + '/root.tsx']),
        robots: siteFile(files, ['public/robots.txt']),
        sitemap: siteFile(files, ['public/sitemap.xml']),
        config: siteFile(files, [CONFIG_PATTERNS['react-router'], 'react-router.config.ts']),
      };
    case 'gatsby':
      return {
        lang_file: siteFile(files, [/^src\/html\.(jsx?|tsx?)$/, CONFIG_PATTERNS.gatsby, 'gatsby-config.js']),
        robots: siteFile(files, ['static/robots.txt']),
        sitemap: siteFile(files, ['static/sitemap.xml']),
        config: siteFile(files, [CONFIG_PATTERNS.gatsby, 'gatsby-config.js']),
      };
    case 'hugo':
      return {
        lang_file: siteFile(files, ['layouts/_default/baseof.html', 'layouts/baseof.html', CONFIG_PATTERNS.hugo, 'hugo.toml']),
        robots: siteFile(files, ['static/robots.txt', 'layouts/robots.txt']),
        sitemap: siteFile(files, ['layouts/sitemap.xml', 'static/sitemap.xml']),
        config: siteFile(files, [CONFIG_PATTERNS.hugo, 'hugo.toml']),
      };
    case 'jekyll':
      return {
        lang_file: siteFile(files, ['_layouts/default.html', '_includes/head.html', '_layouts/default.htm']),
        robots: siteFile(files, ['robots.txt']),
        sitemap: siteFile(files, ['sitemap.xml']),
        config: siteFile(files, [CONFIG_PATTERNS.jekyll, '_config.yml']),
      };
    case 'eleventy': {
      const prefix = inputDir && inputDir !== '.' ? inputDir + '/' : '';
      return {
        lang_file: siteFile(files, [new RegExp('^' + prefix + '_includes/layouts/base\\.(njk|liquid|html)$'), new RegExp('^' + prefix + '_includes/base\\.(njk|liquid|html)$'), prefix + '_includes/layouts/base.njk']),
        robots: siteFile(files, [prefix + 'robots.txt', new RegExp('^' + prefix + 'robots\\.(njk|liquid)$')]),
        sitemap: siteFile(files, [new RegExp('^' + prefix + 'sitemap\\.xml(\\.njk|\\.liquid)?$')]),
        config: siteFile(files, [CONFIG_PATTERNS.eleventy, '.eleventy.js']),
      };
    }
    case 'static':
      return {
        lang_file: null,
        robots: siteFile(files, ['robots.txt']),
        sitemap: siteFile(files, ['sitemap.xml']),
        config: null,
      };
    default:
      return {
        lang_file: null,
        robots: siteFile(files, ['robots.txt', 'public/robots.txt', 'static/robots.txt']),
        sitemap: siteFile(files, ['sitemap.xml', 'public/sitemap.xml', 'static/sitemap.xml']),
        config: null,
      };
  }
}

// ---------------------------------------------------------------------------
// resolveRoute

const EMPTY_SITE_WIDE = Object.freeze({ lang_file: null, robots: null, sitemap: null, config: null });

function result(over) {
  return {
    framework: null, file: null, layout: null, strategy: 'manual', class: 'proposed',
    edit_target: 'file', route: null, params: null, site_wide: { ...EMPTY_SITE_WIDE },
    confidence: 'none', notes: [], ...over,
  };
}

/** Does a Next App Router file carry the literal `export const metadata = {` anchor? */
export function metadataAnchor(projectRoot, file) {
  try {
    const text = readFileSync(join(projectRoot, file.split('/').join(sep)), 'utf8');
    if (/export\s+const\s+metadata\s*[:=][^=]*=?\s*\{/.test(text) || /export\s+const\s+metadata\s*=\s*\{/.test(text)) {
      return { kind: 'metadata-object', present: true, generate: /export\s+(async\s+)?function\s+generateMetadata/.test(text) };
    }
    if (/export\s+(async\s+)?function\s+generateMetadata/.test(text)) return { kind: 'generateMetadata', present: false, generate: true };
    return { kind: null, present: false, generate: false };
  } catch { return { kind: null, present: false, generate: false }; }
}

/** Does a Pages Router file already render a `<Head>` an insertion can go inside? */
function nextHeadAnchor(projectRoot, file) {
  try {
    const text = readFileSync(join(projectRoot, file.split('/').join(sep)), 'utf8');
    return { present: /<Head[\s>]/.test(text), imports: /from\s+['"]next\/head['"]/.test(text) };
  } catch { return { present: false, imports: false }; }
}

/**
 * Map a URL path to the source file that renders it.
 *
 * @param {string} projectRoot  absolute path to the repository
 * @param {string} urlPath      '/blog/rain-shadow', or a full URL (the path is used)
 * @param {object} [profile]    platform profile from scripts/detect-platform.mjs (framework hint)
 * @param {object} [opts]       { files } to reuse a scan
 * @returns {{framework, file, layout, strategy, class, edit_target, route, params, site_wide, confidence, notes}}
 */
export function resolveRoute(projectRoot, urlPath, profile = null, opts = {}) {
  const root = resolve(projectRoot || '.');
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return result({ notes: ['project root not found: ' + root] });
  }
  const files = Array.isArray(opts.files) ? opts.files : scanProject(root, opts);
  const fw = detectFramework(files, profile);
  const segments = pathSegments(urlPath);
  const notes = [];
  let framework = fw.id;

  if (framework === 'payload') {
    notes.push('Payload renders through its Next.js front end: route files follow the Next rules; SEO fields on a collection are a page-api change, not a file edit');
    framework = nextRouter(files) ? 'nextjs' : framework;
  }
  if (framework === 'docusaurus') {
    notes.push('Docusaurus pages are Markdown under docs/ or blog/ with front matter');
    framework = 'docusaurus';
  }

  const appDir = has(files, /^app\/routes/) || has(files, /^app\/root\./) ? 'app' : 'app';
  const inputDir = framework === 'eleventy' ? eleventyInputDir(root, files) : '.';
  const site_wide = siteWideFor(framework, files, { appDir, inputDir });
  const base = { framework, site_wide, notes };

  if (!framework) {
    notes.push('no framework config found in ' + root + '; pass --project pointing at the repository root, or fix through the instructions adapter');
    return result(base);
  }

  let candidates = [];
  let strategy = 'manual';
  let edit_target = 'file';
  let layoutNames = /^layout\.(jsx?|tsx?)$/;

  switch (framework) {
    case 'nextjs': {
      const router = fw.router || nextRouter(files);
      if (router === 'app') { candidates = nextAppCandidates(files); strategy = 'metadata-object'; }
      else { candidates = nextPagesCandidates(files); strategy = 'next-head-jsx'; }
      if (!candidates.length) {
        candidates = router === 'app' ? nextPagesCandidates(files) : nextAppCandidates(files);
        if (candidates.length) { strategy = router === 'app' ? 'next-head-jsx' : 'metadata-object'; notes.push('router hint said "' + router + '" but the matching files are the other router'); }
      }
      break;
    }
    case 'nuxt': candidates = nuxtCandidates(files); strategy = 'use-seo-meta'; break;
    case 'astro': candidates = astroCandidates(files); strategy = 'html-head'; break;
    case 'sveltekit': candidates = svelteKitCandidates(files); strategy = 'svelte-head'; layoutNames = /^\+layout\.(svelte|js|ts)$/; break;
    case 'react-router': {
      const configFile = find(files, new RegExp('^' + appDir + '/routes\\.(ts|js|tsx|jsx)$'));
      if (configFile) {
        let parsed = [];
        try { parsed = parseRoutesConfig(readFileSync(join(root, configFile.split('/').join(sep)), 'utf8')); } catch { parsed = []; }
        candidates = routesConfigCandidates(parsed, appDir);
        if (candidates.length) notes.push('routes resolved from ' + configFile + ' (config-based routing)');
      }
      if (!candidates.length) candidates = remixFlatCandidates(files, appDir);
      strategy = 'meta-export-array';
      break;
    }
    case 'gatsby': candidates = gatsbyCandidates(files); strategy = 'gatsby-head-export'; break;
    case 'hugo': candidates = hugoCandidates(root, files); strategy = 'front-matter'; break;
    case 'jekyll': candidates = jekyllCandidates(root, files); strategy = 'front-matter'; break;
    case 'eleventy': candidates = eleventyCandidates(root, files, inputDir); strategy = 'html-head'; edit_target = 'layout'; break;
    case 'docusaurus': candidates = staticCandidates(files, 'docs').concat(staticCandidates(files, 'blog')); strategy = 'front-matter'; break;
    case 'static': candidates = staticCandidates(files); strategy = 'html-head'; break;
    default: candidates = []; break;
  }

  let match = bestMatch(candidates, segments);

  // A URL that still carries its output extension (/2026/01/14/post.html, /about.htm) maps to the
  // same source file as the extension-less form; try that before giving up.
  if (!match && segments.length && /\.x?html?$/i.test(segments[segments.length - 1])) {
    const bare = segments[segments.length - 1].replace(/\.x?html?$/i, '');
    const trimmed = segments.slice(0, -1).concat(bare);
    match = bestMatch(candidates, trimmed) || (bare === 'index' ? bestMatch(candidates, segments.slice(0, -1)) : null);
    if (match) notes.push('matched after dropping the .html output extension from the URL');
  }

  // Jekyll posts also answer to their bare slug when the site uses a shortened permalink style.
  if (!match && framework === 'jekyll') {
    const alt = [];
    for (const c of candidates) for (const p of c.alt || []) alt.push({ ...c, pattern: p });
    match = bestMatch(alt, segments);
    if (match) notes.push('matched by post slug: the permalink style in _config.yml decides the real URL');
  }

  // Gatsby: pages first, then templates (createPage decides the URL at build time, so this is a hint)
  if (!match && framework === 'gatsby') {
    const templates = findAll(files, /^src\/templates\/.*\.(jsx?|tsx?)$/);
    const slug = segments[segments.length - 1] || 'index';
    const guess = templates.find((f) => basename(f).replace(/\.(jsx?|tsx?)$/, '').toLowerCase().includes(String(slug).toLowerCase()))
      || (templates.length === 1 ? templates[0] : null);
    if (guess) {
      return result({
        ...base, file: guess, layout: null, strategy: 'gatsby-head-export', class: classFor('gatsby-head-export'),
        edit_target: 'file', route: null, params: null, confidence: 'low',
        notes: [...notes, 'no file under src/pages matches this URL; ' + guess + ' is a createPage template and is a guess — confirm it before writing',
          isGatsbyHeadCapable(guess) ? 'Head exports work here (page/template)' : 'a Head export outside src/pages or src/templates has no effect'],
      });
    }
  }

  if (!match) {
    notes.push('no ' + framework + ' route file matches ' + normalizePath(urlPath) + ' (' + candidates.length + ' candidate route files scanned)');
    return result({ ...base, confidence: 'none' });
  }

  const file = match.candidate.file;
  const layout = ['nextjs', 'sveltekit'].includes(framework)
    ? nearestLayout(files, match.candidate.dir, match.candidate.root, layoutNames)
    : (framework === 'eleventy' ? (site_wide.lang_file && site_wide.lang_file.exists ? site_wide.lang_file.path : null)
      : (framework === 'astro' ? find(files, /^src\/layouts\/[^/]+\.astro$/) : null));

  // strategy refinements that depend on the file's own text
  let anchor = null;
  if (framework === 'nextjs' && strategy === 'metadata-object') {
    anchor = metadataAnchor(root, file);
    notes.push(anchor.present
      ? 'literal `export const metadata = {` found — keys can be merged into the existing object'
      : (anchor.generate ? 'the route exports generateMetadata(): the edit goes inside its return value' : 'no metadata export yet: one has to be added'));
    notes.push('metadata-object edits stay `proposed`: a TS/JSX object is not an exact-anchor text edit (CLASS RULE)');
  }
  if (framework === 'nextjs' && strategy === 'next-head-jsx') {
    anchor = nextHeadAnchor(root, file);
    notes.push(anchor.present ? 'an existing <Head> was found: tags are added inside it' : 'no <Head> in this file: the import and the element have to be created');
  }
  if (framework === 'sveltekit') notes.push('<svelte:head> edits stay `proposed` under the CLASS RULE, even for static tags');
  if (framework === 'hugo') {
    const projectPartial = files.includes('layouts/partials/head.html');
    notes.push(projectPartial
      ? 'site-wide head tags go in layouts/partials/head.html'
      : 'no layouts/partials/head.html in the project: copy the theme partial into layouts/ first — never edit themes/');
  }
  if (framework === 'jekyll') {
    const config = site_wide.config && site_wide.config.exists ? site_wide.config.path : null;
    let seoTag = false;
    if (config) { try { seoTag = /jekyll-seo-tag/.test(readFileSync(join(root, config), 'utf8')); } catch { seoTag = false; } }
    if (seoTag) notes.push('jekyll-seo-tag owns the head: set front-matter keys (title, description, image) instead of adding tags to _includes/head.html');
  }
  if (framework === 'gatsby') {
    notes.push(isGatsbyHeadCapable(file) ? 'Head exports work here (page/template)' : 'a Head export outside src/pages or src/templates has no effect');
  }
  if (framework === 'eleventy') notes.push('per-page values come from front matter in ' + file + '; shared head tags go in the base layout');

  const dynamic = match.candidate.pattern.some((p) => p.kind !== 'static');
  const out = result({
    ...base,
    file,
    layout: layout || null,
    strategy,
    class: classFor(strategy),
    edit_target,
    route: { pattern: patternToString(match.candidate.pattern), path: normalizePath(urlPath), dynamic, kind: match.candidate.kind || 'page' },
    params: match.params,
    confidence: fw.confidence === 'low' ? 'low' : (dynamic ? 'medium' : 'high'),
  });
  if (anchor) out.anchor = anchor;
  return out;
}

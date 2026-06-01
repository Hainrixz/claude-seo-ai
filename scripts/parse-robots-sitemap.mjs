#!/usr/bin/env node
// Parse robots.txt (incl. AI-crawler posture) and XML sitemaps. Backs M1 (crawlability),
// M14 (AI crawlers), M17 (sitemaps).
//
// Usage: node parse-robots-sitemap.mjs --url https://example.com   (fetches /robots.txt + first sitemap)
//        node parse-robots-sitemap.mjs --robots https://example.com/robots.txt
//        node parse-robots-sitemap.mjs --sitemap https://example.com/sitemap.xml
//        node parse-robots-sitemap.mjs --file ./robots.txt

import { readFileSync } from 'node:fs';
import { parseArgs, emit, fetchText } from './lib/util.mjs';

const AI_BOTS = {
  training: ['GPTBot', 'ClaudeBot', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'Meta-ExternalAgent', 'Bytespider'],
  retrieval: ['OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot'],
  user: ['ChatGPT-User', 'Perplexity-User', 'Claude-User'],
  search: ['Googlebot', 'Bingbot'],
};

function parseRobots(text) {
  const groups = []; // { agents:[], rules:[{type,path}], crawlDelay }
  const sitemaps = [];
  let cur = null, expectingAgent = false;
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!expectingAgent || !cur) { cur = { agents: [], rules: [], crawlDelay: null }; groups.push(cur); }
      cur.agents.push(value);
      expectingAgent = true;
    } else if (field === 'sitemap') {
      sitemaps.push(value);
    } else if (cur) {
      expectingAgent = false;
      if (field === 'disallow') cur.rules.push({ type: 'disallow', path: value });
      else if (field === 'allow') cur.rules.push({ type: 'allow', path: value });
      else if (field === 'crawl-delay') cur.crawlDelay = value;
    }
  }
  return { groups, sitemaps };
}

// Is `agent` fully blocked? (Disallow: / in its own group, else in the * group.)
function agentBlocked(robots, agent) {
  const lc = agent.toLowerCase();
  const own = robots.groups.find((g) => g.agents.some((a) => a.toLowerCase() === lc));
  const star = robots.groups.find((g) => g.agents.includes('*'));
  const grp = own || star;
  if (!grp) return { blocked: false, via: 'no-rule' };
  const blocked = grp.rules.some((r) => r.type === 'disallow' && (r.path === '/' || r.path === ''));
  const fullBlock = grp.rules.some((r) => r.type === 'disallow' && r.path === '/');
  return { blocked: fullBlock, via: own ? 'explicit' : 'wildcard', anyDisallow: blocked };
}

function aiPosture(robots) {
  const out = {};
  for (const [cls, bots] of Object.entries(AI_BOTS)) {
    out[cls] = {};
    for (const b of bots) { const r = agentBlocked(robots, b); out[cls][b] = r.blocked ? 'blocked' : 'allowed'; }
  }
  return out;
}

function parseSitemap(xml) {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1]);
  const lastmods = (xml.match(/<lastmod>/gi) || []).length;
  const images = (xml.match(/<image:image>/gi) || []).length;
  const videos = (xml.match(/<video:video>/gi) || []).length;
  return {
    kind: isIndex ? 'sitemapindex' : 'urlset',
    url_count: locs.length,
    lastmod_count: lastmods,
    has_image_ext: images > 0,
    has_video_ext: videos > 0,
    over_url_limit: locs.length > 50000,
    sample: locs.slice(0, 5),
  };
}

const args = parseArgs();

if (args.sitemap) {
  const r = await fetchText(args.sitemap);
  if (!r.ok) emit({ error: 'sitemap fetch failed', status: r.status, detail: r.error }, 1);
  emit({ target: args.sitemap, sitemap: parseSitemap(r.text) });
}

let robotsText, robotsUrl = null;
if (args.file) {
  try { robotsText = readFileSync(args.file, 'utf8'); } catch (e) { emit({ error: String(e && e.message || e) }, 1); }
} else {
  robotsUrl = args.robots || (args.url ? new URL('/robots.txt', args.url).href : null);
  if (!robotsUrl) emit({ error: 'provide --url, --robots, --sitemap, or --file' }, 1);
  const r = await fetchText(robotsUrl);
  if (!r.ok && r.status !== 404) emit({ robots_url: robotsUrl, error: 'fetch failed', status: r.status, detail: r.error }, 1);
  robotsText = r.status === 404 ? '' : r.text;
  if (r.status === 404) emit({ robots_url: robotsUrl, exists: false, note: 'no robots.txt (all crawlable by default)' });
}

const robots = parseRobots(robotsText);
const result = {
  robots_url: robotsUrl,
  exists: true,
  groups: robots.groups.length,
  sitemaps_declared: robots.sitemaps,
  ai_posture: aiPosture(robots),
  wildcard_disallow_all: robots.groups.some((g) => g.agents.includes('*') && g.rules.some((r) => r.type === 'disallow' && r.path === '/')),
};

// Heuristic: any Disallow targeting CSS/JS assets (breaks rendering).
const blocksAssets = robots.groups.some((g) => g.rules.some((r) => r.type === 'disallow' && /\.(css|js)(\b|\/|$)|\/(assets|static|_next|js|css)\b/i.test(r.path)));
result.may_block_render_assets = blocksAssets;

if (args.url && robots.sitemaps.length) {
  const r = await fetchText(robots.sitemaps[0]);
  if (r.ok) result.first_sitemap = { url: robots.sitemaps[0], ...parseSitemap(r.text) };
}

emit(result);

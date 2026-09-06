// AI / search crawler user-agent table. Mirrors references/ai-crawlers.md — keep the two in sync.
//
// Classes: training (model training corpora) · retrieval (search index / live answers, may cite)
// · user (fetch triggered by a person's request) · search (classic engine) · other (ads etc.).
// `doc_url` is null where no vendor page was verified — a row without a source may be listed
// but must never back an `established` finding. `robots_reliability` records whether the
// vendor documents honoring robots.txt ('documented'), documents that it may bypass it
// ('limited'), is widely reported to ignore it ('unreliable'), or is unverified ('unknown').

export const UA_TABLE_VERSION = '2026-09';

export const BOT_CLASSES = Object.freeze(['training', 'retrieval', 'user', 'search', 'other']);

const GOOGLE_DOC = 'https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers';
const OPENAI_DOC = 'https://developers.openai.com/api/docs/bots';
// Anthropic publishes its crawler list machine-readably; the support article URL moved domains
// (support.anthropic.com -> support.claude.com) — TODO-verify the current article URL before citing it.
const ANTHROPIC_DOC = 'https://claude.com/crawling/bots.json';
const PERPLEXITY_DOC = 'https://docs.perplexity.ai/guides/bots';
const APPLE_DOC = 'https://support.apple.com/en-us/119829';
const META_DOC = 'https://developers.facebook.com/docs/sharing/webmasters/web-crawlers';

/** @type {ReadonlyArray<{name:string, vendor:string, class:string, purpose:string, doc_url:string|null, robots_reliability:string, legacy?:boolean}>} */
export const BOTS = Object.freeze([
  // --- training ---
  { name: 'GPTBot', vendor: 'OpenAI', class: 'training', purpose: 'model training', doc_url: OPENAI_DOC, robots_reliability: 'documented' },
  { name: 'ClaudeBot', vendor: 'Anthropic', class: 'training', purpose: 'model training', doc_url: ANTHROPIC_DOC, robots_reliability: 'documented' },
  { name: 'Google-Extended', vendor: 'Google', class: 'training', purpose: 'Gemini training / grounding control token — does NOT affect AI Overviews or AI Mode', doc_url: GOOGLE_DOC, robots_reliability: 'documented' },
  { name: 'Applebot-Extended', vendor: 'Apple', class: 'training', purpose: 'Apple Intelligence training control token', doc_url: APPLE_DOC, robots_reliability: 'documented' },
  { name: 'CCBot', vendor: 'Common Crawl', class: 'training', purpose: 'open crawl corpus used by many model trainers', doc_url: 'https://commoncrawl.org/ccbot', robots_reliability: 'documented' },
  { name: 'Meta-ExternalAgent', vendor: 'Meta', class: 'training', purpose: 'model training', doc_url: META_DOC, robots_reliability: 'documented' },
  // TODO-verify: no ByteDance vendor page located for Bytespider; widely reported to ignore robots.txt.
  { name: 'Bytespider', vendor: 'ByteDance', class: 'training', purpose: 'training + search', doc_url: null, robots_reliability: 'unreliable' },
  // TODO-verify: no Cohere vendor page located for the cohere-ai token.
  { name: 'cohere-ai', vendor: 'Cohere', class: 'training', purpose: 'model training', doc_url: null, robots_reliability: 'unknown' },
  // --- retrieval (search index / live answers; may cite) ---
  { name: 'OAI-SearchBot', vendor: 'OpenAI', class: 'retrieval', purpose: 'ChatGPT search index and citations', doc_url: OPENAI_DOC, robots_reliability: 'documented' },
  { name: 'Claude-SearchBot', vendor: 'Anthropic', class: 'retrieval', purpose: 'Claude search index and citations', doc_url: ANTHROPIC_DOC, robots_reliability: 'documented' },
  { name: 'PerplexityBot', vendor: 'Perplexity', class: 'retrieval', purpose: 'Perplexity index and citations', doc_url: PERPLEXITY_DOC, robots_reliability: 'documented' },
  { name: 'Amazonbot', vendor: 'Amazon', class: 'retrieval', purpose: 'Alexa / Amazon answer surfaces', doc_url: 'https://developer.amazon.com/amazonbot', robots_reliability: 'documented' },
  { name: 'Google-CloudVertexBot', vendor: 'Google', class: 'retrieval', purpose: 'Vertex AI Agents crawl, on the site owner\'s request', doc_url: GOOGLE_DOC, robots_reliability: 'documented' },
  { name: 'DuckAssistBot', vendor: 'DuckDuckGo', class: 'retrieval', purpose: 'DuckAssist answers', doc_url: 'https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot', robots_reliability: 'documented' },
  // --- user-triggered fetchers ---
  { name: 'ChatGPT-User', vendor: 'OpenAI', class: 'user', purpose: 'fetch on a ChatGPT user\'s request', doc_url: OPENAI_DOC, robots_reliability: 'documented' },
  { name: 'Perplexity-User', vendor: 'Perplexity', class: 'user', purpose: 'fetch on a Perplexity user\'s request', doc_url: PERPLEXITY_DOC, robots_reliability: 'limited' },
  { name: 'Claude-User', vendor: 'Anthropic', class: 'user', purpose: 'fetch on a Claude user\'s request', doc_url: ANTHROPIC_DOC, robots_reliability: 'documented' },
  // TODO-verify: legacy Anthropic token still seen in logs; current status undocumented.
  { name: 'Claude-Web', vendor: 'Anthropic', class: 'user', purpose: 'legacy user-fetch token', doc_url: null, robots_reliability: 'unknown' },
  { name: 'Meta-ExternalFetcher', vendor: 'Meta', class: 'user', purpose: 'fetch on a user\'s request — Meta documents it may bypass robots.txt', doc_url: META_DOC, robots_reliability: 'limited' },
  // TODO-verify: Mistral's exact bot documentation page.
  { name: 'MistralAI-User', vendor: 'Mistral', class: 'user', purpose: 'fetch on a Le Chat user\'s request', doc_url: null, robots_reliability: 'unknown' },
  // --- classic search ---
  { name: 'Googlebot', vendor: 'Google', class: 'search', purpose: 'Google Search index — the only gate for AI Overviews / AI Mode', doc_url: GOOGLE_DOC, robots_reliability: 'documented' },
  { name: 'Bingbot', vendor: 'Microsoft', class: 'search', purpose: 'Bing index (feeds Copilot)', doc_url: 'https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0', robots_reliability: 'documented' },
  { name: 'Applebot', vendor: 'Apple', class: 'search', purpose: 'Siri / Spotlight / Safari suggestions', doc_url: APPLE_DOC, robots_reliability: 'documented' },
  // --- other ---
  { name: 'OAI-AdsBot', vendor: 'OpenAI', class: 'other', purpose: 'ads landing-page validation', doc_url: OPENAI_DOC, robots_reliability: 'documented' },
]);

/**
 * Legacy shape used by parse-robots-sitemap's `ai_posture`: { class: [names...] }.
 * Order within a class is the table order above (legacy 15 first, then the 2026-09 additions).
 */
export const AI_BOTS = Object.freeze(Object.fromEntries(
  BOT_CLASSES.map((cls) => [cls, Object.freeze(BOTS.filter((b) => b.class === cls).map((b) => b.name))]),
));

const BY_LOWER = new Map(BOTS.map((b) => [b.name.toLowerCase(), b]));

/** Look a bot up by token, case-insensitively. Returns null when unknown. */
export function botByName(name) {
  if (!name) return null;
  return BY_LOWER.get(String(name).trim().toLowerCase()) || null;
}

/** Find the first known bot token inside a full User-Agent string (case-insensitive). */
export function botInUaString(ua) {
  if (!ua) return null;
  const lc = String(ua).toLowerCase();
  let best = null;
  for (const b of BOTS) {
    const i = lc.indexOf(b.name.toLowerCase());
    if (i !== -1 && (best === null || b.name.length > best.name.length)) best = b;
  }
  return best;
}

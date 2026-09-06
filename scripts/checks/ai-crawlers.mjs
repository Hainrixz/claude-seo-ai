// M14 — AI crawler access and Content-Signal, read from the run's site/robots.json.
//
// Two honesty rules are hard-coded here:
//   * Blocking Google-Extended is informational (pass, severity 1). Google documents that
//     Google-Extended controls Gemini/Vertex training, NOT whether a page can appear in AI
//     Overviews or AI Mode, so it is never reported as a citation loss.
//   * Content-Signal findings are never `established`. No vendor documents compliance with it and
//     the IETF draft expired; the preference is real, the enforcement is not.

import { BOTS } from '../lib/bots.mjs';
import { mk, push, clip, listing, plural, originOf } from './_shared.mjs';

/** Classes whose bots fetch a page in order to cite it in an answer. Training-only bots are not here. */
export const CITATION_CLASSES = ['retrieval', 'user'];

const botsIn = (classes) => BOTS.filter((b) => classes.includes(b.class));

/**
 * May this bot back an `established` claim? Only when the vendor publishes the token AND states that
 * it honours robots.txt. lib/bots.mjs records `doc_url: null` / `robots_reliability: 'unknown'` for
 * the tokens nobody documents (Claude-Web, MistralAI-User) and `'limited'` where the vendor says it
 * may bypass robots.txt (Meta-ExternalFetcher) — resting "each vendor documents its token and states
 * that it honours robots.txt" on one of those says something the repo cannot support.
 */
export const isDocumentedBot = (b) => !!(b && b.doc_url) && b.robots_reliability === 'documented';

/** Flatten site/robots.json ai_posture ({class: {bot: verdict}}) into one lookup. */
function postureIndex(robots) {
  const idx = new Map();
  const posture = (robots && robots.ai_posture) || {};
  for (const [, byBot] of Object.entries(posture)) {
    for (const [name, verdict] of Object.entries(byBot || {})) idx.set(name, verdict);
  }
  return idx;
}

function ruleText(v) {
  if (!v) return 'no verdict';
  if (v.rule) return (v.rule.line ? 'line ' + v.rule.line + ': ' : '') + (v.rule.type === 'allow' ? 'Allow: ' : 'Disallow: ') + v.rule.path;
  return 'no matching rule (via ' + v.via + ')';
}

export const check = {
  id: 'ai-crawlers',
  module: 'M14',
  scope: 'site',
  ids: [
    'M14.citation_bots.blocked', 'M14.retrieval.allowed', 'M14.google_extended.blocked_info',
    'M14.content_signal.ai_input_no', 'M14.content_signal.search_no', 'M14.content_signal.ai_train_no',
    'M14.content_signal.malformed', 'M14.content_signal.absent',
  ],

  run(ctx) {
    const out = [];
    const robots = ctx.site && ctx.site.robots;
    const origin = originOf(ctx);
    const robotsUrl = (robots && robots.url) || (origin ? origin + '/robots.txt' : '/robots.txt');
    const auditedPath = (() => {
      const t = (ctx.crawl && ctx.crawl.target) || (ctx.pages && ctx.pages[0] && ctx.pages[0].url);
      try { return t ? new URL(t).pathname : '/'; } catch { return '/'; }
    })();
    const repro = { script: 'parse-robots-sitemap.mjs', args: { url: robotsUrl, path: auditedPath } };

    if (!robots) {
      push(out, mk({
        id: 'M14.citation_bots.blocked', title: 'AI crawler access was not measured (no robots artifact)', status: 'needs_api', scope: 'site',
        evidence: { observed: 'No site/robots.json in ' + ctx.run_dir + ', so no per-bot verdict could be resolved.' },
        expected: 'A run that fetches /robots.txt and records a verdict per AI crawler.',
        recommendation: 'Re-run the crawl without --artifacts none so robots.txt is fetched.',
        fixable: 'advisory',
        verification: { method: 'robots_parse', assertion: 'site/robots.json exists and carries an ai_posture block.' },
        reproduce: repro,
        expected_impact: { axis: 'ai', confidence: 'established', rationale: 'Access is decided by a file that was not read; reporting it as open would be an assumption.' },
      }));
      return out;
    }

    const posture = postureIndex(robots);

    /* ---- citation bots ------------------------------------------------------------------------ */
    const citation = botsIn(CITATION_CLASSES);
    const blocked = citation.filter((b) => { const v = posture.get(b.name); return v && v.url_allowed === false; });
    if (blocked.length) {
      // A severity-4 `established` failure has to be true of every token it names. When the only
      // blocked tokens are legacy/undocumented ones the block is still real — it is just not
      // something a vendor's documentation speaks to, so the claim drops to `directional`.
      const documented = blocked.filter(isDocumentedBot);
      const undocumented = blocked.filter((b) => !isDocumentedBot(b));
      const describe = (b) => b.name + ' (' + b.vendor + ', ' + ruleText(posture.get(b.name))
        + (isDocumentedBot(b) ? '' : '; ' + (b.doc_url ? 'vendor does not document its robots.txt behaviour' : 'no vendor documentation')) + ')';
      push(out, mk({
        id: 'M14.citation_bots.blocked', title: 'robots.txt blocks crawlers that fetch pages in order to cite them', status: 'fail', severity: 4, scope: 'site',
        location: { url: robotsUrl, resource: 'robots.txt' },
        evidence: { observed: plural(blocked.length, 'citation crawler') + ' disallowed on ' + auditedPath + ': ' + listing(blocked.map(describe), 5) + '.'
          + (undocumented.length
            ? ' ' + listing(undocumented.map((b) => b.name), 4) + ' ' + (undocumented.length === 1 ? 'is a legacy or undocumented token' : 'are legacy or undocumented tokens')
              + ' (see references/ai-crawlers.md), so ' + (undocumented.length === 1 ? 'it is listed as evidence but does not' : 'they are listed as evidence but do not') + ' carry the claim.'
            : '') },
        expected: 'Retrieval and user-triggered AI crawlers may fetch the pages the site wants cited.',
        recommendation: 'Allow the tokens above in robots.txt if citation traffic is wanted. Keep training-only tokens (GPTBot, ClaudeBot, CCBot, Google-Extended) under separate rules — they are a different decision.',
        fixable: 'auto',
        verification: { method: 'robots_parse', assertion: 'isAllowed(robots, "<token>", "' + auditedPath + '") is true for each listed crawler.' },
        reproduce: repro,
        expected_impact: documented.length
          ? { axis: 'ai', confidence: 'established', rationale: 'Each token this rests on is published by its vendor, which also documents that the crawler honours robots.txt; that the block costs citations is the directional part, since no vendor publishes citation volumes.' }
          : { axis: 'ai', confidence: 'directional', rationale: 'Every blocked token here is a legacy or undocumented one — no vendor page, or no published robots.txt behaviour — so the block is observable but no vendor documents what it costs.' },
      }));
    } else if (citation.length) {
      push(out, mk({
        id: 'M14.retrieval.allowed', title: 'Retrieval and user-triggered AI crawlers may fetch the audited path', status: 'pass', severity: 4, scope: 'site',
        location: { url: robotsUrl, resource: 'robots.txt' },
        evidence: { observed: 'All ' + citation.length + ' citation-capable crawlers are allowed on ' + auditedPath + ': ' + listing(citation.map((b) => b.name), 6) + '.' },
        expected: 'No Disallow reaches the retrieval/user-class tokens on the audited path.',
        recommendation: 'Keep it this way, and review robots.txt whenever a new AI token is added to it.',
        fixable: 'advisory',
        verification: { method: 'robots_parse', assertion: 'Every retrieval/user-class token resolves to allowed:true for the audited path.' },
        reproduce: repro,
        expected_impact: { axis: 'ai', confidence: 'directional', rationale: 'Access is necessary for citation but not sufficient: no vendor documents how an allowed page is selected for an answer.' },
      }));
    }

    /* ---- Google-Extended --------------------------------------------------------------------- */
    const ge = posture.get('Google-Extended');
    if (ge && ge.url_allowed === false) {
      push(out, mk({
        id: 'M14.google_extended.blocked_info', title: 'Google-Extended is disallowed (training opt-out, not an AI-feature block)', status: 'pass', severity: 1, scope: 'site',
        location: { url: robotsUrl, resource: 'robots.txt' },
        evidence: { observed: 'Google-Extended is disallowed on ' + auditedPath + ' (' + ruleText(ge) + ').' },
        expected: 'Informational: this is a legitimate training preference.',
        recommendation: 'No action needed. Google documents Google-Extended as controlling Gemini and Vertex AI training data — it does not affect whether the page can appear in AI Overviews or AI Mode, which follow the normal Googlebot and snippet rules.',
        fixable: 'advisory',
        verification: { method: 'robots_parse', assertion: 'Google-Extended is disallowed while Googlebot remains allowed.' },
        reproduce: repro,
        expected_impact: { axis: 'ai', confidence: 'established', rationale: 'Google documents that Google-Extended does not affect inclusion in Search, AI Overviews or AI Mode; it only governs training.' },
      }));
    }

    /* ---- Content-Signal ------------------------------------------------------------------------ */
    const cs = robots.content_signals || { present: false };
    if (!cs.present) {
      push(out, mk({
        id: 'M14.content_signal.absent', title: 'No Content-Signal line in robots.txt', status: 'not_applicable', scope: 'site',
        location: { url: robotsUrl, resource: 'robots.txt' },
        evidence: { observed: 'robots.txt at ' + robotsUrl + ' carries no `Content-Signal:` directive.' },
        expected: 'Absence is not a defect: Content-Signal is an optional preference vocabulary.',
        recommendation: 'Add one only if the site wants to state a preference about search, AI input and AI training separately. No vendor documents that it is honoured.',
        fixable: 'advisory',
        verification: { method: 'robots_parse', assertion: 'parseRobots(robots.txt).contentSignals.present is false.' },
        reproduce: repro,
        expected_impact: { axis: 'ai', confidence: 'speculative', rationale: 'The Content-Signal draft expired in April 2026 and defines vocabulary only; nobody publishes compliance, so its absence changes nothing measurable.' },
      }));
      return out;
    }

    const scopes = [];
    if (cs.global) scopes.push({ label: 'global', signals: cs.global, raw: cs.global.raw });
    for (const g of cs.by_group || []) scopes.push({ label: 'group ' + listing(g.agents || [], 3), signals: g.signals, raw: g.raw, line: g.line });

    const said = (key, value) => scopes.filter((s) => s.signals && String(s.signals[key]).toLowerCase() === value);

    for (const [key, id, title, status, severity, sentence] of [
      ['ai-input', 'M14.content_signal.ai_input_no', 'Content-Signal withholds consent for AI answer input', 'warn', 3,
        'The site asks answer engines not to use the page as input while leaving it fetchable.'],
      ['search', 'M14.content_signal.search_no', 'Content-Signal withholds consent for search indexing', 'warn', 3,
        'The site asks search engines not to use the page while leaving it fetchable.'],
    ]) {
      const hits = said(key, 'no');
      if (!hits.length) continue;
      push(out, mk({
        id, title, status, severity, scope: 'site',
        location: { url: robotsUrl, resource: 'robots.txt' },
        evidence: { observed: hits.map((h) => h.label + ': "Content-Signal: ' + clip(h.raw, 120) + '"').join('; ') + ' in ' + robotsUrl + '.' },
        expected: 'The Content-Signal preferences match what the site actually wants from AI and search surfaces.',
        recommendation: 'Confirm this is deliberate. ' + sentence + ' If citations are wanted, set ' + key + '=yes; if not, keep it and be aware no vendor documents that it is honoured.',
        fixable: 'advisory',
        verification: { method: 'robots_parse', assertion: 'The Content-Signal directive that applies to this path sets ' + key + '=yes.' },
        reproduce: repro,
        expected_impact: { axis: 'ai', confidence: 'directional', rationale: 'Content-Signal is a stated preference with no documented enforcement; Cloudflare sets it by default on managed robots.txt files, so it is often unintentional.' },
      }));
    }

    const trainNo = said('ai-train', 'no');
    if (trainNo.length) {
      push(out, mk({
        id: 'M14.content_signal.ai_train_no', title: 'Content-Signal opts out of AI training only', status: 'pass', severity: 1, scope: 'site',
        location: { url: robotsUrl, resource: 'robots.txt' },
        evidence: { observed: trainNo.map((h) => h.label + ': "Content-Signal: ' + clip(h.raw, 120) + '"').join('; ') + '.' },
        expected: 'Informational: a training opt-out that leaves search and answer input untouched.',
        recommendation: 'No action needed — this preference costs no citations.',
        fixable: 'advisory',
        verification: { method: 'robots_parse', assertion: 'The applicable Content-Signal sets ai-train=no while search and ai-input are not "no".' },
        reproduce: repro,
        expected_impact: { axis: 'ai', confidence: 'directional', rationale: 'Opting out of training is a low-cost preference; like the rest of Content-Signal it has no documented enforcement.' },
      }));
    }

    if ((cs.malformed || []).length) {
      push(out, mk({
        id: 'M14.content_signal.malformed', title: 'Content-Signal contains pairs a parser cannot read', status: 'warn', severity: 2, scope: 'site',
        location: { url: robotsUrl, resource: 'robots.txt' },
        evidence: { observed: listing(cs.malformed.map((m) => 'line ' + m.line + ': ' + m.reason), 4) + ' in ' + robotsUrl + '.' },
        expected: 'Every pair is `<known-key>=yes|no`, comma separated.',
        recommendation: 'Fix the malformed pairs; a consumer that cannot parse the line ignores the whole preference.',
        fixable: 'auto',
        verification: { method: 'robots_parse', assertion: 'parseRobots(robots.txt).contentSignals.malformed is empty.' },
        reproduce: repro,
        expected_impact: { axis: 'ai', confidence: 'speculative', rationale: 'The vocabulary comes from an expired IETF draft with no documented consumers, so a malformed value has no measurable effect beyond being unreadable.' },
      }));
    }

    return out;
  },
};

export default check;

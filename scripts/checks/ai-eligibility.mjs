// M14 — Google AI-feature eligibility per page, plus the two access facts that only a user-agent
// diff can show. Built on ai-eligibility.mjs analyzeEligibility(), which resolves the meta robots
// tags, the X-Robots-Tag header, data-nosnippet blocks and the robots.txt verdict for Googlebot.
//
// Scope decides severity here, and severity decides whether a score can be capped, so the rule is
// explicit: a blocker present on EVERY sampled page is reported once at site scope (severity 5);
// a blocker on one page stays at page scope (severity 4). Eligibility that could not be determined
// (`eligible_for_ai_features: null`) is reported as needs_api — never as a pass.

import { analyzeEligibility, LOW_MAX_SNIPPET } from '../ai-eligibility.mjs';
import { mk, push, listing, plural, contentPages, finalUrl, snapRepro, tokensFor } from './_shared.mjs';

const BLOCKER_IDS = {
  noindex: 'M14.ai_eligibility.not_indexable',
  robots_disallow: 'M14.ai_eligibility.not_indexable',
  nosnippet: 'M14.ai_eligibility.nosnippet',
  max_snippet_zero: 'M14.ai_eligibility.max_snippet_zero',
};

const BLOCKER_TITLE = {
  'M14.ai_eligibility.not_indexable': 'Page is not indexable, so it cannot appear in Google AI features',
  'M14.ai_eligibility.nosnippet': 'nosnippet suppresses the text Google AI features would quote',
  'M14.ai_eligibility.max_snippet_zero': 'max-snippet:0 leaves no text for Google AI features to quote',
};

const BLOCKER_FIX = {
  'M14.ai_eligibility.not_indexable': 'Remove the noindex directive (or the robots.txt Disallow) from the URLs that should be eligible.',
  'M14.ai_eligibility.nosnippet': 'Remove `nosnippet` from the robots meta tag / X-Robots-Tag on the pages that should be quotable.',
  'M14.ai_eligibility.max_snippet_zero': 'Raise or remove `max-snippet:0`; Google treats 0 as "no snippet at all".',
};

export const check = {
  id: 'ai-eligibility',
  module: 'M14',
  scope: 'site',
  ids: [
    'M14.ai_eligibility.not_indexable', 'M14.ai_eligibility.nosnippet', 'M14.ai_eligibility.max_snippet_zero',
    'M14.ai_eligibility.max_snippet_low', 'M14.ai_eligibility.data_nosnippet_primary',
    'M14.ai_eligibility.data_nosnippet_partial', 'M14.ai_eligibility.ok',
    'M14.render.content_js_only', 'M14.access.ai_bot_challenged', 'M14.access.googlebot_blocked_at_edge',
  ],

  run(ctx) {
    const out = [];
    const pages = contentPages(ctx);
    if (!pages.length) return out;
    const robots = (ctx.site && ctx.site.robots) || null;

    const analysed = pages.map((page) => ({
      page,
      url: finalUrl(page),
      result: analyzeEligibility(page.parsed, (page.snapshot && page.snapshot.headers) || {}, robots, finalUrl(page), { tokens: tokensFor(ctx, page) }),
    }));

    /* ---- blockers, escalated to site scope when they are universal ---------------------------- */
    const byId = new Map();
    for (const a of analysed) {
      for (const b of a.result.blockers || []) {
        const id = BLOCKER_IDS[b];
        if (!id) continue;
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id).push({ ...a, blocker: b });
      }
    }

    for (const [id, hits] of byId) {
      const universal = pages.length >= 2 && hits.length === pages.length;
      const first = hits[0];
      const reasons = listing([...new Set(hits.flatMap((h) => h.result.reasons || []))], 2);
      const emit = (scope, severity, subjectHits) => mk({
        id, title: BLOCKER_TITLE[id], status: 'fail', severity, scope,
        location: { url: subjectHits[0].url },
        evidence: { observed: (scope === 'site' ? 'All ' + plural(pages.length, 'sampled page') : subjectHits[0].url) + ': ' + reasons + ' (directive sources: ' + listing(subjectHits[0].result.sources || ['none'], 3) + ').' },
        expected: 'Pages that should appear in AI Overviews / AI Mode are indexable and snippet-eligible.',
        recommendation: BLOCKER_FIX[id],
        fixable: 'proposed',
        verification: { method: 'header_check', assertion: 'The URL returns no noindex/nosnippet/max-snippet:0 for Googlebot and robots.txt allows it.' },
        reproduce: snapRepro(ctx, subjectHits[0].page, 'ai-eligibility.mjs'),
        expected_impact: { axis: 'ai', confidence: 'established', rationale: 'Google documents in "AI features and your website" that AI Overviews and AI Mode follow the same indexing and snippet controls as Search; a blocked page is ineligible.' },
      });
      if (universal) push(out, emit('site', 5, hits));
      else for (const h of hits) push(out, emit('page', 4, [h]));
    }

    /* ---- per-page warnings, data-nosnippet and the clean case -------------------------------- */
    for (const { page, url, result } of analysed) {
      const at = { location: { url } };
      const repro = snapRepro(ctx, page, 'ai-eligibility.mjs');

      if ((result.warnings || []).includes('max_snippet_low')) {
        push(out, mk({
          id: 'M14.ai_eligibility.max_snippet_low', title: 'max-snippet is set below the cutoff we use for a quotable passage',
          status: 'warn', severity: 2, scope: 'page', ...at,
          evidence: { observed: url + ' sets max-snippet:' + result.directives.max_snippet + ' (our cutoff is ' + LOW_MAX_SNIPPET + ' words).' },
          expected: 'Either no max-snippet, or a value large enough to carry an answer.',
          recommendation: 'Raise or remove max-snippet on pages that should be quotable.',
          fixable: 'advisory',
          verification: { method: 'header_check', assertion: 'The effective max-snippet for Googlebot is absent or above ' + LOW_MAX_SNIPPET + '.' },
          reproduce: repro,
          expected_impact: { axis: 'ai', confidence: 'directional', rationale: 'The ' + LOW_MAX_SNIPPET + '-word cutoff is ours: Google documents max-snippet as a character limit on the snippet but publishes no threshold below which a page stops being useful to an answer.' },
        }));
      }

      const dn = result.data_nosnippet || {};
      if (dn.supported && dn.elements > 0) {
        if (dn.wraps_h1 || dn.wraps_lead) {
          push(out, mk({
            id: 'M14.ai_eligibility.data_nosnippet_primary', title: 'data-nosnippet wraps the page\'s primary content',
            status: 'fail', severity: 4, scope: 'page', ...at,
            evidence: { observed: url + ' has ' + plural(dn.elements, 'data-nosnippet element') + ' covering ' + dn.words + ' of ' + dn.content_words + ' content words' + (dn.wraps_h1 ? ', including the H1' : '') + (dn.wraps_lead ? ', including the lead passage' : '') + '.' },
            expected: 'data-nosnippet covers ancillary blocks only (prices that change, personal data), never the H1 or the opening answer.',
            recommendation: 'Move the data-nosnippet attribute off the H1/lead and onto the specific blocks that must not be quoted.',
            fixable: 'proposed',
            verification: { method: 'dom_assert', assertion: 'No data-nosnippet element contains the H1 or the first content passage.' },
            reproduce: repro,
            expected_impact: { axis: 'ai', confidence: 'established', rationale: 'Google documents data-nosnippet as excluding the wrapped text from snippets; wrapping the primary content removes exactly the text an answer would quote.' },
          }));
        } else {
          push(out, mk({
            id: 'M14.ai_eligibility.data_nosnippet_partial', title: 'data-nosnippet is used on ancillary blocks only',
            status: 'pass', severity: 1, scope: 'page', ...at,
            evidence: { observed: url + ': ' + plural(dn.elements, 'data-nosnippet element') + ' covering ' + dn.words + ' of ' + dn.content_words + ' content words (' + listing(Object.keys(dn.by_tag || {}), 4) + '), and neither the H1 nor the lead passage is inside one.' },
            expected: 'Scoped usage like this is fine.',
            recommendation: 'No action needed; re-check if the wrapped regions grow to cover the main answer.',
            fixable: 'advisory',
            verification: { method: 'dom_assert', assertion: 'data-nosnippet elements exist and none contains the H1 or the first content passage.' },
            reproduce: repro,
            expected_impact: { axis: 'ai', confidence: 'established', rationale: 'Google documents data-nosnippet at element granularity, so a scoped use suppresses only the wrapped text.' },
          }));
        }
      }

      if (result.eligible_for_ai_features === true) {
        push(out, mk({
          id: 'M14.ai_eligibility.ok', title: 'Page is indexable and snippet-eligible', status: 'pass', severity: 3, scope: 'page', ...at,
          evidence: { observed: url + ': ' + listing(result.reasons || [], 2) },
          expected: 'No noindex, nosnippet or max-snippet:0, and robots.txt allows Googlebot.',
          recommendation: 'No action needed. Eligibility is a gate, not a promise of citation.',
          fixable: 'advisory',
          verification: { method: 'header_check', assertion: 'The effective Googlebot directives leave the page indexable and snippet-eligible.' },
          reproduce: repro,
          expected_impact: { axis: 'ai', confidence: 'established', rationale: 'Google documents that AI features draw on pages eligible for Search snippets; this check confirms the gate is open, nothing beyond it.' },
        }));
      } else if (result.eligible_for_ai_features === null) {
        push(out, mk({
          id: 'M14.ai_eligibility.ok', title: 'AI-feature eligibility could not be determined', status: 'needs_api', scope: 'page', ...at,
          evidence: { observed: url + ': ' + listing(result.unknowns || [], 4) + ' — no blocker was seen, but the inputs needed to confirm eligibility were missing.' },
          expected: 'A snapshot with real HTTP headers and a robots.txt verdict for this URL.',
          recommendation: 'Re-run against the live URL (or a snapshot taken from it) so the headers and robots.txt can be observed.',
          fixable: 'advisory',
          verification: { method: 'header_check', assertion: 'The analysis reports eligible_for_ai_features as true or false rather than null.' },
          reproduce: repro,
          expected_impact: { axis: 'ai', confidence: 'established', rationale: 'A missing observation is not a pass: with robots.txt or the response headers unseen, eligibility is unknown.' },
        }));
      }

      /* ---- content that only exists after JavaScript --------------------------------------- */
      const render = (page.snapshot && page.snapshot.render) || null;
      if (render && render.delta && (render.delta.h1_added > 0 || (render.delta.words || 0) > 0 || (render.delta.jsonld_blocks || 0) > 0)) {
        push(out, mk({
          id: 'M14.render.content_js_only', title: 'Primary content or JSON-LD exists only in the rendered DOM',
          status: 'warn', severity: 4, scope: 'page', ...at,
          evidence: { observed: url + ': rendering adds ' + (render.delta.words || 0) + ' words, ' + (render.delta.h1_added || 0) + ' H1(s) and ' + (render.delta.jsonld_blocks || 0) + ' ld+json block(s) to ' + ((page.parsed && page.parsed.word_count) || 0) + ' words of raw HTML.' },
          expected: 'The answer text and the structured data are in the server response.',
          recommendation: 'Server-render the primary content. Several AI crawlers document that they fetch without executing JavaScript.',
          fixable: 'advisory',
          verification: { method: 'render_diff', assertion: 'The raw HTML already contains the H1, the body text and the JSON-LD.' },
          reproduce: snapRepro(ctx, page, 'snapshot.mjs', { render: 'js' }),
          expected_impact: { axis: 'ai', confidence: 'directional', rationale: 'Vendors document whether their crawler executes JavaScript, but not how much of an answer comes from JS-only content, so the citation cost is directional.' },
        }));
      }

      /* ---- user-agent access (from ua-diff.mjs) --------------------------------------------- */
      const diff = page.ua_diff;
      if (diff && Array.isArray(diff.diffs)) {
        const challenged = (diff.diffs || []).filter((d) => d.challenge_detected && d.ua !== 'googlebot');
        if (challenged.length) {
          const variants = (diff.variants || []).filter((v) => challenged.some((c) => c.ua === v.ua));
          push(out, mk({
            id: 'M14.access.ai_bot_challenged', title: 'AI user-agents receive a challenge instead of the page',
            status: 'warn', severity: 4, scope: 'page', ...at,
            evidence: { observed: url + ': ' + listing(variants.map((v) => v.ua + ' -> HTTP ' + v.status + ' (' + listing(v.challenge_signals || [], 2) + ', ' + v.word_count + ' words)'), 4) + '.' },
            expected: 'AI crawlers that are allowed in robots.txt also get the page from the edge.',
            recommendation: 'Allow-list the documented AI crawler user-agents (and their published IP ranges) in the WAF/bot-management rules, or accept that these engines cannot read the site.',
            fixable: 'advisory',
            verification: { method: 'ua_diff', assertion: 'Each AI user-agent receives the same 200 response as the default UA.' },
            reproduce: { script: 'ua-diff.mjs', args: { url, ua: 'default,googlebot,gptbot,oai-searchbot,claude-searchbot' } },
            expected_impact: { axis: 'ai', confidence: 'directional', rationale: 'A challenge page is what the crawler stores; how each engine reacts to repeated challenges is not documented.' },
          }));
        }
        const gb = (diff.diffs || []).find((d) => d.ua === 'googlebot' && d.challenge_detected);
        if (gb) {
          const v = (diff.variants || []).find((x) => x.ua === 'googlebot') || {};
          push(out, mk({
            id: 'M14.access.googlebot_blocked_at_edge', title: 'A spoofed Googlebot user-agent is refused at the edge',
            status: 'warn', severity: 2, scope: 'page', ...at,
            evidence: { observed: url + ' with the Googlebot user-agent string -> HTTP ' + v.status + ' (' + listing(v.challenge_signals || [], 3) + '); the default UA received HTTP ' + (((diff.variants || []).find((x) => x.ua === diff.baseline) || {}).status) + '.' },
            expected: 'Real Googlebot requests (verified by reverse DNS) are served normally.',
            recommendation: 'Verify before acting: refusing an unverified UA string is legitimate defence. Confirm with Search Console\'s URL Inspection or a reverse-DNS check that real Googlebot traffic is not affected.',
            fixable: 'advisory',
            verification: { method: 'ua_diff', assertion: 'A request from a verified Googlebot IP returns the same response as the default UA.' },
            reproduce: { script: 'ua-diff.mjs', args: { url, ua: 'default,googlebot' } },
            expected_impact: { axis: 'ai', confidence: 'speculative', rationale: 'We spoofed the user-agent string from an unverified IP; the edge may be refusing exactly what it should. Nothing here shows real Googlebot is blocked.' },
          }));
        }
      }
    }

    return out;
  },
};

export default check;

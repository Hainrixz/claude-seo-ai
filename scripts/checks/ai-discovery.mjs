// M21 — AI discovery and agent endpoints (/llms.txt, /agents.md, /.well-known/ucp,
// /.well-known/ai-catalog.json, /sitemap_agentic_discovery.xml), built on ai-discovery.mjs
// analyzeDiscovery() over the probes site/discovery.json already recorded.
//
// M21's scoring weight is 0 by design: no engine documents that any of these files affects
// retrieval or citation. Severities stay <= 2 and confidence stays `speculative` unless the finding
// is about something measurable (a broken link, a robots block, a malformed loc).
//
// The UCP block is owned by M18 on an e-commerce site. When that vertical is active, the UCP ids
// here are emitted as not_applicable naming M18 as the owner, so nothing is double-counted.

import { analyzeDiscovery } from '../ai-discovery.mjs';
import { mk, push, clip, listing, describeExample, plural, isEcommerce, originOf } from './_shared.mjs';

const SPECULATIVE = 'No search or answer engine documents that this file affects retrieval, ranking or citation; it is a convention some agent frameworks read.';

/**
 * Disclosure clause for a block whose validation only saw the head of the response.
 *
 * A run that skipped discovery artifacts (or a file past the saved-body limit) leaves only
 * `text_head` in site/discovery.json. Line-precise defect claims derived from a prefix must say
 * they came from a prefix; otherwise the reader takes them on faith about bytes we never read.
 * Returns '' — nothing to disclose — whenever the parser saw the whole body.
 */
export function partialReadNote(block) {
  if (!block || !block.truncated_source) return '';
  const read = typeof block.parsed_bytes === 'number' ? block.parsed_bytes : null;
  const total = typeof block.source_bytes === 'number' ? block.source_bytes : null;
  const span = read != null && total != null && total > read
    ? 'the first ' + read + ' of ' + total + ' bytes'
    : read != null ? 'the first ' + read + ' bytes' : 'the head';
  return ' Parsed from ' + span + ' of the response — re-run with discovery artifacts saved for a full parse.';
}

export const check = {
  id: 'ai-discovery',
  module: 'M21',
  scope: 'site',
  ids: [
    'M21.llmstxt.missing', 'M21.llmstxt.malformed', 'M21.llmstxt.broken_links', 'M21.llmstxt.blocked_for_ai_bots',
    'M21.agents_md.present', 'M21.agents_md.missing',
    'M21.ucp.present_valid', 'M21.ucp.invalid', 'M21.ucp.not_public',
    'M21.ai_catalog.present', 'M21.ai_catalog.invalid_json',
    'M21.agentic_sitemap.present', 'M21.agentic_sitemap.broken_locs',
  ],

  run(ctx) {
    const out = [];
    const discovery = ctx.site && ctx.site.discovery;
    const origin = originOf(ctx);
    const repro = { script: 'ai-discovery.mjs', args: { 'run-dir': ctx.run_dir } };

    if (!discovery) {
      push(out, mk({
        id: 'M21.llmstxt.missing', title: 'AI discovery paths were not probed in this run', status: 'needs_api', scope: 'site',
        evidence: { observed: 'No site/discovery.json in ' + ctx.run_dir + ' (the run used --artifacts none or discovery probing was skipped).' },
        expected: 'A run that probes /llms.txt, /agents.md and the well-known agent endpoints.',
        recommendation: 'Re-run the crawl with discovery artifacts enabled.',
        fixable: 'advisory',
        verification: { method: 'header_check', assertion: 'site/discovery.json exists and lists a status per probe path.' },
        reproduce: { script: 'ai-discovery.mjs', args: { url: origin || '' } },
        expected_impact: { axis: 'ai', confidence: 'speculative', rationale: SPECULATIVE },
      }));
      return out;
    }

    const d = analyzeDiscovery(discovery, (ctx.site && ctx.site.robots) || null);
    const site = { scope: 'site', fixable: 'advisory' };
    const blockedFor = (path) => ((d.robots_cross_check && d.robots_cross_check.discovery_paths_blocked_for) || []).find((b) => b.path === path);

    /* ---- llms.txt ---------------------------------------------------------------------------- */
    const llms = d.llms_txt || {};
    if (!llms.present) {
      push(out, mk({
        id: 'M21.llmstxt.missing', title: 'No /llms.txt', status: 'warn', severity: 1, ...site,
        location: { url: (origin || '') + '/llms.txt' },
        evidence: { observed: 'GET ' + (origin || '') + '/llms.txt -> HTTP ' + (llms.status == null ? 'no response' : llms.status) + '.' },
        expected: 'Optional: a short Markdown index of the site\'s most useful pages for a language model.',
        recommendation: 'Publish /llms.txt with an H1, a one-line summary and linked sections — but treat it as a convenience for agent frameworks, not an SEO or citation lever.',
        fixable: 'auto',
        verification: { method: 'header_check', assertion: 'GET /llms.txt returns 200 with Markdown starting at an H1.' },
        reproduce: repro,
        expected_impact: { axis: 'ai', confidence: 'speculative', rationale: SPECULATIVE },
      }));
    } else {
      if (!llms.ok || (llms.errors || []).length || llms.looks_like_html) {
        push(out, mk({
          id: 'M21.llmstxt.malformed', title: '/llms.txt does not follow the llms.txt shape', status: 'warn', severity: 1, ...site,
          location: { url: (origin || '') + '/llms.txt' },
          evidence: { observed: (llms.looks_like_html
            ? 'GET /llms.txt returns HTML, not Markdown (' + llms.bytes + ' bytes).'
            : plural((llms.errors || []).length, 'structural problem') + ': ' + listing((llms.errors || []).map((e) => 'line ' + e.line + ': ' + e.reason), 4) + '.')
            + partialReadNote(llms) },
          expected: 'An H1 title, an optional `>` summary, then `## Section` headings with Markdown links.',
          recommendation: 'Fix the structure so a parser can read the sections and links.',
          fixable: 'auto',
          verification: { method: 'header_check', assertion: 'validateLlmsTxt reports ok:true with no errors.' },
          reproduce: repro,
          expected_impact: { axis: 'ai', confidence: 'speculative', rationale: SPECULATIVE },
        }));
      }
      const lc = llms.link_check;
      if (lc && (lc.broken || []).length) {
        push(out, mk({
          id: 'M21.llmstxt.broken_links', title: '/llms.txt links to URLs that do not resolve', status: 'warn', severity: 2, ...site,
          location: { url: (origin || '') + '/llms.txt' },
          evidence: { observed: plural(lc.broken.length, 'link') + ' of ' + (llms.links_total || 0) + ' failed: ' + listing(lc.broken.map((b) => clip(b.url || b.abs, 70) + ' -> HTTP ' + b.status), 4) + '.' },
          expected: 'Every link in /llms.txt resolves to a 200.',
          recommendation: 'Regenerate /llms.txt from the same source as the sitemap so its links cannot rot.',
          fixable: 'proposed',
          verification: { method: 'header_check', assertion: 'Every link in /llms.txt returns a 2xx.' },
          reproduce: { script: 'ai-discovery.mjs', args: { 'run-dir': ctx.run_dir, deep: true } },
          expected_impact: { axis: 'ai', confidence: 'directional', rationale: 'A dead link is a measurable defect in the file regardless of whether any engine reads it.' },
        }));
      }
      const blocked = blockedFor('/llms.txt');
      if (blocked) {
        push(out, mk({
          id: 'M21.llmstxt.blocked_for_ai_bots', title: '/llms.txt exists but robots.txt blocks the bots meant to read it', status: 'warn', severity: 2, ...site,
          location: { url: (origin || '') + '/llms.txt' },
          evidence: { observed: '/llms.txt returns HTTP ' + llms.status + ' and robots.txt disallows it for ' + listing(blocked.blocked_for, 5)
            + ((blocked.detail || []).length ? ' (' + listing(blocked.detail.map((b) => b.bot + ' via ' + b.via + (b.rule ? ' "' + clip(b.rule, 40) + '"' : '')), 2) + ')' : '') + '.' },
          expected: 'A file published for AI agents is fetchable by them.',
          recommendation: 'Allow /llms.txt for the retrieval and user-triggered agent tokens, or remove the file.',
          fixable: 'advisory',
          verification: { method: 'robots_parse', assertion: 'isAllowed(robots, "<agent>", "/llms.txt") is true for the audience tokens.' },
          reproduce: repro,
          expected_impact: { axis: 'ai', confidence: 'directional', rationale: 'The contradiction is observable in robots.txt; what an agent would have done with the file is not documented by anyone.' },
        }));
      }
    }

    /* ---- agents.md ---------------------------------------------------------------------------- */
    const agents = d.agents_md || {};
    push(out, agents.present
      ? mk({
        id: 'M21.agents_md.present', title: '/agents.md is published', status: 'pass', severity: 1, ...site,
        location: { url: (origin || '') + '/agents.md' },
        evidence: { observed: 'GET /agents.md -> HTTP ' + agents.status + ', ' + agents.bytes + ' bytes, headings: ' + listing((agents.headings || []).map((h) => 'h' + h.level + ' "' + clip(h.text, 40) + '"'), 3) + '.' + partialReadNote(agents) },
        expected: 'Informational: the file exists and parses.',
        recommendation: 'Keep it accurate — it states how agents should interact with the site.',
        fixable: 'advisory',
        verification: { method: 'header_check', assertion: 'GET /agents.md returns 200 with Markdown content.' },
        reproduce: repro,
        expected_impact: { axis: 'ai', confidence: 'speculative', rationale: SPECULATIVE },
      })
      : mk({
        id: 'M21.agents_md.missing', title: 'No /agents.md', status: 'warn', severity: 1, ...site,
        location: { url: (origin || '') + '/agents.md' },
        evidence: { observed: 'GET ' + (origin || '') + '/agents.md -> HTTP ' + (agents.status == null ? 'no response' : agents.status) + '.' },
        expected: 'Optional: a Markdown file describing how agents should use the site.',
        recommendation: 'Publish /agents.md only if the site has real instructions for agents (checkout, API, rate limits).',
        fixable: 'advisory',
        verification: { method: 'header_check', assertion: 'GET /agents.md returns 200.' },
        reproduce: repro,
        expected_impact: { axis: 'ai', confidence: 'speculative', rationale: SPECULATIVE },
      }));

    /* ---- UCP (owned by M18 on an e-commerce site) --------------------------------------------- */
    const ucp = d.ucp || {};
    const ucpUrl = (origin || '') + '/.well-known/ucp';
    if (isEcommerce(ctx)) {
      push(out, mk({
        id: ucp.present ? 'M21.ucp.present_valid' : 'M21.ucp.invalid', title: 'UCP profile is judged by M18 on an e-commerce site',
        status: 'not_applicable', ...site,
        location: { url: ucpUrl },
        evidence: { observed: 'GET /.well-known/ucp -> HTTP ' + (ucp.status == null ? 'no response' : ucp.status) + '. The e-commerce vertical is active, so M18 (agentic commerce readiness) owns this endpoint.' + partialReadNote(ucp) },
        expected: 'Reported once, by the module that owns it.',
        recommendation: 'See the M18.agentic.ucp_* findings for this endpoint.',
        fixable: 'advisory',
        verification: { method: 'header_check', assertion: 'The M18 agentic-commerce check reports on /.well-known/ucp.' },
        reproduce: repro,
        expected_impact: { axis: 'ai', confidence: 'speculative', rationale: 'Suppressed to avoid counting the same endpoint twice across two modules.' },
      }));
    } else if (ucp.present && ucp.publicly_readable === false) {
      push(out, mk({
        id: 'M21.ucp.not_public', title: 'The UCP profile is not publicly readable', status: 'warn', severity: 2, ...site,
        location: { url: ucpUrl },
        evidence: { observed: 'GET /.well-known/ucp -> HTTP ' + ucp.status + (ucp.json_valid === false ? ' and the body is not JSON' : '') + '.' + partialReadNote(ucp) },
        expected: 'The profile answers 200 with JSON to an unauthenticated request.',
        recommendation: 'Serve /.well-known/ucp publicly, or remove it.',
        fixable: 'advisory',
        verification: { method: 'header_check', assertion: 'An unauthenticated GET of /.well-known/ucp returns 200 application/json.' },
        reproduce: repro,
        expected_impact: { axis: 'ai', confidence: 'speculative', rationale: SPECULATIVE },
      }));
    } else if (ucp.present && !ucp.ok) {
      push(out, mk({
        id: 'M21.ucp.invalid', title: 'The UCP profile does not validate', status: 'warn', severity: 2, ...site,
        location: { url: ucpUrl },
        evidence: { observed: plural((ucp.errors || []).length, 'error') + ' in /.well-known/ucp: ' + listing((ucp.errors || []).map((e) => e.path + ': ' + e.reason), 4) + '.' + partialReadNote(ucp) },
        expected: 'A parseable version, services and capabilities shape.',
        recommendation: 'Fix the fields listed above; a profile an agent cannot parse is the same as no profile.',
        fixable: 'advisory',
        verification: { method: 'header_check', assertion: 'validateUcp reports ok:true.' },
        reproduce: repro,
        expected_impact: { axis: 'ai', confidence: 'speculative', rationale: SPECULATIVE },
      }));
    } else if (ucp.present) {
      push(out, mk({
        id: 'M21.ucp.present_valid', title: 'A valid UCP profile is published', status: 'pass', severity: 2, ...site,
        location: { url: ucpUrl },
        evidence: { observed: '/.well-known/ucp -> HTTP ' + ucp.status + ', version ' + ucp.version + ', ' + plural(ucp.services ? ucp.services.count : 0, 'service') + ' and ' + plural(ucp.capabilities ? ucp.capabilities.count : 0, 'capability') + ' declared.' + partialReadNote(ucp) },
        expected: 'Informational: the profile exists and validates.',
        recommendation: 'Keep the declared endpoints reachable and the version current.',
        fixable: 'advisory',
        verification: { method: 'header_check', assertion: 'GET /.well-known/ucp returns 200 JSON that validates.' },
        reproduce: repro,
        expected_impact: { axis: 'ai', confidence: 'speculative', rationale: SPECULATIVE },
      }));
    }

    /* ---- ai-catalog ---------------------------------------------------------------------------- */
    const cat = d.ai_catalog || {};
    if (cat.present && cat.json_valid === false) {
      push(out, mk({
        id: 'M21.ai_catalog.invalid_json', title: '/.well-known/ai-catalog.json does not parse as JSON', status: 'warn', severity: 1, ...site,
        location: { url: (origin || '') + '/.well-known/ai-catalog.json' },
        evidence: { observed: 'GET /.well-known/ai-catalog.json -> HTTP ' + cat.status + ' and JSON.parse failed.' },
        expected: 'Valid JSON.',
        recommendation: 'Fix or remove the file.',
        fixable: 'advisory',
        verification: { method: 'header_check', assertion: 'The catalog body parses as JSON.' },
        reproduce: repro,
        expected_impact: { axis: 'ai', confidence: 'speculative', rationale: SPECULATIVE },
      }));
    } else if (cat.present) {
      push(out, mk({
        id: 'M21.ai_catalog.present', title: '/.well-known/ai-catalog.json is published', status: 'pass', severity: 1, ...site,
        location: { url: (origin || '') + '/.well-known/ai-catalog.json' },
        evidence: { observed: 'GET /.well-known/ai-catalog.json -> HTTP ' + cat.status + ', top-level keys: ' + listing(cat.keys || [], 6) + '.' },
        expected: 'Informational.',
        recommendation: 'Keep it in sync with the catalogue it describes.',
        fixable: 'advisory',
        verification: { method: 'header_check', assertion: 'The catalog returns 200 with valid JSON.' },
        reproduce: repro,
        expected_impact: { axis: 'ai', confidence: 'speculative', rationale: SPECULATIVE },
      }));
    }

    /* ---- agentic sitemap ------------------------------------------------------------------------ */
    const ags = d.agentic_sitemap || {};
    if (ags.present && ((ags.errors || []).length || !ags.ok)) {
      push(out, mk({
        id: 'M21.agentic_sitemap.broken_locs', title: '/sitemap_agentic_discovery.xml has unusable entries', status: 'warn', severity: 2, ...site,
        location: { url: (origin || '') + '/sitemap_agentic_discovery.xml' },
        evidence: { observed: 'kind "' + ags.kind + '", ' + plural(ags.url_count || 0, 'loc') + ', ' + plural((ags.errors || []).length, 'parse error') + ': ' + listing((ags.errors || []).map((e) => describeExample(e, 90)), 3) + '.' },
        expected: 'A valid urlset whose <loc> entries are absolute URLs.',
        recommendation: 'Fix the XML, or remove the file if nothing generates it any more.',
        fixable: 'proposed',
        verification: { method: 'xml_parse', assertion: 'The agentic discovery sitemap parses as a urlset with resolvable locs.' },
        reproduce: repro,
        expected_impact: { axis: 'ai', confidence: 'directional', rationale: 'The parse failure is observable; whether any agent reads this file is not documented.' },
      }));
    } else if (ags.present) {
      push(out, mk({
        id: 'M21.agentic_sitemap.present', title: '/sitemap_agentic_discovery.xml is published', status: 'pass', severity: 1, ...site,
        location: { url: (origin || '') + '/sitemap_agentic_discovery.xml' },
        evidence: { observed: 'kind "' + ags.kind + '" with ' + plural(ags.url_count || 0, 'loc') + ': ' + listing(ags.locs || [], 3) + '.' },
        expected: 'Informational.',
        recommendation: 'Keep the listed endpoints reachable.',
        fixable: 'advisory',
        verification: { method: 'xml_parse', assertion: 'The file returns 200 and parses as a urlset.' },
        reproduce: repro,
        expected_impact: { axis: 'ai', confidence: 'speculative', rationale: SPECULATIVE },
      }));
    }

    return out;
  },
};

export default check;

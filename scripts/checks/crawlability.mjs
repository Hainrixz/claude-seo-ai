// M1 — crawlability. Reads the run's site/robots.json (written by lib/site.mjs) and answers the
// only questions robots.txt can settle deterministically: can Googlebot fetch the audited path,
// are the render assets reachable, is the file syntactically sound, is a sitemap declared, and is
// the crawl-delay large enough to starve a crawler that honours it.
//
// Nothing here is inferred: every finding quotes the robots.txt line (with its line number) or the
// resolved verdict that produced it. When site/robots.json is absent the check reports needs_api
// instead of assuming the file is fine.

import { isAllowed } from '../lib/robots.mjs';
import { mk, push, clip, listing, originOf, plural } from './_shared.mjs';

/** Crawl-delay (seconds) above which a honouring crawler visibly starves on a normal site. Ours, not a vendor's. */
export const CRAWL_DELAY_CUTOFF_S = 5;

const ROBOTS_REPRO = (ctx, path) => ({ script: 'parse-robots-sitemap.mjs', args: { url: (originOf(ctx) || '') + '/robots.txt', path: path || '/' } });

/** "line 11: Disallow: /" — the verbatim rule, or a resolved-verdict sentence when there is no rule. */
function ruleText(verdict) {
  if (!verdict) return 'no verdict recorded';
  if (verdict.rule) {
    const r = verdict.rule;
    const line = r.line ? 'line ' + r.line + ': ' : '';
    return line + (r.type === 'allow' ? 'Allow: ' : 'Disallow: ') + r.path;
  }
  return 'no matching rule (via ' + verdict.via + ')';
}

/** Same-origin CSS/JS the sampled pages load, deduped, with the page that referenced each one. */
function renderAssets(ctx) {
  const origin = originOf(ctx);
  const seen = new Map();
  for (const page of ctx.pages || []) {
    const parsed = page.parsed;
    if (!parsed) continue;
    const refs = [
      ...((parsed.scripts || []).filter((s) => s.abs).map((s) => ({ abs: s.abs, kind: 'script' }))),
      ...((parsed.stylesheets || []).filter((s) => s.abs).map((s) => ({ abs: s.abs, kind: 'stylesheet' }))),
    ];
    for (const r of refs) {
      if (origin && !String(r.abs).startsWith(origin)) continue; // third-party hosts are not ours to unblock
      if (!seen.has(r.abs)) seen.set(r.abs, { ...r, page: page.url });
    }
  }
  return [...seen.values()];
}

export const check = {
  id: 'crawlability',
  module: 'M1',
  scope: 'site',
  ids: [
    'M1.robots.unreachable',
    'M1.robots.blocks_googlebot',
    'M1.robots.blocks_css_js',
    'M1.robots.syntax_error',
    'M1.sitemap.missing_directive',
    'M1.crawl_delay.excessive',
  ],

  run(ctx) {
    const out = [];
    const robots = ctx.site && ctx.site.robots;
    const origin = originOf(ctx);
    const auditedPath = (() => {
      const t = (ctx.crawl && ctx.crawl.target) || (ctx.pages && ctx.pages[0] && ctx.pages[0].url);
      try { return t ? new URL(t).pathname : '/'; } catch { return '/'; }
    })();

    if (!robots) {
      push(out, mk({
        id: 'M1.robots.unreachable', title: 'robots.txt was not fetched in this run',
        status: 'needs_api', scope: 'site',
        evidence: { observed: 'No site/robots.json in ' + ctx.run_dir + ': the run was made with --artifacts none, or the crawl could not reach /robots.txt.' },
        expected: 'A run that judges crawlability fetches /robots.txt and stores it as site/robots.json.',
        recommendation: 'Re-run the crawl without --artifacts none (or run parse-robots-sitemap.mjs against the origin) so the robots rules can be read.',
        fixable: 'advisory',
        verification: { method: 'robots_parse', assertion: 'site/robots.json exists in the run directory and carries a `verdicts` block.' },
        reproduce: ROBOTS_REPRO(ctx, auditedPath),
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Crawl access cannot be judged without the file that grants it; reporting it as unknown keeps the score honest.' },
      }));
      return out;
    }

    const status = robots.status;
    const parsed = robots.parsed || null;
    const verdicts = robots.verdicts || {};
    const url = robots.url || (origin ? origin + '/robots.txt' : '/robots.txt');

    /* ---- 5xx / unreachable: Google suspends crawling while robots.txt errors --------------- */
    const unreachable = status === null || status === 0 || status === 429 || (typeof status === 'number' && status >= 500);
    if (unreachable) {
      push(out, mk({
        id: 'M1.robots.unreachable', title: 'robots.txt does not return a usable response',
        status: 'fail', severity: 5, scope: 'site',
        location: { url },
        evidence: { observed: 'GET ' + url + ' -> HTTP ' + (status === null ? 'no response' : status) + (robots.error ? ' (' + clip(robots.error, 120) + ')' : '') + '; the run treated the site as ' + (robots.mode || 'unknown') + '.' },
        expected: 'GET /robots.txt returns 200 with the rules, or 404 so crawlers treat the site as fully allowed.',
        recommendation: 'Fix the server error behind /robots.txt (or return a 404 while it is unavailable). Google suspends crawling of a site whose robots.txt keeps returning 5xx.',
        fixable: 'advisory',
        verification: { method: 'robots_parse', assertion: 'GET /robots.txt returns 200 or 404, not 5xx/429.' },
        reproduce: ROBOTS_REPRO(ctx, auditedPath),
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents that a persistently failing robots.txt makes it stop crawling the site until the file recovers.' },
      }));
    }

    /* ---- Googlebot blocked on the audited path -------------------------------------------- */
    const gb = verdicts.Googlebot;
    if (gb && gb.allowed === false) {
      push(out, mk({
        id: 'M1.robots.blocks_googlebot', title: 'robots.txt disallows Googlebot on the audited path',
        status: 'fail', severity: 5, scope: 'site',
        location: { url, resource: 'robots.txt' },
        evidence: { observed: url + ' ' + ruleText(gb) + ' -> Googlebot is not allowed to fetch ' + (gb.path || auditedPath) + '.' },
        expected: 'Googlebot is allowed to fetch the URLs the site wants indexed.',
        recommendation: 'Remove or narrow the Disallow rule that matches this path in the group that applies to Googlebot, then re-test in Search Console\'s robots.txt report.',
        fixable: 'proposed',
        verification: { method: 'robots_parse', assertion: 'isAllowed(robots, "Googlebot", "' + (gb.path || auditedPath) + '") is true.' },
        reproduce: ROBOTS_REPRO(ctx, gb.path || auditedPath),
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents that a disallowed URL is not crawled; without a crawl the page cannot be indexed from its content.' },
      }));
    }

    /* ---- CSS/JS the renderer needs ---------------------------------------------------------- */
    if (parsed) {
      const blocked = [];
      for (const asset of renderAssets(ctx)) {
        const v = isAllowed(parsed, 'Googlebot', asset.abs);
        if (v && v.allowed === false) blocked.push({ ...asset, verdict: v });
      }
      if (blocked.length) {
        push(out, mk({
          id: 'M1.robots.blocks_css_js', title: 'robots.txt blocks CSS/JS that the sampled pages load',
          status: 'fail', severity: 4, scope: 'site',
          location: { url, resource: 'robots.txt' },
          evidence: { observed: plural(blocked.length, 'render asset') + ' disallowed for Googlebot: ' + listing(blocked.map((b) => b.abs + ' (' + ruleText(b.verdict) + ')'), 4) + '.' },
          expected: 'Every stylesheet and script the page needs to render is crawlable by Googlebot.',
          recommendation: 'Allow the asset paths listed above (an `Allow:` rule inside the group that blocks them is enough). Google renders pages before indexing and needs the CSS/JS to see the layout.',
          fixable: 'auto',
          verification: { method: 'robots_parse', assertion: 'Each listed asset URL returns allowed:true for Googlebot.' },
          reproduce: ROBOTS_REPRO(ctx, (() => { try { return new URL(blocked[0].abs).pathname; } catch { return auditedPath; } })()),
          expected_impact: { axis: 'search', confidence: 'established', rationale: 'Google documents that blocking CSS/JS degrades rendering and therefore what it can index of the page.' },
        }));
      }
    }

    /* ---- syntax ----------------------------------------------------------------------------- */
    if (parsed) {
      const problems = [];
      if (parsed.hasBom) problems.push('the file starts with a UTF-8 BOM, which hides the first directive from strict parsers');
      for (const l of (parsed.invalidLines || []).slice(0, 5)) problems.push('line ' + l.line + ': ' + clip(l.text, 80) + ' (' + l.reason + ')');
      const orphanRules = (parsed.groups || []).some((g) => !g.agents || !g.agents.length);
      if (orphanRules) problems.push('rules appear before any User-agent line, so they belong to no group');
      if (problems.length) {
        push(out, mk({
          id: 'M1.robots.syntax_error', title: 'robots.txt contains lines a parser cannot use',
          status: 'warn', severity: 3, scope: 'site',
          location: { url, resource: 'robots.txt' },
          evidence: { observed: problems.join('; ') + '.' },
          expected: 'Every line is a valid `User-agent:`, `Allow:`, `Disallow:`, `Sitemap:` or `Crawl-delay:` directive, in a group, with no BOM.',
          recommendation: 'Delete or correct the lines quoted above. A directive a parser skips is a rule that silently does not apply.',
          fixable: 'auto',
          verification: { method: 'robots_parse', assertion: 'parseRobots(robots.txt).invalidLines is empty and hasBom is false.' },
          reproduce: ROBOTS_REPRO(ctx, auditedPath),
          expected_impact: { axis: 'search', confidence: 'established', rationale: 'RFC 9309 defines the grammar crawlers parse; a line outside it is ignored, so the rule its author intended never takes effect.' },
        }));
      }
    }

    /* ---- Sitemap directive ------------------------------------------------------------------ */
    const declared = (robots.sitemaps_declared || []).length;
    const sitemapsFound = ctx.site && ctx.site.sitemaps ? (ctx.site.sitemaps.found || 0) : 0;
    if (!declared && !sitemapsFound && status !== null && status < 500) {
      push(out, mk({
        id: 'M1.sitemap.missing_directive', title: 'robots.txt declares no sitemap and none was discovered',
        status: 'warn', severity: 2, scope: 'site',
        location: { url, resource: 'robots.txt' },
        evidence: { observed: 'No `Sitemap:` line in ' + url + ', and none of the well-known sitemap paths returned XML.' },
        expected: 'robots.txt carries a `Sitemap:` line pointing at the site\'s index or urlset.',
        recommendation: 'Add `Sitemap: <origin>/sitemap.xml` to robots.txt (and submit it in Search Console).',
        fixable: 'auto',
        verification: { method: 'robots_parse', assertion: 'robots.txt contains a Sitemap: line whose URL returns a valid urlset or sitemapindex.' },
        reproduce: ROBOTS_REPRO(ctx, auditedPath),
        expected_impact: { axis: 'search', confidence: 'directional', rationale: 'Sitemaps are also discovered from Search Console and /sitemap.xml, so a missing directive is a discovery convenience gap rather than an access failure.' },
      }));
    }

    /* ---- Crawl-delay ------------------------------------------------------------------------ */
    const cd = robots.crawl_delay || {};
    const effective = [
      ['Googlebot', Number(cd.Googlebot)],
      ['*', Number(cd['*'])],
    ].filter(([, v]) => Number.isFinite(v) && v > CRAWL_DELAY_CUTOFF_S);
    if (effective.length) {
      const declaredLines = (cd.declared || []).filter((d) => Number(d.crawl_delay) > CRAWL_DELAY_CUTOFF_S);
      push(out, mk({
        id: 'M1.crawl_delay.excessive', title: 'robots.txt asks honouring crawlers to wait a long time between requests',
        status: 'warn', severity: 2, scope: 'site',
        location: { url, resource: 'robots.txt' },
        evidence: { observed: effective.map(([agent, v]) => 'Crawl-delay ' + v + 's applies to ' + agent).join('; ') + (declaredLines.length ? ' (declared at ' + listing(declaredLines.map((d) => 'line ' + d.line + ': ' + (d.agents || []).join(', ')), 3) + ')' : '') + '.' },
        expected: 'No Crawl-delay, or a value small enough that a crawler can still cover the site (we flag above ' + CRAWL_DELAY_CUTOFF_S + 's).',
        recommendation: 'Lower or drop the Crawl-delay and control crawl rate at the server instead. Googlebot ignores this directive, but Bingbot and several AI crawlers honour it.',
        fixable: 'proposed',
        verification: { method: 'robots_parse', assertion: 'The Crawl-delay applying to * and Googlebot is absent or <= ' + CRAWL_DELAY_CUTOFF_S + '.' },
        reproduce: ROBOTS_REPRO(ctx, auditedPath),
        expected_impact: { axis: 'search', confidence: 'directional', rationale: 'The cutoff is ours: crawlers that honour Crawl-delay fetch fewer URLs per day, but no vendor publishes a threshold at which coverage suffers.' },
      }));
    }

    return out;
  },
};

export default check;

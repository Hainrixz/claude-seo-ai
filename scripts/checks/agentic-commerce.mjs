// M18 (agentic block) — the site-level half of agentic commerce readiness: the UCP profile and the
// Agentic Commerce Protocol feed. Only runs when the e-commerce vertical is active, because these
// endpoints mean nothing on a site with no catalogue.
//
// Everything here is `directional` except the Merchant Center hint: the UCP spec is young and no
// vendor documents what an agent does with a profile. Without --feed the feed lint is `needs_api`,
// never a pass — an unread feed is not a clean feed.

import { readFileSync } from 'node:fs';
import { detectFormat, parseFeed, lintFeed } from '../acp-feed-lint.mjs';
import { analyzeDiscovery } from '../ai-discovery.mjs';
import { partialReadNote } from './ai-discovery.mjs';
import { mk, push, clip, listing, plural, isEcommerce, originOf } from './_shared.mjs';

/** Rows linted from the feed; the rest are reported as un-sampled rather than silently ignored. */
export const FEED_SAMPLE = 500;

export const check = {
  id: 'agentic-commerce',
  module: 'M18',
  scope: 'site',
  ids: [
    'M18.agentic.ucp_profile_missing', 'M18.agentic.ucp_profile_invalid', 'M18.agentic.ucp_not_public',
    'M18.agentic.acp_feed_errors', 'M18.agentic.merchant_center_hint', 'M18.agentic.shopify_catalog_declared',
  ],

  run(ctx) {
    const out = [];
    if (!isEcommerce(ctx)) return out;
    const origin = originOf(ctx);
    const ucpUrl = (origin || '') + '/.well-known/ucp';
    const repro = { script: 'ai-discovery.mjs', args: { 'run-dir': ctx.run_dir } };
    const site = { scope: 'site', fixable: 'advisory', location: { url: ucpUrl } };

    /* ---- UCP profile -------------------------------------------------------------------------- */
    if (ctx.site && ctx.site.discovery) {
      const d = analyzeDiscovery(ctx.site.discovery, (ctx.site && ctx.site.robots) || null);
      const ucp = d.ucp || {};
      if (ucp.body_unread) {
        // The endpoint answered, but this run only holds the head of the body, so whether a profile
        // is published is UNKNOWN. Saying "no UCP profile" next to the probe's own HTTP 200 would be
        // a fabricated negative; needs_api is the honest state, and it is never a silent pass.
        push(out, mk({
          id: 'M18.agentic.ucp_profile_missing', title: 'The UCP profile could not be read in this run', status: 'needs_api', ...site,
          evidence: { observed: 'GET ' + ucpUrl + ' -> HTTP ' + ucp.status + ', but the body was not fully captured, so it could not be parsed.' + partialReadNote(ucp) },
          expected: 'The whole /.well-known/ucp body, so the profile can be validated instead of guessed at.',
          recommendation: 'Re-run the crawl with discovery artifacts saved (the run writes site/ucp.json), then re-check.',
          fixable: 'advisory',
          verification: { method: 'header_check', assertion: 'ai-discovery.mjs --run-dir <run> reports ucp.present with no truncated_source.' },
          reproduce: repro,
          expected_impact: { axis: 'ai', confidence: 'directional', rationale: 'An unread profile is unknown, not absent; UCP is how an agent discovers a store\'s commerce endpoints, but no vendor publishes what share of agent traffic depends on it.' },
        }));
      } else if (!ucp.present) {
        push(out, mk({
          id: 'M18.agentic.ucp_profile_missing', title: 'The store publishes no UCP profile', status: 'warn', severity: 3, ...site,
          evidence: { observed: 'GET ' + ucpUrl + ' -> HTTP ' + (ucp.status == null ? 'no response' : ucp.status) + '.' },
          expected: 'A /.well-known/ucp profile declaring the store\'s catalogue and checkout services.',
          recommendation: 'Publish a UCP profile if agentic checkout matters to this store. On Shopify it is generated for you once the relevant apps are installed.',
          fixable: 'advisory',
          verification: { method: 'header_check', assertion: 'GET /.well-known/ucp returns 200 with a JSON profile.' },
          reproduce: repro,
          expected_impact: { axis: 'ai', confidence: 'directional', rationale: 'UCP is how an agent discovers a store\'s commerce endpoints, but no vendor publishes what share of agent traffic depends on it.' },
        }));
      } else if (ucp.publicly_readable === false) {
        push(out, mk({
          id: 'M18.agentic.ucp_not_public', title: 'The UCP profile is not readable by an unauthenticated agent', status: 'fail', severity: 3, ...site,
          evidence: { observed: 'GET ' + ucpUrl + ' -> HTTP ' + ucp.status + (ucp.json_valid === false ? ' with a non-JSON body' : '') + '.' + partialReadNote(ucp) },
          expected: 'The profile answers 200 with application/json to an anonymous request.',
          recommendation: 'Remove the auth gate or redirect in front of /.well-known/ucp; an agent reads it before it has any credentials.',
          fixable: 'advisory',
          verification: { method: 'header_check', assertion: 'An anonymous GET of /.well-known/ucp returns 200 application/json.' },
          reproduce: repro,
          expected_impact: { axis: 'ai', confidence: 'directional', rationale: 'A profile behind auth cannot be read at discovery time; how much agent traffic that costs is not published.' },
        }));
      } else if (!ucp.ok) {
        push(out, mk({
          id: 'M18.agentic.ucp_profile_invalid', title: 'The UCP profile does not validate', status: 'warn', severity: 3, ...site,
          evidence: { observed: plural((ucp.errors || []).length, 'error') + ' in ' + ucpUrl + ': ' + listing((ucp.errors || []).map((e) => e.path + ': ' + e.reason), 4) + (ucp.version ? ' (version "' + clip(ucp.version, 30) + '")' : '') + '.' + partialReadNote(ucp) },
          expected: 'A valid version plus services/capabilities entries with https spec, endpoint and schema URLs.',
          recommendation: 'Fix the fields listed above and re-publish the profile.',
          fixable: 'advisory',
          verification: { method: 'header_check', assertion: 'validateUcp reports ok:true for the profile.' },
          reproduce: repro,
          expected_impact: { axis: 'ai', confidence: 'directional', rationale: 'A profile an agent cannot parse is equivalent to none, but the UCP spec is young and its consumers are not documented.' },
        }));
      }

      if (ucp.shopify_catalog_declared) {
        push(out, mk({
          id: 'M18.agentic.shopify_catalog_declared', title: 'The platform declares a catalog integration in the UCP profile', status: 'pass', severity: 1, ...site,
          evidence: { observed: ucpUrl + ' declares the Shopify catalog service among ' + listing((ucp.services && ucp.services.keys) || [], 5) + '.' },
          expected: 'Informational.',
          recommendation: 'Nothing to do — this is a platform default, not a merchant achievement.',
          fixable: 'advisory',
          verification: { method: 'header_check', assertion: 'The UCP profile lists the platform catalog service key.' },
          reproduce: repro,
          expected_impact: { axis: 'ai', confidence: 'directional', rationale: 'The declaration is observable; what an agent does with it is not documented.' },
        }));
      }
    }

    /* ---- Merchant Center hint ------------------------------------------------------------------ */
    push(out, mk({
      id: 'M18.agentic.merchant_center_hint', title: 'A verified merchant feed is the documented route for product data into Google\'s shopping surfaces',
      status: 'pass', severity: 1, scope: 'site', fixable: 'advisory',
      location: { url: origin || undefined },
      evidence: { observed: 'Informational: this run has no access to the store\'s Merchant Center account, so no feed state was observed for ' + (origin || 'this site') + '.' },
      expected: 'Product data reaches Google through a verified Merchant Center feed as well as through on-page structured data.',
      recommendation: 'Keep a Merchant Center feed in sync with the site. Google documents it as the authoritative source for shopping and AI shopping surfaces; structured data alone is the fallback.',
      fixable: 'advisory',
      verification: { method: 'manual_review', assertion: 'The store has an active, verified Merchant Center feed (visible only inside the merchant account).' },
      reproduce: { script: 'acp-feed-lint.mjs', args: { feed: (ctx.options && ctx.options.feed_path) || '<feed file>' } },
      expected_impact: { axis: 'both', confidence: 'established', rationale: 'Google documents Merchant Center as the supported channel for product data on its shopping surfaces; we cannot see the account, so this is a hint, not a measurement.' },
    }));

    /* ---- ACP feed ------------------------------------------------------------------------------ */
    const feedPath = ctx.options && ctx.options.feed_path;
    if (!feedPath) {
      push(out, mk({
        id: 'M18.agentic.acp_feed_errors', title: 'No product feed was supplied, so it could not be linted', status: 'needs_api', scope: 'site', fixable: 'advisory',
        location: { url: origin || undefined },
        evidence: { observed: 'The run carries no --feed path, so no Agentic Commerce Protocol feed was read for ' + (origin || 'this site') + '.' },
        expected: 'A JSONL/CSV/TSV product feed passed with --feed so its rows can be validated.',
        recommendation: 'Re-run with --feed <path> to lint item_id, title, description, url, brand, seller_name, image_url, availability and price.',
        fixable: 'advisory',
        verification: { method: 'manual_review', assertion: 'acp-feed-lint.mjs runs against the store\'s feed and reports zero errors.' },
        reproduce: { script: 'acp-feed-lint.mjs', args: { feed: '<feed file>' } },
        expected_impact: { axis: 'both', confidence: 'directional', rationale: 'A feed that was never read is unknown, not clean.' },
      }));
      return out;
    }

    let text = null, readError = null;
    try { text = readFileSync(feedPath, 'utf8'); } catch (e) { readError = String((e && e.message) || e); }
    if (readError) {
      push(out, mk({
        id: 'M18.agentic.acp_feed_errors', title: 'The supplied product feed could not be read', status: 'needs_api', scope: 'site', fixable: 'advisory',
        location: { file: feedPath },
        evidence: { observed: 'Reading ' + feedPath + ' failed: ' + clip(readError, 140) + '.' },
        expected: 'A readable feed file at the supplied path.',
        recommendation: 'Check the path and permissions, then re-run.',
        fixable: 'advisory',
        verification: { method: 'manual_review', assertion: 'The feed file exists and is readable.' },
        reproduce: { script: 'acp-feed-lint.mjs', args: { feed: feedPath } },
        expected_impact: { axis: 'both', confidence: 'directional', rationale: 'An unreadable file yields no observation either way.' },
      }));
      return out;
    }

    const format = detectFormat(text, feedPath);
    const parsedFeed = parseFeed(text, format);
    const lint = lintFeed(parsedFeed.rows, { sample: FEED_SAMPLE });
    if (lint.errors.length) {
      const byReason = new Map();
      for (const e of lint.errors) {
        if (!byReason.has(e.reason)) byReason.set(e.reason, []);
        byReason.get(e.reason).push(e);
      }
      for (const [reason, errs] of byReason) {
        push(out, mk({
          id: 'M18.agentic.acp_feed_errors', title: 'Product feed rows fail validation: ' + reason, status: 'fail', severity: 3, scope: 'site', fixable: 'proposed',
          // `selector` carries the error class: report.mjs dedupes on id + scope + url + file +
          // resource + selector, so without it every error class of one feed collapses into a
          // single surviving finding and the operator only ever sees one of the defects.
          location: { file: feedPath, selector: reason },
          evidence: { observed: plural(errs.length, 'row') + ' of ' + plural(lint.rows, 'row') + ' linted'
            + (lint.sampled ? ' (sampled from ' + lint.rows_total + ' in the ' + format + ' feed)' : ' (the whole ' + format + ' feed)')
            + ' fail with "' + reason + '": ' + listing(errs.map((e) => 'row ' + e.row + ' field ' + e.field + (e.detail ? ' (' + clip(e.detail, 50) + ')' : '')), 4) + '.' },
          expected: 'Every feed row carries the required fields in the documented shape.',
          recommendation: 'Fix the rows listed above at the source that generates the feed; an agent drops the item rather than guessing the missing value.',
          fixable: 'proposed',
          verification: { method: 'manual_review', assertion: 'acp-feed-lint.mjs --strict exits 0 on the feed.' },
          reproduce: { script: 'acp-feed-lint.mjs', args: { feed: feedPath, strict: true } },
          expected_impact: { axis: 'both', confidence: 'directional', rationale: 'The row errors are exact; how each agent handles an invalid row is not documented, so the consequence is directional.' },
        }));
      }
    }

    return out;
  },
};

export default check;

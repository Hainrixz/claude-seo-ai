// M2 (hosting) — states, once, that the audited host is not production.
//
// This matters for the score, not just the report: scripts/score.mjs suppresses the severity-5 caps
// from noindex and robots blocking when the environment is not production, because those directives
// are exactly what a preview or staging host is supposed to serve. Emitting this finding is how the
// run records why those caps were suppressed.

import { mk, push, listing, originOf } from './_shared.mjs';

/** Environments where a site-wide noindex is expected rather than a defect. */
export const NON_PRODUCTION = ['preview', 'staging', 'local', 'development'];

export const check = {
  id: 'hosting-environment',
  module: 'M2',
  scope: 'site',
  ids: ['M2.hosting.preview_environment_audited'],

  run(ctx) {
    const out = [];
    const env = (ctx.profile && ctx.profile.environment) || null;
    const declared = ctx.options && ctx.options.environment;
    const kind = declared || (env && env.kind) || 'production';
    if (!NON_PRODUCTION.includes(kind)) return out;
    const origin = originOf(ctx);

    push(out, mk({
      id: 'M2.hosting.preview_environment_audited', title: 'The audited host is a ' + kind + ' environment, not production',
      status: 'warn', severity: 1, scope: 'site',
      location: { url: origin || undefined },
      evidence: { observed: 'Environment "' + kind + '"' + (declared ? ' (declared for this run)' : ' (detected from ' + listing(((env && env.signals) || []).map((s) => s.kind + ':' + s.value), 3) + ')') + ' for ' + (origin || 'the audited target') + '.' },
      expected: 'Findings are read as describing this environment, and the production host is audited separately.',
      recommendation: 'Re-run the audit against the production URL before acting on the results. On this host a site-wide noindex or a blocking robots.txt is expected, and the scorer suppresses the caps they would otherwise trigger.',
      fixable: 'advisory',
      verification: { method: 'header_check', assertion: 'The audited origin is the production hostname.' },
      reproduce: { script: 'detect-platform.mjs', args: { url: origin || '' } },
      expected_impact: { axis: 'search', confidence: 'established', rationale: 'Preview and staging hosts are documented by their platforms as noindex by default; treating that as a defect would produce a false catastrophic finding.' },
    }));

    return out;
  },
};

export default check;

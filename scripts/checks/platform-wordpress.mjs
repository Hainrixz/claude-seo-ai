// Platform-conditional checks for WordPress (plan 3c). Gated on a medium/high-confidence
// `wordpress` verdict in profile.json.
//
// The rule that shapes this file: when an SEO plugin owns the head, the generic M7 fixes stop being
// correct — injecting tags into the theme fights the plugin. That case is emitted as
// M7.wordpress.plugin_owned_head (not_applicable) naming the plugin, so the fix path becomes a
// plugin-field write instead of a template edit. Anything that needs the filesystem (a physical
// robots.txt shadowing the virtual one) is needs_api without local or SSH access.

import { isAllowed } from '../lib/robots.mjs';
import { flattenNodes } from '../lib/jsonld.mjs';
import { mk, push, clip, listing, plural, agree, contentPages, finalUrl, platformId, originOf, jsonldBlocks } from './_shared.mjs';

/**
 * Archive URL shapes WordPress publishes by default and that are usually thin. The date branch is
 * anchored at BOTH ends: `/2026/`, `/2026/09/` and `/2026/09/05/` are archives, while
 * `/2026/09/05/some-post-slug/` is the most common permalink structure there is — matching it would
 * tell a publisher to noindex its articles.
 */
export const THIN_ARCHIVE_RE = /^\/(?:category|tag|author|page)\/|^\/\d{4}(?:\/\d{2}(?:\/\d{2})?)?\/?$/;
const SEARCH_RE = /[?&]s=/;
const ATTACHMENT_RE = /[?&]attachment_id=/;
const REPLYTOCOM_RE = /[?&]replytocom=/;

/** Sitemap paths the core and the common SEO plugins each publish. */
export const SITEMAP_SOURCES = [
  { path: '/wp-sitemap.xml', owner: 'WordPress core' },
  { path: '/sitemap_index.xml', owner: 'Yoast SEO or Rank Math' },
  { path: '/sitemap.xml', owner: 'All in One SEO (or a core redirect)' },
  { path: '/sitemaps.xml', owner: 'SEOPress' },
];

const pathOf = (u) => { try { return new URL(u).pathname; } catch { return ''; } };
const usableFile = (f) => !!(f && f.status >= 200 && f.status < 300 && f.kind && f.kind !== 'invalid');

/**
 * What each WordPress sitemap path actually serves, from site/sitemaps.json.
 *
 * The distinction this exists to draw: a path that 301s to another path is the SAME sitemap under a
 * second name, and so is a path that serves a byte-identical URL set. `/wp-sitemap.xml` ->
 * `/sitemap_index.xml` -> `/sitemap.xml` is one source doing the right thing, and reporting it as
 * "two sitemap sources report different URL sets and lastmod values" was a false claim about a
 * correctly configured site. Duplication is only claimed when two DIFFERENT documents were fetched
 * and their URL sets differ.
 *
 * @returns {{sources: Array, live: Array, aliases: Array, comparable: boolean}}
 *   `live` holds one entry per distinct document; `aliases` the paths that resolve onto one of them;
 *   `comparable` is true only when every live source's URL list was actually collected.
 */
export function sitemapSources(sitemaps) {
  const files = (sitemaps && Array.isArray(sitemaps.files) ? sitemaps.files : []);
  const urls = (sitemaps && Array.isArray(sitemaps.urls) ? sitemaps.urls : []);
  const truncated = !!(sitemaps && (sitemaps.truncated_files || sitemaps.truncated_urls));
  const byUrl = new Map(files.map((f) => [f.url, f]));

  /** Every file reachable from `root` through the parent links, including root itself. */
  const treeOf = (root) => {
    const ids = new Set([root.url]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of files) if (!ids.has(f.url) && f.parent && ids.has(f.parent)) { ids.add(f.url); grew = true; }
    }
    return ids;
  };

  const sources = [];
  for (const spec of SITEMAP_SOURCES) {
    const file = files.find((f) => pathOf(f.url) === spec.path);
    if (!file) continue;
    const tree = treeOf(file);
    const collected = urls.filter((u) => tree.has(u.sitemap)).map((u) => u.loc);
    // An alias contributes no URLs of its own (lib/sitemaps.mjs stops at the alias), and neither
    // does a tree the file budget cut short — either way the set is unknown, not empty.
    const knowable = !file.alias_of && !truncated;
    sources.push({
      ...spec,
      url: file.url,
      final_url: file.final_url || file.url,
      redirected: !!file.redirected || !!(file.final_url && file.final_url !== file.url),
      status: file.status,
      kind: file.kind,
      alias_of: file.alias_of || null,
      usable: usableFile(file),
      url_count: file.url_count || 0,
      urls: collected,
      urls_known: knowable && collected.length > 0,
    });
  }

  // Group by the document each path actually serves: the post-redirect URL, or the file another
  // path already fetched. The path that OWNS the document is the live one, so a redirect is always
  // described as pointing at its target rather than the other way round.
  const live = [];
  const aliases = [];
  const seen = new Map();
  const usable = sources.filter((x) => x.usable);
  for (const s of [...usable.filter((x) => !x.alias_of), ...usable.filter((x) => x.alias_of)]) {
    const id = s.alias_of ? ((byUrl.get(s.alias_of) || {}).final_url || s.alias_of) : s.final_url;
    if (seen.has(id)) { aliases.push({ ...s, alias_for: seen.get(id).path }); continue; }
    seen.set(id, s);
    live.push(s);
  }
  return { sources, live, aliases, comparable: live.every((s) => s.urls_known) };
}

/** True when two URL lists describe the same set of pages. */
export function sameUrlSet(a, b) {
  const A = new Set(a || []), B = new Set(b || []);
  if (A.size !== B.size) return false;
  for (const u of A) if (!B.has(u)) return false;
  return true;
}

export const check = {
  id: 'platform-wordpress',
  module: 'M2',
  scope: 'site',
  ids: [
    'M2.wordpress.blog_public_off', 'M2.wordpress.attachment_pages_indexable', 'M2.wordpress.thin_archives_indexable',
    'M1.wordpress.replytocom_crawlable', 'M1.wordpress.physical_robots_shadowing',
    'M17.wordpress.duplicate_sitemaps', 'M17.wordpress.no_sitemap_any',
    'M5.wordpress.plugin_schema_incomplete', 'M5.wordpress.duplicate_schema_sources',
    'M7.wordpress.plugin_owned_head',
  ],

  run(ctx) {
    const out = [];
    if (platformId(ctx) !== 'wordpress') return out;
    const pages = contentPages(ctx);
    const origin = originOf(ctx);
    const robots = ctx.site && ctx.site.robots;
    const robotsUrl = (robots && robots.url) || (origin || '') + '/robots.txt';
    const robotsRepro = { script: 'parse-robots-sitemap.mjs', args: { url: robotsUrl, path: '/' } };
    const plugins = (ctx.profile && ctx.profile.cms_plugins) || [];
    const seoPlugin = plugins.find((p) => /seo|rank-?math|aioseo|seopress/i.test(p.id || ''));

    /* ---- blog_public = 0 --------------------------------------------------------------------- */
    const allNoindex = pages.length > 0 && pages.every((p) => {
      const eff = p.snapshot && p.snapshot.robots_directives && p.snapshot.robots_directives.effective;
      return eff && eff.noindex;
    });
    const rootBlocked = robots && robots.verdicts && robots.verdicts.Googlebot && robots.verdicts.Googlebot.allowed === false;
    if (allNoindex && rootBlocked) {
      push(out, mk({
        id: 'M2.wordpress.blog_public_off', title: 'The site is set to discourage search engines (blog_public = 0)',
        status: 'fail', severity: 5, scope: 'site',
        location: { url: origin || undefined, resource: 'option blog_public' },
        evidence: { observed: 'All ' + plural(pages.length, 'sampled page') + ' ' + agree(pages.length, 'serves', 'serve') + ' noindex and robots.txt disallows Googlebot at the root — the exact pair WordPress emits when Settings > Reading > "Discourage search engines" is on.' },
        expected: 'blog_public = 1 on a site that should be indexed.',
        recommendation: 'Turn off "Discourage search engines from indexing this site" in Settings > Reading (or run `wp option update blog_public 1`), then request re-indexing.',
        fixable: 'proposed',
        verification: { method: 'header_check', assertion: 'Pages no longer carry noindex and robots.txt no longer disallows Googlebot at the root.' },
        reproduce: robotsRepro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'WordPress documents that blog_public = 0 emits a site-wide noindex and a blocking robots.txt; the site cannot appear in Search while it is set.' },
      }));
    }

    /* ---- indexable attachment pages, thin archives, replytocom ------------------------------- */
    const indexable = pages.filter((p) => {
      const eff = p.snapshot && p.snapshot.robots_directives && p.snapshot.robots_directives.effective;
      return !(eff && eff.noindex);
    });
    const attachments = indexable.filter((p) => ATTACHMENT_RE.test(finalUrl(p) || ''));
    if (attachments.length) {
      push(out, mk({
        id: 'M2.wordpress.attachment_pages_indexable', title: 'Attachment pages are indexable', status: 'warn', severity: 2, scope: 'site',
        location: { url: finalUrl(attachments[0]) },
        evidence: { observed: plural(attachments.length, 'attachment URL') + ' ' + agree(attachments.length, 'is crawlable and carries', 'are crawlable and carry') + ' no noindex: ' + listing(attachments.map((p) => finalUrl(p)), 4) + '.' },
        expected: 'Attachment pages redirect to the file or the parent post, or carry noindex.',
        recommendation: 'Disable attachment pages (most SEO plugins expose the setting; core has wp_attachment_pages_enabled) so an image does not get its own thin URL.',
        fixable: 'proposed',
        verification: { method: 'dom_assert', assertion: 'Attachment URLs redirect or carry noindex.' },
        reproduce: { script: 'parse-html.mjs', args: { url: finalUrl(attachments[0]) } },
        expected_impact: { axis: 'search', confidence: 'directional', rationale: 'Attachment pages are near-empty duplicates of the media they wrap; Google does not document a penalty, so the cost is index bloat.' },
      }));
    }

    const thin = indexable.filter((p) => {
      const u = finalUrl(p) || '';
      let path = '';
      try { path = new URL(u).pathname; } catch { path = ''; }
      return THIN_ARCHIVE_RE.test(path) || SEARCH_RE.test(u);
    });
    if (thin.length) {
      push(out, mk({
        id: 'M2.wordpress.thin_archives_indexable', title: 'Date, author, tag or search archives are indexable', status: 'warn', severity: 2, scope: 'site',
        location: { url: finalUrl(thin[0]) },
        evidence: { observed: plural(thin.length, 'archive/search URL') + ' ' + agree(thin.length, 'is', 'are') + ' indexable: ' + listing(thin.map((p) => finalUrl(p)), 4) + '.' },
        expected: 'Only the archives that have their own demand are indexable; search results never are.',
        recommendation: 'Set the date, author and search archives to noindex in the SEO plugin, and keep the category/tag archives that earn traffic.',
        fixable: 'advisory',
        verification: { method: 'dom_assert', assertion: 'The thin archive URLs carry noindex.' },
        reproduce: { script: 'parse-html.mjs', args: { url: finalUrl(thin[0]) } },
        expected_impact: { axis: 'search', confidence: 'directional', rationale: 'Google documents that internal search results should not be indexed; for date and author archives it publishes no rule, so this is a judgement about duplication.' },
      }));
    }

    const replytocom = [];
    for (const page of pages) {
      for (const a of (page.parsed && page.parsed.anchors) || []) {
        if (a && a.abs && REPLYTOCOM_RE.test(a.abs)) replytocom.push({ from: finalUrl(page), url: a.abs });
      }
    }
    if (replytocom.length) {
      const allowed = robots && robots.parsed ? isAllowed(robots.parsed, 'Googlebot', replytocom[0].url) : null;
      if (!allowed || allowed.allowed !== false) {
        push(out, mk({
          id: 'M1.wordpress.replytocom_crawlable', title: '?replytocom= links are crawlable', status: 'warn', severity: 1, scope: 'site',
          location: { url: replytocom[0].url },
          evidence: { observed: plural(replytocom.length, 'link') + ' with ?replytocom= (e.g. ' + clip(replytocom[0].url, 90) + ' on ' + replytocom[0].from + ') and robots.txt does not disallow it.' },
          expected: 'Comment-reply URLs are not crawlable — they duplicate the post once per comment.',
          recommendation: 'Add `Disallow: /*?replytocom=` to robots.txt, or turn off threaded comments.',
          fixable: 'advisory',
          verification: { method: 'robots_parse', assertion: 'isAllowed(robots, "Googlebot", "<post>?replytocom=1") is false.' },
          reproduce: robotsRepro,
          expected_impact: { axis: 'search', confidence: 'directional', rationale: 'Each reply link is a parameter duplicate of the post; the crawl cost scales with comment count, which this crawl only sampled.' },
        }));
      }
    }

    /* ---- robots.txt ownership ------------------------------------------------------------------ */
    const hasProjectRoot = !!(ctx.profile && ctx.profile.target && ctx.profile.target.project_root);
    if (!hasProjectRoot) {
      push(out, mk({
        id: 'M1.wordpress.physical_robots_shadowing', title: 'Whether a physical robots.txt shadows the virtual one was not checked',
        status: 'needs_api', scope: 'site',
        location: { url: robotsUrl, resource: 'robots.txt' },
        evidence: { observed: 'The profile carries no project_root, so the WordPress document root could not be inspected for a physical robots.txt file. The HTTP response alone cannot tell a physical file from the virtual one WordPress generates.' },
        expected: 'Local or SSH access to the document root, so the presence of a real robots.txt file can be confirmed.',
        recommendation: 'Run the audit with --path <wordpress root> (or check over SSH). A physical robots.txt silently overrides every plugin robots editor.',
        fixable: 'advisory',
        verification: { method: 'robots_parse', assertion: 'No robots.txt file exists in the WordPress document root, or its content is the one the plugin shows.' },
        reproduce: robotsRepro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'WordPress documents that its robots.txt is virtual and that a real file takes precedence; only the filesystem can distinguish the two.' },
      }));
    }

    /* ---- sitemap sources ------------------------------------------------------------------------ */
    const { sources, live, aliases, comparable } = sitemapSources(ctx.site && ctx.site.sitemaps);
    const describe = (s) => s.path + ' (' + s.owner + ')';
    const aliasNote = aliases.length
      ? ' ' + listing(aliases.map((a) => a.path + ' ' + (a.redirected ? 'redirects to' : 'serves the same document as') + ' ' + a.alias_for), 3)
        + ', so ' + agree(aliases.length, 'it is', 'they are') + ' the same sitemap under another name.'
      : '';
    // Two paths that answer are not two sitemaps: the URL sets decide. See sitemapSources().
    const differing = live.length >= 2 && comparable
      ? live.filter((s, i) => live.some((other, j) => i !== j && !sameUrlSet(s.urls, other.urls)))
      : [];
    if (live.length >= 2 && (!comparable || differing.length)) {
      const known = comparable && differing.length;
      push(out, mk({
        id: 'M17.wordpress.duplicate_sitemaps', title: 'Core and plugin sitemaps are both live', status: 'warn', severity: 3, scope: 'site',
        location: { url: live[0].final_url || ((origin || '') + live[0].path) },
        evidence: { observed: listing(live.map(describe), 4) + ' — ' + plural(live.length, 'separate document')
          + ' ' + agree(live.length, 'returns', 'return') + ' a usable sitemap'
          + (known
            ? ': ' + listing(live.map((s) => s.path + ' lists ' + plural(s.urls.length, 'URL')), 4) + ', and the sets are not the same.'
            : ', and their URL lists were not both collected in this run, so whether they disagree is unmeasured.')
          + aliasNote },
        expected: 'One sitemap source per site.',
        recommendation: 'Disable the core sitemap when an SEO plugin generates one (or the reverse), and keep a single `Sitemap:` line in robots.txt.',
        fixable: 'advisory',
        verification: { method: 'xml_parse', assertion: 'Exactly one sitemap index is served by the site.' },
        reproduce: robotsRepro,
        expected_impact: known
          ? { axis: 'search', confidence: 'established', rationale: 'The two sources publish different URL sets for the same site, which Search Console surfaces as conflicting coverage.' }
          : { axis: 'search', confidence: 'directional', rationale: 'Two documents answer, but this run did not collect both URL lists, so the cost is an inference rather than a measured disagreement.' },
      }));
    } else if (live.length >= 2 || aliases.length) {
      // The honest version of the old false positive: several paths answered, one sitemap.
      const same = live.length >= 2;
      push(out, mk({
        id: 'M17.wordpress.duplicate_sitemaps', title: 'One sitemap source, reachable under more than one path', status: 'pass', severity: 3, scope: 'site',
        location: { url: live.length ? (live[0].final_url || ((origin || '') + live[0].path)) : (origin || '') + aliases[0].path },
        evidence: { observed: listing(sources.filter((s) => s.usable).map(describe), 4) + ' ' + agree(sources.filter((s) => s.usable).length, 'answers', 'answer') + '.'
          + aliasNote
          + (same ? ' ' + listing(live.map((s) => s.path + ' lists ' + plural(s.urls.length, 'URL')), 4) + ' — the same set, so there is one source, not two.' : '') },
        expected: 'One sitemap source per site.',
        recommendation: 'No action needed: the extra paths resolve to the one sitemap. Keep a single `Sitemap:` line in robots.txt pointing at it.',
        fixable: 'advisory',
        verification: { method: 'xml_parse', assertion: 'The extra sitemap paths redirect to, or serve, the same document as the declared one.' },
        reproduce: robotsRepro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'A redirect or an identical URL set is one sitemap under two names; Google follows the redirect and reads one source.' },
      }));
    } else if (!live.length && (!ctx.site || !ctx.site.sitemaps || !ctx.site.sitemaps.found)) {
      push(out, mk({
        id: 'M17.wordpress.no_sitemap_any', title: 'Neither the core nor a plugin sitemap is reachable', status: 'fail', severity: 3, scope: 'site',
        location: { url: (origin || '') + '/wp-sitemap.xml' },
        evidence: { observed: 'None of ' + listing(SITEMAP_SOURCES.map((s) => s.path), 4) + ' returned a usable sitemap.' },
        expected: 'At least one of the core or plugin sitemaps is served.',
        recommendation: 'Re-enable the core sitemap (it is on by default since WordPress 5.5) or the SEO plugin\'s, then declare it in robots.txt.',
        fixable: 'advisory',
        verification: { method: 'xml_parse', assertion: 'One of the WordPress sitemap paths returns a valid sitemap index.' },
        reproduce: robotsRepro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'WordPress ships a sitemap by default; its absence usually means a plugin disabled it without replacing it.' },
      }));
    }

    /* ---- schema ownership ------------------------------------------------------------------------ */
    for (const page of pages) {
      const nodes = [];
      for (const b of jsonldBlocks(page)) {
        if (b.data === undefined) continue;
        for (const n of flattenNodes(b.data)) nodes.push(n);
      }
      const orgs = nodes.filter((n) => n.types.some((t) => t === 'Organization' || t === 'LocalBusiness'));
      if (orgs.length >= 2) {
        push(out, mk({
          id: 'M5.wordpress.duplicate_schema_sources', title: 'Theme and plugin both emit an Organization node', status: 'warn', severity: 3, scope: 'page',
          location: { url: finalUrl(page) },
          evidence: { observed: orgs.length + ' Organization/LocalBusiness nodes on ' + finalUrl(page) + ' across ' + plural(new Set(orgs.map((o) => o.block)).size, 'ld+json block') + ': ' + listing(orgs.map((o) => o.path + ' "' + clip(o.node.name, 40) + '"'), 4) + '.' },
          expected: 'One entity graph per page, from one source.',
          recommendation: 'Let the SEO plugin own the Organization graph and remove the theme\'s copy (or the reverse) — two graphs describing the same entity conflict.',
          fixable: 'advisory',
          verification: { method: 'schema_validator', assertion: 'The page emits a single Organization/LocalBusiness node.' },
          reproduce: { script: 'validate-jsonld.mjs', args: { url: finalUrl(page) } },
          expected_impact: { axis: 'both', confidence: 'established', rationale: 'Google documents that duplicate, conflicting structured data for one entity can cause it to be ignored.' },
        }));
      } else if (orgs.length === 1 && seoPlugin) {
        const org = orgs[0];
        const missing = ['logo', 'sameAs'].filter((k) => !org.node[k] || (Array.isArray(org.node[k]) && !org.node[k].length));
        if (missing.length) {
          push(out, mk({
            id: 'M5.wordpress.plugin_schema_incomplete', title: 'The SEO plugin\'s entity graph is incomplete', status: 'warn', severity: 3, scope: 'site',
            location: { url: finalUrl(page), resource: seoPlugin.id + ' schema settings' },
            evidence: { observed: org.path + ' on ' + finalUrl(page) + ' (emitted by ' + seoPlugin.id + ') lacks ' + listing(missing, 3) + '.' },
            expected: 'The Organization node carries a logo and the sameAs profiles that identify the entity.',
            recommendation: 'Fill the plugin\'s knowledge-graph fields (logo and the social/authority profile URLs) rather than adding a second graph in the theme.',
            fixable: 'advisory',
            verification: { method: 'schema_validator', assertion: 'The Organization node exposes logo and a non-empty sameAs array.' },
            reproduce: { script: 'validate-jsonld.mjs', args: { url: finalUrl(page) } },
            expected_impact: { axis: 'both', confidence: 'established', rationale: 'Google documents logo and sameAs as the properties that connect an Organization to its knowledge panel and profiles.' },
          }));
        }
      }
    }

    /* ---- head ownership --------------------------------------------------------------------------- */
    if (seoPlugin) {
      push(out, mk({
        id: 'M7.wordpress.plugin_owned_head', title: 'The head is owned by an SEO plugin', status: 'not_applicable', scope: 'site',
        location: { url: origin || undefined, resource: seoPlugin.id },
        evidence: { observed: 'Owner: ' + seoPlugin.id + ' (' + seoPlugin.confidence + ' confidence, signals: ' + listing((seoPlugin.signals || []).map((s) => s.kind + ':' + s.value), 3) + '). It emits the title, canonical, robots meta, Open Graph tags and JSON-LD.' },
        expected: 'Head fixes are applied through the plugin\'s fields, not by injecting tags into the theme.',
        recommendation: 'Apply M7/M8/M5 fixes as plugin-field edits (per post/term SEO fields or the plugin\'s templates). Injecting the same tags in header.php produces duplicates the plugin will keep overwriting.',
        fixable: 'advisory',
        verification: { method: 'dom_assert', assertion: 'The head tags are emitted by the plugin, so editing the plugin fields changes them.' },
        reproduce: { script: 'detect-platform.mjs', args: { url: origin || '' } },
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'The plugin re-renders the head on every request; a theme-level duplicate cannot win, so the generic AUTO fix would be wrong here.' },
      }));
    }

    return out;
  },
};

export default check;

// M9 — images and media. Alt text and intrinsic dimensions come straight from the parsed DOM;
// video coverage is inferred from the embeds the page actually carries, never from the topic.
//
// Only images in content regions are judged: an unlabelled icon in the nav is boilerplate, and
// parseDocument already tells us which region every <img> sits in.

import { mk, push, clip, listing, plural, agree, finalUrl, isContentPage, snapRepro, jsonldBlocks } from './_shared.mjs';
import { collectTypes } from '../lib/jsonld.mjs';

/** Embed hosts that mean "this page carries a video" without a <video> element. */
export const VIDEO_EMBED_RE = /(?:^|\.)(?:youtube\.com|youtube-nocookie\.com|youtu\.be|player\.vimeo\.com|vimeo\.com|fast\.wistia\.net|wistia\.com|dailymotion\.com|players\.brightcove\.net|videopress\.com|loom\.com)$/i;

function isVideoEmbed(src) {
  if (!src) return false;
  try { return VIDEO_EMBED_RE.test(new URL(src).hostname); } catch { return false; }
}

/**
 * Quote the tag from the attributes it actually carries. An absent `src` used to be printed as
 * `src=""`, which reads as markup the page does not contain: a Vue `<img :src=… :alt=…>` was quoted
 * as `<img src="" width="96" height="96">`, and a reader could conclude the theme ships an empty src.
 */
const tag = (img) => {
  const src = clip(img.src || img.abs || '', 80);
  return '<img' + (src ? ' src="' + src + '"' : '')
    + (img.alt_present ? ' alt="' + clip(img.alt, 40) + '"' : '')
    + (img.width ? ' width="' + img.width + '"' : '')
    + (img.height ? ' height="' + img.height + '"' : '') + '>';
};

/**
 * The caveat a framework-bound image needs: a Vue/Alpine/Angular `:src`/`:alt` is written by
 * JavaScript, so the plain attribute is absent from the static HTML this check reads. The finding
 * still stands for a consumer that does not run scripts — the evidence just stops implying the
 * theme shipped an empty attribute.
 */
const boundNote = (imgs) => {
  const bound = imgs.filter((i) => Array.isArray(i.bound) && i.bound.length);
  if (!bound.length) return '';
  const attrs = [...new Set(bound.flatMap((i) => i.bound))].sort();
  const alt = bound.filter((i) => i.bound.some((k) => k.endsWith('alt'))).length;
  return ' ' + bound.length + ' of them ' + agree(bound.length, 'carries', 'carry')
    + ' framework-bound attributes instead (' + listing(attrs, 3) + ')'
    + (alt ? '; the alt on ' + alt + ' of those is written by JavaScript, which a consumer that does not run scripts never sees' : '')
    + '.';
};

export const check = {
  id: 'images',
  module: 'M9',
  scope: 'page',
  ids: ['M9.alt.missing', 'M9.img.no_dimensions', 'M9.video.missing_videoobject'],

  run(ctx) {
    const out = [];
    const page = ctx.page;
    if (!page || !isContentPage(page)) return out;
    const parsed = page.parsed || {};
    const url = finalUrl(page);
    const repro = snapRepro(ctx, page, 'parse-html.mjs');
    const at = { location: { url } };

    const images = (parsed.images || []).filter((i) => i && i.in_content);
    const missingAlt = images.filter((i) => !i.alt_present);
    const unsized = images.filter((i) => !i.sized);

    if (missingAlt.length) {
      push(out, mk({
        id: 'M9.alt.missing', title: 'Content images have no alt attribute', status: 'fail', severity: 3, scope: 'page', ...at,
        evidence: { observed: plural(missingAlt.length, 'content <img>') + ' of ' + images.length + ' ' + agree(missingAlt.length, 'has', 'have') + ' no alt attribute: ' + listing(missingAlt.map(tag), 3) + '.' + boundNote(missingAlt) },
        expected: 'Every content image carries an alt attribute — descriptive text, or alt="" when the image is purely decorative.',
        recommendation: 'Add alt text describing what each image shows. Decorative images take an explicit empty alt so assistive technology skips them.',
        fixable: 'proposed',
        verification: { method: 'dom_assert', assertion: 'Every <img> inside the content region has an alt attribute.' },
        reproduce: repro,
        expected_impact: { axis: 'both', confidence: 'established', rationale: 'Google documents alt text as how it understands an image, and it is the only textual handle a non-visual consumer has on the image.' },
      }));
    }

    if (unsized.length) {
      push(out, mk({
        id: 'M9.img.no_dimensions', title: 'Content images declare no width/height', status: 'warn', severity: 3, scope: 'page', ...at,
        evidence: { observed: plural(unsized.length, 'content <img>') + ' of ' + images.length + ' ' + agree(unsized.length, 'lacks', 'lack') + ' numeric width and height: ' + listing(unsized.map(tag), 3) + '.' },
        expected: 'Each <img> declares its intrinsic width and height in pixels so the browser can reserve the space.',
        recommendation: 'Add width and height attributes (or an aspect-ratio in CSS) matching the file\'s intrinsic size.',
        fixable: 'auto',
        verification: { method: 'dom_assert', assertion: 'Every content <img> carries numeric width and height attributes.' },
        reproduce: repro,
        expected_impact: { axis: 'both', confidence: 'directional', rationale: 'Unsized images are a documented cause of layout shift, but whether they move CLS on this page depends on the layout, which static HTML cannot settle.' },
      }));
    }

    /* ---- video ------------------------------------------------------------------------------ */
    const embeds = (parsed.iframes || []).filter((f) => isVideoEmbed(f.abs || f.src));
    if (embeds.length) {
      const types = new Set();
      for (const b of jsonldBlocks(page)) for (const t of collectTypes(b.data, { deep: true })) types.add(t);
      if (!types.has('VideoObject')) {
        push(out, mk({
          id: 'M9.video.missing_videoobject', title: 'Embedded video with no VideoObject markup', status: 'warn', severity: 3, scope: 'page', ...at,
          evidence: { observed: plural(embeds.length, 'video embed') + ' on ' + url + ' (' + listing(embeds.map((e) => clip(e.abs || e.src, 70)), 3) + ') and no VideoObject in the page\'s JSON-LD (types found: ' + (types.size ? listing([...types], 6) : 'none') + ').' },
          expected: 'Each embedded video is described by a VideoObject with name, description, thumbnailUrl and uploadDate.',
          recommendation: 'Add VideoObject JSON-LD for the embedded video, using the schema/jsonld-templates/videoobject.json template.',
          fixable: 'proposed',
          verification: { method: 'schema_validator', assertion: 'The page emits a VideoObject node with the required properties.' },
          reproduce: snapRepro(ctx, page, 'validate-jsonld.mjs'),
          expected_impact: { axis: 'both', confidence: 'established', rationale: 'Google documents VideoObject as the requirement for video rich results and for the video to appear in the Videos tab.' },
        }));
      }
    }

    return out;
  },
};

export default check;

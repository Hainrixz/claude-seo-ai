// M8 — Open Graph / Twitter cards. Presence is read from the parsed head; reachability is the only
// part that costs a request, so it is budgeted, skipped entirely when no fetch implementation is
// injected, and never performed when CLAUDE_SEO_AI_OFFLINE=1.
//
// When the image does answer, its first bytes are sniffed with lib/imgsize.mjs so the evidence can
// state the real pixel size instead of asserting a size we never measured.

import { imageSize, OG_IMAGE_MIN } from '../lib/imgsize.mjs';
import { mk, push, clip, finalUrl, isContentPage, snapRepro, runState } from './_shared.mjs';

/** At most this many og:image URLs are fetched per run, whatever the page count. */
export const OG_PROBE_BUDGET = 8;
/** Only the head of the image is needed to read its dimensions. */
export const OG_PROBE_BYTES = 65536;

const IMAGE_TYPES = /^image\//i;

function metaValue(parsed, key) {
  for (const m of (parsed && parsed.metas) || []) {
    if (!m) continue;
    if (m.property === key || m.name === key) {
      const v = typeof m.content === 'string' ? m.content.trim() : '';
      if (v) return v;
    }
  }
  return null;
}

function absolutize(value, base) {
  if (!value) return null;
  try { return new URL(value, base || undefined).href; } catch { return null; }
}

export const check = {
  id: 'social',
  module: 'M8',
  scope: 'page',
  ids: ['M8.og.missing_image', 'M8.og.image_unreachable', 'M8.twitter.no_card'],

  async run(ctx) {
    const out = [];
    const page = ctx.page;
    if (!page || !isContentPage(page)) return out;
    const parsed = page.parsed || {};
    const url = finalUrl(page);
    const repro = snapRepro(ctx, page, 'parse-html.mjs');
    const at = { location: { url } };

    const ogImage = metaValue(parsed, 'og:image') || metaValue(parsed, 'og:image:url') || metaValue(parsed, 'twitter:image');
    const abs = absolutize(ogImage, parsed.effective_base || url);

    if (!ogImage) {
      push(out, mk({
        id: 'M8.og.missing_image', title: 'No og:image on the page', status: 'fail', severity: 2, scope: 'page', ...at,
        evidence: { observed: 'No <meta property="og:image">, og:image:url or twitter:image in the head of ' + url + '.' },
        expected: 'An absolute og:image URL pointing at a shareable preview image.',
        recommendation: 'Add <meta property="og:image" content="<absolute image URL>"> (at least ' + OG_IMAGE_MIN.width + '×' + OG_IMAGE_MIN.height + ' px) to the template.',
        fixable: 'auto',
        verification: { method: 'dom_assert', assertion: 'meta[property="og:image"] exists with an absolute URL.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'established', rationale: 'The Open Graph protocol and the platforms that consume it document og:image as the source of the shared preview; without it the platform picks an arbitrary image or none.' },
      }));
    } else {
      const fetchImpl = ctx.tools && ctx.tools.fetchImpl;
      const offline = process.env.CLAUDE_SEO_AI_OFFLINE === '1' || (ctx.options && ctx.options.no_network);
      const state = runState(ctx);
      if (abs && fetchImpl && !offline && state.og_probes < OG_PROBE_BUDGET) {
        state.og_probes++;
        let res = null;
        try {
          res = await fetchImpl(abs, { returnBuffer: true, maxBytes: OG_PROBE_BYTES, timeoutMs: 10000, retries: 0 });
        } catch (e) {
          res = { ok: false, status: 0, error: String((e && e.message) || e), headers: {} };
        }
        const status = res ? res.status : 0;
        const type = (res && res.headers && res.headers['content-type']) || '';
        const buf = res && res.body && res.body.buffer;
        const size = buf ? imageSize(buf) : { format: null, width: null, height: null, error: 'no bytes read' };
        const badStatus = !res || !res.ok || status < 200 || status >= 300;
        const badType = !badStatus && type && !IMAGE_TYPES.test(String(type));
        const badBytes = !badStatus && !badType && !size.format;
        // The sniffed dimensions are the only way to tell a real card image from a 1×1 tracking pixel
        // or a favicon someone reused; the platforms refuse anything under 200×200 for a card.
        const tooSmall = !badStatus && !badType && !badBytes
          && (size.width < OG_IMAGE_MIN.width || size.height < OG_IMAGE_MIN.height);
        if (badStatus || badType || badBytes || tooSmall) {
          const observed = badStatus
            ? 'GET ' + abs + ' -> HTTP ' + status + (res && res.error ? ' (' + clip(res.error, 100) + ')' : '') + ', declared as og:image on ' + url + '.'
            : badType
              ? 'GET ' + abs + ' -> HTTP ' + status + ' with content-type "' + clip(type, 60) + '", which is not an image type.'
              : badBytes
                ? 'GET ' + abs + ' -> HTTP ' + status + ' but the first ' + (size.bytes || 0) + ' bytes are not a PNG, JPEG, GIF or WebP file (' + size.error + ').'
                : 'GET ' + abs + ' -> HTTP ' + status + ', a ' + size.format.toUpperCase() + ' measuring ' + size.width + '×' + size.height + ' px, below the ' + OG_IMAGE_MIN.width + '×' + OG_IMAGE_MIN.height + ' px the card formats require.';
          push(out, mk({
            id: 'M8.og.image_unreachable',
            title: tooSmall ? 'og:image is too small for the card formats' : 'og:image does not resolve to a usable image',
            status: 'fail', severity: 2, scope: 'page', ...at,
            evidence: { observed },
            expected: 'The og:image URL returns 200 with an image content type, decodable bytes and at least ' + OG_IMAGE_MIN.width + '×' + OG_IMAGE_MIN.height + ' px.',
            recommendation: tooSmall
              ? 'Point og:image at a larger asset (1200×630 px is the usual choice for a large card).'
              : 'Point og:image at a URL that is publicly reachable and returns a real image; social crawlers do not follow logins or execute JavaScript.',
            fixable: 'proposed',
            verification: { method: 'header_check', assertion: 'GET the og:image URL returns 200 with an image/* content type and at least ' + OG_IMAGE_MIN.width + '×' + OG_IMAGE_MIN.height + ' px.' },
            reproduce: repro,
            expected_impact: { axis: 'search', confidence: 'established', rationale: 'The consuming platforms document that they fetch og:image server-side and publish a minimum size; an unreachable or undersized image yields no preview or a downgraded one.' },
          }));
        }
      }
    }

    /* ---- twitter:card ------------------------------------------------------------------------ */
    if (!metaValue(parsed, 'twitter:card')) {
      push(out, mk({
        id: 'M8.twitter.no_card', title: 'No twitter:card declared', status: 'warn', severity: 2, scope: 'page', ...at,
        evidence: { observed: 'No <meta name="twitter:card"> on ' + url + (ogImage ? '; the page falls back to its Open Graph tags (og:image "' + clip(ogImage, 80) + '").' : '; the page has no Open Graph image to fall back to either.') },
        expected: 'A twitter:card value (summary or summary_large_image) alongside the Open Graph tags.',
        recommendation: 'Add <meta name="twitter:card" content="summary_large_image"> to the template.',
        fixable: 'auto',
        verification: { method: 'dom_assert', assertion: 'meta[name="twitter:card"] exists with a documented card type.' },
        reproduce: repro,
        expected_impact: { axis: 'search', confidence: 'directional', rationale: 'X falls back to Open Graph tags when the card type is absent, so the cost is the larger card format rather than the preview itself.' },
      }));
    }

    return out;
  },
};

export default check;

// Shared numeric bands. One source of truth for the title/description length bands used by
// parse-html.mjs, the on-page checks and the seo-meta-onpage skill, and for the letter bands of
// the two scores. Pure constants + tiny helpers; no I/O.

/** <title> length in characters: [min, max]. `pass` is the acceptance band, `recommended` the sweet spot. */
export const TITLE = Object.freeze({ pass: Object.freeze([30, 60]), recommended: Object.freeze([50, 60]) });

/** meta description length in characters: [min, max]. */
export const DESCRIPTION = Object.freeze({ pass: Object.freeze([70, 160]), recommended: Object.freeze([150, 160]) });

/** Letter-band floors for a 0-100 score. Anything below D is F. */
export const BANDS = Object.freeze({ A: 90, B: 80, C: 70, D: 60 });

/**
 * Letter band for a score value. `null`/`undefined`/NaN (an unscored axis) yields 'unscored' so a
 * missing score never masquerades as an F.
 */
export function band(value) {
  if (value === null || value === undefined || typeof value !== 'number' || Number.isNaN(value)) return 'unscored';
  if (value >= BANDS.A) return 'A';
  if (value >= BANDS.B) return 'B';
  if (value >= BANDS.C) return 'C';
  if (value >= BANDS.D) return 'D';
  return 'F';
}

/**
 * Classify a length against a band spec ({pass:[min,max], recommended:[min,max]}).
 * Returns 'short' | 'long' | 'pass' | 'recommended'. A length inside the recommended range is
 * 'recommended'; inside the pass range but outside recommended is 'pass'.
 */
export function lengthVerdict(length, spec) {
  const n = Number(length) || 0;
  const [pmin, pmax] = spec.pass;
  if (n < pmin) return 'short';
  if (n > pmax) return 'long';
  const [rmin, rmax] = spec.recommended || spec.pass;
  return n >= rmin && n <= rmax ? 'recommended' : 'pass';
}

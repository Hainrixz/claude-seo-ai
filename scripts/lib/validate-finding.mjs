// Structural validation of findings against schema/finding.schema.json using lib/schema-lite.mjs.
// Used by score.mjs (drop + report invalid findings), report.mjs and lib/finding.mjs.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { validate, formatErrors } from './schema-lite.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = resolve(HERE, '..', '..');
export const FINDING_SCHEMA_PATH = resolve(PLUGIN_ROOT, 'schema', 'finding.schema.json');

/** The parsed finding schema (read once at import). */
export const FINDING_SCHEMA = JSON.parse(readFileSync(FINDING_SCHEMA_PATH, 'utf8'));

/**
 * Validate one finding.
 * @returns {{ ok: boolean, errors: string[] }} errors as "path: message" strings ("$" = root)
 */
export function validateFinding(finding) {
  const r = validate(FINDING_SCHEMA, finding);
  return { ok: r.ok, errors: formatErrors(r.errors) };
}

/**
 * Validate a list. Returns the valid findings (same objects, in order) and the dropped ones with
 * their original index, id (when it was a string) and error strings.
 * @returns {{ valid: object[], dropped: Array<{ index: number, id: string|null, errors: string[] }> }}
 */
export function validateFindings(list) {
  const valid = [], dropped = [];
  (Array.isArray(list) ? list : []).forEach((f, index) => {
    const r = validateFinding(f);
    if (r.ok) valid.push(f);
    else dropped.push({ index, id: f && typeof f.id === 'string' ? f.id : null, errors: r.errors });
  });
  return { valid, dropped };
}

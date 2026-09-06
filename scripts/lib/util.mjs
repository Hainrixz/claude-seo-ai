// Shared zero-dependency helpers for claude-seo-ai scripts.
// HTML parsing runs on the zero-dependency tokenizer in lib/html.mjs (browser-like attribute
// and implied-end-tag handling), so the scripts run anywhere `node` exists, with no install
// step, and back the deterministic, reproducible checks (verification.reproduce).
//
// CLI contract (every script in scripts/*.mjs except the guard hook):
//   export async function main(args) -> { result, code }
//   if (isMain(import.meta.url)) runCli(main);
// Scripts are importable without side effects; nothing here calls process.exit.

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchText as fetchTextImpl } from './fetch.mjs';
import { decodeEntities } from './entities.mjs';
import { parseDocument, tokenize, extractPassages, parseLinkHeader, inContent, sameUrl } from './html.mjs';

/** Process exit-code taxonomy shared by every script. */
export const EXIT = Object.freeze({
  OK: 0,         // ran and produced a result
  USAGE: 1,      // bad invocation: missing/invalid arguments, unreadable input path
  RUNTIME: 2,    // ran but failed: network error, unexpected exception
  THRESHOLD: 3,  // ran fine, but a gate/threshold was not met (audit --fail-under, check failures)
});

/**
 * Read a credential by key name, from the environment only.
 *
 * Precedence: `CLAUDE_PLUGIN_OPTION_<KEY>` (what a plugin `userConfig` prompt exports) then `<KEY>`.
 * Secrets are NEVER accepted from argv: a value on the command line lands in `ps`, in the shell
 * history and in every command log the run touches, and this repo's scripts print the command they
 * would re-run. A caller that wants an override sets the variable for the one invocation
 * (`PSI_API_KEY=… node scripts/audit.mjs …`).
 *
 * @param {string} name  key name, e.g. 'PSI_API_KEY'
 * @param {object} [env] defaults to process.env
 * @returns {string|null} the trimmed value, or null when unset/blank
 */
export function credential(name, env = process.env) {
  for (const key of ['CLAUDE_PLUGIN_OPTION_' + name, name]) {
    const v = env ? env[key] : undefined;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Minimal arg parser. Supports `--flag value`, `--flag` (boolean true),
 * `--flag=value`, `--no-flag` (-> flag: false), repeated flags (-> array),
 * and `--` (everything after is positional). Positionals land in `_`.
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  const set = (key, value) => {
    if (Object.prototype.hasOwnProperty.call(out, key) && key !== '_') {
      out[key] = Array.isArray(out[key]) ? [...out[key], value] : [out[key], value];
    } else {
      out[key] = value;
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') && a.length > 2) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) { set(body.slice(0, eq), body.slice(eq + 1)); continue; }
      if (body.startsWith('no-') && body.length > 3) { set(body.slice(3), false); continue; }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { set(body, true); }
      else { set(body, next); i++; }
    } else { out._.push(a); }
  }
  return out;
}

/** Print a JSON result to stdout, set the process exit code, and return the object (never exits). */
export function emit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exitCode = Number.isInteger(code) ? code : EXIT.RUNTIME;
  return obj;
}

/** True when the module at `metaUrl` is the entry script of this process (symlink-safe). */
export function isMain(metaUrl) {
  try {
    const entry = process.argv[1];
    if (!entry || !metaUrl) return false;
    const a = realpathSync(entry);
    const b = realpathSync(fileURLToPath(metaUrl));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch { return false; }
}

/**
 * Run a script's `main(args)` as a CLI: parses argv, emits `result` with exit code `code`.
 * A thrown error becomes `{ error }` with EXIT.RUNTIME. Never calls process.exit.
 */
export async function runCli(main, argv) {
  let out;
  try {
    out = await main(parseArgs(argv));
  } catch (e) {
    const err = { error: String(e && e.message || e) };
    if (process.env.CLAUDE_SEO_AI_DEBUG && e && e.stack) err.stack = e.stack;
    return emit(err, EXIT.RUNTIME);
  }
  if (out && typeof out === 'object' && Object.prototype.hasOwnProperty.call(out, 'result')) {
    return emit(out.result, Number.isInteger(out.code) ? out.code : EXIT.OK);
  }
  return emit(out === undefined ? {} : out, EXIT.OK);
}

/**
 * Fetch text with redirects followed. Delegates to lib/fetch.mjs (recorded redirect chain, byte cap,
 * gzip + charset handling, one retry on network error / 5xx). Legacy shape:
 * { ok, status, text, headers, finalUrl, error } plus `chain` (the status_chain).
 */
export async function fetchText(url, opts = {}) { return fetchTextImpl(url, opts); }

/**
 * Read a persisted PageSnapshot (pages/<slug>.json written by scripts/snapshot.mjs).
 * Returns { snapshot, path, run_dir, error }. `run_dir` is the directory holding pages/ and site/.
 */
export function readSnapshot(pathOrArgs) {
  const p = pathOrArgs && typeof pathOrArgs === 'object' ? pathOrArgs.snapshot : pathOrArgs;
  if (typeof p !== 'string' || !p.trim()) return { snapshot: null, path: null, run_dir: null, error: 'provide --snapshot <pages/<slug>.json>' };
  const abs = resolve(p.trim());
  let snap;
  try { snap = JSON.parse(readFileSync(abs, 'utf8')); }
  catch (e) { return { snapshot: null, path: abs, run_dir: null, error: 'cannot read snapshot ' + abs + ': ' + String(e && e.message || e) }; }
  if (!snap || typeof snap !== 'object' || !Number.isInteger(snap.snapshot_version)) return { snapshot: null, path: abs, run_dir: null, error: 'not a PageSnapshot (missing snapshot_version): ' + abs };
  const run_dir = /[\\/]pages$/i.test(dirname(abs)) ? resolve(dirname(abs), '..') : dirname(abs);
  return { snapshot: snap, path: abs, run_dir, error: null };
}

/**
 * Load HTML from --snapshot, --file or --url (in that precedence).
 * Returns { source: 'snapshot'|'file'|'url'|'none', html, headers, status, finalUrl?, snapshot?, error }.
 *   --snapshot <pages/<slug>.json> [--prefer raw|rendered]  real status/headers/html from a persisted snapshot; the
 *       `snapshot` field is { path, run_dir, slug, prefer, used: 'raw'|'rendered', rendered_available, render_used, note }.
 *   --file  reports `status: null` and empty headers: a local file has no HTTP response, and pretending it
 *       returned 200 would be a fabricated value.
 */
export async function loadInput(args) {
  if (args.snapshot !== undefined) {
    const base = { source: 'snapshot', html: '', headers: {}, status: null, finalUrl: null, snapshot: null, error: null };
    const prefer = args.prefer === undefined || args.prefer === true ? 'raw' : String(args.prefer).toLowerCase();
    if (prefer !== 'raw' && prefer !== 'rendered') return { ...base, error: '--prefer must be raw or rendered' };
    const rs = readSnapshot(args);
    if (rs.error) return { ...base, error: rs.error };
    const snap = rs.snapshot;
    const wantRendered = prefer === 'rendered';
    const hasRendered = !!(snap.rendered_html_path || (snap.html_inline && snap.html_inline.rendered));
    const used = wantRendered && hasRendered ? 'rendered' : 'raw';
    const rel = used === 'rendered' ? snap.rendered_html_path : snap.raw_html_path;
    let html = null;
    if (rel) {
      try { html = readFileSync(resolve(rs.run_dir, rel), 'utf8'); }
      catch (e) { return { ...base, error: 'snapshot HTML missing: ' + rel + ' (' + String(e && e.message || e) + ')' }; }
    } else if (snap.html_inline && typeof snap.html_inline[used] === 'string') html = snap.html_inline[used];
    else return { ...base, error: 'snapshot has no ' + used + ' HTML (raw_html_path is null and nothing is inlined)' };
    const info = {
      path: rs.path, run_dir: rs.run_dir, slug: snap.target && snap.target.slug ? snap.target.slug : null, prefer, used,
      rendered_available: hasRendered, render_used: snap.render && snap.render.used ? snap.render.used : 'none',
      note: wantRendered && used === 'raw' ? 'rendered DOM not available in this snapshot; using the raw HTML' : null,
    };
    return { source: 'snapshot', html, headers: snap.headers && typeof snap.headers === 'object' ? snap.headers : {}, status: snap.status === undefined ? null : snap.status,
      finalUrl: snap.target && snap.target.final_url ? snap.target.final_url : null, snapshot: info, error: null };
  }
  if (args.file) {
    try { return { source: 'file', html: readFileSync(args.file, 'utf8'), headers: {}, status: null, error: null }; }
    catch (e) { return { source: 'file', html: '', headers: {}, status: null, error: String(e && e.message || e) }; }
  }
  if (args.url) {
    const r = await fetchText(args.url);
    return { source: 'url', html: r.text, headers: r.headers, status: r.status, finalUrl: r.finalUrl, error: r.error };
  }
  return { source: 'none', html: '', headers: {}, status: 0, error: 'provide --url <u> or --file <path>' };
}

/**
 * Map a failed loadInput() to a CLI result: missing args / unreadable file are USAGE,
 * a failed fetch is RUNTIME. Returns null when the input is usable.
 */
export function inputFailure(input) {
  if (!input || !(input.error && !input.html)) return null;
  const code = input.source === 'url' ? EXIT.RUNTIME : EXIT.USAGE;
  return { result: { error: input.error }, code };
}

// ---------------------------------------------------------------------------
// HTML getters: a compat facade over lib/html.mjs parseDocument(). Signatures and results on
// well-formed markup are unchanged; they now also handle unquoted and single-quoted attributes,
// apostrophes inside values, tags spanning lines, raw-text decoys (script/style/template/
// noscript/svg content is never mistaken for headings, links or images) and the full entity table.
// A one-entry cache avoids re-tokenizing when a script calls several getters on the same HTML.

let _lastHtml = null;
let _lastDoc = null;
function docFor(html) {
  const s = typeof html === 'string' ? html : String(html ?? '');
  if (s !== _lastHtml) { _lastDoc = parseDocument(s); _lastHtml = s; }
  return _lastDoc;
}

export { decodeEntities, parseDocument, tokenize, extractPassages, parseLinkHeader, inContent, sameUrl };

/** Remove tags and collapse whitespace. Contents of raw-text elements (script/style/…) are dropped as well. */
export function stripTags(s) {
  const str = typeof s === 'string' ? s : String(s ?? '');
  if (str.indexOf('<') === -1) return str.replace(/\s+/g, ' ').trim();
  let out = '';
  for (const t of tokenize(str)) if (t.kind === 'text') out += t.text;
  return out.replace(/\s+/g, ' ').trim();
}

/** Extract the first <title> (decoded, whitespace-collapsed) or null. */
export function getTitle(html) { return docFor(html).title.value; }

/** Content of the first <meta name="..."> that carries a content attribute (case-insensitive name). */
export function getMetaName(html, name) {
  const n = String(name).trim().toLowerCase();
  const m = docFor(html).metas.find((x) => x.name === n && x.content !== null);
  return m ? m.content : null;
}

/** Content of the first <meta property="..."> (Open Graph and friends). */
export function getMetaProperty(html, prop) {
  const p = String(prop).trim().toLowerCase();
  const m = docFor(html).metas.find((x) => x.property === p && x.content !== null);
  return m ? m.content : null;
}

/** href of the first <link> whose rel list contains `rel` (raw attribute value, not resolved). */
export function getLinkRel(html, rel) {
  const r = String(rel).trim().toLowerCase();
  const l = docFor(html).links_rel.find((x) => x.rel.includes(r) && x.href !== null);
  return l ? l.href : null;
}

/** <html lang> (falls back to xml:lang) or null. */
export function getHtmlLang(html) { return docFor(html).lang; }

/** Declared charset from <meta charset> or <meta http-equiv="content-type">, or null. */
export function getCharset(html) { return docFor(html).charset.value; }

/** Headings h1-h6 as [{level, text, region}] in document order (aria role=heading pseudo-headings excluded). */
export function getHeadings(html) {
  return docFor(html).headings.filter((h) => !h.aria).map((h) => ({ level: h.level, text: h.text, region: h.region }));
}

const pxDigits = (v) => (v == null ? null : (/^\s*(\d+)(?:\.\d+)?\s*(?:px)?\s*$/i.exec(String(v)) || [])[1] || null);

/**
 * <img> tags as [{src, altPresent, alt, width, height}]. width/height are the numeric pixel value
 * as a string, or null when absent or not a pixel number ("100%", "auto") — those are unsized.
 * src is the src attribute only; a lazy placeholder is never replaced by data-src here.
 */
export function getImages(html) {
  return docFor(html).images.map((i) => ({ src: i.src, altPresent: i.alt_present, alt: i.alt, width: pxDigits(i.width), height: pxDigits(i.height) }));
}

/** <a href> anchors as [{href, anchor, …}] (see parseDocument().anchors for the extra fields). */
export function getLinks(html) { return docFor(html).anchors; }

/** JSON-LD blocks as [{ok, type, data, error, raw}]; the MIME match ignores parameters, case and whitespace. */
export function getJsonLd(html) { return docFor(html).jsonld; }

/** Valid-ish BCP-47 language[-REGION] check (lenient, covers common cases + x-default). */
export function isBcp47(code) {
  if (!code) return false;
  if (code.toLowerCase() === 'x-default') return true;
  return /^[a-z]{2,3}(-[A-Za-z]{2,4})?(-[A-Za-z0-9]{2,8})?$/.test(code);
}

// Render decision + optional headless rendering for claude-seo-ai (zero dependencies).
//
// The static HTML is always the primary evidence. `needsRender()` says whether a JS render pass would
// add confidence; `findChrome()` looks for an already-installed Chrome/Chromium/Edge/Brave (nothing is
// ever installed); `renderWithChrome()` dumps the DOM through `--dump-dom`; `renderWithPlaywright()`
// only runs when the `playwright` package is already resolvable; `renderDelta()` counts what the rendered
// DOM adds over the static one. A missing renderer is reported (confidence 'reduced' + hint), never thrown.
//
// Chrome quirk handled here: with `--virtual-time-budget` some Chrome builds write the complete DOM and
// then never exit. renderWithChrome() therefore watches stdout: once a document that ends in </html> has
// arrived and the stream has been quiet for a moment, the dump is accepted and the process is killed.

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RENDER_WORD_THRESHOLD = 150;          // below this the static HTML is too thin to judge
export const FRAMEWORK_WORD_THRESHOLD = 400;       // hydration markers + thin content ⇒ render
export const HYDRATION_MARKERS = Object.freeze(['next_data', 'nuxt', 'reactroot', 'angular', 'sveltekit', 'remix']);
export const CHROME_PATH_NAMES = Object.freeze(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome', 'msedge', 'brave-browser']);
export const PLAYWRIGHT_HINT = 'Install with: npm i -D playwright && npx playwright install chromium (~150 MB). Or pass --rendered-file.';
export const CHROME_HINT = 'No Chrome/Chromium/Edge/Brave found. Install one, set CLAUDE_SEO_AI_CHROME=<path to the browser binary>, or pass --rendered-file <dom.html>.';
export const DUMP_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Decide whether the static HTML looks JS-dependent.
 * Signals: low_word_count (<150 words in content regions), next_root_empty / app_root_empty (an empty
 * framework mount point), hydration_markers (a JS framework marker with < 400 words), no_h1_few_anchors
 * (no <h1> and fewer than 3 links), noscript_js_notice (a "enable JavaScript" notice).
 * @returns {{needed:boolean, signals:string[], markers:string[], word_count:number}}
 */
export function needsRender(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  const m = p.markers && typeof p.markers === 'object' ? p.markers : {};
  const words = Number.isFinite(p.word_count) ? p.word_count : 0;
  const anchors = Array.isArray(p.anchors) ? p.anchors.length : 0;
  const hasH1 = Array.isArray(p.headings) && p.headings.some((h) => h && h.level === 1 && !h.aria);
  const markers = HYDRATION_MARKERS.filter((k) => m[k] === true);
  const signals = [];
  if (words < RENDER_WORD_THRESHOLD) signals.push('low_word_count');
  if (m.next_root_empty === true) signals.push('next_root_empty');
  if (m.app_root_empty === true) signals.push('app_root_empty');
  if (markers.length && words < FRAMEWORK_WORD_THRESHOLD) signals.push('hydration_markers');
  if (!hasH1 && anchors < 3) signals.push('no_h1_few_anchors');
  if (m.noscript_js_notice === true) signals.push('noscript_js_notice');
  return { needed: signals.length > 0, signals, markers, word_count: words };
}

// ---------------------------------------------------------------------------
// Locating a browser

function isExecutableFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

function whichSync(name, platform) {
  try {
    const out = execFileSync(platform === 'win32' ? 'where.exe' : 'which', [name], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 3000 });
    const first = String(out).split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return first || null;
  } catch { return null; }
}

function defaultPaths(platform, env) {
  const home = env.HOME || homedir();
  if (platform === 'darwin') {
    const apps = ['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser'];
    const out = [];
    for (const base of ['/Applications', join(home, 'Applications')]) for (const a of apps) out.push(join(base, a + '.app', 'Contents', 'MacOS', a));
    return out;
  }
  if (platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return [
      join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), join(local, 'Chromium', 'Application', 'chrome.exe'),
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium'];
}

function listDirs(p) { try { return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } }

/** Browser binaries inside Playwright's download cache (full browsers first, headless shells last). */
export function playwrightCachePaths({ platform = process.platform, env = process.env } = {}) {
  const home = env.HOME || homedir();
  const bases = [];
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0') bases.push(env.PLAYWRIGHT_BROWSERS_PATH);
  if (platform === 'darwin') bases.push(join(home, 'Library', 'Caches', 'ms-playwright'));
  else if (platform === 'win32') bases.push(join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'ms-playwright'));
  else bases.push(join(home, '.cache', 'ms-playwright'));
  const full = [], shell = [];
  const version = (n) => Number((n.match(/-(\d+)$/) || [])[1] || 0);
  for (const base of bases) {
    const dirs = listDirs(base).sort((a, b) => version(b) - version(a));
    for (const d of dirs) {
      const root = join(base, d);
      if (/^chromium-\d+$/.test(d)) {
        for (const sub of listDirs(root)) {
          const s = join(root, sub);
          if (platform === 'darwin') full.push(join(s, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'), join(s, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
          else if (platform === 'win32') full.push(join(s, 'chrome.exe'));
          else full.push(join(s, 'chrome'));
        }
      } else if (/^chromium_headless_shell-\d+$/.test(d)) {
        for (const sub of listDirs(root)) shell.push(join(root, sub, platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell'));
      }
    }
  }
  return [...full, ...shell];
}

/**
 * Find an installed Chromium-based browser. Order: $CLAUDE_SEO_AI_CHROME → $CHROME_PATH →
 * $PUPPETEER_EXECUTABLE_PATH → PATH lookup → OS default app paths → Playwright caches.
 * @returns {{path:string, source:string}|null}
 */
export function findChrome({ env = process.env, platform = process.platform } = {}) {
  for (const v of ['CLAUDE_SEO_AI_CHROME', 'CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH']) {
    const p = typeof env[v] === 'string' ? env[v].trim() : '';
    if (p && isExecutableFile(p)) return { path: p, source: 'env:' + v };
  }
  for (const name of CHROME_PATH_NAMES) {
    const p = whichSync(name, platform);
    if (p && isExecutableFile(p)) return { path: p, source: 'path:' + name };
  }
  for (const p of defaultPaths(platform, env)) if (isExecutableFile(p)) return { path: p, source: 'app' };
  for (const p of playwrightCachePaths({ platform, env })) if (isExecutableFile(p)) return { path: p, source: 'playwright-cache' };
  return null;
}

// ---------------------------------------------------------------------------
// Headless Chrome

const DOC_END = /<\/html>\s*$/i;

/**
 * Dump the rendered DOM of `url` with headless Chrome. Never throws.
 * @param {string} bin  browser binary (see findChrome)
 * @param {string} url  http(s) or file:// URL
 * @param {object} [opts]
 * @param {string} [opts.ua]                    --user-agent value
 * @param {string} [opts.lang]                  --accept-lang value
 * @param {number} [opts.timeoutMs=45000]       hard kill timeout for the whole run
 * @param {number} [opts.virtualTimeBudgetMs=8000]
 * @param {number} [opts.pageTimeoutMs=20000]   Chrome's own --timeout (page load)
 * @param {number} [opts.quietMs=400]           accept a complete dump after this much stdout silence
 * @param {boolean} [opts.noSandbox]            add --no-sandbox (default: only when CLAUDE_SEO_AI_CHROME_NO_SANDBOX=1)
 * @returns {Promise<{ok:boolean, html:string, bytes:number, ms:number, bin:string, exit:string|null, error:string|null, stderr_tail:string}>}
 */
export function renderWithChrome(bin, url, opts = {}) {
  const {
    ua = null, lang = null, timeoutMs = 45000, virtualTimeBudgetMs = 8000, pageTimeoutMs = 20000, quietMs = 400,
    noSandbox = process.env.CLAUDE_SEO_AI_CHROME_NO_SANDBOX === '1', env = process.env,
  } = opts;
  return new Promise((done) => {
    const t0 = Date.now();
    let profile = null;
    try { profile = mkdtempSync(join(tmpdir(), 'claude-seo-ai-chrome-')); }
    catch (e) { return done({ ok: false, html: '', bytes: 0, ms: 0, bin, exit: null, error: 'cannot create a temporary profile: ' + (e && e.message || e), stderr_tail: '' }); }
    const args = [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
      '--user-data-dir=' + profile,
    ];
    if (ua) args.push('--user-agent=' + ua);
    if (lang) args.push('--accept-lang=' + lang);
    if (noSandbox) args.push('--no-sandbox');
    args.push('--virtual-time-budget=' + virtualTimeBudgetMs, '--timeout=' + pageTimeoutMs, '--dump-dom', url);

    const chunks = [];
    let bytes = 0, settled = false, closed = false, exitKind = null, stderrTail = '';
    let quietTimer = null, hardTimer = null, child = null;
    const cleanup = () => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* Windows may hold the profile briefly */ } };
    const kill = () => { try { if (child && !closed) child.kill('SIGKILL'); } catch { /* already gone */ } };
    const finish = ({ exit, error = null, fatal = false }) => {
      if (settled) return;
      settled = true;
      clearTimeout(quietTimer); clearTimeout(hardTimer);
      const html = Buffer.concat(chunks).toString('utf8');
      const complete = DOC_END.test(html);
      const ok = !fatal && complete && html.trim().length > 0;
      let err = error;
      if (!ok && !err) err = html.trim() ? 'incomplete DOM dump' : 'empty DOM dump';
      if (closed) cleanup(); else if (child) child.once('close', cleanup);
      done({ ok, html: ok ? html : '', bytes, ms: Date.now() - t0, bin, exit, error: err, stderr_tail: stderrTail.trim().split('\n').slice(-3).join('\n') });
    };
    try { child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env }); }
    catch (e) { cleanup(); return finish({ exit: 'spawn-error', error: 'spawn failed: ' + (e && e.message || e), fatal: true }); }
    child.on('error', (e) => { closed = true; finish({ exit: 'spawn-error', error: 'spawn failed: ' + (e && e.message || e), fatal: true }); });
    child.stdout.on('data', (d) => {
      if (bytes + d.length > DUMP_MAX_BYTES) { exitKind = 'killed-overflow'; kill(); return finish({ exit: exitKind, error: 'DOM dump exceeded ' + DUMP_MAX_BYTES + ' bytes', fatal: true }); }
      chunks.push(d); bytes += d.length;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        if (DOC_END.test(Buffer.concat(chunks).toString('utf8'))) { exitKind = 'killed-after-dump'; kill(); finish({ exit: exitKind }); }
      }, quietMs);
    });
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-4000); });
    child.on('close', (code, signal) => {
      closed = true;
      if (settled) { cleanup(); return; }
      const exit = exitKind || (signal ? 'signal:' + signal : 'code:' + code);
      const error = !exitKind && code !== 0 && !bytes ? 'chrome exited with code ' + code : null;
      finish({ exit, error });
    });
    hardTimer = setTimeout(() => {
      exitKind = 'killed-timeout'; kill();
      const complete = DOC_END.test(Buffer.concat(chunks).toString('utf8'));
      finish({ exit: exitKind, error: complete ? null : 'render timeout after ' + timeoutMs + 'ms' });
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Playwright (only when already installed — never installs)

/** Whether `playwright` resolves from `cwd` or $CLAUDE_PLUGIN_DATA/node_modules. */
export function playwrightAvailable({ cwd = process.cwd(), env = process.env } = {}) {
  const bases = [cwd];
  if (env.CLAUDE_PLUGIN_DATA) bases.push(env.CLAUDE_PLUGIN_DATA);
  for (const base of bases) {
    try {
      const req = createRequire(join(base, '__claude_seo_ai_resolve__.cjs'));
      const path = req.resolve('playwright');
      return { available: true, path, base };
    } catch { /* try next base */ }
  }
  return { available: false, path: null, base: null, hint: PLAYWRIGHT_HINT };
}

/**
 * Render with Playwright's bundled Chromium when the package is already installed. Never throws.
 * @returns {Promise<{available:boolean, ok:boolean, html:string, ms:number, error:string|null, hint?:string, path?:string}>}
 */
export async function renderWithPlaywright(url, opts = {}) {
  const { ua = null, lang = null, timeoutMs = 30000 } = opts;
  const avail = playwrightAvailable(opts);
  if (!avail.available) return { available: false, ok: false, html: '', ms: 0, error: 'playwright is not installed', hint: PLAYWRIGHT_HINT };
  const t0 = Date.now();
  let browser = null;
  try {
    const mod = await import(pathToFileURL(avail.path).href);
    const pw = mod.default && mod.default.chromium ? mod.default : mod;
    browser = await pw.chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: ua || undefined, locale: lang ? lang.split(',')[0] : undefined });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
    const html = await page.content();
    await browser.close(); browser = null;
    return { available: true, ok: true, html, ms: Date.now() - t0, error: null, path: avail.path };
  } catch (e) {
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
    return { available: true, ok: false, html: '', ms: Date.now() - t0, error: String(e && e.message || e), path: avail.path };
  }
}

// ---------------------------------------------------------------------------
// Delta

function firstCanonical(doc) {
  const c = doc && Array.isArray(doc.canonicals) && doc.canonicals[0];
  return c ? (c.abs || c.href || null) : null;
}

/**
 * What the rendered DOM adds over the static HTML (counts of items present only in the rendered parse).
 * @returns {{headings:number, h1_added:boolean, anchors:number, images:number, jsonld_blocks:number, words:number, title_changed:boolean, canonical_changed:boolean, meaningful:boolean}}
 */
export function renderDelta(parsedRaw, parsedRendered) {
  const R = parsedRaw || {}, D = parsedRendered || {};
  const onlyIn = (a, b, key) => {
    const seen = new Set((a || []).map(key));
    return (b || []).filter((x) => !seen.has(key(x))).length;
  };
  const hKey = (h) => h.level + '|' + String(h.text || '').trim().toLowerCase();
  const aKey = (a) => (a.abs || a.href || '') + '|' + String(a.anchor || '').trim().toLowerCase();
  const iKey = (i) => i.abs || i.src || i.data_src || '';
  const jKey = (j) => (j.raw != null ? String(j.raw) : JSON.stringify(j.data == null ? null : j.data)).replace(/\s+/g, '');
  const hasH1 = (d) => Array.isArray(d.headings) && d.headings.some((h) => h.level === 1 && !h.aria);
  const out = {
    headings: onlyIn(R.headings, D.headings, hKey),
    h1_added: hasH1(D) && !hasH1(R),
    anchors: onlyIn(R.anchors, D.anchors, aKey),
    images: onlyIn(R.images, D.images, iKey),
    jsonld_blocks: onlyIn(R.jsonld, D.jsonld, jKey),
    words: Math.max(0, (D.word_count || 0) - (R.word_count || 0)),
    title_changed: ((R.title && R.title.value) || null) !== ((D.title && D.title.value) || null),
    canonical_changed: firstCanonical(R) !== firstCanonical(D),
  };
  out.meaningful = out.headings > 0 || out.anchors > 0 || out.images > 0 || out.jsonld_blocks > 0 || out.words > 0 || out.h1_added || out.title_changed || out.canonical_changed;
  return out;
}

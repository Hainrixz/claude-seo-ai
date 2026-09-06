// Local fixture HTTP server for e2e tests. Binds 127.0.0.1 on port 0 (ephemeral), serves the
// synthetic mini site under tests/fixtures/site/ (with `{{ORIGIN}}` substituted by the live origin)
// plus a set of behavioural routes: redirect chains and loops, a robots.txt that can be forced to
// 4xx/5xx, a sitemap index with a gzipped child, discovery endpoints, error/soft-404 pages, header
// canonical/noindex, a non-reciprocal hreflang pair, a disallowed page, a >2 MB stream, a
// content-encoding: gzip body, a charset page, a slow route and a UA echo. Every request is logged
// in `hits` so tests can assert what was (never) fetched.
//
//   const srv = await startServer({ robotsStatus: 500 });
//   srv.url            // "http://127.0.0.1:PORT"
//   srv.hits           // [{ path, ua, method }]
//   await srv.close();

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, extname } from 'node:path';
import { gzipSync } from 'node:zlib';

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'site');
const TYPES = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function fixture(rel, origin) {
  return readFileSync(join(SITE, rel), 'utf8').replace(/\{\{ORIGIN\}\}/g, origin);
}

function staticPath(pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  let abs = resolve(SITE, '.' + rel);
  if (!abs.startsWith(SITE)) return null;
  if (!extname(abs)) abs += '.html';
  if (existsSync(abs) && statSync(abs).isFile()) return abs;
  return null;
}

/**
 * @param {{robotsStatus?:number, robotsBody?:string}} [opts]  robotsStatus forces /robots.txt to that status (e.g. 404, 500)
 */
export function startServer(opts = {}) {
  const hits = [];
  const server = createServer((req, res) => {
    const origin = 'http://127.0.0.1:' + server.address().port;
    const u = new URL(req.url, origin);
    const p = u.pathname;
    hits.push({ path: p + u.search, ua: req.headers['user-agent'] || null, method: req.method });
    const send = (status, body, headers = {}) => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : String(body), 'utf8');
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': buf.length, ...headers });
      res.end(buf);
    };
    const redirect = (status, to) => send(status, '', { location: to, 'content-type': 'text/plain' });

    try {
      // robots.txt (forced status via server option or ?mode=NNN)
      if (p === '/robots.txt') {
        const forced = Number(u.searchParams.get('mode')) || opts.robotsStatus || 200;
        if (forced >= 500) return send(forced, 'Server Error', { 'content-type': 'text/plain' });
        if (forced >= 400) return send(forced, 'Not Found', { 'content-type': 'text/plain' });
        if (forced >= 300) return redirect(forced, '/robots-moved.txt');
        return send(200, opts.robotsBody != null ? opts.robotsBody : fixture('robots.txt', origin), { 'content-type': 'text/plain; charset=utf-8' });
      }
      // redirect chains and loops
      if (p === '/old') return redirect(301, '/older');
      if (p === '/older') return redirect(302, '/blog/a');
      if (p === '/loop1') return redirect(302, '/loop2');
      if (p === '/loop2') return redirect(302, '/loop1');
      if (p === '/dir') return redirect(301, '/dir/');
      if (p === '/dir/') return send(200, '<html><title>dir</title></html>');
      const hop = /^\/hop\/(\d+)$/.exec(p);
      if (hop) { const n = Number(hop[1]); return n > 0 ? redirect(302, '/hop/' + (n - 1)) : send(200, '<html><title>hop end</title></html>'); }
      // sitemaps
      if (p === '/sitemap.xml') return send(200, fixture('sitemap.xml', origin), { 'content-type': 'application/xml; charset=utf-8' });
      if (p === '/sitemap-posts.xml') return send(200, fixture('sitemap-posts.xml', origin), { 'content-type': 'application/xml; charset=utf-8' });
      if (p === '/sitemap-pages.xml.gz') return send(200, gzipSync(Buffer.from(fixture('sitemap-pages.xml', origin))), { 'content-type': 'application/gzip' });
      if (p === '/sitemap_agentic_discovery.xml') return send(200, fixture('sitemap_agentic_discovery.xml', origin), { 'content-type': 'application/xml; charset=utf-8' });
      // The WordPress shape: the legacy core path and the plugin path both redirect onto the one
      // sitemap. Three well-known paths answer 200; there is still exactly ONE sitemap source.
      if (p === '/wp-sitemap.xml') return redirect(301, '/sitemap_index.xml');
      if (p === '/sitemap_index.xml') return redirect(302, '/sitemap.xml');
      // discovery endpoints
      if (p === '/.well-known/ucp') return send(200, fixture('well-known-ucp.json', origin), { 'content-type': 'application/json; charset=utf-8' });
      // error / soft-404 / header-controlled pages
      if (p === '/boom') return send(500, '<html><title>boom</title><body>Internal Server Error</body></html>');
      if (p === '/soft404') return send(200, '<html><head><title>Page not found</title></head><body><h1>Page not found</h1><p>Sorry, nothing here.</p></body></html>');
      if (p === '/noindex') {
        return send(200, '<html><head><title>Header controlled</title></head><body><p>noindex via header</p></body></html>', {
          'x-robots-tag': 'noindex, nofollow', link: '<' + origin + '/canonical-target>; rel="canonical", <' + origin + '/es/header-alt>; rel="alternate"; hreflang="es"',
        });
      }
      // a page whose only outlink is a non-HTML sibling: the crawler must not sample the markdown
      if (p === '/md-host') {
        return send(200, '<html lang="en"><head><title>Machine-readable notes for the fixture site</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>'
          + '<body><main><h1>Notes</h1><p>The machine-readable copy lives in <a href="/notes.md">notes.md</a>.</p></main></body></html>');
      }
      if (p === '/notes.md') return send(200, '# Notes\n\nPlain markdown for agents, not a web page.\n', { 'content-type': 'text/markdown; charset=utf-8' });
      if (p === '/cookies') {
        res.setHeader('set-cookie', ['session=abc123; Path=/; HttpOnly', 'theme=dark; Path=/']);
        return send(200, '<html><title>cookies</title></html>');
      }
      if (p === '/echo-ua') {
        return send(200, JSON.stringify({ ua: req.headers['user-agent'] || null, accept: req.headers.accept || null, 'accept-language': req.headers['accept-language'] || null }), { 'content-type': 'application/json' });
      }
      if (p === '/latin1') {
        return send(200, Buffer.from([0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]), { 'content-type': 'text/html; charset=iso-8859-1' }); // <p>café</p>
      }
      if (p === '/meta-charset') {
        const body = Buffer.concat([Buffer.from('<html><head><meta charset="windows-1252"><title>q</title></head><body><p>'), Buffer.from([0x93, 0x68, 0x69, 0x94]), Buffer.from('</p></body></html>')]);
        return send(200, body, { 'content-type': 'text/html' });
      }
      if (p === '/gz-body') {
        return send(200, gzipSync(Buffer.from('<html><head><title>gz body</title></head><body><p>GZ-BODY-MARKER</p></body></html>')), { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
      }
      if (p === '/big') {
        const total = 2_500_000, chunk = Buffer.alloc(65536, 'x');
        let sent = 0;
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': total });
        const pump = () => {
          while (sent < total) {
            const piece = Math.min(chunk.length, total - sent);
            sent += piece;
            if (!res.write(piece === chunk.length ? chunk : chunk.subarray(0, piece))) { res.once('drain', pump); return; }
          }
          res.end();
        };
        res.on('error', () => { /* client hung up after the byte cap */ });
        return pump();
      }
      if (p === '/slow') {
        const ms = Number(u.searchParams.get('ms')) || 1000;
        const t = setTimeout(() => send(200, '<html><title>slow</title></html>'), ms);
        req.on('close', () => clearTimeout(t));
        return;
      }
      // static mini site
      const file = staticPath(p);
      if (file) {
        const ext = extname(file);
        const body = TYPES[ext] && ext !== '.json' ? fixture(file.slice(SITE.length + 1), origin) : readFileSync(file);
        return send(200, body, { 'content-type': TYPES[ext] || 'application/octet-stream' });
      }
      return send(404, '<html><head><title>404</title></head><body><h1>Not Found</h1></body></html>');
    } catch (e) {
      return send(500, 'fixture server error: ' + (e && e.message || e), { 'content-type': 'text/plain' });
    }
  });
  server.keepAliveTimeout = 500;

  return new Promise((resolveStart, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const url = 'http://127.0.0.1:' + server.address().port;
      resolveStart({
        url, port: server.address().port, hits, server,
        close: () => new Promise((done) => {
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}

// Demo server: serves the demo page and the built SDK, and forwards /a2g/v1/* and /a2g/health to the local decision
// service. It drops the browser's Origin and uses the service's own Host, which the local profile requires, so it first
// applies the same checks for its own origin: a loopback Host (no DNS rebinding) and no foreign Origin (no other site).
// Run from the SDK folder: npm run build && npm run demo
import { createServer, request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.env.DEMO_PORT ?? 5180);
const SERVICE = new URL(process.env.A2G_URL ?? 'http://127.0.0.1:8787');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const ALLOWED = ['demo/', 'dist/'];

const OWN = new Set(['127.0.0.1', 'localhost', '[::1]'].map((name) => `${name}:${PORT}`));
const forbidden = (res) => res.writeHead(403, { 'Content-Type': 'application/json' }).end('{"error":"Forbidden"}');

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!OWN.has(req.headers.host ?? '')) return forbidden(res);
  if (url.pathname.startsWith('/a2g/')) {
    const origin = req.headers.origin;
    if (origin !== undefined && !OWN.has(origin.replace(/^http:\/\//, ''))) return forbidden(res);
    if (!/^\/a2g\/(v1\/[a-z]+|health)$/.test(url.pathname)) return forbidden(res);  // never the console routes
    const headers = { ...req.headers, host: SERVICE.host };
    delete headers.origin;
    const upstream = request({ host: SERVICE.hostname, port: SERVICE.port, method: req.method, path: url.pathname.slice(4) + url.search, headers }, (reply) => {
      res.writeHead(reply.statusCode, reply.headers);
      reply.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":"Decision service unreachable"}'); });
    req.pipe(upstream);
    return;
  }
  const path = normalize(url.pathname === '/' ? 'demo/index.html' : url.pathname.slice(1));
  if (!ALLOWED.some((prefix) => path.startsWith(prefix))) { res.writeHead(404).end(); return; }
  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(PORT, '127.0.0.1', () => console.log(`A2G JS demo at http://127.0.0.1:${PORT}/ (service ${SERVICE.origin})`));

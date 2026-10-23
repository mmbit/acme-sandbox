// The local harness: a tiny fake shop on one port that plays an app for the care service's widget.
// It serves a page with the widget's script tag, answers the app's order endpoint (/api/care/*) for
// one invented customer, and stands in for Caddy: /__care/* goes to the care server (started here as a child process)
// with X-Care-App set, streams included.
//   node platform/care/demo/shop.mjs            then open the URL it prints (PORT=8090 by default)
// It runs the company's plug-in (CARE_COMPANY_DIR, as the server does: company.ts), and takes its app, customer, orders
// and pages from the plug-in's demo/ folder where it has them (demo.mjs, shop.html, order.html: this folder's say
// what each is), else from this folder. Uses the fake model unless CARE_ANTHROPIC_API_KEY is in the environment.
// Everything here is invented (no real customer's data).
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { DIR } from '../src/company.ts';
import * as engineDemo from './demo.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SERVER = resolve(process.env.CARE_SERVER ?? resolve(HERE, '../src/server.ts')); // CARE_SERVER: try another build of it
const OWN = join(DIR, 'demo');
// the plug-in's demo.mjs over this folder's, export by export
export const demo = { ...engineDemo, ...(existsSync(join(OWN, 'demo.mjs')) ? await import(pathToFileURL(join(OWN, 'demo.mjs')).href) : {}) };
const page = (file) => (existsSync(join(OWN, file)) ? join(OWN, file) : join(HERE, file));
const TYPES = { '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const APP = 'demo';
const plugin = existsSync(join(DIR, 'public', 'plugin.js')) ? await import(pathToFileURL(join(DIR, 'public', 'plugin.js')).href) : {};
const opener = plugin.names?.opener ?? 'care'; // the page's Help links: [data-<opener>] (widget.js)

// ---- the order endpoint, as each app adds it (platform/care/README.md, "The order endpoint each app adds")
const same = (a, b) => { const h = (s) => createHash('sha256').update(String(s)).digest(); return timingSafeEqual(h(a), h(b)); };
function careEndpoint(path, body) {
  const all = demo.orders();
  const email = String(body.email ?? '').trim().toLowerCase();
  if (path === 'match') {
    const order = all.find((o) => o.id === String(body.order ?? '').trim().toUpperCase());
    return order && email === demo.customer.email ? { match: true, order } : { match: false };
  }
  if (path === 'orders') return { orders: email === demo.customer.email ? all : [] };
  // an endpoint of the plug-in's own tools, if it plays one
  return demo.endpoint?.(path, body, { orders: all, email }) ?? null;
  return null;
}

const readBody = (req) => new Promise((ok) => { let s = ''; req.setEncoding('utf8'); req.on('data', (c) => { if (s.length < 65_536) s += c; }); req.on('end', () => ok(s)); });
const freePort = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const reachable = (port) => new Promise((ok) => { const c = connect(port, '127.0.0.1', () => { c.end(); ok(true); }); c.on('error', () => ok(false)); });

// Starts the care server and the shop; resolves when both listen. close() stops both and removes the throwaway data.
export async function start({ port = 0, quiet = false } = {}) {
  const token = randomBytes(24).toString('base64url'); // this run's CARE_TOKEN (never written anywhere)
  const carePort = await freePort();
  const dataDir = await mkdtemp(join(tmpdir(), 'care-demo-'));

  const shop = createServer(async (req, res) => {
    let path;
    try { path = new URL(req.url ?? '/', 'http://x').pathname; } catch { res.writeHead(400); return res.end(); }

    // Caddy's part: /__care/* to the care service, X-Care-App set by us (any copy the browser sent is dropped)
    if (path.startsWith('/__care/')) {
      const headers = { ...req.headers };
      for (const k of Object.keys(headers)) if (k.toLowerCase() === 'x-care-app') delete headers[k];
      headers['x-care-app'] = APP;
      headers['x-forwarded-for'] = req.socket.remoteAddress ?? '';
      headers['x-forwarded-proto'] = 'http';
      const up = request({ host: '127.0.0.1', port: carePort, method: req.method, path: req.url, headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        res.flushHeaders(); // an event stream must reach the browser as it comes, not when it ends
        r.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('care server not reachable'); } else res.end(); });
      res.on('close', () => up.destroy()); // the browser left: let go of the stream upstream too
      return req.pipe(up);
    }

    // the app's order endpoint, as care calls it
    const care = /^\/api\/care\/([a-z]+)$/.exec(path);
    if (care) {
      const auth = String(req.headers.authorization ?? '');
      if (req.method !== 'POST' || !auth.startsWith('Bearer ') || !same(auth.slice(7), token)) { res.writeHead(401); return res.end(); }
      let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); return res.end(); }
      const answer = careEndpoint(care[1], body ?? {});
      if (answer == null) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(answer));
    }

    // /plain: the same page without its own Help links, so the widget adds its launcher
    if (path === '/' || path === '/help' || path === '/plain') {
      const html = await readFile(page('shop.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(path === '/plain' ? html.replaceAll(` data-${opener}`, '') : html);
    }
    // /order: a page that breaks on purpose, for the bug report (order.html); its "other origin" is this shop as localhost,
    // and the email in its error the customer's
    if (path === '/order') {
      const html = (await readFile(page('order.html'), 'utf8')).replaceAll('{{OTHER}}', `http://localhost:${shop.address().port}`).replaceAll('{{EMAIL}}', demo.customer.email);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }
    const asset = /^\/(img|fonts)\/[\w.-]+$/.test(path) ? resolve(demo.assets, '.' + path) : null;
    if (asset && TYPES[extname(asset)]) {
      try { const body = await readFile(asset); res.writeHead(200, { 'content-type': TYPES[extname(asset)] }); return res.end(body); } catch { /* a 404 below */ }
    }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
  });
  await new Promise((ok) => shop.listen(port, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${shop.address().port}`;

  const fakeFile = join(dataDir, 'fake-model.json'); // fake(): what the stand-in model does next (src/fake.ts control())
  const env = { ...process.env, PORT: String(carePort), DATA_DIR: dataDir, CARE_LOCAL: '1', CARE_FAKE_FILE: fakeFile,
    CARE_FOLLOW_MS: process.env.CARE_FOLLOW_MS ?? '15000',
    CARE_APPS: JSON.stringify({ [APP]: url }), CARE_TOKENS: JSON.stringify({ [APP]: token }),
    CARE_NAMES: JSON.stringify({ [APP]: demo.app.name }), CARE_KB: JSON.stringify({ [APP]: demo.app.kb }), CARE_THINGS: JSON.stringify({ [APP]: demo.app.thing }) };
  if (!env.CARE_ANTHROPIC_API_KEY) env.CARE_PROVIDER = 'fake'; // the real model only when its key is in the environment
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], { env, stdio: ['ignore', quiet ? 'ignore' : 'inherit', 'inherit'] });
  let exited = null, closing = false;
  child.on('exit', (code, signal) => { exited = code ?? 1; if (!closing) console.error(`shop: the care server stopped (${signal ?? `exit ${code}`})`); });
  for (let i = 0; i < 100 && exited == null && !(await reachable(carePort)); i++) await new Promise((r) => setTimeout(r, 100));
  if (exited != null || !(await reachable(carePort))) console.error('shop: the care server isn\'t listening: the page works, /__care/* answers 502');

  const close = async () => {
    closing = true; child.kill();
    const closed = new Promise((ok) => shop.close(ok));
    shop.closeAllConnections(); // open event streams would hold close() forever
    await closed;
    await rm(dataDir, { recursive: true, force: true });
  };
  // The stand-in model, from outside: fake({ fail: true }) takes it down (every call fails as overloaded), fake({ next:
  // [[{ tool, input }, { text }], …] }) scripts the next calls one list each, fake() goes back to its plain echo.
  const fake = (control = {}) => writeFile(fakeFile, JSON.stringify(control));
  return { url, close, carePort, fake, provider: env.CARE_PROVIDER ?? 'anthropic' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { url, close, provider } = await start({ port: Number(process.env.PORT ?? 8090) });
  console.log(`shop: ${url}  (care as app "${APP}", model: ${provider}; Ctrl-C to stop)`);
  const stop = () => close().finally(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

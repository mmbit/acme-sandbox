#!/usr/bin/env node
// Checks that a deck in a frame talks to HQ only, in Chromium on loopback origins: the deck on one, HQ on a second,
// a stranger on a third, each framing it and answering its hello with a stylesheet.
//   node shared/deck/hq-check.mjs [--webkit]
// HQ's look reaches the deck, and a button to a preview tells HQ the deck's path and slide, never its query. The
// stranger hears nothing and can't restyle it, and neither can HQ when the deck's server names no HQ.
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { playwright } from '../demo/core.mjs';

const dir = mkdtempSync(join(tmpdir(), 'deck-hq-'));
writeFileSync(join(dir, 'deck.json'), JSON.stringify({ title: 'HQ check', sfx: false, chapters: [{ name: 'One', slides: [
  { title: 'First' },
  { title: 'Second', button: { label: 'Try it', href: 'https://demo.preview.example.test/' } }] }] }));
execFileSync('node', [join(dirname(fileURLToPath(import.meta.url)), 'build.mjs'), join(dir, 'deck.json')]);
const deckPage = readFileSync(join(dir, 'index.html'));

const listen = (handler) => new Promise((ok) => { const s = createServer(handler).listen(0, '127.0.0.1', () => ok(s)); });
const originOf = (server) => `http://127.0.0.1:${server.address().port}`;
// The parent: frames the deck, keeps every message it gets, and answers a hello the way a stranger would try to.
const parentPage = (deckUrl) => `<!doctype html><iframe src="${deckUrl}" width="800" height="600"></iframe><script>
  window.heard = [];
  addEventListener('message', (e) => {
    heard.push(e.data);
    if (e.data?.hello) e.source.postMessage({ hq: 'hq-look', look: 'parent', css: 'body { opacity: 0.123 !important; }' }, '*');
  });
</script>`;
const parentServer = (deckUrl) => listen((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(parentPage(deckUrl)));

let hq = null;   // set before each deck server is used
const deckServer = (namesHq) => listen((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/__hq-origin' && namesHq) return res.writeHead(200, { 'content-type': 'text/plain' }).end(hq);
  if (path === '/2026-01-01/presentation/') return res.writeHead(200, { 'content-type': 'text/html' }).end(deckPage);
  res.writeHead(404).end();
});
const withHq = await deckServer(true), withoutHq = await deckServer(false);
const deckUrl = (server) => `${originOf(server)}/2026-01-01/presentation/?marker=c7f3e1#2`;
const hqServer = await parentServer(deckUrl(withHq)), strangerServer = await parentServer(deckUrl(withHq));
const hqForNothing = await parentServer(deckUrl(withoutHq));
hq = originOf(hqServer);

const { chromium, webkit } = playwright();
const browser = await (process.argv.includes('--webkit') ? webkit : chromium).launch();
const problems = [];
const expect = (what, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };

async function visit(parent) {
  const page = await browser.newPage();
  await page.route('https://demo.preview.example.test/**', (route) => route.fulfill({ body: 'the preview' }));
  await page.goto(originOf(parent));
  const deck = page.frames().find((f) => f !== page.mainFrame());
  await deck.waitForSelector('.slide.on a.btn');
  await page.waitForTimeout(500);   // the deck's fetch, hello and the parent's answer
  const look = await deck.evaluate(() => ({ opacity: getComputedStyle(document.body).opacity, look: document.documentElement.dataset.look ?? null }));
  await deck.click('.slide.on a.btn');
  await page.waitForTimeout(300);
  const heard = await page.evaluate(() => window.heard);
  await page.close();
  return { look, heard };
}

const atHq = await visit(hqServer);
expect('HQ: its look reaches the deck', atHq.look, { opacity: '0.123', look: 'parent' });
expect('HQ: a hello, then the button with the path and slide only', atHq.heard,
  [{ hq: 'deck', hello: true }, { hq: 'deck', open: 'https://demo.preview.example.test/', back: '/2026-01-01/presentation/#2' }]);
const atStranger = await visit(strangerServer);
expect('a stranger: no look', atStranger.look, { opacity: '1', look: null });
expect('a stranger: hears nothing', atStranger.heard, []);
const unnamed = await visit(hqForNothing);
expect('a server that names no HQ: no look', unnamed.look, { opacity: '1', look: null });
expect('a server that names no HQ: nothing sent', unnamed.heard, []);

await browser.close();
for (const s of [withHq, withoutHq, hqServer, strangerServer, hqForNothing]) s.close();
console.log(problems.length ? problems.map((p) => `FAIL ${p}`).join('\n') : 'all good: the deck talks to HQ only');
process.exit(problems.length ? 1 : 0);

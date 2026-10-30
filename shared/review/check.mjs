// Review mode on a phone, every way the board opens a demo (shared/review/README.md, "Testing locally").
//   cd platform/coordinator && npm ci && cd ../..
//   node shared/review/check.mjs [--shots dir] [--only hello,<slug>] [--device "iPhone 13"]
// A stand-in for production on this machine: the real coordinator (imported, no schedulers) serves HQ, the preview
// sign-in and /__review/*, every product runs its own server, and a small TLS router plays Caddy (infra/products.py):
// <slug>.preview.company.test behind the preview key (pv stripped before the product), cycles.preview for the cycles'
// pages (decks, brand directions, demos: the coordinator serves their HTML and adds review mode to it).
// Chromium resolves *.company.test to a loopback address of its own (127.7.2.2:443, CHECK_IP to change it).
// Then, held like a phone (touch, portrait), it opens each product from HQ's viewer, "Open in browser", a desk-phone
// card, the Artifacts tab's tile (live apps too: each `status: live` product gets the board's approval here; a cycles demo's
// too) and the
// cycle deck (its own pin, and a note on a slide leaving the slide where it is)
// and its buttons (to a product or a cycles demo), and every cycle page but a deck from HQ's viewer and "Open in browser",
// and a cycles page's PDF link inside HQ's viewer (it saves, the page stays),
// and checks: the real script (not the empty one), the pin drawn,
// on screen, clear of HQ's bar and the product's own buttons, and a tap on it starting a note. Last, a mark's anchor
// (anchor.js) on real elements in a product's page. Exit 1 on any failure.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { request } from 'node:http';
import { mkdtempSync, readFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, normalize, relative } from 'node:path';
import { createRequire } from 'node:module';
import { playwright } from '../browser/browser.mjs';
import { dropped } from './pincheck.mjs';

const REPO = new URL('../..', import.meta.url).pathname;
const { parse } = createRequire(join(REPO, 'platform/coordinator/package.json'))('yaml');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SHOTS = arg('--shots'), ONLY = arg('--only')?.split(','), DEVICE = arg('--device', 'iPhone 13');
const IP = process.env.CHECK_IP || '127.7.2.2', ZONE = 'company.test', HQ = `hq.${ZONE}`;
const tmp = mkdtempSync(join(tmpdir(), 'review-check-'));
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------- the stand-in
// approvals in the temp dir too: an inherited APPROVALS_DIR would get this run's stand-in records
Object.assign(process.env, { DATA_DIR: join(tmp, 'hq'), APPROVALS_DIR: join(tmp, 'approvals'), PUBLIC_HOST: HQ, REPO_DIR: REPO });
const { app } = await import(join(REPO, 'platform/coordinator/src/server.ts'));
const approvals = await import(join(REPO, 'platform/coordinator/src/approvals.ts'));
const { db } = await import(join(REPO, 'platform/coordinator/src/db.ts'));
const { boardOn } = await import(join(REPO, 'platform/coordinator/src/preview.ts'));
db.prepare('insert into sessions (token, expires) values (?, ?)').run('board-session', Date.now() + 864e5);

const slugs = readdirSync(join(REPO, 'products')).filter(s => !s.startsWith('_') && existsSync(join(REPO, 'products', s, 'app/src/server.ts')))
  .filter(s => !ONLY || ONLY.includes(s));
// a live product is live in Artifacts only with the board's record: give each one here, so the Artifacts path covers a live app's row
slugs.filter(s => /^status:\s*live\b/m.test(readFileSync(join(REPO, 'products', s, 'product.yaml'), 'utf8'))).forEach((s, i) => approvals.record(`site:${s}`, 9000 + i));
// the threads the artifacts' files name, as HQ has them: Artifacts fails on one it doesn't have
const { createThread } = await import(join(REPO, 'platform/coordinator/src/projects.ts'));
const manifests = execFileSync('git', ['-C', REPO, 'ls-files', '-z', '--', '*artifact.yaml', 'company/artifacts.yaml', 'products/*/product.yaml', '*demo.yaml']).toString().split('\0').slice(0, -1);
const tags = manifests.flatMap(file => {
  const manifest = parse(readFileSync(join(REPO, file), 'utf8'));
  return file === 'company/artifacts.yaml' ? manifest.artifacts.map(entry => entry.project) : [manifest.project];
}).filter(id => id?.includes('/'));
for (const id of new Set(tags)) {
  const [project, slug] = id.split('/');
  createThread({ project, slug, name: id, goal: 'the review check', owner: 'board' });
}
const ports = new Map(), kids = [];
slugs.forEach((s, i) => {
  const port = 19100 + i; ports.set(s, port);
  mkdirSync(join(tmp, s), { recursive: true });
  kids.push(spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.ts'], { cwd: join(REPO, 'products', s, 'app'),
    env: { ...process.env, PORT: String(port), DATA_DIR: join(tmp, s) }, stdio: 'ignore' }));
});
const quit = code => { kids.forEach(k => k.kill()); process.exit(code); };
process.on('SIGINT', () => quit(130));

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf' };
// Caddy's PDF_IN_FRAME on every preview host: a PDF that loads as a frame's page saves, an app's own name kept
const asFrame = (req, headers) => {
  if (req.headers['sec-fetch-dest'] !== 'iframe' || !String(headers['content-type']).startsWith('application/pdf')) return headers;
  return { ...headers, 'content-disposition': (headers['content-disposition'] ?? 'attachment').replace(/^inline/, 'attachment') };
};
function serveFile(req, res, dir, path) {
  let f = normalize(join(dir, decodeURIComponent(path)));
  if (!f.startsWith(dir)) { res.writeHead(403); return res.end(); }
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!existsSync(f)) {
    // a render this clone has only the .render.json of (renders aren't in git: shared/demo/renders.mjs)
    if (existsSync(`${f}.render.json`)) console.warn(`${relative(REPO, f)} isn't here: node shared/demo/renders.mjs fetch ${relative(process.cwd(), f)}`);
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, asFrame(req, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' })); res.end(readFileSync(f));
}
// forward_auth: without the board's key for this host, off to HQ's preview login (preview.ts check())
const gate = (req, res) => {
  if (boardOn(req, String(req.headers.host).toLowerCase())) return true;
  res.writeHead(302, { location: `https://${HQ}/preview/login?to=${encodeURIComponent(`https://${req.headers.host}${req.url}`)}` }); res.end();
  return false;
};
// Caddy marks every request through the preview door (proxy(door=True)): a product may answer the board differently there
const proxy = (req, res, port) => {
  const headers = { ...req.headers, cookie: (req.headers.cookie || '').replace(/^\s*pv=[^;]*;?\s*|;\s*pv=[^;]*/, ''), 'x-preview-door': '1' };
  const up = request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers }, r => { res.writeHead(r.statusCode, asFrame(req, r.headers)); r.pipe(res); });
  up.on('error', () => { res.writeHead(502); res.end('product down'); });
  req.pipe(up);
};
const certs = join(tmp, 'tls');
mkdirSync(certs);
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certs, 'key.pem'), '-out', join(certs, 'cert.pem'), '-days', '1',
  '-subj', `/CN=${ZONE}`, '-addext', `subjectAltName=DNS:*.${ZONE},DNS:*.preview.${ZONE}`], { stdio: 'ignore' });
const router = createServer({ key: readFileSync(join(certs, 'key.pem')), cert: readFileSync(join(certs, 'cert.pem')) }, (req, res) => {
  const host = String(req.headers.host), path = req.url.split('?')[0];
  if (host === HQ) return app(req, res);
  const slug = host.endsWith(`.preview.${ZONE}`) ? host.slice(0, -`.preview.${ZONE}`.length) : '';
  if (path === '/__preview') return app(req, res);
  if (slug === 'cycles' && path.startsWith('/__review/')) return app(req, res);
  if (slug === 'cycles' && path === '/shared/demo/foley.js') return gate(req, res) && serveFile(req, res, REPO, path);   // the sound kit, Caddy's kit_route: a demo's script imports it
  if (slug === 'cycles' && path === '/__hq-origin') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`https://${HQ}`); }
  // /__hq-origin as Caddy answers it, and its pages from the coordinator, as Caddy sends them (`*/`, `*.html`; a folder
  // without its / is redirected first).
  const file = join(REPO, 'products/_cycles', decodeURIComponent(path));
  if (slug === 'cycles' && !path.endsWith('/') && existsSync(file) && statSync(file).isDirectory()) { res.writeHead(308, { location: `${path}/` }); return res.end(); }
  if (slug === 'cycles' && (path.endsWith('/') || path.endsWith('.html'))) return gate(req, res) && app(req, res);
  if (slug === 'cycles') return gate(req, res) && serveFile(req, res, join(REPO, 'products/_cycles'), path);
  if (!ports.has(slug)) { res.writeHead(404); return res.end(); }
  if (path.startsWith('/__review/')) return app(req, res);
  if (gate(req, res)) proxy(req, res, ports.get(slug));
});
await new Promise((ok, fail) => router.on('error', fail).listen(443, IP, ok));

// ---------------------------------------------------------------- the phone
const { chromium, devices } = playwright();
const ARGS = [`--host-resolver-rules=MAP *.${ZONE} ${IP}`, '--autoplay-policy=no-user-gesture-required'];
const browser = await chromium.launch({ args: ARGS });
const boardContext = async b => {
  const c = await b.newContext({ ...devices[DEVICE], ignoreHTTPSErrors: true });
  await c.addCookies([{ name: 's', value: 'board-session', domain: HQ, path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
  return c;
};
const ctx = await boardContext(browser);
// review.js keeps its UI in a closed shadow root: open it for the checks (only in this browser)
await ctx.addInitScript(() => { const a = Element.prototype.attachShadow; Element.prototype.attachShadow = function (o) { return a.call(this, { ...o, mode: 'open' }); }; });
await new Promise(r => setTimeout(r, 1500)); // the product servers start

const results = [];
const report = (path, slug, r) => { results.push({ path, slug, ...r }); console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${path.padEnd(16)} ${slug.padEnd(14)} ${r.why}`); };
const ui = (frame, fn, arg) => frame.evaluate(([f, a]) => new Function('root', 'a', `return (${f})(root, a)`)(document.querySelector('review-mode')?.shadowRoot, a), [fn.toString(), arg]);
const picking = frame => frame.waitForFunction(() => !document.querySelector('review-mode').shadowRoot.querySelector('.veil').hidden, null, { timeout: 3000 }).then(() => true, () => false);
// In a page (or HQ's viewer frame): the real script, the pin drawn, on screen, clear of HQ's bar and of the product's own
// buttons, and a finger on it (and on the bar's pin, in HQ) starting a note.
async function inspect(frame, inHq) {
  await frame.waitForLoadState('load').catch(() => {});
  const real = await frame.evaluate(async () => !(await (await fetch('/__review/review.js')).text()).startsWith('/* review mode: off')).catch(() => false);
  const drawn = await frame.waitForFunction(() => document.querySelector('review-mode')?.shadowRoot?.querySelector('.fab'), null, { timeout: 5000 }).then(() => true, () => false);
  if (!drawn) return { ok: false, why: real ? 'the real script, but no pin drawn' : 'empty script: no pv cookie here' };
  await frame.waitForTimeout(1200); // the pin settles clear of the page's buttons, the first-time bubble pops up
  const fab = await ui(frame, root => {
    const r = root.querySelector('.fab').getBoundingClientRect(), tappable = 'a[href], button, input, select, textarea, label, summary, [role=button], [role=link], [onclick]';
    const under = new Set();
    for (const dx of [.15, .5, .85]) for (const dy of [.15, .5, .85]) {
      const el = document.elementsFromPoint(r.left + r.width * dx, r.top + r.height * dy).find(e => e.localName !== 'review-mode' && e !== document.documentElement && e !== document.body)?.closest(tappable);
      // blocked: the pin hides a third or more of what's visible of it
      const b = el?.getBoundingClientRect(), vis = b && Math.max(0, Math.min(b.right, innerWidth) - Math.max(b.left, 0)) * Math.max(0, Math.min(b.bottom, innerHeight) - Math.max(b.top, 0));
      const over = b && Math.max(0, Math.min(b.right, r.right) - Math.max(b.left, r.left)) * Math.max(0, Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top));
      if (el && over >= vis / 3) under.add(el.outerHTML.replace(/\s+/g, ' ').slice(0, 70));
    }
    return { x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, covers: [...under], coach: !root.querySelector('.coach').hidden };
  });
  if (fab.w < 44 || fab.x < 0 || fab.y < 0 || fab.x + fab.w > fab.vw || fab.y + fab.h > fab.vh) return { ok: false, why: `pin off screen at ${Math.round(fab.x)},${Math.round(fab.y)}` };
  // a real tap where the pin is on the screen, through whatever HQ or the page has on top of it
  const page = frame.page(), el = await frame.frameElement().catch(() => null), off = el ? await el.boundingBox() : { x: 0, y: 0 }, vp = page.viewportSize();
  const px = off.x + fab.x + fab.w / 2, py = off.y + fab.y + fab.h / 2, barBottom = inHq ? await page.$eval('#viewer .bar', b => b.getBoundingClientRect().bottom) : 0;
  if (py - fab.h / 2 < barBottom || py + fab.h / 2 > vp.height || px + fab.w / 2 > vp.width) return { ok: false, why: 'pin under HQ\'s bar or off the screen' };
  if (inHq && !(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.localName === 'iframe', [px, py]))) return { ok: false, why: 'something of HQ\'s covers the pin' };
  await page.touchscreen.tap(px, py);
  if (!(await picking(frame))) return { ok: false, why: 'a tap on the pin did nothing' };
  const coachGone = await ui(frame, root => root.querySelector('.coach').hidden);
  await page.touchscreen.tap(px, py); // and off again
  let why = `pin at ${Math.round(fab.x)},${Math.round(fab.y)}${fab.coach ? ', first-time bubble shown' : ''}, a tap opens the picker`;
  if (inHq) { // the bar's pin, once review mode said hello from the frame
    const b = await page.waitForSelector('#viewer .bar .pin:not([hidden])', { timeout: 3000 }).catch(() => null);
    if (!b) return { ok: false, why: 'no pin in HQ\'s viewer bar' };
    await b.tap();
    if (!(await picking(frame))) return { ok: false, why: 'the bar\'s pin did nothing' };
    await b.tap(); why += ', and so does the bar\'s';
  }
  if (fab.coach && !coachGone) return { ok: false, why: 'the first-time bubble stayed after the pin was used' };
  if (fab.covers.length) return { ok: false, why: `pin covers the page's ${fab.covers.join(' | ')}` };
  return { ok: true, why, fab };
}
const shot = async (page, name) => SHOTS && page.screenshot({ path: join(SHOTS, `${name}.png`) });
// A page's own links in HQ's viewer, each tapped as the board would (a page of its own, or a route the page draws
// itself): the next page has the pin and the bar's Note, both start a note, and the bar has no Note where review mode
// doesn't run
const FOLLOW = 3;
async function follow(page, path, name, host) {
  const frame = () => page.$('#viewer iframe').then(f => f.contentFrame());
  const start = (await frame()).url(), seen = new Set([new URL(start).pathname]);
  const links = await (await frame()).$$eval('a[href]', as => as.filter(a => a.offsetParent && !a.target).map(a => a.href)
    .filter(h => h.startsWith(`${location.origin}/`) && !h.includes('#')).map(h => h.split('?')[0])).catch(() => []);
  const paths = [...new Set(links)].filter(h => !seen.has(new URL(h).pathname)).slice(0, FOLLOW);
  for (const href of paths) {
    await openLink(page, start, href);
    const f = await frame();
    await f.waitForURL(u => u.href.split('?')[0] === href, { timeout: 10000 }).catch(() => {});
    const r = await inspect(f, true);
    report(path, `${name} → ${new URL(href).pathname}`, r);
    if (r.ok && href === paths[0]) report(`${path}-sent`, `${name} → ${new URL(href).pathname}`, await pinAndSend(page, f));
  }
  // a page without review mode (a stand-in for one written without the tag): no Note in the bar once it has loaded
  await (await frame()).evaluate(u => { location.href = u; }, `https://${host}/__review/none`);
  await page.waitForTimeout(2000);
  const stale = await page.$eval('#viewer .bar .pin', b => !b.hidden);
  report(path, `${name} → a page without it`, { ok: !stale, why: stale ? 'the bar still shows Note on a page that can\'t take a note' : 'no Note in the bar there' });
}
// a note pinned with the bar's Note on the page in the viewer, then sent from Reviews as the board sends it: it arrives
// (sent, in the coordinator)
let pins = 0;
async function pinAndSend(page, f) {
  const words = `A note on the next page, ${++pins}`, box = await (await f.frameElement()).boundingBox();
  await page.tap('#viewer .bar .pin'); await picking(f);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.45);
  if (!(await f.waitForSelector('review-mode .sheet:not([hidden])', { timeout: 3000 }).catch(() => null))) return { ok: false, why: 'no note sheet after the bar\'s Note and a tap' };
  await f.tap('review-mode textarea'); await page.keyboard.type(words); await f.tap('review-mode .send');
  const send = await page.waitForSelector('#viewer .bar .send:not([hidden])', { timeout: 10000 }).catch(() => null);
  const pinned = db.prepare('select id from review_notes where note = ?').get(words);
  if (!send || !pinned) return { ok: false, why: send ? 'the bar\'s Send came, but no note reached the coordinator' : 'no Send in the bar after pinning' };
  await send.tap();
  const tick = await page.waitForSelector(`[data-note="${pinned.id}"]`, { timeout: 10000 }).catch(() => null);
  if (!tick) return { ok: false, why: 'the note isn\'t in Reviews' };
  await tick.tap(); await page.tap('section.wanted [data-send]');
  await page.waitForFunction(id => !document.querySelector(`[data-note="${id}"]`), pinned.id, { timeout: 10000 }).catch(() => {});
  const status = db.prepare('select status from review_notes where id = ?').get(pinned.id)?.status;
  return { ok: status === 'sent', why: `pinned with the bar's Note, ticked in Reviews and sent: ${status}` };
}
// back on the first page, a link to href tapped where the board would tap it
async function openLink(page, start, href) {
  let f = await page.$('#viewer iframe').then(e => e.contentFrame());
  if (f.url() !== start) { await f.evaluate(u => { location.href = u; }, start); await page.waitForTimeout(1500); f = await page.$('#viewer iframe').then(e => e.contentFrame()); }
  await f.waitForLoadState('load').catch(() => {});
  const el = (await f.evaluateHandle(h => [...document.querySelectorAll('a[href]')].find(a => a.href.split('?')[0] === h && a.offsetParent), href)).asElement();
  if (el) { await el.scrollIntoViewIfNeeded().catch(() => {}); await el.tap().catch(() => el.evaluate(x => x.click())); }
  else await f.evaluate(u => { location.href = u; }, href);
  await page.waitForTimeout(1800);
}
const openHq = async (c = ctx) => {
  const page = await c.newPage();
  await page.goto(`https://${HQ}/?intro=0`, { waitUntil: 'domcontentloaded' });
  // #hud is in the page itself; its buttons get their handlers once HQ has booted, after the viewer's link handler
  await page.waitForFunction(() => document.querySelector('#btn-computer')?.onclick, null, { timeout: 15000 });
  return page;
};
// a preview link somewhere in HQ, tapped: HQ's click handler opens it in the viewer
const tapLink = (page, url) => page.evaluate(u => { const a = Object.assign(document.createElement('a'), { href: u, textContent: 'preview' }); document.body.append(a); a.click(); a.remove(); }, url);
// (the bar's address: the host, then its ↗.)
const viewerFrame = async (page, host) => {
  await page.waitForFunction(h => document.querySelector('#viewer iframe[src]') && document.querySelector('#viewer .bar .where')?.textContent === `${h}↗`, host, { timeout: 10000 });
  const f = await (await page.$('#viewer iframe')).contentFrame();
  await f.waitForURL(u => u.hostname === host && !u.pathname.startsWith('/__preview'), { timeout: 10000 }).catch(() => {});
  return f;
};

for (const slug of slugs) {
  const host = `${slug}.preview.${ZONE}`, url = `https://${host}/`;
  // 1. a desk-phone card with a preview link: the phone opens it in HQ's viewer
  {
    const page = await openHq();
    const phone = await page.evaluate(async u => { const d = await import('/shell/desk.js'); await d.openPhone(); const s = document.querySelector('#phone-screen');
      s?.insertAdjacentHTML('beforeend', `<p class="card-link"><a href="${u}" target="_blank" rel="noopener">${u}</a></p>`); return !!s; }, url);
    if (!phone) report('desk-phone', slug, { ok: false, why: 'the desk phone did not open' });
    else { await page.tap('#phone-screen .card-link a'); report('desk-phone', slug, await inspect(await viewerFrame(page, host), true)); await shot(page, `${slug}-viewer`); }
    // 2. "Open in browser" from the viewer's bar, straight away and again after the first link was used
    for (const round of ['open-in-browser', 'browser-again']) {
      const [tab] = await Promise.all([ctx.waitForEvent('page', { timeout: 10000 }).catch(() => null), page.tap('#viewer .bar a[data-external]')]);
      if (!tab) { report(round, slug, { ok: false, why: 'no tab opened' }); continue; }
      await tab.waitForURL(u => u.hostname === host && !u.pathname.startsWith('/__preview'), { timeout: 10000 }).catch(() => {});
      report(round, slug, await inspect(tab.mainFrame(), false)); if (round === 'open-in-browser') await shot(tab, `${slug}-browser`); await tab.close();
    }
    await page.close();
  }
  // 3. HQ's viewer from any other preview link in HQ (the Notes tab, the Library)
  {
    const page = await openHq(); await tapLink(page, url);
    report('viewer', slug, await inspect(await viewerFrame(page, host), true));
    await follow(page, 'viewer-next', slug, host);
    await page.close();
  }
  // 4. the Artifacts tab: the app's tile, live apps included, and a live app's link to its public site ("live ↗", the
  // front door's address), its title saying it has no notes
  {
    const page = await openHq();
    await page.evaluate(async () => (await import('/shell/desk.js')).openComputer('artifacts'));
    const row = `.applist li:has(a.open[href="${url.slice(0, -1)}"])`;
    const go = await page.waitForSelector(`${row} a.open`, { timeout: 10000 }).catch(() => null);
    if (!go) report('apps', slug, { ok: false, why: 'no tile for it' });
    else {
      const pub = await page.$$eval(`${row} a.public`, as => as.map(a => [a.dataset.external, a.title]));
      if (pub.some(([ext, title]) => ext !== '1' || !/no notes/.test(title))) report('apps-public', slug, { ok: false, why: 'a public link not marked as having no notes' });
      else if (pub.length) report('apps-public', slug, { ok: true, why: `${pub.length} public link(s), titled no notes` });
      await shot(page, `${slug}-apps`);
      await go.tap();
      report('apps', slug, await inspect(await viewerFrame(page, host), true));
    }
    await page.close();
  }
}
// 4b. a cycle folder's tile in Artifacts (a demo.yaml or artifact.yaml in it) opens it in HQ's viewer, with the pin
if (!ONLY || ONLY.includes('cycles')) {
  const page = await openHq(), host = `cycles.preview.${ZONE}`;
  await page.evaluate(async () => (await import('/shell/desk.js')).openComputer('artifacts'));
  await page.waitForSelector('.applist a.open', { timeout: 10000 }).catch(() => {});
  const demos = await page.$$eval(`.applist a.open[href^="https://${host}/"]`, as => as.map(a => a.getAttribute('href')));
  if (!demos.length) report('apps-demo', '-', { ok: false, why: 'no cycle folder in Artifacts' });
  await page.close();
  for (const href of demos) {   // (a fresh HQ for each: the viewer the last one opened covers the tiles.)
    const one = await openHq();
    await one.evaluate(async () => (await import('/shell/desk.js')).openComputer('artifacts'));
    const tile = await one.waitForSelector(`.applist a.open[href="${href}"]`, { timeout: 10000 });
    await tile.tap();
    report('apps-demo', new URL(href).pathname, await inspect(await viewerFrame(one, host), true));
    await one.close();
  }
}
// 5. the cycle deck in HQ's viewer: each "try the preview" button opens its product in the viewer, and Back returns to the slide
for (const deck of (existsSync(join(REPO, 'products/_cycles')) ? readdirSync(join(REPO, 'products/_cycles')) : []).filter(d => existsSync(join(REPO, 'products/_cycles', d, 'presentation/index.html')))) {
  const page = await openHq(), deckHost = `cycles.preview.${ZONE}`;
  await tapLink(page, `https://${deckHost}/${deck}/presentation/`);
  let f = await viewerFrame(page, deckHost);
  // the deck's own pin (its CSP lets in review.js from its site), and a note pinned and typed on a slide leaves the slide
  // where it is: a tap on its right side, a space or an arrow would turn it
  report('deck', deck, await inspect(f, true));
  await f.evaluate(() => { location.hash = '#2'; }); await page.waitForTimeout(800);
  const bar = await page.$('#viewer .bar .pin:not([hidden])'), box = await (await f.frameElement()).boundingBox();
  if (bar) {
    await bar.tap(); await picking(f);
    await page.touchscreen.tap(box.x + box.width * 0.85, box.y + box.height * 0.3);
    const noted = await f.waitForSelector('review-mode .sheet:not([hidden])', { timeout: 3000 }).then(() => true, () => false);
    if (noted) { await f.tap('review-mode textarea'); await page.keyboard.type('A note on this slide'); await page.keyboard.press('ArrowRight'); }
    const [at, typed] = await f.evaluate(() => [location.hash, document.querySelector('review-mode').shadowRoot.querySelector('textarea').value]);
    report('deck-note', deck, { ok: noted && at === '#2' && typed === 'A note on this slide', why: `${noted ? 'pinned' : 'no note sheet'}, typed "${typed}", on slide ${at}` });
    await page.keyboard.press('Escape');
  }
  await f.waitForSelector('a.btn', { state: 'attached', timeout: 10000 }).catch(() => {});
  const links = await f.$$eval('a.btn', as => as.map(a => a.href)).catch(() => []);
  for (const href of links) {
    const slug = new URL(href).hostname.split('.')[0], host = `${slug}.preview.${ZONE}`;
    if (!ports.has(slug) && slug !== 'cycles') continue;
    // the button, on its slide, as the board taps it (the deck's address swapped for the stand-in's)
    const local = `https://${host}${new URL(href).pathname}`;
    const n = await f.evaluate(([h, l]) => { const a = [...document.querySelectorAll('a.btn')].find(x => x.href === h); a.href = l;
      const slide = a.closest('section, .slide'); return location.hash = `#${[...slide.parentElement.children].indexOf(slide) + 1}`; }, [href, local]);
    await page.waitForTimeout(800);
    const [tab] = await Promise.all([ctx.waitForEvent('page', { timeout: 2500 }).catch(() => null), f.tap(`a.btn[href="${local}"]`)]);
    if (tab) { report('deck-button', slug, { ok: false, why: 'opened a new tab, outside HQ' }); await tab.close(); continue; }
    // the viewer opened anew, with its Back: a cycles demo is on the deck's own host, so the host alone can't tell them apart
    await page.waitForSelector('#viewer [data-back]', { timeout: 5000 }).catch(() => {});
    report('deck-button', slug, await inspect(await viewerFrame(page, host), true));
    await shot(page, `${slug}-deck`);
    const back = await page.$('#viewer [data-back]');
    if (!back) { report('deck-back', slug, { ok: false, why: 'no way back to the deck' }); break; }
    await back.tap(); await page.waitForSelector('#viewer [data-back]', { state: 'detached', timeout: 5000 }).catch(() => {});
    f = await viewerFrame(page, deckHost);
    const at = await f.evaluate(() => location.hash);
    report('deck-back', slug, { ok: at === n, why: at === n ? `back on slide ${n}` : `back on ${at || 'the first slide'}, not ${n}` });
  }
  await page.close();
}
// 5b. the cycles' own pages (a demo, a brand direction's sketched site): from HQ's viewer and in the browser; a deck's
// own pin is checked in 5 (the deck's pin)
const CYCLES = join(REPO, 'products/_cycles');
const cyclePages = (existsSync(CYCLES) ? readdirSync(CYCLES, { recursive: true }) : []).map(String)
  .filter(f => f.endsWith('index.html') && f.split('/').length <= 3 && !f.endsWith('presentation/index.html'))
  .filter(f => !ONLY || ONLY.includes('cycles')).sort();
for (const f of cyclePages) {
  const host = `cycles.preview.${ZONE}`, name = f.replace(/\/?index\.html$/, '/'), page = await openHq();
  await tapLink(page, `https://${host}/${name}`);
  report('cycles-viewer', name, await inspect(await viewerFrame(page, host), true));
  await follow(page, 'cycles-next', name, host);
  await tapLink(page, `https://${host}/${name}`); await viewerFrame(page, host);
  await shot(page, `cycles-${name.replace(/\W+/g, '-')}viewer`);
  const [tab] = await Promise.all([ctx.waitForEvent('page', { timeout: 10000 }).catch(() => null), page.tap('#viewer .bar a[data-external]')]);
  if (!tab) report('cycles-browser', name, { ok: false, why: 'no tab opened' });
  else {
    await tab.waitForURL(u => u.hostname === host && !u.pathname.startsWith('/__preview'), { timeout: 10000 }).catch(() => {});
    report('cycles-browser', name, await inspect(tab.mainFrame(), false)); await tab.close();
  }
  await page.close();
}
// 5c. a page's PDF link, tapped in HQ's viewer: the file saves and the page stays. Chrome shows no PDF in the viewer's
// sandboxed frame, only a page saying it's blocked: each cycles page's first PDF link,
// as it is and without a `download` of its own, in the whole Chromium (the headless shell saves every PDF, so the blocked
// page never shows there).
const pdfPages = cyclePages.map(f => [f, /href="([^"#?]+\.pdf)"/i.exec(readFileSync(join(CYCLES, f), 'utf8'))?.[1]]).filter(([, pdf]) => pdf);
if (pdfPages.length) {
  const whole = await chromium.launch({ channel: 'chromium', args: ARGS }), wholeCtx = await boardContext(whole);
  for (const [f, pdf] of pdfPages) {
    const host = `cycles.preview.${ZONE}`, name = f.replace(/\/?index\.html$/, '/'), page = await openHq(wholeCtx);
    await tapLink(page, `https://${host}/${name}`);
    const start = (await viewerFrame(page, host)).url(), href = new URL(pdf, start).href;
    const viewerPage = () => page.$('#viewer iframe').then(e => e.contentFrame());
    for (const keepsDownload of [true, false]) {
      const frame = await viewerPage();
      await frame.waitForLoadState('load').catch(() => {});
      const link = (await frame.evaluateHandle(([h, keepsDownload]) => {
        const a = [...document.querySelectorAll('a[href]')].find(x => x.href === h);
        if (a && !keepsDownload) a.removeAttribute('download');
        return a;
      }, [href, keepsDownload])).asElement();
      if (!link) { report('pdf', `${name} ${pdf}`, { ok: false, why: 'its link isn\'t on the page' }); break; }
      await link.scrollIntoViewIfNeeded().catch(() => {});
      const [saved] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }).catch(() => null), link.tap()]);
      await page.waitForTimeout(800);
      const at = (await viewerPage()).url();
      const why = `${keepsDownload ? 'as it is' : 'without download'}: ${saved ? `saved ${saved.suggestedFilename()}` : 'nothing saved'}, ${at === start ? 'the page stayed' : `the frame went to ${at}`}`;
      report('pdf', `${name} ${pdf}`, { ok: !!saved && at === start, why });
      if (at !== start) await frame.goto(start).catch(() => {});
    }
    await page.close();
  }
  await whole.close();
}
// 6. a page that frames another preview gets no second pin there (review mode runs in a frame only right inside HQ)
if (slugs.length) {
  const [a, b] = slugs, page = await ctx.newPage();
  if (b) {
    await page.goto(`https://${a}.preview.${ZONE}/`);
    await page.evaluate(u => document.body.append(Object.assign(document.createElement('iframe'), { src: u })), `https://${b}.preview.${ZONE}/`);
    const inner = await (await page.waitForSelector('body > iframe:last-of-type')).contentFrame();
    await inner.waitForLoadState('load'); await inner.waitForTimeout(1000);
    const pins = await inner.evaluate(() => !!document.querySelector('review-mode'));
    report('framed-elsewhere', b, { ok: !pins, why: pins ? 'a pin in a frame that isn\'t HQ\'s viewer' : `no pin inside ${a}'s frame` });
  }
  // 7. dragged to the left, the pin stays exactly where it's let go, and there
  // on the next page
  await page.goto(`https://${a}.preview.${ZONE}/`); await page.waitForTimeout(1200);
  // (held at the pin's middle, whatever its size)
  const r = await ui(page.mainFrame(), root => { const b = root.querySelector('.fab').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  const cdp = await ctx.newCDPSession(page), touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', r.x, r.y); for (let i = 1; i <= 10; i++) await touch('touchMove', r.x - i * 25, r.y - i * 20);
  report('drop', a, await dropped(page.mainFrame(), () => touch('touchEnd')));
  await page.reload(); await page.waitForTimeout(1200);
  const left = await ui(page.mainFrame(), root => root.querySelector('.fab').getBoundingClientRect().left);
  report('drag', a, { ok: left < 100, why: left < 100 ? 'dragged left, it stays left after a reload' : `still at x ${Math.round(left)} after the drag` });
  // 8. dragged high up, then the phone turns sideways (or a reload in a shorter frame): the pin stays on screen,
  // and turned back upright it's where the board left it
  const fab = () => ui(page.mainFrame(), root => { const b = root.querySelector('.fab').getBoundingClientRect(); return { top: b.top, bottom: b.bottom, x: b.left + b.width / 2, y: b.top + b.height / 2, h: innerHeight }; });
  const upright = page.viewportSize(), onScreen = p => p.top >= 0 && p.bottom <= p.h;
  const s = await fab();
  await touch('touchStart', s.x, s.y); for (let i = 1; i <= 10; i++) await touch('touchMove', s.x, s.y + (100 - s.y) * i / 10); await touch('touchEnd');
  await page.waitForTimeout(600);
  const high = await fab();
  await page.setViewportSize({ width: upright.height, height: upright.width }); await page.waitForTimeout(900);
  const turned = await fab();
  report('drag-rotate', a, { ok: onScreen(turned), why: onScreen(turned) ? `dragged to y ${Math.round(high.top)}, sideways it sits at y ${Math.round(turned.top)} of ${turned.h}` : `sideways the pin is at y ${Math.round(turned.top)}..${Math.round(turned.bottom)}, off a ${turned.h} px screen` });
  await page.reload(); await page.waitForTimeout(1200);
  const reloaded = await fab();
  report('drag-reload', a, { ok: onScreen(reloaded), why: onScreen(reloaded) ? `reloaded sideways, on screen at y ${Math.round(reloaded.top)}` : `reloaded sideways, off screen at y ${Math.round(reloaded.top)}..${Math.round(reloaded.bottom)}` });
  await page.setViewportSize(upright); await page.waitForTimeout(900);
  const back = await fab(), home = Math.abs(back.top - high.top) < 4;
  report('drag-upright', a, { ok: home, why: home ? `upright again, back at y ${Math.round(back.top)}` : `upright again at y ${Math.round(back.top)}, dragged to ${Math.round(high.top)}` });
  // 9. a mark's anchor (anchor.js, as the coordinator serves it) on real elements: its selector, found again by the
  // browser's own querySelector through an open shadow root, the private rule, and a point placed on its element as it
  // is now, in document px
  await page.goto(`https://${a}.preview.${ZONE}/`); await page.waitForTimeout(600);
  const wrong = await page.evaluate(anchorCases);
  report('anchor', a, { ok: !wrong.length, why: wrong.length ? wrong.join('; ') : 'selectors found again (an id with a digit, a shadow root), private words kept out, a point on its element as it is now' });
  await page.close();
}

// The anchor's cases, run in the page: what went wrong, or nothing
async function anchorCases() {
  const { anchorOf, found, placer, selector, textOf } = await import('/__review/anchor.js');
  const wrong = [], same = (got, want, what) => JSON.stringify(got) !== JSON.stringify(want) && wrong.push(`${what}: ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
  const fixture = Object.assign(document.createElement('div'), { id: 'anchor-check' });
  fixture.style.cssText = 'position: relative; height: 4000px';
  fixture.innerHTML = `<section id="123"><p></p><p class="lead big third">Lead</p></section><h1 style="position: absolute; top: 900px; left: 10px; width: 300px; height: 50px; margin: 0">Hello</h1>
    <dl data-private><dd>someone@example.com</dd></dl><p class="long">  ${'word '.repeat(60)}  </p><img alt="A  cat"><chat-box id="9lives"></chat-box><chat-box class="private" data-private></chat-box>`;
  document.body.append(fixture);
  const $ = s => fixture.querySelector(s);
  try {
    // an id that starts with a digit is escaped, and the browser finds the element by it
    const lead = $('p.lead');
    same(selector(lead), 'section#\\31 23 > p.lead.big:nth-of-type(2)', 'the selector');
    same(found(selector(lead), document) === lead, true, 'found by its selector');
    // in an open shadow root: the host's path, a space, its own (the escape's space kept)
    const chat = $('chat-box#\\39 lives'), shadow = chat.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<div class="panel"><button id="send">Send</button></div>';
    const send = shadow.querySelector('button');
    same(selector(send), 'chat-box#\\39 lives button#send', 'the shadow selector');
    same(found(selector(send), document) === send, true, 'found through the shadow root');
    same(found('chat-box#\\39 lives nav', document), null, 'nothing there');
    // no words from a private element, inside a private host's shadow root too; others at most 200
    same(textOf($('dd')), '', 'a private element');
    const inner = Object.assign(document.createElement('p'), { textContent: 'My address is…' });
    $('chat-box.private').attachShadow({ mode: 'open' }).append(inner);
    same(textOf(inner), '', 'inside a private host');
    same(textOf($('p.long')).length, 200, 'long words');
    same(textOf($('img')), 'A cat', 'an image');
    // drawn scrolled down, a point on the headline stays on it with the page back at the top, follows it as it widens,
    // and stays where it was once the headline is gone
    const h1 = $('h1');
    scrollTo(0, 600);
    const view = { w: innerWidth, h: innerHeight, x: scrollX, y: scrollY, dpr: devicePixelRatio }, anchor = anchorOf(h1, { url: location.href, view });
    scrollTo(0, 0);
    const top = Math.round(h1.getBoundingClientRect().top + scrollY), { x, y, w } = anchor.el.box;
    same(y, top, "the box's document y");
    same(placer(anchor, document, { x: scrollX, y: scrollY })([x + w, y]), [x + w, y], 'a point on it, scrolled back');
    h1.style.width = '600px';
    same(placer(anchor, document, { x: scrollX, y: scrollY })([x + w, y]), [x + 2 * w, y], 'a point on it, twice as wide');
    h1.remove();
    same(placer(anchor, document, { x: scrollX, y: scrollY })([x + w, y]), [x + w, y], 'its element gone');
  } finally {
    fixture.remove();
  }
  return wrong;
}

const bad = results.filter(r => !r.ok);
console.log(`\n${results.length - bad.length} of ${results.length} paths ok.`);
await browser.close();
quit(bad.length ? 1 : 0);

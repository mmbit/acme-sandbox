#!/usr/bin/env node
// Checks a built deck: that it was built with today's kit, deck.js and deck.css, then in Chromium (Playwright) every
// slide on the board's screens (company/screens.json: its phone, in Safari and in HQ's viewer, its tablet, laptop and
// monitor): the controls clear of the slides, nothing cut off, text readable on a phone, visuals big enough to make out
// on a phone, each phone frame as wide as its phone, a poster on every video, every film playing; off a phone, every
// slide whole on the screen, lines short enough to read, text in proportion to the screen and no slide shrunk into an
// island in the middle of it; then tap-to-enlarge, the slide list, and the sounds: silent before a gesture, a
// transition sound after one, the mute (M) silencing sounds and videos and remembered after a reload.
//   node shared/deck/check.mjs products/_cycles/<date>/presentation/index.html [--shots /tmp/deck-shots] [--only 1,5,9] [--screens screens.json] [--webkit]
// --webkit runs it all in Playwright's WebKit, Safari's engine, where that's installed.
// Films are served as they are, so the check plays the files the board sees; a Chromium that can't play H.264 (older
// Playwright builds) gets VP9 WebM copies instead (made once, cached in $TMPDIR/deck-webm).
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, relative, extname, basename, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { playwright } from '../demo/core.mjs';
import { stale } from './inlined.mjs';

const argv = process.argv.slice(2), opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const page0 = resolve(argv.find((a, i) => !a.startsWith('--') && !['--shots', '--only', '--screens'].includes(argv[i - 1])) ?? '');
if (!existsSync(page0)) { console.error('usage: node shared/deck/check.mjs <index.html> [--shots dir] [--only 1,2] [--screens file.json] [--webkit]'); process.exit(1); }
const shots = opt('--shots'), only = opt('--only')?.split(',').map(Number);
const root = dirname(dirname(page0)); // serve the deck's parent, so ../ads/ works as on the cycles domain
const types = { '.html': 'text/html', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webm': 'video/webm', '.mp4': 'video/mp4', '.json': 'application/json' };
const problems = [], cache = join(tmpdir(), 'deck-webm'); mkdirSync(cache, { recursive: true });
// A deck plays the kit and deck.js it was built with: one built before a change to them is rebuilt, not checked as it is
for (const part of stale(readFileSync(page0, 'utf8'))) problems.push(`built with an old ${part}: rebuild it (node shared/deck/build.mjs <its deck.json>)`);
let h264 = true;   // asked of the browser once it's launched, before any page loads
function webm(file) {
  const out = join(cache, createHash('sha1').update(file + statSync(file).mtimeMs).digest('hex').slice(0, 12) + '.webm');
  if (!existsSync(out)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', 'scale=360:-2', '-c:v', 'libvpx-vp9', '-b:v', '600k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', out]);
  return out;
}
const server = createServer((req, res) => {
  let file;
  try { file = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); } catch { res.writeHead(400).end(); return; }
  if (!file.startsWith(root + sep) || !existsSync(file) || statSync(file).isDirectory()) {
    // a render this clone has only the .render.json of (renders aren't in git: shared/demo/renders.mjs)
    if (existsSync(`${file}.render.json`)) problems.push(`media: ${relative(root, file)} isn't here: node shared/demo/renders.mjs fetch ${relative(process.cwd(), file)}`);
    res.writeHead(404).end(); return;
  }
  let f = file;
  if (extname(file) === '.mp4' && !h264) try { f = webm(file); } catch { problems.push(`media: can't read ${relative(root, file)}`); res.writeHead(500).end(); return; }
  const body = readFileSync(f), type = types[extname(f)] ?? 'application/octet-stream';
  // a film's byte ranges, as Caddy serves them: WebKit's player can refuse a whole file sent for a range
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (!range) { res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes' }).end(body); return; }
  const start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
  if (start > end) { res.writeHead(416, { 'content-range': `bytes */${body.length}` }).end(); return; }
  res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${body.length}` }).end(body.subarray(start, end + 1));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok)); // localhost only, like shared/demo/core.mjs
const url = `http://127.0.0.1:${server.address().port}/${relative(root, page0)}`;

// Logs every sound the page starts (Web Audio buffers and unmuted videos), so the check can hear without speakers.
const spy = () => {
  window.__heard = [];
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...a) { window.__heard.push({ t: performance.now(), dur: this.buffer?.duration }); return start.apply(this, a); };
};
// The screens: a company names its board's in company/screens.json (or --screens <file>), each { name, width, height,
// inset: [top, right, bottom, left] safe areas, simulated through the deck's --sat/--sar/--sab/--sal; touch }; without
// one, a generic phone (in Safari, with its notch and home bar), tablet, laptop and QHD monitor. A screen under 500 px
// either way is a phone.
const own = opt('--screens') ?? join(dirname(fileURLToPath(import.meta.url)), '../../company/screens.json');
if (opt('--screens') && !existsSync(own)) { console.error(`no such screens file: ${own}`); process.exit(1); }
const sizes = (existsSync(own) ? JSON.parse(readFileSync(own, 'utf8')).screens : [
  { name: 'phone portrait', width: 390, height: 844, inset: [47, 0, 34, 0], touch: true },
  { name: 'phone landscape', width: 844, height: 390, inset: [0, 47, 21, 47], touch: true },
  { name: 'tablet portrait', width: 820, height: 1180, touch: true }, { name: 'tablet landscape', width: 1180, height: 820, touch: true },
  { name: 'laptop', width: 1440, height: 800 }, { name: 'QHD monitor', width: 2560, height: 1300 },
]).map((s) => [s.width, s.height, s.name, s.inset, !!s.touch]);
const { chromium, webkit } = playwright();
const browser = argv.includes('--webkit') ? await webkit.launch() : await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
{ // H.264 High, as the decks' films are made (canPlayType says 'probably' only for a codec it decodes)
  const p = await browser.newPage();
  h264 = await p.evaluate(() => document.createElement('video').canPlayType('video/mp4; codecs="avc1.640028"') === 'probably');
  await p.close();
}
if (shots) mkdirSync(shots, { recursive: true });
// (as env() would give them, so a deck in a frame can set its own to 0)
const insets = ([t, r, b, l]) => {
  const css = `:root { --sat: ${t}px; --sar: ${r}px; --sab: ${b}px; --sal: ${l}px; }`;
  document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); });
};
// A film that won't play (a codec Chromium can't decode, a broken file) fails on its slide, where deck.js plays it.
const unplayable = new Set(), watch = () => {
  window.__unplayable = [];
  document.addEventListener('error', (e) => {
    const v = e.target;
    if (v instanceof HTMLVideoElement) window.__unplayable.push([new URL(v.currentSrc || v.src).pathname.slice(1), v.error?.message || `error ${v.error?.code}`]);
  }, true);   // a media error doesn't bubble
};
const scrolled = {}; // slide views that scroll on a phone, per screen

for (const [w, h, name, inset, touch] of sizes) {
  const phone = Math.min(w, h) < 500;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: phone && h > w });
  const page = await ctx.newPage(); await page.addInitScript(spy); await page.addInitScript(watch);
  if (inset) await page.addInitScript(insets, inset);
  await page.goto(url + '#1'); await page.waitForTimeout(400);
  // the controls: never over the slides, and big enough to tap
  const bands = await page.evaluate(() => {
    const out = [], r = (el) => el.getBoundingClientRect(), deck = r(document.getElementById('deck'));
    // the slides reach the top of the screen; nothing above them is left blank
    if (deck.top > 1) out.push(`the slides start ${Math.round(deck.top)} px below the top of the screen`);
    for (const el of document.querySelectorAll('#bar > *')) {
      const b = r(el); if (!b.width || getComputedStyle(el).display === 'none') continue;
      if (b.bottom > deck.top + 1 && b.top < deck.bottom - 1) out.push(`#${el.id || el.className} overlaps the slides`);
      if (b.left < -1 || b.right > innerWidth + 1) out.push(`#${el.id || el.className} runs off the side of the screen`);
    }
    for (const b of document.querySelectorAll('#bar button:not([hidden]):not(#progress button)')) {
      const q = r(b); if (q.width < 39.5 || q.height < 39.5) out.push(`button ${b.id} is ${Math.round(q.width)}×${Math.round(q.height)}, under 40 px`);
    }
    return out;
  });
  for (const b of bands) problems.push(`${name}: ${b}`);
  const n = await page.$$eval('.slide', (s) => s.length);
  for (let i = 1; i <= n; i++) {
    if (only && !only.includes(i)) continue;
    await page.evaluate((i) => { location.hash = '#' + i; }, i); await page.waitForTimeout(700);
    await page.$$eval('.slide.on img', (imgs) => Promise.all(imgs.map((m) => (m.loading = 'eager', m.decode().catch(() => {})))));
    const { bad, scrolls } = await page.evaluate((phone) => {
      const s = document.querySelector('.slide.on'), out = [], stage = s.getBoundingClientRect();
      const what = (el) => `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`;
      for (const el of s.querySelectorAll('h1, h2, p, li, figure, .card, .chart, a.btn, small, .note, figcaption')) {
        const r = el.getBoundingClientRect(); if (!r.width) continue;
        if (r.left < stage.left - 1 || r.right > stage.right + 1) out.push(`${what(el)} cut off at the side`);
        if (el.scrollHeight > el.clientHeight + 2 && getComputedStyle(el).overflow !== 'visible') out.push(`${what(el)} cut off inside its box`);
        const px = parseFloat(getComputedStyle(el).fontSize);
        if (phone && el.matches('h1, h2, p, li, small, .note, figcaption') && el.textContent.trim() && px < 11.5) out.push(`${what(el)} is ${px.toFixed(1)} px text`);
      }
      // the visuals: big enough to make out (over half the stage's height or width; on a title slide, a fifth), and a
      // poster for every video
      // on a phone (two pictures, overlapping or a pair, count as one)
      const figs = phone ? [...s.querySelectorAll('.vis.duo, .vis.pair, .vis:not(.duo, .pair) figure .shell')] : [];
      for (const f of figs) {
        const r = f.getBoundingClientRect(), fill = Math.max(r.width / stage.width, r.height / stage.height);
        if (fill < (s.matches('.hero') ? 0.2 : 0.55)) out.push(`${what(f.closest('figure') ?? f)} is small: ${Math.round(r.width)}×${Math.round(r.height)} px on a ${Math.round(stage.width)}×${Math.round(stage.height)} stage`);
      }
      // a phone figure as wide as its phone, not as its picture (WebKit sized it by the picture). A caption may leave a
      // title slide's phone a little narrower than its figure: it takes some of the row's height
      for (const f of s.querySelectorAll('figure.phone:not(:has(figcaption))')) {
        const fig = f.getBoundingClientRect().width, shell = f.querySelector('.shell').getBoundingClientRect().width;
        if (fig > shell + 2) out.push(`${what(f)} is ${Math.round(fig)} px wide around a ${Math.round(shell)} px phone`);
      }
      for (const v of s.querySelectorAll('video')) {
        const p = v.closest('.shell').querySelector('img.poster');
        if (!p || !p.complete || !p.naturalWidth) out.push(`${what(v)}: no poster shown`);
      }
      // on a big screen: lines short enough to read, text in proportion to the screen, and the slide using the screen
      // rather than shrinking into an island in the middle of it
      if (!phone) {
        for (const el of s.querySelectorAll('.sub, .points li, .card p, .more > p:not(.note)')) {
          const r = el.getBoundingClientRect(), cs = getComputedStyle(el), px = parseFloat(cs.fontSize);
          const lines = Math.max(1, Math.round(r.height / (parseFloat(cs.lineHeight) || px * 1.2)));
          const per = el.textContent.trim().length / lines;
          if (per > 90) out.push(`${what(el)}: lines of ${Math.round(per)} characters, too long to read`);
          if (px < innerHeight / 60) out.push(`${what(el)} is ${px.toFixed(1)} px text on a ${innerHeight} px high screen: under a 60th`);
        }
        let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
        for (const el of s.querySelectorAll('.body > *')) {
          const q = el.getBoundingClientRect(); if (!q.width || !q.height) continue;
          l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom);
        }
        if (r > l && (r - l) / stage.width < 0.6 && (b - t) / stage.height < 0.6)
          out.push(`an island: the slide fills ${Math.round(r - l)}×${Math.round(b - t)} px of a ${Math.round(stage.width)}×${Math.round(stage.height)} stage`);
      }
      // and off a phone, where there's room, the whole slide on the screen without scrolling
      const over = s.scrollHeight - s.clientHeight;
      if (!phone && over > 4) out.push(`doesn't fit the screen: ${over} px more below`);
      return { bad: out, scrolls: over > 4 };
    }, phone);
    for (const b of bad) problems.push(`${name} slide ${i}: ${b}`);
    if (scrolls && phone) scrolled[name] = (scrolled[name] ?? 0) + 1;
    if (shots) await page.screenshot({ path: join(shots, `${w}x${h}-${String(i).padStart(2, '0')}.png`) });
  }
  for (const [path, why] of await page.evaluate(() => window.__unplayable)) {
    let file = path; try { file = decodeURIComponent(path); } catch {}
    unplayable.add(`${file} (${why})`);
  }
  await ctx.close();
}
for (const u of unplayable) problems.push(`media: ${u} doesn't play`);

// Tapping a picture or a video shows it large and wholly on the screen (a video with its controls), on the phone held
// either way, in Safari and in HQ's viewer; Esc closes it. The menu lists every slide.
let menuChecked = false;
for (const [w, h, name, inset] of sizes.filter(([w, h]) => Math.min(w, h) < 500)) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: h > w });
  const page = await ctx.newPage(); if (inset) await page.addInitScript(insets, inset);
  await page.goto(url + '#1'); await page.waitForTimeout(300);
  for (const kind of ['img', 'video']) {
    const at = await page.$$eval('.slide', (s, kind) => s.findIndex((x) => x.querySelector(`figure .shell > ${kind}`)), kind);
    if (at < 0) continue;
    await page.evaluate((i) => { location.hash = '#' + (i + 1); }, at); await page.waitForTimeout(700);
    await page.locator(`.slide.on figure:has(.shell > ${kind}) .shell`).first().click({ position: { x: 20, y: 60 }, timeout: 5000 })
      .catch(() => {});   // off the screen or covered: reported below as not shown
    await page.waitForFunction(() => { const m = document.querySelector('#zoom .stage > *'); return m && (m.videoWidth || m.naturalWidth); }, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(300);
    const z = await page.evaluate(() => {
      const r = document.querySelector('#zoom .stage > *')?.getBoundingClientRect();
      if (document.getElementById('zoom').hidden || !r) return null;
      return { fill: Math.max(r.width / innerWidth, r.height / innerHeight), inside: r.top >= -1 && r.left >= -1 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1,
        rect: `${Math.round(r.width)}×${Math.round(r.height)} at ${Math.round(r.left)},${Math.round(r.top)}` };
    });
    const what = kind === 'img' ? 'a picture' : 'a video';
    if (!z || z.fill < 0.85) problems.push(`${name}: zoom: tapping ${what} (slide ${at + 1}) does not show it as large as the screen${z ? ` (${z.rect})` : ''}`);
    else if (!z.inside) problems.push(`${name}: zoom: ${what} (slide ${at + 1}) runs off the ${w}×${h} screen: ${z.rect}`);
    if (shots) await page.screenshot({ path: join(shots, `${w}x${h}-zoom-${kind}.png`) });
    await page.keyboard.press('Escape');
    if (!(await page.$eval('#zoom', (z) => z.hidden))) problems.push(`${name}: zoom: Esc does not close it`);
  }
  if (w < h && !menuChecked) {
    menuChecked = true;
    await page.click('#count'); await page.waitForTimeout(200);
    const listed = await page.$$eval('#menu ol ol button', (b) => b.length), slides = await page.$$eval('.slide', (s) => s.length);
    if (listed !== slides) problems.push(`menu: lists ${listed} of ${slides} slides`);
  }
  await ctx.close();
}

// In HQ's viewer the deck is a frame inside HQ's safe area: even when the frame
// is told the phone's insets, no blank strip above a slide (or below the controls) for a notch it isn't next to.
{
  const ctx = await browser.newContext({ viewport: { width: 420, height: 912 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage(); await page.addInitScript(insets, [68, 0, 34, 0]);
  await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><body style="margin:0;display:flex;flex-direction:column;height:100vh"><div style="height:120px;background:#1d1a2f"></div><iframe src="${url}#1" style="flex:1;border:0"></iframe>`);
  await page.waitForTimeout(800);
  const frame = page.frames().find((f) => f.url().startsWith(url));
  const pad = await frame?.evaluate(() => {
    const s = document.querySelector('.slide.on'), bar = document.getElementById('bar');
    return [Math.round(s.getBoundingClientRect().top + parseFloat(getComputedStyle(s).paddingTop)), Math.round(parseFloat(getComputedStyle(bar).paddingBottom))];
  });
  if (!pad) problems.push('in HQ\'s viewer: the deck did not load in a frame');
  else if (pad[0] > 30 || pad[1] > 30) problems.push(`in HQ's viewer: the deck keeps the phone's safe areas inside the frame (${pad[0]} px above the slide, ${pad[1]} px below the controls)`);
  await ctx.close();
}

// Sound: nothing before a gesture; a transition sound after one; M mutes both, and it's remembered.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage(); await page.addInitScript(spy);
  await page.goto(url + '#1'); await page.evaluate(() => { location.hash = '#2'; }); await page.waitForTimeout(500);
  const heard = () => page.evaluate(() => window.__heard.length);
  if (await heard()) problems.push('sound: something played before any tap or key');
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(500);
  if (!(await heard())) problems.push('sound: no transition sound after a key press');
  await page.keyboard.press('m'); await page.waitForTimeout(200);
  const before = await heard(); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(500);
  if ((await heard()) !== before) problems.push('sound: a transition sound played while muted');
  if (await page.$$eval('.slide.on video', (v) => v.some((x) => !x.muted))) problems.push('sound: a video plays unmuted while muted');
  await page.reload(); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(500);
  if (await heard()) problems.push('sound: mute not remembered after a reload');
  if ((await page.getAttribute('#snd', 'aria-pressed')) !== 'false') problems.push('sound: the button does not show mute after a reload');
  await page.keyboard.press('m'); await page.waitForTimeout(300);
  if (!(await heard())) problems.push('sound: unmuting gives no confirming click');
  await ctx.close();
}
await browser.close(); server.close();
console.log(`slides that scroll on a phone (fine, but look at them): ${Object.entries(scrolled).map(([k, v]) => `${v} on the ${k}`).join(', ') || 'none'}`);
console.log(problems.length ? [...new Set(problems)].join('\n') : `ok: ${sizes.length} sizes: controls clear of the slides, nothing cut off, text readable and in proportion, lines short enough, no islands, every slide whole on a tablet, laptop or monitor, visuals big enough, phone frames as wide as their phones, a poster on every video, every film plays; zoom and the slide list work; sounds silent before a gesture, mute works and is remembered`);
process.exit(problems.length ? 2 : 0);

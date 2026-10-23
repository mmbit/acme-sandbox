// The care service's widget against the real care server, in a real browser, at a phone's size and a tablet's both ways
// round:
//   node platform/care/demo/widget-check.mjs      (starts the local shop and the care server with the fake model;
//                                                  screenshots go to a fresh folder in $TMPDIR: look at them)
// It runs the company's plug-in (CARE_COMPANY_DIR, as the server does), in its words and its look; what it types and
// draws comes from the plug-in's demo/demo.mjs, else this folder's (shop.mjs).
// It checks what a customer relies on: the AI greeting before anything is typed, a burst of three messages answered
// once, an input that never locks, the conversation back after a reload (from the server), "Delete this conversation"
// emptying it, a tap and the email card, the launcher, a signed link, no console errors, no request to another origin, and
// nothing of the conversation in the browser's storage. And that it works for everyone, at every size: nothing cut
// off, 44 px targets, AA contrast measured (the plug-in's theme and a second, blue one), live regions, the keyboard (Tab
// order, the ⋯ menu's arrow keys, Escape, a modal sheet on a phone), reduced motion, the input above the phone's
// keyboard; then the outage message and the helper's return, a stop's header, "Delete this conversation", the
// health-detail card (held on the device, and care's own), and each of the plug-in's other languages.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { start, demo } from './shop.mjs';
import * as company from '../src/company.ts';
import * as i18n from '../public/i18n.js';
import { t as said } from '../src/texts.ts';
import { playwright } from '../../../shared/browser/browser.mjs';

// the server's words (texts.ts) are the plug-in's; loading it opens a database, so a throwaway one of the check's own
process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'care-widget-data-'));
await company.load();
const plugin = await import(pathToFileURL(join(company.DIR, 'public', 'plugin.js')).href).catch(() => ({}));
i18n.use({ langs: plugin.langs, words: plugin.words, helper: plugin.helper });
const words = (lang) => i18n.words(lang);
const NAMES = { tag: 'care-chat', opener: 'care', link: 'care', ...plugin.names }; // as widget.js has them
const TAG = NAMES.tag, OPENER = `[data-${NAMES.opener}]`;

process.env.CARE_RETRY_MS ??= '1500'; process.env.CARE_PROBE_MS ??= '1500'; // an outage comes and goes in seconds here
const SIZES = [
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  { name: 'tablet-landscape', viewport: { width: 1180, height: 820 }, hasTouch: true },
  { name: 'tablet-portrait', viewport: { width: 820, height: 1180 }, hasTouch: true },
];
// a second app's theme, as an app sets it: cool paper, navy ink, a blue accent, other fonts
const v = demo.theme.prefix;
const BLUE = `${TAG} { ${v}-accent: #2457c5; ${v}-ink: #14213d; ${v}-paper: #f3f6fb;
  ${v}-font: 'Liberation Sans', Arial, sans-serif; ${v}-serif: 'DejaVu Serif', Georgia, serif; }`;
// the plug-in's own theme's colours: none may show under the blue theme
const OWN_COLOURS = demo.theme.colours;
const ORDER = demo.orders()[1].id; // an order of the customer's, as they'd type it
const KEYBOARD_PX = 336; // an iPhone's keyboard at 390 px wide, suggestions bar included

const shots = await mkdtemp(join(tmpdir(), 'care-widget-'));
const shop = await start({ quiet: true });
const origin = new URL(shop.url).origin;
const fails = [];
const check = (what, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail && !ok ? `: ${detail}` : ''}`); if (!ok) fails.push(what); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [], elsewhere = [];
let failing = 0; // POSTs this check fails on purpose: their console line isn't an error of the widget's

// ---- measured in the page (page.evaluate: these run in the browser and can't use anything else in this file)

// One pass over the widget's shadow root: what's cut off, targets under 44 px, text under AA contrast, and every colour.
function measure(tag) {
  const root = document.querySelector(tag).shadowRoot, panel = root.querySelector('.chat');
  const out = { cut: [], small: [], low: [], colours: [], texts: 0 };
  const label = (el) => `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : ''} "${(el.textContent.trim() || el.getAttribute('aria-label') || el.placeholder || '').slice(0, 32)}"`;
  const shown = (el) => el.checkVisibility({ visibilityProperty: true }) && el.getClientRects().length > 0;
  const all = [...root.querySelectorAll('*')].filter((el) => !el.closest('svg') && !el.matches('style, link') && shown(el));
  const rect = (el) => el.getBoundingClientRect();
  const outside = (r, c, vertical) => r.left < c.left - 1 || r.right > c.right + 1 || (vertical && (r.top < c.top - 1 || r.bottom > c.bottom + 1));
  const view = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };

  // nothing cut off: the panel inside the screen, everything inside the panel (in a scroller, only sideways: the rest
  // scrolls), nothing wider than the box that clips it (an ellipsis is a cut too)
  if (!panel.hidden && outside(rect(panel), view, true)) out.cut.push(`the panel ${JSON.stringify(rect(panel))}`);
  for (const el of all) {
    if (el.classList.contains('vh')) continue;
    const r = rect(el), cs = getComputedStyle(el);
    if (el.closest('.launcher')) { if (outside(r, view, true)) out.cut.push(label(el)); continue; }
    const scroller = el.parentElement?.closest('.ch-log, .ch-about');
    if (outside(r, rect(scroller ?? panel), !scroller)) out.cut.push(`${label(el)} ${Math.round(r.left)}–${Math.round(r.right)} × ${Math.round(r.top)}–${Math.round(r.bottom)}`);
    if (cs.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1) out.cut.push(`${label(el)} overflows sideways (${el.scrollWidth} > ${el.clientWidth})`);
  }

  // 44 × 44 CSS px for everything you tap; a link inside a sentence is exempt (WCAG 2.5.8), so is the file input its label covers
  // A target's own ::after, placed around it, counts: the outage message's link keeps its lines tight that way
  const hit = (el) => {
    const r = rect(el), a = getComputedStyle(el, '::after');
    if (a.content === 'none' || a.position !== 'absolute') return r;
    const [t, right = t, b = t, left = right] = a.inset.split(' ').map(parseFloat);
    return { width: r.width - Math.min(0, left) - Math.min(0, right), height: r.height - Math.min(0, t) - Math.min(0, b) };
  };
  for (const el of all.filter((e) => e.matches('button, a[href], input, textarea, select, summary, label.btn') && !e.matches('.vh, .bubble a'))) {
    const r = hit(el);
    if (r.width < 43.5 || r.height < 43.5) out.small.push(`${label(el)} ${Math.round(r.width)}×${Math.round(r.height)}`);
  }

  // contrast: each text's colour over the backgrounds it really sits on (composited up the tree); disabled and
  // answered-and-faded controls are exempt (WCAG 1.4.3: "part of an inactive user interface component")
  const parse = (s) => {
    const n = s.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0];
    if (s.startsWith('color(srgb')) return { r: n[0] * 255, g: n[1] * 255, b: n[2] * 255, a: n[3] ?? 1 };
    return s === 'transparent' ? { r: 0, g: 0, b: 0, a: 0 } : { r: n[0], g: n[1], b: n[2], a: n[3] ?? 1 };
  };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const lum = (c) => [c.r, c.g, c.b].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const behind = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c.a > 0) layers.push(c); if (c.a >= 1) break; }
    return layers.reduceRight((under, top) => over(top, under), { r: 255, g: 255, b: 255, a: 1 });
  };
  for (const el of all) {
    const cs = getComputedStyle(el);
    for (const p of ['color', 'backgroundColor', 'borderTopColor']) { const c = parse(cs[p]); if (c.a > 0) out.colours.push(hex(c)); }
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const field = el.matches('textarea, input:not([type=file])');
    if (!own && !field) continue;
    if (el.closest(':disabled, .gone, .wg.done .chip:not(.picked), .wg.done .order:not(.picked)')) continue;
    const fg = parse(field && !el.value ? getComputedStyle(el, '::placeholder').color : cs.color);
    if (field && !el.value && !el.placeholder) continue;
    const bg = behind(el), text = over(fg, bg);
    const [hi, lo] = [lum(text), lum(bg)].sort((a, b) => b - a), ratio = (hi + 0.05) / (lo + 0.05);
    const size = parseFloat(cs.fontSize), large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    out.texts++;
    if (ratio < (large ? 3 : 4.5)) out.low.push(`${label(el)} ${ratio.toFixed(2)}:1 (${hex(text)} on ${hex(bg)}${field && !el.value ? ', placeholder' : ''})`);
  }
  return out;
}

// The element that has the focus, through the shadow root: its class, its words and where it sits.
function focused(opener) {
  let a = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  if (!a) return null;
  const r = a.getBoundingClientRect();
  return { inside: a.getRootNode() !== document, cls: typeof a.className === 'string' ? a.className : '', m: a.dataset?.m ?? null, tag: a.tagName.toLowerCase(),
    text: (a.textContent.trim() || a.getAttribute('aria-label') || '').slice(0, 40), x: Math.round(r.left), y: Math.round(r.top), opener: !!a.closest?.(opener) };
}

// ---- helpers
// in every page: careChat(), the widget's element, whatever the plug-in calls it
const chatFinder = (tag) => { window.careChat = () => document.querySelector(tag); };
async function newPage(options = {}) {
  const context = await browser.newContext(options);
  await context.addInitScript(chatFinder, TAG);
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() !== 'error') return; if (failing && /ERR_FAILED/.test(m.text())) failing--; else errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => { const u = r.url(); if (!u.startsWith('data:') && new URL(u).origin !== origin) elsewhere.push(u); });
  const $ = (s) => page.locator(`${TAG} ${s}`);
  const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });
  const openHelp = async () => { await page.locator(`header ${OPENER}`).click(); await $('.chat').waitFor({ state: 'visible' }); await wait(700); }; // past the opening animation (it scales)
  const greeted = () => $('.ch-items .msg.helper').first().waitFor({ timeout: 10_000 }).catch(() => {});
  const inject = (m) => page.evaluate((m) => document.querySelector(m.tag).widget.receive(m.m), { tag: TAG, m }); // draw as if the server said it
  return { context, page, $, shot, openHelp, greeted, inject };
}
// the fit, target and contrast checks for one state of the widget
async function looks(page, tag, { contrast = true } = {}) {
  await wait(700); // let pop-in animations settle (they scale)
  const m = await page.evaluate(measure, TAG);
  check(`${tag}: nothing cut off`, m.cut.length === 0, m.cut.slice(0, 4).join('; '));
  check(`${tag}: every target at least 44 × 44 px`, m.small.length === 0, m.small.slice(0, 4).join('; '));
  if (contrast) check(`${tag}: every text AA (${m.texts} measured)`, m.low.length === 0 && m.texts > 0, m.low.slice(0, 4).join('; '));
  return m;
}
const answers = (page, from) => page.$$eval(`${TAG} .ch-items .msg.helper`, (els, n) => new Set(els.slice(n).map((e, i) => e.dataset.answer || `bubble ${i}`)).size, from);
// every catalogue widget at once, drawn locally from invented specs: for the looks, not the conversation
async function gallery(w) {
  const day = (n) => new Date(Date.now() - n * 864e5).toISOString();
  for (const m of demo.gallery(day)) await w.inject(m);
}

const browser = await playwright().chromium.launch();
try {
  // ---- at each size: the conversation, then the looks (the plug-in's theme, then the blue one)
  for (const size of SIZES) {
    const tag = (s) => `${size.name}: ${s}`;
    const w = await newPage({ viewport: size.viewport, isMobile: !!size.isMobile, hasTouch: !!size.hasTouch });
    const { page, $, shot, openHelp, greeted } = w;
    const chat = $('.chat'), input = $('textarea'), mine = $('.ch-items .msg.me .bubble'), helpers = $('.ch-items .msg.helper');
    await page.goto(shop.url);
    check(tag('no launcher on a page with its own Help link'), await $('.launcher').isHidden());
    await openHelp();

    // the greeting says it's an AI before anything is typed (AI Act art. 50(1))
    await greeted();
    const greeting = (await helpers.first().textContent().catch(() => '')) ?? '';
    check(tag('the greeting says the helper is an AI, before anything is typed'), /\bAI\b/.test(greeting) && (await mine.count()) === 0, greeting.slice(0, 80));
    check(tag('the header shows the AI badge in text'), (await $('.ch-head abbr.ai').textContent()) === 'AI');
    const box = await chat.boundingBox(), { width, height } = size.viewport;
    if (width < 700) check(tag('a sheet over the whole page'), box.width === width && Math.round(box.height) >= height - 2, JSON.stringify(box));
    else check(tag('a ~400 px panel on the right'), box.width <= 400 && box.width >= 380 && width - (box.x + box.width) <= 40, JSON.stringify(box));
    // a touch screen opens on the log (the keyboard would cover the greeting), a mouse and keyboard on the input
    const first = await page.evaluate(focused, OPENER);
    check(tag('opening moves the focus into the chat (the log, on a touch screen)'), first?.inside && first.cls.includes('ch-log'), JSON.stringify(first));
    const modal = await chat.evaluate((el) => [el.getAttribute('role'), el.getAttribute('aria-modal')].join(' '));
    check(tag(width < 700 ? 'the sheet is a modal dialog' : 'the panel beside the page is not modal'), width < 700 ? modal === 'dialog true' : !modal.includes('true'), modal);
    await looks(page, tag('greeting'));
    await shot(`${size.name}-1-greeting`);

    // the input grows to fit what's typed with no scrollbar (its borders counted), and scrolls only at its cap
    const fits = [];
    for (const text of ['', 'one line', 'two lines, '.repeat(5), 'many lines, '.repeat(40)]) {
      await input.fill(text);
      fits.push(await input.evaluate((el) => ({ over: el.scrollHeight > el.clientHeight, scrolls: getComputedStyle(el).overflowY !== 'hidden', h: el.offsetHeight })));
    }
    check(tag('the input shows no scrollbar until it is at its 120 px cap, then scrolls'), fits.every((f) => f.scrolls === (f.h >= 120) && (f.scrolls || !f.over)) && fits.at(-1).scrolls, JSON.stringify(fits));
    // a draft that re-wraps when the input narrows (a phone turned, the panel becoming a sheet) grows again or scrolls,
    // never clipped
    await input.fill('two lines, '.repeat(12));
    const measure = () => input.evaluate((el) => ({ over: el.scrollHeight > el.clientHeight, scrolls: getComputedStyle(el).overflowY !== 'hidden', h: el.offsetHeight }));
    const wide = await measure();
    await page.setViewportSize({ width: 320, height });
    await wait(300);
    const narrow = await measure();
    await page.setViewportSize(size.viewport);
    await input.fill('');
    check(tag('a draft narrowed to 320 px grows or scrolls, never clipped'), (narrow.h > wide.h || narrow.scrolls) && (narrow.scrolls || !narrow.over), JSON.stringify({ wide, narrow }));

    // a burst of three quick messages gets one answer; the input never locks
    const before = await helpers.count();
    const burst = ['hello there', 'my parcel hasn’t come', `it’s ${ORDER}`];
    let locked = false;
    const watch = setInterval(async () => { if (!(await input.isEditable().catch(() => true))) locked = true; }, 100);
    for (const text of burst) { await input.fill(text); await input.press('Enter'); await wait(150); }
    await helpers.nth(before).waitFor({ timeout: 20_000 }).catch(() => {});
    await wait(4000); // time for a second answer, if the burst wrongly got one per message
    clearInterval(watch);
    check(tag('three messages show at once, as sent'), (await mine.allTextContents()).join('|') === burst.join('|'));
    const n = await answers(page, before);
    check(tag('the burst got one answer'), n === 1, `${n} answers`);
    // the machine-readable AI mark
    const marks = [await helpers.first().locator('.bubble').getAttribute('data-ai-generated'), await helpers.nth(before).locator('.bubble').getAttribute('data-ai-generated')];
    check(tag('the model’s answer carries data-ai-generated, the greeting doesn’t'), marks[0] === null && marks[1] === 'true', JSON.stringify(marks));
    check(tag('the input stayed enabled throughout'), !locked && (await input.isEditable()));
    const before2 = await helpers.count();
    await looks(page, tag('answered'));
    await shot(`${size.name}-2-answered`);

    // nothing of the conversation in the browser's storage
    const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
    check(tag('nothing of the conversation in localStorage or sessionStorage'), !burst.some((t) => stored.includes(t)) && stored === '[{},{}]', stored.slice(0, 120));

    // a reload shows the conversation again, from the server
    await page.reload();
    await openHelp();
    await mine.nth(2).waitFor({ timeout: 10_000 }).catch(() => {});
    check(tag('after a reload the conversation is back'), (await mine.allTextContents()).join('|') === burst.join('|') && (await helpers.count()) === before2,
      `${await mine.count()} of mine, ${await helpers.count()} of the helper's`);

    // the ⋯ menu and About, fitted and readable
    await $('.ch-menu').click();
    await looks(page, tag('the ⋯ menu'));
    await shot(`${size.name}-3-menu`);
    await $('[data-m="about"]').click();
    await looks(page, tag('About the helper'));
    await shot(`${size.name}-4-about`);
    await $('.ab-close').click();

    // the phone's keyboard (Chromium opens none, so we make the room one takes): Android shrinks the page itself
    // (shop.html asks for interactive-widget=resizes-content); iOS keeps the page and shrinks only the visual viewport,
    // scrolled, which widget.js follows (--vvh, --vvt): played by overriding visualViewport's height and offset
    if (size.isMobile) {
      await input.click();
      const band = () => page.evaluate(() => {
        const r = (s) => careChat().shadowRoot.querySelector(s).getBoundingClientRect();
        return { input: r('textarea'), send: r('.ch-send'), head: r('.ch-head') };
      });
      const inside = (b, top, bottom) => [b.input, b.send, b.head].every((r) => r.height > 0 && r.top >= top - 1 && r.bottom <= bottom + 1);
      await page.setViewportSize({ width, height: height - KEYBOARD_PX });
      await wait(400);
      let b = await band();
      check(tag('with the keyboard up (the page shrinks), the header, the input and Send stay above it'), inside(b, 0, height - KEYBOARD_PX), JSON.stringify(b));
      await shot(`${size.name}-5-keyboard`);
      await page.setViewportSize(size.viewport);
      await page.evaluate(([h, top]) => {
        Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => h });
        Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, get: () => top });
        visualViewport.dispatchEvent(new Event('resize'));
      }, [height - KEYBOARD_PX, 120]);
      await wait(400);
      b = await band();
      check(tag('with the keyboard up (iOS: the visual viewport shrinks and scrolls), they stay in view above it'), inside(b, 120, 120 + height - KEYBOARD_PX), JSON.stringify(b));
      await page.evaluate(() => { delete visualViewport.height; delete visualViewport.offsetTop; visualViewport.dispatchEvent(new Event('resize')); });
      await input.blur();
    }

    // "Delete this conversation" (a chat never linked: no box, it goes from the server too) empties it
    await $('.ch-menu').click();
    await $('[data-m="delete"]').click();
    await $('.ch-del .del-yes').click();
    await page.waitForFunction(() => !careChat().shadowRoot.querySelector('.ch-items .msg.me'), null, { timeout: 10_000 }).catch(() => {});
    await wait(500);
    const left = await $('.ch-items').textContent();
    check(tag('"Delete this conversation" empties it'), (await mine.count()) === 0 && !burst.some((t) => left.includes(t)), left.replace(/\s+/g, ' ').slice(0, 120));

    // the forgotten chat stays gone after a reload
    await page.reload(); await openHelp(); await wait(800);
    check(tag('and stays gone after a reload'), (await mine.count()) === 0);

    // every widget of the catalogue, a toast and a status line, in the plug-in's theme and then the blue one
    for (const theme of ['own', 'blue']) {
      if (theme === 'blue') { await page.reload(); await page.addStyleTag({ content: BLUE }); await openHelp(); await greeted(); }
      await page.route('**/__care/api/say', (r) => { failing++; r.abort(); }, { times: 1 }); // one message that doesn't go through: "Not sent. Try again"
      await input.fill('this one fails'); await input.press('Enter'); await wait(300);
      await w.inject({ t: 'wait', ids: [await $('.ch-items .msg.me').last().getAttribute('data-id')], on: true });
      await gallery(w);
      for (const [i, el] of (await $('.ch-items .msg').all()).entries()) if (i % 2 === 0 || size.name === 'phone') await el.screenshot({ path: join(shots, `${size.name}-${theme}-${String(i).padStart(2, '0')}.png`) }).catch(() => {});
      await w.inject({ t: 'toast', text: 'A copy of this chat is on its way to a•••@example.com.' });
      const m = await looks(page, tag(`${theme} theme, the whole catalogue, a toast`));
      if (theme === 'blue') {
        const stray = [...new Set(m.colours.filter((c) => OWN_COLOURS.includes(c)))];
        check(tag('the blue theme reaches every colour (none of the plug-in theme’s left)'), stray.length === 0, stray.join(' '));
      }
      await shot(`${size.name}-${theme}-6-catalogue`);
      await $('.ch-menu').click(); await $('[data-m="about"]').click();
      await looks(page, tag(`${theme} theme, About`));
      await page.keyboard.press('Escape');
    }
    await w.context.close();
  }

  // ---- the keyboard, on a laptop: Tab in visual order, the ⋯ menu's arrow keys, Escape back out to what opened it
  {
    const w = await newPage({ viewport: { width: 1180, height: 820 } });
    const { page, $, greeted } = w;
    await page.goto(shop.url);
    await page.focus(`header ${OPENER}`); await page.keyboard.press('Enter');
    await $('.chat').waitFor({ state: 'visible' }); await greeted(); await wait(700);
    const f0 = await page.evaluate(focused, OPENER);
    check('keyboard: opening puts the focus in the input (a mouse and keyboard)', f0?.tag === 'textarea', JSON.stringify(f0));
    await $('.ch-menu').focus();
    const order = [await page.evaluate(focused, OPENER)];
    for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); const f = await page.evaluate(focused, OPENER); if (!f?.inside) break; order.push(f); if (f.cls.includes('ch-send')) break; }
    const names = order.map((f) => f.m ?? f.cls.split(' ')[0] ?? f.tag);
    const visual = order.every((f, i) => !i || f.y > order[i - 1].y + 4 || (Math.abs(f.y - order[i - 1].y) <= 12 && f.x > order[i - 1].x));
    check('keyboard: Tab goes menu, close, the greeting’s choices, the input, Send, in visual order', names[0] === 'ch-menu' && names[1] === 'ch-close'
      && names.filter((x) => x === 'chip').length === 3 && order.at(-2).tag === 'textarea' && names.at(-1) === 'ch-send' && visual, names.join(' → '));
    // the ⋯ menu by keyboard: Enter opens it on its first item, arrows move (and wrap), Home/End, Escape closes it
    await $('.ch-menu').focus(); await page.keyboard.press('Enter'); await wait(100);
    const at = async () => (await page.evaluate(focused, OPENER))?.m;
    const seen = [await at()];
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'Home', 'End']) { await page.keyboard.press(key); seen.push(await at()); }
    const items = await $('.ch-pop [role="menuitem"]:not([hidden])').evaluateAll((els) => els.map((e) => e.dataset.m));
    check('keyboard: the ⋯ menu opens on its first item; arrows, Home and End move through it', seen.join(' ') === [items[0], items[1], items[2], items[1], items[0], items.at(-1), items[0], items.at(-1)].join(' '), seen.join(' '));
    await page.keyboard.press('Escape');
    check('keyboard: Escape closes the menu and gives the focus back to ⋯', (await $('.ch-pop').isHidden()) && (await page.evaluate(focused, OPENER))?.cls.includes('ch-menu')
      && (await $('.ch-menu').getAttribute('aria-expanded')) === 'false');
    await page.keyboard.press('Enter'); await wait(100); await page.keyboard.press('Enter'); await wait(300); // the first item: About
    check('keyboard: About opens with the focus on its button', (await $('.ch-about:not(.ch-del)').isVisible()) && (await page.evaluate(focused, OPENER))?.cls.includes('ab-close'));
    await page.keyboard.press('Escape');
    check('keyboard: Escape closes About, back to ⋯', (await $('.ch-about:not(.ch-del)').isHidden()) && (await page.evaluate(focused, OPENER))?.cls.includes('ch-menu'));
    await page.keyboard.press('Escape'); await wait(400);
    const back = await page.evaluate(focused, OPENER);
    check('keyboard: Escape again closes the chat, back to the Help link that opened it', (await $('.chat').isHidden()) && back?.opener && !back.inside, JSON.stringify(back));
    await w.context.close();
  }

  // ---- on a phone the sheet covers the page: Tab stays inside it
  {
    const w = await newPage({ viewport: SIZES[0].viewport, isMobile: true, hasTouch: true });
    const { page, $, openHelp, greeted } = w;
    await page.goto(shop.url); await openHelp(); await greeted();
    await $('.ch-send').focus(); await page.keyboard.press('Tab');
    const after = await page.evaluate(focused, OPENER);
    await page.keyboard.press('Shift+Tab');
    const before = await page.evaluate(focused, OPENER);
    check('phone: Tab from Send wraps to ⋯, Shift+Tab back to Send (focus stays in the sheet)', after?.cls.includes('ch-menu') && before?.cls.includes('ch-send'), `${after?.cls} / ${before?.cls}`);
    await w.context.close();
  }

  // ---- live regions: what changes gets read out, and each region is in the page before it changes (one that
  // appears together with its words is often not read at all)
  {
    const w = await newPage({ viewport: { width: 1180, height: 820 } });
    const { page, $, openHelp, greeted } = w;
    await page.goto(shop.url); await openHelp(); await greeted();
    const live = await page.evaluate(() => {
      const r = careChat().shadowRoot, q = (s) => r.querySelector(s);
      const a = (s, k) => q(s)?.getAttribute(k);
      const rendered = (s) => getComputedStyle(q(s)).display !== 'none' && !q(s).hidden;
      return { log: a('.ch-log', 'role') === 'log' && a('.ch-log', 'aria-live') === 'polite', status: a('.ch-status', 'aria-live') === 'polite',
        line: a('.ch-line', 'role') === 'status' && rendered('.ch-line'), toast: a('.ch-toast', 'role') === 'status' && rendered('.ch-toast') };
    });
    check('live: the log is role=log, polite', live.log);
    check('live: the header’s status is polite (offline, back)', live.status);
    check('live: the working line is a status, in the page before it shows', live.line);
    check('live: toasts are a status, in the page before one shows', live.toast);
    await w.context.close();
  }

  // ---- reduced motion: no animation runs and nothing scrolls smoothly
  {
    const w = await newPage({ viewport: SIZES[0].viewport, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    const { page, $, openHelp, greeted, inject } = w;
    await page.addInitScript(() => { const go = Element.prototype.scrollTo; window.__smooth = 0; Element.prototype.scrollTo = function (o, ...rest) { if (o?.behavior === 'smooth') window.__smooth++; return go.call(this, o, ...rest); }; });
    await page.goto(shop.url); await openHelp(); await greeted();
    const running = () => page.evaluate(() => careChat().shadowRoot.getAnimations().map((a) => a.animationName ?? 'transition'));
    const moving = [...await running()];
    await $('textarea').fill('hello'); await $('textarea').press('Enter');
    await inject({ t: 'typing', on: true }); await inject({ t: 'status', online: false }); await inject({ t: 'toast', text: 'A copy is on its way.' });
    await $('.ch-menu').click();
    moving.push(...await running());
    check('reduced motion: no animation runs (opening, a message, the working line, offline, a toast, the menu)', moving.length === 0, moving.join(' '));
    check('reduced motion: nothing scrolls smoothly', (await page.evaluate(() => window.__smooth)) === 0);
    await w.context.close();
  }

  // ---- the outage: the model goes down; the message with its link (with `chatFirst`, only if `linkFor` has 'service'),
  // the amber header, the message waiting; then the helper's back
  {
    const w = await newPage({ viewport: SIZES[0].viewport, isMobile: true, hasTouch: true });
    const { page, $, shot, openHelp, greeted } = w;
    await page.goto(shop.url); await openHelp(); await greeted();
    await shop.fake({ fail: true });
    await $('textarea').fill(demo.typed.question); await $('textarea').press('Enter');
    const link = $('.ch-items .msg.helper .bubble .wg-outage');
    await link.waitFor({ state: 'attached', timeout: 30_000 }).catch(() => {});
    const out = await link.evaluate((el) => ({ links: [...el.querySelectorAll('button.link')].map((b) => b.textContent.trim()), chips: el.closest('.msg').querySelectorAll('.chip').length,
      text: el.closest('.bubble').textContent, height: el.getBoundingClientRect().height })).catch(() => ({ links: [], chips: -1, text: '', height: -1 }));
    if (company.settings.chatFirst && !company.settings.linkFor.includes('service')) {
      check('outage: the message offers no person while it waits for the helper: no link, card or chips', out.links.length === 0 && out.chips === 0 && out.text.length > 0, JSON.stringify(out));
      check('outage: no empty raised box below the message', out.height === 0, JSON.stringify(out));
    } else check('outage: the message ends in one small "Email a person" link, no card or chips', out.links.join() === said('email_person', 'en') && out.chips === 0, JSON.stringify(out));
    check('outage: the message says plainly what’s wrong', out.text.includes(said('down', 'en')));
    check('outage: the header turns amber, saying it’s offline', (await $('.chat').evaluate((el) => el.classList.contains('offline'))) && (await $('.ch-status').textContent()) === words('en')('status_off'));
    await $('.ch-items .msg.me .waiting').waitFor({ timeout: 5000 }).catch(() => {});
    check('outage: the message is marked waiting', (await $('.ch-items .msg.me .waiting').count()) === 1);
    check('outage: the input stays open', await $('textarea').isEditable());
    await looks(page, 'outage');
    await shot('outage-card');
    await shop.fake();
    const back = said('back', 'en');
    await page.waitForFunction((t) => [...careChat().shadowRoot.querySelectorAll('.msg.helper .bubble')].some((b) => b.textContent.includes(t)), back, { timeout: 30_000 }).catch(() => {});
    await wait(500);
    check('outage: the helper comes back: "I’m back", the header green again', (await $('.ch-items').textContent()).includes(back)
      && !(await $('.chat').evaluate((el) => el.classList.contains('offline'))) && (await $('.ch-items .msg.me .waiting').count()) === 0);
    await shot('outage-back');
    await w.context.close();
  }

  // ---- a stop (a request the provider refuses): no outage. The header has its stop words, in grey, not amber, it
  // fits a 320 px phone in every language, and nothing is marked waiting
  {
    const w = await newPage({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });
    const { page, $, shot, openHelp, greeted } = w;
    await page.goto(shop.url); await openHelp(); await greeted();
    await shop.fake({ next: [[{ fail: 400 }], [{ fail: 400 }]] }); // the draft and its one retry
    await $('textarea').fill(demo.typed.question); await $('textarea').press('Enter');
    await $('.wg-outage').waitFor({ timeout: 30_000 }).catch(() => {});
    await $('.chat.stopped').waitFor({ timeout: 5000 }).catch(() => {});
    const head = () => page.evaluate((tag) => { const r = document.querySelector(tag).shadowRoot, s = r.querySelector('.ch-status'), c = r.querySelector('.chat').classList;
      return { text: s.textContent, fits: s.scrollWidth <= s.clientWidth, stopped: c.contains('stopped'), offline: c.contains('offline') }; }, TAG);
    const stop = await head();
    check('stop: the header is stopped, not offline, in its stop words', stop.stopped && !stop.offline && stop.text === words('en')('status_stop'), JSON.stringify(stop));
    check('stop: the message isn’t marked waiting', (await $('.ch-items .msg.me .waiting').count()) === 0);
    for (const lang of ['en', ...Object.keys(demo.languages)]) {
      await page.evaluate(([tag, l]) => document.querySelector(tag).widget.setLang(l), [TAG, lang]);
      const h = await head();
      check(`stop: ${lang}: the header’s words fit at 320 px`, h.text === words(lang)('status_stop') && h.fits, JSON.stringify(h));
    }
    await page.evaluate((tag) => document.querySelector(tag).widget.setLang('en'), TAG);
    await looks(page, 'stop');
    await shot('stop-320');
    const asked = () => page.waitForFunction(([tag, t]) => [...document.querySelector(tag).shadowRoot.querySelectorAll('.msg.helper .bubble')].some((b) => b.textContent.includes(t)), [TAG, said('person_address', 'en')], { timeout: 10_000 }).catch(() => {});
    const askedLast = async () => (await $('.ch-items .msg.helper').last().textContent()).includes(said('person_address', 'en'));
    if (!company.settings.chatFirst || company.settings.linkFor.includes('stop')) {
      // a stop's message ends in "Email a person", and it opens the way to a person (asked for an address: none known yet);
      // tapped 9 px below its words, where only its ::after reaches: the 44 px target is real
      const box = await $('.ch-items .bubble .wg-outage button.link').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height + 9);
      await asked();
      check('stop: the message’s "Email a person" link opens the way to a person', (await askedLast()) && (await $('.ch-items .bubble .wg-outage button.link').isDisabled()));
    } else {
      // without 'stop' in `linkFor`, the message offers no person, and the ⋯ menu's "Email a person" opens the way to one
      // at once, with no case for trying here
      const out = await $('.ch-items .msg.helper .bubble .wg-outage').evaluate((el) => ({ links: el.querySelectorAll('button.link').length, chips: el.closest('.msg').querySelectorAll('.chip').length,
        text: el.closest('.bubble').textContent }));
      check('stop: the message offers no person: no link, card or chips', out.links === 0 && out.chips === 0 && [said('stopped', 'en'), said('stopped_today', 'en')].includes(out.text.trim()), JSON.stringify(out));
      await $('.ch-menu').click();
      await $('[data-m="person"]').click();
      await asked();
      check('stop: the ⋯ menu’s "Email a person" opens the way to a person', await askedLast());
    }
    await shop.fake();
    await w.context.close();
  }

  // ---- "Did this help?": after an answer from the knowledge and a pause, two buttons; the tap writes no words of the
  // customer's into the chat, the card says thanks, and "Not really" gets its one line
  {
    const w = await newPage({ viewport: SIZES[0].viewport, isMobile: true, hasTouch: true });
    const { page, $, shot, openHelp, greeted } = w;
    await page.goto(shop.url); await openHelp(); await greeted();
    await shop.fake({ next: [[{ text: 'Yes, we ship to Belgium: 3 to 5 working days.' }, { tool: 'answered', input: { from: 'knowledge' } }]] });
    await $('textarea').fill('do you ship to Belgium?'); await $('textarea').press('Enter');
    const card = $('.wg-helped');
    await card.waitFor({ timeout: 20_000 }).catch(() => {});
    const labels = (await card.locator('.chip').allTextContents()).map((s) => s.trim());
    check('helped: "Did this help?" after the answer, with Yes and Not really', labels.join(' / ') === [said('helped_yes', 'en'), said('helped_not', 'en')].join(' / ')
      && (await $('.ch-items .msg.helper').last().textContent()).includes(said('helped_q', 'en')), labels.join(' / '));
    await looks(page, 'helped');
    await shot('helped');
    const mine = await $('.ch-items .msg.me').count();
    await card.locator('.chip').nth(1).click();
    const line = said('helped_no', 'en');
    await page.waitForFunction((t) => [...careChat().shadowRoot.querySelectorAll('.msg.helper .bubble')].some((b) => b.textContent.includes(t)), line, { timeout: 10_000 }).catch(() => {});
    check('helped: the tap adds no words of the customer’s, and the card says thanks', (await $('.ch-items .msg.me').count()) === mine
      && (await $('.wg-helped').textContent()).includes(words('en')('helped_thanks')));
    check('helped: "Not really" gets its one line', (await $('.ch-items').textContent()).includes(line));
    await looks(page, 'helped, answered');
    await shot('helped-not-really');
    await w.context.close();
  }

  // ---- "Delete this conversation": asks once, empties the chat, and it stays empty after a reload
  {
    const w = await newPage({ viewport: { width: 1180, height: 820 } });
    const { page, $, shot, openHelp, greeted } = w;
    await page.goto(shop.url); await openHelp(); await greeted();
    const helpers = $('.ch-items .msg.helper'), before = await helpers.count();
    await $('textarea').fill('please delete this later'); await $('textarea').press('Enter');
    await helpers.nth(before).waitFor({ timeout: 20_000 }).catch(() => {});
    await $('.ch-menu').click();
    await $('[data-m="delete"]').click().catch(() => {});
    const ask = $('.ch-del');
    check('delete: it asks first, the focus on "Keep it"', (await ask.isVisible()) && (await page.evaluate(focused, OPENER))?.cls.includes('del-no'));
    check('delete: a chat never linked says it goes from our servers too, no box', (await ask.locator('#del-text').textContent()) === words('en')('del_text') && !(await ask.locator('.del-box').isVisible()));
    await looks(page, 'delete: the question');
    await shot('delete-ask');
    await ask.locator('.del-yes').click().catch(() => {});
    await page.waitForFunction(() => !careChat().shadowRoot.querySelector('.ch-items .msg.me'), null, { timeout: 10_000 }).catch(() => {});
    await wait(800);
    check('delete: the chat empties, a fresh greeting, and a toast says so', (await $('.ch-items .msg.me').count()) === 0 && (await helpers.count()) > 0
      && (await $('.ch-toast').textContent()).includes(words('en')('del_done')));
    await shot('delete-done');
    await page.reload(); await openHelp(); await greeted(); await wait(500);
    check('delete: and stays empty after a reload', (await $('.ch-items .msg.me').count()) === 0 && !(await $('.ch-items').textContent()).includes('please delete'));
    await w.context.close();
  }

  // ---- the delete step in a chat linked to an email (hello's may.kept, played here): a ticked box for our copy;
  // unticked, only this device forgets it
  {
    const w = await newPage({ viewport: SIZES[0].viewport, isMobile: true, hasTouch: true });
    const { page, $, shot, openHelp, greeted } = w;
    const posts = [];
    page.on('request', (r) => { const m = r.url().match(/\/__care\/api\/(forget|delete)$/); if (m) posts.push(m[1]); });
    await page.route('**/__care/api/hello', async (r) => {
      const res = await r.fetch(), body = await res.json();
      await r.fulfill({ response: res, json: { ...body, may: { delete: true, kept: true } } });
    });
    await page.goto(shop.url); await openHelp(); await greeted();
    await $('.ch-menu').click();
    await $('[data-m="delete"]').click();
    const ask = $('.ch-del'), box = ask.locator('.del-box input');
    await wait(500); // the panel's rise, over
    const said = await ask.locator('#del-text').textContent(), ticked = await box.isChecked(), target = await box.boundingBox();
    check('delete, linked: "It goes from this device", and a ticked box for our servers, the whole row its target',
      said === words('en')('del_here') && ticked && target?.height >= 44 && target?.width >= 200, JSON.stringify({ said, ticked, target }));
    await looks(page, 'delete, linked: the question');
    await shot('delete-linked-ask');
    await ask.locator('.del-box label').click();
    await ask.locator('.del-yes').click();
    await wait(800);
    check('delete, linked, unticked: only this device forgets it, and a toast says so',
      posts.join() === 'forget' && (await $('.ch-toast').textContent()).includes(words('en')('del_here_done')), posts.join());
    await w.context.close();
  }

  // ---- the health-detail check: a message with a health term is held on the device under its card,
  // nothing sent; "Edit my message" puts it back; "Send it to a person instead" sends it marked for a person. And care's
  // own card, for a message that reached it without the widget's check
  {
    const w = await newPage({ viewport: SIZES[0].viewport, isMobile: true, hasTouch: true });
    const { page, $, shot, openHelp, greeted } = w;
    const says = [];
    page.on('request', (r) => { if (r.url().endsWith('/__care/api/say')) says.push(r.postDataJSON()); });
    await page.goto(shop.url); await openHelp(); await greeted();
    const input = $('textarea'), card = $('.wg-health').last(), helpers = $('.ch-items .msg.helper');
    const text = demo.typed.health;
    await input.fill(text); await input.press('Enter');
    await card.waitFor({ timeout: 5000 }).catch(() => {});
    await wait(500);
    check('health: a message with a health term is held on the device: nothing sent', says.length === 0 && (await $('.ch-items .msg.me .held').count()) === 1, `${says.length} sent`);
    const chips = card.locator('.chip'), boxes = await chips.evaluateAll((els) => els.map((e) => [e.getBoundingClientRect().width, e.getBoundingClientRect().height, e.className]));
    check('health: the health-detail card, its two buttons of equal weight (same size, neither primary)', (await helpers.last().textContent()).includes(words('en')('health_card').replace(/\*\*/g, ''))
      && boxes.length === 2 && Math.abs(boxes[0][0] - boxes[1][0]) < 1 && Math.abs(boxes[0][1] - boxes[1][1]) < 1 && !boxes.some((b) => b[2].includes('primary')), JSON.stringify(boxes));
    await looks(page, 'health: the card');
    await shot('health-card');
    await chips.first().click(); await wait(300);
    check('health: "Edit my message" puts the words back in the input; the card and the message go', (await input.inputValue()) === text
      && (await $('.wg-health').count()) === 0 && (await $('.ch-items .msg.me').count()) === 0 && says.length === 0);
    await input.press('Enter');
    await card.waitFor({ timeout: 5000 }).catch(() => {});
    const asked = helpers.count();
    await card.locator('.chip').nth(1).click();
    await page.waitForRequest((r) => r.url().endsWith('/__care/api/say'), { timeout: 5000 }).catch(() => {});
    check('health: "Send it to a person instead" sends it, marked for a person', says.length === 1 && says[0].text === text && says[0].answer?.health === 'person', JSON.stringify(says));
    await helpers.nth(await asked).waitFor({ timeout: 10_000 }).catch(() => {});
    check('health: care asks where the person should reply', (await helpers.last().textContent()).includes(said('person_address', 'en')));
    await input.fill(demo.customer.email); await input.press('Enter');
    await page.waitForFunction(() => careChat().shadowRoot.querySelector('.ch-items').textContent.includes('Reference H-'), null, { timeout: 10_000 }).catch(() => {});
    check('health: and it goes to a person, with a reference', (await $('.ch-items').textContent()).includes('Reference H-'));
    await shot('health-sent');
    // care's own card: a message that reached care without the widget's check (a script, an outdated page)
    const before = await $('.wg-health').count();
    await page.evaluate(() => fetch('/__care/api/say', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'script1', text: 'I was in hospital when it came' }) }));
    await $('.wg-health').nth(before).waitFor({ timeout: 5000 }).catch(() => {});
    check('health: care holds a message that skipped the widget, under the same card', (await $('.wg-health').count()) === before + 1);
    await $('.wg-health').nth(before).locator('.chip').first().click();
    await page.waitForFunction(() => careChat().shadowRoot.querySelector('textarea').value.includes('hospital'), null, { timeout: 5000 }).catch(() => {});
    check('health: and its "Edit my message" gives the words back', (await input.inputValue()) === 'I was in hospital when it came');
    await w.context.close();
  }

  // ---- languages: a page in each of the plug-in's other languages (its <html lang>, as an app sets it; the browser's
  // too) gets the greeting, the menu, About and the input in its language
  for (const [lang, sample] of Object.entries(demo.languages)) {
    const W = words(lang), locale = sample.locale ?? lang;
    const w = await newPage({ viewport: { width: 1180, height: 820 }, locale });
    const { page, $, shot, openHelp, greeted } = w;
    // a page shipped as <html lang="en"> whose script sets its language after the widget loaded: the launcher and the
    // panel follow it before anything is opened
    await page.goto(`${shop.url}/plain`); await $('.launcher').waitFor({ timeout: 5000 }).catch(() => {});
    await page.evaluate((l) => { document.documentElement.lang = l; }, lang); await wait(100);
    const before = await page.evaluate(() => { const r = careChat().shadowRoot, l = r.querySelector('.launcher');
      return [l.getAttribute('aria-label'), l.querySelector('.l-label').textContent, r.querySelector('.chat').getAttribute('aria-label'), r.querySelector('textarea').placeholder]; });
    check(`${lang}: <html lang> set after the widget loaded: the launcher and the panel follow, unopened`,
      before.join('|') === [W('launcher'), W('help'), W('panel'), W('placeholder')].join('|'), before.join(' / '));
    await page.goto(shop.url); await page.evaluate((l) => { document.documentElement.lang = l; }, lang);
    await openHelp(); await greeted(); await wait(300);
    check(`${lang}: the greeting`, (await $('.ch-items .msg.helper').first().textContent()).includes(said('hi', lang, { app: demo.app.name })));
    await $('.ch-menu').click();
    const menu = (await $('.ch-pop [role="menuitem"]:not([hidden])').allTextContents()).map((s) => s.trim());
    check(`${lang}: the ⋯ menu`, menu.join('|') === [W('m_about'), W('m_person'), W('m_copy'), W('m_delete')].join('|'), menu.join(' | '));
    await looks(page, `${lang}: the ⋯ menu`);
    await $('[data-m="about"]').click();
    const about = await $('.ch-about:not(.ch-del)').textContent();
    check(`${lang}: About`, about.includes(W('about')) && about.includes(W('ab_2')) && (!sample.has || about.includes(sample.has)), about.slice(0, 100));
    await looks(page, `${lang}: About`);
    await shot(`${lang}-about`);
    await page.keyboard.press('Escape');
    const field = await $('textarea').evaluate((el) => [el.placeholder, el.getAttribute('aria-label')]);
    check(`${lang}: the input’s labels`, field[0] === W('placeholder') && field[1] === W('input') && (await $('.ch-send').getAttribute('aria-label')) === W('send'), field.join(' / '));
    const everything = await page.evaluate(() => { const r = careChat().shadowRoot; return r.textContent + [...r.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.value)).join(' '); });
    if (sample.never) check(`${lang}: nothing in the widget says ${sample.never}`, !sample.never.test(everything));
    await $('textarea').fill(sample.health); await $('textarea').press('Enter');
    const health = $('.ch-items .msg.helper:has(.wg-health)');
    await health.waitFor({ timeout: 5000 }).catch(() => {});
    check(`${lang}: the health-detail card, held on the device`, (await health.textContent().catch(() => '')).includes(W('health_card').replace(/\*\*/g, ''))
      && (await health.locator('.chip').allTextContents()).join('|') === [W('health_edit'), W('health_person')].join('|'));
    await shot(`${lang}-greeting`);
    await w.context.close();
  }

  // ---- a tap, and the ⋯ menu's "Email a person" to the email card (with `chatFirst` and 'menu' in `caseFor`, the chat's
  // case for trying here first); the launcher; a signed link
  {
    const w = await newPage({ viewport: { width: 1180, height: 820 } });
    const { page, $, shot, openHelp, greeted } = w;
    const chat = $('.chat'), input = $('textarea'), helpers = $('.ch-items .msg.helper');
    await page.goto(shop.url); await openHelp(); await greeted();
    const chip = $('.wg-choice .chip').first();
    const tapped = page.waitForRequest((r) => r.url().endsWith('/__care/api/say'), { timeout: 5000 }).catch(() => null);
    const tapCount = await helpers.count();
    await chip.click();
    const tap = (await tapped)?.postDataJSON();
    check('a tap sends the widget and action ids', !!tap?.answer?.widget && !!tap?.answer?.action, JSON.stringify(tap));
    await helpers.nth(tapCount).waitFor({ timeout: 20_000 }).catch(() => {});
    check('the tap is marked and answered', (await $('.wg-choice.done .chip.picked').count()) === 1 && (await helpers.count()) > tapCount);
    await $('.ch-menu').click();
    await $('[data-m="person"]').click();
    if (company.settings.chatFirst && company.settings.caseFor.includes('menu')) {
      const pitch = $('.wg-choice').last();
      await pitch.locator('.chip', { hasText: said('email_person', 'en') }).waitFor({ timeout: 10_000 }).catch(() => {});
      check('"Email a person" first says the chat can probably help here, with "Let’s try here" beside it',
        (await helpers.last().textContent()).includes(said('person_case', 'en').split(':')[0])
          && (await pitch.locator('.chip').allTextContents()).join('|') === [said('try_here', 'en'), said('email_person', 'en')].join('|'));
      await pitch.locator('.chip', { hasText: said('email_person', 'en') }).click().catch(() => {});
    }
    await wait(1500);
    await input.fill(demo.customer.email); await input.press('Enter');
    const card = $('.wg-summary');
    await card.waitFor({ timeout: 20_000 }).catch(() => {});
    check('"Email a person" shows the email card', await card.isVisible());
    await looks(page, 'the email card');
    await card.scrollIntoViewIfNeeded().catch(() => {});
    await shot('email-card');
    const sentCount = await helpers.count();
    await card.locator('textarea').fill(demo.typed.note).catch(() => {});
    await card.locator('.chip.primary').click().catch(() => {});
    await helpers.nth(sentCount).waitFor({ timeout: 20_000 }).catch(() => {});
    check('and Send sends it', (await $('.wg-summary.done').count()) === 1 && (await helpers.count()) > sentCount);
    await shot('email-sent');

    // a page without its own Help link gets the launcher, and it opens the chat, unless the plug-in has none
    await w.context.clearCookies();
    await page.goto(`${shop.url}/plain`);
    const launcher = $('.launcher');
    if (plugin.launcher === false) {
      // the widget decides on the launcher once its styles have loaded
      const styled = () => [...globalThis.careChat().shadowRoot.querySelectorAll('link')].every((link) => link.sheet);
      await page.waitForFunction(styled, null, { timeout: 5000 }).catch(() => {});
      check('a plug-in without a launcher: none on a page without a Help link', await launcher.isHidden());
    } else {
      await launcher.waitFor({ timeout: 5000 }).catch(() => {});
      check('a page without a Help link gets the launcher', await launcher.isVisible());
      await looks(page, 'the launcher');
      await launcher.click().catch(() => {});
      check('the launcher opens the chat', await chat.isVisible());
      await shot('launcher-open');
    }

    // a signed link in the fragment: the chat opens, the token goes by POST, the fragment leaves the address bar; the
    // stream opens only once the link has answered (the link gives the session a new id: a stream opened before it is refused)
    const order = [], mark = (r) => { if (r.url().endsWith('/__care/api/stream')) order.push('stream'); };
    const answered = (r) => { if (r.url().endsWith('/__care/api/link')) order.push('link answered'); };
    page.on('request', mark); page.on('response', answered);
    const redeemed = page.waitForRequest((r) => r.url().endsWith('/__care/api/link') && r.method() === 'POST', { timeout: 10_000 }).catch(() => null);
    await page.goto(`${shop.url}/#${NAMES.link}=test-token.123`);
    const link = await redeemed;
    await wait(800);
    page.off('request', mark); page.off('response', answered);
    check('a signed link is redeemed by POST', link?.postDataJSON()?.token === 'test-token.123', link?.postData() ?? 'no request');
    check('and its fragment is cleared', !page.url().includes('#'), page.url());
    check('and the chat is open', await chat.isVisible());
    check('and the stream opens after the link answered', order[0] === 'link answered' && order.includes('stream'), order.join(' → '));

    // a POST refused with 401 { retry: true } (another POST of the page was giving the session a new id) is tried once
    // more before the widget says "Not sent"
    let refused = 0;
    const quiet = errors.length; // the refusal faked here prints its own 401 in the console: not one of ours
    await page.route('**/__care/api/say', (r) => (refused++ ? r.continue() : r.fulfill({ status: 401, contentType: 'application/json', body: '{"retry":true}' })));
    const says = [];
    page.on('request', (r) => { if (r.url().endsWith('/__care/api/say')) says.push(r); });
    await input.fill('is anyone there?'); await input.press('Enter');
    await wait(1500);
    check('a 401 with retry is tried once more, and the message isn\'t marked "Not sent"', says.length === 2 && (await $('.ch-items .msg.me .link').count()) === 0, `${says.length} POSTs`);
    await page.unroute('**/__care/api/say');
    errors.splice(quiet, errors.length - quiet, ...errors.slice(quiet).filter((e) => !/status of 401/.test(e)));
    await w.context.close();
  }

  // ---- diagnostics
  // A page opened with ?order=…&t=…#t=… whose script throws an error naming an email and a card
  // number, makes a failed request with a query and holds a form with values in it. The model offers the consent card;
  // from the card appearing through "See what we'd send" and its preview, no request of any kind; "Send it" makes one
  // POST, and none of those values is in it; what's sent is the picture that was shown, without the chat. Its own
  // browser context: the page's error is on purpose, so it stays out of the console-error check below.
  const SECRETS = [ORDER, 's3cret-token', 'frag-token', demo.customer.email, '4242 4242 4242 4242', '4242424242424242', ...demo.secrets];
  for (const size of [{ name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
    { name: 'laptop', viewport: { width: 1280, height: 800 } }]) {
    const tag = (s) => `diagnostics, ${size.name}: ${s}`;
    const context = await browser.newContext(size);
    await context.addInitScript(chatFinder, TAG);
    const page = await context.newPage();
    const requests = [];
    page.on('request', (r) => { if (!/^(data|blob):/.test(r.url())) requests.push(`${r.method()} ${r.url()}`); });
    const $ = (s) => page.locator(`${TAG} ${s}`);
    const shot = (name) => page.screenshot({ path: join(shots, `diagnostics-${size.name}-${name}.png`) });
    await page.goto(`${shop.url}/order?order=${ORDER}&t=s3cret-token#t=frag-token`);
    await page.locator(`header ${OPENER}`).click(); await $('.chat').waitFor({ state: 'visible' }); await wait(700);
    await $('.ch-items .msg.helper').first().waitFor({ timeout: 10_000 }).catch(() => {});
    await shop.fake({ next: [[{ text: 'Sorry, that page shouldn’t do that.' }, { tool: 'offer_snapshot', input: { problem: 'Saving a new delivery address on the order page fails with an error.' } }]] });
    await $('textarea').fill('The address form on my order page gives an error'); await $('textarea').press('Enter');
    const card = $('.wg-consent');
    await card.waitFor({ timeout: 20_000 }).catch(() => {});
    check(tag('the model’s tool brings up the consent card'), await card.isVisible());
    const [see, send] = await card.locator('.chips .chip').all();
    const buttons = await card.locator('.chips .chip').evaluateAll((els) => els.map((e) => { const s = getComputedStyle(e), r = e.getBoundingClientRect();
      return [Math.round(r.width), Math.round(r.height), s.backgroundColor, s.color, s.borderColor, s.fontWeight, s.fontSize].join(' '); }));
    check(tag('three buttons of equal weight (same size, colour and style; none primary)'), buttons.length === 3 && new Set(buttons).size === 1 && !(await card.locator('.chip.primary').count()), buttons.join(' | '));
    await wait(600);
    await shot('1-card');
    const from = requests.length;
    await see.click();
    const img = card.locator('.peek img.snap');
    await img.waitFor({ timeout: 15_000 }).catch(() => {});
    await page.waitForFunction(() => careChat().shadowRoot.querySelector('.wg-consent .peek img.snap')?.complete, null, { timeout: 5000 }).catch(() => {});
    await wait(500);
    const log = (await card.locator('.peek pre').textContent().catch(() => '')) ?? '';
    check(tag('the preview shows the picture and the log'), (await img.isVisible()) && /error/.test(log) && /request GET \/api\/orders\/:id 404/.test(log), log.slice(0, 200));
    check(tag('the log shows none of the page’s secrets'), !SECRETS.some((s) => log.includes(s)), log.slice(0, 300));
    await card.locator('.peek').scrollIntoViewIfNeeded().catch(() => {});
    await shot('2-preview');
    await looks(page, tag('the preview open'));
    check(tag('no request of any kind from the card appearing through the preview'), requests.length === from, requests.slice(from).join(' '));
    const shownSrc = await img.getAttribute('src');
    const posted = page.waitForRequest((r) => r.url().endsWith('/__care/api/diagnostics'), { timeout: 15_000 }).catch(() => null);
    const before = requests.length;
    await send.click();
    const req = await posted;
    await page.waitForResponse((r) => r.url().endsWith('/__care/api/diagnostics'), { timeout: 15_000 }).catch(() => null);
    await card.locator('.chip.picked').waitFor({ timeout: 5000 }).catch(() => {});
    await $('.ch-items .msg.helper .bubble').filter({ hasText: 'Sent, thank you' }).waitFor({ timeout: 10_000 }).catch(() => {});
    check(tag('“Send it” makes one request: one POST to the diagnostics route'), requests.length - before === 1 && req?.method() === 'POST', requests.slice(before).join(' '));
    const body = req?.postData() ?? '';
    const sent = (() => { try { return JSON.parse(body); } catch { return null; } })();
    check(tag('none of the order, the tokens, the email, the card number or the form’s values in the POST'), !!sent && !SECRETS.some((s) => body.includes(s)), SECRETS.filter((s) => body.includes(s)).join(', '));
    check(tag('and it isn’t empty: the error and the failed request, redacted'), !!sent && JSON.stringify(sent.bundle.events).includes('for [email], card [number]')
      && sent.bundle.events.some((e) => e.text === 'GET /api/orders/:id 404') && sent.bundle.events.some((e) => e.text === 'address_save_failed step=address ok=false')
      && sent.bundle.page.path === '/order', JSON.stringify(sent?.bundle?.events ?? []).slice(0, 300));
    check(tag('what’s sent is exactly the picture that was shown'), !!sent && sent.bundle.picture === shownSrc && /^data:image\/jpeg;base64,/.test(shownSrc ?? ''));
    check(tag('the bundle stays well under 256 KB'), body.length < 230_000, `${body.length} bytes`);
    // inside an inline SVG too: a [data-no-snapshot] shape and one the page's CSS hides aren't drawn; the third one is
    const marks = !sent?.bundle?.picture ? null : await page.evaluate(async (u) => {
      const r = document.getElementById('marks').getBoundingClientRect(), i = new Image(); i.src = u; await i.decode();
      const c = Object.assign(document.createElement('canvas'), { width: i.width, height: i.height }), x = c.getContext('2d'); x.drawImage(i, 0, 0);
      const k = i.width / document.documentElement.clientWidth;
      return [12, 36, 60].map((dx) => Array.from(x.getImageData(Math.round((r.left + dx) * k), Math.round((r.top + 12) * k), 1, 1).data.slice(0, 3)));
    }, sent.bundle.picture);
    const magenta = ([r, g, b]) => r > 180 && g < 110 && b > 180, green = ([r, g, b]) => g > 120 && r < 90 && b < 90;
    check(tag('an SVG’s [data-no-snapshot] and hidden shapes stay out of the picture, its visible one is in'),
      !!marks && !magenta(marks[0]) && !magenta(marks[1]) && green(marks[2]), JSON.stringify(marks));
    if (sent?.bundle?.picture) await writeFile(join(shots, `diagnostics-${size.name}-picture.jpg`), Buffer.from(sent.bundle.picture.split(',')[1], 'base64'));
    check(tag('the card is answered and the reference said'), (await card.locator('.chip.picked').count()) === 1 && (await $('.ch-items .msg.helper .bubble').filter({ hasText: /reference H-\d+/ }).count()) === 1);
    await wait(800); // past the smooth scroll
    await shot('3-sent');
    await looks(page, tag('sent'));
    await context.close();
  }

  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' / '));
  check('no request to any other origin', elsewhere.length === 0, elsewhere.slice(0, 3).join(' '));
} finally {
  await browser.close();
  await shop.close();
  await rm(process.env.DATA_DIR, { recursive: true, force: true });
}
console.log(`screenshots: ${shots}`);
console.log(fails.length ? `${fails.length} failed` : 'all passed');
process.exit(fails.length ? 1 : 0);

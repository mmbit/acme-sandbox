// book-check.mjs's stories of a page torn off at its spine and shared, and of the paper's feel (shell/ink/booktear.js,
// bookshare.js, bookpaper.js), on a desktop with the played store. A press at the page's right edge, where the spine
// is, drawn to the left with a finger, the Pencil and a mouse tears a copy off: Submit, PDF and PNG show over the
// paper while the controls' islands make way, the page in hand torn out at the spine while the book's stays whole. Let
// go on PNG the page's picture downloads, named for its title and day, and no share sheet opens; on PDF a one-page
// PDF; let go anywhere else it flies back and nothing goes, nothing drawn where it was pressed (Submit: send.mjs).
// The bar's dots menu's Tear off and send opens the same three as a menu, its keys going round it and Escape putting
// it away, back on the dots. Moved down the spine it's the page's own (the Pencil draws there); pressed under the
// status bar's blur or on the tools, nothing tears (on an iPad mini upright). With a call on, the page carried onto the
// call's window, a picture file dropped there, and a paste once the board pressed in it all go to Juno, the window lit
// as they come, and the book takes none; a picture taped on the page, picked with Select and carried onto the window
// or its bubble, goes too, and stays taped where it was. Things deleted crumple over the paper, already gone
// underneath: the store has them gone at once, a press goes through the crumple, and it falls straight down past the
// screen's foot within two seconds.
// (the gestures and the presses that aren't a tear: tearing.mjs; torn where a hand finds it: tearhand.mjs; a long
// page's: sharelong.mjs.)
import assert from 'node:assert/strict';
import { playLine } from './call.mjs';
import { freePage, line, paperBox, pick, savedWhere, tool } from './mouse.mjs';
import { DESKTOP, QUIET_MS, crumpled, fellAway, until } from './kit.mjs';
import { dragTo, notATearStory, spineOf, targetsShown, tearOffMenu } from './tearing.mjs';
import { tearHandStories } from './tearhand.mjs';
import { watchedPage } from './start.mjs';

// longer than a native drag's light lasts (calldrop.js LIT_MS, 300 ms), so a light that goes out is caught
const HELD_STILL_MS = 650;

// c: book-check.mjs's { hqIn, base, store, pages, shot, settled, noErrorsIn, SNIP }
export function shareStories(c) {
  return {
    "a page torn off at its spine onto PNG and PDF with a finger, a mouse and the Pencil; the dots' Tear off and send, the same as a menu; onto a call's window":
      browser => shareStory(browser, c),
    'a press moved down the spine, under the blur, at its top corner or on the tools is never a tear': browser =>
      notATearStory(browser, c),
    ...tearHandStories(c),
    'things deleted crumple over the paper, gone at once underneath, never in the way': browser =>
      crumpleStory(browser, c),
  };
}

// ---- the stories

async function shareStory(browser, c) {
  const free = tapedPage(c);
  // (its title the Notebook's, its day the one it was made on here.)
  const titled = c.notebook.route('/api/notebooks/pages/title', {}, { id: free.id, title: 'Shop: the price' }),
    made = new Date(titled.created),
    day = [made.getFullYear(), made.getMonth() + 1, made.getDate()].map(n => String(n).padStart(2, '0')).join('-');
  const s = await opened(browser, c);
  const { page } = s;
  try {
    await spineOf(page);
    await c.shot('share-page', page);
    // PNG with a finger: the page's picture downloads, named for it
    const png = await downloaded(page, () => dragTo(page, 'touch', 'png'));
    assert.deepEqual(
      { name: png.name, head: [...png.bytes.subarray(0, 4)] },
      { name: `Shop the price ${day}.png`, head: [0x89, 0x50, 0x4e, 0x47] },
      'the PNG downloaded, named for its page',
    );
    // PDF with the mouse: a one-page PDF of it, the targets over the paper while it's carried
    const pdf = await downloaded(page, () =>
      dragTo(page, 'mouse', 'pdf', async () => {
        await page.waitForTimeout(400);
        await c.shot('share-targets', page);
        assert.ok(await tornInHand(page), 'the page in hand torn out at the spine, the book’s page whole');
        const shown = await targetsShown(page);
        assert.ok(shown.overPaper, `the targets over the paper: ${JSON.stringify(shown)}`);
        assert.deepEqual(shown.islands, [], 'the islands made way for them');
      }),
    );
    assert.equal(pdf.name, `Shop the price ${day}.pdf`);
    assert.equal(pdf.text.slice(0, 8), '%PDF-1.4', 'a PDF');
    assert.match(pdf.text, /\/Count 1/, 'of one page');
    assert.equal(await page.evaluate(() => window.__shared.length), 0, 'no share sheet');
    await flownBack(c, page, free);
    await menuOfTheDots(c, page);
    await ontoTheCall(c, s);
    await tapedOntoTheCall(c, s, free);
    c.noErrorsIn(s.errors);
  } finally {
    c.pages.splice(c.pages.indexOf(free), 1);
    await s.done();
  }
}
// The Pencil's copy let go off the targets: it flies back, nothing goes and the targets are away, and nothing is drawn
// where it was pressed
async function flownBack(c, page, free) {
  await dragTo(page, 'pen', null);
  await until(async () => !(await page.locator('#book > .bk-held').count()), 'the page flown back');
  await page.waitForTimeout(QUIET_MS);
  assert.equal(await page.evaluate(() => window.__downloads.length), 0, 'nothing downloaded');
  assert.equal(await page.locator('#book .bk-share').isHidden(), true, 'the targets gone');
  assert.equal(await page.locator('#book .bk-controls[data-targets]').count(), 0, 'the islands back');
  assert.equal(c.pages.find(p => p.id === free.id).ink.length, 1, 'nothing drawn where the Pencil tore it');
}

// A call with the CEO (Juno), from the intercom
export async function callTheCeo(s) {
  const ceo = await s.page.evaluate(async () => {
    const at = p => import(new URL(p, location.href).href);
    (await at('shell/desk.js')).openIntercom();
    return (await at('world/world.js')).company.ceo;
  });
  await s.page.click('#call');
  await until(() => s.line.hello, 'a call started');
  assert.equal(s.line.hello.agent, ceo, 'a call with the CEO');
}
// The dots' Tear off and send opens the same three as a menu, its keys going round it, Escape putting it away and the
// keys back on the dots
async function menuOfTheDots(c, page) {
  const menu = await tearOffMenu(page);
  assert.deepEqual(await menu.getByRole('menuitem').evaluateAll(items => items.map(i => i.dataset.share)), [
    'submit',
    'pdf',
    'png',
  ]);
  await c.shot('share-menu', page);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.share), 'submit', 'the keys on its first');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.share), 'pdf');
  await page.keyboard.press('Escape');
  assert.equal(await menu.isHidden(), true, 'Escape puts the menu away');
  assert.ok(await page.evaluate(() => document.activeElement.matches('#book .bk-more')), 'back on the dots');
}
// With the call on: the page carried onto its window, a picture file dropped there, a paste once the board pressed in
// it and the page carried onto its bubble once minimised each go to Juno, lit while they're over it; the book takes none
async function ontoTheCall(c, s) {
  await callTheCeo(s);
  const { page } = s,
    device = page.locator('#call-layer .device');
  let taped = 0;
  page.on('request', r => r.url().includes('/api/book/scrap') && taped++);
  await device.waitFor({ timeout: 5000 });
  await dragTo(page, 'mouse', '#call-layer .device', async () => {
    assert.equal(await device.getAttribute('data-drop'), '', 'the call’s window lit under the page');
    await c.shot('share-onto-call', page);
  });
  await shownOnCall(s, 1, 'the page carried onto the call’s window');
  // (a picture file, as the desktop's drag and the clipboard carry one)
  await page.evaluate(snip => {
    window.__carrying = () => {
      const data = new DataTransfer(),
        bytes = Uint8Array.from(atob(snip), ch => ch.charCodeAt(0));
      data.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
      return data;
    };
    const data = window.__carrying(),
      at = document.querySelector('#call-layer .device .lines');
    for (const type of ['dragenter', 'dragover', 'drop'])
      at.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
  }, c.SNIP.split(',')[1]);
  await shownOnCall(s, 2, 'a picture file dropped on the call’s window');
  await device.locator('.lines').click();
  await page.evaluate(() =>
    document.body.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: window.__carrying(), bubbles: true, cancelable: true }),
    ),
  );
  await shownOnCall(s, 3, 'a paste after a press in the call’s window');
  // minimised, its bubble takes the page
  const bubble = await minimised(page);
  await dragTo(page, 'mouse', '.callbubble .cb-face', async () => {
    assert.equal(await bubble.getAttribute('data-drop'), '', 'the bubble lit under the page');
    await c.shot('share-onto-bubble', page);
  });
  await shownOnCall(s, 4, 'the page carried onto the call’s bubble');
  await page.waitForTimeout(800);
  assert.equal(taped, 0, 'the book took none of them');
}
// A picture taped on the page, picked with Select and carried onto the call's window, then onto its bubble: each time
// it goes to Juno, the place lit under it while it's held there, and lands back where it was taped
async function tapedOntoTheCall(c, s, free) {
  const { page } = s;
  // (the call turned the book to its notes page: back to the picture's by its chapter's bookmark)
  await page.locator('#book .bk-mk-tab[data-chapter=sketch]').click();
  await page.waitForFunction(
    () =>
      !document.querySelector('#book .bk-turn-picture') &&
      document.querySelector('#book .bk-view-head .bk-page-title')?.textContent.includes('Shop: the price'),
  );
  const box = await paperBox(page);
  await pick(page, 'Select');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('Control+a');
  const frame = page.locator('#book .bk-sel');
  await frame.waitFor({ timeout: 3000 });
  await carryTaped(page, frame, '#call-layer .device', () => c.shot('taped-onto-call', page));
  await shownOnCall(s, 5, 'the taped picture carried onto the call’s window');
  await minimised(page);
  await carryTaped(page, frame, '.callbubble');
  await shownOnCall(s, 6, 'the taped picture carried onto the call’s bubble');
  await page.waitForTimeout(800);
  assert.deepEqual(
    free.scraps.map(({ x, y, w, h }) => ({ x, y, w, h })),
    [{ x: TAPED.x, y: TAPED.y, w: TAPED.w, h: TAPED.h }],
    'the picture still taped where it was',
  );
  assert.equal(await page.locator('#book .bk-sel-lifted').count(), 0, 'nothing left lifted');
}
// The picked things carried by their frame onto a place (a selector) and let go there: lit under them, still lit once
// they've been held still a while
async function carryTaped(page, frame, at, held = async () => {}) {
  const from = await frame.boundingBox(),
    target = page.locator(at),
    to = await target.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  assert.equal(await target.getAttribute('data-drop'), '', `${at} lit under the picture`);
  await page.waitForTimeout(HELD_STILL_MS);
  assert.equal(await target.getAttribute('data-drop'), '', `${at} still lit, the picture held still over it`);
  await held();
  await page.mouse.up();
}
// The call minimised (the played store has no call's notes page: the card saying so put away first), its bubble
// still in its corner
async function minimised(page) {
  const notesCard = page.locator('#call-cards [data-card=notes] button');
  if (await notesCard.isVisible()) await notesCard.click();
  await page.click('#call-min');
  const bubble = page.locator('.callbubble');
  await page.waitForSelector('#call-layer', { state: 'hidden', timeout: 3000 });
  // (the bubble springs into its corner: still once two looks agree)
  for (let was = null, now = await bubble.boundingBox(); JSON.stringify(was) !== JSON.stringify(now);) {
    await page.waitForTimeout(300);
    [was, now] = [now, await bubble.boundingBox()];
  }
  return bubble;
}
// The line shown its n-th picture of the call (counted: the ids the line gives them aren't the story's.)
export async function shownOnCall(s, n, what) {
  await until(() => s.line.said.filter(e => e.type === 'picture').length >= n, `${what} went to the call`, 15_000);
}

async function crumpleStory(browser, c) {
  const free = freePage(c);
  const s = await opened(browser, c);
  const { page } = s;
  try {
    const box = await paperBox(page);
    await tool(page, 'Pen').click();
    await line(page, box.x + 120, box.y + 200, 260);
    await savedWhere(c, free.id, p => p.ink.length === 1);
    await tool(page, 'Select').click();
    await page.mouse.move(box.x + 300, box.y + 400);
    await page.keyboard.press('Control+a');
    const fall = crumpled(page);
    fall.catch(() => {}); // (a failure below shows first; awaiting it later still throws)
    await page.keyboard.press('Delete');
    // the crumple plays over the paper, the line already gone underneath and in the store, its fall straight down
    // over within two seconds as every motion in the book
    await page.locator('.bk-fx-sheet').waitFor({ state: 'attached', timeout: 1000 });
    const answer = await fall;
    fellAway(answer, 'the selection');
    assert.ok(answer.length > 0 && answer.length <= 2000, `over within two seconds (${answer.length} ms)`);
    await c.shot('paper-crumple', page);
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.querySelector('.bk-fx')).pointerEvents),
      'none',
      'a press goes through it',
    );
    await savedWhere(c, free.id, p => p.ink.length === 0);
    await page.locator('.bk-fx-sheet').waitFor({ state: 'detached', timeout: 2500 });
    c.noErrorsIn(s.errors);
  } finally {
    c.pages.splice(c.pages.indexOf(free), 1);
    await s.done();
  }
}

// ---- the parts

// HQ on the played store on a desktop, the book open on its last page; the store's picture of a page served, the system's
// share sheet played (what it's given kept: window.__shared), a download's link pressed (the file kept:
// window.__downloads, as Chromium holds back a second download a played finger starts), a call's line, and the
// pictures sent to the call (uploads(): their bytes, kept as they're sent, as a route isn't handed a Blob's body)
export async function opened(browser, c, picture = c.SNIP) {
  const context = await c.hqIn(browser, DESKTOP, { hasTouch: true, deviceScaleFactor: 1 });
  await context.route(`${c.base}/api/book/picture**`, r =>
    r.fulfill({ contentType: 'image/png', body: Buffer.from(picture.split(',')[1], 'base64') }),
  );
  // (a call's pictures, numbered as they come)
  let sent = 0;
  await context.route(`${c.base}/api/pictures**`, r => r.fulfill({ json: { id: ++sent, type: 'image/jpeg' } }));
  await context.addInitScript(() => {
    window.__pictures = [];
    const open = XMLHttpRequest.prototype.open,
      send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...more) {
      this.picture = new URL(url, location.href).pathname === '/api/pictures';
      return open.call(this, method, url, ...more);
    };
    XMLHttpRequest.prototype.send = function (body) {
      if (this.picture) window.__pictures.push(body.arrayBuffer().then(bytes => [...new Uint8Array(bytes)]));
      return send.call(this, body);
    };
    window.__downloads = [];
    const press = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download) return press.call(this);
      window.__downloads.push({ name: this.download, href: this.href });
    };
    window.__shared = [];
    navigator.canShare = d => !!d?.files?.length;
    navigator.share = async ({ files }) => {
      for (const f of files) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        window.__shared.push({
          name: f.name,
          type: f.type,
          head: [...bytes.slice(0, 16)],
          text: new TextDecoder('latin1').decode(bytes.slice(0, 1200)),
        });
      }
    };
  });
  const line = await playLine(context);
  const { page, errors } = await watchedPage(context);
  await page.goto(`${c.base}/?intro=0`);
  await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
  await c.settled(page, 'open');
  const uploads = async () => (await page.evaluate(() => Promise.all(window.__pictures))).map(b => Buffer.from(b));
  return { page, errors, line, uploads, done: () => context.close() };
}

// The page in hand torn down its spine's edge (its outline jagged there, its fibres under it), while the page in the
// book has no tear of its own
const tornInHand = page =>
  page.evaluate(() => {
    const clip = el => getComputedStyle(el).clipPath,
      teeth = (clip(document.querySelector('#book > .bk-held .bk-held-sheet')).match(/%/g) ?? []).length / 2;
    return (
      teeth > 20 &&
      clip(document.querySelector('#book > .bk-held .bk-held-fibres')) !== 'none' &&
      [...document.querySelectorAll('#book .bk-desk, #book .bk-desk *')].every(el => clip(el) === 'none')
    );
  });
// The file act() downloads (its link's press, played: opened()): its name, its bytes and their first 1200 as text
export async function downloaded(page, act) {
  await act();
  await page.waitForFunction(() => window.__downloads.length > 0, null, { timeout: 15_000 });
  const { name, bytes } = await page.evaluate(async () => {
    const { name, href } = window.__downloads.shift();
    return { name, bytes: [...new Uint8Array(await (await fetch(href)).arrayBuffer())] };
  });
  const file = Buffer.from(bytes);
  return { name, bytes: file, text: file.subarray(0, 1200).toString('latin1') };
}
// A page of the board's writing with a picture taped below it (the picture kept by the played store, the page's own)
export function tapedPage(c) {
  const free = freePage(c),
    kept = c.notebook.route(
      '/api/notebooks/pictures',
      { page: free.id },
      { bytes: Buffer.from(c.SNIP.split(',')[1], 'base64'), type: 'image/png' },
    );
  return Object.assign(free, { ink: [inkLine()], scraps: [{ file: kept.file, ...TAPED }] });
}
const TAPED = { x: 160, y: 330, w: 220, h: 150, tilt: 0 };
// A line of the board's writing across the page
export const inkLine = () => ({
  color: '#1d9a5b',
  size: 5,
  points: Array.from({ length: 30 }, (_, i) => [60 + i * 12, 220 + 14 * Math.sin(i / 2), 0.5, i * 16]),
});

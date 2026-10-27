// book-check.mjs's stories of a circle on HQ's page and a pen's tap (shared/review/pencil.js, callnotes.js, marks.js,
// gestures.js; shell/calldraw.js), held like an iPad mini in landscape, on book-check's played store and voice line.
// One flow, on a call or not (Moss's): a ring round something on HQ's page, the pen rested, goes into the book as a note
// with its snip, no post-it and no Send; off a call on its owner's sheet, on a call on the call's page, where the book
// shows it, with the words the call heard. Nothing of it is left on HQ's page (rule zero: bookink.mjs), so the board rings the next thing at once, and a line drawn beside where one was is a
// note of its own. On a call, the pen held still while talking leaves a voice note there with the words the call heard.
// A mouse's ring with the pin goes into the book the same way. A finger carries a ring still open onto the open book,
// its cut-out taped there.
// A quick tap with the pen, wobbling a few px as a hand's does, clicks what's under it (focused, clicked once), on HQ's
// page and on a dialog over it, and leaves no ink, no post-it and no note, nor asks for the microphone.
import assert from 'node:assert/strict';
import { playLine } from './bookcall.mjs';
import { nothingDrawn } from './bookink.mjs';

const SETTLE_MS = 1500; // (callnotes.js)
const RINGS = [
  { x: 250, y: 300, rx: 80, ry: 45 },
  { x: 250, y: 470, rx: 80, ry: 45 },
];
const HELD = [250, 620]; // (where the pen's held still on a call: below the rings, clear of the call's bubble)

const ui = s => `review-mode >> css=${s}`;

// c: book-check's { hqIn, inLooks, base, MINI, settled, posts, pages, notes, snips, org, penOn, ring, inkAt, shot,
// noErrorsIn }
export function circleStories(c) {
  return {
    'a ring off a call rests into the book leaving nothing on HQ, a line beside it is a note of its own, a finger carries an open one onto the book':
      browser => offCallStory({ ...c, browser }),
    // (in Wire too: its call bubble sits elsewhere.)
    "a ring on a call rests into the call's page in the book, nothing left on HQ; held still, a voice note": browser =>
      c.inLooks(browser, (look, shot) => onCallStory({ ...c, browser, look, shot })),
    "a mouse's ring with the pin on HQ rests into the book too, no post-it": browser => mouseStory({ ...c, browser }),
    'a quick pen tap clicks what is under it, on HQ and on a dialog, and leaves no ink': browser =>
      tapStory({ ...c, browser }),
  };
}

async function offCallStory(c) {
  const { page, errors, done } = await hqOpen(c);
  try {
    for (const [i, ring] of RINGS.entries()) {
      const from = noted(c).length;
      await c.penOn(page)(c.ring(ring.x, ring.y, ring.rx, ring.ry));
      await page.waitForTimeout(400);
      assert.equal(await page.locator(ui('.sheet')).isHidden(), true, `ring ${i + 1}: no post-it`);
      const note = await nextNote(c, page, from, SETTLE_MS);
      assert.match(note.snip ?? '', /^data:image\/jpeg;base64,/, `ring ${i + 1}: in the book with its snip`);
      const made = c.pages.find(p => p.id === note.page);
      assert.deepEqual([made?.kind, made?.owner], ['sheet', c.org.company.ceo], `ring ${i + 1}: on the CEO's sheet`);
      await cleared(page, `ring ${i + 1}`);
    }
    // a line just beside where the first ring was: a note of its own, nothing to join (nothing of the first is there)
    const [first] = RINGS,
      from = noted(c).length,
      edits = edited(c).length;
    await c.penOn(page)(Array.from({ length: 12 }, (_, i) => [first.x + first.rx + 12 + i * 6, first.y + i * 2]));
    const beside = await nextNote(c, page, from, SETTLE_MS);
    assert.equal(beside.anchor.ink.length, 1, 'the line alone is its ink');
    assert.equal(edited(c).length, edits, 'no note changed by it');
    await cleared(page, 'the line beside');
    await c.shot('circle-off-call', page);
    await ringCarried(c, page, RINGS[1]);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// A ring still open (drawn, not yet rested) pressed inside by a finger and dragged onto the open book: its cut-out taped
// there, and the note with no words goes (the ring was for keeping: pencil.js carry); nothing left on HQ
async function ringCarried(c, page, ring) {
  const from = c.posts.length;
  const scrap = () => c.posts.slice(from).some(p => p.path === '/api/book/scrap'),
    note = () => c.posts.slice(from).some(p => p.path === '/api/book/note');
  await c.penOn(page)(c.ring(ring.x, ring.y, ring.rx, ring.ry));
  // (a press lifts it once its screenshot is in, before it rests: till then the finger is the page's)
  for (let i = 0; i < 12 && !scrap() && !note(); i++) {
    await page.waitForTimeout(100);
    await carry(page, ring);
    for (let k = 0; k < 3 && !scrap(); k++) await page.waitForTimeout(100);
  }
  assert.ok(
    c.posts.slice(from).some(p => p.path === '/api/book/scrap'),
    'an open ring carried onto the book: its cut-out taped there',
  );
  // (the still once it's taped on the page and the turn to it is over, not caught mid-turn)
  const taped = () => c.posts.slice(from).some(p => p.path === '/api/book/page/save' && p.body.scraps?.length);
  for (let i = 0; i < 40 && !taped(); i++) await page.waitForTimeout(250);
  assert.ok(taped(), '...taped on a page of the book');
  await page.waitForTimeout(SETTLE_MS);
  assert.ok(!note(), '...and no note of its own');
  await nothingDrawn(page, 'a ring carried into the book');
  await c.settled(page, 'open');
  await c.shot('circle-carried', page);
}
// A finger pressed inside a ring and dragged onto the open book's paper
async function carry(page, ring) {
  const paper = await page.evaluate(() => {
    const b = document.querySelector('#book .bk-desk').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.evaluate(
    ([a, b]) => {
      const at = (type, [x, y]) =>
        (document.elementFromPoint(x, y) ?? document.body).dispatchEvent(
          new PointerEvent(type, {
            ...{ pointerId: 11, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y },
            ...{ bubbles: true, composed: true, cancelable: true },
          }),
        );
      at('pointerdown', a);
      for (let i = 1; i <= 12; i++)
        at('pointermove', [a[0] + ((b[0] - a[0]) * i) / 12, a[1] + ((b[1] - a[1]) * i) / 12]);
      at('pointerup', b);
    },
    [
      [ring.x, ring.y],
      [paper.x, paper.y],
    ],
  );
}
// A mouse's ring with the pin goes the same way: no post-it, into the book once the mouse rests. (On a page of its
// own: once a pen has drawn there, the pin's marking takes only the pen, surface.js.)
async function mouseStory(c) {
  const { page, errors, done } = await hqOpen(c);
  try {
    await mouseRing(c, page);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}
async function mouseRing(c, page) {
  const mouse = { x: 250, y: 630, rx: 70, ry: 35 },
    before = noted(c).length;
  await page.click('#book .bk-pin'); // (away till the board summons it: job #20358)
  await page.locator(ui('.fab')).dispatchEvent('click'); // (it bobs: never still for Playwright's click)
  await page.waitForSelector(ui('.veil:not([hidden])'));
  const loop = c.ring(mouse.x, mouse.y, mouse.rx, mouse.ry);
  await page.mouse.move(...loop[0]);
  await page.mouse.down();
  for (const at of loop.slice(1)) await page.mouse.move(...at);
  await page.mouse.up();
  await page.waitForTimeout(400);
  assert.equal(await page.locator(ui('.sheet')).isHidden(), true, "a mouse's ring: no post-it on HQ");
  const byMouse = await nextNote(c, page, before, SETTLE_MS);
  assert.equal(byMouse.anchor.ink.length, 1, "...in the book with the mouse's ring");
  await page.waitForSelector(ui('.veil'), { state: 'hidden' });
  await cleared(page, "the mouse's ring");
}
async function onCallStory(c) {
  const context = await c.hqIn(c.browser, c.MINI),
    line = await playLine(context),
    { page, errors, done } = await hqOpen(c, context, `&open=intercom${c.look}`);
  try {
    await page.click('#call');
    await page.waitForFunction(() => !document.querySelector('#call-screenshare')?.disabled, null, {
      timeout: 15_000,
    });
    for (const [i, ring] of RINGS.entries()) {
      const from = noted(c).length;
      await c.penOn(page)(c.ring(ring.x, ring.y, ring.rx, ring.ry), { lift: false });
      line.send({ type: 'heard', text: `Ring ${i + 1} here` });
      await page.waitForTimeout(100);
      await page.evaluate(() => window.__lift());
      assert.equal(await page.locator(ui('.sheet')).isHidden(), true, 'no post-it on a call');
      const note = await nextNote(c, page, from, SETTLE_MS);
      assert.equal(note.words, `Ring ${i + 1} here`, `ring ${i + 1}: the words said with it`);
      assert.match(note.snip ?? '', /^data:image\/jpeg;base64,/, `ring ${i + 1}: its snip`);
      assert.equal(c.pages.find(p => p.id === note.page)?.kind, 'call', `ring ${i + 1}: on the call's page`);
      await heardNotes(page, line, i + 1);
      // (the book shows it on the call's page, its snip with it)
      const id = c.notes.find(n => n.page === note.page && n.words === note.words)?.id;
      await page
        .locator(`#book .bk-page[data-kind=call] .bs-note[data-id="${id}"] img.bs-snip`)
        .waitFor({ state: 'attached', timeout: 5000 });
      await cleared(page, `ring ${i + 1}`);
    }
    await heldStill(c, page, line);
    await c.shot('circle-on-call', page);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}
// The pen held still while talking, on HQ's page (not on the call's own bubble, which takes no ink, in either look): a
// voice note there, its words the call's
async function heldStill(c, page, line) {
  const from = noted(c).length;
  assert.equal(
    await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-no-ink]'), HELD),
    false,
    'the pen held still on HQ’s page',
  );
  await c.penOn(page)([HELD], { lift: false });
  await page.waitForSelector(ui('.listen:not([hidden])'), { timeout: 3000 });
  line.send({ type: 'heard', text: 'Hold this one' });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__lift());
  const voice = await nextNote(c, page, from, SETTLE_MS);
  assert.deepEqual([voice.words, voice.anchor.ink.length], ['Hold this one', 0], 'a voice note held still, its words');
  await heardNotes(page, line, RINGS.length + 1);
}
// The call's line has heard n notes
async function heardNotes(page, line, n) {
  const count = () => line.said.filter(e => e.type === 'note').length;
  for (let k = 0; k < 40 && count() < n; k++) await page.waitForTimeout(100);
  assert.equal(count(), n, `the call heard ${n} notes`);
}

// The board's notes the book was sent, and the notes changed
const noted = c => c.posts.filter(p => p.path === '/api/book/note' && !p.body.by);
const edited = c => c.posts.filter(p => p.path === '/api/book/note/edit');
async function nextNote(c, page, from, after = 0) {
  await page.waitForTimeout(after);
  for (let i = 0; i < 80 && noted(c).length <= from; i++) await page.waitForTimeout(100);
  assert.equal(noted(c).length, from + 1, 'one note into the book');
  return noted(c).at(-1).body;
}
// A ring in the book: nothing of it on HQ's page (its lift into the book landed)
const cleared = (page, what) => nothingDrawn(page, `${what}, in the book`);

async function tapStory(c) {
  const { page, errors, done } = await hqOpen(c);
  try {
    const from = c.posts.length;
    // a button on HQ's page, and one on a modal dialog over it, each counting its clicks
    await page.evaluate(() => {
      const button = (id, text) => {
        const b = Object.assign(document.createElement('button'), { id, textContent: text });
        b.style.cssText = 'width:160px;height:60px';
        b.addEventListener('click', () => (b.dataset.clicks = String(Number(b.dataset.clicks ?? 0) + 1)));
        return b;
      };
      const onPage = button('tap-page', 'On the page');
      onPage.style.cssText += ';position:fixed;left:120px;top:200px;z-index:5';
      const dialog = document.createElement('dialog');
      dialog.append(button('tap-dialog', 'On the dialog'));
      document.body.append(onPage, dialog);
      // (the times the page asked for the microphone)
      const media = navigator.mediaDevices,
        ask = media.getUserMedia.bind(media);
      window.micsAsked = 0;
      media.getUserMedia = constraints => (window.micsAsked++, ask(constraints));
    });
    await tap(c, page, '#tap-page');
    await page.evaluate(() => document.querySelector('dialog').showModal());
    await tap(c, page, '#tap-dialog');
    assert.equal(c.posts.length, from, 'nothing went to the book');
    assert.equal(await page.evaluate(() => window.micsAsked), 0, 'nor to the microphone: a tap is heard by nobody');
    // a ring's line, once it's no tap, listens
    await page.evaluate(() => document.querySelector('dialog').close());
    await c.penOn(page)(c.ring(400, 640, 80, 45));
    await page.waitForFunction(() => window.micsAsked === 1, null, { timeout: 3000 });
    await c.shot('circle-tap', page);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// A pen's quick tap in an element's middle, wandering a few px as a hand's does (past where ink starts, short of a
// line): the element clicked once and focused, no ink there, no post-it
async function tap(c, page, selector) {
  const box = await page.locator(selector).boundingBox(),
    [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await c.penOn(page)([
    [x, y],
    [x + 3, y + 2],
    [x + 6, y + 3],
    [x + 7, y + 1],
  ]);
  await page.waitForTimeout(400);
  const seen = await page.evaluate(
    s => ({ clicks: document.querySelector(s).dataset.clicks, focused: document.activeElement?.matches(s) }),
    selector,
  );
  assert.deepEqual(seen, { clicks: '1', focused: true }, `${selector}: clicked once, and focused`);
  assert.equal(await c.inkAt(page, x + 4, y + 2), 0, `${selector}: no ink where the pen tapped`);
  assert.equal(await page.locator(ui('.sheet')).isHidden(), true, `${selector}: no post-it`);
}

// HQ on its played store, the book open beside it
async function hqOpen(c, context, more = '') {
  context ??= await c.hqIn(c.browser, c.MINI);
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${c.base}/?intro=0${more}`);
  await page.waitForSelector('#loading.gone', { state: 'attached' });
  await page.waitForSelector('review-mode .fab', { state: 'attached' });
  await c.settled(page, 'open');
  return { page, errors, done: () => context.close() };
}

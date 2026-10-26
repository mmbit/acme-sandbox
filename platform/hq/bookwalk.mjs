// book-check.mjs's walk-through story (shell/calldraw.js, calldrive.js, shared/review/drive.js), held like an iPad mini
// in WebKit, its voice line played.
// Finished work on the desk phone whose maker offered a walk-through: the card says "Walk me through it", and its tap
// rings the maker about the card as a walk-through (the line hears walk with the card). Picked up, a page opens in
// today's book by itself. The agent suggests opening a screen of HQ's: a card with Open and Not now; Open makes the call
// small and opens it, the line hears so, and a card leads back. The agent points at something there (its pointer, with
// its name, at what it named) and a drive at words nowhere on screen comes back not done, with why; Back closes what it
// opened. Hung up with nothing written, the page goes by itself, no card asked; a second walk-through the board rings
// on is kept, with the card that offers to throw it away.
// A walk-through of a preview: Open shows it in HQ's viewer, with review mode
// running in the frame; the agent's pointer and its ring land round what it named inside the preview, the ring in its
// ink with its words beside it and nothing on HQ's own page; a ring off the frame's screen scrolls there first; a ring
// round a note is refused there; hung up, the ring and pointer go from the preview.
import assert from 'node:assert/strict';
import { fulfilPart } from '../../shared/review/parts.mjs';
import { heard, playLine } from './bookcall.mjs';

const CARD = 77;

// c: book-check's { context, open, page (its page now), pen, ring, posts, pages, org, shot, reviewJs }
export async function walkStory(c) {
  const line = await playLine(c.context);
  const agent = c.org.company.ceo;
  await c.context.route(/\/api\/requests$/, r =>
    r.fulfill({
      json: [
        {
          id: CARD,
          created: '2026-10-26T09:00:00Z',
          agent,
          job: 18537,
          kind: 'notice',
          topic: 'hq',
          title: 'Done: the gift-wrap step in the basket',
          body: 'It asks once, at the end, with a preview of the paper.',
          urgency: 'today',
          walk: 1,
        },
      ],
    }),
  );
  const s = { ...c, line, at: c.page }; // (at(): the page now; page: the story's, as heard() reads it)
  await walkedThrough(s);
  await previewWalked(s); // (before a page is kept: every call here is the line's call 9, which finds its kept page)
  await keptWhenWritten(s);
}

// Rung from the card: a walk-through; the agent opens a screen, points, and the board goes back; hung up, the empty page
// goes
async function walkedThrough(s) {
  const page = await ringFromCard(s);
  const made = s.posts.findLast(p => p.path === '/api/book/page/new');
  assert.deepEqual(
    made && [made.body.kind, made.body.call, /^Walk-through with /.test(made.body.label)],
    ['call', 9, true],
    "a walk-through's page in today's book as it's picked up, before anything is drawn",
  );
  const walkPage = s.pages.findLast(p => p.kind === 'call');

  // the agent suggests opening one of HQ's screens: the card waits, then Open shows it with the call small
  s.line.send({ type: 'open', id: 1, what: 'your computer', url: '/?open=computer' });
  const suggested = page.locator('#call-cards [data-card="open"]');
  await suggested.waitFor();
  assert.match(await suggested.innerText(), /suggests opening your computer/);
  await s.shot('book-walk-suggested', page);
  await suggested.getByRole('button', { name: 'Open' }).click();
  const opened = await heard(s, 'opened', e => e.id === 1);
  assert.equal(opened.answer, 'open', 'the line hears the board opened it');
  await page.waitForSelector('.callbubble', { state: 'visible' });
  await page.waitForSelector('#tool .device.computer', { state: 'visible' });
  const back = page.locator('#call-cards [data-card="back"]');
  await back.waitFor();
  assert.match(await back.innerText(), /opened your computer/);

  await pointed(s, page);

  // Back: what it opened closes
  await back.getByRole('button', { name: /Back/ }).click();
  await page.waitForSelector('#tool .device.computer', { state: 'detached', timeout: 3000 });

  // hung up with nothing written: the page goes by itself, and nothing asks
  await page.click('.callbubble .cb-hangup');
  for (let i = 0; i < 60 && !deleted(s, walkPage.id); i++) await page.waitForTimeout(250);
  assert.ok(deleted(s, walkPage.id), "the empty walk-through's page thrown away as the call ends");
  assert.equal(await page.locator('#call-cards [data-card="page"]').count(), 0, 'no card about a page that is gone');
  await page.close();
}

// Its pointer at what it names, with its name; words nowhere on screen come back not done, with why
async function pointed(s, page) {
  s.line.send({ type: 'drive', id: 2, point: 'Artifacts' });
  const pointed = await heard(s, 'driven', e => e.id === 2);
  assert.equal(pointed.done, true, `pointed (${JSON.stringify(pointed)})`);
  await page.waitForFunction(() => !document.querySelector('.hq-pointer').getAnimations().length); // (its glide)
  const at = await page.evaluate(() => {
    const p = document.querySelector('.hq-pointer svg').getBoundingClientRect(),
      named = [...document.querySelectorAll('#tool *')].find(
        el => el.children.length === 0 && el.textContent.trim() === 'Artifacts',
      );
    const t = named.getBoundingClientRect();
    return {
      x: p.left,
      y: p.top,
      t: { l: t.left, r: t.right, top: t.top, b: t.bottom },
      name: document.querySelector('.hq-pointer b').textContent,
      called: document.querySelector('.callbubble').getAttribute('aria-label').replace('Call with ', ''),
    };
  });
  assert.ok(
    at.x >= at.t.l - 4 && at.x <= at.t.r + 4 && at.y >= at.t.top - 30 && at.y <= at.t.b + 4,
    `the pointer is at what it named (${JSON.stringify(at)})`,
  );
  assert.equal(at.name, at.called, 'with its name');
  await s.shot('book-walk-pointed', page);
  s.line.send({ type: 'drive', id: 3, to: 'a heading nowhere at all' });
  const missed = await heard(s, 'driven', e => e.id === 3);
  assert.equal(missed.done, false);
  assert.match(missed.why, /Nothing on their screen says/);
}

// A second walk-through, written on: its page stays, with the card that keeps or throws it away
async function keptWhenWritten(s) {
  const page = await ringFromCard(s);
  const walkPage = s.pages.findLast(p => p.kind === 'call');
  await page.click('#call-min');
  await page.waitForSelector('#call-layer', { state: 'hidden', timeout: 3000 });
  await s.pen(s.ring(330, 440, 110, 34)); // (round the card's title)
  // (the note goes in once the Pencil has stayed up, its snip taken: slow on a loaded worker)
  for (let i = 0; i < 60 && !s.posts.some(p => p.path === '/api/book/note'); i++) await page.waitForTimeout(250);
  const sent = await heard(s, 'note', e => e.id > 0);
  s.line.send({ type: 'note', id: sent.id, state: 'received' });
  await page.click('.callbubble .cb-hangup');
  const kept = page.locator('#call-cards [data-card="page"]');
  await kept.waitFor({ timeout: 15_000 });
  assert.equal(deleted(s, walkPage.id), false, 'a walk-through the board wrote on keeps its page');
  await s.shot('book-walk-kept', page);
  await page.close();
}

// HQ at the card on the desk phone, its walk-through rung and picked up
async function ringFromCard(s) {
  s.line.said.length = 0;
  await s.open(`/?intro=0&open=phone&card=${CARD}`);
  const page = (s.page = s.at());
  const walk = page.getByRole('button', { name: 'Walk me through it' });
  await walk.waitFor();
  await s.shot('book-walk-card', page);
  await walk.click();
  await page.waitForFunction(() => !document.querySelector('#call-screenshare')?.disabled, null, { timeout: 15_000 });
  assert.deepEqual([s.line.hello.request, s.line.hello.walk], [CARD, true], 'the call is a walk-through of the card');
  for (let i = 0; i < 40 && !s.pages.some(p => p.kind === 'call'); i++) await page.waitForTimeout(100);
  return page;
}
const deleted = (s, id) => s.posts.some(p => p.path === '/api/book/page/delete' && p.body.id === id);

// ---- a preview in HQ's viewer: the agent points and rings inside it.
const PREVIEW = 'https://hello.preview.test';
const PREVIEW_PAGE = `<!doctype html><meta name="viewport" content="width=device-width"><title>Basket</title>
<body style="margin: 0; font: 16px system-ui, sans-serif">
<h1 style="margin: 24px">Your basket</h1>
<label style="display: inline-block; margin: 0 24px; padding: 10px 14px; border: 1px solid #bbb">Gift wrap</label>
<div style="height: 1600px"></div>
<p style="margin: 24px">Pick-up point</p>
<script src="/__review/review.js"></script>`;

async function previewWalked(s) {
  const { page, frame, walkPage } = await previewOpened(s);
  await pointedInPreview(s, page, frame);
  await ringedInPreview(s, page, frame);
  // hung up: the ring and the pointer go from the preview, and the untouched walk-through's page with them
  await page.click('.callbubble .cb-hangup');
  await frame.waitForFunction(() => !document.querySelector('.hq-ring, .hq-pointer'), null, { timeout: 5000 });
  for (let i = 0; i < 60 && !deleted(s, walkPage.id); i++) await page.waitForTimeout(250);
  assert.ok(deleted(s, walkPage.id), "a preview's rings write nothing on the walk-through's page");
  await page.close();
}

// Rung from the card, the agent's Open shows the preview in HQ's viewer, review mode running in its frame
async function previewOpened(s) {
  await s.context.route(/\/api\/preview\/link$/, r => r.fulfill({ json: { url: r.request().postDataJSON().url } }));
  await s.context.route(`${PREVIEW}/**`, r => {
    const path = new URL(r.request().url()).pathname;
    if (fulfilPart(r, path, s.reviewJs)) return;
    if (path.startsWith('/__review/')) return r.fulfill({ json: { show: false } });
    return r.fulfill({ contentType: 'text/html', body: PREVIEW_PAGE });
  });
  const page = await ringFromCard(s);
  const walkPage = s.pages.findLast(p => p.kind === 'call');
  s.line.send({ type: 'open', id: 4, what: 'the basket', url: `${PREVIEW}/basket` });
  await page.locator('#call-cards [data-card="open"]').getByRole('button', { name: 'Open' }).click();
  assert.equal((await heard(s, 'opened', e => e.id === 4)).answer, 'open');
  await page.waitForSelector('#viewer .bar .pin:not([hidden])', { timeout: 15_000 }); // (review mode said hello)
  return { page, walkPage, frame: page.frame({ url: /hello\.preview\.test/ }) };
}

// Its pointer, at what it named in the preview, and nothing on HQ's own page
async function pointedInPreview(s, page, frame) {
  s.line.send({ type: 'drive', id: 5, point: 'Gift wrap' });
  assert.equal((await heard(s, 'driven', e => e.id === 5)).done, true, 'pointed in the preview');
  await frame.waitForFunction(() => !document.querySelector('.hq-pointer').getAnimations().length);
  const pointer = await seen(page, frame, '.hq-pointer svg', 'Gift wrap');
  assert.ok(
    pointer.box.x >= pointer.named.x - 4 &&
      pointer.box.x <= pointer.named.r + 4 &&
      Math.abs(pointer.box.y - pointer.named.y) < 30,
    `the pointer at what it named, as the board sees it (${JSON.stringify(pointer)})`,
  );
  assert.equal(await page.locator('body > .hq-pointer').count(), 0, "nothing pointed at on HQ's own page");
}

// Its ring round it, in its ink, its words beside it, kept out of the book; off the frame's screen, scrolled there
// first; a note isn't the preview's to ring
async function ringedInPreview(s, page, frame) {
  const notesBefore = s.posts.filter(p => p.path === '/api/book/note').length;
  s.line.send({ type: 'ink', id: 6, ring: 'Gift wrap', note: null, words: 'this one' });
  const inked = await heard(s, 'inked', e => e.id === 6);
  assert.equal(inked.drawn, true, `ringed in the preview (${JSON.stringify(inked)})`);
  assert.match(inked.why, /not kept in the book/, 'the line hears the ring is the preview’s, not the book’s');
  const ring = await seen(page, frame, '.hq-ring svg path:last-child', 'Gift wrap');
  assert.ok(
    ring.box.x < ring.named.x && ring.box.r > ring.named.r && ring.box.y < ring.named.y && ring.box.b > ring.named.b,
    `the ring round what it named, as the board sees it (${JSON.stringify(ring)})`,
  );
  const look = await frame.evaluate(() => ({
    ink: document.querySelector('.hq-ring svg path:last-child').getAttribute('fill'),
    words: document.querySelector('.hq-ring p')?.textContent,
  }));
  const name = await page.evaluate(() =>
    document.querySelector('.callbubble').getAttribute('aria-label').replace('Call with ', ''),
  );
  assert.equal(
    look.ink,
    await frame.evaluate(() => document.querySelector('.hq-pointer').style.getPropertyValue('--ink')),
  );
  assert.equal(look.words, `${name}: this one`, 'its words beside it, with its name');
  assert.equal(s.posts.filter(p => p.path === '/api/book/note').length, notesBefore, "no note on HQ's call page");
  await s.shot('book-walk-preview-ring', page);
  s.line.send({ type: 'ink', id: 7, ring: 'Pick-up point', note: null, words: '' });
  const below = await heard(s, 'inked', e => e.id === 7);
  assert.match(below.why, /scrolled to it first/);
  const scrolled = await seen(page, frame, '.hq-ring svg path:last-child', 'Pick-up point');
  assert.ok(
    scrolled.named.y > scrolled.frame.y && scrolled.named.b < scrolled.frame.b,
    `on the board's screen (${JSON.stringify(scrolled)})`,
  );
  s.line.send({ type: 'ink', id: 8, ring: null, note: 1, words: '' });
  const noted = await heard(s, 'inked', e => e.id === 8);
  assert.deepEqual([noted.drawn, /preview open/.test(noted.why)], [false, true], 'a note ring refused in a preview');
}
// Where the last thing drawn in the preview's frame is, and what it named, on HQ's page as the board sees it
async function seen(page, frame, drawn, words) {
  const at = await page.evaluate(() => {
    const b = document.querySelector('#viewer iframe').getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, b: b.bottom };
  });
  const inside = await frame.evaluate(
    ([drawn, words]) => {
      const box = el => {
        const b = el.getBoundingClientRect();
        return { x: b.left, y: b.top, r: b.right, b: b.bottom };
      };
      const named = [...document.body.querySelectorAll('*')].find(
        el => el.children.length === 0 && el.textContent.trim() === words,
      );
      return { box: box([...document.querySelectorAll(drawn)].at(-1)), named: box(named), width: innerWidth };
    },
    [drawn, words],
  );
  const k = at.w / inside.width,
    onHq = b => ({ x: at.x + b.x * k, y: at.y + b.y * k, r: at.x + b.r * k, b: at.y + b.b * k });
  return { box: onHq(inside.box), named: onHq(inside.named), frame: { y: at.y, b: at.b } };
}

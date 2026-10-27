// book-check.mjs's answers story (shared/review/slip.js, markslips.js; shell/bookslips.js), held like an iPad mini, on
// book-check's played store.
// A question written on HQ's page sits on the CEO's open sheet; its answer comes through HQ's feed (a 'book' event, not
// the rail's 20 s read) and clips onto the note in the book within seconds, typed under a clip, with then and now: the
// note's snip, and the same place cut again from the live page once the page is still (posted to the store, then shown
// in the book). On HQ's page the answered mark opens its card from the ink: what was said, that it isn't sent yet, the
// answer, and a tick box; the box ticks it. In the book a tick written over the slip ticks it and Undo takes it back,
// and words written under it go as the reply, a new note on the same sheet. A sent note answered with something new
// shows its running preview: its picture, and a link to it.
import assert from 'node:assert/strict';

// a snip: an 8 × 6 red PNG
const RED =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR4nGN4ZmODFTEMpAQAW3NBof5buBkAAAAASUVORK5CYII=';
// a page turned to is the only one on the paper once its leaf has turned (bookflip.js).
const TURN_MS = 600;
const WAIT_MS = 4000; // an answer clipped on, as the feed brings it (the rail's own read is every 20 s)

// c: book-check's { browser, hqIn, base, MINI, store, pages, notes, snips, posts, org, shot, settled, fingerTap,
// noErrorsIn }, and look: 'wire' for Wire (Chromium's: WebKit on Linux can't start it), its stills' names ending -wire
export async function slipStory(c) {
  const at = `/?intro=0${c.look ? `&renderer=${c.look}` : ''}`,
    f = fixtures(c, at),
    context = await c.hqIn(c.browser, c.MINI),
    shot = (name, page) => c.shot(c.look ? `${name}-${c.look}` : name, page),
    s = { ...c, ...f, shot, feed: [], cuts: new Map(), from: c.posts.length };
  await played(s, context);
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`${c.base}${at}`);
    await page.waitForSelector('#loading.gone');
    if (c.look) assert.equal(await page.evaluate(() => document.body.classList.contains('brownstone')), false, 'Wire');
    await page.waitForSelector('review-mode .fab', { state: 'attached' }); // (away while the book's folded)
    await c.settled(page, 'open');
    await page.click(`#book .bk-face[data-id="${f.ceo}"]`);
    // (the leaf turning to the sheet's page holds a picture of both pages while it turns.)
    await page.waitForTimeout(TURN_MS);
    const inBook = page.locator('#book .bs-note', { hasText: f.asked.words });
    await inBook.waitFor({ timeout: 5000 });
    assert.equal(await inBook.locator('.answer-slip').count(), 0, 'no answer yet');
    await page.evaluate(() => {
      window.turns = [];
      document.addEventListener('book:turn', e => window.turns.push(e.detail.page));
    });
    const typed = await clipsOn(s, page, inBook);
    await onThePage(s, page);
    // (the answer and the ticks, page-less book:changed, leave the book on the sheet: only a call's book:paged turns it.
    const turns = await page.evaluate(() => window.turns);
    assert.ok(
      turns.every(id => id === f.sheet.id),
      `the book turned from the sheet to ${turns}`,
    );
    await tickedInTheBook(s, page, typed);
    await replied(s, page);
    await previewed(s, page);
    c.noErrorsIn(errors);
  } finally {
    c.pages.splice(c.pages.indexOf(f.sheet), 1);
    for (const n of c.notes.filter(n => n.page === f.sheet.id)) c.notes.splice(c.notes.indexOf(n), 1);
    await context.close();
  }
}

// The CEO's sheet page for HQ's page at its address (at), an open question on it with its ink, and a sent note answered
// with a preview
function fixtures(c, at) {
  const ceo = c.org.company.ceo,
    y = 520,
    line = Array.from({ length: 21 }, (_, i) => [220 + i * 10, y, 0.5, i * 16]);
  const anchor = { v: 1, url: at, el: null, view: { w: 1133, h: 744, x: 0, y: 0, dpr: 2 } };
  const sheet = { id: 9100, kind: 'sheet', owner: ceo, url: at, w: 700, h: 700 },
    asked = {
      id: 9101,
      n: 1,
      page: sheet.id,
      anchor: { ...anchor, ink: [{ color: '#ff5a5f', size: 5, points: line }] },
      words: 'Is this banner too long?',
      said: 'typed',
      by: 'board',
      snip: '/api/book/snip?id=9101',
      status: 'open',
      slips: [],
    },
    built = {
      id: 9102,
      n: 1,
      page: sheet.id,
      anchor: { ...anchor, ink: [] },
      words: 'A little app to sort these',
      said: 'typed',
      by: 'board',
      snip: '/api/book/snip?id=9102',
      status: 'sent',
      slips: [
        slip(9202, 9102, 'Built it: Sorter.', {
          preview: { name: 'Sorter', open: 'https://sorter.preview.example', picture: '/api/book/snip?id=9102' },
        }),
      ],
    };
  c.pages.push(sheet);
  c.notes.push(asked);
  c.snips.set(asked.id, RED).set(built.id, RED);
  // (the sent note on a sent sheet of the CEO's, as the store lists it)
  const sentSheet = {
    id: 9300,
    owner: ceo,
    name: null,
    status: 'sent',
    sent: new Date().toISOString(),
    notes: [built],
  };
  return { ceo, y, sheet, asked, built, sentSheet };
}

// The slips' routes on the store, and HQ's feed, played; s: the story's state
async function played(s, context) {
  const { feed, cuts, asked, built, sheet, sentSheet, ceo } = s,
    c = s;
  await fed(feed, context, c.base);
  // the slips' routes on the store (bookslips.ts), the rest book-check's
  await context.route(`${c.base}/api/book/**`, async r => {
    const url = new URL(r.request().url()),
      body = r.request().method() === 'POST' ? r.request().postDataJSON() : null,
      hit = [asked, built].flatMap(n => n.slips).find(x => x.id === (body?.id ?? +url.searchParams.get('id')));
    if (body && url.pathname.startsWith('/api/book/slip')) c.posts.push({ path: url.pathname, body });
    if (url.pathname === '/api/book/sheets') {
      const listed = c.store(url.pathname, null, url.searchParams);
      return r.fulfill({ json: { ...listed, sent: [sentSheet, ...listed.sent] } });
    }
    if (url.pathname === '/api/book/slip/now' && body) {
      cuts.set(hit.id, body.picture);
      Object.assign(hit, { now: `/api/book/slip/now?id=${hit.id}&v=1`, now_at: new Date().toISOString() });
      return r.fulfill({ json: { slip: hit } });
    }
    if (url.pathname === '/api/book/slip/now') {
      const cut = cuts.get(hit.id);
      return r.fulfill({ contentType: 'image/jpeg', body: Buffer.from(cut.split(',')[1], 'base64') });
    }
    if (url.pathname === '/api/book/slip/tick') {
      hit.ticked = body.ticked ? new Date().toISOString() : null;
      return r.fulfill({ json: { slip: hit, note: asked } });
    }
    if (url.pathname === '/api/book/slip/reply') {
      const reply = {
        id: 9103,
        page: sheet.id,
        anchor: asked.anchor,
        words: body.words,
        said: 'written',
        by: 'board',
        snip: null,
        status: 'open',
        answers: hit.id,
        slips: [],
      };
      c.notes.push(reply);
      const n = c.notes.filter(x => x.status === 'open' && (x.owner ?? ceo) === ceo).indexOf(reply) + 1;
      return r.fulfill({ json: { note: { ...reply, n }, sheet: null, asked: null } });
    }
    return r.fallback();
  });
}

// the answer, as the quick run clips it on: the feed's 'book' event, and the book has it within seconds
async function clipsOn(s, page, inBook) {
  const { asked, feed, from } = s,
    c = s;
  asked.slips.push(slip(9201, asked.id, 'No: five words, it fits on one line.'));
  feed.push({ type: 'book', agent: 'kit', text: 'slip' });
  const t0 = Date.now(),
    typed = inBook.locator('.answer-slip', { hasText: 'five words' });
  await typed.waitFor({ timeout: WAIT_MS });
  const took = Date.now() - t0;
  assert.ok(took < WAIT_MS, `the answer took ${took} ms to clip on`);
  assert.match(await typed.innerText(), /Kit[\s\S]*Then[\s\S]*Now/i);
  assert.equal(await typed.locator('img[alt="As it was marked"]').getAttribute('src'), asked.snip);
  // ...then the page, still, cuts the same place again: the store gets it, the book shows it as now
  const now = typed.locator('img[alt="The same place now"]');
  await now.waitFor({ timeout: 15_000 }); // (a screenshot waits up to 7 s for fonts and pictures: snapshot.js)
  const cut = c.posts.slice(from).find(p => p.path === '/api/book/slip/now');
  assert.equal(cut?.body.id, 9201);
  assert.match(cut.body.picture, /^data:image\/jpeg;base64,/);
  assert.ok(await now.evaluate(img => img.complete && img.naturalWidth > 0), 'the cut shows');
  await c.shot('slip-book', page);
  return typed;
}

// on HQ's page: the answered mark's card from its ink, and its tick box
async function onThePage(s, page) {
  const { asked, y } = s,
    c = s;
  await c.fingerTap(page, 300, y + 4);
  const card = page.getByRole('dialog', { name: 'A note in the book' });
  await card.waitFor({ timeout: 3000 });
  const said = await card.innerText();
  assert.match(said, /Is this banner too long\?/);
  assert.match(said, /For Juno, not sent/); // (where it waits, as the card says)
  assert.match(said, /five words, it fits on one line/);
  // (its pop-in, and the tap's own click, which the card swallows for 400 ms: marktaps.js.)
  await page.waitForTimeout(500);
  await c.shot('slip-card', page);
  await card.getByRole('button', { name: 'Tick it: done' }).click();
  await until(() => asked.slips[0].ticked);
  await page.locator('#book .answer-slip[data-ticked]').waitFor({ timeout: 3000 });
  await card.getByRole('button', { name: 'Ticked: done' }).click(); // (and back: the next tick is the Pencil's)
  await until(() => !asked.slips[0].ticked);
  await page
    .locator('#book .bs-note .answer-slip:not([data-ticked])', { hasText: 'five words' })
    .waitFor({ timeout: 3000 });
  await c.fingerTap(page, 300, y + 120);
}

// in the book: a tick written over the slip ticks it, and Undo takes it back
async function tickedInTheBook(s, page, typed) {
  const { asked } = s;
  const box = await typed.boundingBox(),
    [x0, y0] = [box.x + 30, box.y + 30];
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (const [dx, dy] of [
    [4, 4],
    [8, 9],
    [12, 14],
    [20, 6],
    [30, -4],
    [42, -16],
  ])
    await page.mouse.move(x0 + dx, y0 + dy);
  await page.mouse.up();
  await until(() => asked.slips[0].ticked);
  await page.click('#book .bk-undo');
  await until(() => !asked.slips[0].ticked);
}

// words written under it: the reply, a new note on the same sheet
async function replied(s, page) {
  const { asked, from } = s,
    c = s;
  const reply = page.locator('#book .bs-note', { hasText: asked.words }).getByRole('textbox', { name: 'Reply to Kit' });
  await reply.fill('Shorter still, three words?');
  await reply.press('Enter');
  await page.locator('#book .slip-said', { hasText: 'On the sheet as note 2' }).waitFor({ timeout: 3000 });
  const replied = c.posts.slice(from).find(p => p.path === '/api/book/slip/reply');
  assert.deepEqual(replied?.body, { id: 9201, words: 'Shorter still, three words?' });
}

// something new comes back as its running preview: its picture and a link to it
async function previewed(s, page) {
  const c = s;
  const preview = page.locator('#book .answer-slip', { hasText: 'Built it: Sorter.' });
  await preview.waitFor({ timeout: 3000 });
  assert.equal(
    await preview.getByRole('link', { name: 'The same place now' }).getAttribute('href'),
    'https://sorter.preview.example',
  );
  assert.match(await preview.innerText(), /Now · Sorter/i);
  await c.shot('slip-preview', page);
}

// HQ's feed: what's due, then a quick reconnect (each request drains it)
async function fed(feed, context, base) {
  await context.route(`${base}/api/events`, r =>
    r.fulfill({
      contentType: 'text/event-stream',
      body: `retry: 150\n\n${feed
        .splice(0)
        .map(e => `data: ${JSON.stringify(e)}\n\n`)
        .join('')}`,
    }),
  );
}

function slip(id, note, text, more = {}) {
  return {
    id,
    note,
    by: 'kit',
    name: 'Kit',
    text,
    picture: null,
    link: null,
    created: new Date().toISOString(),
    ticked: null,
    now: null,
    now_at: null,
    preview: null,
    ...more,
  };
}
// a condition met within a few seconds
async function until(met) {
  for (const end = Date.now() + 4000; Date.now() < end; await new Promise(res => setTimeout(res, 100)))
    if (met()) return;
  assert.fail(`not met in 4 s: ${met}`);
}

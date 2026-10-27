// book-check.mjs's story of the Pencil's ink on HQ's screens, held like an iPad mini, on book-check's played store
// (shared/review/marks.js, markshows.js, hairline.js).
// HQ keeps one address whatever screen is open. A ring drawn on the computer's home screen shows there, a faint hairline
// once its note is in the book, and on no other screen: not on HQ's own view with the computer closed, not under the desk phone, not in
// another tab until that tab opens the computer too. Two notes left from before, on what HQ no longer draws, show
// nowhere. Once the sheet goes (HQ's feed tells every tab, as the coordinator does), the ring fades to a faint hairline
// on its own screen in both tabs, still on no other screen, and a finger's tap on it opens its card with its words. A
// scribble over it clears it from HQ, the note still in the book, and Cmd+Z brings it back.
import assert from 'node:assert/strict';

const RING = { x: 248, y: 305, rx: 70, ry: 50 },
  // (a point on the ring's line: its first, at the right; and a point on the stuck notes' line)
  ON_RING = [RING.x + RING.rx, RING.y],
  ON_STUCK = [300, 600];
const FAINT = 0.45 * 255; // (a hairline's ink at most, of 255)

// c: book-check's { browser, hqIn, base, MINI, settled, ui, penOn, ring, inkAt, fingerTap, notes, org, posts, shot,
// noErrorsIn }, and look ('&renderer=wire' for Wire)
export async function inkStory(c) {
  const stuck = stuckNotes(c),
    context = await c.hqIn(c.browser, c.MINI),
    errors = [],
    from = c.notes.length;
  try {
    const a = await tab(c, context, errors);
    const note = await drawn(c, a);
    await elsewhere(c, a);
    const b = await tab(c, context, errors);
    assert.equal(await c.inkAt(b.page, ...ON_RING), 0, 'another tab on HQ’s own view: no ring');
    await show(b.page, 'computer');
    assert.ok(await hairlined(c, b.page), 'another tab on the same screen: the ring');
    await sent(c, [a, b], note);
    await show(b.page, null);
    assert.equal(await c.inkAt(b.page, ...ON_RING), 0, 'a hairline on no other screen either');
    // a finger's tap on the hairline opens its card with its words
    await c.fingerTap(a.page, ...ON_RING);
    const card = a.page.getByRole('dialog', { name: 'A note in the book' });
    await card.waitFor({ timeout: 3000 });
    assert.ok(note.words && (await card.innerText()).includes(note.words), 'the card says what was said');
    await c.shot('book-ink-card', a.page);
    // a scribble over the sent note's hairline clears it from HQ only, the note left in the book; Cmd+Z brings it
    // back
    const posted = c.posts.length;
    await c.penOn(a.page)(
      Array.from({ length: 24 }, (_, i) => [RING.x - RING.rx + (i % 2) * RING.rx * 2, RING.y - 30 + i * 2.5]),
    );
    await a.page.waitForTimeout(400);
    assert.equal(await c.inkAt(a.page, ...ON_RING), 0, 'a scribble clears a sent note’s hairline');
    await a.page.waitForTimeout(2000); // (past a mark's settle: nothing goes)
    assert.deepEqual(
      c.posts
        .slice(posted)
        .map(p => p.path)
        .filter(p => p.startsWith('/api/book/note')),
      [],
      '...its note left in the book, and no note of the scribble',
    );
    await a.page.keyboard.press('Control+z');
    await a.page.waitForTimeout(400);
    assert.ok(await hairlined(c, a.page), 'Cmd+Z brings the hairline back');
    c.noErrorsIn(errors);
  } finally {
    c.notes.splice(from);
    for (const n of stuck) c.notes.splice(c.notes.indexOf(n), 1);
    await context.close();
  }
}

// Two notes from before, open and sent, on an element HQ no longer draws, where the ring would be on any screen
function stuckNotes(c) {
  const line = Array.from({ length: 21 }, (_, i) => [ON_STUCK[0] - 100 + i * 10, ON_STUCK[1], 0.5, i * 16]);
  const anchor = {
    v: 1,
    url: '/?intro=0',
    el: { selector: 'div#tool > div.device.mail > ul.gone', tag: 'ul', text: 'A list long gone', box: box(200) },
    view: { w: 1133, h: 744, x: 0, y: 0, dpr: 2 },
    ink: [{ color: '#ff5a5f', size: 5, points: line }],
  };
  const stuck = ['open', 'sent'].map((status, i) => ({
    ...{ id: 9500 + i, n: 1, page: 9500, anchor, words: `Left ${status}`, said: 'typed', by: 'board', status },
    ...{ snip: null, slips: [], created: '2026-10-25T08:10:00Z', updated: '2026-10-25T08:16:00Z' },
  }));
  c.notes.push(...stuck);
  return stuck;
}
const box = x => ({ x, y: 500, w: 200, h: 200 });

// HQ in a tab of the context, its book open, its feed played: tab.feed takes the events the coordinator would publish
async function tab(c, context, errors) {
  const page = await context.newPage(),
    feed = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(`${c.base}/api/events`, r =>
    r.fulfill({
      contentType: 'text/event-stream',
      body: `retry: 150\n\n${feed
        .splice(0)
        .map(e => `data: ${JSON.stringify(e)}\n\n`)
        .join('')}`,
    }),
  );
  await page.goto(`${c.base}/?intro=0${c.look}`);
  await page.waitForSelector('#loading.gone');
  await page.waitForSelector('review-mode .fab');
  await c.settled(page, 'open');
  assert.equal(await page.evaluate(() => document.body.classList.contains('brownstone')), !c.look, 'the look');
  return { page, feed };
}

// One of HQ's screens open (the computer's home, the desk phone), or none: HQ's own view
async function show(page, screen) {
  await page.evaluate(async screen => {
    const desk = await import('/shell/desk.js');
    if (screen === 'computer') desk.openComputer('home');
    else if (screen === 'phone') await desk.openPhone();
    else desk.closeTool();
  }, screen);
  await (screen
    ? page.waitForSelector(`#tool .device.${screen}`, { state: 'visible' })
    : page.waitForSelector('#tool', { state: 'hidden' }));
  await page.waitForTimeout(400); // (its pop and the marks drawn after it)
}
// whether the ring shows on a tab's screen as its hairline, within a few seconds
async function hairlined(c, page) {
  for (let i = 0; i < 20; i++, await page.waitForTimeout(150)) {
    const ink = await c.inkAt(page, ...ON_RING);
    if (ink > 0 && ink < FAINT) return true;
  }
  return false;
}

// A ring round the computer's Mail, rested into the book: it shows on its screen. The note.
async function drawn(c, { page }) {
  await show(page, 'computer');
  assert.equal(await c.inkAt(page, ...ON_STUCK), 0, 'the notes from before show nowhere');
  const noted = c.notes.length;
  await c.penOn(page)(c.ring(RING.x, RING.y, RING.rx, RING.ry));
  // (rested, it goes into the book with the words said: the voice line's.)
  for (let i = 0; i < 80 && c.notes.length === noted; i++) await page.waitForTimeout(100);
  const note = c.notes[noted];
  assert.ok(note?.anchor.el?.selector, 'the ring went into the book on what it was drawn round');
  assert.ok(await hairlined(c, page), 'the ring shows on its screen, as its hairline');
  await c.shot('book-ink-computer', page);
  return note;
}

// HQ's own view and the desk phone: no ring, no stuck note; back on the computer, the ring again
async function elsewhere(c, { page }) {
  for (const screen of [null, 'phone']) {
    await show(page, screen);
    const where = screen ?? 'HQ’s own view';
    assert.equal(await c.inkAt(page, ...ON_RING), 0, `no ring on ${where}`);
    assert.equal(await c.inkAt(page, ...ON_STUCK), 0, `the notes from before not on ${where}`);
  }
  await c.shot('book-ink-phone', page);
  await show(page, 'computer');
  assert.ok(await hairlined(c, page), 'back on its screen, the ring');
}

// The sheet sent, its seconds over, the feed telling both tabs: on its screen in each, the ring fades to a hairline
async function sent(c, tabs, note) {
  const [{ page }] = tabs;
  await page.evaluate(async () => {
    const api = (path, body) =>
      fetch(`/api/book${path}`, body && { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
    const ceo = (await (await fetch('/api/org')).json()).company.ceo,
      { open } = await api('/sheets');
    await api('/send', { id: open.find(s => s.owner === ceo).id });
  });
  await page.waitForTimeout(10_200);
  for (const t of tabs) t.feed.push({ type: 'book', agent: c.org.company.ceo, text: 'sent' });
  for (const [i, t] of tabs.entries()) {
    let ink = 255;
    for (let k = 0; k < 40 && !(ink > 0 && ink < FAINT); k++, await t.page.waitForTimeout(150))
      ink = await c.inkAt(t.page, ...ON_RING);
    assert.ok(ink > 0 && ink < FAINT, `tab ${i + 1}: the sent ring is a faint hairline on its screen (${ink} of 255)`);
  }
  assert.equal(note.status, 'sent');
  await c.shot('book-ink-hairline', page);
}

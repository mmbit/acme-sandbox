// book-check.mjs's asks story (shell/bookslips.js asks, desk.js's On the page), held like an iPad mini, on book-check's
// played store.
// A desk-phone card an agent filed about a note (hq ask --note) shows on the desk phone with the note: its snip, whose and
// where it is, its words, and Open in the book, which opens the book on that note, lit. In the book it's clipped under
// the note, "<Agent> asks", its choices as chips: a choice tapped there answers the card through the desk phone's own
// route, the slip reads answered with the pick, and the desk phone has nothing waiting. A card with a key field shows
// in the book as its title and "Answer on the desk phone" only, with nothing to tap or type.
import assert from 'node:assert/strict';

// a snip: an 8 × 6 red PNG
const RED =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR4nGN4ZmODFTEMpAQAW3NBof5buBkAAAAASUVORK5CYII=';
const CARD = `Both halves read well alone. Which stays?

Choose:
- The kiln is lit again: keeps the news.
- The first mugs are out: leads with what people can buy.`;

// c: book-check's { browser, hqIn, base, MINI, store, pages, notes, snips, posts, org, shot, settled, noErrorsIn }, and
// look (Wire's &renderer=wire, or '' for Brownstone)
export async function askStory(c) {
  const at = '/?intro=0',
    f = fixtures(c, at),
    context = await c.hqIn(c.browser, c.MINI),
    s = { ...c, ...f, answered: [] };
  await played(s, context);
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`${c.base}${at}${c.look}`);
    await page.waitForSelector('#loading.gone');
    assert.equal(await page.evaluate(() => document.body.classList.contains('brownstone')), !c.look, 'the look');
    await c.settled(page, 'open');
    await onTheDeskPhone(s, page);
    await answeredInTheBook(s, page);
    c.noErrorsIn(errors);
  } finally {
    c.pages.splice(c.pages.indexOf(f.sheet), 1);
    await context.close();
  }
}

// The CEO's sheet page for HQ's page, two of the board's notes sent to the CEO, a card about each: one with choices,
// one with a key field; and a card about the page itself
function fixtures(c, at) {
  const ceo = c.org.company.ceo,
    name = ceo[0].toUpperCase() + ceo.slice(1),
    sheet = { id: 9400, day: '2026-10-26', kind: 'sheet', owner: ceo, url: at, w: 700, h: 900 };
  const ask = askOf(ceo, name),
    onPage = {
      ...ask(9603, 'The banner: keep it?', { body: 'Keep the banner?\n\nOptions: Keep | Drop', page: at }),
      on: sheet.id,
    },
    choose = ask(9601, 'Gazette headline: which half stays?'),
    keyed = ask(9602, 'The gazette feed’s key', { kind: 'credential', body: 'The key for the feed.', desk: true });
  const note = noteOf(sheet, at),
    headline = note(9401, 1, 'Too long: half this', [choose]),
    feed = note(9402, 2, 'Hook the feed up', [keyed]);
  c.pages.push(sheet);
  c.snips.set(headline.id, RED).set(feed.id, RED);
  const sentSheet = {
    id: 9500,
    owner: ceo,
    name: null,
    status: 'sent',
    sent: new Date().toISOString(),
    notes: [headline, feed],
  };
  // the card as the desk phone lists it, with its place (bookasks.ts card)
  const card = {
    ...{ id: choose.id, agent: ceo, kind: 'decision', title: choose.title, body: CARD, urgency: 'whenever' },
    ...{ status: 'open', created: new Date().toISOString(), topic: 'gazette' },
    place: {
      url: at,
      page: sheet.id,
      day: '2026-10-26',
      note: headline.id,
      n: 1,
      owner: ceo,
      words: headline.words,
      snip: headline.snip,
    },
  };
  return { ceo, name, sheet, choose, keyed, onPage, headline, feed, sentSheet, card };
}
// A card about a note as the book reads it (bookasks.ts askOf)
const askOf =
  (agent, name) =>
  (id, title, more = {}) => ({
    ...{ id, agent, name, kind: 'decision', title, body: CARD, questions: null, page: null },
    ...{ status: 'open', answer: null, answered: null, desk: false, ...more },
  });
// A note of the board's on the sheet page, sent, its mark a line across, with the cards about it
const noteOf = (sheet, at) => (id, n, words, asks) => ({
  ...{ id, n, page: sheet.id, words, said: 'typed', by: 'board', snip: `/api/book/snip?id=${id}`, status: 'sent' },
  ...{ slips: [], links: [], asks },
  anchor: {
    ...{ v: 1, url: at, el: null, view: { w: 1133, h: 744, x: 0, y: 0, dpr: 2 } },
    ink: [
      {
        color: '#ff5a5f',
        size: 5,
        points: Array.from({ length: 21 }, (_, i) => [220 + i * 10, 300 + n * 200, 0.5, i * 16]),
      },
    ],
  },
});

// The sheets with the sent one, the desk phone's cards, and its answer route, played (a later route wins over hqIn's)
async function played(s, context) {
  await context.route(`${s.base}/api/book/sheets`, r => {
    const listed = s.store('/api/book/sheets', null, new URLSearchParams());
    return r.fulfill({ json: { ...listed, sent: [s.sentSheet, ...listed.sent], asks: [s.onPage] } });
  });
  await context.route(`${s.base}/api/requests`, r => r.fulfill({ json: s.choose.status === 'open' ? [s.card] : [] }));
  await context.route(`${s.base}/api/requests/answer`, r => {
    const body = r.request().postDataJSON();
    s.answered.push(body);
    const card = [s.choose, s.onPage].find(a => a.id === body.id && a.status === 'open');
    if (!card) return r.fulfill({ status: 404, json: { error: 'not found' } });
    Object.assign(card, { status: 'answered', answer: body.answer, answered: new Date().toISOString() });
    return r.fulfill({ json: { ok: true } });
  });
}

// The desk phone's card: On the page, with the note's snip and words, and Open in the book landing on the note, lit
async function onTheDeskPhone(s, page) {
  await page.evaluate(() => import('/shell/desk.js').then(m => m.openPhone()));
  await page.waitForSelector('#phone-screen h3');
  const strip = page.locator('#phone-screen .on-page');
  await strip.waitFor({ timeout: 3000 });
  const said = await strip.innerText();
  assert.match(said, /On the page/i);
  assert.match(said, new RegExp(`Your note 1 for ${s.name}, on HQ: “Too long: half this”`));
  assert.equal(await strip.locator('img').getAttribute('src'), s.headline.snip);
  assert.ok(await strip.locator('img').evaluate(img => img.complete && img.naturalWidth > 0), 'the snip shows');
  await page.waitForTimeout(500); // (the phone's pop-in)
  await s.shot('ask-desk', page);
  // (the number lit as the book lands, which goes again once its glow is over)
  await page.evaluate(() => {
    window.lit = [];
    new MutationObserver(list => {
      for (const m of list)
        if (m.target.hasAttribute('data-lit')) window.lit.push(Number(m.target.closest('.bs-note')?.dataset.id));
    }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['data-lit'] });
  });
  await strip.getByRole('button', { name: 'Open in the book' }).click();
  await s.settled(page, 'open');
  await page.waitForFunction(id => window.lit.includes(id), s.headline.id, { timeout: 4000 });
  const seen = await page.evaluate(id => {
    const note = document.querySelector(`#book .bs-note[data-id="${id}"]`).getBoundingClientRect(),
      paper = document.querySelector('#book .bk-paper').getBoundingClientRect();
    return { top: note.top, bottom: note.bottom, paperTop: paper.top, paperBottom: paper.bottom };
  }, s.headline.id);
  assert.ok(seen.top >= seen.paperTop && seen.top < seen.paperBottom, `the note in view: ${JSON.stringify(seen)}`);
}

// In the book: the card under its note, a choice tapped there answers it, the desk phone has nothing waiting; the key
// card only says where it's answered
async function answeredInTheBook(s, page) {
  const slip = page.locator(`#book .bs-note[data-id="${s.headline.id}"] .ask-slip`);
  await slip.waitFor({ timeout: 4000 });
  const said = await slip.innerText();
  assert.match(said, new RegExp(`${s.name} asks`));
  assert.match(said, /Both halves read well alone\. Which stays\?/);
  assert.match(said, /The same card is on your desk phone/);
  const chips = slip.getByRole('button', { name: 'The kiln is lit again' });
  assert.equal(await slip.locator('[data-choice]').count(), 2, 'its two choices as chips');
  const keyed = page.locator(`#book .bs-note[data-id="${s.feed.id}"] .ask-slip`);
  assert.match(await keyed.innerText(), /The gazette feed’s key[\s\S]*Answer on the desk phone/);
  assert.equal(await keyed.locator('button, textarea, input').count(), 0, 'nothing to tap or type for a key');
  await slip.scrollIntoViewIfNeeded();
  await s.shot('ask-book', page);
  // a card about the page itself (hq ask --page): the agent's ring in its ink round what it's about, the card under it
  const ringed = page.locator('#book .ask-on', { hasText: 'The banner' });
  assert.match(await ringed.innerText(), new RegExp(`${s.name} asks about HQ, /\\?intro=0[\\s\\S]*Keep[\\s\\S]*Drop`));
  assert.equal(await ringed.locator('[data-choice]').count(), 2);
  const ink = await ringed.locator('.ask-ring path').evaluate(p => getComputedStyle(p).stroke);
  assert.notEqual(ink, 'rgb(42, 35, 82)', "the agent's ink, not the book's");
  await ringed.scrollIntoViewIfNeeded();
  await s.shot('ask-page', page);
  // (answered, the book reads its sheets again and draws the page anew: the story goes on once it has)
  const reread = page.waitForResponse(r => r.url().endsWith('/api/book/sheets'));
  await ringed.getByRole('button', { name: 'Keep' }).click();
  await ringed.locator('.ask-answer').waitFor({ timeout: 4000 });
  await reread;
  await page.waitForTimeout(300);
  assert.deepEqual(s.answered.at(-1), { ...s.answered.at(-1), id: s.onPage.id, answer: 'Keep' });
  s.answered.length = 0;
  await slip.scrollIntoViewIfNeeded();

  await chips.click();
  await slip.locator('.ask-answer').waitFor({ timeout: 4000 });
  assert.deepEqual(
    s.answered.map(a => [a.id, a.answer]),
    [[s.choose.id, 'The kiln is lit again']],
    "the desk phone's own answer",
  );
  assert.match(await slip.innerText(), /The kiln is lit again/);
  assert.equal(await slip.locator('[data-choice]').count(), 0, 'answered: nothing left to tap');
  // the sheets read again keep it answered under its note; the desk phone has nothing waiting
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('book:changed')));
  await page.waitForTimeout(600);
  assert.match(await slip.innerText(), /The kiln is lit again/);
  await s.shot('ask-answered', page);
  await page.evaluate(() => import('/shell/desk.js').then(m => m.openPhone()));
  await page.waitForSelector('#phone-screen .quiet', { timeout: 4000 });
}

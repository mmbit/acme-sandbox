// book-check.mjs's pin story (shared/review/dock.js, menu.js, postit.js; shell/desk.js), held like an iPad mini in
// landscape, on book-check's played store.
// On HQ the book is the pin's summon: with the book open beside the page the pin shows and takes a tap; folded away, it
// goes (nothing left to tap where it was); opened again, it's back. Where a note goes is one truth: a ring on HQ's own
// page (nothing there names an owner, as on the desk phone's card in the board's picture) lands on Juno's sheet, and
// review mode's menu then names Juno too; a ring on something an agent owns lands on their sheet, and the menu
// follows. Carried and let go, the pin stays exactly where
// it's dropped, the same button while it's held (pincheck.mjs).
import assert from 'node:assert/strict';
import { carried } from '../../shared/review/pincheck.mjs';
import { foldBySpine } from './bookchrome.mjs';

const ui = s => `review-mode >> css=${s}`;

// c: book-check's { browser, hqIn, base, MINI, settled, shot, posts, pages, org, penOn, ring, noErrorsIn }, and look
// ('&renderer=wire' for Wire)
export async function pinStory(c) {
  const context = await c.hqIn(c.browser, c.MINI),
    asked = [];
  // (review mode's menu reads whose sheet from the coordinator: the stand-in answers for the owner the menu asks for,
  // the page's own being the CEO's, as feedback.test.ts holds the real one to)
  await context.route(/\/__review\/mine(\?.*)?$/, r => {
    const owner = new URL(r.request().url()).searchParams.get('owner') ?? c.org.company.ceo;
    asked.push(owner);
    r.fulfill({ json: { book: { owner, name: nameOf(c, owner) }, notes: 1, list: [], sent: false, more: false } });
  });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`${c.base}/?intro=0${c.look}`);
    await page.waitForSelector('#loading.gone');
    await page.waitForSelector('review-mode .fab', { state: 'attached' });
    await c.settled(page, 'open');
    assert.equal(await page.evaluate(() => document.body.classList.contains('brownstone')), !c.look, 'the look');
    await summoned(c, page);
    const ceo = nameOf(c, c.org.company.ceo);
    await noted(c, page, asked, { ring: [300, 300], owner: c.org.company.ceo, name: ceo, look: 'pin-ceo' });
    // something an agent owns on HQ's page, as a thread's tile names it
    const agent = c.org.departments.flatMap(d => d.agents).find(a => a.id !== c.org.company.ceo);
    await page.evaluate(id => {
      const tile = Object.assign(document.createElement('button'), { textContent: 'A thread of theirs' });
      tile.dataset.owner = id;
      tile.style.cssText = 'position:fixed;left:120px;top:440px;width:200px;height:90px;z-index:5';
      document.body.append(tile);
    }, agent.id);
    await noted(c, page, asked, { ring: [220, 485], owner: agent.id, name: agent.name, look: 'pin-agent' });
    // carried up and left with a mouse and let go, it stays exactly there; held, the same button, a grab hand over it
    assert.deepEqual(await carried(page, [-160, -220]), [], 'the pin carried and let go');
    await c.shot('pin-dropped', page);
    c.noErrorsIn(errors);
  } finally {
    await context.close();
  }
}

const nameOf = (c, id) => c.org.departments.flatMap(d => d.agents).find(a => a.id === id)?.name ?? id;

// The pin as the board sees it: shown, and what a tap there lands on, review mode or HQ's page
const pinSeen = page =>
  page.evaluate(() => {
    const fab = document.querySelector('review-mode').shadowRoot.querySelector('.fab'),
      b = fab.getBoundingClientRect(),
      at = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return { shows: fab.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }), tapped: at?.localName };
  });

// Open, the book summons the pin; folded, it's gone and a tap there is HQ's; opened, it's back, quickly
async function summoned(c, page) {
  let seen = await pinSeen(page);
  assert.deepEqual(seen, { shows: true, tapped: 'review-mode' }, 'the open book summons the pin');
  await c.shot('pin-open', page);
  await foldBySpine(page);
  await c.settled(page, 'folded');
  // (its fade is 0.2 s; headless frames under load come late)
  for (let i = 0; i < 15 && (seen = await pinSeen(page)).shows; i++) await page.waitForTimeout(100);
  assert.equal(seen.shows, false, 'folded, the pin is away');
  assert.notEqual(seen.tapped, 'review-mode', 'folded, a tap where the pin was is the page’s');
  await c.shot('pin-folded', page);
  await page.click('#book .bk-lip');
  await c.settled(page, 'open');
  for (let i = 0; i < 15 && !(seen = await pinSeen(page)).shows; i++) await page.waitForTimeout(100);
  assert.deepEqual(seen, { shows: true, tapped: 'review-mode' }, 'the book opened again, the pin is back');
}

// A ring with the pen, rested: the note on that owner's page, and the menu naming the same (no post-it: it goes as it
// settles.)
async function noted(c, page, asked, { ring, owner, name, look }) {
  const from = c.posts.length;
  await c.penOn(page)(c.ring(ring[0], ring[1], 70, 40));
  for (let i = 0; i < 80 && !c.posts.slice(from).some(p => p.path === '/api/book/note'); i++)
    await page.waitForTimeout(100);
  assert.equal(await page.locator(ui('.sheet')).isHidden(), true, 'no post-it');
  await c.shot(look, page);
  const sent = c.posts.slice(from).find(p => p.path === '/api/book/note')?.body,
    on = c.pages.find(p => p.id === sent?.page);
  assert.equal(on?.owner, owner, `the note is on ${name}'s sheet`);
  await page.waitForTimeout(800); // (its lift into the book)
  // the menu, as the board opens it: whose sheet it names is the one the note went to
  const ask = asked.length;
  await page.locator(ui('.more')).dispatchEvent('click');
  await page.waitForSelector(ui('.menu:not([hidden])'));
  for (let i = 0; i < 30 && asked.length === ask; i++) await page.waitForTimeout(100);
  assert.equal(asked.at(-1), owner, `the menu asks for ${name}'s sheet`);
  await page.waitForFunction(
    want =>
      document.querySelector('review-mode').shadowRoot.querySelector('[data-open-book]').textContent.includes(want),
    `In your book, for ${name}`,
    { timeout: 5000 },
  );
  await c.shot(`${look}-menu`, page);
  await page.keyboard.press('Escape');
}

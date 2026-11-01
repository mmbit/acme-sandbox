// The Notebook for book-check's answers stories (bookanswers.mjs): a story's own seed of the store, a page with the
// board's groups and the agents' answers on them, played by HQ's one stand-in (notebookroute.mjs on a notebookPlay(),
// hqIn's notebooks) and changed mid-story through that play; HQ opened on it; what hangs under a note's unit measured
// against it; a stroke as Safari hands a pen's over; a note tried in versions.
import assert from 'node:assert/strict';
import { boxOf } from './shell/ink/notebookstack.js';

// How long a story waits on what the store brings (a face, an answer, a reply drawn) or the pen writes in: HQ reads
// its page again only once the store's event reaches it, and on a loaded machine under the 3D scene that read comes
// seconds late, not missing. A bound for something broken, never a pace: a story waits on the state itself.
export const FEED_MS = 20_000;

// ---- the story's Notebook: My journal with one page (p, numbered clear of the old book's; page: its own columns, a
// call's kind and label), the board's typed groups on it and the agents' answers, as the store keeps them
// (notebookplay.js's seed)
export function notebookOn(c, page = {}) {
  const ceo = c.org.company.ceo,
    name = c.org.agents?.[ceo]?.name ?? ceo,
    at = Date.now(),
    T = new Date(at).toISOString();
  const p = { id: 9500, notebook: 1, pos: 0, created: T, updated: T, w: 1200, h: 1600, ...page };
  const seed = {
    notebooks: [{ id: 1, kind: 'mine', name: 'My journal', created: T, updated: T }],
    pages: [p],
    groups: [],
    slips: [],
    names: { [ceo]: name },
  };
  // (a group's box as the store reads it from its parts: notebookstack.js boxOf. Seeded as a unit already, h its
  // parts' foot, so the store keeps them where the story wrote them)
  const typed = (id, words, x, y) => ({
    ...{ id, page: p.id, kind: 'drawing', ink: [], texts: [{ x, y, w: 260, color: '#2b2230', text: words }] },
    ...{ words, said: 'typed', created: T, updated: T },
    get box() {
      return boxOf({ ink: this.ink, texts: this.texts, pictures: [] });
    },
    get h() {
      return Math.ceil(this.box.y + this.box.h);
    },
  });
  // An agent's answer on group g, without an id, as the store keeps one: no spot, slipped under its note. A seeded
  // answer gives its own ({ id, ...answer(…) }), and play.answer gives one to an answer that lands mid-story.
  let made = 0;
  const answer = (g, style, text, more = {}) => ({
    grp: g.id,
    by: ceo,
    style,
    text,
    created: new Date(at + ++made).toISOString(),
    ...more,
  });
  return { p, ceo, name, seed, groups: seed.groups, typed, answer };
}
// HQ on the story's Notebook at a size, the book open on its page; play: the store it's opened on. book: a desktop's
// book spread this wide (CSS px) beside HQ's page, its columns side by side
export async function opened(browser, c, viewport, nb, { book, ...options } = {}) {
  const context = await c.hqIn(browser, viewport, { ...options, notebooks: nb.seed });
  if (book)
    await context.addInitScript(
      w => localStorage.setItem('hq.book.wide', JSON.stringify({ mode: 'open', book: w })),
      book,
    );
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${c.base}/?intro=0`);
  await page.waitForSelector('#loading.gone');
  // A phone's book comes to rest folded, an iPad's upright too: its lip opens it as the spread. The lip's own click, in
  // the page: on a loaded worker Playwright's waits on it for longer than its timeout.
  await page.waitForFunction(
    () => document.documentElement.dataset.book && !document.querySelector('#book.bk-swinging'),
    null,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(c.settle);
  if ((await page.evaluate(() => document.documentElement.dataset.book)) === 'folded') {
    await page.evaluate(() => document.querySelector('#book .bk-lip').click());
    await page.waitForFunction(
      () => document.documentElement.dataset.book !== 'folded' && !document.querySelector('#book.bk-swinging'),
      null,
      { timeout: 60_000 },
    );
  }
  await page.waitForSelector('#book .bk-answers', { state: 'attached', timeout: 60_000 });
  return { page, errors, play: context.notebook, done: () => context.close() };
}
// Group g's children (its answers and the board's replies) as the store reads them now
export const childrenOf = (play, g) =>
  play.route('/api/notebooks/pages/groups', { page: g.page }).groups.find(x => x.id === g.id).children;
export const layer = page => page.locator('#book .bk-answers');
// What hangs under group g's unit (selector, in its .bk-under) as the page draws it on the screen, settled: its box the
// same two frames running, the page done laying it out. With its unit's box and what it must keep clear of: every other
// unit and what hangs under each.
export async function underUnit(page, g, selector) {
  const sel = `#book .bk-under[data-g="${g.id}"] ${selector}`;
  await page.waitForFunction(
    sel => {
      const box = () => JSON.stringify(document.querySelector(sel)?.getBoundingClientRect());
      const before = box();
      return new Promise(go => requestAnimationFrame(() => requestAnimationFrame(() => go(box() === before))));
    },
    sel,
    { timeout: FEED_MS },
  );
  return page.evaluate(
    ([id, sel]) => {
      const box = el => {
          const r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        },
        unit = document.querySelector(`#book .bk-unit[data-unit="${id}"]`),
        at = document.querySelector(sel);
      const others = [...unit.closest('.bk-page').querySelectorAll('.bk-unit[data-unit], .bk-under[data-g]')]
        .filter(el => (el.dataset.unit ?? el.dataset.g) !== String(id))
        .map(el => ({ id: el.dataset.unit ?? el.dataset.g, ...box(el) }));
      return { at: at && box(at), unit: box(unit), others };
    },
    [g.id, sel],
  );
}
// Two boxes on the screen that share some of it
const overlapping = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
// What hangs under group g's unit (selector, in its .bk-under) where the board reads it at every width: under the unit
// and in its column (a slip's half-degree tilt aside), clear of every other unit and what hangs under it, and on the
// paper left of the tools
export async function underItsNote(page, g, selector) {
  const { at, unit, others } = await underUnit(page, g, selector),
    shown = JSON.stringify({ at, unit });
  assert.ok(at.top >= unit.bottom, `under its note's unit: ${shown}`);
  assert.ok(at.left >= unit.left - TILT && at.right <= unit.right + TILT, `in its unit's column: ${shown}`);
  for (const o of others) assert.ok(!overlapping(at, o), `clear of ${o.id} at ${JSON.stringify(o)}: ${shown}`);
  await clearOfTools(page, `.bk-under[data-g="${g.id}"] ${selector}`);
}
// (how far past its column a slip's tilt takes its corners, screen px: shared/review/slip.js rotates it half a degree)
const TILT = 3;
// Every element at selector in the book left of the tools floating at the paper's right, the islands' stack and the
// tool strip beside it
export async function clearOfTools(page, selector) {
  const tools = await page
      .locator('#book .bk-column .bk-island')
      .evaluateAll(els => Math.min(...els.filter(el => el.offsetWidth).map(el => el.getBoundingClientRect().left))),
    rights = await page
      .locator(`#book ${selector}`)
      .evaluateAll(els => els.map(el => el.getBoundingClientRect().right));
  assert.ok(rights.length && rights.every(x => x <= tools), `clear of the tools: ${JSON.stringify([rights, tools])}`);
}
// A stroke in screen px, as Safari hands a pen's over (or a mouse's, on a desktop); pace: ms between its points, as a
// hand draws it (0, at once)
export async function stroke(page, points, type = 'pen', pace = 0) {
  await page.evaluate(
    async ([pts, type, pace]) => {
      const at = (kind, [x, y], pressure) =>
        (document.elementFromPoint(x, y) ?? document.body).dispatchEvent(
          new PointerEvent(kind, {
            pointerId: 9,
            pointerType: type,
            isPrimary: true,
            clientX: x,
            clientY: y,
            pressure,
            buttons: kind === 'pointerup' ? 0 : 1,
            bubbles: true,
            composed: true,
            cancelable: true,
          }),
        );
      at('pointerdown', pts[0], 0.5);
      for (const p of pts.slice(1)) {
        if (pace) await new Promise(res => setTimeout(res, pace));
        at('pointermove', p, 0.5);
      }
      at('pointerup', pts.at(-1), 0);
    },
    [points, type, pace],
  );
}
// (a version's frame: an 8 × 6 picture, as the try run shoots them)
const RED =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR4nGN4ZmODFTEMpAQAW3NBof5buBkAAAAASUVORK5CYII=';
// A board's note tried in versions: the played Notebook, the note (its try going, three versions said) and a version
// made on it (A, B, C… as they come: its screenshot and its staging preview's address), as notebookOn's answer is
// (bookanswers.mjs and bookpicks.mjs). page: its page's own columns (notebookOn). version() returns an answer without
// an id, as answer() does: a seeded version gives its own, and play.answer gives one to a version made mid-story.
export function triedNote(c, page = {}) {
  const nb = notebookOn(c, page),
    warmer = nb.typed(4400, 'warmer?', 60, 60);
  warmer.tried = { by: nb.ceo, expect: 3, going: true };
  const version = (name, picture = RED) => {
    const slug = name.toLowerCase().replace(/\W+/g, '-');
    return nb.answer(warmer, 'version', `${name}, as it would look`, {
      ...{ version: name, picture, link: `https://try-${slug}.preview.example.com/`, branch: `try/${slug}` },
    });
  };
  nb.groups.push(warmer);
  return { nb, warmer, version };
}

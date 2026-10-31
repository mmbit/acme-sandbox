// The Notebook for book-check's answers stories (bookanswers.mjs): a story's own seed of the store, a page with the
// board's groups and the agents' answers on them, played by HQ's one stand-in (notebookroute.mjs on a notebookPlay(),
// hqIn's notebooks) and changed mid-story through that play; HQ opened on it; an element of the answers' layer measured
// in its page's px; a stroke as Safari hands a pen's over; the four symbols; a note tried in versions.
import { answerSpot } from '../coordinator/src/ink/answerspot.ts';
import { boxOf } from './shell/ink/notebookstack.js';

// How long a story waits on what the store brings (a face, an answer, a reply drawn) or the pen writes in: HQ reads
// its page again only once the store's event reaches it, and on a loaded machine under the 3D scene that read comes
// seconds late, not missing. A bound for something broken, never a pace: a story waits on the state itself.
export const FEED_MS = 20_000;
// The paper a desktop's book spread wide shows, as the store places answers for it (answerspot.ts)
const WIDE = { x: 0, w: 1200 };
// Where the store places an answer holding a (answerspot.ts Contents) on group g: clear of the page's groups, beside it
// on a wide book, with its narrow spot (right of the tool strip) where the book is narrower
export const placed = (nb, g, a) =>
  answerSpot(
    g.box,
    a,
    nb.groups.map(x => x.box),
    WIDE,
  );

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
  // parts' foot, so the store keeps them where the story wrote them: the answers layer reads that box in its page's px)
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
  // An agent's answer on group g, without an id. A seeded answer gives its own ({ id, ...answer(…) }), and play.answer
  // gives one to an answer that lands mid-story.
  let made = 0;
  const answer = (g, style, text, spot, more = {}) => ({
    grp: g.id,
    by: ceo,
    style,
    text,
    spot,
    created: new Date(at + ++made).toISOString(),
    ...more,
  });
  return { p, ceo, name, seed, groups: seed.groups, typed, answer };
}
// HQ on the story's Notebook at a size, the book open on its page; play: the store it's opened on
export async function opened(browser, c, viewport, nb, options = {}) {
  const context = await c.hqIn(browser, viewport, { ...options, notebooks: nb.seed });
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
// An element of the answers' layer in its page's px (its page's layer sits at the page's origin, scaled with it)
export const pagePx = (page, selector) =>
  page.evaluate(sel => {
    const el = document.querySelector(`#book .bk-answers ${sel}`),
      root = el?.closest('.bk-answers');
    if (!el || !root) return null;
    const r = el.getBoundingClientRect(),
      o = root.getBoundingClientRect(),
      k = root.offsetWidth ? o.width / root.offsetWidth : 1;
    return { x: (r.left - o.left) / k, y: (r.top - o.top) / k, w: r.width / k, h: r.height / k };
  }, selector);
// An element of the answers' layer on screen, with the paper the book shows, the controls' islands floating at its
// right edge and the tool strip over its left
export const onScreen = (page, selector) =>
  page.evaluate(sel => {
    const box = el => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    };
    const el = document.querySelector(`#book .bk-answers ${sel}`);
    return {
      at: el && box(el),
      paper: box(document.querySelector('#book .bk-desk')),
      rail: [...document.querySelectorAll('#book .bk-column .bk-island')].filter(i => i.offsetWidth).map(box),
      strip: box(document.querySelector('#book .bk-strip')),
    };
  }, selector);
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
// The four symbols, drawn in a box (x, y: its top-left, s: its size), screen px
export const SYMBOLS = {
  tick: (x, y, s) => [
    [x, y + s * 0.55],
    [x + s * 0.2, y + s * 0.75],
    [x + s * 0.35, y + s * 0.95],
    [x + s * 0.6, y + s * 0.5],
    [x + s, y],
  ],
  krul: (x, y, s) =>
    Array.from({ length: 24 }, (_, i) => {
      const t = i / 23,
        a = t * Math.PI * 3;
      return [x + t * s + Math.cos(a) * s * 0.15, y + s * 0.5 - Math.sin(a) * s * 0.3 - t * s * 0.3];
    }),
  cross: (x, y, s) => [
    [x, y],
    [x + s * 0.5, y + s * 0.5],
    [x + s, y + s],
  ],
  question: (x, y, s) => [
    [x + s * 0.2, y + s * 0.25],
    [x + s * 0.5, y],
    [x + s * 0.8, y + s * 0.25],
    [x + s * 0.5, y + s * 0.55],
    [x + s * 0.5, y + s * 0.75],
  ],
};

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
    return nb.answer(warmer, 'version', `${name}, as it would look`, null, {
      ...{ version: name, picture, link: `https://try-${slug}.preview.example.com/`, branch: `try/${slug}` },
    });
  };
  nb.groups.push(warmer);
  return { nb, warmer, version };
}

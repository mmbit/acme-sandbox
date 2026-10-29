// The played Notebook for book-check's answers stories (bookanswers.mjs): a
// page's groups and their children, the open list and HQ's feed routed over book-check's store; HQ opened on it; an
// element of the answers' layer measured in its page's px; a stroke as Safari hands a pen's over; the four symbols; a
// note tried in versions.
import { freePage } from './bookmouse.mjs';
import { answerSpot } from '../coordinator/src/ink/answerspot.ts';

// How long a story waits on what the feed brings (a face, an answer, a reply drawn) or the pen writes in: HQ reads its
// page again only once the feed's event reaches it, and on a loaded machine under the 3D scene that read comes seconds
// late, not missing. A bound for something broken, never a pace: a story waits on the state itself.
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

// ---- the played Notebook: a page's groups and their children, the open list, and HQ's feed
export function notebookOn(c, page) {
  const ceo = c.org.company.ceo,
    name = c.org.agents?.[ceo]?.name ?? ceo,
    groups = [],
    feed = [],
    open = { forms: [], questions: [] };
  const typed = (id, words, x, y) => ({
    id,
    page: page.id,
    kind: 'drawing',
    by: 'board',
    ink: [],
    texts: [{ x, y, w: 260, color: '#2b2230', text: words }],
    pictures: [],
    words,
    said: 'typed',
    status: 'open',
    note: null,
    box: { x, y, w: 260, h: 40 },
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    anchor: null,
    owner: null,
    owner_name: null,
    children: [],
  });
  const answer = (id, style, text, spot, more = {}) => ({
    kind: 'answer',
    id,
    by: ceo,
    name,
    style,
    text,
    picture: null,
    ink: null,
    form: null,
    form_answer: null,
    version: null,
    spot,
    ticked: null,
    picked: null,
    created: new Date().toISOString(),
    ...more,
  });
  const tell = () => feed.push({ type: 'book', agent: ceo, text: 'notebook', page: page.id });
  return { ceo, name, groups, feed, open, typed, answer, tell };
}
// The story's notebook routed in the browser: the feed, the page's groups and the answers' routes (more: a story's own)
export async function routed(context, c, nb, more = {}) {
  await context.route(`${c.base}/api/events`, r =>
    r.fulfill({
      contentType: 'text/event-stream',
      body: `retry: 150\n\n${nb.feed
        .splice(0)
        .map(e => `data: ${JSON.stringify(e)}\n\n`)
        .join('')}`,
    }),
  );
  await context.route(/\/api\/notebooks/, r => {
    const url = new URL(r.request().url()),
      body = r.request().method() === 'POST' ? r.request().postDataJSON() : null;
    if (body) c.posts.push({ path: url.pathname, body });
    // (a story's own answer to a route first: a reply's stand-in judge.)
    const own = more[url.pathname];
    if (own) return r.fulfill({ json: own(url, body) });
    if (url.pathname === '/api/notebooks/pages/groups') {
      const id = +url.searchParams.get('page'),
        tried = nb.groups.find(g => g.tries_page === id);
      // (a versions page: the group it tries, and its versions among that group's children)
      if (tried) return r.fulfill({ json: { page: id, groups: [], tries: tried.id, tried } });
      return r.fulfill({ json: { page: id, groups: nb.groups.filter(g => g.page === id) } });
    }
    if (url.pathname === '/api/notebooks/open') return r.fulfill({ json: nb.open });
    if (url.pathname === '/api/notebooks/groups/reply')
      return r.fulfill({ json: { id: 9000 + c.posts.length, parent: 0 } });
    if (url.pathname === '/api/notebooks/answers/form') return r.fulfill({ json: { ok: true } });
    return r.fallback();
  });
}
// HQ on the played store at a size, the book open on its last page (the one the story made)
export async function opened(browser, c, viewport, nb, options = {}, more = {}) {
  const context = await c.hqIn(browser, viewport, options);
  await routed(context, c, nb, more);
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${c.base}/?intro=0`);
  await page.waitForSelector('#loading.gone');
  await c.settled(page, 'open');
  // (a phone's book starts folded, an iPad's upright too: its lip opens it as the spread. The lip's own
  // click, in the page: on a loaded worker Playwright's waits on it for longer than its timeout; then the book open,
  // however late its swing.)
  if ((await page.evaluate(() => document.documentElement.dataset.book)) === 'folded') {
    await page.evaluate(() => document.querySelector('#book .bk-lip').click());
    await page.waitForFunction(
      () => document.documentElement.dataset.book !== 'folded' && !document.querySelector('#book.bk-swinging'),
      null,
      { timeout: 60_000 },
    );
  }
  await page.waitForSelector('#book .bk-answers', { state: 'attached', timeout: 60_000 });
  return { page, errors, done: () => context.close() };
}
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
      rail: [...document.querySelectorAll('#book .bk-islands .bk-island')].filter(i => i.offsetWidth).map(box),
      strip: box(document.querySelector('#book .bk-strip')),
    };
  }, selector);
export const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
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
// A board's note tried in versions: its page (p), its versions page made after it (tries, the one the book opens on),
// the played Notebook on them, the note, a version made, and the store's routes listing the pages (bookanswers.mjs and
// bookpicks.mjs, out of bookanswers.mjs)
export function triedNote(c) {
  const p = freePage(c),
    tries = freePage(c),
    nb = notebookOn(c, p),
    warmer = nb.typed(4400, 'warmer?', 60, 60);
  Object.assign(tries, { label: `${nb.name} tries: warmer?`, tries: warmer.id });
  warmer.tries_page = tries.id;
  const version = (id, name, picture = RED) =>
    nb.answer(id, 'version', `${name}, as it would look`, null, { version: name, picture });
  nb.groups.push(warmer);
  // (made a minute apart in order, the versions page last: the book lands on the newest.)
  const tile = (x, i) => ({
    id: x.id,
    title: x.label || 'Free page',
    tries: x.tries ?? null,
    sent: null,
    sending: false,
    archived: false,
    groups: 0,
    created: new Date(Date.UTC(2026, 0, 1, 9, i)).toISOString(),
  });
  const listed = () => ({
    notebook: { id: 1, name: 'My Notebook', kind: 'mine', archived: false },
    pages: c.pages.map(tile),
    archived: [],
  });
  const more = {
    '/api/notebooks': () => ({ shelf: [listed().notebook], archive: [] }),
    '/api/notebooks/pages': listed,
  };
  return { p, tries, nb, warmer, version, more };
}

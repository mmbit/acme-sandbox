// book-check.mjs's call story, its part on the agent's own ink and what it opens (bookcall.mjs runs it): a ring lands
// where the agent aimed on its picture of the board's screen, in its own ink with its words and never in the book; the
// projects view it opens is all the board sees, and a ring lands round a tile there; a preview it opens the same
// (the preview)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { heard } from './bookcall.mjs';

// The agent's ink: a ring where it aimed on its picture of the board's screen (a box in fractions of it), drawn there in
// its own colour with its words, round what's there whatever words it shows, and never in the book
export async function theirInk(s) {
  const { page } = s;
  const target = await page.evaluate(() => {
    const el = [...document.querySelectorAll('#hud button, #hud a')].find(
      e => e.offsetWidth && /^[A-Za-z][\w ]{2,20}$/.test(e.textContent.trim()),
    );
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height, W: innerWidth, H: innerHeight };
  });
  const notes = s.posts.filter(p => p.path === '/api/book/note').length;
  s.line.send({ type: 'ink', id: 2, at: aim(target), words: 'or this one?' });
  assert.deepEqual(await heard(s, 'inked', e => e.id === 2), { type: 'inked', id: 2, drawn: true });
  const ring = await ringNow(page);
  await s.shot(s.named('book-call-ink'), page);
  assert.ok(round(ring, target), `the ring round where it aimed (${JSON.stringify({ ring, target })})`);
  const name = await page.evaluate(() =>
    document.querySelector('.callbubble').getAttribute('aria-label').replace('Call with ', ''),
  );
  assert.equal(ring.words, `${name}: or this one?`, 'its words beside it, with its name');
  assert.notEqual(ring.color.toLowerCase(), '#ff5a5f', 'never in the board’s red');
  assert.equal(s.posts.filter(p => p.path === '/api/book/note').length, notes, 'nothing of it in the book');
}
// A box on the screen (px) as the agent aims at it on its picture: fractions of the screen
const aim = ({ x, y, w, h, W, H }) => ({ x: x / W, y: y / H, width: w / W, height: h / H });
// The agent's newest ring on HQ's page: its loop's box, its words and its ink
async function ringNow(page) {
  await page.waitForFunction(() => document.querySelector('.hq-ring:last-of-type svg path'));
  await page.waitForTimeout(1000); // (drawn as a hand would)
  return page.evaluate(() => {
    const ring = [...document.querySelectorAll('.hq-ring')].at(-1),
      boxes = [...ring.querySelectorAll('svg path')].map(p => p.getBoundingClientRect());
    return {
      x: Math.min(...boxes.map(b => b.left)),
      y: Math.min(...boxes.map(b => b.top)),
      r: Math.max(...boxes.map(b => b.right)),
      b: Math.max(...boxes.map(b => b.bottom)),
      words: ring.querySelector('p')?.textContent,
      color: ring.style.getPropertyValue('--ink'),
    };
  });
}
const round = (ring, t) => ring.x < t.x && ring.r > t.x + t.w && ring.y < t.y && ring.b > t.y + t.h;

// The agent opens HQ's projects view on the call: the one tap leaves just the projects view, with no card
// over it and the intercom the call began on closed under it, its own close back to HQ; the agent's ring lands round
// the tile it aimed at.
export async function openedClean(s) {
  const { page } = s;
  await projectsData(s.context);
  s.line.send({ type: 'open', id: 7, what: 'the projects view', url: '/?open=projects' });
  await page.locator('#call-cards [data-card="open"] [data-open]').click();
  const opened = await heard(s, 'opened', e => e.id === 7);
  assert.deepEqual([opened.answer, opened.shown], ['open', true], 'opened, and the call sees it');
  await page.locator('#projects [data-business]').first().waitFor();
  await page.waitForTimeout(800); // (its way in)
  const after = await page.evaluate(() => ({
    cards: [...document.querySelectorAll('#call-cards [data-card]')].map(c => c.dataset.card),
    tool: !document.querySelector('#tool').hidden,
  }));
  assert.deepEqual(after, { cards: [], tool: false }, 'just the projects view: no card over it, nothing under it');
  await s.shot(s.named('book-call-opened'), page);
  const t = await page.evaluate(() => {
    const b = document.querySelector('#projects [data-business]').getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height, W: innerWidth, H: innerHeight };
  });
  s.line.send({ type: 'ink', id: 8, at: aim(t), words: '' });
  assert.equal((await heard(s, 'inked', e => e.id === 8)).drawn, true);
  assert.ok(round(await ringNow(page), t), 'the ring round the tile it aimed at');
  await page.locator('#projects').getByRole('button', { name: /Close/ }).first().click();
  await page.waitForSelector('#projects', { state: 'hidden' });
  await page.click('#btn-intercom'); // (back where the call began, for the next)
  await page.waitForSelector('#call');
}
// ...and a preview it opens the same: HQ's viewer with nothing over it and the intercom closed under it, so
// its close leaves HQ, not the intercom.
export async function openedPreview(s) {
  const { page } = s;
  await s.context.route(/\/api\/preview\/link$/, r => r.fulfill({ json: { url: r.request().postDataJSON().url } }));
  await s.context.route(`${PREVIEW}/**`, r => r.fulfill({ contentType: 'text/html', body: PREVIEW_PAGE }));
  s.line.send({ type: 'open', id: 9, what: 'the basket', url: `${PREVIEW}/basket` });
  await page.locator('#call-cards [data-card="open"] [data-open]').click();
  const opened = await heard(s, 'opened', e => e.id === 9);
  assert.deepEqual([opened.answer, opened.shown], ['open', true], 'opened, and the call sees it');
  await page.waitForSelector('#viewer:not([hidden]) iframe[src]');
  await page.waitForTimeout(800); // (its way in)
  const after = await page.evaluate(() => ({
    viewer: !document.querySelector('#viewer').hidden,
    cards: [...document.querySelectorAll('#call-cards [data-card]')].map(c => c.dataset.card),
    tool: !document.querySelector('#tool').hidden,
  }));
  assert.deepEqual(
    after,
    { viewer: true, cards: [], tool: false },
    'just the preview: no card over it, nothing under it',
  );
  await s.shot(s.named('book-call-preview'), page);
  await page.click('#viewer [data-close]');
  await page.waitForSelector('#viewer', { state: 'hidden' });
  assert.equal(await page.locator('#tool').isHidden(), true, 'its close leaves HQ, not the intercom');
  await page.click('#btn-intercom'); // (back where the call began, for the next)
  await page.waitForSelector('#call');
}
const PREVIEW = 'https://aim.preview.test';
const PREVIEW_PAGE = '<!doctype html><title>Basket</title><h1>Your basket</h1>';

// The projects view's reads, from HQ's own stand-in data
const projectsData = context =>
  context.route(/\/api\/(projects|work|room)$/, r => {
    const read = new URL(r.request().url()).pathname.split('/').at(-1);
    if (read === 'room') return r.fulfill({ json: { line: '' } });
    return r.fulfill({
      contentType: 'application/json',
      body: readFileSync(new URL(`./mock/${read}.json`, import.meta.url)),
    });
  });

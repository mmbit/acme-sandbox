// book-check.mjs's story of the test call at several sizes (shell/ink/calldraw.js, shell/callbubble.js; the board's
// call 170): on a phone both ways, an iPad mini on its side and a desktop, the call picked up over HQ, a ring drawn on
// it making the call small, the agent asking to see a page, the call's page opened in the book under Calls, and hung up;
// then a call whose notes page couldn't be opened, its page offered to throw away after the hang-up, and thrown away.
// At every step the small call and the cards stay on the screen, over none of the book's or HQ's tools, and nothing
// of theirs over the call's; the small call over nothing the board reads on the book's page shown (its heading, dates
// and scraps), and the ring (review mode's ink) under the book open over HQ, and gone with the call's layer once the
// call and its cards are. Recorded with --shots (call-<size>-<step>), to be looked at.
import assert from 'node:assert/strict';
import { playLine } from './bookcall.mjs';
import { pressAlong, until } from './bookkit.mjs';

// (a tap or a wait on the shared machine under load: taps time out at 30 s there, on main too)
const LOADED_MS = 90_000;
const SIZES = {
  phone: { width: 390, height: 844 },
  'phone-sideways': { width: 844, height: 390 },
  'ipad-mini-sideways': { width: 1133, height: 744 },
  desktop: { width: 1440, height: 900, desktop: true },
};
// What the board taps: any control of HQ's, the intercom's, the book's (its tools, tabs and lip), and review mode's pin,
// where it takes taps (not HQ's, under the open book on a phone)
const TOOLS = ['button', 'input', 'textarea', 'a[href]', '[role=button]', '#book .bk-lip', '[data-keep-clear]'];

// c: book-check.mjs's hqIn, base, shot, noErrorsIn
export function callSizesStories(c) {
  return {
    'the test call at several sizes: the small call, a ring, an ask, its page under Calls and the hang-up, over no tool':
      async browser => {
        const failed = [];
        for (const [name, size] of Object.entries(SIZES))
          await atSize(browser, c, name, size).catch(e => failed.push(e.message));
        assert.deepEqual(failed, [], failed.join('\n'));
      },
  };
}

async function atSize(browser, c, name, { desktop, ...viewport }) {
  const touch = desktop ? { hasTouch: false, isMobile: false, deviceScaleFactor: 1 } : {},
    context = await c.hqIn(browser, viewport, { notebooks: {}, ...touch }),
    line = await playLine(context),
    p = await context.newPage(),
    errors = [],
    seen = [],
    s = {
      p,
      line,
      context,
      name,
      viewport,
      shot: step => c.shot(`call-${name}-${step}`, p),
      clear: async what => seen.push(...(await overlaps(p)).map(o => `${what}: ${o}`)),
    };
  p.on('pageerror', e => errors.push(e.message));
  try {
    await p.goto(`${c.base}/?intro=0&open=intercom`);
    await p.waitForSelector('#loading.gone', { timeout: LOADED_MS });
    await p.waitForSelector('review-mode .fab', { state: 'attached', timeout: LOADED_MS });
    const notesPage = await pickedUp(p);
    await s.shot('1-call');
    await ringed(s);
    await asked(s);
    await underCalls(s, notesPage);
    // (at once: the small call's hang-up may be under something, already told)
    await p.locator('.callbubble .cb-hangup').dispatchEvent('click');
    await p.waitForSelector('.callbubble', { state: 'detached', timeout: LOADED_MS });
    await p.waitForTimeout(1500);
    await s.shot('5-hung-up');
    await thrownAway(p, c, s);
    assert.ok(
      !(await p.evaluate(() => document.querySelector('#floating').matches(':popover-open'))),
      `${name}: the call's layer closed with its call and cards gone`,
    );
    assert.deepEqual(seen, [], `the call over or under a tool:\n${seen.join('\n')}`);
    c.noErrorsIn(errors);
  } catch (e) {
    await s.shot('failed');
    e.message = `${name}: ${e.message} (page errors: ${errors.join(' | ') || 'none'})`;
    throw e;
  } finally {
    await context.close();
  }
}

// A ring round the middle of HQ's page (which narrows beside the book) while the board talks: the call goes small, and
// the ring's note goes down the line
async function ringed({ p, line, name, viewport, shot, clear }) {
  const width = await p.evaluate(() => document.body.getBoundingClientRect().width),
    [cx, cy, rx, ry] = [width / 2, viewport.height * 0.45, Math.min(120, width / 4), Math.min(50, viewport.height / 8)];
  await pressAlong(
    p,
    Array.from({ length: 48 }, (_, i) => [
      cx + rx * Math.cos((i / 44) * 2 * Math.PI),
      cy + ry * Math.sin((i / 44) * 2 * Math.PI),
    ]),
    { lift: false },
  );
  await p.waitForSelector('.callbubble', { state: 'visible', timeout: LOADED_MS });
  line.send({ type: 'heard', text: 'This one feels too big' });
  await p.waitForTimeout(100);
  await p.evaluate(() => window.__lift());
  const sent = await until(
    () => line.said.find(e => e.type === 'note'),
    `${name}: the ring's note on the line`,
    LOADED_MS,
  );
  line.send({ type: 'note', id: sent.id, state: 'received' });
  await p.waitForTimeout(1200); // (the bubble landed in its corner)
  await clear('the small call with a ring');
  await shot('2-ring');
}
// The agent asks to see a page: its card beside the small call, Not now
async function asked({ p, line, shot, clear }) {
  line.send({ type: 'ask', id: 1, what: 'the pricing page' });
  const ask = p.locator('#call-cards [data-card="ask"]');
  await ask.waitFor({ timeout: LOADED_MS });
  await p.waitForTimeout(600);
  await clear('the ask');
  await shot('3-ask');
  await ask.locator('[data-not]').click({ timeout: LOADED_MS });
  await ask.waitFor({ state: 'detached', timeout: LOADED_MS });
}
// The agent's note on the call's page, and the book opened under Calls (from its lip where it stays shut), the call
// going on
async function underCalls({ p, line, context, name, shot, clear }, notesPage) {
  context.notebook.note(notesPage, line.hello.agent, {
    texts: [{ x: 80, y: 140, w: 320, color: '#2b2230', text: 'The mugs in teal' }],
  });
  await p.waitForTimeout(1500);
  if (['folded', 'shut'].includes(await p.evaluate(() => document.documentElement.dataset.book)))
    await p.locator('#book .bk-lip').click({ timeout: LOADED_MS });
  await p.waitForFunction(() => !['folded', 'shut'].includes(document.documentElement.dataset.book), null, {
    timeout: LOADED_MS,
  });
  await p.locator('#book .bk-marks [data-chapter=calls]').click({ timeout: LOADED_MS });
  const title = () =>
    p.evaluate(() => document.querySelector('#book .bk-page:not([hidden]) .bk-page-title')?.textContent ?? '');
  await until(
    async () => /^Call with Lyra/.test(await title()),
    () => `${name}: the call's page under Calls`,
    LOADED_MS,
  );
  await p.waitForTimeout(800);
  await clear('the book open under Calls');
  await shot('4-calls');
}

// The call picked up (the call screen over HQ, its notes page made): that page's id
async function pickedUp(p) {
  const asked = p.waitForResponse(r => new URL(r.url()).pathname === '/api/notebooks/call', { timeout: LOADED_MS });
  await p.locator('#call').dispatchEvent('click');
  await p.waitForFunction(() => !document.querySelector('#call-screenshare')?.disabled, null, { timeout: LOADED_MS });
  return (await (await asked).json()).page.id;
}

// A call whose notes page couldn't be opened, drawn on: hung up, its page (in no notebook) is offered to throw away,
// and one tap does (calldraw.js pageCard)
async function thrownAway(p, c, { name, shot, clear }) {
  await p.route(`${c.base}/api/notebooks/call`, r => r.abort('failed'));
  const mark = { id: 9001, day: '2026-10-31', kind: 'call', call: 9, notebook: null, strokes: 1, pictures: 0 },
    deleted = [];
  await p.route(`${c.base}/api/book`, r =>
    r.fulfill({ json: { day: mark.day, today: mark.day, days: [], pages: [mark] } }),
  );
  await p.route(`${c.base}/api/book/page/delete`, r => {
    deleted.push(r.request().postDataJSON());
    return r.fulfill({ json: { ok: true } });
  });
  await p.locator('#call').dispatchEvent('click');
  const notes = p.locator('#call-cards [data-card="notes"]');
  await notes.waitFor({ timeout: LOADED_MS });
  await p.evaluate(mark => {
    document.dispatchEvent(new CustomEvent('pencil:note', { detail: { call: 9, page: mark.id, id: 1 } }));
  }, mark);
  await p.locator('#call-end').dispatchEvent('click');
  const card = p.locator('#call-cards [data-card="page"]');
  await card.waitFor({ timeout: LOADED_MS });
  await p.waitForTimeout(600);
  await clear('the page offered to throw away');
  await shot('6-throw-away');
  await card.locator('[data-away]').click({ timeout: LOADED_MS });
  await card.waitFor({ state: 'detached', timeout: LOADED_MS });
  assert.deepEqual(deleted, [{ id: mark.id }], `${name}: one tap throws the call's page away`);
}

// What's wrong with the small call and the call's cards where they are: off the screen, over another or over a tool
// the board taps, or something else over them (what's on top at each one's middle isn't its own); the small call over
// anything the board reads on the book's page shown (marked data-keep-in-sight: its heading, dates and scraps); review
// mode's ink lifted into the top layer with them, over the book (no dialog of HQ's is open in the story)
function overlaps(p) {
  return p.evaluate(TOOLS => {
    const shown = el => {
        const r = el.getBoundingClientRect(),
          cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
      },
      over = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1,
      name = el =>
        el.getAttribute('aria-label') || el.dataset.card || el.className.baseVal || el.className || el.localName,
      calls = [...document.querySelectorAll('.callbubble, #call-cards [data-card]')].filter(shown),
      fab = document.querySelector('review-mode')?.shadowRoot?.querySelector('.fab'),
      tools = [...document.querySelectorAll(TOOLS.join(', ')), ...(fab ? [fab] : [])].filter(
        t => shown(t) && !t.closest('.callbubble, #call-cards, [inert]'),
      ),
      read = [...document.querySelectorAll('#book .bk-page:not([hidden]) [data-keep-in-sight]')].filter(shown),
      found = calls.length ? [] : ['no call shows'];
    if (document.querySelector('review-mode')?.matches(':popover-open')) found.push("review mode's ink over the book");
    for (const el of calls) {
      const r = el.getBoundingClientRect();
      if (r.left < 0 || r.top < 0 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5)
        found.push(`${name(el)} off the screen (${[r.left, r.top, r.right, r.bottom].map(Math.round)})`);
      for (const t of tools) if (over(r, t.getBoundingClientRect())) found.push(`${name(el)} over ${name(t)}`);
      if (el.matches('.callbubble'))
        for (const u of read)
          if (over(r, u.getBoundingClientRect()))
            found.push(`${name(el)} over ${u.dataset.unit ? `scrap ${u.dataset.unit}` : `"${u.textContent}"`}`);
      for (const o of calls)
        if (o !== el && el.compareDocumentPosition(o) & 4 && over(r, o.getBoundingClientRect()))
          found.push(`${name(el)} over ${name(o)}`);
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (top && !el.contains(top)) found.push(`${name(top)} over ${name(el)}`);
    }
    return found;
  }, TOOLS);
}

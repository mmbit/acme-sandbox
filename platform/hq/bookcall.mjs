// book-check.mjs's call story (shell/calldraw.js, shared/review/callnotes.js), held like an iPad mini in WebKit, its
// voice line played.
// A call with the CEO: the Pencil down on the page makes the call small; a ring drawn while the board talks goes into
// the call's page (not a sheet) with the words the call heard, and down the call's own socket to the line as the Pencil
// stays up; the agent asks to see a page by name, the card waits with Show and Not now while the call goes on, nothing
// of the screen gone until Show, and Show starts the watch-along; the agent's ring lands on the page in its own ink, kept on the call's page with its
// words, and a ring round words nowhere on screen comes back not drawn, with why; hung up, the call's page is offered
// to throw away, and one tap does. Along the way: a private part under the ring is painted over in what the agent
// gets; a line drawn while a mark goes in is drawn and makes the next note, with only the words said since its
// pen-down; a mark the book didn't take stays, the board is told, and it goes in with the next line, but one whose
// connection dropped as the call ended isn't sent twice (a line drawn after it goes in on its own, also after one of
// that mark's lines was undone, and the board is told the book may still have that one). The cards in the look asked
// for (look: Wire's keys).
import assert from 'node:assert/strict';

const SETTLE_MS = 1500; // (callnotes.js)
const MASK = [0x8c, 0x8c, 0x8c]; // (snapshot.js)

// c: book-check's { context, open, page (its page now), pen, ring, ui, posts, pages, org, pixels, grab, shot }, and
// look: a renderer to run it in (its name on the shots), else HQ's own
export async function callStory(c) {
  const line = await playLine(c.context);
  await c.open(`/?intro=0&open=intercom${c.look ? `&renderer=${c.look}` : ''}`);
  const page = c.page(),
    s = { ...c, page, line, named: name => `${name}${c.look ? `-${c.look}` : ''}`, shown: 0 };
  // (the screen goes to the agent only as a watch-along: counted, to know it starts at Show and not before.)
  page.on('request', r => r.url().endsWith('/api/watchalong/start') && s.shown++);
  await page.click('#call');
  await page.waitForFunction(() => !document.querySelector('#call-screenshare')?.disabled, null, { timeout: 15_000 });
  await noteOnTheCall(s);
  await drawnWhileFiling(s);
  await downWhileFiled(s);
  await notTaken(s);
  await askToSee(s);
  await theirInk(s);
  await lostAtTheEnd(s);
  await thrownAway(s);
  await drawnAfterTheLoss(s);
  await drawnAfterTheLoss(s, 'undo');
}

// The call's microphone (a quiet tone: Linux's headless WebKit has none) and its voice line: what HQ sends it, kept
export async function playLine(context) {
  await context.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ac = new AudioContext(),
        tone = ac.createOscillator(),
        gain = ac.createGain(),
        out = ac.createMediaStreamDestination();
      gain.gain.value = 0.001;
      tone.connect(gain).connect(out);
      tone.start();
      return out.stream;
    };
  });
  const line = { ws: null, said: [] };
  await context.routeWebSocket(/\/voice\/ws$/, ws =>
    ws.onMessage(m => {
      if (typeof m !== 'string') return; // (the microphone)
      const e = JSON.parse(m);
      if (e.agent) {
        line.ws = ws;
        line.hello = e; // (bookwalk.mjs: the call's request and walk)
        ws.send(JSON.stringify({ type: 'call', id: 'line', call: 9, key: 'k' }));
        ws.send(JSON.stringify({ type: 'state', state: 'listening' }));
      } else if (e.type !== 'ping') line.said.push(e);
    }),
  );
  line.send = e => line.ws.send(JSON.stringify(e));
  return line;
}
// What the line heard from HQ of a type, waited for
export async function heard(s, type, has = () => true) {
  for (let i = 0; i < 60; i++) {
    const e = s.line.said.find(x => x.type === type && has(x));
    if (e) return e;
    await s.page.waitForTimeout(100);
  }
  assert.fail(`the line heard no ${type} (${JSON.stringify(s.line.said)})`);
}
const lastNote = s => s.posts.filter(p => p.path === '/api/book/note').at(-1).body;

// The Pencil down on the page: the call goes small, sharing nothing by itself; the ring drawn while the board talks goes
// into the call's page with the words heard, and to the line
async function noteOnTheCall(s) {
  const { page } = s;
  // (someone's private details under the ring: the agent gets the page around it with them painted over)
  await page.evaluate(() =>
    document.body.insertAdjacentHTML(
      'beforeend',
      `<p id="private-part" data-private style="position:fixed;left:312px;top:625px;z-index:40;margin:0;padding:4px;
        background:#d00000;color:#fff;font:bold 16px sans-serif">A. Customer, 1 Lane</p>`,
    ),
  );
  await s.pen(s.ring(372, 640, 120, 40), { lift: false });
  await page.waitForSelector('.callbubble', { state: 'visible' });
  await page.waitForSelector('#call-layer', { state: 'hidden', timeout: 3000 }); // (the Pencil down makes the call small)
  assert.equal(await page.evaluate(() => !!document.querySelector('.callbubble .cb-eye:not([hidden])')), false);
  s.line.send({ type: 'heard', text: 'This one feels too big' }); // (the board talks while drawing)
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__lift());
  await page.waitForTimeout(400);
  assert.equal(await page.locator(s.ui('.sheet')).isHidden(), true, 'no post-it on a call: the call is listening');
  const sent = await heard(s, 'note');
  const made = s.posts.find(p => p.path === '/api/book/page/new' && p.body.kind === 'call')?.body;
  assert.deepEqual(made && [made.kind, made.call], ['call', 9], "the call's page in today's book, at its first mark");
  const note = lastNote(s);
  assert.equal(note.words, 'This one feels too big', 'the words the call heard while drawing are the note’s');
  assert.equal(note.said, 'spoken');
  assert.match(note.snip ?? '', /^data:image\/jpeg;base64,/, 'its snip goes with it');
  const snip = await s.pixels(note.snip),
    near = (i, [r, g, b], by) =>
      Math.abs(snip.data[i] - r) + Math.abs(snip.data[i + 1] - g) + Math.abs(snip.data[i + 2] - b) < by;
  let masked = 0,
    shown = 0;
  for (let i = 0; i < snip.data.length; i += 4) {
    if (near(i, MASK, 12)) masked++;
    if (near(i, [0xd0, 0, 0], 90)) shown++;
  }
  assert.ok(
    masked > 2000 && shown === 0,
    `the private part painted over in the snip (${masked} masked, ${shown} shown)`,
  );
  assert.equal(note.anchor.el?.text, '', '...and its words left out of the anchor');
  await page.evaluate(() => document.querySelector('#private-part').remove());
  assert.equal(note.by, undefined, "the board's own");
  assert.ok(sent.id > 0, `the note went down the call's socket as the Pencil stayed up ${SETTLE_MS} ms`);
  s.line.send({ type: 'note', id: sent.id, state: 'received' });
  await s.shot(s.named('book-call-note'), page);
}

const notes = s => s.posts.filter(p => p.path === '/api/book/note');
// The board's notes in the book, waited for until there are n
async function noted(s, n) {
  for (let i = 0; i < 80 && notes(s).length < n; i++) await s.page.waitForTimeout(100);
  assert.equal(notes(s).length, n, `${n} notes in the book`);
  return notes(s).at(-1).body;
}
// Whether the board's red shows near a point on the screen
const red = (s, [x, y]) =>
  s.page.evaluate(([x, y]) => [x + scrollX, y + scrollY], [x, y]).then(at => inkedAt(s, at, '#ff5a5f'));

// The book's next note handled so, the rest as ever (Playwright's own times: 1 leaves a late fallback handled twice)
function once(page, handle) {
  let done = false;
  return page.route('**/api/book/note', r => {
    if (done) return r.fallback();
    done = true;
    return handle(r);
  });
}

// A ring, and its arrow drawn while the ring goes into the book (the book slow to answer): the arrow is drawn at once
// and goes in as the next note
async function drawnWhileFiling(s) {
  const { page } = s,
    before = notes(s).length;
  await once(page, r => new Promise(go => setTimeout(go, 2500)).then(() => r.fallback()));
  await s.pen(s.ring(200, 300, 70, 30));
  await page.waitForTimeout(SETTLE_MS + 400); // (the ring going in now)
  const arrow = Array.from({ length: 12 }, (_, i) => [280 + i * 8, 320 + i * 4]);
  await s.pen(arrow);
  await page.waitForTimeout(150);
  assert.equal(notes(s).length, before, 'the ring still going in');
  assert.ok(await red(s, arrow[6]), 'the arrow drawn while the ring goes in shows at once');
  const second = await noted(s, before + 2);
  const first = notes(s).at(-2).body;
  assert.deepEqual(
    [first.anchor.ink.length, second.anchor.ink.length],
    [1, 1],
    'the ring one note, the arrow drawn meanwhile the next',
  );
  const [sx, sy] = await page.evaluate(() => [scrollX, scrollY]),
    [x, y] = second.anchor.ink[0].points[0];
  assert.ok(Math.hypot(x - sx - arrow[0][0], y - sy - arrow[0][1]) < 2, 'the next note is the arrow');
  for (let i = 0; i < 40 && s.line.said.filter(e => e.type === 'note').length < 3; i++) await page.waitForTimeout(100);
  assert.equal(s.line.said.filter(e => e.type === 'note').length, 3, 'both went down the line');
}

// A ring, and its arrow's pen down while the ring goes in and still down when it's in: the arrow's note has only the
// words said since its own pen-down, not the ring's again
async function downWhileFiled(s) {
  const { page } = s,
    before = notes(s).length;
  await once(page, r => new Promise(go => setTimeout(go, 1500)).then(() => r.fallback()));
  await s.pen(s.ring(480, 220, 70, 30), { lift: false }); // (clear of the marks above)
  s.line.send({ type: 'heard', text: 'This border' });
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__lift());
  await page.waitForTimeout(SETTLE_MS + 400); // (the ring going in now)
  await s.pen(
    Array.from({ length: 12 }, (_, i) => [560 + i * 8, 240 + i * 4]),
    { lift: false },
  );
  s.line.send({ type: 'heard', text: 'goes thinner' });
  assert.equal((await noted(s, before + 1)).words, 'This border', "the ring's words");
  await page.evaluate(() => window.__lift());
  assert.equal((await noted(s, before + 2)).words, 'goes thinner', "the arrow's own words, the ring's not again");
}

// The book out of reach as a mark settles: it stays drawn, the board is told, and it goes in with the next line
async function notTaken(s) {
  const { page } = s,
    before = notes(s).length;
  await once(page, r => r.abort());
  await s.pen(s.ring(220, 460, 70, 30));
  await page.waitForTimeout(SETTLE_MS + 800);
  assert.equal(notes(s).length, before, 'the book took nothing');
  assert.match(await page.locator(s.ui('.tip')).textContent(), /Could not reach the book\. The mark stays here/);
  assert.equal(await page.locator(s.ui('.tip.show')).isVisible(), true, 'the board is told on the page');
  assert.ok(await red(s, [290, 460]), 'the mark stays drawn');
  await s.shot(s.named('book-call-not-taken'), page);
  await s.pen(Array.from({ length: 10 }, (_, i) => [300 + i * 6, 470 + i * 3]));
  const kept = await noted(s, before + 1);
  assert.equal(kept.anchor.ink.length, 2, 'the ring and the next line, one note');
}

// The agent asks to see a page by name: a card, no countdown, the call going on; Show starts the watch-along
async function askToSee(s) {
  const { page } = s;
  s.line.send({ type: 'ask', id: 1, what: 'the pricing page' });
  const card = page.locator('#call-cards [data-card="ask"]');
  await card.waitFor();
  assert.match(await card.textContent(), /\S asks to see the pricing page/);
  await page.waitForTimeout(1500);
  assert.equal(await card.isVisible(), true, 'the ask waits, with no countdown');
  assert.equal(await page.locator('.callbubble').isVisible(), true, 'the call goes on beside it');
  await keys(s, card, 'the ask');
  await s.shot(s.named('book-call-ask'), page);
  // (nothing of the screen has gone yet: the notes went as the Pencil lifted, each its own snip.)
  assert.equal(s.shown, 0, 'the screen shown before Show');
  assert.equal(await page.locator('.callbubble .cb-eye').isVisible(), false, 'the bubble says it watches before Show');
  await card.locator('[data-show]').click();
  assert.deepEqual(await heard(s, 'asked'), { type: 'asked', id: 1, answer: 'show' });
  await page.waitForSelector('.callbubble .cb-eye:not([hidden])', { timeout: 5000 });
  assert.equal(s.shown, 1, 'Show shows the screen');
  assert.equal(await card.count(), 0);
}

// The agent's ink: a ring round words on the board's screen, in its own colour, kept on the call's page; words nowhere
// on screen come back not drawn, with why
async function theirInk(s) {
  const { page } = s;
  const words = await page.evaluate(() => {
    const el = [...document.querySelectorAll('#hud button, #hud a')].find(
      e => e.offsetWidth && /^[A-Za-z][\w ]{2,20}$/.test(e.textContent.trim()),
    );
    return el?.textContent.trim();
  });
  assert.ok(words, 'something with words on it on HQ');
  s.line.send({ type: 'ink', id: 2, ring: words, note: null, words: 'or this one?' });
  assert.deepEqual(await heard(s, 'inked', e => e.id === 2), { type: 'inked', id: 2, drawn: true });
  const theirs = lastNote(s);
  assert.equal(theirs.by, s.org.company.ceo, "the agent's ink is its own note on the call's page");
  assert.equal(theirs.words, 'or this one?');
  const color = theirs.anchor.ink[0].color;
  assert.notEqual(color.toLowerCase(), '#ff5a5f', 'never in the board’s red');
  assert.ok(theirs.anchor.el?.text.includes(words), 'anchored on what it named');
  assert.ok(await inkedAt(s, theirs.anchor.ink[0].points[0], color), `the agent's ring shows in its colour (${color})`);
  await s.shot(s.named('book-call-ink'), page);
  s.line.send({ type: 'ink', id: 3, ring: 'nothing anywhere says this', note: null, words: '' });
  const missed = await heard(s, 'inked', e => e.id === 3);
  assert.equal(missed.drawn, false);
  assert.match(missed.why, /Nothing on their screen says/);
}
// Whether the screen shows a colour near a point of the document
async function inkedAt(s, [x, y], color) {
  const [sx, sy] = await s.page.evaluate(() => [scrollX, scrollY]);
  const { data } = await s.pixels(
    await s.grab({ x: Math.max(0, x - sx - 8), y: Math.max(0, y - sy - 8), width: 16, height: 16 }),
  );
  const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  for (let i = 0; i < data.length; i += 4)
    if (Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b) < 60) return true;
  return false;
}

// The connection dropped as the call's last mark goes in, and the call hung up: the book may have it, so it isn't sent
// again, and the board is told where to look
async function lostAtTheEnd(s) {
  const { page } = s,
    sent = [];
  const count = q => q.method() === 'POST' && new URL(q.url()).pathname === '/api/book/note' && sent.push(q);
  page.on('request', count);
  await once(page, r => r.abort());
  await s.pen(s.ring(220, 460, 70, 30));
  await page.waitForTimeout(SETTLE_MS + 800);
  await page.click('.callbubble .cb-hangup');
  await page
    .locator(s.ui('.tip.show'))
    .getByText(/connection dropped/)
    .waitFor({ timeout: 5000 });
  await page.waitForTimeout(500);
  page.off('request', count);
  assert.equal(sent.length, 1, 'the mark whose connection dropped went once, not again as the call ended');
}

// A call again: the connection dropped as a ring goes in (undo: with an arrow, undone after), a line drawn after it,
// and the call hung up before that settles: the line goes in on its own, the ring not again (undo: the board told the
// book may still have the arrow)
async function drawnAfterTheLoss(s, undo) {
  const { page } = s,
    sent = [];
  await page.click('#call');
  await page.waitForFunction(() => !document.querySelector('#call-screenshare')?.disabled, null, { timeout: 15_000 });
  const count = q =>
    q.method() === 'POST' && new URL(q.url()).pathname === '/api/book/note' && sent.push(q.postDataJSON());
  page.on('request', count);
  await once(page, r => r.abort());
  await s.pen(s.ring(220, 460, 70, 30));
  if (undo) await s.pen(Array.from({ length: 12 }, (_, i) => [300 + i * 8, 470 + i * 4]));
  await page.waitForTimeout(SETTLE_MS + 800);
  if (undo) await twoFingerTap(page);
  const after = Array.from({ length: 10 }, (_, i) => [230 + i * 6, 520 + i * 3]);
  await s.pen(after);
  // (at once: a click waits out the bubble's move, past SETTLE_MS)
  await page.locator('.callbubble .cb-hangup').dispatchEvent('click');
  for (let i = 0; i < 50 && sent.length < 2; i++) await page.waitForTimeout(100);
  await page.waitForTimeout(500);
  page.off('request', count);
  assert.deepEqual(
    sent.map(b => b.anchor.ink.length),
    [undo ? 2 : 1, 1],
    'the lost mark once, then the line drawn after it on its own as the call ended',
  );
  // (its shape: a line joining an open mark is kept where its element was at the mark's first line, marks.js)
  const pts = sent[1].anchor.ink[0].points,
    [dx, dy] = [0, 1].map(k => pts.at(-1)[k] - pts[0][k] - (after.at(-1)[k] - after[0][k]));
  assert.ok(Math.hypot(dx, dy) < 2, 'the note that went is the line drawn after');
  if (undo)
    await page
      .locator(s.ui('.tip.show'))
      .getByText(/may still have the lines you undid/)
      .waitFor();
}
// Two fingers tapped together: undo (book-check's scribble story: WebKit on Linux has no Touch to make)
const twoFingerTap = async page => {
  await page.evaluate(() => {
    const t = (id, x) => ({ identifier: id, target: document.body, clientX: x, clientY: 600 });
    const fire = (type, touches, changed) =>
      document.body.dispatchEvent(
        Object.defineProperties(new Event(type, { bubbles: true, composed: true }), {
          touches: { value: touches },
          changedTouches: { value: changed },
        }),
      );
    const two = [t(1, 300), t(2, 400)];
    fire('touchstart', two, two);
    fire('touchend', [], two);
  });
  await page.waitForTimeout(150);
};

// Hung up: the call's page stays in the day unless thrown away, in one tap
async function thrownAway(s) {
  const { page } = s;
  const callPage = s.pages.findLast(p => p.kind === 'call');
  const kept = page.locator('#call-cards [data-card="page"]');
  await kept.waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500); // (a toast's way in)
  await keys(s, kept, "the call's page");
  await s.shot(s.named('book-call-page'), page);
  await kept.locator('[data-away]').click();
  await kept.waitFor({ state: 'detached' });
  assert.equal(
    s.posts.findLast(p => p.path === '/api/book/page/delete')?.body.id,
    callPage.id,
    "the call's page thrown away",
  );
}

// In Wire, a card's answers are keys of its height, with a lip, the one to press lit (renderers/wire/skin.css)
async function keys(s, card, what) {
  if (s.look !== 'wire') return;
  const looks = await card.locator('button').evaluateAll(bs =>
    bs.map(b => {
      const cs = getComputedStyle(b);
      return { h: b.offsetHeight, lip: cs.boxShadow, bg: cs.backgroundColor };
    }),
  );
  assert.ok(
    looks.every(k => k.h >= 48 && k.lip !== 'none') && looks[0].bg !== looks[1].bg,
    `${what}'s answers are Wire's keys, the first lit (${JSON.stringify(looks)})`,
  );
}

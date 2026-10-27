// book-check.mjs's story of giving through the faces (shell/bookrail.js, booksheet.js, bookplane.js, bookdogear.js),
// on book-check's played store.
// A note on a free page waits for Juno (the CEO's: nobody's), with no sheet page of theirs yet. Juno's face, tapped
// from the free page, turns the leaf to "For Juno": the page shown changes once, under the turning leaf, never a blink.
// No face carries a count. There Juno's face is ringed with a small plane right by it: its tap hands the sheet over
// (the store sees the send) and a ring runs round the plane; a tap on the ringed plane takes it back, and so does Undo.
// The free page's corner, dragged onto a face with a mouse, a finger or the Pencil, gives that page; the ringed plane
// by that face takes it back. No page has a plane in its heading.
import assert from 'node:assert/strict';

// a leaf's turn and a little more (bookflip.js TURN_MS)
const TURN_MS = 700;

// c: book-check's { hqIn, base, viewport, settled, pages, notes, snips, posts, sheets, org, SNIP, shot,
// noErrorsIn }
export function sendFaceStories(c) {
  return {
    'a face tapped on another page turns the leaf to its sheet; the plane by it hands the sheet over, its ring and Undo':
      browser => faceStory({ ...c, browser }),
    "a page's corner dragged onto a face gives the page, with a mouse, a finger and the Pencil; no plane in a heading":
      browser => cornerStory({ ...c, browser }),
  };
}

async function faceStory(c) {
  const f = fixtures(c);
  const { page, errors, done } = await opened(c);
  try {
    const juno = page.locator(`#book .bk-face[data-id="${c.org.company.ceo}"]`);
    assert.equal(await juno.getAttribute('aria-label'), 'For Juno', 'no count on the face');
    assert.equal((await juno.innerText()).trim(), '', 'nor on its picture');
    // the face tapped from the free page: the leaf turns to Juno's sheet, made for the note waiting
    const made = c.posts.length;
    await watchPages(page);
    await juno.click();
    const sheet = page.getByRole('region', { name: 'For Juno' });
    await sheet.getByRole('group').first().waitFor({ timeout: 5000 });
    await page.waitForTimeout(TURN_MS);
    const seen = await page.evaluate(() => ((window.__watching = false), window.__seen));
    assert.deepEqual(
      seen,
      [seen[0], 'turning', 'For Juno'],
      `the page changes once, under a turning leaf: ${JSON.stringify(seen)}`,
    );
    assert.notEqual(seen[0], 'For Juno', 'it started on the free page');
    const madePages = c.posts.slice(made).filter(p => p.path === '/api/book/page/new');
    assert.equal(madePages.length, 1, "Juno's sheet page made once");
    await noPlaneInHeading(page);
    // on Juno's sheet the face is ringed, the plane right by it
    assert.equal(await juno.getAttribute('data-here'), '', "the face says you're on its sheet");
    const plane = page.getByRole('button', { name: 'Send to Juno' });
    await plane.waitFor({ timeout: 3000 });
    await still(c, 'send-after-here', page);
    // its tap hands the sheet over: the store sees the send, the ring runs round the plane
    await sendAt(c, page, c.org.company.ceo);
    const going = page.locator('#book [role=status]').filter({ hasText: /^1 note to Juno/ });
    await going.waitFor({ timeout: 3000 });
    await still(c, 'send-after-ring', page);
    // a tap on the ringed plane takes it back
    await undoAt(c, page, () => page.locator('#book .bk-plane[data-sending]').click());
    // sent again, and Undo takes it back
    await sendAt(c, page, c.org.company.ceo);
    await undoAt(c, page, () => page.locator('#book .bk-undo').click());
    c.noErrorsIn(errors);
  } finally {
    putAway(c, f);
    await done();
  }
}

async function cornerStory(c) {
  const f = fixtures(c);
  const { page, errors, done } = await opened(c);
  try {
    await noPlaneInHeading(page);
    const corner = page.locator('#book .bk-dogear');
    await corner.waitFor({ timeout: 3000 });
    for (const [how, to] of [
      ['mouse', 'kit'],
      ['touch', 'moss'],
      ['pen', 'wren'],
    ]) {
      const from = c.posts.length;
      await dragCorner(c, page, how, to);
      await page.waitForFunction(id => document.querySelector(`#book .bk-plane[data-for="${id}"] .bk-ring`), to, {
        timeout: 5000,
      });
      const sent = c.posts.slice(from).filter(p => p.path === '/api/book/page/send');
      assert.deepEqual(
        sent.map(p => p.body),
        [{ id: f.free.id, to }],
        `with ${how === 'touch' ? 'a finger' : how === 'pen' ? 'the Pencil' : 'a mouse'}, the page goes to ${to}`,
      );
      const said = page.locator('#book [role=status]').filter({ hasText: /^This page to / });
      await said.first().waitFor({ timeout: 3000 });
      // a tap on the ringed plane by that face takes it back, and the corner is there again
      await undoAt(c, page, () => page.locator(`#book .bk-plane[data-for="${to}"]`).click(), to);
      await corner.waitFor({ timeout: 3000 });
    }
    c.noErrorsIn(errors);
  } finally {
    putAway(c, f);
    await done();
  }
}

// A still for the board, the mouse off the book so no tooltip covers it
async function still(c, name, page) {
  await page.mouse.move(5, 300);
  await page.waitForTimeout(250);
  await c.shot(name, page);
}

// HQ on the played store, the book open on the free page
async function opened(c) {
  const context = await c.hqIn(c.browser, c.viewport),
    page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${c.base}/?intro=0`);
  await page.waitForSelector('#loading.gone');
  await c.settled(page, 'open');
  await page.locator(`#book .bk-face[data-id="${c.org.company.ceo}"]`).waitFor({ timeout: 10_000 });
  return { page, errors, done: () => context.close() };
}

// What the paper shows, each frame from now: the page shown by its name (its kind when it has none), or 'turning'
// while a leaf turns over it, each change once
const watchPages = page =>
  page.evaluate(() => {
    window.__seen = [];
    window.__watching = true;
    const look = () => {
      const turning = document.querySelector('#book .bk-turn-picture, #book .bk-turn-leaf'),
        shown = [...document.querySelectorAll('#book .bk-page')].find(p => !p.hidden);
      const now = turning ? 'turning' : (shown?.getAttribute('aria-label') ?? shown?.dataset.kind ?? 'nothing');
      if (window.__seen.at(-1) !== now) window.__seen.push(now);
      if (window.__watching) requestAnimationFrame(look);
    };
    look();
  });

// No page heading carries a plane, nor any button
async function noPlaneInHeading(page) {
  const inHeading = await page.locator('#book .bk-title button, #book .bk-title svg, #book .bs-plane').count();
  assert.equal(inHeading, 0, 'no plane in the page’s heading');
}

// The plane by an agent's face tapped (on their sheet): the store sees the send, and a ring runs round the plane
async function sendAt(c, page, id) {
  const from = c.posts.length,
    plane = page.locator(`#book .bk-plane[data-for="${id}"]`);
  await plane.click();
  await plane.locator('.bk-ring').waitFor({ timeout: 5000 });
  assert.ok(
    c.posts.slice(from).some(p => p.path === '/api/book/send'),
    'the store sees the send',
  );
  assert.match(await plane.getAttribute('aria-label'), /^Sending to /, 'the plane says it’s on its way');
}
// Taken back (act: a tap on the ringed plane, Undo): the store sees it, and the ring is gone
async function undoAt(c, page, act, id = c.org.company.ceo) {
  const from = c.posts.length;
  await act();
  await page.waitForFunction(who => !document.querySelector(`#book .bk-plane[data-for="${who}"] .bk-ring`), id, {
    timeout: 5000,
  });
  assert.ok(
    c.posts.slice(from).some(p => p.path === '/api/book/undo'),
    'the store sees the send taken back',
  );
}

// The page's corner drawn onto an agent's face (everyone's shows once the page is in hand): with the mouse, or as a
// finger or the Pencil hands it over (pointer events of that type)
async function dragCorner(c, page, how, to) {
  const corner = await page.locator('#book .bk-dogear').boundingBox(),
    from = [corner.x + corner.width - 8, corner.y + 8],
    peeled = [from[0] - 40, from[1] + 30];
  if (how === 'mouse') {
    await page.mouse.move(...from);
    await page.mouse.down();
    await page.mouse.move(...peeled, { steps: 6 });
  } else await pointer(page, how, [from, ...steps(from, peeled, 6)], false);
  const face = page.locator(`#book .bk-face[data-id="${to}"]`);
  await face.waitFor({ timeout: 3000 });
  const box = await face.boundingBox(),
    onFace = [box.x + box.width / 2, box.y + box.height / 2];
  if (how === 'mouse') {
    await page.mouse.move(...onFace, { steps: 10 });
    if (to === 'kit') await c.shot('send-after-corner', page);
    await page.mouse.up();
  } else await pointer(page, how, steps(peeled, onFace, 10), true);
}
const steps = ([x0, y0], [x1, y1], n) =>
  Array.from({ length: n }, (_, i) => [x0 + ((x1 - x0) * (i + 1)) / n, y0 + ((y1 - y0) * (i + 1)) / n]);
// A finger's or the Pencil's points: the first pressed (when first), each moved over, the last let go (when last)
const pointer = (page, type, points, last) =>
  page.evaluate(
    ([type, points, last]) => {
      const at = (kind, [x, y]) =>
        (document.elementFromPoint(x, y) ?? document.body).dispatchEvent(
          new PointerEvent(kind, {
            pointerId: 21,
            pointerType: type,
            isPrimary: true,
            clientX: x,
            clientY: y,
            pressure: kind === 'pointerup' ? 0 : 0.5,
            button: kind === 'pointermove' ? -1 : 0,
            buttons: kind === 'pointerup' ? 0 : 1,
            bubbles: true,
            composed: true,
            cancelable: true,
          }),
        );
      const pressed = !window.__pressing;
      if (pressed) at('pointerdown', points[0]);
      window.__pressing = !last;
      for (const p of pressed ? points.slice(1) : points) at('pointermove', p);
      if (last) at('pointerup', points.at(-1));
    },
    [type, points, last],
  );

// A free page with a line of the board's writing and a note on it for nobody (Juno's, the CEO's); no sheet page yet
function fixtures(c) {
  const free = {
    id: 9700,
    day: '2026-10-26',
    kind: 'free',
    owner: null,
    label: '',
    w: 700,
    h: 800,
    ink: [
      {
        color: '#1d9a5b',
        size: 5,
        points: Array.from({ length: 30 }, (_, i) => [60 + i * 12, 220 + 14 * Math.sin(i / 2), 0.5, i * 16]),
      },
    ],
  };
  c.snips.set(9701, c.SNIP);
  const note = {
    id: 9701,
    n: 1,
    page: free.id,
    anchor: { v: 1, url: '/?open=shop', el: null, view: { w: 1133, h: 744, x: 0, y: 0, dpr: 2 }, ink: [] },
    words: 'The price, bigger',
    said: 'typed',
    by: 'board',
    snip: '/api/book/snip?id=9701',
    status: 'open',
    links: [],
    slips: [],
  };
  const before = c.pages.length;
  c.pages.push(free);
  c.notes.push(note);
  c.renumber();
  return { free, note, before };
}
// The played store as it was before fixtures(c): its pages (Juno's sheet page made here too), notes and sheets
function putAway(c, f) {
  c.pages.splice(f.before);
  c.notes.splice(c.notes.indexOf(f.note), 1);
  c.sheets.delete(c.org.company.ceo);
}

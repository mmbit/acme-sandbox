// book-check.mjs's pin-flow story (the board's, 27 Oct: shared/review/postit.js, settle.js, lift.js; shell/ink/
// bookgroups.js; Ink's folder), each on its own played store, on an iPad mini with the Pencil, a phone in portrait with
// a finger and a desktop with a mouse. A mark on HQ's page opens the post-it at the foot of the screen, its photo
// framed on the mark; words said (the voice line's) or typed; Save, and the mark is gone from the screen at once, the
// note a scrap on the Notebook's newest page (groups/scrap: its anchor, words and photo). The book open, it turns there
// and the scrap shows; shut, it stays shut (it never opens by itself), and the pull tab's one tap opens it at the
// scrap. In the book its words stay editable (groups/edit, typed) and a pen's line drawn from inside its photo joins it
// (groups/edit with the ink): one group. The same from an artifact, a preview in HQ's viewer: its words said on the iPad
// and the desktop (HQ recording them, the preview never once asking for the microphone: the board, call 154), typed on
// the phone; its post-it's Save goes to the preview's /__review/notes, which the coordinator makes a scrap on the same
// page. Cancel: the mark gone, nothing saved.
import assert from 'node:assert/strict';
import { fulfilPart } from '../../shared/review/parts.mjs';
import { nothingDrawn } from './bookink.mjs';
import { groupsOf, newestPage, shownScrap } from './bookplayed.mjs';
import { talked, voiceServed } from './bookvoice.mjs';
import { talkedInViewer, askLeftBehind, pagesWatched } from './booktalk.mjs';
import { DESKTOP, MINI, pinOn, pressAlong, ui, until } from './bookkit.mjs';

// ---- the stories
const IPAD_SCREEN = { name: 'ipad', viewport: MINI, more: {}, starts: 'open', hand: 'pen' },
  PHONE_SCREEN = {
    name: 'phone',
    viewport: { width: 390, height: 844 },
    // (2x, not an iPhone's 3x: HQ's scene drawn without a GPU at 3x took a second a frame on a loaded worker, the
    // book's swing open half a minute. job #12594)
    more: { deviceScaleFactor: 2 },
    starts: 'folded',
    hand: 'touch',
  },
  DESKTOP_SCREEN = {
    name: 'desktop',
    viewport: DESKTOP,
    more: { deviceScaleFactor: 1, hasTouch: false },
    starts: 'open',
    hand: 'mouse',
  };
export const PREVIEW = 'https://scrap.preview.test';
const PREVIEW_PAGE = `<!doctype html><meta name="viewport" content="width=device-width"><title>Basket</title>
<body style="margin: 0; font: 16px system-ui, sans-serif">
<h1 style="margin: 24px">Your basket</h1>
<p style="margin: 24px; max-width: 30em">Two jars of plum jam, gift-wrapped, at the pick-up point by Friday.</p>
<script src="/__review/review.js"></script>`;
// How long a saved mark's ink may take to fly into the book: its flight is half a second, but HQ's scene drawn without a
// GPU on a loaded worker holds the page's frames up for seconds (job #12594's desktop run: past the default's 0.9 s)
const FLIGHT_MS = 4000;

// c: book-check's { hqIn, base, reviewJs, settled, ring, posts, hush, shot, noErrorsIn }
export function scrapStories(c) {
  return {
    "the pin flow on an iPad mini: a mark's post-it, Save, a scrap on the newest page, the book open or shut, editable; from an artifact too, its words said; Cancel":
      browser => pinFlow({ ...c, browser }, IPAD_SCREEN),
    "the pin flow on a phone in portrait: a finger's mark, its post-it, Save, the book shut till its tab's tap, editable; from an artifact too; Cancel":
      browser => pinFlow({ ...c, browser }, PHONE_SCREEN),
    "the pin flow on a desktop: a mouse's mark, its post-it, Save, a scrap on the newest page in the open book, editable; from an artifact too, its words said; Cancel":
      browser => pinFlow({ ...c, browser }, DESKTOP_SCREEN),
  };
}

async function pinFlow(c, screen) {
  const context = await c.hqIn(c.browser, screen.viewport, { ...screen.more, notebooks: {} }),
    errors = [];
  await previewServed(c, context);
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await pagesWatched(page); // (askLeftBehind, talkedInViewer)
  try {
    await page.goto(`${c.base}/?intro=0`);
    await page.waitForSelector('#loading.gone');
    await page.waitForSelector('review-mode .fab', { state: 'attached' }); // (away till summoned: job #20358)
    await c.settled(page, screen.starts);
    const s = { ...c, page, screen, play: context.notebook, named: what => `scrap-${screen.name}-${what}` };
    // on HQ: the book as the device starts it (open on an iPad and a desktop, shut on a phone)
    const first = await savedOnHq(s, { spoken: screen.hand === 'pen' });
    await edited(s, first);
    // (a mouse's press on a picture moves it, booktools.js: a pen or a stylus draws on the photo)
    if (screen.hand !== 'mouse') await drawnOn(s, first);
    // the iPad with its book put away: the Pencil's next note leaves it shut till the pull tab's tap
    if (screen.hand === 'pen') {
      await page.locator('#book .bk-lip').click();
      await turned(c, page, 'folded');
      await savedOnHq(s, { spoken: false, what: 'shut' });
    }
    await cancelled(s);
    await fromArtifact(s, { spoken: screen.hand !== 'touch' });
    c.noErrorsIn(errors);
  } catch (e) {
    await c.shot(`scrap-${screen.name}-failed`, page); // (what the board saw as it failed)
    throw e;
  } finally {
    c.hush(false);
    await context.close();
  }
}

// A mark on HQ's page, its post-it, its words (said, or typed), Save: the mark gone, a scrap on the newest page, the
// book turned to it there or, shut, opened at it by the pull tab's one tap. Returns the scrap as the store keeps it.
async function savedOnHq(s, { spoken, what = '' }) {
  const { page } = s,
    shut = (await bookMode(page)) === 'folded',
    from = s.posts.length;
  s.hush(!spoken);
  await landedHeard(page);
  await markOnHq(s);
  const sheet = await postIt(s, page, s.screen.viewport);
  if (spoken) await talked(page);
  else await sheet.locator('textarea').fill(`Tighten this line${what && `, ${what}`}`);
  await s.shot(s.named(`postit${what && `-${what}`}`), page);
  const sent = await savedScrap(s, from, `${s.screen.name}${what && ` (${what})`}`);
  assert.equal(sent.anchor?.v, 1, 'the scrap carries its anchor');
  assert.ok(sent.anchor.el?.selector, 'anchored on what was marked');
  assert.ok(sent.anchor.ink?.length >= 1, 'with the mark as its ink');
  assert.match(sent.snip ?? '', /^data:image\/(jpeg|png);base64,/, 'its photo goes with it');
  if (spoken) {
    assert.match(sent.words, /shorter/, 'the words said while marking are its words');
    assert.equal(sent.said, 'spoken');
  } else {
    assert.equal(sent.words, `Tighten this line${what && `, ${what}`}`, 'the words typed are its words');
    assert.equal(sent.said, 'typed');
  }
  const scrap = groupsOf(s.play).at(-1);
  assert.equal(scrap.page, newestPage(s.play).id, 'the scrap is on the newest page');
  await inBook(s, scrap, shut, what);
  assert.ok(!s.posts.slice(from).some(p => p.path === '/api/book/note'), 'nothing on a sheet');
  return scrap;
}
// A mark on HQ's page as the device makes it: the Pencil anywhere; a mouse or a finger with the pin, turned on as
// Settings' Pin on HQ does
async function markOnHq(s) {
  const { page, screen } = s,
    at = { x: Math.min(250, screen.viewport.width / 2), y: 300, rx: 80, ry: 45 };
  if (screen.hand === 'pen') return pressAlong(page, s.ring(at.x, at.y, at.rx, at.ry));
  if (!(await page.locator(ui('.fab')).isVisible())) await pinOn(page);
  await page.locator(ui('.fab')).dispatchEvent('click'); // (it bobs: never still for Playwright's click)
  await page.waitForSelector(ui('.veil:not([hidden])'));
  await drawn(page, s.ring(at.x, at.y, at.rx, at.ry), screen.hand);
}
// Points drawn by a mouse (the page's own), or a finger or the Pencil (as Safari hands them over, into review mode's veil
// when it's up)
async function drawn(on, points, hand, offset = { x: 0, y: 0 }) {
  if (hand === 'mouse') {
    const page = on.page?.() ?? on;
    await page.mouse.move(points[0][0] + offset.x, points[0][1] + offset.y);
    await page.mouse.down();
    for (const [x, y] of points.slice(1)) await page.mouse.move(x + offset.x, y + offset.y);
    return page.mouse.up();
  }
  await pressAlong(on, points, { type: hand === 'pen' ? 'pen' : 'touch' });
}
// The post-it as the board sees it: at the foot of the screen, inside its width, its photo developed, its button Save.
// on: the page or the preview's frame; screen: its size
async function postIt(s, on, screen) {
  const sheet = on.locator(ui('.sheet'));
  await sheet.waitFor({ state: 'visible' });
  await on.waitForSelector(ui('.polaroid:not(.busy) .img :is(img, canvas)'));
  await sheet.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished))); // (its pop: in a frame it can start late)
  const box = await sheet.evaluate(el => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, bottom: r.bottom, top: r.top };
  });
  assert.ok(
    box.left >= 0 && box.right <= screen.width && screen.height - box.bottom < 60 && box.top > screen.height / 3,
    `${s.screen.name}: the post-it at the foot of the screen (${JSON.stringify(box)} on ${JSON.stringify(screen)})`,
  );
  assert.equal((await sheet.locator('.send').textContent()).trim(), 'Save', 'its button reads Save');
  return sheet;
}
// The scrap in the book: open, the book turned to its page and the scrap in view with its words, clear of the tools;
// shut, still shut a moment after (the ink landed in its handle), then the pull tab's one tap opens it there
async function inBook(s, scrap, shut, what = '') {
  const { page } = s;
  if (shut) {
    await page.waitForTimeout(1500);
    assert.equal(await bookMode(page), 'folded', `${s.screen.name}: the Notebook doesn't open by itself`);
    assert.equal(await page.evaluate(() => window.__landed), true, '...its ink landing in the pull tab');
    await page.locator('#book .bk-lip').click();
    await turned(s, page, s.screen.name === 'phone' ? 'spread' : 'open');
  }
  // (the swing and the turn to it: slow on a loaded worker)
  const seen = await until(
    () => shownScrap(page, scrap),
    `${s.screen.name}: the scrap on the page shown${shut ? ', the book opened by its tab' : ''}`,
  );
  const { photo, paper } = seen;
  assert.ok(
    photo.x + photo.w > paper.left && photo.x < paper.right && photo.y + photo.h > paper.top && photo.y < paper.bottom,
    `${s.screen.name}: the scrap in view (${JSON.stringify(seen)})`,
  );
  assert.equal(seen.words, scrap.words, '...its words under it');
  // ...and clear of the islands over the paper's right edge, so a stroke on its photo starts on it, not on the tools
  await until(
    async () => {
      const now = await shownScrap(page, scrap);
      return now && now.right <= now.tools;
    },
    `${s.screen.name}: the scrap left of the book's tools (${JSON.stringify(seen)})`,
    5000,
  );
  await s.shot(s.named(`book${what && `-${what}`}`), page);
}
// Its words typed again in the book: saved, over the scrap as it was read, said as they first were
async function edited(s, scrap) {
  const { page } = s,
    from = s.posts.length,
    // (a scrap's words in its body: .bk-words.)
    words = page.locator(`#book .bk-words[data-g="${scrap.id}"] textarea.bk-scrap-words`);
  // (a finger's tap first on a touch screen: till one its words are the pen's to strike, penwords.js)
  if (s.screen.hand !== 'mouse') await words.tap();
  await words.fill('Shorter, and in the house font');
  const edit = await posted(s, from, '/api/notebooks/groups/edit', "the scrap's words edited are saved");
  assert.deepEqual(
    { id: edit.id, since: edit.since, words: edit.words, said: edit.said },
    { id: scrap.id, since: scrap.updated, words: 'Shorter, and in the house font', said: scrap.said },
  );
  const kept = groupsOf(s.play).find(g => g.id === scrap.id);
  assert.equal(kept.words, 'Shorter, and in the house font', 'the store keeps them');
}
// A line drawn from inside its photo: the scrap's own ink, the same group (no new one)
async function drawnOn(s, scrap) {
  const { page } = s,
    from = s.posts.length,
    count = groupsOf(s.play).length,
    inked = scrap.ink.length,
    { photo } = await shownScrap(page, scrap);
  const line = Array.from({ length: 14 }, (_, i) => [
    photo.x + photo.w / 4 + i * 5,
    photo.y + photo.h / 2 + 6 * Math.sin(i),
  ]);
  // (a finger in the book moves its page and never inks, bookwrite.js: a phone draws there with a stylus)
  await pressAlong(page, line);
  const edit = await posted(s, from, '/api/notebooks/groups/edit', 'a line over the photo joins the scrap');
  assert.equal(edit.id, scrap.id, 'the same group');
  assert.equal(edit.ink?.length, inked + 1, 'its ink with the line');
  assert.equal(groupsOf(s.play).length, count, 'no group of its own');
  await s.shot(s.named('drawn-on'), page);
}
// Cancel: the mark gone from the screen at once, and nothing saved
async function cancelled(s) {
  const { page } = s,
    from = s.posts.length;
  s.hush(true);
  if (s.screen.hand === 'touch' && (await bookMode(page)) !== 'folded') {
    await page.locator('#book .bk-lip').click();
    await turned(s, page, 'folded');
  }
  await markOnHq(s);
  const sheet = await postIt(s, page, s.screen.viewport);
  await sheet.locator('[data-cancel]').dispatchEvent('click');
  await nothingDrawn(page, `${s.screen.name}: cancelled`, 0);
  await page.waitForTimeout(2000); // (past what a mark's settle was)
  assert.deepEqual(
    s.posts
      .slice(from)
      .map(p => p.path)
      .filter(p => p.startsWith('/api/notebooks/groups') || p.startsWith('/api/book/note') || p === '/__review/notes'),
    [],
    'a cancelled note saves nothing',
  );
  await nothingDrawn(page, `${s.screen.name}: cancelled, a moment later`, 0);
  assert.equal(await page.locator(ui('.sheet')).isHidden(), true, 'the post-it gone');
}

// ---- an artifact: a preview in HQ's viewer, review mode running in its frame
export async function previewServed(c, context) {
  await voiceServed(c, context);
  await context.route(/\/api\/preview\/link$/, r => r.fulfill({ json: { url: r.request().postDataJSON().url } }));
  await context.route(`${PREVIEW}/**`, r => {
    const path = new URL(r.request().url()).pathname;
    if (fulfilPart(r, path, c.reviewJs)) return;
    // the board's note: the coordinator makes it a scrap on My journal's current page (bookreview.ts)
    if (path === '/__review/notes' && r.request().method() === 'POST') {
      const body = r.request().postDataJSON();
      c.posts.push({ path, body });
      const { v, url, el, view, ink } = body.element ?? {},
        g = context.notebook.route(
          '/api/notebooks/groups/scrap',
          {},
          {
            anchor: { v, url, el, view, ink },
            words: body.note,
            said: body.said === 'spoken' ? 'spoken' : 'typed',
            snip: body.shot,
            owner: 'juno',
          },
        );
      return r.fulfill({ json: { ok: true, id: g.id, page: g.page, owner: 'juno', name: 'Juno' } });
    }
    if (path.startsWith('/__review/')) return r.fulfill({ json: { show: false } });
    return r.fulfill({ contentType: 'text/html', body: PREVIEW_PAGE });
  });
}
// A mark on the preview: its post-it in the frame, words said through HQ's microphone (the frame never asking for it)
// or typed, Save to the preview's notes, the mark gone, and the scrap on the Notebook's newest page, the open book
// turned to it (shut, opened at it by the tab once the preview's closed)
async function fromArtifact(s, { spoken }) {
  const { page, screen } = s,
    from = s.posts.length,
    shut = (await bookMode(page)) === 'folded';
  s.hush(!spoken); // (HQ records the frame's words over the voice line too: framemic.js)
  await page.evaluate(url => import('/shell/desk.js').then(desk => desk.openLink(url)), `${PREVIEW}/basket`);
  await page.waitForSelector('#viewer .bar .pin:not([hidden])'); // (review mode said hello)
  const frame = page.frame({ url: /scrap\.preview\.test/ }),
    box = await page.locator('#viewer iframe').boundingBox(),
    loop = s.ring(110, 48, 100, 30); // (round the heading)
  await askLeftBehind(page, frame);
  await landedHeard(page);
  // (an artifact's own pin first, the Pencil too: it draws without one on HQ's page alone)
  await page.locator('#viewer .bar .pin').dispatchEvent('click');
  await frame.waitForSelector(ui('.veil:not([hidden])'));
  await drawn(frame, loop, screen.hand, box);
  const size = { width: Math.round(box.width), height: Math.round(box.height) },
    sheet = await postIt(s, frame, size);
  if (spoken) await talkedInViewer(s, frame, sheet);
  else await sheet.locator('textarea').fill('Say when it ships');
  await s.shot(s.named('artifact-postit'), page);
  await sheet.locator('.send').dispatchEvent('click'); // (a tap: no navigation to wait for)
  const sent = await posted(s, from, '/__review/notes', "the artifact's Save goes to its notes");
  assert.deepEqual(
    { note: sent.note, said: sent.said },
    spoken ? { note: 'Make this headline shorter', said: 'spoken' } : { note: 'Say when it ships', said: 'typed' },
    'the words said (or typed) are its words',
  );
  if (spoken) assert.ok((await page.evaluate(() => window.micsAsked)) >= 1, 'HQ recorded them');
  assert.equal(await frame.evaluate(() => window.micsAsked), 0, 'the preview never asked for the microphone');
  const allowed = await page.locator('#viewer iframe').getAttribute('allow');
  assert.doesNotMatch(allowed, /microphone/, "desk.js's frame isn't allowed the microphone");
  assert.ok(sent.element?.ink?.length >= 1, 'with the mark as its ink');
  assert.match(sent.shot ?? '', /^data:image\/(jpeg|png);base64,/, 'and its photo');
  await nothingDrawn(frame, `${screen.name}: the artifact's note saved`, FLIGHT_MS);
  await nothingDrawn(page, `${screen.name}: HQ, the artifact's note saved`, FLIGHT_MS);
  const scrap = groupsOf(s.play).at(-1);
  assert.equal(scrap.page, newestPage(s.play).id, "the artifact's scrap is on the newest page");
  if (shut) await page.click('#viewer [data-close]');
  await inBook(s, scrap, shut, 'artifact');
}
// ---- helpers
const bookMode = page => page.evaluate(() => document.documentElement.dataset.book);
// The book swung or slid to a mode after a tap, then laid out (a loaded worker's WebKit can take far past book-check's
// settle for the swing alone: the story then read a book still swinging shut as open. job #12594)
async function turned(c, page, mode) {
  await page.waitForFunction(m => document.documentElement.dataset.book === m, mode);
  await c.settled(page, mode);
}
// (whether a mark's ink lands in the folded book's handle from here)
const landedHeard = page =>
  page.evaluate(() => {
    window.__landed = false;
    document.addEventListener('book:landed', () => (window.__landed = true), { once: true });
  });
// The body of the first post to a path since from, waited for
async function posted({ posts }, from, path, what) {
  return (await until(() => posts.slice(from).find(p => p.path === path), what)).body;
}

// ---- for these stories and the others: a mark on HQ, its post-it saved as the board does (shown, Save tapped), the
// mark gone from the screen at once (rule zero); the body of the scrap it posted. on: { page, posts }; from: the posts
// before the mark; what: where, for the asserts
export async function savedScrap({ page, posts }, from, what) {
  const sheet = page.locator(ui('.sheet'));
  await sheet.waitFor({ state: 'visible' });
  await sheet.locator('.send').dispatchEvent('click'); // (a tap: no navigation to wait for)
  await nothingDrawn(page, `${what}, saved`, FLIGHT_MS);
  const scrap = await posted({ posts }, from, '/api/notebooks/groups/scrap', `${what}: Save puts it in the Notebook`);
  // (its post-it flown off before the next mark: one drawn while it's still going joins the saving one's queue)
  await sheet.waitFor({ state: 'hidden' });
  return scrap;
}

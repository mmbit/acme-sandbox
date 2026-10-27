#!/usr/bin/env node
// The book's stories as the board lives them, held like an iPad mini in WebKit (touch, 744 × 1133). One check for all of
// them; each thread adds its story here.
//   node platform/hq/book-check.mjs [--shots dir] [--stories words]
// The Pencil on HQ: a ring drawn on HQ's own page with a pen, no button first; nothing moves as the pen lifts (the line
// on screen just before is the line after, pixel for pixel but antialiasing); no number on a lone mark; the pen rested,
// the note goes on its sheet in the book with no post-it (the anchor in document px, the words said while drawing, a
// snip), and the mark is a faint hairline on the page once it's in. A finger's
// drag draws
// nothing. Held still, the pen takes a voice note there. A scribble wipes a mark, a two-finger tap brings it back. The
// ring, its number and Send again in Wire (?renderer=wire). And on a page of their own, every kind of line (pressure, a
// lift at no pressure, one crossing another, a highlighter) is the same wet as dry (shared/review/inkcheck.mjs).
// The book beside HQ's page, on an iPad mini, a desktop and a phone, in WebKit and Chromium (HQ in dev mode, on its
// mock data): HQ's page laid out in the room the book leaves (its toolbar whole, nothing of it under the book), the
// rail put, the book folded away to its lip with HQ's page the whole screen and brought back, spread, portrait starting
// folded, a phone's book opening as one whole page that stays whole, what's remembered after a reload, a page that
// grows as it's written down and New page starting the next. A ring on a phone, the book folded, rests into the book.
// The Pencil on HQ's page, never over the book beside it, in WebKit and Chromium at iPad mini landscape: review mode's
// layer the page's width, a pen on the book's paper drawing nothing, a ring at the page's edge going in, the pin on the
// page, over a dialog too, and the spread covering it with the page. Pinched out, the day's pages side by side, then the week as a contact sheet, and back.
// A guest's note on the board's sheet: their name tag in their colour, beside the board's own, one plane for both.
// A second screen: an iPad (WebKit) paired with a desktop (Chromium) by the book's code, a ring live across, finished
// on the other screen, swapped, flicked back, closed (bookpair.mjs).
// A sent note's ink kept on HQ's page as a hairline, a finger's tap on it showing its words and answer (a tap beside it
// the page's), and a picture pasted into the book landing taped on the page in view.
// A walk-through of finished work from its desk-phone card (bookwalk.mjs), and of a preview in HQ's viewer, the agent
// pointing and ringing inside it. (the preview: job #18848)
// An agent's answer clipping onto its note within seconds, with then and now, ticked and replied to (bookslip.mjs),
// and in Wire too, in Chromium. (Wire: job #19103)
// Search (bookfind.mjs): a word said while drawing yesterday found as it's written, an answer by its words, and the
// find opening its page at the note, its number lit. On a desktop, the caret in
// the field, Search put away with the book and back with it.
// The pin (bookpin.mjs): away as HQ loads on a desktop, an iPad and a phone; summoned by opening the book or the book's
// pin control (on a phone, the control folds the book onto HQ with the pin), away again folded or with the control; an
// artifact's pin as it was; a note's sheet and review mode's menu naming one owner. Carried and let go, it stays
// exactly where it's dropped, the same button while it's held.
// Handwriting (bookwritten.mjs): words written on HQ's page, read once the pen rests, stand beside the ink as type and
// go into the book as written; read late, they still reach the note.
// Ink on HQ's screens (bookink.mjs): a ring shows on the screen it was drawn on only, in this tab and another, notes left
// on what HQ no longer draws show nowhere, and once its sheet goes it's a faint hairline there, its card a tap away.
// The film's other stories (bookfilm.mjs): a morning, yesterday's sheet in the book with its answer clipped on; HQ's
// page beside the book, none of its buttons cut, at every width that keeps a page (in Wire too, in Chromium); and a
// picture dragged in from beside, taped where it's let go. (Wire: job #19263)
// The drawing tools (bookdraw.mjs): erased at two sizes, shapes filled and outlined, an arrow, ink and a picture
// selected, moved, cut, pasted and deleted, Undo and Redo through all of it, with a mouse and the Pencil.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import { serve, ROOT } from './serve.mjs';
import { playwright, errorsOf, until, openPage } from '../../shared/browser/browser.mjs';
import { fulfilPart } from '../../shared/review/parts.mjs';
import { wetDry, STILL } from '../../shared/review/inkcheck.mjs';
import { callStory } from './bookcall.mjs';
import { walkStory } from './bookwalk.mjs';
import { pairStory } from './bookpair.mjs';
import { phoneStory } from './bookphone.mjs';
import { slipStory } from './bookslip.mjs';
import { askStory } from './bookask.mjs';
import { findStory, keptStory } from './bookfind.mjs';
import { writtenStory } from './bookwritten.mjs';
import { mouseStories } from './bookmouse.mjs';
import { drawStories } from './bookdraw.mjs';
import { spaceStories } from './bookspace.mjs';
import { deskStories, notPaper, inkPixels } from './bookdesk.mjs';
import { frameStories } from './bookframe.mjs';
import { bodyStories } from './bookbody.mjs';
import { inkStory } from './bookink.mjs';
import { sentStory, phoneSendStory } from './booksent.mjs'; // (phoneSendStory: job #19631)
import { sendFaceStories } from './booksendface.mjs';
import { pinStory, pinScreensStory } from './bookpin.mjs'; // (pinScreensStory: job #20358)
import { chromeStories } from './bookchrome.mjs';
import { circleStories } from './bookcircle.mjs';
import { liftStories } from './booklift.mjs';
import { penStories } from './bookpen.mjs';
// (LOOKS: job #19359)
import { morningStory, everyWidthStory, LOOKS } from './bookfilm.mjs';

const only = process.argv.includes('--stories') ? process.argv[process.argv.indexOf('--stories') + 1] : null;
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) await mkdir(shots, { recursive: true });
const shot = async (name, page) => shots && page.screenshot({ path: `${shots}/${name}.png` });
const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const org = await (await fetch(`${base}/mock/org.json`)).json();
const reviewJs = (await readFile(`${ROOT}/shared/review/review.js`, 'utf8')).replace('{{HQ_ORIGIN}}', base);

// ---- the book's store, played (booknotes.ts): today's pages, notes numbered on their sheet, wiped. A note's sheet is
// its owner's (owner on it; none: the CEO's), open, in its ten seconds to undo, or sent; notes edited, moved, put in
// order and linked (booksend.ts too). (the sheets beyond the CEO's one)
// (the picture the paste story pasted)
let pasted = null;
const pages = [],
  notes = [],
  posts = [],
  snips = new Map();
let ids = 0;
// (a call's page numbers its notes on its own sheet, never listed to send: bookcalls.ts)
const ownerOf = n =>
  pages.find(p => p.id === n.page)?.kind === 'call' ? `call ${n.page}` : (n.owner ?? org.company.ceo);
const openOf = (owner = org.company.ceo) => notes.filter(n => n.status === 'open' && ownerOf(n) === owner);
const renumber = () => new Set(notes.map(ownerOf)).forEach(o => openOf(o).forEach((n, i) => (n.n = i + 1)));
// each owner's open sheet: { id, status, send_at }, and the sheets sent, newest first
const sheets = new Map(),
  sentSheets = [];
const sheetFor = owner =>
  sheets.get(owner) ??
  sheets.set(owner, { id: owner === org.company.ceo ? 1 : ++ids, status: 'open', send_at: null }).get(owner);
const shownSheet = owner => ({ ...sheetFor(owner), owner, name: null, sent: null, page: null, notes: openOf(owner) });
const ownerOfSheet = id => [...sheets].find(([, s]) => s.id === id)?.[0];
// a send whose ten seconds are over goes, as GET sheets does on the store; its owner's next notes open a new sheet
function deliverDue() {
  for (const [owner, s] of sheets)
    if (s.status === 'sending' && s.send_at <= Date.now()) {
      const gone = openOf(owner);
      for (const n of gone) n.status = 'sent';
      sentSheets.unshift({
        ...s,
        owner,
        name: null,
        page: null,
        status: 'sent',
        send_at: null,
        sent: new Date().toISOString(),
        notes: gone,
      });
      sheets.delete(owner);
    }
  // (a page given on its own: a one-off sheet, sent once its seconds are over.)
  for (const s of pageSends.filter(p => p.send_at <= Date.now())) {
    pageSends.splice(pageSends.indexOf(s), 1);
    sentSheets.unshift({ ...s, status: 'sent', send_at: null, sent: new Date().toISOString() });
  }
}
// pages given by their corner, in their seconds to undo (booksend.ts).
const pageSends = [];
function pageSendStore(path, body) {
  if (path === '/api/book/page/send') {
    const page = pages.find(p => p.id === body.id);
    if (!['free', 'call'].includes(page?.kind))
      return { refused: [400, 'a free page or a call’s is given on its own'] };
    const id = ++ids,
      note = { id: ++ids, n: 1, page: page.id, status: 'open', words: page.label ?? '', slips: [], links: [] };
    pageSends.push({
      id,
      owner: body.to,
      name: null,
      status: 'sending',
      send_at: Date.now() + 10_000,
      sent: null,
      page: page.id,
      notes: [note],
    });
    return pageSends.at(-1);
  }
  const s = path === '/api/book/undo' && pageSends.find(p => p.id === body.id);
  if (!s) return null;
  pageSends.splice(pageSends.indexOf(s), 1);
  return { id: s.id, status: 'undone' };
}
function sheetStore(path, body, q) {
  const given = pageSendStore(path, body);
  if (given) return given;
  const note = notes.find(n => n.id === body?.id);
  if (path === '/api/book/sheets') {
    deliverDue();
    const owners = [...new Set([...sheets.keys(), ...notes.filter(n => n.status === 'open').map(ownerOf)])];
    return {
      open: [...owners.filter(o => !o.startsWith('call ') && openOf(o).length).map(shownSheet), ...pageSends],
      sent: sentSheets,
    };
  }
  // (a call page's notes, on a sheet of its own for its page)
  if (path === '/api/book/calls') {
    const pages = q.get('pages').split(',').map(Number);
    return {
      calls: pages
        .map(page => `call ${page}`)
        .filter(o => openOf(o).length)
        .map(o => ({ id: 9000 + Number(o.slice(5)), owner: null, status: 'call', notes: openOf(o) })),
    };
  }
  if (path === '/api/book/send' || path === '/api/book/undo') {
    const owner = ownerOfSheet(body.id),
      s = sheets.get(owner);
    if (!s) return null;
    if (path === '/api/book/send' && s.status === 'open')
      Object.assign(s, { status: 'sending', send_at: Date.now() + 10_000 });
    if (path === '/api/book/undo' && s.status === 'sending' && s.send_at > Date.now())
      Object.assign(s, { status: 'open', send_at: null });
    return shownSheet(owner);
  }
  // (words read late only over the words they were read for)
  if (path === '/api/book/note/edit' && body.was !== undefined && body.was !== note.words)
    return { refused: [409, 'the note has other words by now: read it again'] };
  // (and lines joined to it on HQ's page: its ink and its snip cut again.)
  if (path === '/api/book/note/edit' && body.snip) snips.set(note.id, body.snip);
  if (path === '/api/book/note/edit')
    return {
      note: Object.assign(note, { words: body.words, said: body.said, ...(body.anchor && { anchor: body.anchor }) }),
    };
  if (path === '/api/book/note/move') {
    Object.assign(note, { owner: body.to ?? org.company.ceo, links: [] });
    for (const n of notes) n.links = (n.links ?? []).filter(id => id !== note.id);
    notes.push(notes.splice(notes.indexOf(note), 1)[0]);
    renumber();
    return { note, sheet: shownSheet(ownerOf(note)) };
  }
  if (path === '/api/book/sheet/order') {
    const owner = ownerOfSheet(body.id);
    for (const id of body.notes)
      notes.push(
        notes.splice(
          notes.findIndex(n => n.id === id),
          1,
        )[0],
      );
    renumber();
    return shownSheet(owner);
  }
  if (path === '/api/book/note/link') {
    const other = notes.find(n => n.id === body.to);
    for (const [a, b] of [
      [note, other],
      [other, note],
    ])
      a.links = body.linked ? [...new Set([...(a.links ?? []), b.id])] : (a.links ?? []).filter(id => id !== b.id);
    return shownSheet(ownerOf(note));
  }
  return null;
}
function store(path, body, q) {
  if (path === '/api/book') return { day: '2026-10-26', today: '2026-10-26', days: [], pages };
  if (path === '/api/book/page/new') {
    const page = { id: ++ids, day: '2026-10-26', ...body }; // (its day)
    pages.push(page);
    return page;
  }
  // (each with whose sheet it's on and whether that's a call's.)
  const listed = n => ({ ...n, owner: n.owner ?? null, onCall: ownerOf(n).startsWith('call ') });
  if (path === '/api/book/notes' && q.has('url'))
    return {
      notes: notes
        .filter(n => {
          const u = new URL(n.anchor.url, base);
          return u.origin === base && u.pathname + u.search === q.get('url');
        })
        .map(listed),
    };
  if (path === '/api/book/notes') return { notes: notes.filter(n => n.page === +q.get('page')).map(listed) };
  // (a page read whole and saved, its pictures with it.)
  if (path === '/api/book/page') {
    const page = pages.find(p => p.id === +q.get('id'));
    const scraps = (page?.scraps ?? []).map(s => ({ ...s, url: scrapUrl(s) }));
    // (and the words typed on it.)
    return page && { ...page, ink: page.ink ?? [], scraps, texts: page.texts ?? [] };
  }
  if (path === '/api/book/page/save') {
    const page = pages.find(p => p.id === body.id),
      // (its width grows too, and the words typed on it kept.)
      grown = { h: body.h ?? page?.h, w: body.w ?? page?.w, ...(body.texts && { texts: body.texts }) },
      // (its top-left once it grows up or left.)
      corner = { x: body.x ?? page?.x ?? 0, y: body.y ?? page?.y ?? 0 };
    return page && Object.assign(page, { ink: body.ink, scraps: body.scraps, ...grown, ...corner });
  }
  const played = sheetStore(path, body, q);
  if (played) return played;
  if (path === '/api/book/note') {
    const note = {
      id: ++ids,
      page: body.page,
      anchor: body.anchor,
      words: body.words,
      said: body.said,
      by: body.by ?? 'board',
      snip: body.snip ? `/api/book/snip?id=${ids}` : null,
      status: 'open',
      ...(body.to !== undefined && { owner: body.to ?? org.company.ceo }),
    };
    if (body.snip) snips.set(note.id, body.snip);
    notes.push(note);
    renumber();
    return { note, sheet: shownSheet(ownerOf(note)) };
  }
  if (path === '/api/book/page/delete') {
    pages.splice(
      pages.findIndex(p => p.id === body.id),
      1,
    );
    return { ok: true };
  }
  if (path === '/api/book/note/delete') {
    notes.find(n => n.id === body.id).status = 'wiped';
    renumber();
    return { ok: true };
  }
  // (Undo of a wipe: the same note, last on its sheet.)
  if (path === '/api/book/note/restore') {
    const i = notes.findIndex(n => n.id === body.id && n.status === 'wiped');
    if (i < 0) return null;
    const [note] = notes.splice(i, 1);
    notes.push(Object.assign(note, { status: 'open' }));
    renumber();
    return { note, sheet: shownSheet(ownerOf(note)) };
  }
  return null;
}

// A picture uploaded to a page (POST /api/book/scrap, its bytes as the body), kept by its file's name
const scraps = new Map();
const scrapUrl = s => `/api/book/scrap?id=${s.file.split('-')[0]}&file=${s.file}`;
function keepScrap(id, type, bytes) {
  const file = `${id}-s-${String(scraps.size + 1).padStart(8, '0')}.${type === 'image/png' ? 'png' : 'jpg'}`;
  scraps.set(file, { type, bytes });
  return { file, url: scrapUrl({ file }) };
}

// ---- a stand-in voice line: the words come as the microphone's audio does (hushed: the board says nothing)
// (hushed)
const SAID = ['Make this', 'Make this headline shorter'];
let hushed = false;
function voiceLine(ws) {
  let frames = 0,
    said = 0;
  ws.onMessage(m => {
    if (typeof m !== 'string') {
      frames += m.length;
      if (!hushed && said < 1 && frames > 16000)
        ws.send(JSON.stringify({ type: 'heard', text: SAID[said++], partial: true }));
      return;
    }
    if (JSON.parse(m).type !== 'end') return;
    ws.send(JSON.stringify({ type: 'heard', text: hushed ? '' : SAID[1], partial: false }));
    ws.send(JSON.stringify({ type: 'done' }));
  });
}

// ---- a stand-in handwriting reader (handwriting.ts): any ink reads as its words, after ms (or refused: [status, why]);
// the inks it was given kept. Its asks aren't the book's posts: one comes a moment after any mark's lines.
const reader = { words: '', ms: 0, inks: [], refused: null };

const IPAD_MINI = { viewport: { width: 744, height: 1133 }, deviceScaleFactor: 2, hasTouch: true };
// HQ held like an iPad mini in a browser, its coordinator and voice line played
async function hqIn(browser, viewport = IPAD_MINI.viewport, more = {}) {
  const context = await browser.newContext({
    ...IPAD_MINI,
    ...more,
    viewport,
    serviceWorkers: 'block',
    permissions: ['microphone'],
  });
  // review mode's closed shadow root opened, and a recorder for the microphone (the browser's own stand-in, once
  // allowed): Safari has MediaRecorder, Linux's headless WebKit doesn't (the words come over the live line, the clip is
  // only its fallback)
  await context.addInitScript(() => {
    const a = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (o) {
      return a.call(this, { ...o, mode: 'open' });
    };
    window.MediaRecorder ??= class {
      static isTypeSupported = type => type === 'audio/webm';
      state = 'inactive';
      mimeType = 'audio/webm';
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        setTimeout(() => {
          this.ondataavailable?.({ data: new Blob([new Uint8Array(400)], { type: this.mimeType }) });
          this.onstop?.();
        });
      }
    };
  });
  await context.routeWebSocket(/\/__review\/dictate(\?.*)?$/, voiceLine);
  await context.route(`${base}/__review/**`, r => {
    const path = new URL(r.request().url()).pathname;
    if (fulfilPart(r, path, reviewJs)) return;
    if (path === '/__review/mine') return r.fulfill({ json: { notes: 0 } });
    return r.fulfill({ json: { show: false } });
  });
  await context.route(`${base}/api/**`, async r => {
    const url = new URL(r.request().url()),
      body = r.request().method() === 'POST' && url.pathname !== '/api/book/scrap' ? r.request().postDataJSON() : null;
    if (url.pathname === '/api/org') return r.fulfill({ json: org });
    // (a call reads the board's language before it dials, and its Show starts a watch-along: nothing recorded here)
    if (url.pathname === '/api/language') return r.fulfill({ json: { lang: 'en' } });
    // (nobody invited: the rail draws its faces only once it has read who has a book.)
    if (url.pathname === '/api/book/people') return r.fulfill({ json: [] });
    if (url.pathname === '/api/watchalong/start') return r.fulfill({ json: { id: 1, events: null } });
    // (no first visit: HQ asks the intercom whether to welcome the board, and with no answer it lays 'coordinator
    // unreachable' over every still.)
    if (url.pathname === '/api/chat') return r.fulfill({ json: { messages: [], welcome: false } });
    if (url.pathname === '/api/book/scrap') {
      const req = r.request();
      if (req.method() === 'GET') {
        const kept = scraps.get(url.searchParams.get('file'));
        return kept ? r.fulfill({ contentType: kept.type, body: kept.bytes }) : r.fulfill({ status: 404, body: '' });
      }
      const type = req.headers()['content-type'],
        bytes = req.postDataBuffer() ?? pasted;
      posts.push({ path: url.pathname, body: { type, size: bytes.length } });
      return r.fulfill({ json: keepScrap(+url.searchParams.get('id'), type, bytes) });
    }
    if (url.pathname === '/api/book/snip') {
      const snip = snips.get(+url.searchParams.get('id'));
      if (!snip) return r.fulfill({ status: 404, json: { error: 'not found' } });
      return r.fulfill({
        contentType: snip.slice(5, snip.indexOf(';')),
        body: Buffer.from(snip.split(',')[1], 'base64'),
      });
    }
    // (the handwriting reader.)
    if (url.pathname === '/api/book/read') {
      reader.inks.push(body.ink);
      const { words, ms, refused } = reader;
      await new Promise(res => setTimeout(res, ms));
      if (refused) return r.fulfill({ status: refused[0], json: { error: refused[1] } });
      return r.fulfill({ json: { writing: !!words, words } });
    }
    if (body && url.pathname.startsWith('/api/book')) posts.push({ path: url.pathname, body });
    const answer = store(url.pathname, body, url.searchParams);
    if (answer?.refused) return r.fulfill({ status: answer.refused[0], json: { error: answer.refused[1] } });
    if (answer) return r.fulfill({ json: answer });
    // (no guests' books here: HQ's rail reads them with its sheets, and tells the page only once both are read.)
    if (['/api/requests', '/api/gazette', '/api/book/people'].includes(url.pathname)) return r.fulfill({ json: [] });
    return r.fulfill({ status: 404, body: '' });
  });
  return context;
}
// ---- the book beside HQ's page, a story at a time, in a browser: the failures counted, each one told
const MINI = { width: 1133, height: 744 },
  MINI_PORTRAIT = { width: 744, height: 1133 },
  DESKTOP = { width: 1440, height: 900 },
  PHONE = { width: 390, height: 844 };
const SETTLE_MS = 700; // the book's slide (260 ms) and HQ laying itself out again after it

// A story in every look the browser shows (bookfilm.mjs's LOOKS), its stills marked -wire in Wire.
async function inLooks(browser, story) {
  for (const look of LOOKS(browser))
    try {
      await story(look, (name, page) => shot(`${name}${look && '-wire'}`, page));
    } catch (e) {
      e.message = `${look ? 'in Wire' : 'in Brownstone'}: ${e.message}`;
      throw e;
    }
}
function STORIES() {
  return {
    "a morning: yesterday's sheet in the book, sent, its answer clipped on": browser =>
      morningStory(browser, { hq, inBook, shot, noErrorsIn, viewport: MINI, settle: SETTLE_MS }),
    // (the book's tools with a mouse on a desktop.)
    ...mouseStories({
      hqIn,
      base,
      store,
      pages,
      notes,
      posts,
      org,
      renumber,
      shot,
      settled,
      noErrorsIn,
      settle: SETTLE_MS,
    }),
    // (the drawing tools: the eraser, shapes, Select, Undo and Redo, with a mouse and the Pencil.)
    ...drawStories({ hqIn, base, store, pages, shot, settled, settle: SETTLE_MS }),
    // (the paper's space: every way, the pinch, never frozen.)
    ...spaceStories({ hqIn, base, store, pages, shot, settled, noErrorsIn, settle: SETTLE_MS }),
    // (the Pencil's taps, Select off the screen's edge, Copy and Paste, boxes of words.)
    ...penStories({ hqIn, base, store, pages, shot, settled }),
    // (moving about the book's pages with a mouse: the overview, the zoom, the pan, New page, the heading.)
    ...deskStories({ hq, storedPages, shot, settle: SETTLE_MS }),
    // (the book as an object: its shadow, its floating controls, its spine let go, its cover and name, the pairing
    // card at any width.)
    ...frameStories({ hq, shot, settled, settle: SETTLE_MS }),
    // (the book's body: its handle, where it's let go, the table under it, its open and its turns.)
    ...bodyStories({ hq, shot, settled, settle: SETTLE_MS }),
    // (the book's chrome: the column, the foot and the overview, the pages' names, Safari's strip.)
    ...chromeStories({ base, hqIn, shot, settled, settle: SETTLE_MS }),
    'iPad mini landscape: the book open beside the page, HQ whole in it': async browser => {
      const { page, errors, done } = await hq(browser, MINI);
      try {
        const seen = await sight(page);
        assert.equal(seen.mode, 'open');
        beside(seen);
        hqWhole(seen);
        await shot('book-landscape', page);
        assert.deepEqual(errors, []);
      } finally {
        await done();
      }
    },
    "the book folds away to its lip, the page takes the whole screen, and the lip's tap brings it back":
      async browser => {
        const { page, errors, done } = await hq(browser, MINI);
        try {
          const open = await sight(page);
          await putAway(page);
          await settled(page, 'folded');
          let seen = await sight(page);
          assert.equal(seen.mode, 'folded');
          folded(seen, MINI);
          hqWhole(seen);
          await shot('book-folded', page);
          await page.click('#book .bk-lip');
          await settled(page, 'open');
          seen = await sight(page);
          assert.equal(seen.mode, 'open');
          assert.equal(seen.page, open.page, 'the page is back at its open width');
          railStays(seen, open);
          assert.deepEqual(errors, []);
        } finally {
          await done();
        }
      },
    'a flick of the spine to the right puts the book away; the lip pulled left brings it back': async browser => {
      const { page, errors, done } = await hq(browser, MINI);
      try {
        const open = await sight(page);
        await drag(page, await spineAt(page), 120, 3);
        await settled(page, 'folded');
        assert.equal((await sight(page)).mode, 'folded');
        await pullLip(page, -600);
        await settled(page, 'open');
        const seen = await sight(page);
        assert.equal(seen.mode, 'open');
        railStays(seen, open);
        assert.deepEqual(errors, []);
      } finally {
        await done();
      }
    },
    // (the spread only where HQ would be narrower than a phone)
    'the spine let go with HQ narrower than a phone spreads the book over the screen, the rail still there':
      async browser => {
        const { page, errors, done } = await hq(browser, MINI);
        try {
          const open = await sight(page);
          await drag(page, await spineAt(page), -320, 14, undefined, HOLD_MS);
          await settled(page, 'spread');
          const seen = await sight(page);
          assert.equal(seen.mode, 'spread');
          assert.ok(
            seen.book.left < open.page / 2 && seen.rail.left >= seen.book.left && seen.rail.right <= seen.book.right,
            `the spread is ${JSON.stringify(seen.book)}, beside a page of ${open.page}`,
          );
          railStays(seen, open);
          await shot('book-spread', page);
          await putAway(page);
          await settled(page, 'open');
          assert.equal((await sight(page)).page, open.page, 'the page is back at its open width');
          assert.deepEqual(errors, []);
        } finally {
          await done();
        }
      },
    'portrait starts folded; pulled in, the book opens beside a narrower page, never over it': async browser => {
      const { page, errors, done } = await hq(browser, MINI_PORTRAIT);
      try {
        const start = await sight(page);
        assert.equal(start.mode, 'folded');
        folded(start, MINI_PORTRAIT);
        await pullLip(page, -420);
        await settled(page, 'open');
        const seen = await sight(page);
        assert.equal(seen.mode, 'open');
        assert.ok(seen.page < start.page, `the page stayed ${seen.page} px wide`);
        beside(seen);
        onScreen(seen.rail, MINI_PORTRAIT, 'the rail');
        hqWhole(seen);
        await shot('book-portrait', page);
        assert.deepEqual(errors, []);
      } finally {
        await done();
      }
    },
    'turning the iPad keeps each shape its own: landscape open, portrait folded, landscape open again':
      async browser => {
        const { page, errors, done } = await hq(browser, MINI);
        try {
          const landscape = await sight(page);
          await page.setViewportSize(MINI_PORTRAIT);
          await settled(page, 'folded');
          let seen = await sight(page);
          assert.equal(seen.mode, 'folded');
          folded(seen, MINI_PORTRAIT);
          await page.setViewportSize(MINI);
          await settled(page, 'open');
          seen = await sight(page);
          assert.equal(seen.mode, 'open');
          assert.equal(seen.page, landscape.page, 'the page is back at its landscape width');
          assert.deepEqual(errors, []);
        } finally {
          await done();
        }
      },
    'remembered: folded stays folded after a reload, and the width the spine was dragged to': async browser => {
      const { page, errors, done } = await hq(browser, MINI);
      try {
        const before = (await sight(page)).book.width;
        await drag(page, await spineAt(page), -60, 10, undefined, HOLD_MS);
        await page.waitForTimeout(SETTLE_MS);
        const wider = (await sight(page)).book.width;
        assert.ok(wider > before + 40, `dragged from ${before} to ${wider}`);
        await page.reload();
        await ready(page);
        assert.equal((await sight(page)).book.width, wider);
        await putAway(page);
        await settled(page, 'folded');
        await page.reload();
        await ready(page);
        assert.equal((await sight(page)).mode, 'folded');
        assert.deepEqual(errors, []);
      } finally {
        await done();
      }
    },
    'a desktop: the book a column on the right, open, and HQ whole beside it; put away, only its lip':
      async browser => {
        const { page, errors, done } = await hq(browser, DESKTOP, { hasTouch: false });
        try {
          const seen = await sight(page);
          assert.equal(seen.mode, 'open');
          beside(seen);
          hqWhole(seen);
          await shot('book-desktop', page);
          await putAway(page);
          await settled(page, 'folded');
          folded(await sight(page), DESKTOP);
          await shot('book-desktop-folded', page);
          assert.deepEqual(errors, []);
        } finally {
          await done();
        }
      },
    // (with the lip's stories)
    'a phone: HQ the whole screen beside the lip; the book opens as one whole page that stays whole, again and again':
      async browser => {
        const { page, errors, done } = await hq(browser, PHONE);
        try {
          const start = await sight(page);
          assert.equal(start.mode, 'folded');
          folded(start, PHONE);
          hqWhole(start);
          await shot('book-phone-folded', page);
          for (const round of [1, 2]) {
            await page.click('#book .bk-lip');
            // as the slide ends, and again once the pages have laid themselves out: the same whole page
            await settled(page, 'spread');
            const opened = await sight(page);
            coversPaper(await pageAtMiddle(page, opened.book, PHONE), opened.book, `round ${round}, as it opened`);
            await page.waitForTimeout(SETTLE_MS);
            const seen = await sight(page);
            coversPaper(await pageAtMiddle(page, seen.book, PHONE), seen.book, `round ${round}, laid out`);
            assert.ok(
              seen.book.left <= 12 && seen.rail.left >= seen.book.left && seen.rail.right <= seen.book.right,
              `the paper: ${JSON.stringify(seen.book)}`,
            );
            onScreen(seen.rail, PHONE, 'the rail');
            if (round === 1) await shot('book-phone-open', page);
            await putAway(page);
            await settled(page, 'folded');
            folded(await sight(page), PHONE);
          }
          assert.deepEqual(errors, []);
        } finally {
          await done();
        }
      },
    // (the page is endless: panned down past what it holds, a line written there grows it in the store, and the paper
    // shows nothing but paper all the while.)
    "a page grows as it's written down": async browser => {
      const { page, errors, done } = await hq(browser, MINI);
      try {
        const paper = (await sight(page)).book,
          stored = await storedPages(page);
        await page.mouse.move(paper.left + paper.width / 2, MINI.height / 2);
        for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 400);
        await page.waitForTimeout(SETTLE_MS);
        assert.deepEqual(await notPaper(page), [], 'the paper shows past the page');
        await write(page, paper.left + 60, MINI.height - 40);
        await page.waitForTimeout(SETTLE_MS);
        const grown = (await storedPages(page)).find(p => p.h > stored.find(q => q.id === p.id).h);
        assert.ok(grown, 'no page grew in the store');
        await shot('book-grown', page);
        assert.deepEqual(errors, []);
      } finally {
        await done();
      }
    },
    // (the pages control says which page of the day it is)
    'New page starts the next: the day gets a page more, and writing on it keeps it': async browser => {
      const { page, errors, done } = await hq(browser, MINI);
      try {
        const paper = (await sight(page)).book,
          stored = (await storedPages(page)).length,
          where = () =>
            page
              .locator('#book')
              .getByRole('button', { name: /^The day's pages/ })
              .getAttribute('aria-label'),
          [, n] = (await where()).match(/(\d+) of \d+$/);
        await page.getByRole('button', { name: 'New page', exact: true }).click();
        await page.waitForTimeout(SETTLE_MS);
        assert.match(await where(), new RegExp(`Free page, ${+n + 1} of ${+n + 1}$`));
        assert.equal(await inkPixels(page), 0, 'the new page has ink on it');
        assert.equal((await storedPages(page)).length, stored, 'a page was kept before anything was written on it');
        await write(page, paper.left + 80, MINI.height / 2);
        await page.waitForTimeout(SETTLE_MS);
        const kept = await storedPages(page);
        assert.equal(kept.length, stored + 1);
        assert.equal(kept[kept.length - 1].strokes, 1);
        await shot('book-new-page', page);
        assert.deepEqual(errors, []);
      } finally {
        await done();
      }
    },
    "a sent note's ink stays as a hairline; a tap shows its words": async browser => {
      const y = 520,
        line = Array.from({ length: 21 }, (_, i) => [220 + i * 10, y, 0.5, i * 16]);
      const sheet = { id: ++ids, kind: 'sheet', owner: org.company.ceo, url: '/?intro=0', w: 700, h: 700 },
        sent = {
          id: ++ids,
          sheet: 99,
          page: sheet.id,
          n: 1,
          anchor: { v: 1, url: '/?intro=0', el: null, view: { w: 1133, h: 744, x: 0, y: 0, dpr: 2 }, ink: [] },
          words: 'Fewer words on this banner',
          said: 'typed',
          status: 'sent',
          created: '2026-10-26T08:10:00Z',
          updated: '2026-10-26T08:16:00Z',
          slips: [{ id: 1, note: 0, by: 'kit', name: 'Kit', text: 'Trimmed it to five.' }],
        };
      sent.anchor.ink = [{ color: '#ff5a5f', size: 5, points: line }];
      pages.push(sheet);
      notes.push(sent);
      const { page, errors, done } = await hqOnStore(browser);
      try {
        // faint and thin along its line, and no number at it
        for (let i = 0; i < 20 && !(await inkAt(page, 320, y)); i++) await page.waitForTimeout(150);
        const ink = await inkAt(page, 320, y);
        assert.ok(ink > 0 && ink < 0.45 * 255, `the sent ink along its line is ${ink} of 255 strong`);
        assert.equal(await inkAt(page, 320, y + 6), 0, 'the hairline is thin');
        assert.equal(await inkAt(page, 214, y - 6), 0, 'a sent note has no number on the page');
        await shot('book-hairline', page);
        // a finger's tap on it: its words, when it went and the answer, and the page hears its touch cancelled
        let heard = await fingerTap(page, 300, y + 7);
        assert.deepEqual(heard, { up: 0, cancel: 1 }, 'a tap on a hairline is the card’s, not the page’s');
        const card = page.getByRole('dialog', { name: 'A note in the book' });
        await card.waitFor({ timeout: 3000 });
        // (when it went comes once the sheets are read)
        let said = await card.innerText();
        for (let i = 0; i < 30 && !/Sent \w/.test(said); i++)
          said = await page.waitForTimeout(100).then(() => card.innerText());
        assert.match(said, /Fewer words on this banner/);
        assert.match(said, /Sent (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d/);
        assert.match(said, /answer[\s\S]*Trimmed it to five\./i);
        await shot('book-hairline-card', page);
        // a tap anywhere else closes it, and is the page's (below the card, which grew with the answer's reply line:
        const below = await card.boundingBox();
        heard = await fingerTap(page, 300, Math.round(below.y + below.height + 30));
        assert.deepEqual(heard, { up: 1, cancel: 0 }, 'a tap beside a hairline stays the page’s');
        await card.waitFor({ state: 'hidden', timeout: 3000 });
        noErrorsIn(errors);
      } finally {
        pages.splice(pages.indexOf(sheet), 1);
        notes.splice(notes.indexOf(sent), 1);
        await done();
      }
    },
    'an answer clips onto its note within seconds: then and now, ticks, a reply, a running preview': browser =>
      slipStory({
        ...{ browser, hqIn, base, MINI, store, pages, notes, snips, posts, org },
        ...{ shot, settled, fingerTap, noErrorsIn },
      }),
    "a card about a note: on the desk phone with the note, Open in the book on it, answered by a tap under it in the book; a key's only on the desk phone":
      browser =>
        inLooks(browser, (look, shot) =>
          askStory({
            ...{ browser, hqIn, base, MINI, store, pages, notes, snips, posts, org },
            ...{ shot, settled, noErrorsIn, look },
          }),
        ),
    "the pin comes as the book opens, a note's sheet and the menu name one owner; dropped, it stays": browser =>
      inLooks(browser, (look, shot) =>
        pinStory({
          ...{ browser, hqIn, base, MINI, settled, shot, posts, pages, org, penOn, ring, noErrorsIn, look },
        }),
      ),
    'the pin away as HQ loads on a desktop and a phone, summoned and put away; an artifact keeps its own': browser =>
      pinScreensStory({ browser, hqIn, base, settled, shot, noErrorsIn, reviewJs }),
    // (a circle on HQ, on a call or not, and the pen's tap.)
    ...circleStories({
      hqIn,
      inLooks,
      base,
      MINI,
      settled,
      posts,
      pages,
      notes,
      snips,
      org,
      penOn,
      ring,
      inkAt,
      shot,
      noErrorsIn,
    }),
    // (a mark's ink lifting into the book, open and folded.)
    ...liftStories({ hqIn, base, MINI, settled, penOn, ring, inkAt, shot, noErrorsIn }),
    'a picture pasted in the book lands taped, and one dragged in lands where it was let go': async browser => {
      const { page, errors, done } = await hqOnStore(browser);
      try {
        const paper = (await sight(page)).book,
          from = posts.length;
        // (WebKit's Playwright doesn't hand over a Blob's body: the store takes the picture's bytes from here then)
        pasted = Buffer.from(
          await page.evaluate(async () => {
            const c = Object.assign(document.createElement('canvas'), { width: 240, height: 160 }),
              g = c.getContext('2d');
            g.fillStyle = '#1d9a5b';
            g.fillRect(0, 0, 240, 160);
            window.__png = await new Promise(res => c.toBlob(res, 'image/png'));
            return [...new Uint8Array(await window.__png.arrayBuffer())];
          }),
        );
        await page.evaluate(() => {
          const dt = new DataTransfer();
          dt.items.add(new File([window.__png], 'shot.png', { type: 'image/png' }));
          document.body.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
          );
        });
        const saved = () =>
          posts
            .slice(from)
            .filter(p => p.path === '/api/book/page/save' && p.body.scraps?.length)
            .at(-1)?.body;
        for (let i = 0; i < 40 && !saved(); i++) await page.waitForTimeout(250);
        const uploads = posts.slice(from).filter(p => p.path === '/api/book/scrap');
        assert.equal(uploads.length, 1, 'the picture went to the book once');
        assert.equal(uploads[0].body.type, 'image/png');
        const kept = saved();
        assert.ok(kept, 'the page with the picture on it was saved');
        const onPage = pages.find(p => p.id === kept.id);
        assert.equal(onPage.kind, 'free', "it's taped on today's free page, the page in view");
        const [scrap] = kept.scraps;
        assert.ok(Math.abs(scrap.tilt) <= 4, `a touch askew, not ${scrap.tilt} degrees`);
        assert.ok(scrap.w <= onPage.w / 2 + 0.01 && scrap.x >= 0 && scrap.x + scrap.w <= onPage.w, 'on the page');
        // ...and the board sees it there, on the book's paper
        await page.waitForTimeout(SETTLE_MS);
        const clip = { x: paper.left, y: 0, width: paper.width, height: MINI.height },
          green = await greenIn(page, await page.screenshot({ clip }));
        assert.ok(green > 2000, `the picture shows on the book's paper (${green} of its pixels)`);
        await shot('book-pasted', page);
        // ...and one dragged in from Safari beside it (split screen) lands taped where it's let go.
        const at = { x: paper.left + paper.width * 0.62, y: MINI.height * 0.7 },
          spot = { x: at.x - 30, y: at.y - 20, width: 60, height: 40 },
          dropped = posts.length,
          before = await greenIn(page, await page.screenshot({ clip: spot }));
        await page.evaluate(at => {
          const dt = new DataTransfer();
          dt.items.add(new File([window.__png], 'from-safari.png', { type: 'image/png' }));
          const paper = document.elementFromPoint(at.x, at.y),
            drag = type =>
              paper.dispatchEvent(
                new DragEvent(type, {
                  dataTransfer: dt,
                  clientX: at.x,
                  clientY: at.y,
                  bubbles: true,
                  cancelable: true,
                }),
              );
          drag('dragenter');
          drag('dragover');
          drag('drop');
        }, at);
        const keptDrop = () =>
          posts
            .slice(dropped)
            .some(p => p.path === '/api/book/page/save' && p.body.id === kept.id && p.body.scraps?.length > 1);
        for (let i = 0; i < 40 && !keptDrop(); i++) await page.waitForTimeout(250);
        assert.ok(keptDrop(), 'the page was saved with the dropped picture beside the pasted one');
        assert.equal(posts.slice(dropped).filter(p => p.path === '/api/book/scrap').length, 1, 'the drop went in once');
        await page.waitForTimeout(SETTLE_MS);
        const after = await greenIn(page, await page.screenshot({ clip: spot }));
        assert.ok(after > 0.6 * 4 * 60 * 40 && before < after / 2, `taped where it was let go (${before}, ${after})`);
        await shot('book-dropped', page);
        noErrorsIn(errors);
      } finally {
        await done();
      }
    },
    "a guest's note joins the board's sheet, in their colour with their name tag": async browser => {
      // Esmee, invited into the board's book, wrote on a preview the board shared: her note is on the board's open
      // sheet for the page's owner (feedback.ts, bookguests.ts), beside the board's own
      const ORANGE = '#d9480f',
        view = { w: 1133, h: 744, x: 0, y: 0, dpr: 2 },
        mark = (x, color) => [{ color, size: 5, points: [0, 1, 2, 3].map(i => [x + i * 20, 300, 0.5, i * 16]) }];
      // (on the CEO's sheet page of today if the Pencil left one: one an owner a day, whatever its url)
      const had = pages.find(p => p.kind === 'sheet' && p.owner === org.company.ceo),
        sheet = had ?? { id: ++ids, kind: 'sheet', owner: org.company.ceo, url: '/?intro=0', w: 700, h: 700 },
        note = (n, words, ink, guest) => ({
          id: ++ids,
          sheet: 1,
          page: sheet.id,
          n,
          by: guest ? 'guest:1' : 'board',
          anchor: { v: 1, url: 'https://hello.preview.example/basket', el: null, view, ink },
          words,
          said: 'typed',
          snip: null,
          status: 'open',
          links: [],
          slips: [],
          guest,
        }),
        theirs = note(1, 'The price is hard to read', mark(200, ORANGE), { name: 'Esmee', colour: ORANGE }),
        ours = note(2, 'yes, both', mark(400, '#ff5a5f'), null);
      if (!had) pages.push(sheet);
      notes.push(theirs, ours);
      renumber();
      const { page, errors, done } = await hqOnStore(browser);
      try {
        // (a note numbered only to tell it apart from a snip's)
        const hers = page.getByRole('group', { name: /^Note( \d+)?, Esmee/ });
        await hers.waitFor({ timeout: 5000 });
        // her name on it, in her colour; the board's own note beside it carries no name
        const tag = hers.getByText('Esmee', { exact: true });
        assert.ok(await tag.isVisible(), 'her name tag shows on her note');
        const tagColour = await tag.evaluate(e => getComputedStyle(e).backgroundColor);
        assert.equal(tagColour, 'rgb(217, 72, 15)', 'her name tag is in her colour');
        // (a note's words as the board reads them: in its words' box)
        const wordsOf = g => g.getByRole('textbox').first().inputValue();
        assert.equal(await wordsOf(hers), 'The price is hard to read');
        const boards = [];
        for (const g of await page.getByRole('group', { name: /^Note( \d+)?$/ }).all())
          if ((await wordsOf(g)) === 'yes, both') boards.push(g);
        assert.equal(boards.length, 1, "the board's own note is on the same sheet");
        assert.equal(await boards[0].getByText('Esmee').count(), 0, "the board's note has no name tag");
        // both go in one send: the one plane by the face
        const plane = page.getByRole('button', { name: /^Send to / });
        assert.ok(await plane.isVisible(), 'one plane sends the lot');
        await shot('book-guest-note', page);
        noErrorsIn(errors);
      } finally {
        if (!had) pages.splice(pages.indexOf(sheet), 1);
        notes.splice(notes.indexOf(theirs), 1);
        notes.splice(notes.indexOf(ours), 1);
        renumber();
        await done();
      }
    },
    "two notes on an agent's page land on its sheet and send in one tap, undo within ten seconds": async browser => {
      // Kit's page in today's book with two of the Pencil's notes on it, as the Pencil leaves them (marks.js)
      const kit = 'kit',
        view = { w: 1133, h: 744, x: 0, y: 0, dpr: 2 },
        sheetPage = { id: ++ids, kind: 'sheet', owner: kit, url: '/?open=shop', label: '', w: 700, h: 700 };
      const theirs = ['The price is too small', 'And warmer, like Inkbath'].map((words, i) => {
        const id = ++ids;
        snips.set(id, SNIP);
        const ink = [
          { color: '#2a2352', size: 5, points: [0, 1, 2].map(j => [100 + j * 40, 200 + i * 90, 0.5, j * 16]) },
        ];
        return {
          id,
          page: sheetPage.id,
          owner: kit,
          anchor: { v: 1, url: '/?open=shop', el: null, view, ink },
          words,
          said: 'spoken',
          snip: `/api/book/snip?id=${id}`,
          status: 'open',
          links: [],
          slips: [],
        };
      });
      pages.push(sheetPage);
      notes.push(...theirs);
      renumber();
      const { page, errors, done } = await hqOnStore(browser);
      try {
        // Kit's face in the rail counts them, and a tap on it opens Kit's sheet in the book
        const face = page.locator('#book nav [aria-label^="For Kit"]');
        await face.waitFor({ timeout: 5000 });
        await face.click();
        await page.waitForTimeout(SETTLE_MS);
        // (Kit's sheet: another one of today's sheets has its own Note 1)
        const kits = page.getByRole('region', { name: 'For Kit' });
        // two numbered notes, each with its snip and its words
        for (const [i, words] of ['The price is too small', 'And warmer, like Inkbath'].entries()) {
          const note = kits.getByRole('group', { name: `Note ${i + 1}` });
          await note.waitFor({ timeout: 5000 });
          await shot(`book-sheet-note${i + 1}`, page);
          assert.ok(
            await inBook(page, note),
            `note ${i + 1} shows on the book's paper (${JSON.stringify(await note.boundingBox())} in ${JSON.stringify(await page.locator('#book section').first().boundingBox())})`,
          );
          assert.equal((await note.innerText()).trim().split('\n')[0], String(i + 1), `its number is ${i + 1}`);
          assert.equal(await note.getByRole('textbox').inputValue(), words);
          assert.ok(await note.getByRole('textbox').isEditable(), 'its words can be written over');
          assert.equal(
            await note.locator('img').evaluate(img => img.complete && img.naturalWidth > 0),
            true,
            'its snip',
          );
        }
        await shot('book-sheet', page);
        // a finger held still on a note lifts it, and brings no Paste bubble under it (the bubble is the page's, for
        // a finger held on its paper: booktape.js).
        const held = await fingerHold(kits.getByRole('group', { name: 'Note 1' }).locator('img'), 900);
        assert.deepEqual(held, { lifted: true, paste: false }, 'a held note lifts, with no Paste bubble under it');
        await page.waitForTimeout(SETTLE_MS);
        // one tap on the plane by Kit's face: no question asked, the ring runs out round it (by the face, was in the page's heading)
        const plane = page.getByRole('button', { name: 'Send to Kit' });
        await plane.click();
        const timer = page.locator('#book .bk-plane[data-for="kit"] .bk-ring');
        await timer.waitFor({ timeout: 3000 });
        assert.equal(await page.getByRole('dialog').count(), 0, 'nothing asks "are you sure?"');
        const ring = () =>
          timer.evaluate(t =>
            [...t.querySelectorAll('circle')].map(c => parseFloat(getComputedStyle(c).strokeDashoffset)).at(-1),
          );
        const early = await ring();
        await page.waitForTimeout(1500);
        assert.ok((await ring()) > early + 5, 'the ring runs out as the seconds pass');
        await shot('book-sheet-sending', page);
        assert.ok(
          posts.some(p => p.path === '/api/book/send' && p.body.id === sheetFor(kit).id),
          'the sheet is sent',
        );
        // Undo within the seconds: the sheet is open again, the plane back
        await page.locator('#book .bk-undo').click();
        await plane.waitFor({ timeout: 3000 });
        assert.ok(
          posts.some(p => p.path === '/api/book/undo'),
          'the send is taken back',
        );
        assert.equal(sheetFor(kit).status, 'open');
        // sent again and left: after ten seconds the sheet reads "Sent 08:16", creased, its words read-only
        await plane.click();
        await timer.waitFor({ timeout: 3000 });
        const went = page.getByText(/^2 notes sent to Kit · \d\d:\d\d$/);
        await went.waitFor({ timeout: 16_000 });
        assert.ok(await inBook(page, went), '"Sent" shows at the sheet\'s head');
        assert.equal(await timer.count(), 0, 'the seconds to undo are over');
        // (a sent note shows no number)
        assert.equal(
          await kits.getByRole('group').first().getByRole('textbox').isEditable(),
          false,
          'a sent note is read-only',
        );
        assert.equal(await face.count(), 0, "Kit's face has no notes waiting");
        await shot('book-sheet-sent', page);
        noErrorsIn(errors);
      } finally {
        pages.splice(pages.indexOf(sheetPage), 1);
        for (const n of theirs) notes.splice(notes.indexOf(n), 1);
        sentSheets.splice(0, sentSheets.length, ...sentSheets.filter(s => s.owner !== kit));
        sheets.delete(kit);
        await done();
      }
    },
    // (Search, bookfind.mjs)
    "Search: a word said while drawing yesterday found as it's written, its page opened at the note, the number lit":
      browser => findStory(browser, { hq, inBook, shot, noErrorsIn, viewport: MINI, settle: SETTLE_MS }),
    'Search on a desktop: in the overview, its words kept when the overview closes and opens again, Esc wiping them':
      browser => keptStory(browser, { hq, noErrorsIn, desktop: DESKTOP }),
    // (handwriting read into type, bookwritten.mjs)
    // (a send that says what went to whom, a plane in view, notes clear of the writing: booksent.mjs; in Wire too: job #19359)
    "a sheet's send: notes clear of the board's writing, numbered only to tell apart, the plane in view, what went to whom":
      browser =>
        inLooks(browser, (look, shot) =>
          sentStory({
            ...{ browser, hqIn, base, viewport: MINI, settled, pages, notes, snips, sentSheets, sheets },
            ...{ renumber, SNIP, shot, noErrorsIn, look, posts },
          }),
        ),
    // (giving through the faces: a face's sheet turned to, handed over, a page by its corner.)
    ...sendFaceStories({
      ...{ hqIn, base, viewport: MINI, settled, pages, notes, snips, posts, sheets, org, renumber },
      ...{ SNIP, shot, noErrorsIn },
    }),
    // (the board's phone, 420 × 912)
    "a phone's folded book: its handle nudges no one; opened, a face turns it to their sheet, the plane in view":
      browser =>
        phoneSendStory({
          ...{ browser, hqIn, base, viewport: { width: 420, height: 912 }, settled, pages, notes, snips, sentSheets },
          ...{ sheets, renumber, SNIP, shot, noErrorsIn },
        }),
    'handwriting on the page read into type: beside the ink, into the book as written, read late, refused': browser =>
      writtenStory(browser, {
        hqOnStore,
        ui,
        reader,
        hush: on => (hushed = on),
        posts,
        notes,
        pages,
        ceo: org.departments.flatMap(d => d.agents).find(a => a.id === org.company.ceo).name,
        noErrorsIn,
        shot,
      }),
    // (in Wire too: job #19359)
    'a ring shows on its own screen only, in any tab; sent, a faint hairline there; nothing stuck': browser =>
      inLooks(browser, (look, shot) =>
        inkStory({
          ...{ browser, hqIn, base, MINI, settled, ui, penOn, ring, inkAt, fingerTap, notes, org, posts },
          ...{ shot, noErrorsIn, look },
        }),
      ),
    "HQ's page never under the book, at every width that keeps a page: split screen to a big desktop": browser =>
      everyWidthStory(browser, { hq, sight, beside, hqWhole, settled, shot, noErrorsIn }),
    // (the overview opens from its button, never a pinch on the page.)
    "the overview: the day's pages side by side, in order; pinched out, the week as a contact sheet; a page tapped, or pinched in, back":
      async browser => {
        const { page, errors, done } = await hq(browser, MINI);
        try {
          const paper = (await sight(page)).book,
            today = (await storedPages(page)).length;
          await overviewButton(page).click();
          await page.waitForTimeout(SETTLE_MS);
          let far = await farView(page);
          assert.equal(far.level, 'day', 'the overview shows the day');
          assert.equal(far.days.length, 1);
          assert.equal(far.days[0].frames.length, today, "every page of the day's");
          const row = far.days[0].frames;
          // (side by side, in rows where the book is too narrow for them all: none out of sight.)
          assert.ok(
            row.every((f, i) => !i || (f.top === row[i - 1].top ? f.left > row[i - 1].right : f.top > row[i - 1].top)),
            `side by side, in order: ${JSON.stringify(row)}`,
          );
          assert.ok(
            row.every(f => f.left >= paper.left && f.right <= paper.left + paper.width),
            'all in the book',
          );
          assert.ok(
            row.every(f => f.inked),
            'each with its ink',
          );
          await shot('book-pinch-day', page);
          await pinch(page, paper, 0.5);
          far = await farView(page);
          assert.equal(far.level, 'week', 'again, the week');
          assert.deepEqual(
            far.days.map(d => d.name),
            ['Today', far.days[1]?.name].filter(Boolean),
            'a row a day with pages, the latest first',
          );
          assert.ok(far.days.length >= 2, "the week has the day before's pages too");
          assert.ok(far.days[1].frames[0].top > far.days[0].frames[0].top, 'its days in rows, a contact sheet');
          await shot('book-pinch-week', page);
          // a page tapped there opens it in the book, on its own day
          await page.locator('#book [data-level=week] .bk-frame').last().click();
          await page.waitForTimeout(SETTLE_MS);
          assert.equal((await farView(page)).level, undefined, 'a page tapped goes back to the page');
          // (its heading on the page says the day.)
          const day = await page.locator('#book .bk-page:not([hidden]) .bk-when').textContent();
          assert.ok(
            far.days[1].name.split(' ').every(w => day.includes(w)),
            `on its own day: ${day}, not ${far.days[1].name}`,
          );
          // and a pinch in comes back from the day
          await overviewButton(page).click();
          await page.waitForTimeout(SETTLE_MS);
          assert.equal((await farView(page)).level, 'day');
          await pinch(page, paper, 2);
          assert.equal((await farView(page)).level, undefined, 'a pinch in goes back to the page');
          assert.deepEqual(
            errors.filter(e => !/can not be found here|No active pointer with the given id/.test(e)),
            [],
          );
        } finally {
          await done();
        }
      },
  };
}

// Whether an element shows on the book's paper (the open book's, beside HQ's page)
const inBook = (page, locator) =>
  locator.evaluate(el => {
    const r = el.getBoundingClientRect(),
      paper = document.querySelector('#book section').getBoundingClientRect();
    return (
      r.width > 0 &&
      r.left >= paper.left - 1 &&
      r.right <= paper.right + 1 &&
      r.top >= paper.top &&
      r.bottom <= paper.bottom
    );
  });
// A snip as the Pencil cuts one (a picture of the page around a mark): a pale card with a dark line across, a PNG
function snipPng(w = 240, h = 120) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length);
    out.write(type, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      rows.set(Math.abs(y - h / 2) < 3 ? [42, 35, 82] : [255, 248, 236], y * (w * 3 + 1) + 1 + x * 3);
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w);
  head.writeUInt32BE(h, 4);
  head.set([8, 2, 0, 0, 0], 8);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}
const SNIP = snipPng();

// HQ with review mode and the book on the played store (hqIn), held like an iPad mini in landscape, the book open.
async function hqOnStore(browser) {
  const context = await hqIn(browser, MINI),
    page = await context.newPage(),
    errors = errorsOf(page);
  await page.goto(`${base}/?intro=0`);
  await until(page, '#loading.gone');
  await page.waitForSelector('review-mode .fab', { state: 'attached' }); // (away while the book's folded)
  await settled(page, 'open');
  return { page, errors, done: () => context.close() };
}
// How strong review mode's ink is at a point: the most opaque of its layers' pixels there (0-255)
const inkAt = (page, x, y) =>
  page.evaluate(
    ([x, y]) => {
      const k = devicePixelRatio;
      let most = 0;
      for (const c of document.querySelector('review-mode').shadowRoot.querySelectorAll('.ui > canvas')) {
        if (!c.width) continue;
        const { data } = c.getContext('2d').getImageData(Math.round(x * k) - 1, Math.round(y * k) - 1, 3, 3);
        for (let i = 3; i < data.length; i += 4) most = Math.max(most, data[i]);
      }
      return most;
    },
    [x, y],
  );
// A finger's tap at a point, as Safari hands it over: what the page itself heard of it ({ up, cancel })
const fingerTap = (page, x, y) =>
  page.evaluate(
    ([x, y]) => {
      const heard = { up: 0, cancel: 0 },
        count = e => (e.type === 'pointerup' ? heard.up++ : heard.cancel++),
        target = document.elementFromPoint(x, y) ?? document.body;
      document.addEventListener('pointerup', count);
      document.addEventListener('pointercancel', count);
      for (const type of ['pointerdown', 'pointerup'])
        target.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 9,
            pointerType: 'touch',
            isPrimary: true,
            clientX: x,
            clientY: y,
            bubbles: true,
            composed: true,
            cancelable: true,
          }),
        );
      document.removeEventListener('pointerup', count);
      document.removeEventListener('pointercancel', count);
      return heard;
    },
    [x, y],
  );
// A finger held still on an element for ms, then let go where it was, as Safari hands it over: whether a note had
// lifted, and whether a Paste bubble was showing, just before the finger let go.
const fingerHold = (el, ms) =>
  el.evaluate(async (target, ms) => {
    const r = target.getBoundingClientRect(),
      [x, y] = [r.left + r.width / 2, r.top + r.height / 2];
    const fire = type =>
      target.dispatchEvent(
        new PointerEvent(type, {
          ...{ pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y },
          ...{ bubbles: true, composed: true, cancelable: true },
        }),
      );
    fire('pointerdown');
    await new Promise(res => setTimeout(res, ms));
    const seen = { lifted: !!document.querySelector('.bs-lifted'), paste: !!document.querySelector('.bk-paste') };
    fire('pointerup');
    return seen;
  }, ms);
// How many of a screenshot's pixels are the pasted picture's green (#1d9a5b), counted in the page
const greenIn = (page, png) =>
  page.evaluate(
    async src => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
      c.getContext('2d').drawImage(img, 0, 0);
      const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height),
        near = (i, v) => Math.abs(data[i] - v) < 30;
      let green = 0;
      for (let i = 0; i < data.length; i += 4) if (near(i, 29) && near(i + 1, 154) && near(i + 2, 91)) green++;
      return green;
    },
    `data:image/png;base64,${png.toString('base64')}`,
  );
const noErrorsIn = errors =>
  assert.deepEqual(
    errors.filter(e => !/can not be found here|No active pointer with the given id/.test(e)),
    [],
  );

// The overview's button at the paper's foot
const overviewButton = page =>
  page
    .locator('#book')
    .getByRole('button', { name: /^The overview:/ })
    .first();
// Two fingers on the book's paper, apart and then closing to (or opening to) k of that, as Safari hands them over
const pinch = (page, paper, k) =>
  page.evaluate(
    async ([x, y, k]) => {
      const on = document.querySelector('#book .bk-far:not([hidden])') ?? document.querySelector('#book .bk-desk');
      const at = (type, id, dx) =>
        on.dispatchEvent(
          new PointerEvent(type, {
            pointerId: id,
            pointerType: 'touch',
            isPrimary: id === 21,
            clientX: x + dx,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }),
        );
      at('pointerdown', 21, -90);
      at('pointerdown', 22, 90);
      for (let i = 1; i <= 8; i++) {
        const d = 90 * (1 + ((k - 1) * i) / 8);
        at('pointermove', 21, -d);
        at('pointermove', 22, d);
        await new Promise(res => setTimeout(res, 20));
      }
      at('pointerup', 21, 0);
      at('pointerup', 22, 0);
      await new Promise(res => setTimeout(res, 700));
    },
    [paper.left + paper.width / 2, MINI.height / 2, k],
  );
// The view pinched out: its level ('day', 'week' or none), and its days' names and frames (boxes, and ink drawn)
const farView = page =>
  page.evaluate(() => {
    const far = document.querySelector('#book .bk-far');
    return {
      level: far.hidden ? undefined : far.dataset.level,
      days: [...far.querySelectorAll('.bk-far-day')].map(d => ({
        // (the day's name: the week's row's, or the day's at the overview's head.)
        name: (d.querySelector('.bk-far-name') ?? far.querySelector('.bk-far-nav b')).textContent,
        frames: [...d.querySelectorAll('.bk-frame')].map(f => {
          const r = f.getBoundingClientRect(),
            c = f.querySelector('canvas');
          return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), inked: c.width > 0 };
        }),
      })),
    };
  });

// The page under the middle of the book's paper: its box, and whether any ink is drawn on it
const pageAtMiddle = (page, paper, screen = MINI) =>
  page.evaluate(
    ([x, y]) => {
      const el = document.elementsFromPoint(x, y).find(e => e.dataset.kind);
      const r = el.getBoundingClientRect();
      return {
        left: Math.round(r.left),
        right: Math.round(r.right),
        height: Math.round(r.height),
        inked: el.querySelectorAll('canvas').length > 0,
      };
    },
    [paper.left + paper.width / 2, screen.height / 2],
  );
// Today's pages as the store keeps them (dev mode's, in memory): { id, h, strokes }
const storedPages = page =>
  page.evaluate(async () => {
    const book = await import('/shell/bookdata.js');
    return (await book.loadDay(true)).pages.map(({ id, h, strokes }) => ({ id, h, strokes }));
  });
// A mouse line across the paper from x, a little wavy, at y
async function write(page, x, y) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) await page.mouse.move(x + i * 10, y + 10 * Math.sin(i / 2));
  await page.mouse.up();
}

// HQ in a fresh context at a size, the book drawn (look: '&renderer=wire' for Wire)
async function hq(browser, viewport, options = {}, look = '') {
  const { context, page, errors } = await openPage(browser, { viewport, hasTouch: true, ...options });
  await page.goto(`${base}/?intro=0${look}`);
  await ready(page);
  return { page, errors, done: () => context.close() };
}
async function ready(page) {
  // (folded away, the rail's faces are out of sight)
  await page.waitForSelector('#book [aria-label^="For "]', { state: 'attached', timeout: 30_000 });
  await page.waitForTimeout(SETTLE_MS);
}
// What the board sees, measured: the book's mode, HQ's page width, the book's paper, the rail's (the controls floating
// over the paper's right edge, together) and the lip's boxes, whether the folded book is out of sight, and HQ's toolbar
// buttons that show (the rail's islands, no facing pages)
const sight = page =>
  page.evaluate(() => {
    const box = el => {
      const r = el.getBoundingClientRect();
      return {
        left: Math.round(r.left),
        right: Math.round(r.right),
        width: Math.round(r.width),
        top: Math.round(r.top),
      };
    };
    const shown = el => el.offsetParent && el.getBoundingClientRect().width > 0,
      lip = document.querySelector('#book .bk-lip');
    return {
      mode: document.documentElement.dataset.book,
      page: document.body.getBoundingClientRect().width,
      book: box(document.querySelector('#book section > div')),
      rail: (() => {
        const all = [...document.querySelectorAll('#book nav [role="toolbar"][aria-orientation="vertical"]')]
          .map(el => el.getBoundingClientRect())
          .filter(r => r.width);
        const left = Math.min(...all.map(r => r.left)),
          right = Math.max(...all.map(r => r.right));
        return {
          left: Math.round(left),
          right: Math.round(right),
          width: Math.round(right - left),
          top: Math.round(Math.min(...all.map(r => r.top))),
        };
      })(),
      lip: { ...box(lip), shows: getComputedStyle(lip).opacity > 0.5 },
      away: getComputedStyle(document.querySelector('#book section')).visibility === 'hidden',
      tools: [...document.querySelectorAll('#hud .tools > *')].filter(shown).map(box),
    };
  });
// The rail where it was before the book moved
function railStays(seen, before) {
  assert.deepEqual(seen.rail, before.rail, 'the rail moved');
}
// The open book beside HQ's page, never over it
const beside = seen => assert.ok(seen.book.left >= seen.page, `the book at ${seen.book.left} is over the page`);
// The folded book out of sight past the screen's edge, its rail too, HQ's page the whole screen, and only the lip
// showing, a sliver at the edge
function folded(seen, screen) {
  assert.equal(seen.page, screen.width, `HQ's page is ${seen.page} px of the screen's ${screen.width}`);
  assert.ok(
    seen.book.left >= screen.width && seen.rail.left >= screen.width,
    `the book shows: ${JSON.stringify(seen)}`,
  );
  assert.ok(seen.away, 'the folded book is out of sight');
  // (the handle, at the screen's edge)
  assert.ok(
    seen.lip.shows && Math.abs(seen.lip.right - screen.width) <= 1 && seen.lip.width < screen.width / 2,
    `the handle: ${JSON.stringify(seen.lip)}`,
  );
}
// A box (the rail's) on the screen, none of it past an edge
function onScreen(box, screen, what) {
  assert.ok(box.left >= 0 && box.left < screen.width && box.right <= screen.width, `${what}: ${JSON.stringify(box)}`);
}
// The page in the middle of the paper covers all of it, a px either side
function coversPaper(shown, paper, when) {
  assert.ok(
    shown.left <= paper.left + 1 && shown.right >= paper.right - 1,
    `${when}: the page shown covers ${shown.left}-${shown.right} of the paper's ${paper.left}-${paper.right}`,
  );
}
// The lip pulled left, at its own height
async function pullLip(page, dx) {
  const r = await page.locator('#book .bk-lip').boundingBox();
  await drag(page, r.x + r.width / 2, dx, 12, r.y + r.height / 2);
}
// HQ's toolbar whole on its page: every button that shows inside the page's width, so none is under the book
function hqWhole(seen) {
  assert.ok(seen.tools.length >= 5, `only ${seen.tools.length} of HQ's tools show`);
  for (const t of seen.tools)
    assert.ok(t.left >= 0 && t.right <= seen.page, `a tool at ${t.left}-${t.right}, past the page's ${seen.page}`);
}
const spineAt = async page => {
  const r = await page.locator('#book [role=separator]').boundingBox();
  return r.x + r.width / 2;
};
// A drag across the screen at two-thirds of its height (or at y): from x by dx, in steps (few: a flick), held still
// for hold ms before it's let go (hold, a drag let go where it is, not a flick)
async function drag(page, x, dx, steps, y = (page.viewportSize().height * 2) / 3, hold = 0) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps });
  if (hold) await page.waitForTimeout(hold);
  await page.mouse.up();
}
// (longer than a flick's reading of the last moves, booklayout.js)
const HOLD_MS = 200;
// The book put away: its spine flicked right, to the screen's edge (the rail's
// arrow gone)
async function putAway(page) {
  const x = await spineAt(page);
  await drag(page, x, page.viewportSize().width - 10 - x, 3);
}
// The book in a mode, laid out: headless WebKit's frames come slowly under HQ's scene, and it tells the page a new
// size up to a second or two late
async function settled(page, mode) {
  for (const end = Date.now() + 5000; Date.now() < end; await page.waitForTimeout(100))
    if ((await page.evaluate(() => document.documentElement.dataset.book)) === mode) break;
  await page.waitForTimeout(SETTLE_MS);
}
async function bookStories(browser, which) {
  let failed = 0;
  for (const [name, story] of Object.entries(STORIES())) {
    if (only && !name.includes(only)) continue;
    try {
      await story(browser);
      console.log(`ok   ${which}: ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${which}: ${name}\n     ${e.message.split('\n').join('\n     ')}`);
    }
  }
  return failed;
}

// (--stories: Chromium, which this machine has; the whole check's first part is WebKit's. Chromium's microphone is its
// fake one, allowed: the words of a ring come over the voice line only once the mic starts.)
const FAKE_MIC = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
const browser = await (only
  ? playwright().chromium.launch({ args: ['--disable-dev-shm-usage', ...FAKE_MIC] })
  : playwright().webkit.launch());
let context = await hqIn(browser);

// HQ at an address, on a page of its own
let page, errors;
const open = async url => {
  page = await context.newPage();
  errors = errorsOf(page);
  await page.goto(`${base}${url}`);
  await until(page, '#loading.gone');
  await page.waitForSelector('review-mode .fab', { state: 'attached' }); // (away while the book's folded)
};
const ui = s => `review-mode >> css=${s}`;

// A pen on the page, as Safari hands it over (pressure, then none at the lift): down, along the points, and up only
// when asked (lift), so what's on screen just before the lift can be seen
const penOn =
  on =>
  (points, { lift = true, type = 'pen' } = {}) =>
    on.evaluate(
      ([pts, lift, type]) => {
        const at = (kind, [x, y], pressure) =>
          (document.elementFromPoint(x, y) ?? document.body).dispatchEvent(
            new PointerEvent(kind, {
              pointerId: 7,
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
        at('pointerdown', pts[0], 0.4);
        pts.slice(1).forEach((p, i) => at('pointermove', p, 0.35 + 0.4 * Math.sin((i / pts.length) * Math.PI)));
        window.__lift = () => at('pointerup', pts.at(-1), 0);
        if (lift) window.__lift();
      },
      [points, lift, type],
    );
const pen = (...a) => penOn(page)(...a);
const ring = (cx, cy, rx, ry) =>
  Array.from({ length: 48 }, (_, i) => [
    cx + rx * Math.cos((i / 44) * 2 * Math.PI),
    cy + ry * Math.sin((i / 44) * 2 * Math.PI),
  ]);
// What review mode's ink shows in a box as the pen lifts: its layers put together as the screen does (HQ's own page
// animates under it), at the very end of the line (its last piece drawn wet: ink.js's 'end'), then once it's dry
const lifting = clip =>
  page.evaluate(clip => {
    const k = devicePixelRatio,
      layers = () => {
        const out = Object.assign(document.createElement('canvas'), { width: clip.width * k, height: clip.height * k }),
          g = out.getContext('2d');
        g.fillStyle = '#808080';
        g.fillRect(0, 0, out.width, out.height);
        // (its ink layers only: the post-it's polaroid can develop in the same frame)
        for (const c of document.querySelector('review-mode').shadowRoot.querySelectorAll('.ui > canvas')) {
          g.globalAlpha = Number(getComputedStyle(c).opacity);
          g.drawImage(c, clip.x * k, clip.y * k, clip.width * k, clip.height * k, 0, 0, out.width, out.height);
        }
        return out.toDataURL('image/png');
      };
    let wet = null;
    const end = e => e.detail.phase === 'end' && (wet = layers());
    document.addEventListener('ink:stroke', end);
    window.__lift();
    document.removeEventListener('ink:stroke', end);
    return new Promise(res => requestAnimationFrame(() => res({ wet, dry: layers() })));
  }, clip);
// what's on screen in a box; a picture's pixels (a data URL, decoded in the page)
const grab = clip => page.screenshot({ clip }).then(b => `data:image/png;base64,${b.toString('base64')}`);
const pixels = src =>
  page.evaluate(async src => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height }),
      g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    return { data: [...g.getImageData(0, 0, c.width, c.height).data], width: c.width, height: c.height };
  }, src);
// how two pictures differ: the worst channel, and how many pixels differ past 24 (the first few of them), leaving out
// a square of corner device px at the top left
async function differ(a, b, { corner = 0 } = {}) {
  // (worked out in the page: two pictures' pixels carried out to here hold up the stand-ins for seconds.)
  return page.evaluate(
    async ([a, b, corner]) => {
      const data = async src => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height }),
          g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        return { data: g.getImageData(0, 0, c.width, c.height).data, width: c.width };
      };
      const [p, q] = await Promise.all([data(a), data(b)]);
      let worst = 0,
        changed = 0;
      const at = [];
      for (let i = 0; i < p.data.length; i += 4) {
        if ((i / 4) % p.width < corner && i / 4 / p.width < corner) continue;
        const d = Math.max(...[0, 1, 2].map(k => Math.abs(p.data[i + k] - q.data[i + k])));
        worst = Math.max(worst, d);
        if (d > 24 && changed++ < 6)
          at.push([
            (i / 4) % p.width,
            Math.floor(i / 4 / p.width),
            [...p.data.slice(i, i + 3)],
            [...q.data.slice(i, i + 3)],
          ]);
      }
      return { worst, changed, at };
    },
    [a, b, corner],
  );
}
// whether the board sees the number's red disc at a point (ACCENT, #ff5a5f)
async function redAt(x, y) {
  const { data } = await pixels(await grab({ x: x - 3, y: y - 3, width: 6, height: 6 }));
  for (let i = 0; i < data.length; i += 4) if (data[i] > 220 && data[i + 1] < 130 && data[i + 2] < 130) return true;
  return false;
}

// ---- a ring round something on HQ's page: no button, no veil, and nothing moves at the lift; its number at it, the
// words said while drawing, no picture taken in, and Send. look: what the stills' names end in. Returns the note sent
// and how much moved at the lift.
async function ringed(look) {
  const url = new URL(page.url()),
    here = url.pathname + url.search,
    noted = posts.filter(p => p.path === '/api/book/note').length;
  const loop = ring(372, 330, 150, 60),
    clip = { x: 372 - 175, y: 330 - 85, width: 350, height: 170 };
  await pen(loop, { lift: false });
  // (a ring takes a moment to draw: the mic, on from the pen's touch, is listening by its end)
  await page.waitForTimeout(1500);
  const { wet, dry } = await lifting(clip);
  // (the mark's number may land in the very frame of the lift, its disc in the clip's top left 32 px, 64 device px:
  // the ring never comes that near)
  const jump = await differ(wet, dry, { corner: 64 });
  if (shots) {
    await writeFile(`${shots}/lift-wet${look}.png`, Buffer.from(wet.split(',')[1], 'base64'));
    await writeFile(`${shots}/lift-dry${look}.png`, Buffer.from(dry.split(',')[1], 'base64'));
  }
  // (a line moved or redrawn differently leaves ink where there was page, past 150 on a channel. HQ's canvases are on
  // headless WebKit's GPU here, which antialiases some paths coarsely, a few hundred edge pixels off by under 100:
  // inkcheck.mjs below holds every line to a few pixels on the CPU canvas, as Safari draws)
  assert.ok(jump.worst < 100, `nothing moves as the pen lifts${look} (${JSON.stringify(jump)})`);
  assert.equal(await page.locator(ui('.veil')).isHidden(), true, 'the Pencil draws on HQ with no mode over the page');
  // (rested, it goes into the book with no post-it: settle.js.)
  await page.waitForTimeout(800);
  assert.equal(await page.locator(ui('.sheet')).isHidden(), true, `no post-it${look}`);
  // a lone mark carries no number: numbers only tell several apart (shared/review/notenumbers.js)
  assert.ok(!(await redAt(372 - 150 - 6, 330 - 60 - 6)), `a lone mark shows no number${look}`);
  await shot(`book-pencil-ring${look}`, page);
  for (let i = 0; i < 100 && posts.filter(p => p.path === '/api/book/note').length === noted; i++)
    await page.waitForTimeout(100);
  const sent = posts.filter(p => p.path === '/api/book/note')[noted]?.body,
    made = pages.find(p => p.id === sent?.page);
  // (the note's own page for HQ's address, once)
  assert.ok(
    posts.filter(p => p.path === '/api/book/page/new' && p.body.url === here).length <= 1,
    'counting its number makes no page in the book',
  );
  // (one page an owner a day, whatever HQ's address)
  assert.deepEqual(
    made && { kind: made.kind, owner: made.owner },
    { kind: 'sheet', owner: org.company.ceo },
    "the note is on the CEO's page in today's book: nothing ringed on HQ's home names an owner",
  );
  assert.equal(sent.anchor.v, 1);
  assert.ok(sent.anchor.el?.selector, `the note is anchored on what was ringed${look}`);
  assert.equal(sent.anchor.ink.length, 1, 'the ring is its ink');
  assert.ok(
    Math.abs(Math.min(...sent.anchor.ink[0].points.map(p => p[0])) - 222) < 6,
    'its ink in document px, where it was drawn',
  );
  assert.match(sent.words, /shorter/, 'the words said while drawing are its words');
  assert.equal(sent.said, 'spoken');
  assert.match(sent.snip ?? '', /^data:image\/jpeg;base64,/, 'a snip of the page around it goes with it');
  await page.waitForTimeout(800); // (its lift into the book)
  assert.ok(!(await redAt(372 - 150 - 6, 330 - 60 - 6)), `in the book, its hairline shows no number${look}`);
  assert.ok((await inkAt(page, 372 + 150, 330)) < 0.45 * 255, `in the book, a hairline on the page${look}`);
  await shot(`book-pencil-sent${look}`, page);
  return { sent, jump };
}
// ---- the Pencil on a phone, the book folded away to its lip: the post-it on HQ's page, within its whole width, and
// Send puts the note in the book
async function onAPhone(browser) {
  await context.close();
  context = await hqIn(browser, PHONE);
  await open('/?intro=0');
  await settled(page, 'folded');
  // (into the book, a note of its own or joining one beside it, its ink landing in the folded book's lip)
  const noted = posts.length,
    inBook = () => posts.slice(noted).filter(p => p.path === '/api/book/note' || p.path === '/api/book/note/edit');
  await page.evaluate(() => document.addEventListener('book:landed', () => (window.__landed = true), { once: true }));
  await pen(ring(195, 300, 110, 50));
  const width = await page.evaluate(() => document.body.getBoundingClientRect().width);
  assert.equal(width, PHONE.width, "HQ's page is the phone's whole width");
  for (let i = 0; i < 100 && !inBook().length; i++) await page.waitForTimeout(100);
  assert.equal(await page.locator(ui('.sheet')).isHidden(), true, 'no post-it on a phone either');
  assert.equal(inBook().length, 1, 'rested, the note goes in the book');
  await page.waitForFunction(() => window.__landed, null, { timeout: 3000 });
  await shot('book-phone-ring', page);
  noErrors();
}
// ---- the Pencil writes on HQ's page, never on the book beside it: in landscape, the book open.
async function besideTheBook(browser) {
  await context.close();
  context = await hqIn(browser, MINI);
  await open('/?intro=0');
  await settled(page, 'open');
  // review mode's layer and its pin beside the page's width
  const layer = () =>
    page.evaluate(() => {
      const root = document.querySelector('review-mode').shadowRoot,
        box = el => {
          const b = el.getBoundingClientRect();
          return b.width
            ? { left: Math.round(b.left), right: Math.round(b.right), x: b.x + b.width / 2, y: b.y + b.height / 2 }
            : null;
        };
      return {
        page: Math.round(document.body.getBoundingClientRect().width),
        ui: box(root.querySelector('.ui')),
        fab: box(root.querySelector('.fab')),
      };
    });
  const onPage = (l, what) =>
    assert.ok(
      l[what].left >= 0 && l[what].right <= l.page,
      `${what} at ${l[what].left}-${l[what].right}, past the page's ${l.page}`,
    );
  const seen = await sight(page);
  let l = await layer();
  assert.deepEqual([l.ui.left, l.ui.right], [0, l.page], "review mode's layer is HQ's page, not the book beside it");
  onPage(l, 'fab');
  // a pen on the book's paper is the book's
  let noted = posts.length;
  await pen(Array.from({ length: 16 }, (_, i) => [seen.book.left + 40 + i * 12, 420 + 8 * Math.sin(i)]));
  await page.waitForTimeout(4000); // (past a mark's settle and its screenshot)
  assert.equal(
    posts.slice(noted).filter(p => p.path === '/api/book/note').length,
    0,
    "a pen on the book's paper is no note",
  );
  noted = posts.length;
  // a ring at the page's edge: into the book, a note of its own or joining one beside it
  const inBook = () => posts.slice(noted).filter(p => p.path === '/api/book/note' || p.path === '/api/book/note/edit');
  await pen(ring(l.page - 70, 420, 50, 34));
  for (let i = 0; i < 100 && !inBook().length; i++) await page.waitForTimeout(100);
  assert.equal(inBook().length, 1, 'a ring on the page goes in');
  await shot('book-pencil-beside', page);
  // over one of HQ's dialogs (the top layer, placed by the window), still the page's width
  await page.evaluate(() => {
    const d = Object.assign(document.createElement('dialog'), { id: 'beside' });
    document.body.append(d);
    d.showModal();
  });
  await page.waitForTimeout(300);
  l = await layer();
  assert.deepEqual([l.ui.left, l.ui.right], [0, l.page], "over a dialog, review mode's layer is still the page's");
  await page.evaluate(() => document.querySelector('#beside').remove());
  await page.waitForTimeout(300);
  // the spread covers HQ's page, the pin with it (the spine let go with HQ narrower than a phone)
  await drag(page, await spineAt(page), 320 - (await spineAt(page)), 14, undefined, HOLD_MS);
  await settled(page, 'spread');
  l = await layer();
  assert.equal(
    await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('#book'), [l.fab.x, l.fab.y]),
    true,
    'the spread book covers the pin with the page',
  );
  noErrors();
}
// (HQ's world captures the pointer of every pointerdown, and so does the book's paper: a scripted one has no pointer to
// capture, which WebKit and Chromium each say in their words)
const noErrors = () =>
  assert.deepEqual(
    errors.filter(e => !/can not be found here|No active pointer with the given id/.test(e)),
    [],
  );

// --stories <words>: only the book's stories whose names hold those words, in Chromium, nothing else (a check's share of
// the worker's memory holds one part at a time).
if (only) {
  await context.close();
  const failed = await bookStories(browser, 'chromium');
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
}
await open('/?intro=0');
const { sent, jump } = await ringed('');

// ---- a finger works the page: its drag draws nothing
const before = posts.length;
await pen(
  Array.from({ length: 20 }, (_, i) => [200 + i * 12, 700]),
  { type: 'touch' },
);
await page.waitForTimeout(500);
assert.equal(await page.locator(ui('.sheet')).isHidden(), true, "a finger's drag opens no note");
assert.equal(posts.length, before);

// ---- held still, the pen listens there: the words land as a note as it lifts
await pen([[560, 520]], { lift: false });
await page.waitForSelector(ui('.listen:not([hidden])'), { timeout: 3000 });
await page.waitForTimeout(1500);
await page.evaluate(() => window.__lift());

for (let i = 0; i < 60 && posts.filter(p => p.path === '/api/book/note').length < 2; i++)
  await page.waitForTimeout(250);
const voice = posts.filter(p => p.path === '/api/book/note')[1]?.body;
assert.ok(voice, 'a voice note went into the book as the pen lifted');
assert.equal(voice.said, 'spoken');
assert.equal(voice.anchor.ink.length, 0, 'a voice note is a pin, no ink');
assert.ok(voice.anchor.el, 'on what the pen held still over');

await page.waitForSelector(ui('.sheet'), { state: 'hidden' });
// ---- a scribble over the ring wipes it; a two-finger tap brings it back
const zigzag = Array.from({ length: 24 }, (_, i) => [300 + (i % 2) * 140, 300 + i * 2.5]);
// (the wipe is a step to undo once the book has taken it: the page reads its marks again then.)
const reread = page.waitForResponse(res => res.url().includes('/api/book/notes?url='));
await pen(zigzag);
for (let i = 0; i < 20 && !posts.some(p => p.path === '/api/book/note/delete'); i++) await page.waitForTimeout(150);
await reread;
const wiped = notes[0];
assert.equal(posts.find(p => p.path === '/api/book/note/delete')?.body.id, wiped.id, 'a scribble wipes the mark');
await page.evaluate(() => {
  // (Linux's headless WebKit has no Touch to make: a touch event's lists, as Safari fills them)
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
// (the same note back, whole: its id, words and snip.)
for (let i = 0; i < 20 && !posts.some(p => p.path === '/api/book/note/restore'); i++) await page.waitForTimeout(150);
const back = posts.find(p => p.path === '/api/book/note/restore')?.body;
assert.equal(back?.id, wiped.id, 'a two-finger tap brings the wiped mark back');
assert.deepEqual(
  [wiped.status, wiped.anchor.ink, wiped.words, wiped.snip],
  ['open', sent.anchor.ink, sent.words, `/api/book/snip?id=${wiped.id}`],
  '...the same note, open on its sheet again with its ink, words and snip',
);
assert.equal(posts.filter(p => p.path === '/api/book/note').length, 2, '...not a new one in its place');
noErrors();

// ---- a call drawing in (bookcall.mjs; the agent's ink, aimed: bookaim.mjs.)
await context.close();
context = await hqIn(browser);
await callStory({ context, open, page: () => page, pen, ring, ui, posts, pages, org, pixels, grab, shot });
noErrors();
// ---- a walk-through of finished work (bookwalk.mjs)
await context.close();
context = await hqIn(browser);
await walkStory({ context, open, page: () => page, pen, ring, posts, pages, org, shot, reviewJs });
noErrors();
await besideTheBook(browser);
await onAPhone(browser);
await context.close();
// a second screen: an iPad paired with a desktop by the book's code
const desk = await playwright().chromium.launch({ args: ['--disable-dev-shm-usage'] });
await pairStory({ pad: browser, desk, hqIn, base, penOn, ring, ui, posts, notes, shot });
// (a phone: job #19221; its ring's life on the desktop, notes: job #19336)
await phoneStory({ pad: browser, desk, hqIn, base, penOn, ring, ui, posts, notes, shot });
await desk.close();

// ---- every kind of line, wet and dry, on a page of its own
const lines = await browser.newContext(IPAD_MINI);
for (const line of await wetDry(await lines.newPage()))
  assert.ok(line.changed <= STILL, `${line.name}: wet and dry are the same line (${JSON.stringify(line)})`);
let failed = await bookStories(browser, 'webkit');
await browser.close();

// ---- the ring, its number and Send in Wire, in Chromium: Linux's headless WebKit has no en-CA dates (its ICU writes
// 10/26/2026 for HQ's YYYY-MM-DD), so Wire's calendar can't start there and HQ shows Brownstone instead (Safari has them)
const chromium = await playwright().chromium.launch({ args: FAKE_MIC });
context = await hqIn(chromium);
await open('/?intro=0&renderer=wire');
assert.equal(await page.evaluate(() => document.body.classList.contains('brownstone')), false, 'Wire is the look');
const wire = await ringed('-wire');
noErrors();
// ---- a call drawing in, in Wire (bookcall.mjs)
await context.close();
context = await hqIn(chromium);
await callStory({
  context,
  open,
  page: () => page,
  pen,
  ring,
  ui,
  posts,
  pages,
  org,
  pixels,
  grab,
  shot,
  look: 'wire',
});
noErrors();
// ---- an answer clipping onto its note, in Wire (bookslip.mjs.)
await slipStory({
  ...{ browser: chromium, hqIn, base, MINI, store, pages, notes, snips, posts, org },
  ...{ shot, settled, fingerTap, noErrorsIn, look: 'wire' },
});
await besideTheBook(chromium);
failed += await bookStories(chromium, 'chromium');
await chromium.close();

server.close();
// (Search; handwriting; a morning, a picture dragged in, every width)
console.log(
  `book-check: on HQ in WebKit at iPad mini size, a pen's ring with no button first (nothing moving at the lift: at most ${jump.worst} off on an edge, ${wire.jump.worst} in Wire), no number on it (no page made for it), the pen rested and the note in the book with no post-it (anchor, words, snip), the mark a hairline once it's in, in Brownstone and in Wire (Chromium); a finger's drag drawing nothing; a voice note held still; a scribble wiping a mark and a two-finger tap bringing it back with its words and snip; a call (in Brownstone, and in Wire in Chromium): the Pencil making it small, a note to the call's page and the line with the words heard, a private part painted over in its snip, a line drawn while it goes in drawn and the next note, a mark the book didn't take kept and told, one whose line was lost as the call ended not sent twice (a line drawn after it sent alone, also after an undo), the agent's ask and Show, its ring where it aimed in its own ink and never in the book, its projects view and a preview opened alone, its rings gone at hang-up, the page thrown away, the cards' answers Wire's keys; an answer clipping onto its note in Wire (Chromium); a walk-through from a card (its page opened at pickup, the agent's Open card and nothing left over what opened, its pointer where it aimed, a miss told, the empty page gone at hang-up, a written one kept), and of a preview in HQ's viewer (the agent's pointer and its ring in its ink where it aimed inside the frame, the ring following as the preview scrolls, nothing on HQ's page, both gone at hang-up); every kind of line the same wet and dry; the Pencil's layer HQ's page beside the open book (a pen on the book's paper drawing nothing, a ring at its edge going in, the pin on the page, over a dialog too, the spread covering it), in WebKit and Chromium; an iPad paired with a desktop by the book's code (a ring live across, finished, swapped, flicked back, closed); the book's stories above (the overview of the day and the week among them, Search, handwriting read into type, a morning with yesterday's answer, a picture dragged in, and HQ's page at every width)${failed ? `, ${failed} failing` : ''}${shots ? ` (screenshots in ${shots})` : ''}`,
);
if (failed) process.exitCode = 1;

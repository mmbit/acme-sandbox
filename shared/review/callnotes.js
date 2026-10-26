// The Pencil on a call (HQ's call tells it what it needs through the document's events: platform/hq/shell/calldraw.js).
// While a call is on, a mark goes on the call's page in the book, not on a sheet: the agent on the call is the one
// listening. No post-it and no mic of its own: the call hears the board, and what it hears while a mark is drawn is
// the note's words. The mark goes into the book once the Pencil has stayed up SETTLE_MS (lines drawn closer together
// are one note: a circle and its arrow), and HQ's call sends it to the agent ('pencil:note', marks.js).
// The agent draws too: a ring in its own ink round what it names on the board's screen, or round one of the call's
// notes, with its words beside it in its hand, kept on the call's page as its note (marks.js draws it, so a
// watch-along records it as the board's ink is).
//   call:on    { call, agent, name, color }   a call is on: its calls row, its agent, its name and its ink
//   call:off   { done }                       it ended; done() once a mark still settling is in the book
//   call:heard { text }                       words the call heard the board say
//   call:ink   { ring | note, words, reply, taken }  the agent asks to draw: taken() at once, reply({ drawn, why }) once
//                                                    it's drawn or can't be
import { anchorOf, isPrivate } from './anchor.js';
import { viewNow } from './mark.js';
import { reset } from './tool.js';
import { say } from './dock.js';
import { lifted, toBook } from './pencil.js';
import * as marks from './marks.js';

// The Pencil up this long and the mark goes: about a breath, so a circle and the arrow after it stay one note
const SETTLE_MS = 1500;
// Words the call heard are kept this long for the mark being drawn (the line hears a phrase once it's finished)
const HEARD_MS = 60_000;
// How long the Pencil's tip says a mark couldn't go into the book
const TOLD_MS = 8000;
// The agent's ring: this far round its target, a hand-drawn loop that overshoots its start a little
const RING_PAD = 10,
  RING_POINTS = 56,
  RING_MS = 14; // (between its points, as a hand draws it: about 0.8 s)

export function setupCall(r) {
  Object.assign(r, {
    call: null,
    callLines: [],
    callHeard: [],
    callMarkAt: 0,
    callNextAt: 0,
    callTimer: 0,
    callFiling: null,
  });
  document.addEventListener('call:on', e => {
    r.call = e.detail;
    r.callHeard = [];
    marks.load(r).catch(err => console.error("The Pencil: the call's page", err));
  });
  document.addEventListener('call:off', e => ended(r).finally(() => e.detail?.done?.()));
  document.addEventListener('call:heard', e => {
    const now = performance.now();
    r.callHeard = [...r.callHeard.filter(h => now - h.at < HEARD_MS), { at: now, text: String(e.detail?.text ?? '') }];
  });
  document.addEventListener('call:ink', e => {
    const { reply } = e.detail;
    e.detail.taken?.();
    draw(r, e.detail).then(reply, err => {
      console.error("The Pencil: the agent's ink", err);
      reply({ drawn: false, why: `HQ couldn't keep it in the book (${err?.message || err})` });
    });
  });
  // the Pencil down holds the mark open; each line it ends gives it SETTLE_MS more. (Down while the last mark goes in:
  // the next mark's first line, its words heard from here.)
  addEventListener(
    'pointerdown',
    e => {
      if (!r.call || e.pointerType !== 'pen') return;
      clearTimeout(r.callTimer);
      if (r.mode === 'idle') r.callMarkAt = performance.now();
      else if (r.mode === 'sending' && !r.callLines.length) r.callNextAt = performance.now();
    },
    true,
  );
  document.addEventListener('ink:stroke', e => {
    if (!r.call || e.detail?.phase !== 'end') return;
    clearTimeout(r.callTimer);
    r.callTimer = setTimeout(() => file(r), SETTLE_MS);
  });
}

// The mark into the call's page with the words heard since its first line; whether it went in. Lines drawn meanwhile
// (pencil.js holds them in r.callLines, drawn) are the next mark's once it's in. If the book didn't take it, the mark
// stays, those lines with it, and the board is told: the next line drawn tries again as it settles.
function file(r) {
  if (!r.call || r.mode !== 'note' || !r.mark) return;
  const words = r.callHeard
    .filter(h => h.at >= r.callMarkAt)
    .map(h => h.text)
    .join(' ')
    .trim();
  Object.assign(r, { spoken: !!words, typed: false });
  r.text.value = words;
  r.mode = 'sending';
  return (r.callFiling = toBook(r).then(
    () => {
      const next = r.callLines.splice(0);
      reset(r);
      r.callMarkAt = r.callNextAt; // (a pen still down now lifts into the next mark: its words count from its pen-down)
      if (next.length) {
        for (const line of next) lifted(r, line);
        r.callTimer = setTimeout(() => file(r), SETTLE_MS);
      }
      return true;
    },
    err => {
      console.error('The Pencil: a note on the call', err);
      r.mode = 'note';
      for (const line of r.callLines.splice(0)) lifted(r, line);
      const why = err?.status ? `The book said no: ${err.message}.` : 'Could not reach the book.';
      say(r, `${why} The mark stays here, and goes in with your next line.`, TOLD_MS);
      return false;
    },
  ));
}

// The call ended: a mark going in, then one still settling (one the book didn't take, tried once more), then the page
// shows its sheet's marks again. One the book still won't take is gone with the call, and the board is told.
async function ended(r) {
  clearTimeout(r.callTimer);
  await r.callFiling;
  if ((await file(r)) === false) {
    say(r, "The call's last mark couldn't go into the book, so it isn't kept.", TOLD_MS);
    reset(r);
  }
  r.call = null;
  r.callHeard = [];
  marks.load(r).catch(err => console.error("The Pencil: the book's marks", err));
}

// ---- the agent's ink
async function draw(r, d) {
  if (!r.call) return { drawn: false, why: 'The call has ended.' };
  const target = d.note ? noted(r, d.note) : named(d.ring);
  if (target.why) return { drawn: false, why: target.why };
  const view = viewNow(),
    stroke = ringAround(target.box, d.color ?? r.call.color, Date.now());
  await unroll(r, stroke);
  const ink = [{ ...stroke, points: stroke.points.map(([x, y, ...rest]) => [x + view.x, y + view.y, ...rest]) }];
  const anchor = anchorOf(target.el, { url: location.href, view, ink });
  const words = String(d.words ?? '').trim();
  await marks.post(r, {
    anchor,
    live: target.el,
    words,
    said: words ? 'written' : undefined,
    snip: null,
    by: r.call.agent,
  });
  return { drawn: true, ...(target.off ? { why: "It's off their screen just now: they'd scroll to see it." } : {}) };
}

// One of the call's marks on this page, by its number
function noted(r, n) {
  const m = r.marks.find(x => x.n === n);
  if (!m) return { why: `There's no note ${n} on the page they're on now (${location.pathname}${location.search}).` };
  const b = marks.whereNow(m);
  return { el: m.live?.isConnected ? m.live : null, box: b.w ? b : { ...b, w: 24, h: 24 } };
}

// What the agent names on the board's screen: the innermost visible element whose words (or label) hold them, one on
// screen first, the smallest of those. Never inside private parts or the call's own controls.
const flat = s =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
const SKIP = new Set(['script', 'style', 'template', 'noscript', 'head']);
function named(words) {
  const want = flat(words);
  if (!want) return { why: 'Name what to ring by the words they can see on it.' };
  const says = el =>
    flat(`${el.textContent} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('alt') ?? ''}`).includes(want);
  const hits = [...document.body.querySelectorAll('*')].filter(
    el => !SKIP.has(el.localName) && !el.closest('[data-watchalong-hide]') && says(el),
  );
  const shown = hits
    .filter(el => !hits.some(o => o !== el && el.contains(o)) && !isPrivate(el))
    .map(el => ({ el, box: el.getBoundingClientRect() }))
    .filter(({ el, box }) => box.width && box.height && getComputedStyle(el).visibility !== 'hidden');
  if (!shown.length)
    return { why: `Nothing on their screen says “${words}”: they're on ${location.pathname}${location.search}.` };
  const onScreen = ({ box }) => box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
  const best = (shown.some(onScreen) ? shown.filter(onScreen) : shown).sort(
    (a, b) => a.box.width * a.box.height - b.box.width * b.box.height,
  )[0];
  const b = best.box;
  return { el: best.el, box: { x: b.left, y: b.top, w: b.width, h: b.height }, off: !onScreen(best) };
}

// A ring round a box (screen px) as a hand draws one: a loop a little out of round, starting top left, overshooting
// where it began, lighter at its ends. seed: its wobble, so no two rings are alike
function ringAround(b, color, seed) {
  let s = seed >>> 0 || 1;
  const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const cx = b.x + b.w / 2,
    cy = b.y + b.h / 2,
    rx = b.w / 2 + RING_PAD,
    ry = b.h / 2 + RING_PAD,
    from = -2.4 + rand() * 0.5,
    turn = 2 * Math.PI + 0.35 + rand() * 0.25,
    [p, q] = [rand() * 6, rand() * 6];
  const points = [];
  for (let i = 0; i <= RING_POINTS; i++) {
    const f = i / RING_POINTS,
      a = from + turn * f,
      k = (1 + 0.04 * Math.sin(2 * a + p) + 0.025 * Math.sin(3 * a + q)) * (1 + 0.07 * f);
    points.push([
      Math.round((cx + rx * k * Math.cos(a)) * 10) / 10,
      Math.round((cy + ry * k * Math.sin(a)) * 10) / 10,
      Math.round((0.35 + 0.4 * Math.sin(Math.PI * f)) * 100) / 100,
      i * RING_MS,
    ]);
  }
  return { color, size: 4, points };
}
// The ring drawn as a hand would, over the page's marks, before it's kept
function unroll(r, stroke) {
  const end = stroke.points.at(-1)[3],
    start = performance.now();
  return new Promise(done => {
    const frame = () => {
      const t = performance.now() - start;
      marks.paint(r, [...marks.openLines(r), { ...stroke, points: stroke.points.filter(p => p[3] <= t) }]);
      if (t < end) requestAnimationFrame(frame);
      else done();
    };
    requestAnimationFrame(frame);
  });
}

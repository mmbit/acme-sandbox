// The Pencil on HQ's own pages (review mode with the book: data-book on its script). The one rule: the Pencil writes,
// a finger works the page. No button and no mode: a pen drawn across any HQ page draws there, and a finger still
// scrolls and taps under the ink (the page never scrolls under the pen). A pen's tap stays the page's, and a pen in a
// text field is Apple's handwriting-to-text. A mouse draws with the pin, as review mode always has.
//   - A mark is the lines drawn while its post-it is open: its number shows at it on the page (marks.js), the mic
//     starts with its first line and the words said go in its note, typed ones too. Send puts the note on its sheet in
//     the book; it stays on the page, numbered, until the sheet goes.
//   - Hold the pen still on one spot and talk: a voice note there, its words landing as the pen lifts.
//   - Scribble over a mark: it's wiped. Ring something: the mark is on what's inside the ring.
//   - A two-finger tap takes back the last thing, whatever it was (Cmd or Ctrl+Z too). Nothing asks "are you sure?".
// The book hears each note as it's made ('pencil:note').
import * as inkjs from './ink.js';
import { aim, boxOfLines, marked } from './mark.js';
import { under } from './surface.js';
import { compose, develop } from './postit.js';
import { expose } from './snapshot.js';
import { canRecord, stopMic } from './dictation.js';
import { cancel } from './tool.js';
import { ACCENT } from './base.js';
import * as marks from './marks.js';

const MOVE = 4; // px a pen moves before it draws: less is a tap, the page's own
const HOLD_MS = 550; // a pen held this still this long starts a voice note
const TAP_MS = 350; // a two-finger tap: both fingers down and up within this, barely moving
const TAP_SLOP = 12;

export const CSS = `
      .listen { position: absolute; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; pointer-events: none;
        background: radial-gradient(${ACCENT} 0 5px, transparent 6px), radial-gradient(rgba(255,90,95,.35), transparent 70%);
        animation: listen 1.1s ease-in-out infinite; }
      .listen[hidden] { display: none; }
      @keyframes listen { 50% { transform: scale(1.35); opacity: .7 } }`;
// (.pencil: a hidden stand-in for the surface inkjs.pen wants, so its lines are in the window's px from its corner; the
// pen's events reach it from the window (penDown...), so a tap on review mode's own buttons stays theirs)
export const HTML = '<i class="listen" hidden aria-hidden="true"></i><i class="pencil" hidden></i>';

// A touch beside HQ's page, on the book (outside <body>, platform/hq/shell/book.js): the book's, never the page's ink.
const offPage = e => !e.composedPath().includes(document.body);
// Where a pen's touch belongs to the page or the browser, not the ink: review mode's own UI, the book, and text fields
// (Scribble writes in them)
function theirs(r, e) {
  const path = e.composedPath();
  if (path.includes(r.host) || offPage(e)) return true;
  const t = path[0];
  return !!(
    t instanceof Element && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
  );
}
// The pen may draw now: on the page, nothing of review mode's over it (a mouse's marking has its own veil). On a call,
// while the last mark goes in too: callnotes.js.
const free = r =>
  !r.covered &&
  r.side.hidden &&
  r.zoom.hidden &&
  r.veil.hidden &&
  (r.mode === 'idle' || r.mode === 'note' || (r.call && r.mode === 'sending'));

// A scribble: a line going back and forth over itself, far longer than the box it fills
export function scribbled(points) {
  if (points.length < 8) return false;
  let length = 0,
    turns = 0,
    dir = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0],
      dy = points[i][1] - points[i - 1][1];
    length += Math.hypot(dx, dy);
    const d = Math.abs(dx) >= Math.abs(dy) ? Math.sign(dx) : 2 * Math.sign(dy);
    if (d && dir && d === -dir) turns++;
    if (d) dir = d;
  }
  const b = boxOfLines([{ points }]);
  return turns >= 4 && length > 3.5 * Math.max(b.w, b.h, 1);
}
// A ring: a line that comes back near where it started, round something bigger than a dot
export function ringed(points) {
  if (points.length < 8) return false;
  const b = boxOfLines([{ points }]),
    [x0, y0] = points[0],
    [x1, y1] = points[points.length - 1];
  return Math.min(b.w, b.h) > 24 && Math.hypot(x1 - x0, y1 - y0) < 0.25 * Math.max(b.w, b.h);
}
// What a ring holds: the biggest element inside it, from the one under its middle out
function inside(r, area) {
  let el = under(r, area.x + area.w / 2, area.y + area.h / 2);
  const fits = e => {
    const b = e.getBoundingClientRect();
    return (
      b.left >= area.x - area.w * 0.1 &&
      b.right <= area.x + area.w * 1.1 &&
      b.top >= area.y - area.h * 0.1 &&
      b.bottom <= area.y + area.h * 1.1
    );
  };
  while (el.parentElement && el.parentElement !== document.body && fits(el.parentElement)) el = el.parentElement;
  return el;
}

// A line the Pencil finished, in the screen's px
export function lifted(r, stroke) {
  r.pencil.clear();
  // (on a call, a line drawn while the last mark goes into the book waits, drawn, for it: callnotes.js.)
  if (r.call && r.mode === 'sending') {
    r.callLines.push(stroke);
    return marks.paint(r);
  }
  const pts = stroke.points,
    area = boxOfLines([stroke]);
  if (scribbled(pts)) {
    const hit = marks.markAt(r, area);
    if (hit === 'open') return wipeOpen(r);
    if (hit) return wipeMark(r, hit);
  }
  if (r.mode === 'note' && r.mark) {
    // another line of the mark being made
    r.strokes.push(marks.intoMark(r, stroke));
    if (marks.openLines(r, r.strokes) === r.strokes) aim(r); // (scrolled since, the first lines' element stays)
    marks.paint(r);
    develop(r);
    return;
  }
  if (r.mode !== 'idle') return;
  // the first line: a new mark, its note, its number and the mic
  r.strokes = [stroke];
  r.mark = { kind: 'circle' };
  aim(r);
  if (ringed(pts)) flash(r, (r.mark.el = inside(r, area)));
  begin(r);
}
function begin(r) {
  r.undoTo = { mark: null, shot: null, exposure: null, editing: null };
  r.markNumber = null;
  marks.paint(r);
  const mark = r.mark;
  marks.nextNumber(r).then(n => {
    if (r.mark !== mark) return;
    r.markNumber = n;
    marks.paint(r);
  });
  compose(r);
}
// a ring's pick, outlined for a moment
function flash(r, el) {
  const b = el.getBoundingClientRect();
  Object.assign(r.hl.style, {
    left: `${b.left - 3}px`,
    top: `${b.top - 3}px`,
    width: `${b.width + 6}px`,
    height: `${b.height + 6}px`,
  });
  r.hl.hidden = false;
  setTimeout(() => (r.hl.hidden = true), 700);
}

// Send, on the post-it: the note on its sheet in the book (its words once any still being said are in). The post-it
// goes, the mark stays on the page with its number. Returns whether it went without its photo (the screenshot failed,
// or was still developing after 9 s), for the post-it to say so.
export async function toBook(r) {
  const words = r.text.value.trim(),
    said = !words ? null : r.spoken && !r.typed ? 'spoken' : 'typed',
    general = r.mark.kind === 'general';
  const taken = general ? null : await Promise.race([r.shot, new Promise(res => setTimeout(() => res(null), 9000))]);
  const snip =
    taken &&
    marks.snipOf(
      { c: expose(r, taken, r.mark), k: taken.k },
      r.strokes.length ? boxOfLines(r.strokes) : r.mark.element.rect,
    );
  const anchor = general ? { ...marked(r), el: null } : marked(r);
  const note = await marks.post(r, { anchor, live: r.mark.el, words, said, snip });
  r.steps.push({ kind: 'note', id: note.id });
  return !general && !snip;
}

// Hold still to talk: a pin where the pen is, the mic on, a red pulse at its tip; lifted, the words land
function hold(r, e) {
  r.holding = { x: e.clientX, y: e.clientY, fresh: r.mode === 'idle' };
  Object.assign(r.listen.style, { left: `${e.clientX}px`, top: `${e.clientY}px` });
  r.listen.hidden = false;
  if (r.holding.fresh) {
    r.strokes = [];
    r.mark = { kind: 'pin', x: e.clientX, y: e.clientY, el: under(r, e.clientX, e.clientY), area: null };
    begin(r);
  } else if (canRecord && !r.rec && !r.stopping) r.mic.click();
}
async function letGo(r) {
  const { fresh } = r.holding,
    mark = r.mark;
  r.holding = null;
  r.listen.hidden = true;
  await stopMic(r);
  if (r.mark !== mark || r.mode !== 'note' || !fresh) return;
  if (r.text.value.trim()) r.pinIt.click();
  else if (canRecord) cancel(r); // (nothing heard: no note)
}

// Wiping: the mark being made goes with its post-it; one on its sheet goes from it too. Both come back with an undo.
function wipeOpen(r) {
  r.steps.push({ kind: 'unwipeOpen', strokes: r.strokes, mark: r.mark, words: r.text.value });
  cancel(r);
}
async function wipeMark(r, m) {
  const note = await marks.noteOf(r, m.id);
  await marks.wipe(r, m);
  r.steps.push({ kind: 'unwipe', m, note });
  await marks.load(r);
}

// Undo anything: the last line of the mark being made (the first one: the mark goes), else the last note sent to the
// sheet comes off it, else the last wipe comes back
export async function undo(r) {
  if (r.mode === 'note' && r.strokes.length > (r.mark?.kind === 'circle' ? 1 : 0)) {
    r.strokes.pop();
    aim(r);
    marks.paint(r);
    develop(r);
    return;
  }
  if (r.mode === 'note') return cancel(r);
  if (r.mode !== 'idle') return;
  const step = r.steps.pop();
  if (!step) return;
  if (step.kind === 'note' || step.kind === 'unwipe') {
    const m = step.kind === 'note' && r.marks.find(x => x.id === step.id);
    try {
      if (m) await marks.wipe(r, m);
      if (step.kind === 'unwipe') await marks.unwipe(r, step.m, step.note);
    } catch (err) {
      r.steps.push(step); // (the book didn't take it: the step is still there to undo)
      throw err;
    }
    await marks.load(r);
  } else if (step.kind === 'unwipeOpen') {
    r.strokes = step.strokes;
    r.mark = { kind: step.mark.kind, x: step.mark.x, y: step.mark.y, el: step.mark.el, area: step.mark.area };
    if (r.mark.kind === 'circle') aim(r);
    begin(r);
    r.text.value = step.words;
  }
}

// The pen on the page: down, then moved past MOVE, draws (the line from where it touched); held still, listens.
// p: the pen's state, { down: its pointerdown, drawing, timer }
const stopClick = c => c.isTrusted && c.stopPropagation(); // (the browser's, not a Send this file presses)
// (a line drawn, or a voice note, is no click on what the pen lifted over)
function noClick() {
  addEventListener('click', stopClick, { capture: true, once: true });
  setTimeout(() => removeEventListener('click', stopClick, true), 400);
}
const penDown = (r, p) => e => {
  if (e.pointerType !== 'pen' || !e.isPrimary || !free(r) || theirs(r, e)) return;
  r.penSeen = true;
  Object.assign(p, { down: e, drawing: false });
  // (a call hears the board already: no voice note on one.)
  p.timer = setTimeout(() => p.down === e && !p.drawing && !r.call && hold(r, e), HOLD_MS);
};
const penMove = (r, p) => e => {
  if (!p.down || e.pointerId !== p.down.pointerId || r.holding) return;
  if (!p.drawing) {
    if (Math.hypot(e.clientX - p.down.clientX, e.clientY - p.down.clientY) < MOVE) return;
    clearTimeout(p.timer);
    p.drawing = r.pencil.start(p.down);
    if (!p.drawing) return (p.down = null);
  }
  e.stopPropagation();
  r.pencil.move(e);
};
const penUp = (r, p) => e => {
  if (!p.down || e.pointerId !== p.down.pointerId) return;
  clearTimeout(p.timer);
  const drew = p.drawing,
    held = !!r.holding;
  p.down = null;
  p.drawing = false;
  if (drew) {
    e.stopPropagation();
    if (e.type === 'pointercancel') r.pencil.cancel(e);
    else r.pencil.end(e);
  }
  if (held) letGo(r);
  if (drew || held) noClick();
};
function pen(r) {
  const p = { down: null, drawing: false, timer: 0 };
  addEventListener('pointerdown', penDown(r, p), true);
  addEventListener('pointermove', penMove(r, p), true);
  addEventListener('pointerup', penUp(r, p), true);
  addEventListener('pointercancel', penUp(r, p), true);
  // (Safari scrolls under a pen until its first touchmove says no; a finger's still scroll)
  addEventListener(
    'touchmove',
    e => (p.down || r.holding) && [...e.changedTouches].some(t => t.touchType === 'stylus') && e.preventDefault(),
    { capture: true, passive: false },
  );
}

// Two fingers tapped together, anywhere on the page: undo
function twoFingerTap(r) {
  let tap = null;
  const fingers = e => [...e.touches].filter(t => t.touchType !== 'stylus');
  addEventListener(
    'touchstart',
    e => {
      const f = fingers(e);
      if (offPage(e)) tap = null;
      else if (f.length === 2 && e.touches.length === 2)
        tap = { at: e.timeStamp, from: f.map(t => [t.clientX, t.clientY]) };
      else if (e.touches.length > 2) tap = null;
    },
    { capture: true, passive: true },
  );
  addEventListener(
    'touchmove',
    e => {
      if (!tap) return;
      const moved = [...e.touches].some(
        (t, i) => tap.from[i] && Math.hypot(t.clientX - tap.from[i][0], t.clientY - tap.from[i][1]) > TAP_SLOP,
      );
      if (moved) tap = null;
    },
    { capture: true, passive: true },
  );
  addEventListener(
    'touchend',
    e => {
      if (!tap || e.touches.length) return;
      const quick = e.timeStamp - tap.at < TAP_MS;
      tap = null;
      if (quick && !r.covered) undo(r);
    },
    { capture: true, passive: true },
  );
}

export function setupPencil(r) {
  r.marks = [];
  r.steps = [];
  r.listen = r.$('.listen');
  r.pinIt.textContent = 'Send';
  r.text.addEventListener('input', () => (r.typed = true));
  r.pencil = inkjs.pen(r.$('.pencil'), r.wet, {
    halo: true,
    under: r.haloCanvas,
    ink: () => inkjs.INKS[r.inkNow],
    end: stroke => lifted(r, stroke),
  });
  pen(r);
  twoFingerTap(r);
  // the marks follow the page: scrolled, resized, or another of HQ's pages (it changes its address itself)
  let queued = false;
  const again = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      marks.paint(r);
    });
  };
  addEventListener('scroll', again, { capture: true, passive: true });
  addEventListener('resize', again);
  // (the book out of reach: the page keeps the marks it shows, and the console says why)
  const load = () => marks.load(r).catch(err => console.error("The Pencil: the book's marks", err));
  let url = location.pathname + location.search;
  setInterval(() => {
    const now = location.pathname + location.search;
    if (now !== url) {
      url = now;
      r.steps = []; // (what was done on the other page stays there)
      load();
    } else if (r.marks.length) again(); // (HQ's own layout moves things too)
  }, 1000);
  load();
  addEventListener('pageshow', load);
}
// What a reset leaves: no number for the next mark until it has one
export const unmark = r => {
  r.markNumber = null;
  r.spoken = r.typed = false;
  if (r.book) r.pinIt.textContent = 'Send';
};

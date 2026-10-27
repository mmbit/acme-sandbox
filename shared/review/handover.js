// The open mark on a second screen: HQ pairs a phone or tablet with a desktop (platform/hq/shell/pair.js), and a mark
// begun on one can be finished on the other: ring on the phone and type on the computer, ring with the mouse and
// scribble on the phone. HQ's pairing and the Pencil talk only through the document's events, and only while
// <html data-paired> says a second screen is there:
//   pencil:mark  { mark | null }        (out) the open mark now, each time it changes (a line, its words), null once gone
//   pencil:flick { mark }               (out) the board flicked the post-it away: HQ sends it to the other screen
//   pencil:hand  { take: mark, back, reply }  (in) a mark from the other screen opens here, post-it and caret ready
//                                        (back: one of this screen's own that didn't stay there, where it was drawn);
//                                        reply(whether it did: not while a mark of this screen's own is open)
//   pencil:hand  { give: true, reply }  (in) the open mark leaves for the other screen: reply(mark), or null with none
// A mark is { anchor, words, typed }: the anchor as a note keeps it (anchor.js, document px, its element found again on
// any width), its words said or typed so far, and whether any were typed on this screen. On a call nothing goes across: the call's agent is the one listening.
// On the page's screen (<html data-paired="page">) a mark made there opens no post-it: it goes to the book's screen once
// the pen rests, so nothing pops up and away under the pen. It goes with `snap`, its own picture as the board saw it
// there (the snip a note keeps), `round`, what it's round (anchor.js roundOf: { selector, tag, text, box } in document
// px, or null), and `taken` once it came from the other screen to be finished here. It lands on the other screen's page
// only where anchor.js's lands() says it can (the same element there, the mark about all of it); anywhere else it opens
// there as that picture, nothing drawn on the page.
import { anchorOf, found, landing, placer, roundOf } from './anchor.js';
import { aim, boxOfLines, marked, viewNow } from './mark.js';
import { under } from './surface.js';
import { reset } from './tool.js';
import { expose } from './snapshot.js';
import { snapped } from './postit.js';
import * as marks from './marks.js';

// A post-it thrown this fast (px per ms, over its last moves) and this far goes to the other screen
const FLICK_SPEED = 0.8,
  FLICK_PX = 60;
// The open mark's words are told this long after the last letter
const WORDS_MS = 150;

const paired = () => 'paired' in document.documentElement.dataset;
// The open mark as it goes across, or null: none, a change of an old note, or a call's
const open = r =>
  r.mode === 'note' && r.mark?.element && !r.editing && !r.call
    ? {
        anchor: marked(r),
        round: roundNow(r),
        words: r.text.value,
        typed: !!r.typed,
        ...(r.mark.taken && { taken: true }),
        ...(r.mark.snap && { snap: r.mark.snap }),
      }
    : null;
// What the open mark is round, as another screen finds it (its lines' box, or a pin's element), or null
function roundNow(r) {
  const area = r.strokes.length ? boxOfLines(r.strokes) : null,
    el = area ? roundOf(under(r, area.x + area.w / 2, area.y + area.h / 2), area) : r.mark.el;
  return el?.isConnected ? anchorOf(el, { url: location.href, view: viewNow() }).el : null;
}
// Tell the pairing what the open mark is now (pencil.js and tool.js call it on each change)
export function moved(r) {
  if (!paired()) return;
  document.dispatchEvent(new CustomEvent('pencil:mark', { detail: { mark: open(r) } }));
}

// begin: pencil.js's, a new mark's number, post-it and mic
export function setupHandover(r, { begin }) {
  let timer = 0;
  r.text.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => moved(r), WORDS_MS);
  });
  document.addEventListener('pencil:hand', e => {
    const d = e.detail ?? {};
    if (d.take) d.reply?.(take(r, d.take, begin, !!d.back));
    else if (d.give) give(r).then(mark => d.reply?.(mark));
  });
  flick(r);
}

// The mark leaves: its lines go from this page with it (nothing is wiped: it's the other screen's now), and its picture
// as this screen showed it, once its screenshot is in: the same wait as the post-it's polaroid here, snapshot.js's own
// for the page's fonts and pictures
async function give(r) {
  const mark = open(r);
  if (!mark) return null;
  const { shot, strokes } = r,
    m = r.mark;
  reset(r);
  marks.paint(r);
  const taken = await Promise.resolve(shot).catch(() => null);
  if (!taken) return mark; // (no picture: the other screen says none came across, postit.js snapped())
  const area = strokes.length ? boxOfLines(strokes) : m.element.rect;
  return { ...mark, snap: marks.snipOf({ c: expose({ strokes }, taken, m), k: taken.k }, area) };
}

// A mark from the other screen: its element brought into view, its lines on it as they were drawn there, the post-it
// open with its words and the caret after them. back: one of this screen's own, come back
function take(r, { anchor, round = null, words = '', typed = false, snap = null }, begin, back = false) {
  if (r.mode !== 'idle' || r.call || !anchor?.v) return false;
  if (back) {
    // (one of this screen's own goes back where it was, by its own anchor; one that came here as the other screen's
    // picture, about no element of this page, goes back as that picture)
    if (snap && !anchor.el) snapped(r, snap, null);
    else put(r, anchor, anchor, (anchor.el?.selector && found(anchor.el.selector, document)) || null, begin);
    return finish(r, words, typed);
  }
  // (one from the other screen lands on what it's round only where lands() says; anywhere else it comes as that
  // screen's picture, nothing drawn on this page)
  const by = { el: round },
    el = landing(by, document, { x: scrollX, y: scrollY }, anchor.ink ?? []);
  if (el) put(r, anchor, by, el, begin);
  else snapped(r, snap, anchor.el);
  return finish(r, words, typed);
}
// The mark drawn on this page: anchor's lines placed by `by`'s element (anchor.js placer), round el when it's here, or
// its pin where that element is, and begun as this screen's open mark
function put(r, anchor, by, el, begin) {
  el?.scrollIntoView({ block: 'center', inline: 'nearest' });
  const scroll = { x: scrollX, y: scrollY },
    at = placer(by, document, scroll, el);
  r.strokes = (anchor.ink ?? []).map(l => ({
    ...l,
    points: l.points.map(p => {
      const [x, y, ...rest] = at(p);
      return [x - scroll.x, y - scroll.y, ...rest];
    }),
  }));
  if (r.strokes.length) {
    r.mark = { kind: 'circle' };
    aim(r);
    if (el) r.mark.el = el;
  } else {
    const [x, y] = by.el?.box ? at([by.el.box.x, by.el.box.y]) : [scroll.x + 40, scroll.y + 40];
    r.mark = { kind: anchor.kind === 'general' ? 'general' : 'pin', x: x - scroll.x, y: y - scroll.y, el, area: null };
  }
  r.mark.taken = true; // (finished here: its post-it opens, and it doesn't go across again by itself)
  begin(r);
}
// (it came from the other screen: finished here, its words in and the caret after them)
function finish(r, words, typed) {
  r.text.value = words;
  Object.assign(r, { typed: !!words && typed, spoken: !!words && !typed });
  // (the post-it lands a moment after the mark: the caret goes in once it's there)
  setTimeout(() => r.mode === 'note' && r.text.focus({ preventScroll: true }), 420);
  return true;
}

// The post-it thrown off the screen by its paper (not its words or buttons): it flies on the way it went, and once
// it's gone HQ sends the mark across
function flick(r) {
  r.sheet.addEventListener('pointerdown', e => {
    if (!paired() || !open(r) || !e.isPrimary || e.button > 0) return;
    if (e.composedPath()[0]?.closest?.('textarea, input, button, a, select')) return;
    const x0 = e.clientX,
      y0 = e.clientY,
      trail = [[e.timeStamp, x0, y0]];
    const onMove = m => {
      if (m.pointerId !== e.pointerId) return;
      trail.push([m.timeStamp, m.clientX, m.clientY]);
      if (trail.length > 6) trail.shift();
      r.sheet.style.translate = `${m.clientX - x0}px ${m.clientY - y0}px`;
    };
    const onUp = u => {
      if (u.pointerId !== e.pointerId) return;
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      removeEventListener('pointercancel', onUp);
      const [t, xa, ya] = trail.find(([t]) => t >= u.timeStamp - 100) ?? trail[0],
        dt = Math.max(1, u.timeStamp - t),
        vx = (u.clientX - xa) / dt,
        vy = (u.clientY - ya) / dt,
        far = Math.hypot(u.clientX - x0, u.clientY - y0);
      if (u.type === 'pointerup' && far > FLICK_PX && Math.hypot(vx, vy) > FLICK_SPEED) return away(r, vx, vy);
      r.sheet.animate([{ translate: r.sheet.style.translate }, { translate: '0 0' }], { duration: 180 });
      r.sheet.style.translate = '';
    };
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
    addEventListener('pointercancel', onUp);
  });
}
function away(r, vx, vy) {
  const mark = open(r),
    k = 900 / Math.max(0.01, Math.hypot(vx, vy)),
    from = r.sheet.style.translate || '0 0';
  const [x, y] = from.split(' ').map(parseFloat);
  r.sheet
    .animate(
      [
        { translate: from, opacity: 1 },
        { translate: `${x + vx * k}px ${(y || 0) + vy * k}px`, opacity: 0 },
      ],
      {
        duration: 240,
        easing: 'ease-in',
      },
    )
    .finished.catch(() => {})
    .finally(() => {
      document.dispatchEvent(new CustomEvent('pencil:flick', { detail: { mark } }));
      r.sheet.style.translate = '';
    });
}

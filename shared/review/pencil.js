// The Pencil on HQ's own pages (review mode with the book: data-book on its script). The one rule: the Pencil writes,
// a finger works the page. No button and no mode: a pen drawn across any HQ page draws there, and a finger still
// scrolls and taps under the ink (the page never scrolls under the pen). A pen's tap stays the page's, and a pen in a
// text field is Apple's handwriting-to-text. A mouse draws with the pin, as review mode always has.
//   - A mark is the lines drawn while the pen keeps coming back: the mic starts with its first line (on a call, the
//     call hears it) and the words said go in its note. Rest the pen and it lifts into the book as a note, a hairline
//     left on the page (settle.js, marks.js). No post-it and no Send.
//   - Draw on or beside a note's hairline and the lines join that note.
//   - Hold the pen still on one spot and talk: a voice note there, its words landing as the pen lifts.
//   - Scribble over a mark or a hairline: it's wiped, from the book too. Ring something: the mark is on what's inside
//     the ring.
//   - A two-finger tap takes back the last thing, whatever it was (Cmd or Ctrl+Z too). Nothing asks "are you sure?".
// The pen's touches are pentouch.js's. The book hears each note as it's made ('pencil:note').
import * as inkjs from './ink.js';
import { aim, boxOfLines } from './mark.js';
import { compose, develop, towards } from './postit.js'; // (towards)
import { canRecord } from './dictation.js';
import { reset } from './acts.js';
import { ACCENT } from './base.js';
import * as marks from './marks.js';
import { followPage } from './markfollow.js';
// (sent notes' hairlines, and a ring carried into the book.)
import * as hairline from './hairline.js';
import { inside, ringed, scribbled } from './gestures.js';
// (the pen's touches, a mark's end and a note joined.)
import { setupTouch, theirs } from './pentouch.js';
import { setupSettle } from './settle.js';
import { hairTaps } from './marktaps.js';
import { joining, unjoin } from './join.js';
import { setupCarry } from './carry.js';
// (handwriting read into type.)
import * as written from './written.js';
// (the open mark finished on a second screen.)
import { moved, setupHandover } from './handover.js';

export const CSS = `
      .listen { position: absolute; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; pointer-events: none;
        background: radial-gradient(${ACCENT} 0 5px, transparent 6px), radial-gradient(rgba(255,90,95,.35), transparent 70%);
        animation: listen 1.1s ease-in-out infinite; }
      .listen[hidden] { display: none; }
      @keyframes listen { 50% { transform: scale(1.35); opacity: .7 } }${hairline.CSS}`;
// (.pencil: a hidden stand-in for the surface inkjs.pen wants, so its lines are in the window's px from its corner; the
// pen's events reach it from the window (penDown...), so a tap on review mode's own buttons stays theirs)
export const HTML = `<i class="listen" hidden aria-hidden="true"></i><i class="pencil" hidden></i>${hairline.HTML}`;

// A line the Pencil finished, in the screen's px
function lifted(r, stroke) {
  r.pencil.clear();
  // (a line drawn while the last mark goes into the book waits, drawn, for it: settle.js.)
  if (r.mode === 'sending') {
    r.nextLines.push(stroke);
    return marks.paint(r);
  }
  listening(r, stroke);
  const pts = stroke.points,
    area = boxOfLines([stroke]);
  if (scribbled(pts) && scribbledOut(r, area)) return;
  if (r.mode === 'note' && r.mark) {
    // another line of the mark being made
    r.strokes.push(marks.intoMark(r, stroke));
    if (marks.openLines(r, r.strokes) === r.strokes) aim(r); // (scrolled since, the first lines' element stays)
    marks.paint(r);
    develop(r);
    written.readSoon(r);
    moved(r);
    return;
  }
  if (r.mode !== 'idle') return;
  // the first line: a new mark, its note, its number and the mic; on or beside a note's hairline, that note again
  // (join.js.)
  const joins = joining(r, area);
  r.strokes = [...(joins?.lines ?? []), stroke];
  r.mark = { kind: 'circle', ...(joins && { joins: joins.m }) };
  aim(r);
  if (ringed(pts)) {
    flash(r, (r.mark.el = inside(r, area)));
    r.mark.ringed = true; // (a finger can carry what it holds into the book: carry.js)
  }
  begin(r);
  moved(r);
}
// A scribble over a mark or a hairline: what it wipes, if anything (whether it did)
function scribbledOut(r, area) {
  const hit = marks.markAt(r, area);
  // (an open mark joining a note wipes the note)
  if (hit === 'open' && r.mark.joins) wipeJoined(r);
  else if (hit === 'open') wipeOpen(r);
  else if (hit) {
    moved(r); // (the scribble was live on a second screen, and no mark follows to hold it: now it goes.)
    wipeMark(r, hit);
  }
  if (hit) return true;
  // (over a sent note's hairline: only the hairline clears.)
  const went = r.mode === 'idle' && marks.sentHairAt(r, area);
  if (!went) return false;
  moved(r);
  marks.clearHair(r, went);
  r.steps.push({ kind: 'unclear', n: went });
  return true;
}
function begin(r) {
  r.undoTo = { mark: null, shot: null, exposure: null };
  r.markNumber = r.mark.joins?.n ?? null;
  marks.paint(r);
  const mark = r.mark;
  if (!mark.joins)
    marks.nextNumber(r).then(n => {
      if (r.mark !== mark) return;
      r.markNumber = n;
      marks.paint(r);
    });
  compose(r);
  towards(r, mark);
  written.readSoon(r);
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

// Wiping: the mark being made goes with its post-it; one on its sheet goes from it too. Both come back with an undo.
function wipeOpen(r) {
  r.steps.push({ kind: 'unwipeOpen', strokes: r.strokes, mark: r.mark, words: r.text.value });
  reset(r);
}
// ...and a mark joining a note: the note goes, from the book too.
function wipeJoined(r) {
  const m = r.mark.joins;
  reset(r);
  return wipeMark(r, m);
}
async function wipeMark(r, m) {
  await marks.wipe(r, m);
  r.steps.push({ kind: 'unwipe', m });
  await marks.load(r);
}

// Undo anything: the last line of the mark being made (the first one: the mark goes), else the last note sent to the
// sheet comes off it, else the last wipe comes back
export async function undo(r) {
  // (a mark joining a note keeps the note's own lines)
  const floor = r.mark?.kind === 'circle' ? 1 + (r.mark.joins ? r.mark.joins.anchor.ink.length : 0) : 0;
  if (r.mode === 'note' && r.strokes.length > floor) {
    r.strokes.pop();
    aim(r);
    marks.paint(r);
    develop(r);
    written.readSoon(r);
    moved(r);
    return;
  }
  if (r.mode === 'note') return reset(r);
  if (r.mode !== 'idle') return;
  const step = r.steps.pop();
  if (!step) return;
  if (step.kind === 'note' || step.kind === 'unwipe') {
    const m = step.kind === 'note' && r.marks.find(x => x.id === step.id);
    try {
      if (m) await marks.wipe(r, m);
      if (step.kind === 'unwipe') await marks.unwipe(r, step.m);
    } catch (err) {
      r.steps.push(step); // (the book didn't take it: the step is still there to undo)
      throw err;
    }
    await marks.load(r);
  } else if (step.kind === 'unclear') {
    marks.clearHair(r, step.n, false);
  } else if (step.kind === 'join') {
    await unjoin(r, step);
  } else if (step.kind === 'unwipeOpen') {
    r.strokes = step.strokes;
    r.mark = { kind: step.mark.kind, x: step.mark.x, y: step.mark.y, el: step.mark.el, area: step.mark.area };
    if (r.mark.kind === 'circle') aim(r);
    begin(r);
    r.text.value = step.words;
  }
}

export function setupPencil(r) {
  r.marks = [];
  r.steps = [];
  r.listen = r.$('.listen');
  r.pinIt.textContent = 'Send';
  written.typing(r);
  r.pencil = inkjs.pen(r.$('.pencil'), r.wet, {
    halo: true,
    under: r.haloCanvas,
    ink: () => inkjs.INKS[r.inkNow],
    end: stroke => lifted(r, stroke),
  });
  // (what the pen's touches and a mark's end do with the Pencil's own, handed in: they never import it.)
  setupTouch(r, { begin, undo });
  setupSettle(r, { lifted });
  setupHandover(r, { begin });
  hairTaps(r);
  carry(r);
  followPage(r);
}
// A ring just drawn, carried by a finger into the book (carry.js): the ring's line on the screenshot and on the screen
// now, while it's open and its screenshot taken. Once taped, a note with no words yet goes: the ring was for keeping.
// Or a note's ring kept as a hairline, its snip taped (the note stays).
function carry(r) {
  setupCarry(r, {
    ring: at => {
      if (r.mode === 'idle') return marks.hairRingAt(r, at);
      if (r.mode !== 'note' || !r.mark?.ringed || !r.exposure || !r.strokes.length) return null;
      const [then] = r.strokes,
        [now] = marks.openLines(r, [then]);
      return { then: then.points, now: now.points, shot: r.exposure };
    },
    carried: () => r.mode === 'note' && !r.text.value.trim() && reset(r),
    onPage: e => !theirs(r, e),
  });
}

// The mic's pulse at the end of the line just drawn, while it listens for the mark's words (not on a call: the call
// hears them).
function listening(r, stroke) {
  if (r.call || !canRecord || r.mode === 'sending') return;
  const [x, y] = stroke.points.at(-1);
  Object.assign(r.listen.style, { left: `${x}px`, top: `${y}px` });
  r.listen.hidden = false;
}

// What a reset leaves: no number for the next mark until it has one
export const unmark = r => {
  r.markNumber = null;
  if (r.listen && !r.holding) r.listen.hidden = true;
  r.spoken = r.typed = false;
  if (r.book) r.pinIt.textContent = 'Send';
  if (r.book) moved(r); // (no open mark now: a second screen hears so.)
  // (the sheets read while it was made)
  if (r.marksStale) {
    r.marksStale = false;
    r.loadMarks();
  }
};

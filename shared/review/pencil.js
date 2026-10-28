// The Pencil on HQ's own pages (review mode with the book: data-book on its script). The one rule: the Pencil writes,
// a finger works the page. No button and no mode: a pen drawn across any HQ page draws there, and a finger still
// scrolls and taps under the ink (the page never scrolls under the pen). A pen's tap stays the page's, and a pen in a
// text field is Apple's handwriting-to-text. A mouse draws with the pin, as review mode always has.
//   - A mark is the lines drawn while the pen keeps coming back: the mic starts with its first line (on a call, the
//     call hears it) and the words said go in its note. Rest the pen and it lifts into the book as a note, the page left
//     clean: nothing of it stays drawn (settle.js, marks.js paint: rule zero).
//   - Hold the pen still on one spot and talk: a voice note there, its words landing as the pen lifts.
//   - Scribble over the mark being made: it's let go. Ring something: the mark is on what's inside the ring.
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
import { inside, ringed, scribbled } from './gestures.js';
// (the pen's touches, a mark's end and a ring carried into the book.)
import { setupTouch, theirs } from './pentouch.js';
import { setupSettle } from './settle.js';
import { setupCarry } from './carry.js';
// (handwriting read into type.)
import * as written from './written.js';
import { unpen } from './postitpen.js';
// (the open mark finished on a second screen.)
import { moved, setupHandover } from './handover.js';

export const CSS = `
      .listen { position: absolute; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; pointer-events: none;
        background: radial-gradient(${ACCENT} 0 5px, transparent 6px), radial-gradient(rgba(255,90,95,.35), transparent 70%);
        animation: listen 1.1s ease-in-out infinite; }
      .listen[hidden] { display: none; }
      @keyframes listen { 50% { transform: scale(1.35); opacity: .7 } }`;
// (.pencil: a hidden stand-in for the surface inkjs.pen wants, so its lines are in the window's px from its corner; the
// pen's events reach it from the window (penDown...), so a tap on review mode's own buttons stays theirs)
export const HTML = `<i class="listen" hidden aria-hidden="true"></i><i class="pencil" hidden></i>`;

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
  if (scribbled(pts) && marks.markAt(r, area)) return wipeOpen(r);
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
  // the first line: a new mark, its note and the mic
  r.strokes = [stroke];
  r.mark = { kind: 'circle' };
  aim(r);
  if (ringed(pts)) {
    flash(r, (r.mark.el = inside(r, area)));
    r.mark.ringed = true; // (a finger can carry what it holds into the book: carry.js)
  }
  begin(r);
  moved(r);
}
function begin(r) {
  r.undoTo = { mark: null, shot: null, exposure: null };
  marks.paint(r);
  compose(r);
  towards(r, r.mark);
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

// A scribble over the mark being made: it goes with its post-it, and comes back with an undo
function wipeOpen(r) {
  r.steps.push({ kind: 'unwipeOpen', strokes: r.strokes, mark: r.mark, words: r.text.value });
  reset(r);
}

// Undo anything: the last line of the mark being made (the first one: the mark goes), else the last note sent to the
// sheet comes off it, else the last mark scribbled out comes back
export async function undo(r) {
  // (the post-it's words edited with the Pencil first: postitpen.js.)
  if (r.mode === 'note' && r.wordSteps?.length) return r.wordSteps.pop()();
  const floor = r.mark?.kind === 'circle' ? 1 : 0;
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
  if (step.kind === 'note' || step.kind === 'scrap') {
    try {
      await (step.kind === 'scrap' ? marks.unscrap : marks.wipe)(step.id); // (a scrap)
    } catch (err) {
      r.steps.push(step); // (the book didn't take it: the step is still there to undo)
      throw err;
    }
  } else if (step.kind === 'unwipeOpen') {
    r.strokes = step.strokes;
    r.mark = { kind: step.mark.kind, x: step.mark.x, y: step.mark.y, el: step.mark.el, area: step.mark.area };
    if (r.mark.kind === 'circle') aim(r);
    begin(r);
    r.text.value = step.words;
  }
}

export function setupPencil(r) {
  r.steps = [];
  forgetHairlines();
  r.listen = r.$('.listen');
  r.pinIt.textContent = 'Save';
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
  carry(r);
  followPage(r);
}
// The hairlines once kept on this screen are gone with them (rule zero): the device's list of the ones scribbled out
// goes too. A one-off: remove it once every screen the board uses has loaded HQ since.
const forgetHairlines = () => localStorage.removeItem('__hq_cleared_hairlines');
// A ring just drawn, carried by a finger into the book (carry.js): the ring's line on the screenshot and on the screen
// now, while it's open and its screenshot taken. Once taped, a note with no words yet goes: the ring was for keeping.
function carry(r) {
  setupCarry(r, {
    ring: () => {
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

// What a reset leaves
export const unmark = r => {
  unpen(r);
  if (r.listen && !r.holding) r.listen.hidden = true;
  r.spoken = r.typed = false;
  if (r.book) r.pinIt.textContent = 'Save';
  if (r.book) moved(r); // (no open mark now: a second screen hears so.)
};

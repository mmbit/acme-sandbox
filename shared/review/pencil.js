// The Pencil on HQ's own pages (review mode with the book: data-book on its script). The one rule: the Pencil writes,
// a finger works the page. No button and no mode: a pen drawn across any HQ page draws there, and a finger still
// scrolls and taps under the ink (the page never scrolls under the pen). A pen's tap stays the page's, and a pen in a
// text field is Apple's handwriting-to-text. A mouse draws with the pin, as review mode always has.
//   - A mark is the lines drawn while the pen keeps coming back: the words said once its mic button is tapped (on a
//     call, the call hears them) go in its note. Rest the pen and it lifts
//     into the book as a note, the page left clean: nothing of it stays drawn (settle.js, marks.js paint: rule zero).
//     Words written with it stay ink, on the note's snip, for whoever reads the note: nothing reads them into type.
//   - Ring something: the mark is on what's inside the ring. The strip's eraser and undo take lines back (surface.js).
//   - A two-finger tap takes back the last thing, whatever it was (Cmd or Ctrl+Z too). Nothing asks "are you sure?".
// The pen's touches are pentouch.js's. The book hears each note as it's made ('pencil:note').
import * as inkjs from './ink.js';
import { aim, boxOfLines } from './mark.js';
import { compose, develop, towards } from './postit.js'; // (towards)
import { reset } from './acts.js';
import * as marks from './marks.js';
import { followPage } from './markfollow.js';
import { inside, ringed } from './gestures.js';
// (the pen's touches, a mark's end and a ring carried into the book.)
import { setupTouch, theirs } from './pentouch.js';
import { setupSettle } from './settle.js';
import { setupCarry } from './carry.js';
import { ERASER, erases } from './eraser.js';
import { addLine, erase as eraseOpen, eraseLines, restore } from './surface.js';

// (.pencil: a hidden stand-in for the surface inkjs.pen wants, so its lines are in the window's px from its corner; the
// pen's events reach it from the window (penDown...), so a tap on review mode's own buttons stays theirs)
export const HTML = `<i class="pencil" hidden></i>`;

// The ink a line starts with: the strip's eraser while it's in hand (only while the strip shows: surface.js showStrip),
// else the strip's ink, on HQ's own call red only, INKS' first
const penInk = r => (r.eraserInHand ? ERASER : inkjs.INKS[r.call ? 0 : r.inkNow]);

// A line the Pencil finished, in the screen's px
function lifted(r, stroke) {
  r.pencil.clear();
  if (erases(stroke)) return erase(r, stroke);
  // (a line drawn while the last mark goes into the book waits, drawn, for it: settle.js.)
  if (r.mode === 'sending') {
    r.nextLines.push(stroke);
    return marks.paint(r);
  }
  if (r.mode === 'note' && r.mark) {
    // another line of the mark being made: a step undo takes back
    addLine(r, marks.intoMark(r, stroke));
    if (marks.openLines(r, r.strokes) === r.strokes) aim(r); // (scrolled since, the first lines' element stays)
    marks.paint(r);
    develop(r);
    return;
  }
  if (r.mode !== 'idle') return;
  // the first line: a new mark and its note (its mic waits for the post-it's button)
  r.strokes = [stroke];
  r.mark = { kind: 'circle' };
  aim(r);
  if (ringed(stroke.points)) {
    flash(r, (r.mark.el = inside(r, boxOfLines([stroke]))));
    r.mark.ringed = true; // (a finger can carry what it holds into the book: carry.js)
  }
  begin(r);
}
function begin(r) {
  r.undoTo = { mark: null, shot: null, exposure: null };
  r.inkSteps = [];
  marks.paint(r);
  compose(r);
  towards(r, r.mark);
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

// The eraser lifted: every line its pass touched goes from the page, the open mark's and, on a call, those of the marks
// its agent hasn't had its turn on yet (their notes went to it as they were). One step undo takes back: the open
// mark's, or one of its own with none open. (A mark going into the book keeps its lines.)
function erase(r, pass) {
  if (r.mode === 'note') return eraseOpen(r, pass, r.held);
  const step = eraseLines(r, pass, r.held);
  if (!step) return;
  r.steps.push({ kind: 'erased', ...step });
  marks.paint(r);
}

// Undo anything: the last change to the mark being made (a line drawn, lines erased; none left: the mark goes), else
// the last note sent to the sheet comes off it (on a call its ink too), or the lines an eraser took come back
export async function undo(r) {
  if (r.mode === 'note') {
    const step = r.inkSteps.pop();
    if (!step) return reset(r);
    restore(r, step);
    if (r.strokes.length) aim(r);
    marks.paint(r);
    develop(r);
    return;
  }
  if (r.mode !== 'idle') return;
  const step = r.steps.pop();
  if (!step) return;
  if (step.kind === 'erased') {
    restore(r, step); // (a held mark the agent has had since stays gone with it)
    return marks.paint(r);
  }
  try {
    await (step.kind === 'scrap' ? marks.unscrap : marks.wipe)(step.id); // (a scrap)
  } catch (err) {
    r.steps.push(step); // (the book didn't take it: the step is still there to undo)
    throw err;
  }
  r.held = r.held.filter(h => h.note !== step.id);
  marks.paint(r);
}

export function setupPencil(r) {
  r.steps = [];
  forgetHairlines();
  r.pinIt.textContent = 'Save';
  r.pencil = inkjs.pen(r.$('.pencil'), r.wet, {
    halo: true,
    under: r.haloCanvas,
    ink: () => penInk(r),
    end: stroke => lifted(r, stroke),
  });
  // (what the pen's touches and a mark's end do with the Pencil's own, handed in: they never import it.)
  setupTouch(r, { undo });
  setupSettle(r, { lifted });
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

// What a reset leaves
export const unmark = r => {
  r.spoken = r.typed = false;
  if (r.book) r.pinIt.textContent = 'Save';
};

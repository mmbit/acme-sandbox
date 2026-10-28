// The post-it's words edited with the Pencil (penwords.js): kept from Apple's Scribble while they're there to edit, a
// strike takes words out, a slice opens the words where the next writing goes (read as handwriting), and writing on
// them that's neither goes on at their end. Each change is a step of the post-it's own undo (pencil.js, surface.js:
// r.wordSteps), and counts as typed: the reader's words never come over it.
import { amendOf, keepFromScribble, openGap, penEdits, strikeOut, strokesOn } from './penwords.js';
import { readWords } from './written.js';

export function setupPostitPen(r) {
  r.wordSteps = [];
  r.penWords = keepFromScribble(r.text);
  strokesOn(r.text, { use: () => penEdits(r.text), end: points => amended(r, points) });
}
// What a reset leaves: no gap open (what's written in it and not read yet dropped, never put in the next post-it's
// words), nothing to undo, the words (none now) the field's own again
export function unpen(r) {
  r.wordGap?.drop();
  r.wordGap = null;
  r.wordSteps = [];
  r.penWords?.refresh();
}

function amended(r, points) {
  const edit = amendOf(r.text, points);
  if (edit?.kind === 'strike') return strikeOut(r.text, edit, points, { put: text => put(r, text) });
  r.wordGap?.close();
  const gap = openGap(r.text, edit ? edit.at : r.text.value.length, {
    text: () => r.text.value,
    put: text => put(r, text),
    read: readWords,
    failed: err =>
      (r.msg.textContent = `Your handwriting wasn’t read: ${err?.status ? err.message : 'HQ couldn’t be reached'}.`),
    closed: () => r.wordGap === gap && (r.wordGap = null),
    // (writing that's no edit is the first line of what goes on at the end)
    lines: edit ? [] : [points],
  });
  r.wordGap = gap;
}
// The words changed as if typed, a step the post-it's undo takes back
function put(r, text) {
  const was = r.text.value;
  set(r, text);
  r.wordSteps.push(() => set(r, was));
}
function set(r, text) {
  r.text.value = text;
  r.text.dispatchEvent(new Event('input'));
  r.penWords.refresh();
}

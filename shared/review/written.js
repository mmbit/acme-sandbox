// Handwriting read into type (the coordinator's handwriting.ts): once the pen rests, the lines of the mark being made go
// as a picture of the ink alone to a small model, which says whether they're writing and what they say. The words fill
// the post-it's field, to be changed there before Send, go in the note as said 'written', and stand beside the ink as
// type (marks.js paint) and in the book. Words that come once the note is in the book are its words still, unless the
// board gave it others. Never on a call: the call's agent sees the ink itself.
import * as inkjs from './ink.js';
import { boxOfLines } from './mark.js';
import { say } from './dock.js';
import { send } from './markpage.js';
import { paint } from './marks.js';

const REST_MS = 1200; // the pen resting this long after a line: the mark's lines so far are read
// (the picture: the ink with a little room round it, drawn up to twice its size, so a word written small reads too)
const PAD = 12,
  SCALE_MAX = 2,
  SIDE_MAX = 1200;
const TOLD_MS = 8000; // (words read for a note in the book that couldn't go in it: told this long, as a call's mark is)

// The ink alone, dark on white
export function inkPicture(lines) {
  const b = boxOfLines(lines),
    k = Math.min(SCALE_MAX, SIDE_MAX / (Math.max(b.w, b.h) + 2 * PAD)),
    c = document.createElement('canvas');
  c.width = Math.ceil((b.w + 2 * PAD) * k);
  c.height = Math.ceil((b.h + 2 * PAD) * k);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.setTransform(k, 0, 0, k, (PAD - b.x) * k, (PAD - b.y) * k);
  inkjs.draw(
    g,
    lines.map(l => ({ ...l, color: '#000', alpha: 1 })),
  );
  return c.toDataURL('image/png');
}

// Words typed in the post-it are the board's: words read, changed, no longer stand beside the ink as type
export function typing(r) {
  r.text.addEventListener('input', () => {
    r.typed = true;
    if (r.mark?.written) paint(r);
  });
}

// A line drawn on the mark being made, or taken back: its lines read once the pen rests (words typed or said are the
// note's own: nothing is read over them)
export function readSoon(r) {
  clearTimeout(r.readTimer);
  r.readTimer = 0;
  const mark = r.mark;
  if (r.call || mark?.kind !== 'circle' || !r.strokes.length || r.typed || r.spoken) return;
  r.readTimer = setTimeout(() => {
    r.readTimer = 0;
    read(r, mark);
  }, REST_MS);
}
// Send: the lines not read yet, read now (their words join the note when they come)
export function readNow(r) {
  if (!r.readTimer) return;
  clearTimeout(r.readTimer);
  r.readTimer = 0;
  read(r, r.mark);
}

// One reading at a time for a mark: lines drawn while one is out are read when it's back. A mark dropped meanwhile
// (Cancel, a wipe, undone) has nothing to read.
function read(r, mark) {
  if (mark !== r.mark && !mark.lines) return;
  if (mark.reading) return (mark.again = true);
  const lines = mark === r.mark ? [...r.strokes] : mark.lines;
  mark.reading = send('/read', { ink: inkPicture(lines) })
    .then(
      ({ words }) => took(r, mark, words),
      err => {
        console.error('The Pencil: the handwriting', err);
        // (the post-it open on it says so, or its words would look like a reading that found no writing; going or gone
        // to the book, the page does, as settle's are told. A mark dropped meanwhile stays quiet.)
        const why = `Your handwriting wasn’t read: ${err?.status ? err.message : 'HQ couldn’t be reached'}.`;
        if (mark === r.mark && r.mode === 'note' && !r.sheet.hidden)
          r.msg.textContent = mark.unread = why; // (the post-it open)
        else if (mark === r.mark || mark.lines) say(r, `${why} What it says isn’t in its note.`, TOLD_MS);
      },
    )
    .finally(() => {
      mark.reading = null;
      if (mark.again) {
        mark.again = false;
        read(r, mark);
      }
    });
}
// The words read: into the open post-it's field, where it holds no others, else into the note in the book
function took(r, mark, words) {
  if (mark === r.mark && r.mode === 'note') {
    const field = r.text.value.trim();
    if (r.typed || r.spoken || (field && field !== mark.written)) return;
    r.text.value = mark.written = words;
    if (r.msg.textContent === mark.unread) r.msg.textContent = ''; // (an earlier reading's failure, told: now read)
    r.rec?.typed?.(); // (words said from here on go after them)
    paint(r);
    return;
  }
  mark.read = words;
  settle(r, mark);
}

// The mark's note in the book (pencil.js toBook): words read since go in it, if it went with none or with an earlier
// reading's
export function sent(r, mark, note) {
  mark.lines = [...r.strokes];
  mark.note = note;
  settle(r, mark);
}
function settle(r, mark) {
  const { note, read: words } = mark;
  if (!note || !words || words === note.words) return;
  if (note.words && !(note.said === 'written' && note.words === mark.written)) return;
  // (only over the words it went with: the board may have typed others in the book since, which stay)
  send('/note/edit', { id: note.id, words, said: 'written', was: note.words }).then(
    ({ note: now }) => {
      Object.assign(mark, { note: now, written: words });
      r.marks = r.marks.map(m => (m.id === now.id ? { ...m, words: now.words, said: now.said } : m));
      paint(r);
      document.dispatchEvent(new CustomEvent('pencil:words', { detail: { id: now.id } }));
    },
    err => {
      // (sent on with its sheet, or wiped, since: 404; other words in it by now: 409. The words go nowhere.)
      if (err?.status === 404 || err?.status === 409) return;
      console.error('The Pencil: the handwriting', err);
      const why = err?.status ? `The book said no: ${err.message}.` : 'Could not reach the book.';
      say(r, `${why} The words read for note ${note.n} aren’t in it.`, TOLD_MS);
    },
  );
}

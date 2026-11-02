// Paste by a tap with Select (bookselect.js): a tap on bare paper, the Pencil's or a finger's, brings the Paste bubble
// there, so pasting by touch needs no press held still (Ink 1.1's deck: no long press anywhere). Tapped, the bubble
// reads the clipboard (Safari asks first, unless this page put what's there): the book's own clip where the clipboard
// still names it, as ⌘V takes it (bookselectclip.js), else what it holds, a picture copied in Photos too (booktape.js).
// A finger that moves the page never reaches Select's press, so its tap is heard here. A press anywhere but the bubble
// sends it away.
import { MOD } from './bookui.js';
import { sfx } from '../audio.js';
import { said } from './booksave.js';
import { word } from './bookscope.js';
import { followPress } from './bookpress.js';
import * as brought from './bookbrought.js';
import { distance, isTap } from '/__review/tap.js';

// the bubble goes after this long
const BUBBLE_MS = 5000;
// what a finger's tap is on when it isn't bare paper: a field, a control, a box of words, a scrap's words, review mode
const NOT_BARE = 'input, textarea, select, button, a, label, [contenteditable], .bk-typed, .bk-words, review-mode';

// sel: bookselect.js's. clip: bookselectclip.js's { named(text) (whether the clipboard's words name its clip),
// pasteAt([x, y] | null) (its clip pasted there, page px) }. Returns { offer([clientX, clientY]) (the bubble there) }
export function mountTapPaste(sel, clip) {
  const tp = { sel, clip, bubble: null };
  fingerTaps(tp);
  addEventListener('pointerdown', e => tp.bubble && e.target !== tp.bubble && gone(tp), true);
  return { offer: at => offer(tp, at) };
}

// A finger that moves the page (bookinput.js fingerPans), in select mode: its tap on bare paper offers Paste, as a
// Pencil's does (bookselect.js lasso)
function fingerTaps(tp) {
  const { book } = tp.sel;
  book.desk.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch' || !e.isPrimary || !book.input.fingerPans() || book.tools?.mode() !== 'select')
      return;
    if (book.input.claims(e) || e.target.closest(NOT_BARE) || !book.at(e.clientX, e.clientY)) return;
    let reach = 0;
    followPress(e, {
      move: m => (reach = Math.max(reach, distance(e, m))),
      up: u => u.type === 'pointerup' && isTap(e, u, reach) && offer(tp, [e.clientX, e.clientY]),
    });
  });
}

function offer(tp, [x, y]) {
  gone(tp);
  const { clip } = tp,
    { book } = tp.sel,
    box = book.paper.getBoundingClientRect(),
    on = book.at(x, y);
  const bubble = Object.assign(document.createElement('button'), {
    type: 'button',
    className: 'bk-paste',
    textContent: word('paste'),
  });
  Object.assign(bubble.style, { left: `${x - box.left}px`, top: `${y - box.top}px` });
  book.paper.append((tp.bubble = bubble));
  sfx.tick();
  bubble.onclick = async () => {
    gone(tp);
    let got;
    try {
      got = await brought.clipboard();
    } catch {
      return said(book, (on?.view ?? book.view()).page, `The clipboard can’t be read here: paste with ${MOD}+V.`);
    }
    if (clip.named(got.text)) return clip.pasteAt(on && [on.x, on.y]);
    book.tape.land(got, [x, y]);
  };
  bubble.timer = setTimeout(() => gone(tp), BUBBLE_MS);
}
function gone(tp) {
  clearTimeout(tp.bubble?.timer);
  tp.bubble?.remove();
  tp.bubble = null;
}

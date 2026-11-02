// The board's bindings on the page that are more than a tool's press (the rail, the wheel, Shift and Ctrl are
// bookstrip.js, bookpan.js and booktools.js): whether a finger moves the page or draws. None of them waits on a press
// held still: a voice note is the mic's tap (bookvoice.js), Paste a tap on bare paper with Select (bookselect.js), and
// every tool is on the rail (Ink 1.1's deck: no long press anywhere.).
//
// book.input: { fingerPans(), claims(e) }. claims(e): whether a press on the paper is the strip's, for a part that
// hears a finger's tap itself (Select's Paste: bookselect.js fingerTaps).
import { prefs } from '/__review/prefs.js';

export function mountInput(book) {
  return (book.input = {
    // A finger moves the page, rather than drawing, where this device's preferences say so (on since its first pen)
    fingerPans: () => prefs().penPans,
    claims: e => !!e.target?.closest?.('.bk-strip'),
  });
}

// The number a note shows beside it on its sheet in the book (HQ's booksheet.js; nothing of a note shows on HQ's page:
// rule zero). A number is there to tell notes apart, so a page that shows only
// one open note numbers none; one that shows several gives each its number on its sheet, and never two the same: notes
// from two sheets (two owners', or a sent sheet's and the next one's) that share a number on their own sheets, the later
// ones in the page's order take the next numbers free. A sent note is a line on its sheet, never numbered.

// notes: the open notes one page shows, in its order ({ id, n }: n, its number on its sheet). Returns id → its number
// there, or null when it shows none.
export function shownNumbers(notes) {
  const out = new Map(notes.map(x => [x.id, null]));
  if (notes.length < 2) return out;
  const taken = new Set(),
    later = [];
  for (const x of notes)
    if (Number.isInteger(x.n) && x.n > 0 && !taken.has(x.n)) {
      taken.add(x.n);
      out.set(x.id, x.n);
    } else later.push(x);
  let next = Math.max(0, ...taken);
  for (const x of later) out.set(x.id, ++next);
  return out;
}

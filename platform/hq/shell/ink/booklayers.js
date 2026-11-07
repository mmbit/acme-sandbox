// The stack of what's on a scrap: its pictures and its ink, bottom first, one order for everything that draws it (the
// unit's canvas, bookpage.js; the share and lift pictures, bookpaperdraw.js and bookselectlift.js; the page's picture,
// notebookpicture.js and the store's bookrender.ts) and for what a press picks (bookselectmath.js topAt). Its typed
// words stay over it all.
//
// A thing Select has put forward or back keeps its place in the stack, its `layer` (bookselectlayer.js). Everything
// without one lies over every thing with one, as a scrap has always laid it: its pictures, then its ink, the more
// see-through under the less (the marker under the pencil's and the pen's, the pencil's under the pen's, whichever came
// first), each in its own order. So what's drawn or pasted after a move lands on top.

// A thing's place in its scrap's stack, a stroke's or a picture's, as the play and the store check it: a whole number
// from 0
export const layerOk = n => Number.isInteger(n) && n >= 0 && n < 2 ** 31;

// A scrap's pictures and strokes in the order they're laid, bottom first: [{ picture: true, it } | { it }, ...]
export function stackOf(pictures, ink) {
  const all = [
    ...pictures.map((it, i) => ({ it, picture: true, i, o: 0 })),
    ...ink.map((it, i) => ({ it, i, o: opacityOf(it) })),
  ];
  // (Infinity less Infinity is NaN, which falls through to the next key)
  return all
    .sort(
      (a, b) =>
        (a.it.layer ?? Infinity) - (b.it.layer ?? Infinity) ||
        Number(!a.picture) - Number(!b.picture) ||
        a.o - b.o ||
        a.i - b.i,
    )
    .map(({ it, picture }) => (picture ? { picture, it } : { it }));
}
// The same, in runs of one kind, for what draws a run at a time: [{ pictures: [...] } | { ink: [...] }, ...]. A run of
// ink is drawn as one, so the eraser's pieces of a see-through stroke still fill as one (inkshape.js fills).
export function runsOf(pictures, ink) {
  const runs = [];
  for (const { picture, it } of stackOf(pictures, ink)) {
    const kind = picture ? 'pictures' : 'ink',
      last = runs.at(-1);
    if (last?.[kind]) last[kind].push(it);
    else runs.push({ [kind]: [it] });
  }
  return runs;
}
// A stroke's opacity, as inkshape.js opacityOf: 1 for a pen's
const opacityOf = s => (s.alpha < 1 ? s.alpha : 1);

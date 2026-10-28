// Two writers on one page (an invited person and the board in their book, or two screens): a save the store refuses
// because the page changed since this side read it (book.ts savePage's since, 409) is merged with the page as it is now
// and saved again. Three ways: the page as this side read it (base), as it has it now (mine) and as the store has it
// (theirs): theirs, less what this side took off since, and what it added. A stroke is the same one when it's the same
// JSON (one never changes once drawn: undo and the eraser take it whole); so is a picture, moved: taken off and taped
// again.

// The merged list: theirs in their order, this side's own items in place of the same ones (so its undo still finds
// them), then what this side added
export function merged(base, mine, theirs, key = JSON.stringify) {
  const had = new Set(base.map(key)),
    now = new Map(mine.map(x => [key(x), x])),
    there = new Set(theirs.map(key));
  const kept = theirs.filter(x => !had.has(key(x)) || now.has(key(x))).map(x => now.get(key(x)) ?? x);
  return [...kept, ...mine.filter(x => !had.has(key(x)) && !there.has(key(x)))];
}
// A page's pictures merged: a picture moved on both sides is where this side put it (one place for each file)
export function mergedScraps(base, mine, theirs) {
  const all = merged(base, mine, theirs, s => JSON.stringify([s.file, s.x, s.y, s.w, s.h, s.tilt])),
    last = new Map(all.map(s => [s.file, s]));
  return all.filter(s => last.get(s.file) === s);
}

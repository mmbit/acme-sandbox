// Where an agent's answer lies on a notebook page, never over the board's groups or another answer, and inside the
// paper the board reads: beside its group (right) if that strip is free paper and fits between the tool strip floating
// over the paper's left edge and the controls at its right edge, else below it (as wide as the room there lets it),
// else the first free place further down (pages are endless: the page grows). The board's groups never move; an answer
// keeps the spot it was given (book_slips.spot). A spot that runs past the narrowest paper the board reads on (the book
// at its least) keeps a narrow spot too, placed there the same way, which HQ draws where the spot doesn't fit the paper
// (bookanswers.js): no screen moves an answer onto paper not cleared for it. A spot the board writes on later, on a
// screen that draws the answer's other spot, moves down clear again (downAgain: answerplace.ts). Pure, so it's tested
// alone (answerspot.test.ts); bookanswer.ts gives it the page.

export type Box = { x: number; y: number; w: number; h: number };
// Relative to its group's box's top-left, in page px; h: its height there, as placed (what it holds measured once, a
// picture by its real size); narrow: where it lies on the narrowest paper, when this spot runs past it
export type Spot = { dx: number; dy: number; w: number; h: number; narrow?: Spot };

// What an answer holds, for its height: its words, a picture's size, its ink's height, a form's questions
export type Contents = {
  text?: string;
  picture?: { width: number; height: number } | null;
  ink?: number | null;
  questions?: number;
};

// An answer's width (least: below a group near the paper's edge), the room kept round it, how its words fill it (about
// 32 characters a line at its width, 24 px a line), and the controls' column at the paper's right edge it keeps left
// of (HQ's bookui.js --bk-stack, one column, with its inset from the edge), the tool strip's over the paper's left edge
// it keeps right of (HQ's bookstrip.css: its left, 40 px, nearer the edge on a narrow book, its island's width, 52 px
// with a finger, and the 8 px the controls keep too), and the narrowest paper the board reads on: the book at its least
// (HQ's booklayout.js BOOK.min, 320 px, less its margins), narrower than a phone's
export const ANSWER = {
  w: 300,
  least: 180,
  gap: 24,
  line: 24,
  chars: 32,
  head: 40,
  reply: 48,
  question: 56,
  rail: 72,
  strip: 100,
  narrowest: 294,
} as const;
// The narrowest paper a narrow spot is placed for: the book at its least, or wider where that has no room for an answer
// at its least between the strip and the controls (there it runs into the controls' column, that floats at the foot)
export const NARROWEST = Math.max(ANSWER.narrowest, ANSWER.strip + ANSWER.least + ANSWER.rail);

// An answer's height at a width from what it holds: its words' lines, a picture scaled to the width, its ink's height,
// a form's fields, the head (the face) and the strip under it the board writes a reply in
export function answerHeight(a: Contents, w: number = ANSWER.w) {
  const chars = Math.max(1, Math.floor((ANSWER.chars * w) / ANSWER.w));
  const lines = (a.text ?? '').split('\n').reduce((sum, l) => sum + Math.max(1, Math.ceil(l.length / chars)), 0);
  const picture = a.picture ? Math.round((a.picture.height * w) / Math.max(1, a.picture.width)) : 0;
  return (
    ANSWER.head + lines * ANSWER.line + picture + (a.ink ?? 0) + (a.questions ?? 0) * ANSWER.question + ANSWER.reply
  );
}

// The spot for an answer holding a on the group's box, clear of every box taken (the board's other groups and the
// answers already given, as page boxes, their narrow spots too), inside the paper (the page's x and w across: the width
// its paper showed), with its narrow spot if it runs past the narrowest paper
export function answerSpot(group: Box, a: Contents, taken: Box[], paper: { x: number; w: number }): Spot {
  const spot = spotOn(group, a, taken, paper),
    narrowest = { x: paper.x, w: Math.min(paper.w, NARROWEST) };
  if (group.x + spot.dx + spot.w <= narrowest.x + narrowest.w - ANSWER.rail) return spot;
  return { ...spot, narrow: spotOn(group, a, taken, narrowest) };
}
// A spot (an answer's, or its narrow spot) the board has written on since, on a screen that draws the answer's other
// one: in the first free place under its group again, clear of every box taken, as wide and tall as it was
export function downAgain(group: Box, spot: Spot, taken: Box[]): Spot {
  const b = spotBox(group, spot);
  return under(group, b.x, b.w, b.h, taken);
}
function spotOn(group: Box, a: Contents, taken: Box[], paper: { x: number; w: number }): Spot {
  const edge = paper.x + paper.w - ANSWER.rail,
    left = paper.x + ANSWER.strip;
  const right = Math.max(group.x + group.w + ANSWER.gap, left);
  const beside = answerHeight(a);
  if (right + ANSWER.w <= edge && !blocking(taken, right, group.y, ANSWER.w, beside).length)
    return at(group, right, group.y, ANSWER.w, beside);
  // (below: at its group's x, right of the strip, as wide as the paper there lets it, moved in from the edge when
  // that's less than its least, never left of the strip)
  const from = Math.max(group.x, left),
    w = Math.round(Math.min(ANSWER.w, Math.max(ANSWER.least, edge - from))),
    x = Math.max(left, Math.min(from, edge - w));
  return under(group, x, w, answerHeight(a, w), taken);
}
// The first free line under the group at x, w wide and h tall. Every line above the foot of a box in the way is in its
// way too, so it jumps to the next line past that foot: one step a box, however tall the boxes are. Never short of the
// foot: a foot on a line can come out an ulp past it, and far down a line is less than an ulp, so the same box would
// block again.
function under(group: Box, x: number, w: number, h: number, taken: Box[]): Spot {
  const top = group.y + group.h + ANSWER.gap;
  for (let y = top; ;) {
    const inWay = blocking(taken, x, y, w, h);
    if (!inWay.length) return at(group, x, y, w, h);
    const past = Math.max(...inWay.map(t => t.y + t.h + ANSWER.gap));
    y = Math.max(past, y + ANSWER.line, top + Math.ceil((past - top) / ANSWER.line) * ANSWER.line);
  }
}
const blocking = (taken: Box[], x: number, y: number, w: number, h: number) => {
  const gap = ANSWER.gap;
  return taken.filter(t => x < t.x + t.w + gap && x + w + gap > t.x && y < t.y + t.h + gap && y + h + gap > t.y);
};
const at = (group: Box, x: number, y: number, w: number, h: number) => ({
  dx: Math.round(x - group.x),
  dy: Math.round(y - group.y),
  w,
  h,
});
// An answer's spot back as a page box
export const spotBox = (group: Box, spot: Spot): Box => ({
  x: group.x + spot.dx,
  y: group.y + spot.dy,
  w: spot.w,
  h: spot.h,
});
// The paper an answer's spot takes on any screen: its spot's box, and its narrow spot's
export const spotBoxes = (group: Box, spot: Spot): Box[] => [
  spotBox(group, spot),
  ...(spot.narrow ? [spotBox(group, spot.narrow)] : []),
];

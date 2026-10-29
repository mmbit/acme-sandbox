// Where an agent's answer lies on a notebook page, never over the board's groups or another answer, and inside the
// paper the board reads, at a width it reads easily: beside its group (right) if that strip is free paper and fits left
// of the controls at the paper's right edge (Undo's column and the tool strip beside it), else below it (as wide as the
// paper there lets it, moved in to the left rather than narrowed), else the first free place further down (pages are
// endless: the page grows). The board's groups never move; an answer keeps the spot it was given (book_slips.spot). A
// spot that runs past a narrower paper the board reads on (NARROWER: the book beside HQ's page, a phone's, the book at
// its least) keeps a narrow spot too, placed there the same way, and that one its own for the next narrower paper it
// runs past, which HQ draws where the spot doesn't fit the paper (bookanswers.js): no screen moves an answer onto paper
// not cleared for it, nor under the controls. Whenever the board's groups come to cover a spot, any of its spots
// (written, edited, moved onto the page or brought back by Undo), that spot moves down clear again (downAgain, from
// answerplace.ts spotsClear). Pure, so it's tested alone (answerspot.test.ts); bookanswer.ts gives it the page.

export type Box = { x: number; y: number; w: number; h: number };
// Relative to its group's box's top-left, in page px; h: its height there, as placed (what it holds measured once, a
// picture by its real size); narrow: where it lies on the next narrower paper this spot runs past (NARROWER)
export type Spot = { dx: number; dy: number; w: number; h: number; narrow?: Spot };

// What an answer holds, for its height: its words, a picture's size, its ink's height, a form's questions
export type Contents = {
  text?: string;
  picture?: { width: number; height: number } | null;
  ink?: number | null;
  questions?: number;
};

// An answer's width (about 42 characters a line in the hand, 24 px a line: bookanswers.css's 23 px Caveat; least: on
// paper with less room than that left of the controls), the room kept round it, and the controls' columns at the
// paper's right edge it keeps left of, as HQ keeps them (bookanswers.js edgeOf: bookui.js --bk-stack, Undo's column and
// the tool strip beside it, 52 px each with a finger and 8 px apart, and 24 px: 12 in from the edge, 12 kept), and the room it keeps at the paper's left, where a phone's spread has its pull tab
export const ANSWER = {
  w: 400,
  least: 120,
  gap: 24,
  line: 24,
  chars: 42,
  head: 40,
  reply: 48,
  question: 56,
  rail: 136,
  inset: 12,
} as const;
// The papers the board reads on narrower than a wide page's, widest first, each a book's width less its margin and page
// edges (28 px; a phone's 36: HQ's booklayout.js): the book beside HQ's page (an iPad mini held sideways, 501 px; a
// desktop's is wider), a phone's (the spread, 390 px across less its edge) and the book at its least (BOOK.min, 320 px,
// dragged there with its cover's edge; an iPad upright opens as the spread, its paper wider than the first).
export const NARROWER = [473, 342, 292] as const;
// The narrowest paper a narrow spot is placed for
export const NARROWEST = NARROWER[NARROWER.length - 1];

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
// its paper showed), with a narrow spot for the widest narrower paper it runs past (and so on, down to the narrowest)
export function answerSpot(group: Box, a: Contents, taken: Box[], paper: { x: number; w: number }): Spot {
  const spot = spotOn(group, a, taken, paper),
    past = NARROWER.find(w => w < paper.w && group.x + spot.dx + spot.w > paper.x + w - ANSWER.rail);
  return past === undefined ? spot : { ...spot, narrow: answerSpot(group, a, taken, { x: paper.x, w: past }) };
}
// A spot kept from before the controls grew (rail), placed again by answerSpot's rules: on each paper, from the spot's
// own down to the narrowest it runs past, the spot of its chain HQ draws there (bookanswers.js spotHere) if it's left of
// the controls and clear of every box taken, else a new one there. The answer moves only where the old one runs under.
export function spotAgain(
  group: Box,
  spot: Spot | undefined,
  a: Contents,
  taken: Box[],
  paper: { x: number; w: number },
): Spot {
  const edge = paper.x + paper.w - ANSWER.rail;
  let s = spot;
  while (s && group.x + s.dx + s.w > edge) s = s.narrow;
  const kept = s && !taken.some(t => overlapping(spotBox(group, s!), t)),
    here: Spot = kept ? { dx: s!.dx, dy: s!.dy, w: s!.w, h: s!.h } : spotOn(group, a, taken, paper),
    past = NARROWER.find(w => w < paper.w && group.x + here.dx + here.w > paper.x + w - ANSWER.rail);
  return past === undefined ? here : { ...here, narrow: spotAgain(group, s, a, taken, { x: paper.x, w: past }) };
}
export const overlapping = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
// A spot (an answer's, or one of its narrow spots) the board's groups now cover: in the first free place under its
// group again, clear of every box taken, as wide and tall as it was
export function downAgain(group: Box, spot: Spot, taken: Box[]): Spot {
  const b = spotBox(group, spot);
  return under(group, b.x, b.w, b.h, taken);
}
function spotOn(group: Box, a: Contents, taken: Box[], paper: { x: number; w: number }): Spot {
  const edge = paper.x + paper.w - ANSWER.rail,
    left = paper.x + ANSWER.inset;
  const right = Math.max(group.x + group.w + ANSWER.gap, left);
  const beside = answerHeight(a);
  if (right + ANSWER.w <= edge && !blocking(taken, right, group.y, ANSWER.w, beside).length)
    return at(group, right, group.y, ANSWER.w, beside);
  // (below: at its group's x, as wide as the paper left of the controls lets it, moved in to the left so it keeps that
  // width rather than narrowing to a column, never past the paper's left less its inset)
  const w = Math.round(Math.min(ANSWER.w, Math.max(ANSWER.least, edge - left))),
    x = Math.max(left, Math.min(group.x, edge - w));
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
// The paper an answer's spot takes on any screen: its spot's box, and its narrow spots'
export const spotBoxes = (group: Box, spot: Spot): Box[] => [
  spotBox(group, spot),
  ...(spot.narrow ? spotBoxes(group, spot.narrow) : []),
];

// Where a notebook's new things land and how big, one rule for the coordinator's store (notebook.ts, notebookscraps.ts),
// HQ's book (booklanding.js, bookgroupmath.js) and the store's play in memory (notebookplay.js): the page new groups land
// on, a group's box and a scrap's picture's size. Pure: rows and numbers in, no DB, no DOM.

// A scrap's picture at most this wide, in its unit's px: a little inside the unit (scrapunit.js UNIT_W)
export const STACK = { w: 313 };
// A scrap's picture at most this tall (half again its width), scaled down to it, but never below this share of the
// scale its width allows, so a tall crop's words stay readable rather than towering down the page (the board, call 162)
const TALL = { h: 470, readable: 0.6 };
// a scrap's post-it words under its picture (bookgroups.js .bk-under, bookgroups.css .bk-scrap-words): this far below
// it, at least this wide (a scrap's as wide as the stack, anything else's this) and at most that, a line this tall at
// about this many px a letter, and the paper round them
export const CAPTION = { top: 10, least: 280, most: 420, line: 14 * 1.45, letter: 7.4, pad: { x: 10, y: 8 } };

// A scrap's picture's size on its page from the snip's (its pixels, as the book shows it): as wide as it was cut, at
// most STACK.w, a tall one scaled down towards TALL.h
/** @param {number} width @param {number} height */
export function scrapSize(width, height) {
  const wide = Math.min(1, STACK.w / width),
    k = Math.max(Math.min(wide, TALL.h / height), wide * TALL.readable);
  return { w: Math.round(width * k), h: Math.round(height * k) };
}
// a typed box's line, and how wide a letter of it is at most, about (booktexts.js TEXT: 18 px, in the book's face or a
// wider stand-in)
const LINE_PX = 24,
  LETTER_PX = 11;

// The page new groups land on, of a notebook's pages ({ id, created, archived, tries }): the newest neither sending or
// sent (sent(page), as the caller's pages tell it: a row's send_at, a summary's sending and sent), archived nor a try's
// versions page (ink/booktry.ts) nor an Asks page, the agents' (ink/askpages.ts); undefined for none, when the store
// makes one
export function landingPage(pages, sent) {
  return pages
    .filter(p => !p.archived && !sent(p) && p.tries == null && p.kind !== 'asks')
    .sort((a, b) => b.created.localeCompare(a.created) || b.id - a.id)[0];
}

// The box round a group's elements in page px, { x, y, w, h }: a line's points as wide as its pen, a typed box's
// lines, a picture's rect; null for none (a kind left out: none of it)
export function boxOf(parts) {
  const { ink, texts, pictures } = { ink: [], texts: [], pictures: [], ...parts };
  const boxes = [
    ...ink.flatMap(s => s.points.map(([x, y]) => ({ x: x - s.size / 2, y: y - s.size / 2, w: s.size, h: s.size }))),
    ...texts.map(t => ({ x: t.x, y: t.y, w: t.w, h: typedHigh(t) })),
    ...pictures.map(c => ({ x: c.x, y: c.y, w: c.w, h: c.h })),
  ];
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map(b => b.x)),
    y = Math.min(...boxes.map(b => b.y));
  return { x, y, w: Math.max(...boxes.map(b => b.x + b.w)) - x, h: Math.max(...boxes.map(b => b.y + b.h)) - y };
}
// How tall a typed box's words stand, its lines wrapped at its width
export function typedHigh({ w, text }) {
  return LINE_PX * wrappedLines(text, w, LETTER_PX);
}

// How many lines words take, wrapped at width px of letters letter px wide
const wrappedLines = (text, width, letter) => {
  const perLine = Math.max(1, Math.floor(width / letter));
  return text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil([...l].length / perLine)), 0);
};
// The width of a scrap's words under it, w wide (bookgroups.js)
/** @param {number} w */
export const wordsWidth = w => Math.max(STACK.w, Math.min(CAPTION.most, w));
// Where what's under a group starts (a scrap's words, its answers and replies: bookgroups.js, and the store's picture of
// a page, bookpicture.ts), and how wide it is, the group's kind and box as the store has them
/** @param {{ x: number, y: number, w: number, h: number }} box @param {string} kind */
export const underAt = (box, kind) => ({ x: box.x, y: box.y + box.h + CAPTION.top, w: underWidth(kind, box.w) });
// The width of what's under a group w wide: a scrap's words as wide as the scrap, anything else's at least
// CAPTION.least, at most CAPTION.most
/** @param {string} kind @param {number} w */
export const underWidth = (kind, w) =>
  kind === 'scrap' ? wordsWidth(w) : Math.max(CAPTION.least, Math.min(CAPTION.most, w));
// A group's children slipped under it, in the order they came (bookgroups.js, and the store's picture of a page,
// bookpicture.ts): its answers and replies, not an answer the store placed at its spot or a version, nor the replies to
// them, which the answers' layer draws written in (bookanswers.js). A reply's id is a group's, an answer's a slip's: a
// reply is matched only by the answer it answers.
/** @template {{ id: number, kind: string, spot?: unknown, style?: string | null, answers?: number | null }} C
 * @param {C[]} children @returns {C[]} */
export function slipsUnder(children) {
  const written = new Set(
    children.filter(c => c.kind === 'answer' && (c.spot || c.style === 'version')).map(c => c.id),
  );
  return children.filter(c => (c.kind === 'reply' ? c.answers == null || !written.has(c.answers) : !written.has(c.id)));
}

// Handwriting's words edited with the pen: whether a stroke drawn over words strikes some out (a line along their
// middle) or slices the text open between two of them (a line down through a line of words), from the stroke's points
// and the words' boxes on screen; what the text becomes; and, apart from the pure part, the words' boxes measured in the
// page (wordsOf).
//
// A stroke's points are [x, y, ...] in client px. A word is { start, end, rects }: its characters' range in the text and
// its boxes on screen ({ left, top, right, bottom }, one per line it runs over).

// How a strike reads: its line runs at most this steep (tan 25°), along the middle of a line of words (the middle
// BAND of its height, as a fraction cut off top and bottom), and covers at least COVER of a word's width to strike it.
// A slice runs at most this far off upright (the same 25°) and reaches across at least SPAN of the line's height.
const SLANT = Math.tan((25 * Math.PI) / 180),
  BAND = 0.15,
  COVER = 0.6,
  SPAN = 0.6;
// (a line's points in its band: most of a strike's, or it was drawn across lines, not along one)
const ALONG = 0.7;

// The edit a stroke makes on words: { kind: 'strike', ranges: [[start, end], ...] } (the words struck, in order),
// { kind: 'slice', at } (the index the text opens at, on a word's edge), or null (it's ink).
export function editOf(points, words) {
  if (points.length < 2 || !words.length) return null;
  const lines = linesOf(words),
    [x0, y0] = points[0],
    [x1, y1] = points.at(-1),
    dx = Math.abs(x1 - x0),
    dy = Math.abs(y1 - y0);
  if (dy <= dx * SLANT) return strikeOf(points, lines);
  if (dx <= dy * SLANT) return sliceOf(points, lines);
  return null;
}

// The words' boxes as lines of text, top to bottom: each { top, bottom, left, right, boxes: [{ rect, word, first,
// last }] } (first, last: the word's first or last box)
export function linesOf(words) {
  const lines = [];
  for (const word of words)
    word.rects.forEach((rect, i) => {
      const box = { rect, word, first: i === 0, last: i === word.rects.length - 1 },
        middle = (rect.top + rect.bottom) / 2;
      const line = lines.find(l => middle > l.top && middle < l.bottom);
      if (!line)
        return lines.push({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, boxes: [box] });
      line.boxes.push(box);
      Object.assign(line, {
        top: Math.min(line.top, rect.top),
        bottom: Math.max(line.bottom, rect.bottom),
        left: Math.min(line.left, rect.left),
        right: Math.max(line.right, rect.right),
      });
    });
  return lines.sort((a, b) => a.top - b.top);
}

// ---- a strike

// The line most of the stroke runs along the middle of, and each word there it covers enough of
function strikeOf(points, lines) {
  const line = lines.find(l => inBand(points, l) >= ALONG);
  if (!line) return null;
  const spans = spansIn(points, line),
    struck = line.boxes.filter(({ rect }) => covered(spans, rect) >= COVER * (rect.right - rect.left));
  if (!struck.length) return null;
  const ranges = [...new Set(struck.map(b => b.word))].map(w => [w.start, w.end]).sort((a, b) => a[0] - b[0]);
  return { kind: 'strike', ranges };
}
const band = l => {
  const cut = (l.bottom - l.top) * BAND;
  return [l.top + cut, l.bottom - cut];
};
// The share of a stroke's points in a line's middle band
function inBand(points, line) {
  const [top, bottom] = band(line);
  return points.filter(([, y]) => y >= top && y <= bottom).length / points.length;
}
// The x spans the stroke draws inside the line's band, one per step between two points there
function spansIn(points, line) {
  const [top, bottom] = band(line),
    inside = ([, y]) => y >= top && y <= bottom;
  const spans = [];
  for (let i = 1; i < points.length; i++)
    if (inside(points[i - 1]) && inside(points[i]))
      spans.push([Math.min(points[i - 1][0], points[i][0]), Math.max(points[i - 1][0], points[i][0])]);
  return spans;
}
// How much of a box's width the spans cover together (overlaps counted once)
function covered(spans, rect) {
  const clipped = spans
    .map(([a, b]) => [Math.max(a, rect.left), Math.min(b, rect.right)])
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);
  let total = 0,
    reach = -Infinity;
  for (const [a, b] of clipped) {
    if (b <= reach) continue;
    total += b - Math.max(a, reach);
    reach = b;
  }
  return total;
}

// ---- a slice

// The line the stroke reaches across (the nearest its middle, when it crosses several), cut where the stroke crosses
// the line's middle, at the word's edge nearest that
function sliceOf(points, lines) {
  const ys = points.map(p => p[1]),
    top = Math.min(...ys),
    bottom = Math.max(...ys),
    middle = (top + bottom) / 2;
  const across = lines.filter(l => {
    const reach = Math.min(bottom, l.bottom) - Math.max(top, l.top);
    return reach >= SPAN * (l.bottom - l.top);
  });
  if (!across.length) return null;
  const line = across.reduce((a, b) => (Math.abs(mid(b) - middle) < Math.abs(mid(a) - middle) ? b : a));
  const x = crossing(points, mid(line)),
    slack = line.bottom - line.top;
  if (x < line.left - slack || x > line.right + slack) return null;
  const edges = line.boxes.flatMap(({ rect, word, first, last }) => [
    ...(first ? [{ x: rect.left, at: word.start }] : []),
    ...(last ? [{ x: rect.right, at: word.end }] : []),
  ]);
  const nearest = edges.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a));
  return { kind: 'slice', at: nearest.at };
}
const mid = l => (l.top + l.bottom) / 2;
// Where the stroke crosses a height: between the two points either side of it (the first such step), else its point
// nearest it
function crossing(points, y) {
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1],
      [bx, by] = points[i];
    if ((ay - y) * (by - y) <= 0 && ay !== by) return ax + ((bx - ax) * (y - ay)) / (by - ay);
  }
  return points.reduce((a, b) => (Math.abs(b[1] - y) < Math.abs(a[1] - y) ? b : a))[0];
}

// ---- the text

// The text with the struck ranges gone, tidied: words either side of a cut keep one space between them, and a cut at
// a line's start or end leaves no space hanging there. Struck words with only spaces between go as one.
export function struck(text, ranges) {
  const merged = [];
  for (const [s, e] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && /^[ \t]*$/.test(text.slice(last[1], s))) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  let out = text;
  for (const [s, e] of merged.reverse()) {
    const before = out.slice(0, s).replace(/[ \t]*$/, ''),
      after = out.slice(e).replace(/^[ \t]*/, ''),
      spaced = out.slice(0, s) !== before || out.slice(e) !== after;
    const edge = !before || before.endsWith('\n') || !after || after.startsWith('\n');
    out = before + (spaced && !edge ? ' ' : '') + after;
  }
  return out;
}
// The text with words put in at an index, a space either side where a word would touch them: { text, caret } (caret:
// just after the words put in)
export function inserted(text, at, words) {
  const said = words.trim();
  if (!said) return { text, caret: at };
  const before = text.slice(0, at),
    after = text.slice(at);
  const lead = before && !/\s$/.test(before) ? ' ' : '',
    trail = after && !/^\s/.test(after) ? ' ' : '';
  return { text: before + lead + said + trail + after, caret: at + lead.length + said.length };
}

// ---- the words measured in the page

// An element's text and its words' boxes on screen: { text, words }. A textarea's words are measured in a copy of it
// laid out the same (a field's own text has no boxes to ask for); any other element's in its own text.
export function wordsOf(el) {
  if (el instanceof HTMLTextAreaElement) return inCopy(el);
  const nodes = [],
    walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) nodes.push(walk.currentNode);
  let text = '';
  const at = nodes.map(n => {
    const from = text.length;
    text += n.data;
    return { n, from };
  });
  // (a word's start is in the node holding its first letter, its end in the one holding its last)
  const holding = i => at.find(a => i >= a.from && i < a.from + a.n.data.length);
  const words = [...text.matchAll(/\S+/g)].map(m => {
    const range = document.createRange(),
      end = m.index + m[0].length,
      s = holding(m.index),
      e = holding(end - 1);
    range.setStart(s.n, m.index - s.from);
    range.setEnd(e.n, end - e.from);
    return { start: m.index, end, rects: rectsOf(range) };
  });
  return { text, words };
}
// A range's boxes, one per line (a browser gives a box per run of text it laid out; those on a line are joined)
function rectsOf(range) {
  const lines = [];
  for (const r of range.getClientRects()) {
    if (!r.width) continue;
    const line = lines.find(l => r.top < l.bottom && r.bottom > l.top);
    if (line) Object.assign(line, { left: Math.min(line.left, r.left), right: Math.max(line.right, r.right) });
    else lines.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }
  return lines;
}
// A textarea's words: its text in a copy laid out as it is, placed over it (penwords.js shows the same copy to open a
// gap), measured, and gone again
function inCopy(field) {
  const copy = copyOf(field);
  try {
    const { words } = wordsOf(copy);
    return { text: field.value, words };
  } finally {
    copy.remove();
  }
}
// A copy of an element's words in a box laid out as it is (its font, padding, width and wrap), over it on screen,
// unseen (shown: penwords.js's gap). Its text is one text node, the field's value or the element's text.
export function copyOf(field, { shown = false } = {}) {
  const copy = document.createElement('div'),
    style = getComputedStyle(field);
  for (const p of COPIED) copy.style[p] = style[p];
  Object.assign(copy.style, {
    position: 'absolute',
    margin: '0',
    borderColor: 'transparent',
    borderStyle: 'solid',
    overflow: 'hidden',
    pointerEvents: 'none',
    visibility: shown ? 'visible' : 'hidden',
    left: `${field.offsetLeft}px`,
    top: `${field.offsetTop}px`,
  });
  copy.textContent = field.value ?? field.textContent;
  field.after(copy);
  overlay(copy, field);
  copy.scrollTop = field.scrollTop;
  return copy;
}
// (what lays out a field's words)
const COPIED = [
  'boxSizing',
  'width',
  'height',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontStretch',
  'fontVariant',
  'letterSpacing',
  'wordSpacing',
  'lineHeight',
  'textTransform',
  'textIndent',
  'textAlign',
  'direction',
  'tabSize',
  'whiteSpace',
  'overflowWrap',
  'wordBreak',
  'color',
];
// A box placed absolutely beside an element moved so it lies over it on screen, whatever positions them (its offset
// parent may not be its own): placed, measured, and moved by what's left, in the box's own px (a page's zoom scales
// them both)
export function overlay(box, el, grow = 0) {
  const to = el.getBoundingClientRect(),
    now = box.getBoundingClientRect(),
    k = to.width / el.offsetWidth || 1;
  box.style.left = `${parseFloat(box.style.left) + (to.left - now.left) / k - grow}px`;
  box.style.top = `${parseFloat(box.style.top) + (to.top - now.top) / k - grow}px`;
  return k;
}

// The words of an agent's drawing fitted to the shapes they sit in, in the drawing's own frame once its fonts are in
// (drawing.ts), so no word runs out of its box whatever width the model guessed. A text that fits is left as drawn. One
// that doesn't is measured in the font it's drawn in and wrapped at its word gaps, then made a little smaller, and
// only then is its shape made bigger round it; several texts in one shape are stacked so none covers another, and the
// drawing's viewBox takes in whatever still reaches past it. The frame tells the agent what was fitted and which words
// still overlap. Each function here runs in the frame as its own source (FITTED), so it calls only the others here.

type Placed = { text: SVGTextElement; shape: SVGGeometryElement | null; words: string; how: Set<string> };
type Line = { words: string[]; like: Element | null };
type Span = { left: number; right: number };

// The script the frame runs: every function below, then the fitting once the page and its fonts are in, whose answer
// is { fitted, overlap }
const PARTS = [fitWords, shapesOf, upright, shapeOf, filled, inFill, spanAt, besides, heightAt, padOf, holds, linesOf];
export const FITTED = `${[...PARTS, layOut, shift, place, fit, grow, scaled, stack, roomFor, overlapsOf].join('\n')}
new Promise((resolve, reject) => {
  const ready = () => document.readyState === 'complete' ? document.fonts.ready.then(fitWords).then(resolve, reject) : setTimeout(ready, 20);
  ready();
})`;

function fitWords() {
  const svg = document.querySelector('main > svg') as SVGSVGElement | null;
  if (!svg) return { fitted: [], overlap: [] };
  const shapes = shapesOf();
  const placed: Placed[] = [...svg.querySelectorAll('text')]
    .filter(
      t =>
        !t.closest('defs, marker, pattern, clipPath, mask, symbol') &&
        t.textContent!.trim() &&
        !t.querySelector('textPath') &&
        upright(t),
    )
    .map(text => ({
      text,
      shape: null,
      words: linesOf(text)
        .flatMap(l => l.words)
        .join(' '),
      how: new Set(),
    }));
  for (const p of placed) p.shape = shapeOf(p.text, shapes);
  for (const p of placed) if (!holds(p.shape, p.text.getBoundingClientRect(), padOf(p.text))) fit(p);
  for (const shape of new Set(placed.map(p => p.shape))) if (shape) stack(placed.filter(p => p.shape === shape));
  roomFor(svg, Math.max(4, ...placed.map(p => padOf(p.text).x)));
  const unfit = placed.filter(p => !holds(p.shape, p.text.getBoundingClientRect(), padOf(p.text)));
  return {
    fitted: placed.filter(p => p.how.size).map(p => `"${p.words}" (${[...p.how].join(', ')})`),
    overlap: overlapsOf(placed).concat(
      unfit.map(p => `"${p.words}" and ${p.shape ? 'its shape' : 'a shape beside it'}`),
    ),
  };
}

// The drawing's closed shapes a text may be in or beside: not its arrows, nor what its defs define
function shapesOf() {
  const all = document.querySelectorAll<SVGGeometryElement>('main > svg :is(rect, circle, ellipse, polygon, path)');
  return [...all].filter(
    s => !s.closest('defs, marker, pattern, clipPath, mask, symbol') && !s.classList.contains('arrow') && upright(s),
  );
}

// Neither turned nor skewed, so its box on the screen is its own
function upright(e: SVGGraphicsElement) {
  const m = e.getScreenCTM();
  return !!m && Math.abs(m.b) < 1e-6 && Math.abs(m.c) < 1e-6 && m.a > 0 && m.d > 0;
}

// The smallest closed shape a text starts in (its anchor, the middle of its first line), or null for words on the page
function shapeOf(text: SVGTextElement, shapes: SVGGeometryElement[]) {
  const box = text.getBBox(),
    m = text.getScreenCTM()!,
    size = parseFloat(getComputedStyle(text).fontSize);
  const anchor = getComputedStyle(text).textAnchor;
  const x = anchor === 'middle' ? box.x + box.width / 2 : anchor === 'end' ? box.right - size / 2 : box.x + size / 2;
  const y = text.getNumberOfChars() ? text.getStartPositionOfChar(0).y - size * 0.35 : box.y + box.height / 2;
  const at = new DOMPoint(x, y).matrixTransform(m);
  const area = (s: Element) => s.getBoundingClientRect().width * s.getBoundingClientRect().height;
  const holding = shapes.filter(s => area(s) > 0 && inFill(s, at.x, at.y));
  return holding.sort((a, b) => area(a) - area(b))[0] ?? null;
}

// Whether a point on the screen is inside a shape's outline (null: the drawing's viewBox)
function filled(shape: SVGGeometryElement | null, x: number, y: number) {
  if (shape) return inFill(shape, x, y);
  const r = document.querySelector('main > svg')!.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}
function inFill(shape: SVGGeometryElement, x: number, y: number) {
  const p = new DOMPoint(x, y).matrixTransform(shape.getScreenCTM()!.inverse());
  return shape.isPointInFill(p);
}

// The widest a band of the screen (top to bottom) reaches inside a shape either side of x, or null if x isn't in it
function spanAt(shape: SVGGeometryElement | null, x: number, top: number, bottom: number): Span | null {
  const inside = (at: number) => [top, (top + bottom) / 2, bottom].every(y => filled(shape, at, y));
  if (!inside(x)) return null;
  const r = (shape ?? document.querySelector('main > svg')!).getBoundingClientRect();
  const reach = (to: number) => {
    let [lo, hi] = [x, to];
    for (let i = 0; i < 18; i++) [lo, hi] = inside((lo + hi) / 2) ? [(lo + hi) / 2, hi] : [lo, (lo + hi) / 2];
    return lo;
  };
  const span = { left: reach(r.left - 1), right: reach(r.right + 1) };
  return shape ? span : besides(span, x, top, bottom);
}

// The part of a band of the page either side of x that runs into no shape, or null if one is across x itself
function besides(span: Span, x: number, top: number, bottom: number): Span | null {
  for (const b of shapesOf().map(s => s.getBoundingClientRect())) {
    if (b.bottom <= top || b.top >= bottom || b.right <= span.left || b.left >= span.right) continue;
    if (b.left < x && b.right > x) return null;
    span = b.right <= x ? { ...span, left: b.right } : { ...span, right: b.left };
  }
  return span;
}

// How far a shape reaches up and down from a point in it: { top, bottom } on the screen
function heightAt(shape: SVGGeometryElement | null, x: number, y: number) {
  const r = (shape ?? document.querySelector('main > svg')!).getBoundingClientRect();
  const reach = (to: number) => {
    let [lo, hi] = [y, to];
    for (let i = 0; i < 18; i++) [lo, hi] = filled(shape, x, (lo + hi) / 2) ? [(lo + hi) / 2, hi] : [lo, (lo + hi) / 2];
    return lo;
  };
  return filled(shape, x, y) ? { top: reach(r.top - 1), bottom: reach(r.bottom + 1) } : null;
}

// The room a text keeps from its shape's outline, on the screen: a quarter of its letters' height across, a little
// above and below (its box already holds the letters' ascent and descent)
function padOf(text: SVGTextElement) {
  const size = parseFloat(getComputedStyle(text).fontSize) * text.getScreenCTM()!.a;
  return { x: size * 0.25, y: size * 0.05 };
}

// Whether a shape holds a box on the screen with its padding round it (null: the viewBox, across alone)
function holds(shape: SVGGeometryElement | null, r: DOMRect, pad: { x: number; y: number }) {
  if (!shape) {
    const page = document.querySelector('main > svg')!.getBoundingClientRect();
    const room = besides({ left: page.left, right: page.right }, (r.left + r.right) / 2, r.top, r.bottom);
    return !!room && r.left - pad.x >= room.left - 0.5 && r.right + pad.x <= room.right + 0.5;
  }
  const [l, t, rt, b] = [r.left - pad.x, r.top - pad.y, r.right + pad.x, r.bottom + pad.y];
  const xs = [l, (l + rt) / 2, rt],
    ys = [t, (t + b) / 2, b];
  return xs.every(x => ys.every(y => inFill(shape, x, y)));
}

// A text's lines as it was drawn: a tspan given its own x, y or dy starts one, and keeps its look (class, style)
function linesOf(text: SVGTextElement): Line[] {
  const lines: Line[] = [{ words: [], like: null }];
  for (const node of text.childNodes) {
    const span = node instanceof Element ? node : null;
    const starts = span && ['x', 'y', 'dy'].some(a => span.hasAttribute(a));
    if (starts && lines.at(-1)!.words.length) lines.push({ words: [], like: span });
    else if (span) lines.at(-1)!.like ??= span;
    lines.at(-1)!.words.push(...node.textContent!.split(/\s+/).filter(Boolean));
  }
  return lines.filter(l => l.words.length);
}

// The text written again as lines of tspans at a font size, each at most width wide on the screen (a word longer
// than that alone on its line), from where its first line was
function layOut(text: SVGTextElement, lines: Line[], size: number, width: number) {
  const first = text.getStartPositionOfChar(0),
    box = text.getBBox(),
    k = text.getScreenCTM()!.a;
  const anchor = getComputedStyle(text).textAnchor;
  const x = anchor === 'middle' ? box.x + box.width / 2 : anchor === 'end' ? box.right : box.x;
  text.replaceChildren();
  text.style.fontSize = `${size}px`;
  for (const line of lines) {
    let span: SVGTSpanElement | null = null;
    for (const word of line.words) {
      const was = span?.textContent ?? '';
      if (span) span.textContent = `${was} ${word}`;
      if (span && span.getComputedTextLength() * k <= width) continue;
      if (span) span.textContent = was;
      span = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
      for (const a of ['class', 'style'])
        if (line.like?.hasAttribute(a)) span.setAttribute(a, line.like.getAttribute(a)!);
      span.setAttribute('x', String(x));
      span.setAttribute(text.childNodes.length ? 'dy' : 'y', String(text.childNodes.length ? size * 1.2 : first.y));
      span.textContent = word;
      text.append(span);
    }
  }
}

// A text laid out by layOut moved across and down by so many px on the screen
function shift(text: SVGTextElement, dx: number, dy: number) {
  const m = text.getScreenCTM()!;
  for (const span of text.children) span.setAttribute('x', String(parseFloat(span.getAttribute('x')!) + dx / m.a));
  const top = text.firstElementChild!;
  top.setAttribute('y', String(parseFloat(top.getAttribute('y')!) + dy / m.d));
}

// The text laid out at a font size, its lines wrapped or as drawn, and placed in its shape near where it was (across
// by its anchor, down by its middle, or the shape's middle if not there), or false if it can't be so
function place(p: Placed, lines: Line[], size: number, was: DOMRect, wrap = true) {
  const anchor = getComputedStyle(p.text).textAnchor,
    k = p.text.getScreenCTM()!.a;
  const pad = { x: size * k * 0.25, y: size * k * 0.05 };
  const ax = anchor === 'middle' ? (was.left + was.right) / 2 : anchor === 'end' ? was.right : was.left;
  const outline = (p.shape ?? document.querySelector('main > svg')!).getBoundingClientRect();
  const mid = (outline.left + outline.right) / 2;
  for (const y of p.shape ? [(was.top + was.bottom) / 2, (outline.top + outline.bottom) / 2] : [was.top]) {
    let height = size * k * 1.2,
      span: Span | null = null,
      top = y;
    for (let round = 0; round < 4; round++) {
      const reach = p.shape ? heightAt(p.shape, mid, y) : { top: -Infinity, bottom: Infinity };
      if (!reach || reach.bottom - reach.top < height + 2 * pad.y) break;
      top = p.shape ? Math.min(Math.max(y - height / 2, reach.top + pad.y), reach.bottom - pad.y - height) : y;
      const at = [ax, mid].find(x => spanAt(p.shape, x, top - pad.y, top + height + pad.y));
      span = at === undefined ? null : spanAt(p.shape, at, top - pad.y, top + height + pad.y);
      if (!span) break;
      const [left, right] = [span.left + pad.x, span.right - pad.x];
      // (words on the page keep to their anchor's side where they can, clear of what's beside them)
      const near =
        anchor === 'middle' ? 2 * Math.min(ax - left, right - ax) : anchor === 'end' ? ax - left : right - ax;
      const from = p.shape ? right - left : near;
      layOut(p.text, lines, size, wrap ? from : Infinity);
      if (wrap && p.text.getBoundingClientRect().width > from + 0.5) layOut(p.text, lines, size, right - left);
      if (Math.abs(p.text.getBoundingClientRect().height - height) < 0.5) break;
      height = p.text.getBoundingClientRect().height;
      span = null;
    }
    const r = p.text.getBoundingClientRect();
    if (!span || r.width > span.right - span.left - 2 * pad.x + 0.5) continue;
    const from = anchor === 'middle' ? ax - r.width / 2 : anchor === 'end' ? ax - r.width : ax;
    const left = Math.min(Math.max(from, span.left + pad.x), span.right - pad.x - r.width);
    shift(p.text, left - r.left, top - r.top);
    if (holds(p.shape, p.text.getBoundingClientRect(), pad)) return true;
  }
  return false;
}

// A text that runs out of its shape fitted to it: one that only just does a little smaller on its lines, then on more
// lines, then smaller still (a fifth at most, so it's still read at the size the drawing gave it), then with its shape
// grown round it. Words on the page are only wrapped.
function fit(p: Placed) {
  const was = p.text.getBoundingClientRect(),
    lines = linesOf(p.text),
    size = parseFloat(getComputedStyle(p.text).fontSize);
  const sizes = p.shape ? [1, 0.95, 0.9, 0.85, 0.8].map(s => s * size) : [size];
  let at = p.shape ? sizes.slice(1, 3).find(s => place(p, lines, s, was, false)) : undefined;
  at ??= sizes.find(s => place(p, lines, s, was));
  if (at === undefined && p.shape) {
    at = sizes.at(-1)!;
    grow(p, lines, at, was);
  }
  const page = document.querySelector('main > svg')!.getBoundingClientRect();
  if (at === undefined && was.width > page.width - 2 * padOf(p.text).x)
    layOut(p.text, lines, size, page.width - 2 * padOf(p.text).x);
  const now = p.text.getBoundingClientRect();
  if (p.text.querySelectorAll('tspan').length > lines.length) p.how.add(`on ${p.text.children.length} lines`);
  if (at !== undefined && at < size) p.how.add('smaller');
  if (!p.how.size && Math.max(...(['x', 'y', 'width', 'height'] as const).map(k => Math.abs(now[k] - was[k]))) > 0.5)
    p.how.add('moved in');
}

// The text's shape grown round its middle until the text fits in it at a size
function grow(p: Placed, lines: Line[], size: number, was: DOMRect) {
  const shape = p.shape!;
  for (let round = 0; round < 8 && !place(p, lines, size, was); round++) {
    const r = p.text.getBoundingClientRect(),
      pad = padOf(p.text),
      s = shape.getBoundingClientRect();
    const middle = (s.top + s.bottom) / 2;
    const span = spanAt(shape, (s.left + s.right) / 2, middle - r.height / 2 - pad.y, middle + r.height / 2 + pad.y);
    const reach = heightAt(shape, (s.left + s.right) / 2, middle);
    const across = span ? Math.max(1, (r.width + 2 * pad.x) / (span.right - span.left)) : 1;
    const down = reach ? Math.max(1, (r.height + 2 * pad.y) / (reach.bottom - reach.top)) : 1.1;
    scaled(shape, Math.max(across, 1.02) * 1.02, Math.max(down, 1.02) * (span ? 1.02 : 1.1), false);
  }
  p.how.add('its shape made bigger');
}

// A shape made so many times wider and taller round its middle, or round the middle of its top
function scaled(shape: SVGGeometryElement, across: number, down: number, top: boolean) {
  const b = shape.getBBox(),
    cx = b.x + b.width / 2,
    cy = top ? b.y : b.y + b.height / 2;
  const set = (name: string, v: number) => shape.setAttribute(name, String(v));
  if (shape instanceof SVGRectElement) {
    set('x', cx - (b.width * across) / 2);
    set('width', b.width * across);
    set('y', cy - (top ? 0 : (b.height * down) / 2));
    set('height', b.height * down);
  } else if (shape instanceof SVGCircleElement || shape instanceof SVGEllipseElement) {
    const [rx, ry] = shape instanceof SVGCircleElement ? ['r', 'r'] : ['rx', 'ry'];
    const grown = shape instanceof SVGCircleElement ? Math.max(across, down) : 0;
    set(rx, (b.width / 2) * (grown || across));
    set(ry, (b.height / 2) * (grown || down));
    if (top) set('cy', b.y + (b.height / 2) * (grown || down));
  } else {
    const was = shape.getAttribute('transform') ?? '';
    shape.setAttribute('transform', `${was} translate(${cx} ${cy}) scale(${across} ${down}) translate(${-cx} ${-cy})`);
    shape.style.vectorEffect = 'non-scaling-stroke';
  }
}

// The texts in one shape stacked so that none covers one above it, and the shape grown down to hold them all
function stack(group: Placed[]) {
  const box = (p: Placed) => p.text.getBoundingClientRect();
  group.sort((a, b) => box(a).top - box(b).top);
  for (const [i, p] of group.entries()) {
    const r = box(p),
      above = group.slice(0, i).map(box);
    const floor = Math.max(...above.filter(a => a.left < r.right && r.left < a.right).map(a => a.bottom));
    if (floor <= r.top + 0.5) continue;
    const m = p.text.getScreenCTM()!;
    p.text.setAttribute('transform', `${p.text.getAttribute('transform') ?? ''} translate(0 ${(floor - r.top) / m.d})`);
    p.how.add('moved down');
  }
  const shape = group[0].shape!;
  for (let round = 0; round < 8; round++) {
    const out = group.filter(p => !holds(shape, box(p), padOf(p.text)));
    if (!out.length) return;
    const s = shape.getBoundingClientRect();
    const below = Math.max(...out.map(p => box(p).bottom + padOf(p.text).y * 4)) - s.bottom;
    scaled(shape, 1, Math.max(1.02, (s.height + Math.max(below, 0)) / s.height), true);
    for (const p of out) p.how.add('its shape made bigger');
  }
}

// The drawing's viewBox grown to take in whatever reaches past it with an edge round it (screen px), so nothing drawn
// is cut off its picture
function roomFor(svg: SVGSVGElement, margin: number) {
  const view = svg.viewBox.baseVal,
    width = svg.getBoundingClientRect().width;
  if (!view?.width || !view.height) return;
  const got = svg.getBBox(),
    edge = (margin * view.width) / width;
  const left = Math.min(view.x, got.x - edge),
    top = Math.min(view.y, got.y - edge);
  const right = Math.max(view.x + view.width, got.x + got.width + edge),
    bottom = Math.max(view.y + view.height, got.y + got.height + edge);
  if (right - left - view.width < 1 && bottom - top - view.height < 1) return;
  svg.setAttribute('viewBox', `${left} ${top} ${right - left} ${bottom - top}`);
  svg.style.height = `${(width * (bottom - top)) / (right - left)}px`;
}

// The texts that still cover each other, by their words (a box's own room above and below its letters left out)
function overlapsOf(placed: Placed[]) {
  const boxes = placed.map(p => ({ p, r: p.text.getBoundingClientRect(), y: padOf(p.text).y * 2 }));
  const covers = (a: (typeof boxes)[0], b: (typeof boxes)[0]) =>
    a.r.left + 1 < b.r.right &&
    b.r.left + 1 < a.r.right &&
    a.r.top + a.y < b.r.bottom - b.y &&
    b.r.top + b.y < a.r.bottom - a.y;
  return boxes.flatMap((a, i) =>
    boxes
      .slice(i + 1)
      .filter(b => covers(a, b))
      .map(b => `"${a.p.words}" and "${b.p.words}"`),
  );
}

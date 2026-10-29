// The Sketchbook's page under the pen: the sketch's lines on a dry canvas, the one being drawn on a wet canvas over it
// (ink.js, review mode's own pen), the eraser, undo and redo, and the page as a picture.
//
// A sketch keeps its lines in its own units, the CSS px of the page it was started on (w × h): on a smaller or larger
// screen the page is drawn at scale k, and a line drawn there is divided by k as it ends, so it stays where it was drawn.
import { pen, draw, fit, shown } from '/__review/ink.js';
import { fromSegment } from '/__review/eraser.js';
import { drawScrap, scrapLayer, setScrap } from './sketchscraps.js';

export const PAPER = '#fffdf8';
// the picture HQ gives the coordinator: twice the page, at most this long on its longer side
const PICTURE_PX = 2400;

// sheet: the page element, holding canvas.dry under canvas.wet. tool(): the tray's choice { kind: 'pen' | 'eraser',
// color, size, alpha }. changed(): after every change to the lines or the pictures (to save them). paste(at): a press
// held still on the bare paper (sketchscraps.js).
export function sheetPen(sheet, sketch, { tool, changed, paste }) {
  const page = { sheet, tool, lines: sketch.ink.slice(), k: 1, penSeen: false, dry: sheet.querySelector('canvas.dry') };
  // the pictures on the page, each known by its file.
  Object.assign(page, { w: sketch.w, h: sketch.h, scraps: (sketch.scraps ?? []).map(s => ({ ...s, key: s.file })) });
  // (a walk-through's recording has the dry canvas's own pictures, so it's told the strokes are in them: shown)
  page.redraw = () => {
    const g = fit(page.dry);
    g.scale(page.k, page.k);
    draw(g, page.lines);
    shown(page.dry, []);
    scraps.render();
  };
  const steps = history(page, changed);
  const scraps = scrapLayer(page, steps, { pen: drawing(page, steps), paste });
  rubbing(page, steps);
  return {
    get lines() {
      return page.lines;
    },
    get scraps() {
      return page.scraps;
    },
    addScrap: scraps.add,
    unpin: scraps.unpin,
    unpick: scraps.unpick,
    ready: scraps.ready,
    // the page drawn at scale k (on opening, and each time the screen changes size)
    layout(k) {
      page.k = k;
      page.redraw();
    },
    // The page as merged with the store's (someone else drew in it meanwhile: pagemerge.js), drawn again. What undo
    // knew goes: its steps' places are no longer the lines'.
    replace(lines, scraps) {
      page.lines.splice(0, page.lines.length, ...lines);
      page.scraps.splice(0, page.scraps.length, ...scraps.map(s => (s.key ? s : { ...s, key: s.file })));
      steps.done = [];
      steps.undone = [];
      page.redraw();
    },
    undo: steps.undo,
    redo: steps.redo,
    get canUndo() {
      return steps.done.length > 0;
    },
    get canRedo() {
      return steps.undone.length > 0;
    },
  };
}

// Undo and redo: each step a line added ({ add }) or a rub's lines taken ({ erased: [[place, line], ...] }, in the order
// they went, each with its place as it went: put back the other way round), or a picture's change ({ scrap: its key,
// from, to, at }: sketchscraps.js)
function history(page, changed) {
  const { lines } = page;
  const steps = { done: [], undone: [] };
  steps.apply = op => {
    if (op.scrap) setScrap(page.scraps, op.scrap, op.to, op.at);
    else if (op.add) lines.push(op.add);
    else for (const [i] of op.erased) lines.splice(i, 1);
  };
  const revert = op => {
    if (op.scrap) setScrap(page.scraps, op.scrap, op.from, op.at);
    else if (op.add) lines.splice(lines.lastIndexOf(op.add), 1);
    else for (const [i, line] of op.erased.slice().reverse()) lines.splice(i, 0, line);
  };
  steps.record = op => {
    steps.done.push(op);
    steps.undone = [];
    changed();
  };
  const step = (from, to, act) => {
    const op = steps[from].pop();
    if (!op) return;
    act(op);
    steps[to].push(op);
    page.redraw();
    changed();
  };
  steps.undo = () => step('done', 'undone', revert);
  steps.redo = () => step('undone', 'done', steps.apply);
  return steps;
}

// (once a pen has drawn, only the pen: the hand resting on the glass draws nothing)
function allowed(page, e) {
  if (e.pointerType === 'pen') page.penSeen = true;
  return (!page.penSeen || e.pointerType === 'pen') && e.button === 0;
}

// The pen: ink.js draws the line live on the wet canvas; as it ends it goes on the dry one, in the sketch's units
function drawing(page, steps) {
  const ink = pen(page.sheet, page.sheet.querySelector('canvas.wet'), {
    use: e => allowed(page, e) && page.tool().kind !== 'eraser',
    ink: () => {
      const t = page.tool();
      return { color: t.color, size: t.size * page.k, ...(t.alpha < 1 ? { alpha: t.alpha } : {}) };
    },
    end: stroke => {
      const line = inUnits(stroke, page.k),
        g = page.dry.getContext('2d');
      steps.apply({ add: line });
      g.save();
      g.scale(page.k, page.k);
      draw(g, [line]);
      g.restore();
      shown(page.dry, []);
      ink.clear();
      steps.record({ add: line });
    },
  });
  return ink;
}

// The eraser, on the lines it touches
function rubbing(page, steps) {
  eraser(page.sheet, {
    use: e => page.tool().kind === 'eraser' && allowed(page, e),
    at: (x, y) => {
      const r = page.tool().size / 2,
        k = page.k;
      // (the last first, so each place still holds as the ones before it go)
      const hit = page.lines
        .map((line, i) => [i, line])
        .filter(([, line]) => touches(line, x / k, y / k, r))
        .reverse();
      if (!hit.length) return null;
      steps.apply({ erased: hit });
      page.redraw();
      return hit;
    },
    end: erased => steps.record({ erased }),
  });
}

// A line from the screen's px into the sketch's units
function inUnits(stroke, k) {
  const r = v => Math.round((v / k) * 100) / 100;
  return { ...stroke, size: r(stroke.size), points: stroke.points.map(([x, y, p, t]) => [r(x), r(y), p, t]) };
}

// The eraser: a whole line goes where it's touched, as a finger's rub takes a pencil line in a notebook. A rub is one
// step to undo, however many lines it took. at(x, y) in the page's px gives the lines it took there, or null.
// A quick flick reports points far apart: the rub goes every few px between them.
const RUB_STEP_PX = 4;
function eraser(sheet, { use, at, end }) {
  let rub = null,
    last = null;
  const point = e => {
    const r = sheet.getBoundingClientRect(),
      x = e.clientX - r.left,
      y = e.clientY - r.top,
      [x0, y0] = last ?? [x, y],
      n = Math.max(1, Math.ceil(Math.hypot(x - x0, y - y0) / RUB_STEP_PX));
    last = [x, y];
    for (let i = 1; i <= n; i++) rub.push(...(at(x0 + ((x - x0) * i) / n, y0 + ((y - y0) * i) / n) ?? []));
  };
  // (a pointerdown has no coalesced events)
  const take = e => {
    const each = e.getCoalescedEvents?.();
    for (const c of each?.length ? each : [e]) point(c);
  };
  sheet.addEventListener('pointerdown', e => {
    if (rub || !use(e)) return;
    e.preventDefault();
    rub = [];
    last = null;
    sheet.setPointerCapture(e.pointerId);
    take(e);
  });
  sheet.addEventListener('pointermove', e => rub && take(e));
  const finish = () => {
    if (rub?.length) end(rub);
    rub = null;
  };
  sheet.addEventListener('pointerup', finish);
  sheet.addEventListener('pointercancel', finish);
}
// Whether a circle of radius r at (x, y) touches the line's ink
function touches(line, x, y, r) {
  const pts = line.points,
    reach = r + line.size / 2;
  for (let i = 0; i < pts.length; i++) {
    if (fromSegment([x, y], pts[i], pts[i + 1] ?? pts[i]) <= reach) return true;
  }
  return false;
}

// The sketch as a picture (a data URL): its pictures and lines on the paper, twice the page's size or at most PICTURE_PX
// long (scraps: each with its img loaded, sketchscraps.js)
export function pictureOf(sketch, type = 'image/png') {
  const s = Math.min(2, PICTURE_PX / Math.max(sketch.w, sketch.h)),
    c = document.createElement('canvas');
  c.width = Math.round(sketch.w * s);
  c.height = Math.round(sketch.h * s);
  const g = c.getContext('2d');
  g.fillStyle = PAPER;
  g.fillRect(0, 0, c.width, c.height);
  g.scale(s, s);
  for (const scrap of sketch.scraps ?? []) drawScrap(g, scrap);
  draw(g, sketch.ink);
  return c.toDataURL(type);
}

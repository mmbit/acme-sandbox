// Flat shapes painted in a palette: as one SVG, or on a 2D canvas. Both paint a role the same way: one ink line at one
// weight round every shape, faces in paper or their tone, the shade in dots, hatching or a flat tone, and the accent.
import { pathOf } from './shapes.js';

const FACES = { top: 0, ball: 0, left: 1, right: 2 };

// How a role is painted: { fill, pattern, stroke }. pattern ('dots', 'hatch', 'field'): laid over the fill. null:
// not drawn at all.
function paintOf(role, palette) {
  const { shade, ink, paper } = palette;
  const flat = shade === 'flat';
  if (role === 'line' || role === 'thin') return { stroke: true };
  if (role === 'accent') return { fill: palette.accent, stroke: true };
  if (role === 'accent-side') return { fill: palette.accentSide, stroke: true };
  if (role === 'shadow') return flat ? { fill: palette.shadow, stroke: false } : { pattern: shade, stroke: false };
  if (role === 'pool')
    return flat ? palette.pool && { fill: palette.pool, stroke: false } : { pattern: 'field', stroke: false };
  const cut = role.lastIndexOf('-');
  const tone = role.slice(0, cut),
    face = role.slice(cut + 1);
  if (tone === 'dark') return { fill: ink, stroke: true };
  if (flat) return { fill: (palette.tones[tone] ?? palette.tones.plain)[FACES[face]], stroke: true };
  return face === 'right' ? { fill: paper, pattern: shade, stroke: true } : { fill: paper, stroke: true };
}

// The weight of the line, and the patterns' sizes from it: a dot's pitch and radius, the hatching's pitch and weight.
const sizes = line => ({
  dots: { pitch: line * 3.4, r: line * 0.55 },
  field: { pitch: line * 5.5, r: line * 0.45 },
  hatch: { pitch: line * 3, weight: line * 0.55 },
});

// The shapes as an SVG, W x H, placed by { k, ox, oy } (shapes.js fit). line: the weight in px. title: what it shows,
// for screen readers. id: a prefix for its patterns, unique on a page that shows several palettes at once.
export function svg(
  shapes,
  palette,
  { W, H, k = 1, ox = 0, oy = 0, line = Math.max(1.5, W * 0.0028), title = '', id = `la-${palette.id ?? 'own'}` },
) {
  const s = sizes(line),
    n = v => +v.toFixed(2);
  const dot = (name, { pitch, r }) =>
    `<pattern id="${id}-${name}" width="${n(pitch)}" height="${n(pitch)}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<circle cx="${n(pitch / 2)}" cy="${n(pitch / 2)}" r="${n(r)}" fill="${palette.ink}"/></pattern>`;
  const hatch =
    `<pattern id="${id}-hatch" width="${n(s.hatch.pitch)}" height="${n(s.hatch.pitch)}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<path d="M0 0V${n(s.hatch.pitch)}" stroke="${palette.ink}" stroke-width="${n(s.hatch.weight)}"/></pattern>`;
  const body = shapes.map(shape => {
    const look = paintOf(shape.role, palette);
    if (!look) return '';
    const d = pathOf(shape, { k, ox, oy });
    const stroke = look.stroke
      ? ` stroke="${inkOf(shape, palette)}" stroke-width="${n(shape.role === 'thin' ? line / 2 : line)}"`
      : '';
    if (shape.kind === 'line') return `<path d="${d}" fill="none"${stroke}/>`;
    const under = look.pattern && look.fill ? `<path d="${d}" fill="${look.fill}"/>` : '';
    return `${under}<path d="${d}" fill="${look.pattern ? `url(#${id}-${look.pattern})` : look.fill}"${stroke}/>`;
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${escape(title)}">` +
    `<defs>${dot('dots', s.dots)}${dot('field', s.field)}${hatch}</defs><rect width="${W}" height="${H}" fill="${palette.ground}"/>` +
    `<g stroke-linejoin="round" stroke-linecap="round">${body.join('')}</g></svg>\n`
  );
}

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escape = text => text.replace(/[&<>"]/g, c => ENTITIES[c]);

// The shapes on a 2D canvas whose transform places the view's units k px apart (CSS px times the canvas's own scale,
// both in k), the line line px at that scale, the patterns' size kept on screen. Colours must be the canvas's: no var().
// Each shape keeps its Path2D, so a scene that keeps its shapes paints them again cheaply.
export function paint(ctx, shapes, palette, { k = 1, line = 1.5 } = {}) {
  ctx.lineJoin = ctx.lineCap = 'round';
  for (const shape of shapes) {
    const look = paintOf(shape.role, palette);
    if (!look) continue;
    shape.path ??= new Path2D(pathOf(shape));
    if (shape.kind !== 'line' && look.fill) {
      ctx.fillStyle = look.fill;
      ctx.fill(shape.path);
    }
    if (look.pattern) {
      ctx.fillStyle = pattern(ctx, palette, look.pattern, line, k);
      ctx.fill(shape.path);
    }
    if (look.stroke) {
      ctx.strokeStyle = inkOf(shape, palette);
      ctx.lineWidth = (shape.role === 'thin' ? line / 2 : line) / k;
      ctx.stroke(shape.path);
    }
  }
}

// A canvas pattern, made once per canvas, palette, kind and size, and turned 45 degrees and shrunk to keep its size
// on screen whatever k is
const patterns = new WeakMap();
function pattern(ctx, palette, kind, line, k) {
  const mine = patterns.get(ctx) ?? new Map();
  patterns.set(ctx, mine);
  const key = `${palette.ink}|${kind}|${line}`;
  if (!mine.has(key)) mine.set(key, tile(ctx, palette.ink, kind, sizes(line)[kind]));
  const made = mine.get(key);
  made.setTransform(new DOMMatrix().scale(1 / k).rotate(45));
  return made;
}
function tile(ctx, ink, kind, { pitch, r, weight }) {
  const side = Math.max(2, Math.round(pitch)),
    cell = new OffscreenCanvas(side, side),
    g = cell.getContext('2d');
  g.fillStyle = g.strokeStyle = ink;
  if (kind === 'hatch') {
    g.lineWidth = weight;
    g.beginPath();
    g.moveTo(side / 2, 0);
    g.lineTo(side / 2, side);
    g.stroke();
  } else {
    g.beginPath();
    g.arc(side / 2, side / 2, r, 0, Math.PI * 2);
    g.fill();
  }
  return ctx.createPattern(cell, 'repeat');
}

// The colour of a shape's line: ink, or onAccent for a line drawn on the accent (moved after paint, its last caller)
const inkOf = (shape, palette) => (shape.onAccent ? (palette.onAccent ?? palette.ink) : palette.ink);

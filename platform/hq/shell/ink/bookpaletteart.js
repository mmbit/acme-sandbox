// The tools' card's pictures and names (bookpalette.js): each tool's icon, a colour's swatch, a
// width as a line of it, the eraser's size as a ring, each ink's word, and the cursor on the paper.
import { icon } from '../icons.js';

// each tool's icon, HQ's in the look's own style (icons.js): the tools' modes, the pen's nibs, the shapes and their fill
export const ICONS = {
  select: icon('tool-select'),
  pen: icon('tool-pen'),
  pencil: icon('tool-pencil'),
  brush: icon('tool-brush'),
  highlighter: icon('tool-marker'),
  eraser: icon('tool-eraser'),
  ellipse: icon('shape-ellipse'),
  rect: icon('shape-rect'),
  line: icon('shape-line'),
  arrow: icon('shape-arrow'),
  text: icon('tool-text'),
  outline: icon('shape-outline'),
  filled: icon('shape-filled'),
  smooth: icon('tool-smooth'),
};
// the inks' words by their names (ink.js PENS, bookinkmath.js MARKERS)
export const INK_WORDS = {
  Night: 'inkNight',
  Graphite: 'inkGraphite',
  Brown: 'inkBrown',
  Red: 'inkRed',
  Orange: 'inkOrange',
  Yellow: 'inkYellow',
  Green: 'inkGreen',
  Teal: 'inkTeal',
  Sky: 'inkSky',
  Blue: 'inkBlue',
  Violet: 'inkViolet',
  Pink: 'inkPink',
};
// a colour as a drop of it on a disc of paper a little wider, so a dark ink shows on a dark look's card too (as wide
// as its svg: the one in use is ringed round it, booktools.css)
export const swatch = (color, alpha = 1) =>
  `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="#fffaf0"/><circle cx="10" cy="10" r="8.6" fill="${color}" fill-opacity="${alpha}" stroke="rgba(42,35,82,.28)" stroke-width="1"/></svg>`;
// a width as a short line of it, in the tool's colour (scaled so the widest fits)
export const widthIcon = (w, most, color, alpha = 1) =>
  `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12" stroke="${color}" stroke-opacity="${alpha}" stroke-width="${Math.max(1.4, (w / most) * 9)}" stroke-linecap="round"/></svg>`;
// the eraser's size as a ring that size (at most the button's)
export const ringIcon = (d, most) =>
  `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="${Math.max(2, (d / most) * 8)}" fill="#fffaf0" stroke="currentColor" stroke-width="1.4"/></svg>`;
// The cursor on the paper for a tool, as CSS: the eraser a ring its size (d, across), the marker a nib of its colour,
// the others a dot of theirs
export function cursorIcon(mode, color, d) {
  if (mode === 'eraser') {
    const s = d + 4,
      c = s / 2;
    const ring = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><circle cx="${c}" cy="${c}" r="${d / 2}" fill="rgba(255,250,240,.35)" stroke="#fffaf0" stroke-width="2.5"/><circle cx="${c}" cy="${c}" r="${d / 2}" fill="none" stroke="#2a2352" stroke-opacity=".7" stroke-width="1"/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(ring)}") ${c} ${c}`;
  }
  const svgCursor =
    mode === 'highlighter'
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="22"><rect x="2" y="2" width="10" height="18" rx="2" fill="${color}" fill-opacity=".6" stroke="#2a2352" stroke-opacity=".5"/></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="5.5" fill="none" stroke="#fffaf0" stroke-width="2"/><circle cx="8" cy="8" r="5.5" fill="none" stroke="${color}" stroke-opacity=".55"/><circle cx="8" cy="8" r="2.2" fill="${color}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svgCursor)}") ${mode === 'highlighter' ? '7 11' : '8 8'}`;
}

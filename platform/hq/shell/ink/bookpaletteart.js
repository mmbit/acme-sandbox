// The tools' card's pictures and names (bookpalette.js): each tool's icon in the controls' line, a colour's swatch, a
// width as a line of it, the eraser's size as a ring, each ink's word, and the cursor on the paper.
// (the cursor)
import { ERASER_PATHS } from '/__review/eraser.js';

// (the line's attributes on a group, as bookui.js's lineIcon: HQ's own style fills every svg, and that beats an
// attribute on the svg itself.)
const svg = body =>
  `<svg viewBox="0 0 20 20" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;
export const ICONS = {
  // Select: a dashed box, its dashes meeting at the corners
  select: svg('<path d="M4 4h12v12H4z" stroke-dasharray="2.6 3.4" stroke-dashoffset="1.3"/>'),
  pen: svg('<path d="M4.2 15.8l.9-3.6 8.6-8.6a2 2 0 0 1 2.8 2.8l-8.6 8.6z"/><path d="M12.3 5l2.7 2.7"/>'),
  // the pencil: its sharpened wood, the lead at its point
  pencil: svg(
    '<path d="M3.8 16.2l1.5-4.6 8.9-8.9 3.1 3.1-8.9 8.9z"/><path d="M5.3 11.6c1 .1 2.9 2 3.1 3.1"/><path d="M3.8 16.2l1.7-.6" stroke-width="2.4"/>',
  ),
  // the brush: its handle, the ferrule and the bristles' drop of ink
  brush: svg(
    '<path d="M16.6 3.4l-5.3 6.3"/><path d="M12.6 11l-2.1-2.1"/><path d="M10.5 8.9c-2.6-.5-4.6 1-4.9 3.4-.2 1.6-.8 2.6-2.2 3.4 3 .5 5.7-.2 7-1.9.9-1.2 1-2.9.1-4.9z"/>',
  ),
  highlighter: svg(
    '<path d="M6.6 13.6l7.6-9.4 3 2.4-7.6 9.4z"/><path d="M6.6 13.6l-1.5 2.4 3.1.2 1.4-1.8"/><path d="M3 18.2h9" stroke-width="2.2" opacity=".45"/>',
  ),
  eraser: svg(ERASER_PATHS),
  ellipse: svg('<ellipse cx="10" cy="10" rx="6.6" ry="5.4"/>'),
  rect: svg('<rect x="3.6" y="5" width="12.8" height="10" rx="1.2"/>'),
  line: svg('<path d="M4.5 15.5l11-11"/>'),
  arrow: svg('<path d="M4.5 15.5l11-11"/><path d="M9.2 4.5h6.3v6.3"/>'),
  text: svg('<path d="M4.5 5.5V4h11v1.5"/><path d="M10 4v12"/><path d="M7.5 16h5"/>'),
  outline: svg('<rect x="4" y="4" width="12" height="12" rx="2"/>'),
  filled: svg('<rect x="4" y="4" width="12" height="12" rx="2" fill="currentColor"/>'),
  smooth: svg('<path d="M3 13c2.5-6 4.5-6 7-1.5S15 15 17 7"/>'),
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
// a colour as a drop of it on a disc of paper a little wider, so a dark ink shows on a dark look's card too
export const swatch = (color, alpha = 1) =>
  `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="#fffaf0"/><circle cx="10" cy="10" r="7" fill="${color}" fill-opacity="${alpha}" stroke="rgba(42,35,82,.28)" stroke-width="1"/></svg>`;
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

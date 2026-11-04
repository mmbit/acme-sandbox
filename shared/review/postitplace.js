// Where the post-it stands on the page, and the Pencil's strip with it (postit.js)
import { boxOfLines } from './mark.js';
import { openLines } from './marks.js';

// The post-it and the strip placed together against the ink being drawn, so the lines stay in reach (a phone, an iPad
// on its side): the post-it at the foot of the page, or up top, and where neither end clears the ink, folded to its head
// and words (no polaroid). It moves only once it stands over some of the ink and another place stands over less, and
// unfolds once a whole post-it stands over no more than the folded one. The strip (surface.js) goes to the page's other
// end from the post-it, clear of the safe area there, as far from the ink as that side allows (the next line of the
// mark goes beside the last), or beside the post-it where the ink reaches that end.
const EDGE_PX = 12, // (the strip's least margin at the page's top and foot, as the post-it's: postit.js)
  CLEAR_PX = 16, // (ink this close to the post-it or the strip counts as under it)
  STRIP_PX = 54, // (the strip lying down: a 40 px key, its padding, border and shadow)
  GAP_PX = 10; // (between the post-it and the strip beside it)

export function placed(r) {
  if (r.sheet.hidden) return;
  const ink = inkUnder(r),
    ends = stripEnds(r),
    now = placeNow(r);
  // (the first of the least covered wins: a whole post-it before a folded one, where it stands before the other end)
  const places = [false, true].flatMap(folded => [now.up, !now.up].map(up => ({ up, folded })));
  const best = places
    .map(place => ({ ...place, ...coverAt(r, place, ink, ends) }))
    .reduce((a, b) => (b.covered < a.covered ? b : a));
  setPlace(r, best);
  r.ui.style.setProperty('--strip-y', `${best.stripTop}px`);
}

// The open mark's ink, as the span of the page's height it takes, where it could be under the post-it (not beside it);
// null where it can't
function inkUnder(r) {
  const lines = openLines(r);
  if (!lines.length) return null;
  const ink = boxOfLines(lines),
    { left, right } = r.sheet.getBoundingClientRect(),
    besideIt = ink.x > right + CLEAR_PX || ink.x + ink.w < left - CLEAR_PX;
  return besideIt ? null : { top: ink.y - CLEAR_PX, foot: ink.y + ink.h + CLEAR_PX };
}

// The post-it at a place and the strip with it: where the strip's top goes, and how much of the ink's height both cover
function coverAt(r, place, ink, ends) {
  const sheet = sheetAt(r, place),
    covers = (top, foot) => (ink ? Math.max(0, Math.min(ink.foot, foot) - Math.max(ink.top, top)) : 0),
    farEnd = place.up ? ends.lowest : ends.highest,
    besideSheet = place.up ? sheet.foot + GAP_PX : sheet.top - GAP_PX - STRIP_PX,
    stripTop = covers(farEnd, farEnd + STRIP_PX) ? besideSheet : farEnd;
  return { stripTop, covered: covers(sheet.top, sheet.foot) + covers(stripTop, stripTop + STRIP_PX) };
}

// The post-it's top and foot on the page at a place (its CSS: postit.js), measured with the place's classes on
function sheetAt(r, place) {
  const was = placeNow(r);
  setPlace(r, place);
  const top = r.sheet.offsetTop,
    foot = top + r.sheet.offsetHeight;
  setPlace(r, was);
  return { top, foot };
}

// How high and how low the strip's top may go: EDGE_PX inside the page, or inside its safe area (measured: surface.js)
function stripEnds(r) {
  const style = getComputedStyle(r.bar),
    inset = side => Math.max(EDGE_PX, parseFloat(style.getPropertyValue(`--inset-${side}`)));
  return { highest: inset('top'), lowest: innerHeight - inset('bottom') - STRIP_PX };
}

const placeNow = r => ({ up: r.ui.classList.contains('up'), folded: r.ui.classList.contains('folded') });
function setPlace(r, { up, folded }) {
  r.ui.classList.toggle('up', up);
  r.ui.classList.toggle('folded', folded);
}

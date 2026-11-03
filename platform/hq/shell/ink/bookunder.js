// What hangs under a notebook page's unit (bookunits.js), in the page's px: its words, answers and replies, with the
// agent's face and pencil dots while an answer comes (bookgroups.js .bk-under), then a try's versions (bookanswers.js
// .bk-versions), one under the other. The masonry keeps the room for all of it under the unit; on a sketch page it hangs
// where it covers no other unit (sketchcanvas.js canvasOf).

// How tall what hangs under a unit is, in the page's px, each with the gap above it
export function underOf(view, id) {
  return hangingOf(view, id).reduce((h, el) => h + el.offsetHeight + HANG, 0);
}
// (the gap above each thing that hangs under a unit, page px)
const HANG = 10;
const hangingOf = (view, id) =>
  [`.bk-groups > .bk-under`, `.bk-answers > .bk-versions`]
    .map(at => view.el.querySelector(`:scope > ${at}[data-g="${id}"]`))
    .filter(Boolean);
// What hangs under a unit's place p moved to the box laid for it (p.hung: bookunits.js), a try's versions as wide as the
// unit
export function hangUnder(view, p) {
  let foot = p.hung.y;
  for (const el of hangingOf(view, p.id)) {
    Object.assign(el.style, { left: `${p.hung.x}px`, top: `${foot + HANG}px` });
    if (el.matches('.bk-versions')) el.style.width = `${p.w}px`;
    foot += HANG + el.offsetHeight;
  }
  tieUp(view, p);
}
// A tie in the book's ink from a unit to what hangs under it past its row (p.hung.tie: sketchcanvas.js), down to the
// top of the first card hanging, HANG and its own margin under its box's; none where it hangs at the unit's foot or
// beside it
function tieUp(view, p) {
  const [first] = hangingOf(view, p.id),
    was = view.el.querySelector(`.bk-tie[data-g="${p.id}"]`);
  if (!first || !p.hung.tie) return was?.remove();
  const top = HANG + first.firstElementChild.offsetTop,
    points = p.hung.tie.map(([x, y], i, all) => [x, i === all.length - 1 ? y + top : y]),
    [x0, y0] = [0, 1].map(k => Math.min(...points.map(pt => pt[k]))),
    tie = was ?? document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  tie.setAttribute('class', 'bk-tie');
  tie.dataset.g = p.id;
  Object.assign(tie.style, { left: `${x0}px`, top: `${y0}px` });
  tie.innerHTML = `<polyline points="${points.map(([x, y]) => `${x - x0},${y - y0}`).join(' ')}"/>`;
  first.before(tie);
}

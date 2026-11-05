// What hangs under a notebook page's unit (bookunits.js), in the page's px: its words, answers and replies, with the
// agent's face and pencil dots while an answer comes (bookgroups.js .bk-under), then a try's versions (bookanswers.js
// .bk-versions), one under the other. The masonry keeps the room for all of it under the unit.

// How tall what hangs under a unit is, in the page's px, each with the gap above it; bare: the unit has nothing on it
// and draws no card (bookunits.js), so the first hangs at its top with no gap.
export function underOf(view, id, bare = false) {
  const h = hangingOf(view, id).reduce((h, el) => h + el.offsetHeight + HANG, 0);
  return bare && h ? h - HANG : h;
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
  // (a bare unit's, h 0, from its top: underOf.)
  let foot = p.hung.y,
    gap = p.h ? HANG : 0;
  for (const el of hangingOf(view, p.id)) {
    Object.assign(el.style, { left: `${p.hung.x}px`, top: `${foot + gap}px` });
    if (el.matches('.bk-versions')) el.style.width = `${p.w}px`;
    foot += gap + el.offsetHeight;
    gap = HANG;
  }
}

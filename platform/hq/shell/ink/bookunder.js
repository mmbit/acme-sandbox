// What hangs under a notebook page's unit (bookunits.js), in the page's px: its words, answers and replies, with the
// agent's face and pencil dots while an answer comes (bookgroups.js .bk-under), then a try's versions (bookanswers.js
// .bk-versions), one under the other. The masonry keeps the room for all of it under the unit.

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
// What hangs under a unit's place p moved to its foot, a try's versions as wide as the unit
export function hangUnder(view, p) {
  let foot = p.y + p.h;
  for (const el of hangingOf(view, p.id)) {
    Object.assign(el.style, { left: `${p.x}px`, top: `${foot + HANG}px` });
    if (el.matches('.bk-versions')) el.style.width = `${p.w}px`;
    foot += HANG + el.offsetHeight;
  }
}

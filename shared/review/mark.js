// What a note marks: the element under a pin or a drawing, the screen it was seen on, a video's moment, and the mark as
// it goes with the note (its anchor, anchor.js, in document px, with review mode's own: the kind, the drawn area, the
// element's HTML). While the note is open the mark stays in the screen's px, as its lines are drawn.
import { V, box, isPrivate, noKeys, selector, textOf } from './anchor.js';
import { under } from './surface.js';

// where lines are: the box around all their points
export function boxOfLines(lines) {
  const pts = lines.flatMap(l => l.points),
    xs = pts.map(q => q[0]),
    ys = pts.map(q => q[1]);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}

// The element as it goes, in the screen's px: its HTML without form values, like the screenshot (hidden and password
// fields are dropped, other fields lose their value, a button's value is its label, so it stays, and textareas lose
// their text), and none of it when it's private
export function describe(el) {
  const c = el.cloneNode(true);
  for (const f of [c, ...c.querySelectorAll('input, textarea')]) {
    if (f.localName === 'textarea') f.textContent = '';
    else if (f.localName !== 'input' || /^(button|submit|reset|image)$/.test(f.type)) continue;
    else if ((f.type === 'hidden' || f.type === 'password') && f !== c) f.remove();
    else f.removeAttribute('value');
  }
  const html = isPrivate(el) ? '' : c.outerHTML.slice(0, 2000);
  return { selector: selector(el), tag: el.localName, text: textOf(el), html, rect: box(el.getBoundingClientRect()) };
}

// A drawn mark's area, around all its lines, and the smallest element that holds most of it
export function aim(r) {
  const { mark } = r;
  if (mark.kind !== 'circle') return;
  const area = boxOfLines(r.strokes);
  let el = under(r, area.x + area.w / 2, area.y + area.h / 2);
  for (
    let b;
    el.parentElement &&
    el !== document.body &&
    (b = el.getBoundingClientRect()) &&
    (b.width < area.w * 0.8 || b.height < area.h * 0.8);
  )
    el = el.parentElement;
  Object.assign(mark, { el, area });
  if (!mark.element) return; // (compose describes it)
  mark.element = { ...mark.element, ...describe(el), area: box(area) };
  if (r.editing) r.editing.mark = { ...marked(r), live: el };
}

// the screen too, as a big screen with a half-width window reads as a small laptop; touch points tell an iPad from a Mac
export const viewNow = () => ({
  w: innerWidth,
  h: innerHeight,
  dpr: devicePixelRatio || 1,
  x: Math.round(scrollX),
  y: Math.round(scrollY),
  ua: navigator.userAgent,
  sw: screen.width,
  sh: screen.height,
  touch: navigator.maxTouchPoints || 0,
});

// A note's lines as they go with it (at most MAX_LINES of them), each thinned to at most 1,000 points (its last kept)
// and all of them to 12,000, the coordinator's caps (feedback.ts inkOf), so every line is drawn again on a change
const thin = (l, most) =>
  l.points.length <= most
    ? l
    : {
        ...l,
        points: l.points.filter((_, i, all) => i % Math.ceil(all.length / (most - 1)) === 0 || i === all.length - 1),
      };
const inkOut = strokes => strokes.map(l => thin(l, Math.min(1000, Math.floor(12_000 / strokes.length))));

// The mark as the note keeps it: its anchor in document px (the screen's px plus the scroll it was drawn at), with its
// kind, area and HTML, and whether its first picture is the video's frame
export function marked(r) {
  const e = r.mark.element,
    v = r.mark.view;
  const onPage = b => (b ? { ...b, x: b.x + v.x, y: b.y + v.y } : null);
  return {
    v: V,
    url: noKeys(r.mark.page),
    el: e.tag ? { selector: e.selector, tag: e.tag, text: e.text, box: onPage(e.rect) } : null,
    view: { w: v.w, h: v.h, x: v.x, y: v.y, dpr: v.dpr },
    ink: inkOut(r.strokes).map(l => ({ ...l, points: l.points.map(([x, y, ...rest]) => [x + v.x, y + v.y, ...rest]) })),
    kind: e.kind,
    area: onPage(e.area),
    html: e.html ?? '',
    ...(e.video ? { video: { ...e.video, frame: !!r.framePic && r.pictures[0] === r.framePic } } : {}),
  };
}
// the mark as the polaroid frames it (frame.js): in the screen's px, as the screenshot is
export const onScreen = m => ({
  kind: m.element.kind,
  area: m.element.area,
  el: m.element.rect && { box: m.element.rect },
  view: { ...m.view, x: 0, y: 0 },
});

// A note on a video keeps its moment: the video under the pin (or the circle's middle) stops there, its time goes with
// the note ("at 0:07"), the screenshot shows that frame, and the frame itself goes with it as a picture.
// (a video with no frame yet has no moment to keep)
export const videoAt = m =>
  [
    m.el.closest('video'),
    ...document.elementsFromPoint(...(m.area ? [m.area.x + m.area.w / 2, m.area.y + m.area.h / 2] : [m.x, m.y])),
  ].find(e => e?.localName === 'video' && e.readyState >= 2);
export const clock = t => {
  const s = Math.floor(t),
    mm = `${Math.floor(s / 60) % 60}`;
  return `${s >= 3600 ? `${Math.floor(s / 3600)}:${mm.padStart(2, '0')}` : mm}:${`${s % 60}`.padStart(2, '0')}`;
};

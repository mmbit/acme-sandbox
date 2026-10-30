// How HQ's viewer lays out its frames: which device sizes a screen offers, and whether live and staging fit side by
// side or take turns as tabs. Plain maths (viewer.js draws it), so node tests it: viewerfit.test.js.

// The sizes a frame can play, by the width a page gets on each (CSS px). "This device" fills its column as it is.
// A device frame never grows past its width: only shrinks, down to least of it (narrower columns take turns as tabs).
// prettier-ignore
export const DEVICES = {
  here:    { name: 'This device', width: null, least: 360 },
  desktop: { name: 'Desktop',     width: 1440, least: 560 },
  tablet:  { name: 'Tablet',      width: 768,  least: 384 },
  phone:   { name: 'Phone',       width: 390,  least: 320 },
};
// A screen this wide or wider offers a phone's size, and from WIDE up a tablet's and a desktop's too. Under SWITCH
// there's no switcher: the screen is the device.
const SWITCH = 1000,
  WIDE = 1200;
// Room round the frames and between two side by side, and the head row over them (labels, or the tabs)
export const GAP = 24;
export const HEAD = 40;

// The device sizes a screen w px wide offers, in the switcher's order
export function devicesFor(w) {
  if (w < SWITCH) return ['here'];
  if (w < WIDE) return ['here', 'phone'];
  return ['here', 'desktop', 'tablet', 'phone'];
}

// The layout in a stage w × h px for a device, with live beside staging (two) or staging alone:
// { columns: both shown at once, column: each one's width, width: the page's own width in its frame, scale: what the
// frame is drawn at, height: the page's own height in its frame, head: whether a head row sits over the frames, pad:
// the room round them }. This device in tabs goes edge to edge, as the page would on it.
export function fit(w, h, device, two) {
  const d = DEVICES[device],
    head = two || device !== 'here',
    across = (n, pad) => Math.floor((w - 2 * pad - (n - 1) * GAP) / n),
    columns = two && across(2, GAP) >= d.least,
    pad = columns || device !== 'here' ? GAP : 0,
    column = Math.max(0, across(columns ? 2 : 1, pad)),
    width = d.width ?? column,
    scale = Math.min(1, column / width),
    room = Math.max(0, h - (head ? HEAD : 0) - (pad ? GAP / 2 : 0));
  return { columns, column, width, scale, height: Math.round(room / scale), head, pad };
}

// A screen's choices as kept (HQ's store, per screen shape): the device, and the notebook over the frames or beside
// them. kept: what the store had, or null. offered: devicesFor's. book: 'over' | 'beside'.
export function chosen(kept, offered, shape) {
  const device = offered.includes(kept?.device) ? kept.device : 'here',
    book = kept?.book === 'over' || kept?.book === 'beside' ? kept.book : shape === 'wide' ? 'beside' : 'over';
  return { device, book };
}
// Over or beside is a choice only on a screen on its side: upright and on a phone the notebook always lies over
export const bookChoice = shape => shape === 'landscape' || shape === 'wide';

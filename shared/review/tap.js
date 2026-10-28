// A pen's tap, as a hand taps without thinking: a click, never a dot of ink (pencil.js on HQ's page, and HQ's book).
// No imports, so the book loads it alone.
// Lifted within TAP_MS, never further than TAP_PX from where it touched. A Pencil's tap wobbles a few px, more than
// where ink starts (pencil.js MOVE), so it's judged as the pen lifts, a line already begun thrown away. A still press
// longer than this is a hold (pentouch.js: the device's own, prefs.js.).
export const TAP_MS = 300;
export const TAP_PX = 10;
// down, up: the pen's pointerdown and pointerup; reach: the farthest it got from down in between, in px
export const isTap = (down, up, reach = distance(down, up)) =>
  up.pointerId === down.pointerId && up.timeStamp - down.timeStamp < TAP_MS && reach < TAP_PX;
// Whether the pen has gone past a tap's reach: a line, not a tap
export const wandered = (down, e) => distance(down, e) >= TAP_PX;
export const distance = (a, b) => Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);

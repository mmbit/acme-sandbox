// A key dropped onto a table: it falls from above its place, lands with a clack and bounces to rest, as Wire's keys do
// when HQ opens and the projects view's when a level opens, by the platform's fall (shared/tactile/drop.js). Or pinned
// to a board, as a note is (pinKey).
import { fall } from '../../../shared/tactile/drop.js';

// el falls from height px above its place, delay ms from now, tilted by tilt degrees until it first lands. land(k) is
// called as it hits, for its first two landings (k: 0, then 1).
export function dropKey(el, { height, delay = 0, tilt = 0, land = () => {} }) {
  const { frames, hits, duration } = fall(height);
  el.animate(
    [{ t: 0, y: frames[0].y }, ...frames].map(f => ({
      offset: f.t / duration,
      transform: `translateY(${f.y.toFixed(1)}px) rotate(${(f.y < 0 && f.t < hits[0].t ? (tilt * -f.y) / height : 0).toFixed(2)}deg)`,
    })),
    { duration: duration * 1000, delay, fill: 'backwards' },
  );
  hits.slice(0, 2).forEach((h, k) => setTimeout(() => land(k), delay + h.t * 1000));
}
// el pinned to a board, delay ms from now: it comes down a little onto its place, held by the pin at its top, and
// swings once on it to rest, tilted by tilt degrees as it lands. land(0) is called as the pin goes in.
const PIN_MS = 460,
  PINNED = 0.45; // (the share of the move by which it's on the board)
export function pinKey(el, { delay = 0, tilt = 0, land = () => {} }) {
  // (it swings about its pin's head, 14 px down its middle: style.css)
  const at = (offset, transform) => ({ offset, transform, transformOrigin: '50% 14px' });
  el.animate(
    [
      { ...at(0, `translateY(-18px) rotate(${tilt.toFixed(2)}deg) scale(1.02)`), opacity: 0 },
      { ...at(PINNED, `rotate(${tilt.toFixed(2)}deg)`), opacity: 1 },
      at(0.72, `rotate(${(-tilt * 0.4).toFixed(2)}deg)`),
      at(1, 'none'),
    ],
    { duration: PIN_MS, delay, easing: 'ease-out', fill: 'backwards' },
  );
  setTimeout(() => land(0), delay + PIN_MS * PINNED);
}

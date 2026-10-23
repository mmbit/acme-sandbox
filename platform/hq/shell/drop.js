// A key dropped onto a table: it falls from above its place, lands with a clack and bounces to rest, as Wire's keys do
// when HQ opens and the projects view's when a level opens, by the platform's fall (shared/tactile/drop.js).
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

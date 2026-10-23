// Tiles dropped onto the page: each falls from above the screen a moment after the one before, tilted a little, lands,
// bounces and comes to rest, as a tile dropped on a table would.
import { reducedMotion } from './motion.js';

export const GRAVITY_PX_S2 = 4200;
// What a landing gives back of the speed it hit with
export const BOUNCE = 0.3;
// Slower than this after a bounce, it stays down
export const REST_PX_S = 140;
export const DROP_DELAY_MS = 120;
export const DROP_STAGGER_MS = 70;
// The most a tile leans as it falls (either way), straightened by the time it lands
export const DROP_TILT_DEG = 5;
// It falls from this far above the screen's top
export const DROP_CLEARANCE_PX = 40;
const FRAME_S = 1 / 60;
const MAX_FRAMES = 240; // (4 s: a fall from any screen's height has come to rest sooner)

// Drops each tile in turn (in view: one below the screen is simply there). onBounce(index, bounce) runs as tile
// number index lands (bounce 0) and bounces (1, 2…), for its clack.
export function dropTiles(tiles, { onBounce = () => {} } = {}) {
  if (reducedMotion()) {
    tiles.forEach((_, index) => onBounce(index, 0));
    return;
  }
  tiles.forEach((tile, index) => {
    const height = tile.getBoundingClientRect().bottom + DROP_CLEARANCE_PX,
      { frames, hits, duration } = fall(height),
      tilt = (Math.random() * 2 - 1) * DROP_TILT_DEG,
      delay = DROP_DELAY_MS + index * DROP_STAGGER_MS,
      lean = frame => (frame.y < 0 && frame.t < hits[0].t ? (tilt * -frame.y) / height : 0);
    tile.animate(
      [{ t: 0, y: frames[0].y }, ...frames].map(frame => ({
        offset: frame.t / duration,
        transform: `translateY(${frame.y.toFixed(1)}px) rotate(${lean(frame).toFixed(2)}deg)`,
      })),
      { duration: duration * 1000, delay, fill: 'backwards' },
    );
    hits.forEach((hit, bounce) => setTimeout(() => onBounce(index, bounce), delay + hit.t * 1000));
  });
}

// A fall from height above its place, a frame at a time: where it is (y, 0 at rest) at each time (t, in seconds),
// and when and how fast it lands each time (hits)
export function fall(height) {
  const frames = [],
    hits = [];
  let y = -height,
    v = 0,
    t = 0;
  for (let n = 0; n < MAX_FRAMES; n++) {
    v += GRAVITY_PX_S2 * FRAME_S;
    y += v * FRAME_S;
    t += FRAME_S;
    if (y >= 0) {
      y = 0;
      hits.push({ t, v });
      v = -v * BOUNCE;
      if (Math.abs(v) < REST_PX_S) {
        frames.push({ y: 0, t });
        break;
      }
    }
    frames.push({ y, t });
  }
  return { frames, hits, duration: t };
}

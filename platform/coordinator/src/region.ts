// A part of a screen or picture an agent asks for, in fractions of it from its top left.
import type { Region } from '../../../shared/watchalong/mirror.ts';

// The region asked for: undefined when none was, null when it isn't one (each side 0 to 1, with an area, inside)
export function regionOf(asked: unknown): Region | undefined | null {
  if (asked == null) return undefined;
  const { x, y, width, height } = asked as Record<string, unknown>;
  const all = [x, y, width, height];
  if (!all.every(v => typeof v === 'number' && v >= 0 && v <= 1)) return null;
  const region = { x: x as number, y: y as number, width: width as number, height: height as number };
  // (0.0001 over: thirds and the like add up past 1 in floating point)
  return region.width > 0 &&
    region.height > 0 &&
    region.x + region.width <= 1.0001 &&
    region.y + region.height <= 1.0001
    ? region
    : null;
}

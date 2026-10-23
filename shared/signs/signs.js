// The signs a screen shows of work under way and of what waits: the ring that turns round a face at work, times in words
// (how long ago, how long, about when), the count of what's unread and the pulse of jobs running.
// Nothing here has a colour of its own or a sound: the page colours the marks by their classes, and the ring by the
// colour ringColour picks from the worker's own (an agent's shirt, a machine's lights).
import { contrastChannels } from '../contrast/contrast.js';

// The ring: a turn this long, this share of its circle drawn, never under this contrast with the key it's on
export const RING_TURN_MS = 6000;
export const RING_ARC = 0.45;
export const RING_FLOOR = 2;
// The pulse: each voice's beat this long, a voice's beat this share of it after the one before (HQ's projects view's)
export const BEAT_MS = 1200;
export const BEAT_SPREAD = 0.38;
// A count past this reads as this and a plus
export const COUNT_MAX = 99;

// ring({ working }): the ring round a face, an <svg class="ring"> to lay over its box, turning while working. Its
// stroke is the page's (--ring); a 76 grid, 5 thick, so it scales with the face.
export const ring = ({ working = true } = {}) =>
  `<svg class="ring${working ? ' turning' : ''}" viewBox="0 0 76 76" style="--ring-turn: ${RING_TURN_MS}ms" aria-hidden="true"><circle cx="38" cy="38" r="35" pathLength="100" stroke-dasharray="${RING_ARC * 100} ${100 - RING_ARC * 100}"/></svg>`;

// ringColour(colour, key): the worker's own colour where it stands out from the key under it, else the same colour
// deepened (or, on a dark key, lifted) by the least step that does, so a cream shirt on a white key still rings
export function ringColour(colour, key, floor = RING_FLOOR) {
  const own = channels(colour),
    under = channels(key),
    toward = contrastChannels([0, 0, 0], under) >= contrastChannels([255, 255, 255], under) ? 0 : 255;
  for (let t = 0; t < 1; t += 0.02) {
    const mixed = own.map(c => c + (toward - c) * t);
    if (contrastChannels(mixed, under) >= floor) return toHex(mixed);
  }
  return toHex([toward, toward, toward]);
}

const channels = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const toHex = rgb => `#${rgb.map(c => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

// ---- times in words. at and now are ms; timeZone the company's clock (Intl's name), the reader's where none
const MINUTE = 60_000;
// ago(at): how long ago, short, for a badge: now, 4m, 2h, 3d
export function ago(at, now = Date.now()) {
  const m = Math.round((now - at) / MINUTE);
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}
// lasted(ms): how long, in words: 1 min, 47 min, 1 h 5 min, 3 h, 2 d
export function lasted(ms) {
  const m = Math.max(1, Math.round(ms / MINUTE));
  if (m >= 1440) return `${Math.floor(m / 1440)} d`;
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}
// glance(ms): a time ahead or a size, as a glance reads it: to the five minutes, then hours to the half, from ten
// hours whole hours: 5 min, 25 min, 1½ h, 11 h
export function glance(ms) {
  const m = Math.max(5, Math.round(ms / MINUTE / 5) * 5);
  if (m < 60) return `${m} min`;
  return m < 600 ? `${Math.round(m / 30) / 2} h`.replace('.5 h', '½ h') : `${Math.round(m / 60)} h`;
}
// clock(at): a time of day, 24-hour: 16:40 today, Thu 09:00 on another day
export function clock(at, { now = Date.now(), timeZone } = {}) {
  const time = parts(at, timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return dayOf(at, timeZone) === dayOf(now, timeZone) ? time : `${parts(at, timeZone, { weekday: 'short' })} ${time}`;
}
// fromNow(at): when something is due, from now: a glance within the day (25 min, 1½ h), then its day (Thu), and its
// date from six days on (Thu 29 Oct). A time already past reads as its clock time.
export function fromNow(at, { now = Date.now(), timeZone } = {}) {
  const ms = at - now;
  if (ms <= 0) return clock(at, { now, timeZone });
  if (ms >= 6 * 1440 * MINUTE) return parts(at, timeZone, { weekday: 'short', day: 'numeric', month: 'short' });
  return ms < 1440 * MINUTE ? glance(ms) : parts(at, timeZone, { weekday: 'short' });
}

const dayOf = (at, timeZone) => parts(at, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' });
const parts = (at, timeZone, options) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, ...options }).format(new Date(at)).replace(',', '');

// ---- the count
// countText(n): the count as shown: 1 to 99, then 99+; '' for none (the badge then hides)
export const countText = n => (n > COUNT_MAX ? `${COUNT_MAX}+` : n > 0 ? String(Math.floor(n)) : '');
// 5×7 pixel digits, for a pixel look: at badge size a UI font's 2, 3, 5, 6 and 8 can blur into one
const DIGITS = {
  0: '01110 10001 10011 10101 11001 10001 01110',
  1: '00100 01100 00100 00100 00100 00100 01110',
  2: '01110 10001 00001 00110 01000 10000 11111',
  3: '11110 00001 00001 01110 00001 00001 11110',
  4: '00010 00110 01010 10010 11111 00010 00010',
  5: '11111 10000 11110 00001 00001 10001 01110',
  6: '00110 01000 10000 11110 10001 10001 01110',
  7: '11111 00001 00010 00100 01000 01000 01000',
  8: '01110 10001 10001 01110 10001 10001 01110',
  9: '01110 10001 10001 01111 00001 00010 01100',
  '+': '00000 00100 00100 11111 00100 00100 00000',
};
// pixelDigits(text): an <svg> of the text's digits in pixels, 2 px a pixel
export function pixelDigits(text) {
  let path = '';
  [...text].forEach((char, i) =>
    DIGITS[char].split(' ').forEach((row, y) => {
      for (let x = 0; x < row.length; x++) if (row[x] === '1') path += `M${i * 6 + x} ${y}h1v1h-1z`;
    }),
  );
  const width = text.length * 6 - 1;
  return `<svg viewBox="0 0 ${width} 7" width="${width * 2}" height="14" aria-hidden="true"><path d="${path}"/></svg>`;
}

// ---- the pulse
// pulseMarks(n): a voice for each of n jobs running, three bars moving as one, each voice on a beat of its own, so where
// more runs, more moves; the beat is set from the clock, so a repaint carries its rhythm on instead of starting over.
// The page animates each voice's three .beat bars (BEAT_MS long, from its --at) and labels the whole. (HQ's projects
// view's voices)
export function pulseMarks(n, now = Date.now()) {
  return Array.from({ length: n }, (_, i) => {
    const at = (((now - i * BEAT_MS * BEAT_SPREAD) % BEAT_MS) + BEAT_MS) % BEAT_MS;
    return `<span class="voice" style="--beat: ${BEAT_MS}ms; --at: -${Math.round(at)}ms"><i class="beat"></i><i class="beat"></i><i class="beat"></i></span>`;
  }).join('');
}

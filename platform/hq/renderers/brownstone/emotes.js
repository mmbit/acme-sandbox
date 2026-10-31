// The emote over someone's head (world/emotes.js), as a pixel icon in a little speech bubble.
import { EMOTES, fade } from '../../world/emotes.js';
import { INK, F, text, textW } from './iso.js';

const PAPER = '#fffaf0';
// kind → rows of pixels (each letter a colour in INKS); a kind with none shows its glyph in the pixel font
const ART = {
  love: ['.rr.rr.', 'rrrrrrr', 'rrrrrrr', '.rrrrr.', '..rrr..', '...r...'],
  happy: ['.yyyyy.', 'yykykyy', 'yyyyyyy', 'ykyyyky', 'yykkkyy', '.yyyyy.'],
  celebrate: ['...o...', '..ooo..', 'ooooooo', '.ooooo.', '.oo.oo.', 'o.....o'],
  idea: ['.yyyy.', 'ywyyyy', 'yyyyyy', '.yyyy.', '..ss..', '..ss..'],
  question: ['.bbb.', 'b...b', '...b.', '..b..', '.....', '..b..'],
  thinking: ['.......', '.......', 'k..k..k', '.......'],
  sleepy: ['vvvvv', '...v.', '..v..', '.v...', 'vvvvv'],
};
const INKS = {
  r: '#ff5c8a',
  y: '#ffd966',
  k: INK,
  o: '#f2c14e',
  w: '#fff3b0',
  s: '#8b8fa3',
  b: '#5b8def',
  v: '#9b8fc4',
};
const ICON_H = 6; // the bubble fits an icon this many pixels tall

// Over each person drawn this frame (R.hits; not the head of someone coming up the stairs, a copy of them), above the
// name tag when they're the one picked out. It pops up a pixel as it fades in, and bobs.
export function drawEmotes(g, people, t, selected) {
  for (const A of people) {
    const a = fade(A.emote);
    if (!a || A.clipAbove) continue;
    const kind = A.emote.kind,
      art = ART[kind],
      glyph = !art && EMOTES[kind].glyph;
    const w = art ? art[0].length : textW(glyph),
      h = art ? art.length : 5;
    const bw = Math.max(9, w + 4),
      bh = ICON_H + 4,
      x = A.hit.sx - (bw >> 1);
    const y =
      A.hit.y0 - bh - 4 - (A === selected ? 11 : 0) - Math.round((1 - a) * 2) + Math.round(Math.sin(t * 3 + A.i));
    g.globalAlpha = a;
    F(g, x + 1, y, bw - 2, bh, INK);
    F(g, x, y + 1, bw, bh - 2, INK);
    F(g, x + 1, y + 1, bw - 2, bh - 2, PAPER);
    F(g, A.hit.sx - 1, y + bh, 3, 1, INK);
    F(g, A.hit.sx, y + bh - 1, 1, 2, PAPER);
    F(g, A.hit.sx, y + bh + 1, 1, 1, INK); // the tail
    const ix = x + ((bw - w) >> 1),
      iy = y + 2 + ((ICON_H - h) >> 1);
    if (glyph) text(g, glyph, ix, iy, EMOTES[kind].color);
    else
      art.forEach((row, v) =>
        [...row].forEach((c, u) => {
          if (c !== '.') F(g, ix + u, iy + v, 1, 1, INKS[c]);
        }),
      );
    g.globalAlpha = 1;
  }
}

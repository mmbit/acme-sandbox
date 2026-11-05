// A voice note's slip of paper under its words, one look wherever it's drawn: on the page (bookvoice.css, through the
// custom properties slipProperties gives the book), in the store's picture (the coordinator's ink/bookrender.ts) and
// on a canvas (bookpaperdraw.js).

// Its paper x round its words and y above and below them (page px), its corners' radius, its shadows (each y down,
// blurred by blur, grown by spread, in the shadow's ink at alpha, as CSS's box-shadow has them) and a strip of tape
// across the middle of its top, turned by tilt degrees
export const VOICE_SLIP = {
  ...{ x: 6, y: 4, paper: '#fffdf6', radius: 2 },
  shadow: {
    ink: '80, 60, 10',
    layers: [
      { y: 1, blur: 1, spread: 0, alpha: 0.16 },
      { y: 7, blur: 12, spread: -7, alpha: 0.4 },
    ],
  },
  tape: { w: 46, h: 13, tilt: -4, color: 'rgba(246, 236, 200, 0.8)' },
};

// A shadow's colour as CSS and a canvas take it
export const shadowColor = layer => `rgba(${VOICE_SLIP.shadow.ink}, ${layer.alpha})`;

// The slip's look as bookvoice.css reads it, custom property by property
export function slipProperties() {
  const { x, y, paper, radius, shadow, tape } = VOICE_SLIP;
  return {
    '--bk-voice-x': `${x}px`,
    '--bk-voice-y': `${y}px`,
    '--bk-voice-paper': paper,
    '--bk-voice-radius': `${radius}px`,
    '--bk-voice-shadow': shadow.layers.map(l => `0 ${l.y}px ${l.blur}px ${l.spread}px ${shadowColor(l)}`).join(', '),
    '--bk-voice-tape-w': `${tape.w}px`,
    '--bk-voice-tape-h': `${tape.h}px`,
    '--bk-voice-tape-tilt': `${tape.tilt}deg`,
    '--bk-voice-tape': tape.color,
  };
}

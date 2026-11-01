// Slate's colourways: which ones a company has, which one a device wears, and the logo drawn in it. Slate's scene.js
// wears them.
import { rgb, mix } from '../../util.js';
import { contrastChannels } from '../../../../shared/contrast/contrast.js';

// The company's colourways (theme/hq.yaml wire.colourways: id, name, ground, ink, muted, panel, accent, side,
// onAccent, as #hex), or a light and a dark one of Wire's own
export const WAY = ['ground', 'ink', 'muted', 'panel', 'accent', 'side', 'onAccent'];
const WIRE_WAYS = [
  {
    id: 'day',
    name: 'Day',
    ground: '#ece6da',
    ink: '#1d1b17',
    muted: '#5c554a',
    panel: '#f7f3ec',
    accent: '#d6ea3c',
    side: '#8f9f14',
    onAccent: '#1d1b17',
  },
  {
    id: 'night',
    name: 'Night',
    ground: '#15171c',
    ink: '#ece8e0',
    muted: '#a39e94',
    panel: '#20232a',
    accent: '#d6ea3c',
    side: '#7d8c10',
    onAccent: '#15171c',
  },
];
// theme: theme/hq.yaml, brandColour: brand.yaml's colour (#rrggbb, or undefined)
export const colourways = (theme, brandColour) => {
  const own = (theme.wire?.colourways ?? []).map(w => branded(w, brandColour));
  return own.length ? own : WIRE_WAYS;
};
// A colourway that sets no accent of its own wears the brand's colour (its logo's): its lip a shade darker, its letters
// black or white, whichever reads on it
const branded = (w, colour) => {
  if (w.accent !== undefined || colour === undefined) return w;
  const on =
    contrastChannels(rgb(colour), [0, 0, 0]) > contrastChannels(rgb(colour), [255, 255, 255]) ? '#000000' : '#ffffff';
  return { side: mix(colour, '#000000', 0.3), onAccent: on, ...w, accent: colour };
};

// The one a device wears: its own pick (an id, or 'auto'), else the first as dark as the device, else the first
export const pickColourway = (all, pick, dark) =>
  (pick !== 'auto' && all.find(w => w.id === pick)) || all.find(w => darkGround(w.ground) === dark) || all[0];

// a ground dark enough for light letters (its relative luminance)
export const darkGround = hex => {
  const [r, g, b] = (hex.length < 7 ? [...hex.slice(1, 4)].map(c => c + c) : hex.slice(1, 7).match(/../g)).map(
    c => parseInt(c, 16) / 255,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.4;
};

// The logo inline, after its picture, when it has a part in the accent: its parts drawn in the first colourway's
// accent, side and ink get the class logo-accent, logo-side or logo-ink, for the colourway in use to fill. Any other
// logo stays the picture it is (null).
export async function inlineLogo(img, first) {
  const text = img
      ? await fetch(img.src).then(
          r => (r.ok ? r.text() : ''),
          () => '',
        )
      : '',
    svg = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
  if (svg?.nodeName !== 'svg' || !img.isConnected) return null;
  for (const el of svg.querySelectorAll('script, foreignObject')) el.remove();
  for (const el of svg.querySelectorAll('[fill]')) {
    const part = ['accent', 'side', 'ink'].find(k => el.getAttribute('fill').toLowerCase() === first[k].toLowerCase());
    if (part) el.setAttribute('class', `logo-${part}`);
  }
  if (!svg.querySelector('.logo-accent')) return null;
  svg.setAttribute('class', 'logo');
  img.hidden = true;
  img.after(svg);
  return svg;
}

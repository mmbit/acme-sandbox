// The line-art style's palettes, as data: a drawing's colours and how it shades.
//
// ground: behind everything; ink: every line, dot and hatch; paper: a face that has no tone of its own (the line looks
// leave faces bare). accent and accentSide: the one shape where the picture's story is, and a cylinder's side under it.
// onAccent: a line drawn on the accent, where ink wouldn't read (ink if left out).
// shade: how faces turned from the light and shadows are shaded: 'dots', 'hatch' or 'flat'. tones (flat looks):
// a tone's [top, left, right] colours; a tone a palette leaves out is plain. shadow and pool: the flat looks' colours
// for a cast shadow and the ground under a scene (null: none). Any CSS colour goes, var(--x) included, in an SVG.

// One ink on white: a technical drawing's cutaway, hatched in the shade.
const blueprint = {
  id: 'blueprint',
  name: 'Blueprint',
  ground: '#ffffff',
  ink: '#2440a8',
  paper: '#ffffff',
  accent: '#c8d3f4',
  accentSide: '#97a8e6',
  shade: 'hatch',
};

// Even dark lines over flat fills in soft colours: periwinkle, mint and white on a light blue, trees on a green plate.
const soft = {
  id: 'soft',
  name: 'Soft colour',
  ground: '#e6f0fb',
  ink: '#2a2f45',
  paper: '#ffffff',
  accent: '#ff9b7a',
  accentSide: '#e0735a',
  shade: 'flat',
  tones: {
    plain: ['#ffffff', '#f0f3fa', '#dce3f0'],
    glass: ['#c3cdf7', '#a9b6f1', '#8f9fe8'],
    roof: ['#9aa9ec', '#8293e2', '#6c7dd4'],
    leaf: ['#b8ead0', '#9edfbd', '#82cfa6'],
    base: ['#b5e2b9', '#9bd3a1', '#83c18b'],
    skin: ['#ffffff', '#ffffff', '#ffffff'],
    dark: ['#2a2f45', '#2a2f45', '#2a2f45'],
  },
  shadow: '#c9d6ea',
  pool: null,
};

// Ink on a warm paper, dots in the shade, one shape in the accent.
const line = {
  id: 'line',
  name: 'Line and dots',
  ground: '#f4f1ea',
  ink: '#1f1d1a',
  paper: '#f4f1ea',
  accent: '#f2652a',
  accentSide: '#b9431b',
  shade: 'dots',
};

export const PALETTES = { soft, blueprint, line };

// A palette by its id, or a company's own: an object over the palette it names as base (line by default), so it
// sets only what differs.
export function paletteOf(chosen = 'soft') {
  if (typeof chosen === 'string') {
    if (!PALETTES[chosen]) throw new Error(`lineart: no palette called ${chosen}`);
    return PALETTES[chosen];
  }
  const base = paletteOf(chosen.base ?? 'line');
  return { ...base, ...chosen, tones: { ...base.tones, ...chosen.tones } };
}

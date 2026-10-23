// The reference sheet (reference.png): the palette with its lit and shaded steps, every place the kit draws, and its
// things and people, each at the one pixel size of a cover. Render: node shared/covers/render.mjs shared/covers/reference.js
// (the range of places, things and people, not one room)
const COLS = 3, GAP = 6, TOP = 26, CELL = 72 + 12;
export const size = [COLS * 128 + (COLS + 1) * GAP, TOP + 4 * CELL + 2];

export default (g, kit) => {
  const { R, C, W, H, lite, dark, text } = kit;
  R(g, 0, 0, size[0], size[1], C.ink);
  // the palette: each colour with its highlight (lite) above and its shade (dark) below
  Object.values(C).forEach((c, i) => { const x = GAP + i * 14; R(g, x, 6, 12, 4, lite(c)); R(g, x, 10, 12, 6, c); R(g, x, 16, 12, 4, dark(c)); });
  const panels = [
    ['ROOM', t => kit.room(t)],
    ['OUTDOORS', t => kit.outdoors(t, { time: 'dusk' })],
    ['STREET', t => kit.street(t)],
    ['ROOF', t => kit.roof(t, { time: 'night' })],
    ['PRINT FLOOR', t => kit.printFloor(t)],
    ['SKY', t => kit.sky(t, { time: 'day', seed: 'sheet' })],
    ['ABOVE: DESK', t => kit.above(t)],
    ['CUTAWAY', t => kit.cutaway(t, { rooms: 3, seed: 'sheet' })],
    ['WALL: BRICK', t => kit.wall(t, { kind: 'brick' })],
    ['THINGS', t => things(t, kit)],
    ['MORE THINGS', t => moreThings(t, kit)],
    ['PERSON FIGURE BUST', t => people(t, kit)],
  ];
  panels.forEach(([label, draw], i) => {
    const x = GAP + (i % COLS) * (W + GAP), y = TOP + (i / COLS | 0) * CELL;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    draw(c.getContext('2d'));
    g.drawImage(c, x, y);
    text(g, label, x, y + H + 3, C.mist);
  });
};

function things(g, { R, C, fg, van, parcel, printer, streetLamp, tree, shadow }) {
  R(g, 0, 0, 128, 72, C.cream); R(g, 0, 62, 128, 10, C.pave);
  shadow(g, 30, 64, 22); fg(g, g => van(g, 4, 66, { label: 'VAN' }));
  fg(g, g => parcel(g, 58, 50, 12, 12, { label: 'A' }));
  fg(g, g => printer(g, 74, 62));
  fg(g, g => streetLamp(g, 120, 62, { on: true }));
  fg(g, g => tree(g, 64, 34));
}

function moreThings(g, { R, C, fg, waterTower, telescope, moon, mug, map, pin, pencil, sheet, sign, plant, bird, star }) {
  R(g, 0, 0, 128, 72, C.cream);
  fg(g, g => waterTower(g, 4, 34));
  fg(g, g => telescope(g, 26, 34));
  R(g, 46, 4, 24, 26, C.night); fg(g, g => moon(g, 58, 17, 7, { crescent: true }));
  fg(g, g => mug(g, 78, 30)); fg(g, g => mug(g, 96, 22, { above: true }));
  fg(g, g => plant(g, 112, 34));
  fg(g, g => map(g, 4, 40, 40, 28)); fg(g, g => pin(g, 24, 54));
  fg(g, g => sheet(g, 50, 40, 16, 20)); fg(g, g => pencil(g, 48, 64, 22));
  fg(g, g => sign(g, 'SIGN', 76, 42));
  bird(g, 104, 44); star(g, 116, 46);
}

function people(g, { R, C, person, figure, bust, wall }) {
  wall(g, { kind: 'plain', c: C.paper }); R(g, 0, 62, 128, 10, C.woodL);
  person(g, 'ada', 6, 64);
  for (const [i, frame] of ['stand', 'walk', 'wave', 'carry'].entries()) figure(g, 'ben', 28 + i * 9, 64, { frame });
  bust(g, 'cleo', 80, 10);
}

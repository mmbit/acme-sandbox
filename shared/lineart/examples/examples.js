// Three drawings that show what the kit draws: a house cut away, an apartment block on its plate, a desk in a room.
// Each is a function that adds its items to a scene, back to front.

// A two-storey house cut open at the front: rooms on each floor, stairs, the roof cut away too.
export function house(s) {
  s.pool(5, 4, 8, 6.5);
  s.shadow([
    [10, 0],
    [13, 1.2],
    [13, 9.2],
    [10, 8],
  ]);
  s.room(0, 0, 0, 10, 8, 3, { windows: 2 });
  s.box(0.6, 0.6, 0, 3, 1, 0.9).box(0.6, 0.6, 0.9, 3, 1, 0.15); // a kitchen counter
  s.box(6, 0.4, 0, 3.2, 1.4, 0.5).box(6, 0.4, 0.5, 3.2, 0.4, 0.8); // a sofa
  s.box(6.3, 3, 0, 2.6, 1.6, 0.5); // the low table
  s.figure(4.5, 3.5, 0, { reach: [5.4, 3.2, 0.9] });
  s.figure(7.6, 1.4, 0, { pose: 'sit' });
  for (let i = 0; i < 6; i++) s.box(8.6, 4 + i * 0.6, 0, 1.2, 0.6, 0.5 * (i + 1)); // the stairs
  s.room(0, 0, 3.25, 10, 4.4, 2.8, { windows: 1 });
  s.box(1, 0.6, 3.25, 3.4, 2.4, 0.6).box(1, 0.6, 3.85, 0.4, 2.4, 0.8); // a bed
  s.figure(6.5, 2.4, 3.25, { accent: true });
  s.roof(0, 0, 6.05, 10, 4.4, 2.2, { ridge: 'x', cut: true });
  s.tree(12, 1, 0, 0.9).tree(-1.5, 9, 0, 0.7);
}

// A block of flats: three floors of windows on a green plate with trees, the front door in the accent.
export function apartments(s) {
  s.plate(-2, -2, 16, 14, 0.5);
  s.shadow([
    [9, 1],
    [12.5, 2.5],
    [12.5, 9.5],
    [9, 8],
  ]);
  for (let floor = 0; floor < 3; floor++) {
    const z = floor * 2.6;
    s.box(0, 0, z, 9, 8, 2.6);
    for (const u of [1.5, 4.5, 7.5])
      s.quad(
        [
          [u - 0.6, 8, z + 0.8],
          [u + 0.6, 8, z + 0.8],
          [u + 0.6, 8, z + 2],
          [u - 0.6, 8, z + 2],
        ],
        'left',
        { tone: 'glass' },
      );
    for (const v of [1.5, 4, 6.5])
      s.quad(
        [
          [9, v - 0.6, z + 0.8],
          [9, v + 0.6, z + 0.8],
          [9, v + 0.6, z + 2],
          [9, v - 0.6, z + 2],
        ],
        'right',
        { tone: 'glass' },
      );
  }
  s.box(-0.2, -0.2, 7.8, 9.4, 8.4, 0.35, { tone: 'roof' });
  s.box(1, 1, 8.15, 2, 2, 1).box(5.5, 4, 8.15, 2.6, 2.4, 0.6, { tone: 'glass' });
  s.quad(
    [
      [3.8, 8, 0],
      [5.2, 8, 0],
      [5.2, 8, 1.7],
      [3.8, 8, 1.7],
    ],
    'left',
    { accent: true },
  );
  s.tree(11.5, 2, 0, 1).tree(12.5, 6, 0, 0.8).tree(2, 11, 0, 0.9).tree(6.5, 11.2, 0, 0.7).tree(10.5, 10.5, 0, 1);
  s.figure(4.5, 9.6, 0).figure(8, 10, 0);
}

// A desk in the corner of a room, its screen the one accent.
export function desk(s) {
  s.pool(4, 3.5, 7, 5.5);
  s.room(-1.5, -1.5, 0, 10, 8.5, 5, { windows: 1 });
  for (const [x, y] of [
    [0.3, 0.3],
    [6.4, 0.3],
  ])
    s.box(x, y, 0, 0.3, 0.3, 2.3);
  s.box(0, 0, 2.3, 7, 3.8, 0.25);
  for (const [x, y] of [
    [0.3, 3.3],
    [6.4, 3.3],
  ])
    s.box(x, y, 0, 0.3, 0.3, 2.3);
  s.box(2.4, 0.8, 2.55, 2.8, 0.25, 1.8);
  s.quad(
    [
      [2.6, 1.05, 2.75],
      [5, 1.05, 2.75],
      [5, 1.05, 4.15],
      [2.6, 1.05, 4.15],
    ],
    'left',
    { accent: true },
  );
  s.box(0.6, 0.6, 2.55, 0.8, 0.8, 0.6).tree(1, 1, 3.15, 0.55);
  s.cylinder(5.9, 2.6, 2.55, 0.35, 0.55);
  s.box(2.6, 4.5, 0, 2.2, 2, 1.4);
  s.figure(3.7, 5.1, 0, { pose: 'sit', reach: [3.7, 2.6, 2.7] });
}

export const EXAMPLES = {
  house: { build: house, palette: 'blueprint', W: 1400, H: 1100, title: 'A two-storey house cut open at the front' },
  apartments: {
    build: apartments,
    palette: 'soft',
    W: 1400,
    H: 1100,
    title: 'A block of flats on a green plate with trees',
  },
  desk: { build: desk, palette: 'line', W: 1600, H: 900, title: 'A desk in the corner of a room, its screen lit' },
};

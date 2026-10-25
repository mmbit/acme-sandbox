// A drawing in the isometric line-art style, built in 3D: boxes, cylinders, balls, flat panels and lines, and the
// pieces made of them (rooms cut away, walls, roofs, base plates, trees, people).

// x runs to the lower right, y to the lower left, z up, in any unit the drawing likes. Items are drawn in the order
// they're added, so add them back to front: further back means smaller x + y.
export const scene = () => {
  const items = [];
  const add = item => (items.push(item), api);
  const api = {
    items,
    // A box from its far corner (x, y, z): w along x, d along y, h up. tone: the palette's tone for its faces.
    // accent: the one face filled with the accent (top | left | right).
    box: (x, y, z, w, d, h, o = {}) =>
      add({ kind: 'box', x, y, z, w, d, h, tone: o.tone ?? 'plain', accent: o.accent }),
    // An upright cylinder standing at (x, y, z). accent: its top in the accent and its side in the accent's side colour.
    cylinder: (x, y, z, r, h, o = {}) =>
      add({ kind: 'cylinder', x, y, z, r, h, tone: o.tone ?? 'plain', accent: o.accent }),
    ball: (x, y, z, r, o = {}) => add({ kind: 'ball', x, y, z, r, tone: o.tone ?? 'plain', accent: o.accent }),
    // A flat panel: its corners in 3D, and the face it lies like (top | left | right), which sets its shade.
    quad: (pts, face, o = {}) => add({ kind: 'quad', pts, face, tone: o.tone ?? 'plain', accent: o.accent }),
    // A line through points in 3D. thin: half the weight (lattices, mullions, hatching drawn by hand). onAccent: drawn
    // on the accent shape, in the palette's onAccent so it reads there.
    line: (pts, o = {}) => add({ kind: 'line', pts, thin: !!o.thin, onAccent: !!o.onAccent }),
    // A shadow cast on the ground at height z: its outline as [x, y] points.
    shadow: (pts, z = 0) => add({ kind: 'shadow', pts: pts.map(([x, y]) => [x, y, z]) }),
    // A pool of ground under a scene: an ellipse at height z, sparsely shaded.
    pool: (x, y, rx, ry, z = 0) => add({ kind: 'pool', pts: ellipse(x, y, rx, ry, z) }),
    // A base plate h thick, its top at z (the ground, 0, unless a room's floor slab is to stand on it)
    plate: (x, y, w, d, h = 0.4, o = {}) => api.box(x, y, (o.z ?? 0) - h, w, d, h, { tone: o.tone ?? 'base' }),
    room: (x, y, z, w, d, h, o = {}) => room(api, { x, y, z, w, d, h, ...o }),
    wall: (x, y, z, length, along, h, o = {}) => wall(api, { x, y, z, length, along, h, ...o }),
    roof: (x, y, z, w, d, h, o = {}) => roof(api, { x, y, z, w, d, h, ...o }),
    tree: (x, y, z = 0, r = 0.8, o = {}) =>
      api
        .line([
          [x, y, z],
          [x, y, z + r * 1.3],
        ])
        .ball(x, y, z + r * 1.6, r, { tone: o.tone ?? 'leaf' }),
    figure: (x, y, z = 0, o = {}) => figure(api, x, y, z, o),
  };
  return api;
};

// The size of a person, in the drawing's units, for placing furniture round them: a seat is SEAT up.
export const PERSON = { r: 0.3, body: 1.05, head: 0.34, seat: 0.75 };

// A room cut away: its floor, and the two far walls (along x at its back, along y at its left), the near side open.
// wall: the walls' thickness; floor: the slab's; windows: how many in each far wall, each with its cross.
function room(api, { x, y, z, w, d, h, wall: t = 0.2, floor = 0.25, windows = 0, tone = 'plain', floorTone = tone }) {
  api.box(x, y, z - floor, w, d, floor, { tone: floorTone });
  api.box(x, y, z, t, d, h, { tone }).box(x + t, y, z, w - t, t, h, { tone });
  const [low, high] = [z + h * 0.35, z + h * 0.8];
  for (let i = 0; i < windows; i++) {
    const share = (i + 0.5) / windows,
      u = y + d * share,
      v = x + w * share;
    pane(
      api,
      [
        [x + t, u - 0.5, low],
        [x + t, u + 0.5, low],
        [x + t, u + 0.5, high],
        [x + t, u - 0.5, high],
      ],
      'right',
    );
    pane(
      api,
      [
        [v - 0.5, y + t, low],
        [v + 0.5, y + t, low],
        [v + 0.5, y + t, high],
        [v - 0.5, y + t, high],
      ],
      'left',
    );
  }
  return api;
}
// a window: glass with a cross of mullions
function pane(api, pts, face) {
  const mid = (a, b) => a.map((v, i) => (v + b[i]) / 2);
  api.quad(pts, face, { tone: 'glass' });
  api
    .line([mid(pts[0], pts[1]), mid(pts[3], pts[2])], { thin: true })
    .line([mid(pts[0], pts[3]), mid(pts[1], pts[2])], { thin: true });
}

// A wall from (x, y, z) running length along 'x' or 'y', h high, t thick. door: a doorway's middle along it, from its
// start; windows: their middles along it. Both as distances from the wall's start.
function wall(api, { x, y, z, length, along, h, t = 0.2, door, windows = [], tone = 'plain' }) {
  const alongX = along === 'x';
  api.box(x, y, z, alongX ? length : t, alongX ? t : length, h, { tone });
  const face = alongX ? 'left' : 'right';
  const at = (u, v) => (alongX ? [x + u, y + t, z + v] : [x + t, y + u, z + v]);
  for (const u of windows)
    pane(api, [at(u - 0.4, h * 0.4), at(u + 0.4, h * 0.4), at(u + 0.4, h * 0.8), at(u - 0.4, h * 0.8)], face);
  if (door != null)
    api.quad([at(door - 0.45, 0), at(door + 0.45, 0), at(door + 0.45, h * 0.7), at(door - 0.45, h * 0.7)], face, {
      tone: 'dark',
    });
  return api;
}

// A gable roof over the box (x, y, z, w, d), its ridge h above z, running along 'x' or 'y', overhanging by over.
// cut: cut away like the rooms, only its far slope and the inside of its far gable.
function roof(api, { x, y, z, w, d, h, ridge = 'x', over = 0.2, tone = 'roof', cut = false }) {
  // drawn as if its ridge ran along x (u); along y, x and y swap places, and so do the left and right faces
  const alongX = ridge === 'x';
  const [u, v, length, span] = alongX ? [x, y, w, d] : [y, x, d, w];
  const [u0, u1, v0, v1, middle, top] = [u - over, u + length + over, v - over, v + span + over, v + span / 2, z + h];
  const quad = (face, faceTone, ...pts) =>
    api.quad(
      pts.map(([a, b, c]) => (alongX ? [a, b, c] : [b, a, c])),
      alongX || face === 'top' ? face : { left: 'right', right: 'left' }[face],
      { tone: faceTone },
    );
  quad('top', tone, [u0, v0, z], [u1, v0, z], [u1, middle, top], [u0, middle, top]);
  const gable = cut ? u : u + length;
  quad('right', 'plain', [gable, v, z], [gable, v + span, z], [gable, middle, top]);
  if (!cut) quad('left', tone, [u0, middle, top], [u1, middle, top], [u1, v1, z], [u0, v1, z]);
  return api;
}

// A person: a body and a head, standing or seated (pose 'sit': on a seat PERSON.seat up). tone: their clothes' tone;
// accent: the person in the accent; reach: a hand out to that point; lift: both arms up; mark: a little aerial.
function figure(api, x, y, z, { pose = 'stand', tone = 'plain', accent, reach, lift, mark } = {}) {
  const { r, body, head } = PERSON;
  const low = pose === 'sit' ? z + PERSON.seat - body * 0.35 : z;
  const tall = pose === 'sit' ? body * 0.8 : body;
  api.cylinder(x, y, low, r, tall, { tone, accent });
  const top = low + tall + head * 1.15;
  api.ball(x, y, top, head, { tone: 'skin' });
  if (mark)
    api
      .line([
        [x, y, top + head],
        [x, y, top + head + 0.3],
      ])
      .ball(x, y, top + head + 0.36, 0.07, { tone: 'dark' });
  if (reach) api.line([[x, y, low + tall * 0.85], reach]);
  if (lift)
    api
      .line([
        [x - 0.2, y + 0.2, low + tall * 0.85],
        [x - 0.3, y + 0.3, top + 0.9],
      ])
      .line([
        [x + 0.2, y - 0.2, low + tall * 0.85],
        [x + 0.3, y - 0.3, top + 0.9],
      ]);
  return api;
}

function ellipse(x, y, rx, ry, z) {
  const steps = 72;
  return Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * Math.PI * 2;
    return [x + rx * Math.cos(a), y + ry * Math.sin(a), z];
  });
}

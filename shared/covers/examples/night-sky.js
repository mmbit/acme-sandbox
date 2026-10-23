// The sky alone, no people: a full moon over the roofs and, among the stars, a constellation drawn as a present with
// its ribbon and bow. Let the idea be the picture when nobody needs to stand in it.
export default (g, { C, fg, sky, moon, star, line, lite }) => {
  sky(g, { time: 'night', seed: 'parcel-stars' });
  fg(g, g => moon(g, 104, 16, 9));
  // the constellation: a star at each corner and knot, faint lines between them
  const pts = { a: [28, 26], b: [64, 26], c: [64, 48], d: [28, 48], knot: [46, 26], foot: [46, 48], bowL: [36, 15], bowR: [56, 16] };
  const join = (p, q) => line(g, ...pts[p], ...pts[q], lite(C.plum2, 0.35));
  for (const pair of ['a knot', 'knot b', 'b c', 'c foot', 'foot d', 'd a', 'knot foot', 'knot bowL', 'knot bowR']) join(...pair.split(' '));
  for (const p of Object.values(pts)) star(g, ...p);
};

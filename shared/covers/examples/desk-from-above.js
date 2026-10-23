// A desk seen from above, no people: a map with a dotted route from one pin to another, a parcel waiting at the start,
// a mug and a pencil. A view from above suits plans, routes and anything laid out.
export default (g, { C, P, fg, above, map, pin, parcel, mug, pencil, sheet }) => {
  above(g, { surface: 'desk' });
  fg(g, g => map(g, 26, 8, 66, 50, { seed: 'route' }));
  // the route, dotted, from the pin on the coast to the one inland
  const route = [[44, 44], [48, 40], [52, 38], [56, 35], [60, 31], [64, 29], [68, 26], [72, 22], [76, 20]];
  for (const [x, y] of route) P(g, x, y, C.red);
  fg(g, g => { pin(g, 42, 46, C.teal); pin(g, 78, 18, C.red); });
  fg(g, g => parcel(g, 4, 40, 16, 14, { top: true, label: 'A' }));
  fg(g, g => mug(g, 108, 18, { above: true }));
  fg(g, g => sheet(g, 100, 36, 20, 26));
  fg(g, g => pencil(g, 74, 62, 24));
};

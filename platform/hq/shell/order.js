// The board's new order of one grid of tiles: the ids it sorted take the places they held in the whole order (every
// project's), and the others keep theirs. The coordinator keeps it (projectorder.ts) and dev mode stands in for it
// (data.js sortProjects).
export function placed(order, sorted) {
  const places = sorted.map(id => order.indexOf(id)).sort((a, b) => a - b),
    next = [...order];
  places.forEach((place, i) => (next[place] = sorted[i]));
  return next;
}

// The projects view's reads of the board and its sorts, kept apart: a load that a sort crossed may hold the old order,
// so it loads again once the new one is kept
import { loadProjects, sortProjects } from './data.js';

// one more as a grid's new order is sent and again once it's kept, and the orders sent and not yet kept
let sorts = 0;
const keeping = new Set();

export async function loadBoard(dev) {
  const asked = sorts,
    board = await loadProjects(dev);
  if (asked === sorts && !keeping.size) return board;
  await Promise.allSettled(keeping);
  return loadBoard(dev);
}
// A grid's new order (its keys' ids), kept by the coordinator for every device: the whole order, or it throws
export function keepOrder(dev, ids) {
  sorts++;
  const kept = sortProjects(dev, ids).finally(() => {
    keeping.delete(kept);
    sorts++;
  });
  keeping.add(kept);
  return kept;
}

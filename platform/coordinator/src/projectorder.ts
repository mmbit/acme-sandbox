// The board's order of the projects' tiles, which it sorts by dragging (POST /api/projects/order). Only its projects
// view follows it (projects.ts listProjectBoard).
import { remember, setting } from './db.ts';
import { projects } from './company.ts';
import { placed } from '../../hq/shell/order.js';

const ORDER_KEY = 'project_order';

// The projects in the board's order: those it has placed, then the rest in the order they come
export function inBoardOrder<P extends { id: string }>(list: P[]) {
  const order = boardOrder(list.map(p => p.id));
  return [...list].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

// The ids of one grid of tiles (a business's, or all of them) in the board's new order: they take the places they held
// among every project, in that order, and the others keep theirs. The answer is the whole order, or why not.
export function orderProjects(given: unknown): { order: string[] } | string {
  if (!Array.isArray(given)) return 'order is a list of project ids';
  const ids = projects().list.map(p => p.id);
  const stranger = given.find(id => !ids.includes(id));
  if (stranger !== undefined) return `${JSON.stringify(stranger)} isn't an open project, so it can't be ordered`;
  if (new Set(given).size < given.length) return 'order names each project once';
  const order = placed(boardOrder(ids), given);
  remember(ORDER_KEY, JSON.stringify(order));
  return { order };
}

// Every one of `ids` in the board's order: those it has placed, then the rest as they are
function boardOrder(ids: string[]) {
  const stored = JSON.parse(setting(ORDER_KEY) ?? '[]') as string[];
  const kept = stored.filter(id => ids.includes(id));
  return [...kept, ...ids.filter(id => !kept.includes(id))];
}

// The book's pages from the coordinator's store (book.ts), or in dev mode from mock/book.json, written in memory.
//   a day: { day, today, days: [{ day, pages }], pages: [summaries] }
//   a page read whole: its summary { id, day, kind, owner, url, call, label, w, h, ... } with ink: [strokes] and
//   scraps: [{ file, url, x, y, w, h, tilt }]
import { act, copy, get, refused } from './data.js';

export const loadDay = (dev, day) => (dev ? mockDay(day) : act(`/api/book${day ? `?day=${day}` : ''}`));
export const loadPage = (dev, id) => (dev ? mockPage(id) : act(`/api/book/page?id=${Number(id)}`));
// { kind: 'free', w, h }: a blank page, today's
export const createPage = (dev, body) => (dev ? mockCreate(body) : act('/api/book/page/new', body));
// { id, ink, scraps, h }
export const savePage = (dev, body) => (dev ? mockSave(body) : act('/api/book/page/save', body));

// A day as the store names it, YYYY-MM-DD, `ago` days before today here
export function dayOf(ago = 0, now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ago);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// (dev mode: mock/book.json's pages, each `ago` days old, so its days are always today and the ones before)
let mock = null;
async function state() {
  if (!mock) {
    const now = new Date().toISOString();
    mock = (await get('mock/book.json')).pages.map(({ ago, ...p }) => ({ ...p, day: dayOf(ago), created: now }));
    for (const p of mock) p.updated = now;
  }
  return mock;
}
const summary = ({ ink, scraps, ...p }) => ({ ...p, strokes: ink.length, pictures: scraps.length });
async function mockDay(day) {
  const pages = await state(),
    today = dayOf(),
    asked = day ?? today;
  const counts = Map.groupBy(pages, p => p.day);
  const days = [...counts.keys()].sort().reverse();
  return copy({
    day: asked,
    today,
    days: days.map(d => ({ day: d, pages: counts.get(d).length })),
    pages: pages.filter(p => p.day === asked).map(summary),
  });
}
async function mockPage(id) {
  const p = (await state()).find(p => p.id === Number(id));
  if (!p) throw refused(404, 'not found');
  return copy({ ...summary(p), ink: p.ink, scraps: p.scraps.map(s => ({ ...s, url: `mock/${s.file}` })) });
}
async function mockCreate({ kind, w, h }) {
  const pages = await state(),
    now = new Date().toISOString();
  const p = { id: Math.max(0, ...pages.map(p => p.id)) + 1, day: dayOf(), kind, owner: null, url: null, call: null };
  pages.push(Object.assign(p, { label: '', w, h, ink: [], scraps: [], created: now, updated: now }));
  return copy(summary(p));
}
async function mockSave({ id, ink, scraps, h }) {
  const p = (await state()).find(p => p.id === Number(id));
  if (!p) throw refused(404, 'not found');
  Object.assign(p, { ink, scraps, h, updated: new Date().toISOString() });
  return copy(summary(p));
}

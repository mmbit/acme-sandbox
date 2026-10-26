// The book's pages from the coordinator's store (book.ts), or in dev mode from mock/book.json, written in memory.
//   a day: { day, today, days: [{ day, pages }], pages: [summaries] }
//   a page read whole: its summary { id, day, kind, owner, url, call, label, w, h, ... } with ink: [strokes] and
//   scraps: [{ file, url, x, y, w, h, tilt }]
import { act, copy, get, refused } from './data.js';

// (who: an invited person's book the board has open, null for its own; people: everyone with a book of their own,
// { who, name, colour }.)
const whose = who => (who ? `&who=${encodeURIComponent(who)}` : '');
export const loadDay = (dev, day, who = null) =>
  dev ? mockDay(day, who) : act(`/api/book?day=${day ?? ''}${whose(who)}`);
export const loadPage = (dev, id, who = null) =>
  dev ? mockPage(id) : act(`/api/book/page?id=${Number(id)}${whose(who)}`);
// { kind: 'free', w, h, who? }: a blank page, today's
export const createPage = (dev, body) => (dev ? mockCreate(body) : act('/api/book/page/new', body));
// { id, ink, scraps, h, since, who? }: refused (409) when the page changed since (pagemerge.js)
export const savePage = (dev, body) => (dev ? mockSave(body) : act('/api/book/page/save', body));
export const loadPeople = dev => (dev ? get('mock/book-people.json') : act('/api/book/people'));

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
async function mockDay(day, who) {
  const pages = (await state()).filter(p => (p.who ?? null) === who),
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
async function mockCreate({ kind, w, h, who = null }) {
  const pages = await state(),
    now = new Date().toISOString();
  const p = {
    id: Math.max(0, ...pages.map(p => p.id)) + 1,
    who,
    day: dayOf(),
    kind,
    owner: null,
    url: null,
    call: null,
  };
  pages.push(Object.assign(p, { label: '', w, h, ink: [], scraps: [], created: now, updated: now }));
  return copy(summary(p));
}
async function mockSave({ id, ink, scraps, h }) {
  const p = (await state()).find(p => p.id === Number(id));
  if (!p) throw refused(404, 'not found');
  Object.assign(p, { ink, scraps, h, updated: new Date().toISOString() });
  return copy(summary(p));
}

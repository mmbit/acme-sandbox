// What the answers on the book's pages read and send, from the store's routes, or in dev mode (with no store) from
// mock/notebook-groups.json and mock/notebook-open.json, kept in memory.
//   GET /api/notebooks/pages/groups?page= → { page, groups: [group], tries?, tried? }: each group { id, box: { x, y, w,
//     h }, words, texts, ink, pictures, tries_page, waiting: null | { by, name, spot, style: 'text' | 'versions',
//     count? }, children }, a child an answer { kind: 'answer', id, by, name, style: 'text' | 'drawing' | 'form' |
//     'question' | 'version', text, picture, ink, form, form_answer, version, spot: { dx, dy, w, h, narrow? } | null,
//     ticked, picked, created } or a reply { kind: 'reply', answers, ink, box }. A versions page has tries (the group
//     tried) and tried (that group, as above).
//   GET /api/notebooks/open → { forms: [item], questions: [item] }, an item { id, group, page, notebook, day, by, name,
//     text, created }.
//   POST /api/notebooks/groups/reply { answer, ink, frame? } (frame: where a version's picture shows, page px), POST /api/notebooks/answers/form { id, answers }.
import { act, copy, get } from '../data.js';

// A page's groups; null when it isn't a notebook page (the store has none of it)
export const loadGroups = (dev, page) =>
  read(dev, `/api/notebooks/pages/groups?page=${Number(page)}`, () => mockGroups(page));
export const loadOpen = dev => read(dev, '/api/notebooks/open', mockOpen);
export const sendReply = (dev, answer, ink, frame = null) =>
  sent(dev, '/api/notebooks/groups/reply', { answer, ink, ...(frame ? { frame } : {}) }, () => mockReply(answer, ink));
export const sendForm = (dev, id, answers) =>
  sent(dev, '/api/notebooks/answers/form', { id, answers }, () => mockForm(id, answers));

// The route read plainly, so a check can stand in for it; in dev mode, where nothing answers it, the mock
async function read(dev, url, mocked) {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (res.ok) return res.json();
  if (dev) return mocked();
  if (res.status === 404) return null;
  if (res.status === 401) location.href = '/login';
  throw new Error(`The answers can’t be read (error ${res.status})`);
}

// The route posted to; in dev mode, where nothing answers it, the mock
const sent = (dev, url, body, mocked) =>
  act(url, body).catch(e => (dev && e.status === 404 ? mocked() : Promise.reject(e)));

// ---- dev mode
let mock = null;
const state = async () =>
  (mock ??= { groups: await get('mock/notebook-groups.json'), open: await get('mock/notebook-open.json') });
async function mockGroups(page) {
  const pages = (await state()).groups;
  return pages[page] ? copy(pages[page]) : null;
}
const mockOpen = async () => copy((await state()).open);
// Every answer child with this id, on any page (a versions page holds its group's copy too)
async function answersOf(id) {
  const { groups } = await state(),
    all = Object.values(groups).flatMap(p => [...p.groups, ...(p.tried ? [p.tried] : [])]);
  return all.flatMap(g => g.children.filter(c => c.kind === 'answer' && c.id === id).map(a => ({ g, a })));
}
async function mockReply(answer, ink) {
  const found = await answersOf(answer);
  if (!found.length) throw new Error('That answer is gone.');
  const id = Date.now(),
    created = new Date().toISOString();
  for (const { g } of found) g.children.push({ kind: 'reply', id, answers: answer, ink, created });
  return { id, parent: found[0].g.id };
}
async function mockForm(id, answers) {
  const found = await answersOf(id);
  if (!found.length) throw new Error('That form is gone.');
  for (const { a } of found) a.form_answer = answers;
  const m = await state();
  m.open.forms = m.open.forms.filter(f => f.id !== id);
  return { id };
}

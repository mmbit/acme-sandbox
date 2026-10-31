// The Notebook's store as the book reads and writes it: the coordinator's routes (knowledge/notes/platform/notebook.md:
// notebook.ts, notebookgroups.ts, notebooksend.ts), or in dev mode the same routes played in memory on
// mock/notebook.json (notebookplay.js), with the same answers and refusals. Every change there is a `book` event with
// text `notebook` and its page; dev mode's are book:notebook on the document straight away, as events.js passes the
// store's on.
import { copy, get, refused } from '../data.js';
import { notebookRequest } from './bookscope.js';
import { notebookPlay } from './notebookplay.js';
import { pagePicture } from './notebookpicture.js';

// GET when there's no body
export async function ask(dev, path, query = null, body = undefined) {
  const url = query ? `${path}?${new URLSearchParams(query)}` : path;
  if (!dev) return notebookRequest(url, body);
  const play = await played();
  try {
    return pictured(copy(play.route(path, new URLSearchParams(query ?? {}), body)));
  } catch (e) {
    throw refused(e.status ?? 0, e.message, e.reason);
  }
}

// ---- the notebooks and their pages

// { shelf, archive }, My journal first; each notebook with its cover (an address, or null) and news (its new answers)
export const loadShelf = dev => ask(dev, '/api/notebooks');
// A notebook's cover: a picture's data URL
export const setCover = (dev, id, picture) => ask(dev, '/api/notebooks/cover', null, { id, picture });
// { notebook, pages, archived } in the notebook's order (dev mode draws each page's picture: notebookpicture.js)
export async function loadPages(dev, notebook) {
  const read = await ask(dev, '/api/notebooks/pages', { notebook });
  if (dev)
    await Promise.all(
      [...read.pages, ...read.archived].map(async p => {
        p.picture = await pagePicture(p, async () => (await loadGroups(dev, p.id)).groups);
      }),
    );
  return read;
}
export const archiveNotebook = (dev, id, archived) => ask(dev, '/api/notebooks/archive', null, { id, archived });
export const createPage = (dev, notebook) => ask(dev, '/api/notebooks/pages/create', null, { notebook });
export const orderPages = (dev, notebook, pages) => ask(dev, '/api/notebooks/pages/order', null, { notebook, pages });
export const archivePage = (dev, id, archived) => ask(dev, '/api/notebooks/pages/archive', null, { id, archived });
export const titlePage = (dev, id, title) => ask(dev, '/api/notebooks/pages/title', null, { id, title });
export const zoomPage = (dev, id, shape, zoom) => ask(dev, '/api/notebooks/pages/zoom', null, { id, shape, zoom });
// A page sent: the board's at once (aside: the groups with asks still open, moved to a new page first), an invited
// person's with its 10 seconds to undo, or taken back in them (their Undo): the page, sending, then sent. (aside:
export const sendPage = (dev, id, aside = []) =>
  ask(dev, '/api/notebooks/pages/send', null, { id, ...(aside.length && { aside }) });
export const undoSend = (dev, id) => ask(dev, '/api/notebooks/pages/undo', null, { id });

// A review round closed from the Shelf (anyway: though asks are still open, refused 409 without it), wrapped and away
// to the CEO; one back unwrapped: its round, as the Shelf lists it (notebook.round).
export const closeRound = (dev, id, anyway = false) =>
  ask(dev, '/api/notebooks/round/close', null, { id, ...(anyway && { anyway: true }) });
export const unwrapRound = (dev, id) => ask(dev, '/api/notebooks/round/unwrap', null, { id });

// ---- a page's groups

// { page, notebook, title, groups }, each group with its box and its children (answers and replies)
export const loadGroups = (dev, page) => ask(dev, '/api/notebooks/pages/groups', { page });
// parts: { ink, texts, pictures } as the store keeps them
export const createGroup = (dev, page, parts) => ask(dev, '/api/notebooks/groups/create', null, { page, ...parts });
// since: the group's updated as this screen read it; one changed since is refused (409)
export const editGroup = (dev, id, since, parts) =>
  ask(dev, '/api/notebooks/groups/edit', null, { id, since, ...parts });
// To the page's end, or right after unit after there ('start': its first).
export const moveGroup = (dev, id, page, after) => ask(dev, '/api/notebooks/groups/move', null, { id, page, after });
export const deleteGroup = (dev, id) => ask(dev, '/api/notebooks/groups/delete', null, { id });
export const restoreGroup = (dev, id) => ask(dev, '/api/notebooks/groups/restore', null, { id });
// Whom a scrap can be handed to: { recent, everyone }, each person { to, name, kind } (bookassign.js)
export const loadPeople = dev => ask(dev, '/api/notebooks/people');
// A group handed to a person (their to) → { group, to }; it stays where it is, wearing their tag
export const assignGroup = (dev, id, to) => ask(dev, '/api/notebooks/groups/assign', null, { id, to });
// A reply under an agent's answer (a slip's id) → { id, parent }; taken back in its seconds
export const reply = (dev, answer, words) => ask(dev, '/api/notebooks/groups/reply', null, { answer, words });
export const deleteReply = (dev, id) => ask(dev, '/api/notebooks/replies/delete', null, { id });
// An agent's desk-phone card under a group answered, through the desk phone's own route: one answer closes both.
// answers: its questions' (questions.js).
export const answerAsk = (dev, id, answer, answers) =>
  ask(dev, '/api/requests/answer', null, { id, answer, secrets: {}, ...(answers && { answers }) });

// A picture for a group on a page: { file, url }
export async function keepPicture(dev, page, blob) {
  if (!dev) return notebookRequest(`/api/notebooks/pictures?page=${Number(page)}`, blob);
  const kept = await ask(
    dev,
    '/api/notebooks/pictures',
    { page },
    { bytes: await blob.arrayBuffer(), type: blob.type },
  );
  devUrls.set(kept.file, URL.createObjectURL(blob));
  return { ...kept, url: devUrls.get(kept.file) };
}

// ---- dev mode

let play = null;
const played = () =>
  (play ??= get('mock/notebook.json').then(seed => {
    const p = notebookPlay({ seed });
    p.listen(detail => setTimeout(() => document.dispatchEvent(new CustomEvent('book:notebook', { detail }))));
    return p;
  }));
// (a picture's address in dev mode: one kept this visit is this browser's, a mock one is mock/'s)
const devUrls = new Map();
const devUrl = file => devUrls.get(file) ?? `mock/${file}`;
function pictured(v) {
  if (Array.isArray(v)) return v.map(pictured);
  if (!v || typeof v !== 'object') return v;
  for (const k of Object.keys(v)) v[k] = pictured(v[k]);
  if (typeof v.file === 'string' && 'url' in v) v.url = devUrl(v.file);
  return v;
}

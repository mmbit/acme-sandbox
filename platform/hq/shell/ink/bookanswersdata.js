// What the answers on the book's pages read and send, from the store's routes, or in dev mode played with the rest of
// the Notebook (notebookdata.js, on mock/notebook.json.).
//   GET /api/notebooks/pages/groups?page= → { page, groups: [group] }: each group { id, box: { x, y, w, h }, words,
//     texts, ink, pictures, waiting: null | { by, name, spot, style: 'text' }, try: null | { state: 'coming' | 'made' |
//     'empty', expect, by, name, reason }, children }, a child an answer { kind: 'answer', id, by, name, style: 'text' |
//     'drawing' | 'form' | 'question' | 'version', text, picture, link, ink, form, form_answer, version, branch,
//     spot: { dx, dy, w, h, narrow? } | null, ticked, picked, crossed, cleared, created } or a reply { kind: 'reply',
//     answers, ink, box, frame? }.
//   GET /api/notebooks/open → { forms: [item], questions: [item] }, an item { id, group, page, notebook, day, by, name,
//     text, created }.
//   POST /api/notebooks/groups/reply { answer, ink, frame? } (frame: where a version's picture shows, page px), POST /api/notebooks/answers/form { id, answers }.
import { ask } from './notebookdata.js';

// The route read as the rest of the Notebook reads it (in dev mode the play's); a page that isn't the store's is null
const read = (dev, path, query = null) =>
  ask(dev, path, query).catch(e => (e.status === 404 ? null : Promise.reject(e)));

// A page's groups; null when it isn't a notebook page (the store has none of it)
export const loadGroups = (dev, page) => read(dev, '/api/notebooks/pages/groups', { page: Number(page) });
export const loadOpen = dev => read(dev, '/api/notebooks/open');
export const sendReply = (dev, answer, ink, frame = null) =>
  ask(dev, '/api/notebooks/groups/reply', null, { answer, ink, ...(frame ? { frame } : {}) });
export const sendForm = (dev, id, answers) => ask(dev, '/api/notebooks/answers/form', null, { id, answers });

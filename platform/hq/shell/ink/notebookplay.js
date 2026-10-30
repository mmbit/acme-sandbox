// The Notebook's store played in memory: every route of the coordinator's (notebook.ts, notebookgroups.ts,
// notebooksend.ts, notebookpictures.ts) with the same answers and refusals, for dev mode (notebookdata.js, on
// mock/notebook.json) and book-check's stand-in. No DOM: the browser and node import it alike. The board's own
// notebooks only, every route the board's session.
//   - seed: { notebooks, pages, groups, slips, asks, names } as the store keeps them, a group's ink, texts, pictures and
//     anchor as values, not JSON; asks: the agents' desk-phone cards about a note, as bookasks.ts's asksOn lists them,
//     each with its note (asks). names: an agent's name by id, for a scrap's
//     owner_name. A page's send_at is in ms (a seeded sent page's: some time gone). No seed: My Notebook with one blank
//     page.
//   - now(): the time in ms (a story's clock). sendMs: a send's time to undo (notebooksend.ts's SEND_MS).
//   - A page's picture is null here: in dev mode the browser draws it (notebookpicture.js).
import { inkOf, labelOf, pictureOf, refuse, wordsOf } from './notebookplaychecks.js';
import { boxOf, landingPage } from './notebookstack.js';
import { BOARD, GROUP_ROUTES, groupOf, insertGroup, keepPicture, pictureUrl, putAside } from './notebookplaygroups.js';
import { search } from './notebookplaysearch.js';
import { SCREEN_SHAPES } from './booklayout.js';
import { ZOOM_KEPT } from './bookrow.js';

// The size a new page starts at (notebook.ts NEW_PAGE)
const NEW_PAGE = { w: 1200, h: 1600 };
const MAX_BYTES = 3.5 * 1024 * 1024;
// What a seeded page or group is unless it says otherwise
const PAGE = { kind: 'free', label: '', archived: false, send_at: null, fresh: null, x: 0, y: 0 };
const GROUP = { parent: null, answers: null, by: BOARD, ink: [], texts: [], pictures: [], anchor: null, words: '' };
Object.assign(GROUP, { said: null, owner: null, status: 'open', note: null, deleted: null });

export function notebookPlay({ seed, now = () => Date.now(), sendMs = 10_000 } = {}) {
  const s = store(seed, now, sendMs);
  return {
    // A route answered: path ('/api/notebooks/...'), query (URLSearchParams or a plain object), body (a POST's JSON;
    // a picture's POST, { bytes: ArrayBuffer or Uint8Array, type }; none: a GET). A JSON-safe copy (a picture's GET:
    // { bytes, type }); a refusal throws an Error with .status and the coordinator's words.
    route: (path, query = {}, body = undefined) => routed(s, path, query, body),
    // An agent's answer on a sent group's note (group: its id): a slip as bookslips.ts's slipsOf lists it ({ by, text,
    // name?, picture?, link?, preview? }), its id and note filled in. → the slip
    answer(group, slip) {
      const g = s.group(Number(group));
      if (!g?.note) throw new Error(`group ${group} hasn't been sent: only a sent group's note is answered`);
      const answered = {
        ...{ picture: null, link: null, preview: null, now: null, now_at: null, ticked: null, text: '' },
        ...slip,
        id: s.next('slip'),
        note: g.note,
        name: slip.name ?? s.names[slip.by] ?? slip.by,
        created: s.stamp(),
      };
      s.slips.push(answered);
      s.changed(s.page(g.page).notebook, g.page);
      return JSON.parse(JSON.stringify(answered));
    },
    // An agent's desk-phone card about a sent group's note (group: its id), as bookasks.ts's asksOn lists it ({ agent,
    // kind, title, body, questions? }), its id, note and name filled in. → the card.
    ask: (group, card) => askAbout(s, group, card),
    // An agent's note on a page (a call agent's scrap or typed words: ink/callnotes.ts), by: the agent's id; parts:
    // { ink, texts, pictures }. → the group
    note: (page, by, parts) =>
      inHand(s, by, () => copy(insertGroup(s, s.page(Number(page)), 'scrap', by, { ...EMPTY, ...parts }))),
    // The board's routes as a call's agent works the page through them (ink/callpage.ts): its changes counted on the
    // page as made by its hand (notebook.ts byHand)
    by: (agent, path, body) => inHand(s, agent, () => routed(s, path, {}, body)),
    // fn({ notebook, page }) after every change, as the coordinator's `book` event with text `notebook` (page null: a
    // notebook's order)
    listen(fn) {
      s.listeners.push(fn);
      return () => (s.listeners = s.listeners.filter(f => f !== fn));
    },
    // A picture uploaded this session: { bytes, type }, or null (a seeded one's file is mock/'s)
    picture: file => s.files.get(file) ?? null,
  };
}

// ---------------------------------------------------------------- the store's state
function store(seed, now, sendMs) {
  const at = { notebook: 0, page: 0, group: 0, slip: 0, ask: 0, note: 0, file: 0 };
  const s = {
    now,
    sendMs,
    notebooks: (seed?.notebooks ?? []).map(n => ({ who: BOARD, archived: false, ...n })),
    pages: (seed?.pages ?? []).map(p => ({ ...PAGE, ...p })),
    groups: (seed?.groups ?? []).map(g => ({ ...GROUP, ...g })),
    slips: [...(seed?.slips ?? [])],
    asks: [...(seed?.asks ?? [])],
    names: { ...seed?.names },
    // a note's time to go (ms), by its id: one seeded is long gone
    notes: new Map(),
    // the pictures uploaded (a seeded group's files: null, mock/'s)
    files: new Map(),
    listeners: [],
    next: kind => ++at[kind],
    // (a time no change before it had: an edit's since tells two apart even on a story's still clock)
    last: 0,
    stamp() {
      s.last = Math.max(s.now(), s.last + 1);
      return new Date(s.last).toISOString();
    },
    notebook: id => s.notebooks.find(n => n.id === id),
    page: id => s.pages.find(p => p.id === id),
    group: id => s.groups.find(g => g.id === id),
    shut: p => p.send_at !== null,
    gone: p => p.send_at !== null && p.send_at <= s.now(),
    noteGone: id => (s.notes.get(id) ?? 0) <= s.now(),
    mine: () => s.notebooks.find(n => n.kind === 'mine') ?? s.notebook(makeNotebook(s, 'mine', 'My Notebook')),
    currentPage: id => currentPage(s, id),
    newPage: id => newPage(s, id),
    changed: (notebook, page) => changed(s, notebook, page),
    ours: file => s.files.has(file),
  };
  for (const kind of ['notebooks', 'pages', 'groups', 'slips', 'asks'])
    for (const row of s[kind]) at[kind.slice(0, -1)] = Math.max(at[kind.slice(0, -1)], row.id);
  for (const g of s.groups) {
    at.note = Math.max(at.note, g.note ?? 0);
    for (const c of g.pictures ?? []) s.files.set(c.file, null);
  }
  if (!s.notebooks.some(n => n.kind === 'mine')) s.mine();
  return s;
}
function makeNotebook(s, kind, name) {
  const id = s.next('notebook'),
    now = s.stamp();
  s.notebooks.push({ id, who: BOARD, kind, name, archived: false, created: now, updated: now });
  return id;
}
// The page new groups land on (notebookstack.js), made if there's none (notebook.ts currentPage and openPageOf)
const currentPage = (s, notebook) => openPageOf(s, notebook) ?? newPage(s, notebook);
const openPageOf = (s, notebook) =>
  landingPage(
    s.pages.filter(p => p.notebook === notebook),
    s.shut,
  )?.id ?? null;
function newPage(s, notebook) {
  const id = s.next('page'),
    now = s.stamp(),
    pos = Math.max(-1, ...s.pages.filter(p => p.notebook === notebook).map(p => p.pos)) + 1;
  s.pages.push({ id, notebook, pos, send_at: null, fresh: null, kind: 'free', label: '', archived: false });
  Object.assign(s.page(id), { created: now, updated: now, x: 0, y: 0, ...NEW_PAGE });
  changed(s, notebook, id);
  return id;
}
// A page has changed: its box grows round its groups, its notebook moves up the shelf, and every screen showing it
// reads it again
function changed(s, notebook, page) {
  const now = s.stamp();
  const p = page && s.page(page);
  if (p) {
    const on = s.groups.filter(g => g.page === p.id && g.deleted === null);
    const round = boxOf({
      ink: on.flatMap(g => g.ink),
      texts: on.flatMap(g => g.texts),
      pictures: on.flatMap(g => g.pictures),
    });
    const x = Math.min(p.x, round?.x ?? p.x),
      y = Math.min(p.y, round?.y ?? p.y);
    const w = Math.max(p.x + p.w, round ? round.x + round.w : 0) - x,
      h = Math.max(p.y + p.h, round ? round.y + round.h : 0) - y;
    Object.assign(p, { updated: now, x: Math.floor(x), y: Math.floor(y), w: Math.ceil(w), h: Math.ceil(h) });
  }
  s.notebook(notebook).updated = now;
  // (counted, as notebook.ts byHand's: someone else's change, which a screen's read takes as a step of its own)
  if (p && s.hand) p.handed = (p.handed ?? 0) + 1;
  for (const fn of [...s.listeners]) fn({ notebook, page: page ?? null });
}
function routed(s, path, query, body) {
  const handler = ROUTES[`${body === undefined ? 'GET' : 'POST'} ${path}`] ?? (() => refuse(404));
  const q = query instanceof URLSearchParams ? Object.fromEntries(query) : { ...query };
  const answer = handler(s, body === undefined ? q : body, q);
  return path === '/api/notebooks/pictures' && body === undefined ? answer : JSON.parse(JSON.stringify(answer));
}
const EMPTY = { ink: [], texts: [], pictures: [] },
  copy = x => JSON.parse(JSON.stringify(x));
function inHand(s, hand, act) {
  s.hand = hand;
  try {
    return act();
  } finally {
    s.hand = null;
  }
}

// ---------------------------------------------------------------- notebooks, pages, sending
// A route's handler for its 'METHOD path': (s, the body or a GET's query, the query)
const ROUTES = {
  'GET /api/notebooks': listNotebooks,
  'POST /api/notebooks/archive': archiveNotebook,
  'GET /api/notebooks/pages': listPages,
  'POST /api/notebooks/pages/create': (s, b) => pageOf(s, s.page(s.newPage(notebookRow(s, b?.notebook).id))),
  'POST /api/notebooks/pages/order': orderPages,
  'POST /api/notebooks/pages/archive': (s, b) => pageChanged(s, b, p => (p.archived = archived(b.archived))),
  'POST /api/notebooks/pages/title': (s, b) => pageChanged(s, b, p => (p.label = labelOf(b?.title))),
  'POST /api/notebooks/pages/zoom': zoomPage,
  'POST /api/notebooks/pages/send': (s, b) => pageOf(s, sendPage(s, pageRow(s, b?.id))),
  'POST /api/notebooks/pages/undo': (s, b) => pageOf(s, undoSend(s, pageRow(s, b?.id))),
  'GET /api/notebooks/pages/groups': listGroups,
  ...GROUP_ROUTES,
  'POST /api/notebooks/groups/reply': replyTo,
  'POST /api/notebooks/replies/delete': deleteReply,
  'POST /api/notebooks/pictures': uploadPicture,
  'GET /api/notebooks/pictures': (s, q) => (s.files.get(q.file) ? { ...s.files.get(q.file) } : refuse(404)),
  'GET /api/book/search': search,
  'POST /api/requests/answer': answerAsk,
};
function askAbout(s, group, card) {
  const g = s.group(Number(group));
  if (!g?.note) throw new Error(`group ${group} hasn't been sent: only a sent group's note is asked about`);
  const asked = {
    ...{ questions: null, page: null, status: 'open', answer: null, answered: null },
    ...card,
    id: s.next('ask'),
    note: g.note,
    name: card.name ?? s.names[card.agent] ?? card.agent,
  };
  s.asks.push(asked);
  s.changed(s.page(g.page).notebook, g.page);
  return JSON.parse(JSON.stringify(asked));
}
// The desk phone's answer to a card (jobs.ts answerRequest), for one under a group: answered, its group's page read
// again. Its questions all answered first (an optional one may be blank), as the desk phone's own route refuses.
function answerAsk(s, b) {
  const a = s.asks.find(x => x.id === Number(b?.id) && x.status === 'open');
  if (!a) refuse(404);
  if ((a.questions ?? []).some((q, k) => !q.optional && !String(b.answers?.[k] ?? '').trim()))
    refuse(400, 'a question still needs its answer');
  Object.assign(a, { status: 'answered', answer: String(b.answer ?? ''), answered: s.stamp() });
  const g = s.groups.find(x => x.note === a.note);
  if (g) s.changed(s.page(g.page).notebook, g.page);
  return { ok: true };
}
function listNotebooks(s) {
  s.mine();
  const all = [...s.notebooks].sort(
    (a, b) => (b.kind === 'mine') - (a.kind === 'mine') || b.updated.localeCompare(a.updated) || b.id - a.id,
  );
  const shelf = all.filter(n => !n.archived).map(n => notebookOf(s, n)),
    archive = all.filter(n => n.archived).map(n => notebookOf(s, n));
  return { shelf, archive };
}
function archiveNotebook(s, b) {
  const n = notebookRow(s, b?.id),
    to = archived(b.archived);
  if (n.kind === 'mine') refuse(409, 'My Notebook stays on the shelf');
  Object.assign(n, { archived: to, updated: s.stamp() });
  return notebookOf(s, n);
}
function listPages(s, b) {
  const n = notebookRow(s, b?.notebook);
  s.currentPage(n.id);
  const pages = pagesOf(s, n.id);
  return {
    notebook: notebookOf(s, n),
    pages: pages.filter(p => !p.archived).map(p => pageOf(s, p)),
    archived: pages.filter(p => p.archived).map(p => pageOf(s, p)),
  };
}
function orderPages(s, b) {
  const n = notebookRow(s, b?.notebook),
    ids = Array.isArray(b.pages) ? b.pages.map(Number) : [],
    now = pagesOf(s, n.id).map(p => p.id);
  if (ids.length !== now.length || new Set(ids).size !== ids.length || !ids.every(i => now.includes(i)))
    refuse(400, "pages is every one of the notebook's pages, once each, in their new order");
  ids.forEach((i, pos) => (s.page(i).pos = pos));
  s.changed(n.id, null);
  return listPages(s, { notebook: n.id });
}
// (the zoom the board left a page at, by the book's shape: no change to the page, notebook.ts zoomPage)
function zoomPage(s, b) {
  const p = pageRow(s, b?.id),
    zoom = Number(b?.zoom);
  if (!SCREEN_SHAPES.includes(b?.shape)) refuse(400);
  if (!(zoom >= ZOOM_KEPT.least && zoom <= ZOOM_KEPT.most)) refuse(400);
  p.zooms = { ...p.zooms, [b.shape]: Math.round(zoom * 1000) / 1000 };
  return pageOf(s, p);
}
// A page archived or titled: change(p) does it
function pageChanged(s, b, change) {
  const p = pageRow(s, b?.id);
  change(p);
  s.changed(p.notebook, p.id);
  return pageOf(s, p);
}
function listGroups(s, q) {
  const p = pageRow(s, q?.page),
    on = s.groups.filter(g => g.page === p.id && g.deleted === null).sort((a, b) => a.id - b.id);
  const replies = on.filter(g => g.parent !== null);
  return {
    page: p.id,
    notebook: p.notebook,
    title: p.label,
    handed: p.handed ?? 0,
    groups: on.filter(g => g.parent === null).map(g => groupOf(s, g, replies)),
  };
}
// Each open group of a page goes as its own note, in sendMs; a fresh page takes new groups at once
function sendPage(s, p) {
  if (s.shut(p)) refuse(409, 'this page has been sent');
  const groups = s.groups.filter(
    g => g.page === p.id && g.parent === null && g.deleted === null && g.status === 'open',
  );
  if (!groups.length) refuse(409, 'nothing on this page to send');
  const at = s.now() + s.sendMs;
  for (const g of groups) {
    g.note = s.next('note');
    g.status = 'sent';
    s.notes.set(g.note, at);
  }
  p.send_at = at;
  // (a fresh page only when no other is open, or under the last page, notebooksend.ts)
  const kept = pagesOf(s, p.notebook).filter(o => !o.archived);
  p.fresh = openPageOf(s, p.notebook) !== null && kept.at(-1) !== p ? null : s.newPage(p.notebook);
  s.changed(p.notebook, p.id);
  return p;
}
// A send taken back in its time: the page open again, the fresh page gone while it's blank and untitled
function undoSend(s, p) {
  if (p.send_at === null) refuse(409, "this page hasn't been sent");
  if (s.gone(p)) refuse(409, 'too late to undo: the page has gone');
  for (const g of s.groups.filter(x => x.page === p.id && x.parent === null && x.note !== null)) {
    if (s.noteGone(g.note)) continue;
    s.notes.delete(g.note);
    Object.assign(g, { status: 'open', note: null });
  }
  const fresh = s.page(p.fresh);
  if (fresh && fresh.send_at === null && fresh.label === '' && !s.groups.some(g => g.page === fresh.id))
    s.pages.splice(s.pages.indexOf(fresh), 1);
  Object.assign(p, { send_at: null, fresh: null });
  s.changed(p.notebook, p.id);
  return p;
}
// The board's reply under an agent's answer (a slip): a reply group under the answered group, going in sendMs
function replyTo(s, b) {
  const slip = s.slips.find(x => x.id === Number(b?.answer));
  const answered = slip && s.groups.find(g => g.note === slip.note);
  const p = answered && s.page(answered.page);
  if (!p) refuse(404);
  const said = wordsOf(b.words, b.said ?? 'written'),
    ink = b.ink === undefined ? [] : inkOf(b.ink);
  if (!said.words && !ink.length) refuse(400, 'a reply has words or ink');
  const top = answered.parent === null ? answered : s.group(answered.parent);
  const g = insertGroup(
    s,
    p,
    'reply',
    BOARD,
    { ink, texts: [], pictures: [] },
    {
      ...{ parent: top.id, answers: slip.id, words: said.words, said: said.said },
      ...{ status: 'sent', note: s.next('note') },
    },
  );
  s.notes.set(g.note, s.now() + s.sendMs);
  return { id: g.id, parent: top.id };
}
function deleteReply(s, b) {
  const g = s.group(id(b?.id));
  const p = g && g.kind === 'reply' && s.page(g.page);
  if (!p || g.deleted !== null) refuse(404);
  if (s.noteGone(g.note)) refuse(409, 'too late to take back: the reply has gone');
  s.notes.delete(g.note);
  putAside(s, g, p);
  return { ok: true, id: g.id };
}
// A picture uploaded to an open page, for a group there to place: { file, url }
function uploadPicture(s, b, q) {
  const p = s.page(id(q.page));
  if (!p || s.shut(p)) refuse(404, 'no such open page');
  if (b?.type !== 'image/jpeg' && b?.type !== 'image/png') refuse(415, 'a JPEG or PNG only');
  const bytes = new Uint8Array(b.bytes);
  if (bytes.length > MAX_BYTES) refuse(413, 'too large');
  const file = keepPicture(s, p.id, pictureOf(bytes));
  return { file, url: pictureUrl(file) };
}

// ---------------------------------------------------------------- shared
const id = v => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : 0);
const notebookRow = (s, v) => s.notebook(id(v)) ?? refuse(404);
const pageRow = (s, v) => s.page(id(v)) ?? refuse(404);
const pagesOf = (s, notebook) =>
  s.pages.filter(p => p.notebook === notebook).sort((a, b) => a.pos - b.pos || a.id - b.id);
const archived = v => (typeof v === 'boolean' ? v : refuse(400, 'archived is true or false'));
const notebookOf = (s, n) => ({
  ...{ id: n.id, name: n.name, kind: n.kind, archived: !!n.archived, created: n.created, updated: n.updated },
  pages: s.pages.filter(p => p.notebook === n.id && !p.archived).length,
});
// What the shelf and a notebook's page grid read of a page. sending: in its time to undo; sent: when it went.
const pageOf = (s, p) => ({
  ...{ id: p.id, notebook: p.notebook, kind: p.kind, title: p.label, archived: !!p.archived, zooms: { ...p.zooms } },
  sending: p.send_at !== null && !s.gone(p),
  sent: s.gone(p) ? new Date(p.send_at).toISOString() : null,
  ...{ created: p.created, updated: p.updated, day: p.created.slice(0, 10), x: p.x, y: p.y, w: p.w, h: p.h },
  groups: s.groups.filter(g => g.page === p.id && g.parent === null && g.deleted === null).length,
  picture: null,
});

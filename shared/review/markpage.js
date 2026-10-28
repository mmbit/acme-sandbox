// The book's store as the Pencil's marks reach it (the coordinator's /api/book routes, booknotes.ts), and the page in
// today's book a mark on HQ's page goes on: its owner's sheet page, or on a call the call's (marks.js).
const API = '/api/book';

const json = async res => {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  return body;
};
// ...and the Notebook's (the coordinator's /api/notebooks routes, notebookgroups.ts), where a note off a call goes as a
// scrap (marks.js post)
export const toNotebook = (path, body) => send(path, body, '/api/notebooks');
export const get = path => fetch(API + path, { credentials: 'same-origin' }).then(json);
export const send = (path, body, api = API) =>
  fetch(api + path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(json);

// HQ's page as the book names it: its path and query, never its fragment
export const here = () => location.pathname + location.search;
// Whether a note's mark was made on this page (its anchor's url, fragment aside)
export const onThisPage = a => {
  const u = new URL(a.url, location.href);
  return u.origin === location.origin && u.pathname + u.search === here();
};

// Whose a mark is: the agent whose work it's on, as HQ's page names it on what's drawn there (data-owner="<agent id>"
// on the nearest box around the mark, through open shadow roots; "" for nobody's), else nobody's, which is the
// company's CEO's (/api/org, asked once).
export async function ownerOf(r, el) {
  r.org ??= fetch('/api/org')
    .then(json)
    .then(o => ({
      ceo: o.company?.ceo,
      agents: new Map(o.departments.flatMap(d => d.agents.map(a => [a.id, a.name ?? a.id]))), // (names)
    }));
  r.org.catch(() => (r.org = null)); // (never a failed ask kept)
  const { ceo, agents } = await r.org;
  for (let e = el; e; e = e.parentElement ?? e.getRootNode?.().host) {
    const owner = e.getAttribute?.('data-owner');
    if (owner) return agents.has(owner) ? owner : ceo;
    if (owner === '') break;
  }
  return ceo;
}

// ...and the sheet's name for it, as the book heads it ("For Juno").
export async function ownerNamed(r, el) {
  const owner = await ownerOf(r, el);
  return { owner, name: (await r.org)?.agents.get(owner) ?? owner };
}

// The owner's page in today's book (a sheet's page, one an owner a day, made at their first note), and who it's for.
// On a call, the call's page.
export async function pageOf(r, owner) {
  if (r.call) return callPage(r);
  r.bookPages ??= new Map();
  const known = r.bookPages.get(owner);
  if (known?.day === dayNow()) return known;
  const day = await get('');
  const page =
    day.pages.find(p => p.kind === 'sheet' && p.owner === owner) ??
    (await send('/page/new', {
      kind: 'sheet',
      owner,
      url: here(),
      ...size(),
    }));
  const found = { id: page.id, owner, day: dayNow() };
  r.bookPages.set(owner, found);
  return found;
}
// (the day the cache holds a page for: a page left open past midnight makes the next day's)
const dayNow = () => new Date().toDateString();

// A call's page in today's book (callnotes.js): made at the call's first mark, the board's or its agent's, so a call
// nobody drew on leaves none. Asked once a call, so two first marks make one page. A walk-through's is made as it's
// picked up, kept only if the board writes on it (HQ's calldraw.js).
export function callPage(r) {
  const call = r.call.call;
  if (r.bookPage?.call === call) return r.bookPage;
  if (r.callPage?.call !== call)
    r.callPage = {
      call,
      page: (async () => {
        const day = await get('');
        let page = day.pages.find(p => p.kind === 'call' && p.call === call);
        if (!page) {
          const label = `${r.call.walk ? 'Walk-through' : 'Call'} with ${r.call.name}`;
          page = await send('/page/new', { kind: 'call', call, label, ...size() });
          // (the book beside HQ turns to it.)
          document.dispatchEvent(new CustomEvent('book:paged', { detail: { page: page.id } }));
        }
        return (r.bookPage = { id: page.id, url: null, call });
      })().catch(err => {
        r.callPage = null; // (asked again at the next mark)
        throw err;
      }),
    };
  return r.callPage.page;
}
const size = () => ({
  w: Math.min(4000, Math.max(100, innerWidth)),
  h: Math.min(4000, Math.max(100, innerHeight)),
});

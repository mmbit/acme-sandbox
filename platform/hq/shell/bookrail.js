// The book's rail: a face for each agent with an open sheet (its count of notes) or an answer not yet ticked (a dot),
// and at its foot Search, Undo and the book's arrow. What a face or Search does beyond opening the book is theirs who
// listen: book:face (detail: { owner }) and book:search on the document. The folded book's lip carries the faces' dot:
// an answer waits to be read. Under the faces, everyone invited with a book of
// their own, their initial in their colour: a tap opens theirs in the board's (book:person, detail: { who, name, colour },
// or null for the board's own again; book:whose says which is open).
import { esc } from '../util.js';
import * as world from '../world/world.js';
import { loadSheets as readSheets } from './booksheetdata.js';
import { loadPeople } from './bookdata.js';
import { facesOf } from './bookfaces.js';
import { scene, look } from './stage.js';

// The faces follow the store: read again this often, when HQ comes back to the front, when the Pencil leaves a note
// (pencil:note) and when asked (refreshRail)
const SHEETS_POLL_MS = 20000;

const ICONS = {
  search:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15 15l5.5 5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  undo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7H4V2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M4.5 7A8 8 0 1 1 6 17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  arrow:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

let faces, lip, dev;
let people = [],
  open = null; // (invited people with a book, and whose is open)

// node: the rail's element; lipNode: the folded book's lip. on: { toggle, open, undo }, the book's (book.js)
export function mountRail(node, lipNode, on) {
  dev = on.dev;
  lip = lipNode;
  node.innerHTML = `<div class="bk-faces"></div><div class="bk-foot">
    <button class="bk-search" title="Search the book">${ICONS.search}<span class="sr">Search</span></button>
    <button class="bk-undo" title="Undo">${ICONS.undo}<span class="sr">Undo</span></button>
    <button class="bk-arrow" title="Put the book away or bring it back">${ICONS.arrow}<span class="sr">The book</span></button></div>`;
  faces = node.querySelector('.bk-faces');
  node.querySelector('.bk-arrow').addEventListener('click', on.toggle);
  node.querySelector('.bk-undo').addEventListener('click', on.undo);
  node.querySelector('.bk-search').addEventListener('click', () => {
    on.open();
    document.dispatchEvent(new CustomEvent('book:search'));
  });
  faces.addEventListener('click', e => {
    const face = e.target.closest('.bk-face');
    if (!face) return;
    on.open();
    if (face.dataset.who) {
      const person = face.dataset.who === open ? null : people.find(p => p.who === face.dataset.who);
      return document.dispatchEvent(new CustomEvent('book:person', { detail: person ?? null }));
    }
    document.dispatchEvent(new CustomEvent('book:face', { detail: { owner: face.dataset.owner || null } }));
  });
  refreshRail();
  setInterval(() => document.hidden || refreshRail(), SHEETS_POLL_MS);
  document.addEventListener('visibilitychange', () => document.hidden || refreshRail());
  // a note the Pencil just left on a sheet counts on its face at once
  document.addEventListener('pencil:note', refreshRail);
  // ...and its words, read from its handwriting after it went in
  document.addEventListener('pencil:words', refreshRail);
  // ...and an answer the moment it clips on (HQ's feed), or a slip ticked or replied to on HQ's page
  document.addEventListener('book:changed', refreshRail);
  document.addEventListener('book:whose', e => {
    open = e.detail.who;
    for (const f of faces.querySelectorAll('[data-who]'))
      f.setAttribute('aria-pressed', String(f.dataset.who === open));
  });
  return { refresh: refreshRail };
}

// Read the sheets again and draw the faces (an unreadable store leaves the faces as they were, till the next read). The
// sheets read go to the book's pages too (book:sheets on the document, booksheet.js), so faces and sheets agree.
// (the sheets told, dev mode's played in memory, booksheetdata.js)
export async function refreshRail() {
  const [sheets, invited] = await Promise.all([
    readSheets(dev).catch(e => (console.error('[hq] The book’s sheets can’t be read:', e), null)),
    loadPeople(dev).catch(e => (console.error('[hq] The invited people’s books can’t be read:', e), null)),
  ]);
  if (!sheets || !invited) return;
  const all = facesOf(sheets, world.company.ceo);
  people = invited;
  faces.innerHTML =
    all.map(faceHtml).join('') + (people.length ? '<hr class="bk-sep">' : '') + people.map(personHtml).join('');
  const unread = all.some(f => f.dot);
  lip.innerHTML = `${unread ? '<i class="bk-dot"></i>' : ''}<span class="sr">The book</span>`;
  lip.title = `The book: tap or pull it in${unread ? ' (an answer to read)' : ''}`;
  document.dispatchEvent(new CustomEvent('book:sheets', { detail: sheets }));
}
// The face under a point on the screen: { id (the agent), owner (null: nobody's) }, or null.
export function faceAt(x, y) {
  for (const f of faces?.querySelectorAll('.bk-face:not(.bk-person)') ?? []) {
    const r = f.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
      return { id: f.dataset.id, owner: f.dataset.owner || null };
  }
  return null;
}
// An agent's face's box on the screen, or null when it has none in the rail
export const faceBox = id =>
  [...(faces?.querySelectorAll('.bk-face:not(.bk-person)') ?? [])]
    .find(f => f.dataset.id === id)
    ?.getBoundingClientRect() ?? null;

function faceHtml({ id, owner, count, dot }) {
  const name = world.agents.get(id)?.data.name ?? id ?? '',
    picture = portrait(id),
    said = [count ? `${count} note${count === 1 ? '' : 's'}` : '', dot ? 'an answer to read' : ''].filter(Boolean);
  return `<button class="bk-face" data-id="${esc(id ?? '')}" data-owner="${esc(owner ?? '')}" title="For ${esc(name)}${said.length ? `: ${esc(said.join(', '))}` : ''}">
    <i class="bk-av"${picture ? ` style="background-image:url(${picture})"` : ''}>${picture ? '' : esc(name[0] ?? '')}</i>
    ${count ? `<b>${count}</b>` : ''}${dot ? '<i class="bk-dot"></i>' : ''}<span class="sr">For ${esc(name)}</span></button>`;
}
// An invited person's book: their initial in their colour, pressed while it's open.
const personHtml = ({ who, name, colour }) =>
  `<button class="bk-face bk-person" data-who="${esc(who)}" aria-pressed="${who === open}" style="--ink:${esc(colour)}" title="${esc(name)}’s book">
    <i class="bk-av">${esc([...name][0] ?? '')}</i><span class="sr">${esc(name)}’s book</span></button>`;
// An agent's face as HQ's look draws them (a data URL), kept per look; none before the scene has placed them
// (exported: a free page's faces to send it to, booksendpage.js.)
const portraits = new Map();
export function portrait(id) {
  const key = `${look}:${id}`;
  if (!portraits.has(key)) {
    const drawn = world.agents.has(id) ? scene?.portrait?.({ kind: 'agent', id }) : null;
    if (!drawn) return '';
    portraits.set(key, drawn.img.toDataURL());
  }
  return portraits.get(key);
}

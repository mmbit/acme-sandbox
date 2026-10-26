// The book's rail: a face for each agent with an open sheet (its count of notes) or an answer not yet ticked (a dot),
// and at its foot Search, Undo and the book's arrow. What a face or Search does beyond opening the book is theirs who
// listen: book:face (detail: { owner }) and book:search on the document.
import { esc } from '../util.js';
import * as world from '../world/world.js';
import { get } from './data.js';
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

let faces, dev;

// node: the rail's element. on: { toggle, open, undo }, the book's (book.js)
export function mountRail(node, on) {
  dev = on.dev;
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
    document.dispatchEvent(new CustomEvent('book:face', { detail: { owner: face.dataset.owner || null } }));
  });
  refreshRail();
  setInterval(() => document.hidden || refreshRail(), SHEETS_POLL_MS);
  document.addEventListener('visibilitychange', () => document.hidden || refreshRail());
  // a note the Pencil just left on a sheet counts on its face at once
  document.addEventListener('pencil:note', refreshRail);
  return { refresh: refreshRail };
}

// Read the sheets again and draw the faces (an unreadable store leaves the faces as they were, till the next read)
export async function refreshRail() {
  const sheets = await loadSheets().catch(e => (console.error('[hq] The book’s sheets can’t be read:', e), null));
  if (sheets) faces.innerHTML = facesOf(sheets, world.company.ceo).map(faceHtml).join('');
}
const loadSheets = () => get(dev ? 'mock/book-sheets.json' : '/api/book/sheets');

function faceHtml({ id, owner, count, dot }) {
  const name = world.agents.get(id)?.data.name ?? id ?? '',
    picture = portrait(id),
    said = [count ? `${count} note${count === 1 ? '' : 's'}` : '', dot ? 'an answer to read' : ''].filter(Boolean);
  return `<button class="bk-face" data-owner="${esc(owner ?? '')}" title="For ${esc(name)}${said.length ? `: ${esc(said.join(', '))}` : ''}">
    <i class="bk-av"${picture ? ` style="background-image:url(${picture})"` : ''}>${picture ? '' : esc(name[0] ?? '')}</i>
    ${count ? `<b>${count}</b>` : ''}${dot ? '<i class="bk-dot"></i>' : ''}<span class="sr">For ${esc(name)}</span></button>`;
}
// An agent's face as HQ's look draws them (a data URL), kept per look; none before the scene has placed them
const portraits = new Map();
function portrait(id) {
  const key = `${look}:${id}`;
  if (!portraits.has(key)) {
    const drawn = world.agents.has(id) ? scene?.portrait?.({ kind: 'agent', id }) : null;
    if (!drawn) return '';
    portraits.set(key, drawn.img.toDataURL());
  }
  return portraits.get(key);
}

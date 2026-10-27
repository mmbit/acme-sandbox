// The book's rail: a face for each agent with an open sheet or an answer not yet ticked (a dot), never a count, and
// by the face of the sheet shown a small plane that sends it; and in the book's
// island Undo and Redo (islands floating over the paper: bookui.js.). What a face does beyond opening the book is theirs who listen: book:face
// (detail: { owner }) on the document. The folded book's handle draws what the faces
// hold from the sheets read here (book:sheets: bookhandle.js.). Under the faces,
// everyone invited with a book of
// their own, their initial in their colour: a tap opens theirs in the board's (book:person, detail: { who, name, colour },
// or null for the board's own again; book:whose says which is open).
import { esc } from '../util.js';
import * as world from '../world/world.js';
import { SEND_MS, loadSheets as readSheets } from './booksheetdata.js';
import { loadPeople } from './bookdata.js';
import { facesOf } from './bookfaces.js';
import { PLANE, sendAt } from './bookplane.js';
import { sendOrder } from './booksheetplace.js';
import { scene, look } from './stage.js';
import { button, hide, island, islands, tip, MOD } from './bookui.js';

// The faces follow the store: read again this often, when HQ comes back to the front, when the Pencil leaves a note
// (pencil:note) and when asked (refreshRail)
const SHEETS_POLL_MS = 20000;

const ICONS = {
  undo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7H4V2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M4.5 7A8 8 0 1 1 6 17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  // (Undo's arrow turned the other way.)
  redo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 7h5V2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M19.5 7A8 8 0 1 0 18 17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

let faces, dev;
let people = [],
  open = null; // (invited people with a book, and whose is open)

// node: the rail's element. on: { open, undo, redo }, the book's (book.js.: the lip is bookhandle.js's)
export function mountRail(node, on) {
  dev = on.dev;
  // (the controls float as small islands over the paper's right edge, one style for all: bookui.js.)
  node.append(islands());
  faces = island('faces');
  const book = island('book'),
    undo = button({ icon: ICONS.undo, label: 'Undo', keys: `${MOD}+Z`, onClick: on.undo }),
    redo = button({ icon: ICONS.redo, label: 'Redo', keys: `${MOD}+Shift+Z`, onClick: on.redo });
  undo.classList.add('bk-undo');
  redo.classList.add('bk-redo');
  book.append(undo, redo);
  faces.addEventListener('click', e => tapped(e.target, on));
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

// A face tapped: the book opened at its sheet (book:face), or an invited person's book opened in it, or the board's own
// again when theirs is open (book:person). The small plane by a face sends the sheet shown, or takes back a send in its
// seconds (book:give, detail: { id, owner, sending: the sheet in its seconds or null). (book:give)
function tapped(target, on) {
  const plane = target.closest('.bk-plane');
  if (plane) {
    const face = shownFaces.find(f => f.id === plane.dataset.for);
    const detail = { id: face.id, owner: face.owner, sending: face.sending };
    return document.dispatchEvent(new CustomEvent('book:give', { detail }));
  }
  const face = target.closest('.bk-face');
  if (!face) return;
  on.open();
  if (face.dataset.who) {
    const person = face.dataset.who === open ? null : people.find(p => p.who === face.dataset.who);
    return document.dispatchEvent(new CustomEvent('book:person', { detail: person ?? null }));
  }
  document.dispatchEvent(new CustomEvent('book:face', { detail: { owner: face.dataset.owner || null } }));
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
  shownFaces = facesOf(sheets, world.company.ceo);
  people = invited;
  drawFaces();
  document.dispatchEvent(new CustomEvent('book:sheets', { detail: sheets }));
}

// ---- the faces (kept and drawn again in place, no count on them; the plane
// by a face)

let shownFaces = [],
  here = null, // the agent whose sheet the book shows, or null
  carried = false; // something carried over the faces: everyone's face shows, to give it to anyone

// The faces in the island, in their order: each agent's (kept, its parts drawn again), while something is carried
// everyone else's after a hairline, then the invited people's books; and the plane by a face that has one
function drawFaces() {
  const kept = new Map([...faces.querySelectorAll('.bk-face[data-id]')].map(f => [f.dataset.id, f]));
  const others = carried ? everyoneElse() : [];
  const buttons = [...shownFaces, ...others].map(face => {
    const button = kept.get(face.id) ?? faceButtonOf(face);
    kept.delete(face.id);
    drawFace(button, face, others.includes(face));
    return button;
  });
  for (const gone of kept.values()) gone.remove();
  faces.querySelectorAll('.bk-sep, .bk-person, .bk-plane').forEach(n => n.remove());
  faces.append(...buttons);
  if (people.length) faces.insertAdjacentHTML('beforeend', `<hr class="bk-sep">${people.map(personHtml).join('')}`);
  // (the book's own tooltips, never title=)
  for (const f of faces.querySelectorAll('.bk-person')) tip(f, f.getAttribute('aria-label'));
  many();
  for (const face of shownFaces) if (face.sending || (face.id === here && face.count)) planeBy(face);
}
// Every agent who has no face yet, as faces with nothing waiting (the rail's first, then by name: sendOrder)
const everyoneElse = () =>
  sendOrder(
    [...(world.agents?.keys() ?? [])].map(id => ({ id, name: nameOf(id) })),
    [],
  )
    .filter(a => !shownFaces.some(f => f.id === a.id))
    .map(a => ({ id: a.id, owner: a.id, count: 0, dot: false, sending: null }));
function faceButtonOf({ id }) {
  const button = document.createElement('button');
  button.className = 'bk-face';
  button.dataset.id = id;
  tip(button, () => button.getAttribute('aria-label'));
  return button;
}
// A face: the agent's portrait, ringed while the book shows their sheet, a dot for an answer to read
function drawFace(button, { id, owner, dot }, other) {
  const name = nameOf(id),
    picture = portrait(id);
  button.dataset.owner = owner ?? '';
  button.toggleAttribute('data-here', id === here);
  button.toggleAttribute('data-other', other);
  button.setAttribute('aria-label', `For ${name}${dot ? ': an answer to read' : ''}`);
  button.innerHTML = `<i class="bk-av"${picture ? ` style="background-image:url(${picture})"` : ''}>${
    picture ? '' : esc(name[0] ?? '')
  }</i>${dot ? '<i class="bk-dot"></i>' : ''}`;
}
// The small plane right by a face: on their sheet, its tap sends it; in a send's seconds, a ring runs out round it and
// its tap takes the send back. Past them, while the store still reads the board's writing beside its notes, the plane
// alone, on its way
function planeBy({ id, sending }) {
  const face = faceButton(id),
    name = nameOf(id),
    plane = document.createElement('button'),
    gone = sending && sendAt(sending) <= Date.now(),
    say = gone ? `On its way to ${name}` : sending ? `Sending to ${name}` : `Send to ${name}`;
  plane.className = 'bk-plane';
  plane.dataset.for = id;
  plane.toggleAttribute('data-sending', !!sending);
  plane.disabled = !!gone;
  plane.setAttribute('aria-label', gone || !sending ? say : `${say}: tap to take it back`);
  tip(plane, gone || !sending ? say : `${say}: tap to undo`);
  plane.innerHTML = `${sending && !gone ? ringHtml(sending) : ''}${PLANE}`;
  plane.style.top = `${face.offsetTop + face.offsetHeight / 2}px`;
  faces.append(plane);
}
// The seconds to undo a send, a ring running out round the plane (its circle's length, RING)
const RING = 100.53;
function ringHtml(sheet) {
  const left = Math.max(0, sendAt(sheet) - Date.now());
  return `<svg class="bk-ring" viewBox="0 0 36 36" aria-hidden="true"><circle class="bk-ring-track" cx="18" cy="18"
    r="16"/><circle cx="18" cy="18" r="16" style="stroke-dasharray: ${RING}; stroke-dashoffset: ${
      RING * (1 - left / SEND_MS)
    }; animation-duration: ${left}ms"/></svg>`;
}
// The face of the sheet the book shows (an agent's id, or null): ringed, the plane by it
export function markHere(id) {
  if (id === here) return;
  here = id;
  if (faces) drawFaces();
}
// Something carried to the faces (a page by its corner: bookdogear.js), or put down: everyone's face shows meanwhile
export function carrying(on) {
  carried = on;
  hide(); // (no face's tooltip over what's carried, nor left behind it)
  faces.closest('.bk-islands')?.toggleAttribute('data-carrying', on);
  drawFaces();
}
// Too many faces for the island: it scrolls; else what's by a face stands out past its edge
function many() {
  faces.removeAttribute('data-many');
  faces.toggleAttribute('data-many', faces.scrollHeight > faces.clientHeight + 1);
}
const nameOf = id => world.agents.get(id)?.data.name ?? id ?? '';

// The face under a point on the screen: { id (the agent), owner (null: nobody's) }, or null.
export function faceAt(x, y) {
  for (const f of faces?.querySelectorAll('.bk-face:not(.bk-person)') ?? []) {
    const r = f.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
      return { id: f.dataset.id, owner: f.dataset.owner || null };
  }
  return null;
}
// An agent's face in the rail, and its box on the screen (null when it has none)
export const faceButton = id =>
  [...(faces?.querySelectorAll('.bk-face:not(.bk-person)') ?? [])].find(f => f.dataset.id === id) ?? null;
export const faceBox = id => faceButton(id)?.getBoundingClientRect() ?? null;

// An invited person's book: their initial in their colour, pressed while it's open.
const personHtml = ({ who, name, colour }) =>
  `<button class="bk-face bk-person" data-who="${esc(who)}" aria-pressed="${who === open}" style="--ink:${esc(colour)}" aria-label="${esc(name)}’s book">
    <i class="bk-av">${esc([...name][0] ?? '')}</i></button>`;
// An agent's face as HQ's look draws them (a data URL), kept per look; none before the scene has placed them
// (exported: the folded book's handle draws them too, bookhandle.js.)
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

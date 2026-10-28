// The Sketchbook's shelf: a book's sketches as small pages (the newest change first, a New sketch first of all), the
// archive on a shelf of its own. Each one's menu renames, archives and deletes it in place, and a tap opens it full
// screen to draw on (sketchpage.js). Whose book it is, and what's around it, is the book's (sketchbook.js: HQ's, the
// board's; sketchguest.js: an invited person's on the guest desk). (from
// sketchbook.js)
//   book: { dev, list() → { sketches, guests? }, load(id), act(what, body), upload(id, blob), to: whom Send goes to,
//     sent(): after a send, toast(words, tap), ago(iso) }. guests: the invited people's books the board looks at, each
//     { name, sketches } on a shelf of its name, where a tap shows its picture.
import { esc } from '../../util.js';
import { sfx } from '../audio.js';
import { openSketch, newSketch } from './sketchpage.js';
import { zoom } from '../zoom.js';

// what the screen shows: a shelf (sketches | archive | guest:<n>), the sketch whose menu is open, the one being renamed
const screen = { el: null, book: null, shelf: 'sketches', menu: null, renaming: null, shown: '', list: [], guests: [] };

// The shelf in el, for book: a new el is a fresh opening, on the sketches. Each call (re)loads the list.
export async function shelf(el, book) {
  if (el !== screen.el) Object.assign(screen, { el, shelf: 'sketches', menu: null, renaming: null, shown: '' });
  screen.book = book;
  ({ sketches: screen.list, guests: screen.guests = [] } = await book.list());
  paint();
}

// Back, from the shelf's own header: a menu open closes first, then any shelf goes back to the sketches. On the sketches
// it returns false, so whatever is around the shelf goes back.
export function back() {
  if (!screen.el?.isConnected || (!screen.menu && screen.shelf === 'sketches')) return false;
  sfx.blip();
  if (screen.menu) screen.menu = null;
  else screen.shelf = 'sketches';
  paint();
  return true;
}

// The screen, drawn again only when what it shows has changed (a page's picture is fetched once per version)
function paint(force = false) {
  const { el, shelf, list } = screen;
  if (!el?.isConnected) return;
  const theirs = shelf.startsWith('guest:') ? screen.guests[Number(shelf.slice(6))] : null;
  const shown = theirs ? theirs.sketches : list.filter(s => s.archived === (shelf === 'archive'));
  const key = JSON.stringify([shelf, screen.menu, screen.renaming, shown, list.length, screen.guests.length]);
  if (key === screen.shown && !force) return;
  screen.shown = key;
  const archived = list.filter(s => s.archived).length;
  // (the Notebook, once the Sketchbook, in a person's book's title and line)
  el.innerHTML = `<div class="sk-book">
    <div class="sk-shelves" role="tablist">
      <button role="tab" data-shelf="sketches" aria-selected="${shelf === 'sketches'}">Sketches</button>
      <button role="tab" data-shelf="archive" aria-selected="${shelf === 'archive'}">Archive${archived ? ` · ${archived}` : ''}</button>
      ${screen.guests.map((g, i) => `<button role="tab" class="sk-theirs" data-shelf="guest:${i}" aria-selected="${shelf === `guest:${i}`}" title="${esc(g.name)}’s own Notebook">${esc(g.name)}</button>`).join('')}
    </div>
    ${theirs ? `<p class="sk-whose">${esc(theirs.name)}’s own sketches, from the Notebook you gave them${theirs.on ? '' : ' (closed now)'}. A tap looks closer.</p>` : ''}
    <ul class="sk-grid">${shelf === 'sketches' ? NEW : ''}${shown.map(theirs ? theirCardHtml : cardHtml).join('')}</ul>
    ${shelf === 'archive' && !shown.length ? '<p class="sk-none">Nothing archived. A sketch you archive waits here, out of the way.</p>' : ''}
  </div>`;
  wire(el);
  el.querySelector('.sk-rename')?.focus();
}
const NEW = `<li class="sk-card"><button class="sk-new" data-new><span class="sk-paper"><i aria-hidden="true">+</i></span><b>New sketch</b></button></li>`;

function cardHtml(s) {
  const name = s.label || 'Untitled',
    open = screen.menu === s.id;
  const picture = s.picture ? `<img src="${esc(s.picture)}" alt="" loading="lazy" draggable="false">` : '';
  const label =
    screen.renaming === s.id
      ? `<input class="sk-rename" data-rename="${s.id}" value="${esc(s.label)}" placeholder="Untitled" maxlength="80" aria-label="Label" enterkeyhint="done">`
      : `<b>${esc(name)}</b>`;
  return `<li class="sk-card${open ? ' menu-open' : ''}">
    <button class="sk-open" data-open="${s.id}" aria-label="Open “${esc(name)}”"><span class="sk-paper">${picture}</span></button>
    <span class="sk-name"><span class="sk-words">${label}<i>${esc(when(s))}</i></span>
      <button class="sk-dots" data-menu="${s.id}" aria-expanded="${open}" aria-label="More for “${esc(name)}”">⋯</button></span>
    ${open ? menuHtml(s) : ''}
  </li>`;
}
// An invited person's sketch, the board's to look at only
function theirCardHtml(s) {
  const name = s.label || 'Untitled';
  const picture = s.picture ? `<img src="${esc(s.picture)}" alt="" loading="lazy" draggable="false">` : '';
  return `<li class="sk-card">
    <button class="sk-open" data-look="${s.id}" aria-label="Look at “${esc(name)}”"><span class="sk-paper">${picture}</span></button>
    <span class="sk-name"><span class="sk-words"><b>${esc(name)}</b><i>${esc(when(s))}</i></span></span>
  </li>`;
}
function menuHtml(s) {
  return `<span class="sk-menu" role="menu">
    <button role="menuitem" data-relabel="${s.id}">Rename</button>
    <button role="menuitem" data-archive="${s.id}">${s.archived ? 'Move out of the archive' : 'Archive'}</button>
    <button role="menuitem" data-delete="${s.id}">Delete…</button>
  </span>`;
}
// (sent: since it last changed)
function when(s) {
  const ago = screen.book.ago(s.updated);
  return s.sent && s.sent >= s.updated ? `${ago} · sent` : ago;
}

function wire(el) {
  const on = (sel, act) => el.querySelectorAll(sel).forEach(b => (b.onclick = e => act(b, e)));
  on('[data-shelf]', b => shelfTo(b.dataset.shelf));
  on('[data-new]', () => newSketch(screen.book, refresh).catch(problem));
  on('[data-open]', b => openSketch(screen.book, Number(b.dataset.open), refresh).catch(problem));
  on('[data-look]', b => {
    const s = screen.guests[Number(screen.shelf.slice(6))]?.sketches.find(s => s.id === Number(b.dataset.look));
    if (s?.picture) zoom(s.picture, s.label || 'Untitled');
  });
  on('[data-menu]', b => {
    sfx.blip();
    screen.menu = screen.menu === Number(b.dataset.menu) ? null : Number(b.dataset.menu);
    paint();
  });
  on('[data-relabel]', b => {
    Object.assign(screen, { renaming: Number(b.dataset.relabel), menu: null });
    paint();
  });
  on('[data-archive]', b => {
    const s = screen.list.find(s => s.id === Number(b.dataset.archive));
    act('archive', { id: s.id, archived: !s.archived });
  });
  on('[data-delete]', b => sureToDelete(b));
  const rename = el.querySelector('.sk-rename');
  if (rename) {
    rename.addEventListener('keydown', e => e.key === 'Enter' && rename.blur());
    rename.addEventListener('blur', () => {
      screen.renaming = null;
      act('label', { id: Number(rename.dataset.rename), label: rename.value });
    });
  }
}
function shelfTo(shelf) {
  sfx.blip();
  Object.assign(screen, { shelf, menu: null, renaming: null });
  paint();
}
// The first press asks, the second deletes it for good
function sureToDelete(button) {
  if (!button.classList.contains('sure')) {
    button.classList.add('sure');
    button.textContent = 'Delete it for good';
    sfx.tick();
    return;
  }
  sfx.boom();
  act('delete', { id: Number(button.dataset.delete) });
}

async function act(what, body) {
  screen.menu = null;
  try {
    await screen.book.act(what, body);
  } catch (e) {
    problem(e);
  }
  await refresh();
}
async function refresh() {
  if (!screen.el?.isConnected) return;
  ({ sketches: screen.list, guests: screen.guests = [] } = await screen.book.list());
  paint(true);
}
function problem(e) {
  const el = screen.el?.querySelector('.sk-book');
  el?.querySelector('.sk-problem')?.remove();
  el?.insertAdjacentHTML('afterbegin', `<p class="sk-problem" role="alert">${esc(e.message)}</p>`);
}

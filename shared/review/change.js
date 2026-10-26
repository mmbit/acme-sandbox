// Changing a note: Change in My notes opens the note's own sheet, its words in it and its mark back on the page: on its
// element where that's still there (anchor.js: found by its selector, inside open shadow roots too, and moving and
// scaling with it), else where it was on the page. Redraw marks it again, as a new note would. A note pinned on another
// page of this product opens that page first; one on another product's page (an outsider's link opens several)
// changes its words only.
import { keep, kept } from './base.js';
import { placer } from './anchor.js';
import { frameMark } from './frame.js';
import { shut } from './menu.js';
import { closeSide } from './notes.js';
import { uncoach } from './dock.js';
import { paintInk, pick } from './surface.js';
import { showSheet } from './postit.js';
import { showPictures } from './pictures.js';
import { stopMic } from './dictation.js';

const EDIT = '__hq_review_edit';
// (a shelf's base, or '')
const baseOf = r => new URL('..', r.ROUTE).pathname.slice(0, -1);
const local = r =>
  location.pathname.startsWith(baseOf(r)) ? location.pathname.slice(baseOf(r).length) + location.search : null;
const clean = page => page.replace(/#.*….*$/, ''); // (a fragment's values are left out of a note's page)

export function changeNote(r, n, arrived = false) {
  const page = clean(n.page),
    [path, hash] = [page.replace(/#.*$/, ''), page.match(/#.*$/)?.[0] ?? ''];
  if (n.mark && n.here && !arrived && path !== local(r)) {
    keep(sessionStorage, EDIT, String(n.id));
    location.assign(`${location.origin}${baseOf(r)}${page}`);
    return;
  }
  if (n.mark && n.here && hash && hash !== location.hash) location.hash = hash;
  shut(r);
  closeSide(r);
  uncoach(r);
  r.tip.classList.remove('show');
  r.mode = 'note';
  r.mark = null;
  r.shot = null;
  r.editing = { n, mark: n.mark && n.here ? n.mark : null, redrawn: false };
  r.dock.hidden = true;
  r.sheet.classList.toggle('bare', !n.mark);
  r.redrawButton.hidden = !r.editing.mark;
  developed(r, n);
  r.$('.who h2').textContent = !n.mark
    ? 'A general note'
    : n.mark.kind === 'circle'
      ? 'About this bit…'
      : 'About this…';
  const el = n.mark?.el;
  r.$('.chip').textContent = el
    ? `<${el.tag}>${n.text ? ` “${n.text.slice(0, 40)}${n.text.length > 40 ? '…' : ''}”` : ''}`
    : '';
  r.$('.page').textContent = n.mark ? n.page : `About it all · written on ${n.page}`;
  r.pinIt.textContent = 'Save';
  r.text.value = n.note;
  showPictures(r, n.pictures ?? []);
  r.framePic = r.pictures.find(p => p.file && p.file === n.video?.frame) ?? null;
  // (after the page's own layout settles, the mark in view above the sheet)
  showSheet(r);
  setTimeout(() => showMark(r, true), arrived ? 600 : 0);
}
// the polaroid: the note's screenshot as it went, framed on its mark
function developed(r, n) {
  const pol = r.$('.polaroid'),
    img = r.$('.polaroid .img');
  pol.classList.remove('busy');
  img.textContent = '';
  if (!n.shot) {
    img.innerHTML = '<span>No photo with this note.</span>';
    return;
  }
  const i = new Image();
  i.src = n.shot.url;
  i.alt = 'The screen, as it was';
  const placement = frameMark(n.shot.mark, 3 / 4);
  if (placement) {
    i.className = 'framed';
    Object.assign(i.style, placement);
  }
  i.onerror = () => (img.innerHTML = '<span>No photo here: the note still has it.</span>');
  img.append(i);
}
// a change asked for on another page: once this one has loaded
function asked(r) {
  const id = kept(sessionStorage, EDIT);
  if (!id) return;
  try {
    sessionStorage.removeItem(EDIT);
  } catch {
    /* private mode */
  }
  fetch(new URL('mine?shots', r.ROUTE), { credentials: 'same-origin', cache: 'no-store' })
    .then(res => (res.ok ? res.json() : null))
    .then(mine => {
      const n = mine?.list.find(x => x.id === Number(id));
      if (n && r.mode === 'idle') changeNote(r, n, true);
    })
    .catch(() => {
      /* My notes still has it */
    });
}
// The shown mark, drawn where it is now: its lines, and a pin's element outlined. scroll: brings it into view above
// the sheet. (r.editing.mark: the note's anchor, in document px; live: its element, while this page still holds it)
export function showMark(r, scroll = false) {
  const m = r.editing?.mark;
  paintInk(r, []);
  r.hl.hidden = true;
  if (!m || (r.mode !== 'note' && r.mode !== 'sending')) return;
  const placed = placer(m, document, { x: scrollX, y: scrollY }, m.live);
  const at = ([x, y, ...rest]) => {
    const [px, py] = placed([x, y]);
    return [px - scrollX, py - scrollY, ...rest];
  };
  const a = m.area ?? m.el?.box;
  if (!a) return;
  const [left, top] = at([a.x, a.y]),
    [right, bottom] = at([a.x + a.w, a.y + a.h]);
  if (scroll) {
    const room = r.sheet.hidden ? innerHeight : r.sheet.getBoundingClientRect().top,
      middle = (top + bottom) / 2;
    if (top < 8 || bottom > room - 8) {
      scrollBy({ left: 0, top: middle - Math.max(room, 120) / 2, behavior: 'instant' });
      return showMark(r);
    }
  }
  if (m.kind !== 'circle') {
    Object.assign(r.hl.style, {
      left: `${left - 3}px`,
      top: `${top - 3}px`,
      width: `${right - left + 6}px`,
      height: `${bottom - top + 6}px`,
    });
    r.hl.hidden = false;
  }
  paintInk(
    r,
    (m.ink ?? []).map(l => ({ ...l, points: l.points.map(at) })),
  );
}
// Redraw: the sheet steps aside for the pin's tap or circle; the pin, Escape or Cancel puts the sheet back as it was
async function redraw(r) {
  if (r.mode !== 'note') return;
  await stopMic(r); // (words being said are this note's)
  if (r.mode !== 'note') return;
  r.sheet.hidden = true;
  paintInk(r, []);
  r.hl.hidden = true;
  r.dock.hidden = false;
  pick(r);
}
export function unpick(r) {
  r.penOn.cancel();
  r.veil.hidden = true;
  r.fab.classList.remove('on');
  r.dock.hidden = true;
  r.mode = 'note';
  showSheet(r);
  showMark(r);
}

export function setupChange(r) {
  asked(r);
  addEventListener('scroll', () => r.editing && showMark(r), { passive: true, capture: true });
  addEventListener('resize', () => r.editing && showMark(r));
  r.redrawButton.onclick = () => redraw(r);
}

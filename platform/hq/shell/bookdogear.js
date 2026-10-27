// A page given by its corner: the page shown (a free page, a call's) has its top-right corner turned down, a dog-ear.
// Held and drawn away (a finger, the Pencil or a mouse) the page comes off with it, a small copy held by its corner,
// and the column shows everyone's face; let go on a face, it folds into the plane and flies in (bookplane.js), the same
// ten seconds to undo; let go anywhere else, it goes back. Then "Sent to Kit 15:31" at the page's head.
// Its look: booksheet.css. (was a plane in the page's head and a row of faces)
import { esc } from '../util.js';
import { picture } from './bookflip.js';
import { carrying, faceAt, faceButton } from './bookrail.js';
import { sendPage } from './booksheetdata.js';
import { pageSends, sentLine } from './booksheetplace.js';
import { foldLayer, give } from './bookplane.js';

// how far a press moves before the page comes off (less: a tap, the corner only lifts), and the copy's width held
const PEEL_PX = 6,
  HELD_PX = 150;
// the pages that go by their corner (a sheet's goes from its face)
const GIVEN = ['free', 'call'];

// sh: the sheets' (booksheet.js). Returns { draw(view) }: a page's head says when it went, the corner follows the page
// shown.
export function mountDogEar(sh) {
  const ear = document.createElement('button');
  ear.className = 'bk-dogear';
  ear.hidden = true;
  ear.setAttribute('aria-label', 'This page’s corner: drag it onto a face to give them the page');
  ear.innerHTML = '<i aria-hidden="true"></i>';
  sh.book.paper.querySelector('.bk-pages').append(ear);
  const follow = () => (ear.hidden = !givable(sh));
  for (const type of ['book:turn', 'book:whose', 'book:sheets', 'book:wrote']) document.addEventListener(type, follow);
  ear.addEventListener('pointerdown', e => held(sh, ear, e));
  ear.addEventListener('click', e => e.detail === 0 && peek(ear)); // (a keyboard's press: the corner lifts)
  return {
    draw: v => {
      stamp(sh, v);
      follow();
    },
  };
}

// The page shown, when its corner can give it: one of the board's own, of a kind that goes by its corner, not on its
// way already
function givable(sh) {
  const v = sh.book.who ? null : sh.book.views[sh.book.cur];
  return v && GIVEN.includes(v.page.kind) && !(v.page.id && pageSends(sh.sheets, v.page.id).sending) ? v : null;
}
// When the page went, and to whom, at its head
function stamp(sh, v) {
  const at = v.el.querySelector('[data-slot=stamp]');
  if (!at || !GIVEN.includes(v.page.kind) || !v.page.id) return;
  const { sent } = pageSends(sh.sheets, v.page.id);
  at.innerHTML = sent
    ? `<span class="bs-stamp">${esc(sentLine(sent.sent, new Date(), `Sent to ${sh.name(sent.owner)}`))}</span>`
    : '';
}

// A press on the corner: moved, the page comes off with it; let go without moving, the corner lifts a little
function held(sh, ear, down) {
  if (!down.isPrimary || (down.pointerType === 'mouse' && down.button !== 0)) return;
  // (the corner's, never the paper's pan or the pen's ink under it)
  down.preventDefault();
  down.stopPropagation();
  const v = givable(sh);
  if (!v) return;
  let carried = null;
  // (followed on the window, by its pointer: a finger's and the Pencil's stay with the corner they pressed, a mouse's
  // run over the faces)
  const move = e => {
    if (e.pointerId !== down.pointerId) return;
    if (!carried && Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < PEEL_PX) return;
    carried ??= lift(sh, ear, e);
    carry(sh, carried, e);
  };
  const up = e => {
    if (e.pointerId !== down.pointerId) return;
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
    if (!carried) return e.type === 'pointerup' && peek(ear);
    const face = e.type === 'pointerup' ? faceAt(e.clientX, e.clientY) : null;
    drop(sh, v, ear, carried, face);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
}
// The corner lifts and settles: it's a corner to take hold of
function peek(ear) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  ear.firstChild.animate([{ scale: '1' }, { scale: '1.5', offset: 0.35 }, { scale: '1' }], {
    duration: 420,
    easing: 'cubic-bezier(.3,1.5,.5,1)',
  });
}

// The page comes off the paper as a small copy held by its corner (the pointer at its top-right), everyone's face in
// the column to give it to
function lift(sh, ear, e) {
  const desk = sh.book.desk,
    shown = desk.getBoundingClientRect(),
    k = HELD_PX / shown.width,
    height = Math.max(60, shown.height * k);
  const layer = foldLayer({ left: e.clientX - HELD_PX + 12, top: e.clientY - 12, width: HELD_PX, height });
  layer.dataset.page = '';
  const copy = picture(desk);
  Object.assign(copy.style, {
    inset: 'auto',
    left: '0',
    top: '0',
    width: `${shown.width}px`,
    height: `${shown.height}px`,
    transform: `scale(${k})`,
    transformOrigin: '0 0',
  });
  layer.querySelector('.bs-fold-on').append(copy);
  layer.insertAdjacentHTML('beforeend', '<span class="bs-to" hidden></span>');
  ear.dataset.lifted = '';
  carrying(true);
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const at = layer.getBoundingClientRect(),
      dx = shown.left + shown.width / 2 - (at.left + at.width / 2),
      dy = shown.top + shown.height / 2 - (at.top + at.height / 2);
    layer.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${1 / k})`, opacity: 0.4 }, { transform: 'none' }], {
      duration: 240,
      easing: 'cubic-bezier(.2,.8,.3,1)',
    });
  }
  return { layer, over: null };
}
// Carried: the copy follows the pointer by its corner, and over a face says whose it would be
function carry(sh, carried, e) {
  const { layer } = carried,
    width = layer.offsetWidth;
  Object.assign(layer.style, { left: `${e.clientX - width + 12}px`, top: `${e.clientY - 12}px` });
  const face = faceAt(e.clientX, e.clientY),
    tag = layer.querySelector('.bs-to');
  if (face?.id === carried.over) return;
  if (carried.over) faceButton(carried.over)?.removeAttribute('data-over');
  carried.over = face?.id ?? null;
  if (face) faceButton(face.id)?.setAttribute('data-over', '');
  tag.hidden = !face;
  if (face) tag.textContent = `To ${sh.name(face.id)}`;
}
// Let go: on a face, the page goes to them (a page not yet kept has nothing to give: it goes back); anywhere else, the
// copy flies back into the corner
async function drop(sh, v, ear, { layer, over }, face) {
  if (over) faceButton(over)?.removeAttribute('data-over');
  layer.querySelector('.bs-to')?.remove();
  delete ear.dataset.lifted;
  if (face && v.page.id) {
    await give(sh, v, face.id, layer, { page: true }, () => sendPage(sh.dev, v.page.id, face.id));
    return carrying(false);
  }
  carrying(false);
  const home = ear.getBoundingClientRect(),
    at = layer.getBoundingClientRect(),
    dx = home.right - at.right,
    dy = home.top - at.top;
  await layer
    .animate([{ transform: 'none' }, { transform: `translate(${dx}px, ${dy}px) scale(0.2)`, opacity: 0 }], {
      duration: 260,
      easing: 'cubic-bezier(.4,0,.6,1)',
      fill: 'forwards',
    })
    .finished.catch(() => {});
  layer.remove();
}

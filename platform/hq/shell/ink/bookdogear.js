// A page sent or shared by its corner: every page the board sees has its top-right corner turned down, a dog-ear. Held
// and drawn away (a finger, the Pencil or a mouse) a copy of the page tears off with it, torn out at the spine, its edge
// jagged, with a soft tear of paper; the page itself stays whole. The rail makes way for three targets over the page
// bar (bookshare.js): Submit to the CEO, PDF and PNG. Let go on Submit, the page goes (bookpagesend.js); on PDF or PNG
// the copy folds into it and the file downloads; anywhere else, it goes back. Pressed with a key or tapped, the corner
// opens the same three as a small menu. With a call on, the call's window takes it too (calldrop.js). Its look:
// bookshare.css. (Submit, the call's target gone)
import { foley } from '../audio.js';
import { picture } from './bookflip.js';
import { fold, tear } from './bookpaper.js';
import { said } from './booksave.js';
import { callAbout, downloaded, filesOf, mountTargets } from './bookshare.js';
import { askedFirst, openAsks, submit } from './bookpagesend.js';
import { shut } from './booksave.js';
import { islands } from './bookui.js';
import { callWindowAt, lightCall } from '../calldrop.js';

// how far a press moves before the page comes off (less: a tap, the menu), the copy's width held, and its corner
// turned down (bookshare.css's)
const PEEL_PX = 6,
  HELD_PX = 150,
  EAR_PX = 14;

// book: bookpages.js's. The corner follows the page shown.
export function mountDogEar(book) {
  const ear = document.createElement('button'),
    pages = book.paper.querySelector('.bk-pages');
  ear.className = 'bk-dogear';
  ear.hidden = true;
  ear.setAttribute('aria-label', 'Send this page: drag its corner onto Submit, PDF or PNG, or press for the choices');
  ear.setAttribute('aria-haspopup', 'menu');
  ear.innerHTML = '<i aria-hidden="true"></i>';
  pages.append(ear);
  const corner = { book, ear, files: null, lane: islands() }; // (the rail)
  corner.targets = mountTargets(corner.lane, {
    act: (kind, box) => went(corner, kind, box, null),
    closed: () => ear.focus(),
  });
  const follow = () => {
    ear.hidden = !shown(book);
    if (ear.hidden) corner.targets.hide();
  };
  for (const type of ['book:turn', 'book:wrote']) document.addEventListener(type, follow);
  follow(); // (mounted late, after the first page's turn)
  ear.addEventListener('pointerdown', e => held(corner, e));
  ear.addEventListener('click', e => e.detail === 0 && menu(corner)); // (a key's press)
}

// The page shown, or null (none yet); whether a page can be sent (a call's notes page goes as its call ends)
const shown = book => book.views[book.cur] ?? null;
const sendable = page => !shut(page) && page.kind !== 'call';

// The targets as a menu, the page's files started
function menu(corner) {
  const v = shown(corner.book);
  if (!v) return;
  corner.files = filesOf(corner.book, v.page);
  corner.targets.menu(sendable(v.page));
}

// A press on the corner: moved, the page comes off with it; let go without moving, the menu
function held(corner, down) {
  if (!down.isPrimary || (down.pointerType === 'mouse' && down.button !== 0)) return;
  // (the corner's, never the paper's pan or the pen's ink under it)
  down.preventDefault();
  down.stopPropagation();
  const v = shown(corner.book);
  if (!v) return;
  let carried = null;
  // (followed on the window, by its pointer: a finger's and the Pencil's stay with the corner they pressed)
  const move = e => {
    if (e.pointerId !== down.pointerId) return;
    if (!carried && Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < PEEL_PX) return;
    carried ??= lift(corner, v, e);
    carry(corner, carried, e);
  };
  const up = e => {
    if (e.pointerId !== down.pointerId) return;
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
    if (!carried) return e.type === 'pointerup' && menu(corner);
    const target = e.type === 'pointerup' ? aimedAt(corner, e) : null;
    drop(corner, carried, target);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
}

// The page comes off the paper as a small copy held by its corner (the pointer at its top-right), torn out at the spine
// as it shrinks into the hand, the targets over the paper, its files started so they're ready as it's let go
function lift(corner, v, e) {
  const desk = corner.book.desk,
    shownBox = desk.getBoundingClientRect(),
    k = HELD_PX / shownBox.width;
  const layer = document.createElement('div');
  layer.className = 'bk-held';
  layer.setAttribute('aria-hidden', 'true');
  Object.assign(layer.style, { width: `${HELD_PX}px`, height: `${Math.max(60, shownBox.height * k)}px` });
  const copy = picture(desk);
  Object.assign(copy.style, {
    inset: 'auto',
    left: '0',
    top: '0',
    width: `${shownBox.width}px`,
    height: `${shownBox.height}px`,
    transform: `scale(${k})`,
    transformOrigin: '0 0',
  });
  // (the paper clipped to its turned corner and torn edge inside, its torn fibres under it, the shadow round both outside)
  layer.innerHTML = '<div class="bk-held-fibres"></div><div class="bk-held-sheet"></div>';
  const [fibres, sheet] = layer.children;
  sheet.append(copy);
  desk.closest('#book').append(layer);
  placeAt(layer, e);
  tear(sheet, fibres, EAR_PX);
  foley('tear', { dur: 0.22 }, { vol: 0.07 });
  corner.ear.dataset.lifted = '';
  corner.files = filesOf(corner.book, v.page);
  corner.targets.carrying(sendable(v.page));
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const at = layer.getBoundingClientRect(),
      dx = shownBox.left + shownBox.width / 2 - (at.left + at.width / 2),
      dy = shownBox.top + shownBox.height / 2 - (at.top + at.height / 2);
    layer.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${1 / k})`, opacity: 0.4 }, { transform: 'none' }], {
      duration: 240,
      easing: 'cubic-bezier(.2,.8,.3,1)',
    });
  }
  return { layer, v };
}
// Carried: the copy follows the pointer by its corner, and the target under it lights
function carry(corner, { layer }, e) {
  placeAt(layer, e);
  const target = aimedAt(corner, e),
    onCall = !!target && !target.dataset.share;
  corner.targets.over(target);
  lightCall(onCall);
  layer.toggleAttribute('data-over', !!target);
}
// What the page is over: a target, the call's window, or null
const aimedAt = (corner, e) => corner.targets.under(e.clientX, e.clientY) ?? callWindowAt(e.clientX, e.clientY);
const placeAt = (layer, e) =>
  Object.assign(layer.style, { left: `${e.clientX - layer.offsetWidth + 12}px`, top: `${e.clientY - 12}px` });

// Let go: on Submit, the page goes; on PDF or PNG, the copy folds into it; anywhere else, it flies back into the corner
async function drop(corner, { layer, v }, target) {
  delete corner.ear.dataset.lifted;
  lightCall(false);
  const box = target?.getBoundingClientRect();
  if (target?.dataset.share !== 'submit') corner.targets.hide();
  if (target) return went(corner, target.dataset.share ?? 'call', box, layer, v);
  const home = corner.ear.getBoundingClientRect(),
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

// The page goes where it was let go (kind: 'submit' | 'pdf' | 'png' | 'call', box: the target's on the screen; layer:
// the copy carried, or null from the menu, a picture of the page going instead). Submit with asks still open on the page
// asks first (the copy lying on it meanwhile), and Answer them first sends it back to the corner.
async function went(corner, kind, box, layer, v = shown(corner.book)) {
  const { book } = corner;
  if (!v) return layer?.remove();
  if (kind === 'submit') {
    const asks = openAsks(v.page),
      go = !asks.length || (await askedFirst(corner.lane, box, asks));
    corner.targets.hide();
    if (!go) return layer ? drop(corner, { layer, v }, null) : corner.ear.focus();
    return submit(book, v, layer, asks);
  }
  if (layer) fold(layer.getBoundingClientRect(), layer, box);
  else fold(book.desk.getBoundingClientRect(), picture(book.desk), box);
  const files = corner.files;
  // (a file downloaded, never the share sheet)
  (kind === 'call' ? callAbout(v.page, files.png) : downloaded(files[kind])).catch(e => said(book, v.page, e.message));
}

// A page sent or shared by tearing it off at its spine (board, card 341's call): a press at the page's right edge,
// where the spine is, drawn away to the left (a finger, the Pencil or a mouse) tears a copy of the page off with it,
// its edge jagged, with a soft tear of paper, and it shrinks into the hand as a small page; the page itself stays
// whole. Three targets come up over the paper (bookshare.js): Submit to the CEO, PDF and PNG. Let go on Submit, the
// page goes (bookpagesend.js); on PDF or PNG the copy folds into it and the file downloads; anywhere else, it goes back
// to the spine. Tear off and send in the bar's dots menu opens the same three as a small menu. With a call on, the
// call's window takes it too (calldrop.js). No dog-ear: nothing shows at the edge (board, call 190). Its look:
// bookshare.css.
import { foley } from '../audio.js';
import { picture } from './bookflip.js';
import { fold, tear } from './bookpaper.js';
import { said } from './booksave.js';
import { callAbout, downloaded, filesOf, mountTargets } from './bookshare.js';
import { askedFirst, openAsks, submit } from './bookpagesend.js';
import { shut } from './booksave.js';
import { button, island, islands, lineIcon } from './bookui.js';
import { word } from './bookscope.js';
import { callWindowAt, holdCallPosition, lightCall } from '../calldrop.js';

// how far a press moves to the left before the page comes off (less, or more down than across: the page's own, a
// stroke or a pan), how far in from the page's right edge a press takes it, and the copy's width held
const PEEL_PX = 10,
  SPINE_PX = 32,
  HELD_PX = 150;
// (a page held at its edge and drawn away: the page's top edge as perforated paper tears)
const ICON = lineIcon(
  '<path d="M6 21V3h12v18"/><path d="M6 7.5l2-1.2 2 1.2 2-1.2 2 1.2 2-1.2 2 1.2"/><path d="M12 11v6M9.5 14.5L12 17l2.5-2.5"/>',
);

// book: bookpages.js's. The page's right edge, by the spine, takes the press; the menu's row follows the page shown.
export function mountTear(book) {
  const item = button({ icon: ICON, label: word('tearOff'), onClick: () => menu(spine) });
  item.classList.add('bk-tear');
  island('menu').append(item);
  const spine = { book, item, files: null, lane: islands(), at: null };
  spine.targets = mountTargets(spine.lane, {
    act: (kind, box) => went(spine, kind, box, null),
    closed: () => backOnDots(spine),
  });
  const follow = () => {
    item.hidden = !shown(book);
    if (item.hidden) spine.targets.hide();
  };
  for (const type of ['book:turn', 'book:wrote']) document.addEventListener(type, follow);
  follow(); // (mounted late, after the first page's turn)
  book.paper.closest('.bk-leaf').addEventListener('pointerdown', e => pressed(spine, e));
}

// The page shown, or null (none yet); whether a page can be sent (a call's notes page goes as its call ends)
const shown = book => book.views[book.cur] ?? null;
const sendable = page => !shut(page) && page.kind !== 'call';

// The keys back on the dots that opened the menu (its own row is in the dots' menu only, never shown)
const backOnDots = spine => spine.lane.querySelector('.bk-more').focus();

// The targets as a menu, the page's files started
function menu(spine) {
  const v = shown(spine.book);
  if (!v) return;
  spine.files = filesOf(spine.book, v.page);
  spine.targets.menu(sendable(v.page));
}

// A press near the page's right edge, by the spine, below the blur and clear of the controls: drawn away to the left,
// the page comes off with it, the page letting go of the press (bookwrite.js, bookpan.js: lostpointercapture); moved
// more down than across, or let go first, it was the page's all along
function pressed(spine, down) {
  if (!down.isPrimary || (down.pointerType === 'mouse' && down.button !== 0)) return;
  const paper = spine.book.paper.getBoundingClientRect(),
    top = spine.book.desk.getBoundingClientRect().top;
  if (down.clientX < Math.min(paper.right, innerWidth) - SPINE_PX || down.clientY < top) return;
  if (down.target.closest?.('.bk-strip, .bk-bar, .bk-card, .bk-share, button, a, input, [contenteditable]')) return;
  if (spine.book.paper.closest('#book')?.hasAttribute('data-far')) return;
  const v = shown(spine.book),
    leaf = spine.book.paper.closest('.bk-leaf');
  if (!v) return;
  let carried = null;
  // (followed on the window, by its pointer: a finger's and the Pencil's stay with the page they pressed)
  const move = e => {
    if (e.pointerId !== down.pointerId) return;
    const dx = e.clientX - down.clientX,
      dy = e.clientY - down.clientY;
    if (!carried) {
      if (Math.abs(dy) > PEEL_PX && Math.abs(dy) > -dx) return end();
      if (-dx < PEEL_PX) return;
      try {
        leaf.setPointerCapture(down.pointerId);
      } catch {
        // (the window's moves carry it on)
      }
      spine.at = { x: down.clientX, y: down.clientY };
      carried = lift(spine, v, e);
    }
    carry(spine, carried, e);
  };
  const up = e => {
    if (e.pointerId !== down.pointerId) return;
    end();
    if (!carried) return;
    const target = e.type === 'pointerup' ? aimedAt(spine, e) : null;
    drop(spine, carried, target);
  };
  const end = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
}

// The page comes off the paper as a small copy held by its spine's edge (the pointer at its top-right), torn out at the
// spine as it shrinks into the hand, the targets over the paper, its files started so they're ready as it's let go
function lift(spine, v, e) {
  holdCallPosition(true);
  const desk = spine.book.desk,
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
  // (the paper clipped to its torn edge inside, its torn fibres under it, the shadow round both outside)
  layer.innerHTML = '<div class="bk-held-fibres"></div><div class="bk-held-sheet"></div>';
  const [fibres, sheet] = layer.children;
  sheet.append(copy);
  desk.closest('#book').append(layer);
  placeAt(layer, e);
  tear(sheet, fibres);
  foley('tear', { dur: 0.22 }, { vol: 0.07 });
  spine.files = filesOf(spine.book, v.page);
  spine.targets.carrying(sendable(v.page));
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
// Carried: the copy follows the pointer by its spine's edge, and the target under it lights
function carry(spine, { layer }, e) {
  placeAt(layer, e);
  const target = aimedAt(spine, e),
    onCall = !!target && !target.dataset.share;
  spine.targets.over(target);
  lightCall(onCall);
  layer.toggleAttribute('data-over', !!target);
}
// What the page is over: a target, the call's window, or null
const aimedAt = (spine, e) => spine.targets.under(e.clientX, e.clientY) ?? callWindowAt(e.clientX, e.clientY);
const placeAt = (layer, e) =>
  Object.assign(layer.style, { left: `${e.clientX - layer.offsetWidth + 12}px`, top: `${e.clientY - 12}px` });

// Let go: on Submit, the page goes; on PDF or PNG, the copy folds into it; anywhere else, it flies back to the spine
// where it was torn from (or the dots, from the menu)
async function drop(spine, { layer, v }, target) {
  lightCall(false);
  const box = target?.getBoundingClientRect();
  holdCallPosition(false);
  if (target?.dataset.share !== 'submit') spine.targets.hide();
  if (target) return went(spine, target.dataset.share ?? 'call', box, layer, v);
  const home = spine.at ?? { x: innerWidth, y: innerHeight / 2 },
    at = layer.getBoundingClientRect(),
    dx = home.x - at.right,
    dy = home.y - at.top;
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
// asks first (the copy lying on it meanwhile), and Answer them first sends it back to the spine.
async function went(spine, kind, box, layer, v = shown(spine.book)) {
  const { book } = spine;
  if (!v) return layer?.remove();
  if (kind === 'submit') {
    const asks = openAsks(v.page),
      go = !asks.length || (await askedFirst(spine.lane, box, asks));
    spine.targets.hide();
    if (!go) return layer ? drop(spine, { layer, v }, null) : backOnDots(spine);
    return submit(book, v, layer, asks);
  }
  if (layer) fold(layer.getBoundingClientRect(), layer, box);
  else fold(book.desk.getBoundingClientRect(), picture(book.desk), box);
  const files = spine.files;
  // (a file downloaded, never the share sheet)
  (kind === 'call' ? callAbout(v.page, files.png) : downloaded(files[kind])).catch(e => said(book, v.page, e.message));
}

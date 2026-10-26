// My notes, an outside reviewer's: every note not sent yet as one scrolling list, each with its screenshot as it went with
// the note (the spot marked on it, framed on the mark as the polaroid was; a tap shows the whole screen), its words in
// full and its page, and Change and Delete (two taps). The screenshots come from HQ's host (mine?shots), for the session
// this browser holds there, each loaded as it scrolls into view. (The board's notes are in its book, menu.js.)
// The words are the reviewer's: text only, never HTML.
import { ACCENT, button, line, post } from './base.js';
import { frameMark } from './frame.js';
import { paint, refresh, shut, unsure } from './menu.js';
import { uncoach } from './dock.js';
import { changeNote } from './change.js';

// a sidebar sliding in from the side (the whole width on a phone), every note a card in one scrolling list. Sized to
// what's visible (fitSide, below), it stays on screen on a zoomed or wide page.
export const CSS = `
      .side { pointer-events: auto; position: absolute; top: 0; right: 0; bottom: 0; width: min(440px, 100%); display: flex; background: var(--bg); color: var(--ink); transform-origin: 0 0;
        padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) 0;
        box-shadow: -1px 0 0 var(--line), -14px 0 34px rgb(20 28 45 / .18); animation: slide-in .3s cubic-bezier(.3,1.2,.5,1) both; }
      .side.whole { box-shadow: none; padding-left: env(safe-area-inset-left); }
      .dim { pointer-events: auto; position: absolute; inset: 0; background: rgb(20 28 45 / .3); }   /* beside it on a wider screen: a tap closes it */
      @keyframes slide-in { from { transform: translateX(100%) } }
      .side[hidden], .dim[hidden], .zoom[hidden], .side [hidden] { display: none; }
      .side .screen { flex: 1; min-width: 0; display: flex; flex-direction: column; max-height: none; overflow: hidden; padding: 0; }
      .side header { display: flex; align-items: center; gap: 6px; padding: 6px 6px 6px 16px; background: var(--card); border-bottom: 1px solid var(--line); }
      .side header .cap { flex: 1; margin: 0; }
      .side .x { flex: none; width: 44px; height: 44px; padding: 0; border-radius: 50%; text-align: center; font-size: 24px; font-weight: 400; line-height: 1; color: var(--muted); }
      .side ol { flex: 1; overflow: auto; overscroll-behavior: contain; list-style: none; margin: 0; padding: 2px 14px 14px; }
      .side li { margin: 12px 0 0; padding: 14px; border-radius: 16px; background: var(--card); box-shadow: var(--shadow); }
      .side .shot { position: relative; aspect-ratio: 4 / 3; padding: 0; overflow: hidden; border-radius: 10px; background: var(--bg); box-shadow: inset 0 0 0 1px var(--line); cursor: zoom-in; }
      .side .shot img { position: absolute; left: 0; top: 0; width: 100%; height: 100%; object-fit: contain; display: block; }   /* (the whole screen, where frame.js won't frame it) */
      .side .shot img.framed { max-width: none; object-fit: fill; }
      .side .words { margin: 12px 0 4px; font-size: 15px; white-space: pre-wrap; overflow-wrap: anywhere; }
      .side .pics { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 6px; padding: 0; list-style: none; }
      .side .pics button { width: 56px; height: 56px; padding: 0; overflow: hidden; border-radius: 8px; background: var(--bg); box-shadow: inset 0 0 0 1px var(--line); cursor: zoom-in; }
      .side .pics img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .side .where { overflow-wrap: anywhere; }
      .side .acts { display: flex; gap: 8px; margin-top: 12px; }
      .side .acts button { width: auto; padding: 8px 16px; border-radius: var(--btn-r); font-size: 14px; background: var(--soft); }
      .side .acts .sure, .side .acts .sure:hover { background: ${ACCENT}; color: #fff; }
      .side .oops { margin: 8px 0 0; font-size: 13px; color: #c23c44; }
      .side .oops:empty { display: none; }
      .side footer { display: flex; gap: 8px; padding: 10px 14px 12px; background: var(--card); border-top: 1px solid var(--line); }
      .side footer button { width: auto; margin: 0; }
      .side footer [data-close] { flex: none; padding: 10px 20px; border-radius: var(--btn-r); text-align: center; background: var(--soft); }   /* where a thumb reaches */
      .side footer .go { flex: 1; min-width: 0; margin: 0; }
      .side .empty { margin: 16px 4px; color: var(--muted); }
      /* a screenshot, bigger: the whole screen as it was, a tap or Escape puts it away */
      .zoom { pointer-events: auto; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
        background: rgb(10 12 18 / .9); cursor: zoom-out; animation: pop-in .25s cubic-bezier(.3,1.5,.5,1) both; }
      .zoom img { min-width: 0; max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 6px; box-shadow: 0 14px 40px rgba(0,0,0,.6); background: #fff; }`;

export const HTML = `<div class="dim" hidden></div><div class="side" hidden role="dialog" aria-label="My notes"><div class="screen">
        <header><p class="cap"></p><button class="x" aria-label="Close my notes">×</button></header>
        <ol></ol>
        <footer><button data-close>Close</button><button class="go" data-send hidden>Send my notes<small></small></button></footer></div></div>
      <div class="zoom" hidden role="dialog" aria-label="The screenshot, bigger"><img alt="The screen as it was, with the spot marked"></div>`;

const EMPTY = 'No notes waiting. Tap the red pin to leave one.';

export async function openSide(r) {
  shut(r);
  uncoach(r);
  r.tip.classList.remove('show');
  if (r.mode !== 'idle') return;
  r.side.hidden = r.dim.hidden = false;
  r.dock.hidden = true;
  r.zoom.hidden = true;
  fitSide(r);
  r.sideList.replaceChildren(line('empty', 'Loading your notes…'));
  r.side.querySelector('.x').focus();
  try {
    const res = await fetch(new URL('mine?shots', r.ROUTE), { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw new Error();
    r.state = await res.json();
    paint(r);
  } catch {
    if (!r.side.hidden)
      r.sideList.replaceChildren(line('empty', 'Couldn’t load your notes. Close this and try again.'));
    return;
  }
  if (r.side.hidden) return;
  r.showing?.disconnect();
  // (loads each screenshot as it comes near the list's view)
  r.showing =
    window.IntersectionObserver &&
    new IntersectionObserver(
      seen =>
        seen.forEach(e => {
          if (!e.isIntersecting) return;
          r.showing.unobserve(e.target);
          e.target.firstChild.src = e.target.dataset.src;
        }),
      { root: r.sideList, rootMargin: '600px 0px' },
    );
  r.sideList.replaceChildren(...r.state.list.map(n => entry(r, n)));
  if (!r.state.list.length) r.sideList.append(line('empty', EMPTY));
}
export function closeSide(r) {
  if (r.side.hidden) return;
  r.side.hidden = r.dim.hidden = r.zoom.hidden = true;
  r.showing?.disconnect();
  r.showing = null;
  unsure(r, r.sideSend);
  if (r.mode === 'idle') {
    r.dock.hidden = false;
    r.more.focus();
  }
}
// The fixed .ui follows the layout viewport, which a page laid out wider than the phone, or pinch-zoomed (iOS zooms
// into a box being typed in), makes bigger than the screen. So the sidebar is sized in screen pixels to the visual
// viewport and scaled back by the zoom, which keeps it, its × and its foot at the phone's own scale and on screen.
function fitSide(r) {
  const viewport = window.visualViewport;
  if (r.side.hidden || !viewport) return;
  // (its right edge the screen's, or the page's where HQ's book stands beside it: .ui is the page's box then.)
  const pageScale = viewport.scale,
    right = Math.min(viewport.offsetLeft + viewport.width, r.ui.clientWidth),
    screenWidth = (right - viewport.offsetLeft) * pageScale,
    wide = screenWidth > 560,
    sideWidth = wide ? 440 : screenWidth;
  r.side.classList.toggle('whole', !wide);
  Object.assign(r.side.style, {
    top: `${viewport.offsetTop}px`,
    left: `${right - sideWidth / pageScale}px`,
    right: 'auto',
    bottom: 'auto',
    width: `${sideWidth}px`,
    height: `${viewport.height * pageScale}px`,
    transform: pageScale === 1 ? '' : `scale(${1 / pageScale})`,
  });
}
// (a picture added to a note, or its screenshot)
function enlarge(r, url, what) {
  const img = r.zoom.querySelector('img');
  img.src = url;
  img.alt = what;
  r.zoom.setAttribute('aria-label', `${what}, bigger`);
  r.zoom.hidden = false;
}
// notes gone elsewhere (sent from another tab, a share that ended) leave an open sidebar too
export function dropGone(r) {
  if (r.side.hidden) return;
  for (const li of r.sideList.querySelectorAll(':scope > li'))
    if (!r.state.list.some(n => n.id === Number(li.dataset.id))) li.remove();
  if (!r.sideList.querySelector('li, .empty')) r.sideList.append(line('empty', EMPTY));
}
// a picture's button, loaded as it comes into view like the screenshot
function lazyPicture(r, url, cls, what, gone) {
  const b = button('', cls),
    img = new Image();
  b.setAttribute('aria-label', `Show the ${cls === 'shot' ? 'screenshot' : 'picture'} bigger`);
  img.alt = '';
  b.append(img);
  b.dataset.src = url;
  img.onerror = gone;
  if (r.showing) r.showing.observe(b);
  else img.src = url;
  b.onclick = () => enlarge(r, url, what);
  return b;
}
function entry(r, n) {
  const li = document.createElement('li');
  li.dataset.id = n.id;
  if (n.shot) {
    // (a device without the reader's session on HQ's host: the note alone)
    const b = lazyPicture(r, n.shot.url, 'shot', 'The screenshot', () => b.remove());
    const placement = frameMark(n.shot.mark, 4 / 3);
    if (placement) {
      b.firstChild.className = 'framed';
      Object.assign(b.firstChild.style, placement);
    }
    li.append(b);
  }
  const words = line('words', n.note);
  // the pictures added to it
  const added = document.createElement('ul');
  added.className = 'pics';
  for (const p of n.pictures ?? []) {
    const item = document.createElement('li');
    item.append(lazyPicture(r, p.url, 'pic', 'A picture added to the note', () => item.remove()));
    added.append(item);
  }
  const about = n.text ? `On “${n.text.slice(0, 60)}${n.text.length > 60 ? '…' : ''}” · ` : '';
  const where = line('where', `${n.kind === 'general' ? 'General note · written on ' : about}${n.page}`, 'small');
  const acts = document.createElement('div'),
    change = button('Change'),
    del = button('Delete'),
    oops = line('oops', '');
  acts.className = 'acts';
  acts.append(change, del);
  oops.setAttribute('aria-live', 'polite');
  li.append(words, ...(added.childElementCount ? [added] : []), where, acts, oops);
  // Change: the note's own sheet, its mark on the page again
  change.onclick = () => changeNote(r, n);
  del.onclick = () => deleting(r, n, li, del, oops);
  return li;
}
async function deleting(r, n, li, del, oops) {
  if (!del.dataset.sure) {
    del.dataset.sure = '1';
    del.classList.add('sure');
    del.textContent = 'Tap again to delete';
    return;
  }
  del.disabled = true;
  try {
    const res = await post(r.ROUTE, 'delete', { id: n.id });
    if (!res.ok && res.status !== 404) throw new Error(); // (404: gone already)
    li.remove();
    r.state.list = r.state.list.filter(x => x.id !== n.id);
    r.state.notes = r.state.list.length;
    paint(r);
    refresh(r);
    if (!r.state.list.length) r.sideList.append(line('empty', EMPTY));
  } catch {
    del.disabled = false;
    oops.textContent = 'Couldn’t delete it. Try again?';
  }
}

export function setupNotes(r) {
  r.side.querySelector('.x').onclick =
    r.side.querySelector('[data-close]').onclick =
    r.dim.onclick =
      () => closeSide(r);
  window.visualViewport?.addEventListener('resize', () => fitSide(r));
  window.visualViewport?.addEventListener('scroll', () => fitSide(r));
  r.zoom.onclick = () => (r.zoom.hidden = true);
}

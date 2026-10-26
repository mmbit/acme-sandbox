// Review mode's menu: a small button beside the pin, with the count of the reviewer's notes not sent yet: General note,
// My notes (the sidebar, notes.js), Send my notes, and once an outsider sent theirs, Add more notes. The pin stays just
// the pin.
import { ACCENT, label } from './base.js';
import { say, uncoach } from './dock.js';
import { closeSide, dropGone, openSide } from './notes.js';
import { general } from './postit.js';
import { stopMic } from './dictation.js';
import { reset } from './tool.js';

const MENU =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

// the menu, a quiet round button beside the pin with the count of notes not sent yet
export const CSS = `
      .more { pointer-events: auto; position: absolute; right: 70px; bottom: 12px; width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; touch-action: none;   /* (it drags the pin too) */
        background: rgba(255,255,255,.92); color: #2b2230; border: 1px solid rgba(43,34,48,.3); box-shadow: 0 2px 8px rgba(43,34,48,.15); }
      .more svg { width: 16px; height: 16px; }
      .more[aria-expanded="true"] { background: #2b2230; color: #fff; }
      .more .count { position: absolute; top: -8px; left: -8px; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 11px; background: #ffe66d; color: #2b2230;
        font-size: 12px; font-weight: 700; display: grid; place-items: center; box-shadow: 0 2px 0 #d9b92c; }
      .more .count:empty { display: none; }
      .more.boing { animation: boing .6s cubic-bezier(.3,1.6,.5,1); }
      .dock.left .more { right: auto; left: 70px; }
      .more[hidden], .menu[hidden], .menu [hidden] { display: none; }
      /* the menu and My notes look like the guest pages: plain cards in their colours */
      /* (100cqw: .ui's width, base.js) */
      .menu { pointer-events: auto; position: absolute; right: 0; bottom: 72px; width: min(290px, calc(100cqw - 24px)); padding: 6px; background: var(--card); color: var(--ink);
        border-radius: 18px; box-shadow: 0 0 0 1px var(--line), var(--shadow), 0 14px 34px rgb(20 28 45 / .16); animation: pop-in .3s cubic-bezier(.3,1.5,.5,1) both; }
      .menu.below { bottom: auto; top: 72px; }
      .dock.left .menu { right: auto; left: 0; }
      .screen { max-height: min(62vh, 440px); overflow: auto; padding: 4px 0 0; }
      .cap { margin: 4px 12px 6px; font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
      .screen button { display: block; width: 100%; padding: 10px 12px; border-radius: 12px; text-align: left; font-size: 15px; font-weight: 600; transition: background .15s, filter .15s; }
      .screen button:hover, .screen button:focus-visible { background: var(--soft); outline: 0; }
      .screen button:disabled { opacity: .6; }
      .screen small { display: block; margin-top: 1px; font-size: 13px; font-weight: 400; color: var(--muted); }
      .screen .go, .screen .go:hover, .screen .go:focus-visible { margin-top: 6px; border-radius: min(var(--btn-r), 16px); background: var(--accent); color: var(--on); }   /* Send my notes, Add more notes: the menu's way on */
      .screen .go:hover, .screen .go:focus-visible { filter: brightness(1.07); }
      .screen .go small { color: inherit; opacity: .85; }
      .screen .go.sure { background: ${ACCENT}; color: #fff; }`;

export const HTML = `<div class="menu" hidden role="menu" aria-label="Review mode"><div class="screen"><p class="cap"></p>
          <div class="items"><button role="menuitem" data-general>General note<small>About it all, not one spot</small></button>
            <button role="menuitem" data-list>My notes<small></small></button>
            <button role="menuitem" class="go" data-mine hidden>Send my notes<small></small></button>
            <button role="menuitem" class="go" data-again hidden>Add more notes<small>Pin away, then send them again</small></button></div></div></div>
        <button class="more" aria-label="Review mode’s menu: a general note, my notes" aria-haspopup="menu" aria-expanded="false">${MENU}<span class="count"></span></button>`;

const sendLine = r => (r.outside ? `To the ${r.OUTSIDE} crew` : 'Tick and send in HQ');

// The notes are the coordinator's (/__review/mine), read on every page and again when the browser brings one back or
// its tab is shown again: an outsider's wherever they pinned them on the link (the shop's pages and its apps'), the
// board's waiting on this product.
export async function refresh(r) {
  try {
    const res = await fetch(new URL('mine', r.ROUTE), { credentials: 'same-origin', cache: 'no-store' });
    if (res.ok) {
      r.state = await res.json();
      paint(r);
      dropGone(r);
    }
  } catch {
    /* this page's own count */
  }
  // inside HQ's frame the viewer bar's Send counts the board's notes waiting on this product, as listed here: a cue for
  // HQ only, whose Reviews shows the real ones
  if (!r.outside) r.toHq({ waiting: r.state.list.map(n => n.id) });
}
export function paint(r) {
  const n = r.state.notes,
    done = r.outside && r.state.sent,
    of = `${n} ${n === 1 ? 'note' : 'notes'}`;
  // sent, and nothing more to add (the share has ended for good): the tool is done on this page
  if (done && !r.state.more) {
    reset(r);
    r.fab.remove();
    r.more.remove();
    r.menu.remove();
    return;
  }
  r.more.querySelector('.count').textContent = done ? '' : n || '';
  r.fab.hidden = done;
  r.$('[data-general]').hidden = done;
  // every line one line in the menu's width, a phone's too: the count only in the caption, a sub-line only what its title
  // doesn't say
  r.$('.cap').textContent = done ? 'Sent · thank you!' : n ? `Review · ${of} to send` : 'Review mode';
  r.side.querySelector('.cap').textContent = `My notes${n ? ` · ${n} to send` : ''}`;
  r.notesItem.hidden = done || !n;
  label(r.notesItem, 'My notes', 'Read, change or delete');
  for (const b of [r.sendButton, r.sideSend]) {
    b.hidden = done || !n;
    if (!b.dataset.sure) label(b, 'Send my notes', sendLine(r));
  }
  r.again.hidden = !done;
}

// it opens over the pin (under it when the pin sits high) and shuts on a choice, a tap anywhere else or Escape; shut,
// a Send my notes that asked again starts over
export function unsure(r, b) {
  if (b.disabled) return;
  delete b.dataset.sure;
  b.classList.remove('sure');
  paint(r);
}
export function shut(r) {
  r.menu.hidden = true;
  r.more.setAttribute('aria-expanded', 'false');
  unsure(r, r.sendButton);
}
function opened(r) {
  if (r.dragged) {
    r.dragged = false;
    return;
  } // (it drags the pin too: dock.js)
  if (!r.menu.hidden) return shut(r);
  uncoach(r);
  r.tip.classList.remove('show');
  refresh(r);
  r.menu.hidden = false;
  r.more.setAttribute('aria-expanded', 'true');
  r.menu.classList.toggle('below', r.dock.getBoundingClientRect().top < r.menu.offsetHeight + 24);
}

// Send my notes, in the menu and at the sidebar's foot. An outsider's (two taps): their notes go to the crew, and they
// add no more (until its date they can take them up again: Add more notes). Once everyone invited has sent theirs, the
// crew gathers them
// The board's is a hand-over to HQ, where only its own ticks choose what goes (the page's code could post a send
// itself): inside HQ's frame it asks HQ for its send step (Reviews over the preview, at these notes), on HQ itself it
// opens Reviews there, in a tab of its own it opens HQ's Reviews at them.
function handOver(r) {
  shut(r);
  closeSide(r);
  const ids = r.state.list.slice(0, 50).map(n => n.id);
  if (r.framed) return r.toHq({ send: 1 });
  if (r.summoned) return dispatchEvent(new CustomEvent('review:send', { detail: ids }));
  window.open(`${r.HQ}/?open=notes&notes=${ids.join(',')}`, '_blank', 'noopener');
}
async function submit(r, b) {
  if (!b.dataset.sure) {
    b.dataset.sure = '1';
    b.classList.add('sure');
    label(b, 'Tap again to send', sendLine(r));
    return;
  }
  b.disabled = true;
  let failureLabel = { title: 'Couldn’t send', subtitle: 'Tap to try again' };
  try {
    const res = await fetch(new URL('submit', r.ROUTE), { method: 'POST', credentials: 'same-origin' });
    if (res.status === 403) failureLabel = { title: 'The link has ended', subtitle: 'Thank you for your notes!' };
    if (!res.ok) throw new Error(failureLabel.title);
    b.disabled = false;
    shut(r);
    closeSide(r);
    uncoach(r, false);
    r.state = { ...r.state, sent: true, more: false };
    await refresh(r);
    paint(r);
    say(r, `Sent to the ${r.OUTSIDE} crew. Thank you!`, r.state.more ? 4000 : 0);
  } catch {
    b.disabled = false;
    delete b.dataset.sure;
    b.classList.remove('sure');
    label(b, failureLabel.title, failureLabel.subtitle);
  }
}
// Add more notes: the same as on their door, right here
async function again(r) {
  r.again.disabled = true;
  try {
    const res = await fetch(new URL('more', r.ROUTE), { method: 'POST', credentials: 'same-origin' });
    if (!res.ok) throw new Error();
    shut(r);
    await refresh(r);
    say(r, 'Pin away! Send them again when done');
  } catch {
    label(r.again, 'Add more notes', 'Couldn’t: try again, or use your link');
  } finally {
    r.again.disabled = false;
  }
}

export function setupMenu(r) {
  r.state = { notes: 0, list: [], sent: r.SENT, more: r.SENT };
  paint(r);
  refresh(r);
  addEventListener('pageshow', e => e.persisted && refresh(r));
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh(r));
  r.more.onclick = () => opened(r);
  addEventListener('pointerdown', e => !e.composedPath().includes(r.host) && shut(r), true);
  r.ui.addEventListener('pointerdown', e => {
    if (!r.menu.contains(e.target) && !r.more.contains(e.target)) shut(r);
  });
  r.$('[data-general]').onclick = () => {
    shut(r);
    if (r.mode === 'idle') general(r);
  };
  r.notesItem.onclick = () => openSide(r);
  // A page that frames another page with its own pin (HQ's viewer) hides this one meanwhile ('review:cover', detail
  // true, then false); notes sent or discarded on that page count again ('review:notes')
  addEventListener('review:cover', e => {
    r.covered = !!e.detail;
    if (r.covered) {
      shut(r);
      stopMic(r);
    }
    r.host.style.display = r.covered ? 'none' : 'block';
  });
  if (r.covered) r.host.style.display = 'none'; // (covered while it loaded)
  addEventListener('review:notes', () => refresh(r));
  for (const b of [r.sendButton, r.sideSend]) b.onclick = () => (r.outside ? submit(r, b) : handOver(r));
  r.again.onclick = () => again(r);
}

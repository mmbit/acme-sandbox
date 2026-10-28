// Review mode's menu: a small button beside the pin: General note, and the board's Open the book, whose sheet for the
// page's owner its notes join (the board's count is that sheet's). An outsider's notes join the board's sheet as they
// write them: their menu says so. The pin stays just the pin.
import { label } from './base.js';
import { uncoach } from './dock.js';
import { general } from './postit.js';
import { stopMic } from './dictation.js';

const MENU =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

// the menu, a quiet round button beside the pin with the count of the board's notes on the sheet
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
      /* the menu looks like the guest pages: a plain card in their colours */
      /* (100cqw: .ui's width, base.js) */
      .menu { pointer-events: auto; position: absolute; right: 0; bottom: 72px; width: min(290px, calc(100cqw - 24px)); padding: 6px; background: var(--card); color: var(--ink);
        border-radius: 18px; box-shadow: 0 0 0 1px var(--line), var(--shadow), 0 14px 34px rgb(20 28 45 / .16); animation: pop-in .3s cubic-bezier(.3,1.5,.5,1) both; }
      .menu.below { bottom: auto; top: 72px; }
      .dock.left .menu { right: auto; left: 0; }
      .screen { max-height: min(62vh, 440px); overflow: auto; padding: 4px 0 0; }
      .cap { margin: 4px 12px 6px; font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
      .screen button { display: block; width: 100%; padding: 10px 12px; border-radius: 12px; text-align: left; font-size: 15px; font-weight: 600; transition: background .15s, filter .15s; }
      .screen button:hover, .screen button:focus-visible { background: var(--soft); outline: 0; }
      .screen small { display: block; margin-top: 1px; font-size: 13px; font-weight: 400; color: var(--muted); }
      .screen .go, .screen .go:hover, .screen .go:focus-visible { margin-top: 6px; border-radius: min(var(--btn-r), 16px); background: var(--accent); color: var(--on); }   /* Open the book: the menu's way on */
      .screen .go:hover, .screen .go:focus-visible { filter: brightness(1.07); }
      .screen .go small { color: inherit; opacity: .85; }`;

export const HTML = `<div class="menu" hidden role="menu" aria-label="Review mode"><div class="screen"><p class="cap"></p>
          <div class="items"><button role="menuitem" data-general>General note<small>About it all, not one spot</small></button>
            <button role="menuitem" class="go" data-open-book hidden>Open the Notebook<small></small></button></div></div></div>
        <button class="more" aria-label="Review mode’s menu: a general note" aria-haspopup="menu" aria-expanded="false">${MENU}<span class="count"></span></button>`;

// The board's: whose sheet a note on this page joins and how many are on it (the coordinator's /__review/mine; book:
// { owner, name }), read on every page and again when the browser brings one back or its tab is shown again.
export async function refresh(r) {
  if (r.outside) return;
  try {
    const mine = new URL('mine', r.ROUTE);
    mine.searchParams.set('page', location.href);
    // (on HQ, the sheet the board's last note went to)
    if (r.book && r.lastOwner) mine.searchParams.set('owner', r.lastOwner);
    const res = await fetch(mine, { credentials: 'same-origin', cache: 'no-store' });
    if (res.ok) {
      r.state = await res.json();
      paint(r);
    }
  } catch {
    /* this page's own count */
  }
}
// every line one line in the menu's width, a phone's too: the count only in the caption, a sub-line only what its title
// doesn't say. An outsider's: where their notes go.
export function paint(r) {
  if (r.outside) {
    r.$('.cap').textContent = `Review · to ${r.OUTSIDE}’s book`;
    return;
  }
  r.more.querySelector('.count').textContent = r.state.notes || '';
  paintBook(r);
}
// The board's: where its notes go, and the way there.
function paintBook(r) {
  const n = r.state.notes,
    name = r.state.book?.name;
  // (the board's notes go to its Notebook's newest page)
  r.$('.cap').textContent = n ? `${n} on your Notebook’s newest page` : 'Review mode';
  r.bookButton.hidden = !name;
  if (name) label(r.bookButton, 'Open the Notebook', 'At its newest page');
}

// it opens over the pin (under it when the pin sits high) and shuts on a choice, a tap anywhere else or Escape
export function shut(r) {
  r.menu.hidden = true;
  r.more.setAttribute('aria-expanded', 'false');
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

// Open the book, the board's: at the sheet its notes here join. The book is HQ's, behind its sign-in, where the board
// sees every note before its plane sends a sheet: inside HQ's frame it asks HQ to open it there, on HQ itself it asks
// the page ('review:book'), in a tab of its own it opens HQ.
function openBook(r) {
  shut(r);
  const owner = r.state.book?.owner;
  if (!owner) return;
  if (r.framed) return r.toHq({ book: owner });
  if (r.summoned) return dispatchEvent(new CustomEvent('review:book', { detail: owner }));
  window.open(`${r.HQ}/?open=book&owner=${encodeURIComponent(owner)}`, '_blank', 'noopener');
}
export function setupMenu(r) {
  r.bookButton = r.$('[data-open-book]');
  r.state = { notes: 0 };
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
  // A page that frames another page with its own pin (HQ's viewer) hides this one meanwhile ('review:cover', detail
  // true, then false)
  addEventListener('review:cover', e => {
    r.covered = !!e.detail;
    if (r.covered) {
      shut(r);
      stopMic(r);
    }
    r.host.style.display = r.covered ? 'none' : 'block';
  });
  if (r.covered) r.host.style.display = 'none'; // (covered while it loaded)
  // HQ's feature tip asks where the pin is ('review:pin'): the pin goes in the event's detail.
  // (away, there's no pin to show)
  if (r.summoned) addEventListener('review:pin', e => !r.covered && !r.away && !r.fab.hidden && (e.detail.pin = r.fab));
  r.bookButton.onclick = () => openBook(r);
}

// A Notebook page sent whole (knowledge/notes/platform/notebook.md), each of its groups as a note to the agent whose
// work it was cut from (or as the CEO's routing check decides). The board's goes one way only: a copy torn from the
// dog-ear and let go on Submit (bookdogear.js). It goes at once, never undone; the copy folds into a paper plane and
// flies off from where it was let go, with a whoosh, and the page itself stays where it is: the Sent stamp is pressed
// on it as the plane goes, and it's locked (no tools come back on it: bookcontrols.js). Asks still open on it, a small
// card over Submit asks first: send now, the open asks moved to a new page to answer there, or answer them first.
// An invited person's page goes by its Send key (bookcontrols.js), with 10 seconds to undo from a toast, the book left
// on the page under it. A page sending or sent wears the stamp at its head, Sent and the time once it's gone, still
// wet till then, and its own groups are read-only (booksave.js); its answers and replies still come and go. (the board's
// tear to Submit)
import { esc } from '../../util.js';
import { foley } from '../audio.js';
import { toast } from '../toast.js';
import { plane, stamp } from './bookpaper.js';
import { picture } from './bookflip.js';
import { keep } from './bookedit.js';
import { said, saved, shut } from './booksave.js';
import { sendPage, undoSend } from './notebookdata.js';
import { viewOf } from './bookview.js';
import { scope, word } from './bookscope.js';

// how long an invited person's send waits to go (notebooksend.ts SEND_MS), and a little after, to read the page once
// it's gone; the stamp's press before their page folds; the board's stamp pressed this long after the copy is let go,
// as its plane leaves (the deck's film: the fold, the flight, then the stamp)
const SEND_MS = 10_000,
  AFTER_MS = 600,
  PRESS_MS = 260,
  STAMP_MS = 1300;

// The board's page v (the book's view of it, bookpages.js) torn out and let go on Submit: copy, the carried copy (null
// from the menu: a picture of the page goes), aside, the groups whose asks were still open, set aside on a new page.
export async function submit(book, v, copy, aside = []) {
  const { page } = v,
    from = copy ? copy.getBoundingClientRect() : book.desk.getBoundingClientRect();
  copy?.removeAttribute('data-over'); // (its size as it was let go is the plane's: bookshare.css)
  plane(from, copy ?? picture(book.desk));
  foley('flip', { material: 'paper', dur: 0.25 }, { vol: 0.35 });
  foley('slide', { material: 'paper', dur: 0.55 }, { vol: 0.3, at: 0.35 });
  const pressed = new Promise(r => setTimeout(r, STAMP_MS));
  try {
    await saved(book, page);
  } catch {
    return; // (the save that failed said why on the page: the store's older groups don't go in its place)
  }
  let answer;
  try {
    answer = await sendPage(
      book.dev,
      page.id,
      aside.map(g => g.id),
    );
  } catch (e) {
    return said(book, page, e.message);
  }
  // (what was drawn on it before can't be undone now: its groups are sent)
  keep(book.steps, s => s.page !== page);
  await pressed;
  went(book, page, answer);
  foley('stamp', { peel: 0.5 }, { vol: 0.5 });
  book.controls?.update();
}

// The groups on a page with an agent's ask on them still waiting on the board (bookasks.js), in the page's order
export const openAsks = page =>
  [...(page.groups?.values() ?? [])].filter(g => (g.asks ?? []).some(a => a.status !== 'answered'));

// The card that opens from Submit when asks are still open on the page (lane: the line the targets show in, bookui.js;
// at: Submit's box on the screen): whether to send now, those asks moved to a new page (true), or answer them first
// (false, as Escape or a tap away). The page stays in view behind it.
export function askedFirst(lane, at, asks) {
  const n = asks.flatMap(g => g.asks.filter(a => a.status !== 'answered')).length,
    names = [...new Set(asks.flatMap(g => g.asks.map(a => a.name ?? 'An agent')))],
    whose = names.map(name => `${name}’s`).join(' and ');
  const card = document.createElement('div');
  card.className = 'bk-asks-open';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Asks still open');
  card.innerHTML = `<p class="bk-asks-open-head"><i aria-hidden="true"></i>${esc(
    n === 1 ? '1 ask is still open' : `${n} asks are still open`,
  )}</p><p class="bk-asks-open-whose">${esc(`${whose} ${n === 1 ? 'ask waits' : 'asks wait'} on you`)}</p><button type="button" data-go>${esc(
    n === 1 ? 'Send now, move it to a new page' : 'Send now, move them to a new page',
  )}</button><button type="button" data-wait>${esc(n === 1 ? 'Answer it first' : 'Answer them first')}</button>`;
  lane.append(card);
  // (its tail points down at Submit: the card's left by its layout, as it scales in)
  const left = lane.getBoundingClientRect().left + card.offsetLeft - card.offsetWidth / 2;
  card.style.setProperty('--bk-tail', `${Math.round(at.left + at.width / 2 - left)}px`);
  card.querySelector('[data-go]').focus();
  return new Promise(done => {
    const end = go => {
      removeEventListener('pointerdown', away, true);
      card.remove();
      done(go);
    };
    const away = e => !card.contains(e.target) && end(false);
    addEventListener('pointerdown', away, true);
    card.addEventListener(
      'click',
      e => e.target.closest('[data-go], [data-wait]') && end(!!e.target.closest('[data-go]')),
    );
    card.addEventListener('keydown', e => e.key === 'Escape' && end(false));
  });
}

// An invited person's Send key (bookcontrols.js). book: bookpages.js's. hooks: { pagesAgain() (the notebook's pages read again, a promise), show(id) (a page turned
// to), under(id) (a page shown at once, under what covers the paper) }
export async function sendShown(book, hooks) {
  const v = viewOf(book),
    page = v?.page;
  if (!page || shut(page)) return;
  try {
    await saved(book, page);
  } catch {
    return; // (the save that failed said why on the page: the store's older groups don't go in its place)
  }
  let answer;
  try {
    answer = await sendPage(book.dev, page.id);
  } catch (e) {
    return said(book, page, e.message);
  }
  const step = { page, undo: () => takeBack(book, page, hooks), redo: null };
  // (what was drawn on it before can't be undone now: its groups are sent)
  keep(book.steps, s => s.page !== page);
  book.steps.push(step);
  went(book, page, answer);
  toast(word('<b>Sent.</b> It goes in 10 seconds: tap to undo'), () => {
    if (book.steps.includes(step)) keep(book.steps, s => s !== step);
    step.undo();
  });
  setTimeout(() => hooks.pagesAgain().then(() => stamped(book, page)), SEND_MS + AFTER_MS);
  await flown(book, page, hooks);
}
// The page sent, stamped, folds into a plane and flies off, the page after it shown under it at once (after the last,
// the fresh page the store made, once read). Left as it is if the board turned away meanwhile.
async function flown(book, page, hooks) {
  const after = () => book.views[book.views.findIndex(v => v.page === page) + 1];
  const read = after() ? null : hooks.pagesAgain();
  await new Promise(r => setTimeout(r, PRESS_MS));
  await read;
  const next = after();
  if (!next || viewOf(book)?.page !== page) return;
  plane(book.desk.getBoundingClientRect(), picture(book.desk));
  hooks.under(next.page.id);
}
// A send taken back in its seconds: the page open again and turned back to
async function takeBack(book, page, hooks) {
  try {
    went(book, page, await undoSend(book.dev, page.id));
  } catch (e) {
    return toast(esc(e.message));
  }
  await hooks.pagesAgain();
  hooks.show(page.id);
}
// A page as the store says it is after a send or its undo: its stamp, and its groups' clips
function went(book, page, answer) {
  Object.assign(page, { sending: answer.sending, sent: answer.sent, updated: answer.updated });
  book.groups?.drawn(page);
  stamped(book, page, true);
}
// The stamp at a page's head: SENT and the time it went (the deck's, in the accent), its ink still wet till then; none
// on an open page (el: its view's, one not yet in the book's). Pressed down as the page is sent (fresh).
export function stamped(book, page, fresh = false, el = book.views.find(x => x.page === page)?.el) {
  const node = el?.querySelector('[data-slot=stamp]');
  if (!node) return;
  // (a call's notes page is stamped once its call's follow-up has handed out what's on it: the store's sent, never
  // sending.)
  if (!page.sent && !page.sending) {
    node.replaceChildren();
    return node.classList.remove('bk-stamped', 'bk-stamp-wet');
  }
  const time = page.sent ? timeOf(page.sent) : '',
    when = time.toLocaleUpperCase();
  node.classList.toggle('bk-stamp-wet', !page.sent);
  if (!fresh && node.firstChild && node.dataset.when === when) return;
  node.dataset.when = when;
  const label = time ? word('Sent {time}', { time }) : word('Sent');
  const words = `${word('Sent').toLocaleUpperCase()} ${when}`.trim(),
    w = 30 + words.length * 15;
  node.innerHTML = `<svg viewBox="0 0 ${w} 48" width="${Math.round((w * 38) / 48)}" height="38" role="img" aria-label="${esc(label)}"><rect x="2" y="2" width="${w - 4}" height="44" rx="7"/><text x="${w / 2}" y="32" text-anchor="middle">${esc(words)}</text></svg>`;
  node.classList.add('bk-stamped');
  if (fresh) stamp(node);
}
const timeOf = at =>
  new Date(at).toLocaleString(scope ? document.documentElement.lang : undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

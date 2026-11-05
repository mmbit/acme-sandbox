// The opened scrap's own keys, beside Klaar on its sheet (bookscrapopen.js book.scrap.key): Beantwoord on a scrap handed
// to whoever opened it sends the answer back and closes it (Klaar alone only saves), and on one where an agent waits on
// the board (its card open on it, or its answer under it) sends what was drawn and typed on it to that agent
// (bookslipreply.js); and ⋯, a small
// menu: Geef aan… (the board's, to anyone invited) and, last and apart, Scrap weggooien. Throwing away is tucked there
// on purpose, never a key of its own: one an agent made asks once more. It closes the sheet, and on the grid the
// card crumples and falls straight down, Undo a step and in the toast (bookgroups.js drop). Every key acts as the pen
// or a finger lifts on it, Safari's click or none (bookcontrols.js onEveryTap). Its look: bookscrapkeys.css.
import { esc, stylesheet } from '../../util.js';
import { toast } from '../toast.js';
import { onEveryTap } from './bookcontrols.js';
import { scope, word } from './bookscope.js';
import { shut } from './booksave.js';
import { viewOf } from './bookview.js';
import { answerGroup } from './notebookdata.js';
import { replyFromScrap, seen, turnOf } from './bookslipreply.js';
import { answerFromScrap } from './bookasks.js';
import { cardOf, put } from './bookcard.js';

stylesheet('shell/ink/bookscrapkeys.css');

// the menu hangs this far (px) under its key
const MENU_GAP_PX = 6;

// book: bookpages.js's, once book.scrap is there. Each scrap opened gets its keys.
export function mountScrapKeys(book) {
  // (keys: this scrap's, off the sheet again as it closes: the sheet and Klaar stay for the next)
  const ks = { book, menu: null, keys: [] };
  document.addEventListener('book:scrap-open', e => opened(ks, e.detail));
  document.addEventListener('book:scrap-close', () => {
    shutMenu(ks);
    for (const k of ks.keys.splice(0)) k.remove();
  });
}

// A scrap opened ({ gid, page }): its keys on its sheet
function opened(ks, { gid, page }) {
  // (the group as the grid last read it: the opened scrap's own record is read again only as it opens)
  const { book } = ks,
    g = page.parent?.groups?.get(gid) ?? page.groups?.get(gid);
  if (!g || shut(page)) return;
  // (a copy handed to this side; else an agent's card open on it or its answer under it, what's drawn on it since now
  // going: bookslipreply.js.)
  seen(page);
  const handed = g.question && !g.question.answered && !g.asks?.length,
    turn = handed ? null : turnOf(g);
  if (handed || turn) ks.keys.push(answerKey(ks, gid, turn));
  ks.keys.push(moreKey(ks, gid, page));
  for (const k of ks.keys) book.scrap.key(k);
}

// ---- Beantwoord

// (turn: what an agent waits on, bookslipreply.js turnOf; null: a scrap handed to this side, answered by the store's
// Answer)
function answerKey(ks, gid, turn) {
  const b = keyOf(word('answerKey'), 'bk-scrap-answer');
  b.textContent = word('answerKey');
  onEveryTap(b, async () => {
    b.disabled = true;
    try {
      const view = viewOf(ks.book);
      if (turn?.ask) await answerFromScrap(ks.book, view, gid, turn.ask);
      else if (turn?.answer) await replyFromScrap(ks.book, view.page, gid, turn.answer);
      else {
        const { group } = await answerGroup(ks.book.dev, gid);
        const had = view?.page.groups?.get(gid);
        if (had) had.question = group.question;
      }
      toast(esc(word('answerSent')));
      ks.book.scrap.close();
    } catch (e) {
      b.disabled = false;
      toast(esc(e.message));
    }
  });
  return b;
}

// ---- ⋯ and its menu

function moreKey(ks, gid, page) {
  const b = keyOf(word('scrapMore'), 'bk-scrap-more');
  b.setAttribute('aria-haspopup', 'menu');
  b.innerHTML = '<i></i><i></i><i></i>';
  onEveryTap(b, () => (ks.menu ? shutMenu(ks) : menuOf(ks, b, gid, page)));
  return b;
}
// The menu under its key: Geef aan… (the board's), then under a rule Scrap weggooien
function menuOf(ks, from, gid, page) {
  const card = cardOf('bk-scrap-menu', word('scrapMore'));
  card.innerHTML = `${scope ? '' : row('give', word('scrapGive'))}${row('drop', word('scrapThrowAway'))}`;
  const r = from.getBoundingClientRect(),
    room = ks.book.desk.getBoundingClientRect();
  put(card, r.right - card.offsetWidth, r.bottom + MENU_GAP_PX, room);
  const away = e => !card.contains(e.target) && !from.contains(e.target) && shutMenu(ks);
  const keys = e => e.key === 'Escape' && shutMenu(ks);
  addEventListener('pointerdown', away, true);
  addEventListener('keydown', keys);
  ks.menu = { card, off: () => (removeEventListener('pointerdown', away, true), removeEventListener('keydown', keys)) };
  for (const b of card.querySelectorAll('[data-act]'))
    onEveryTap(b, () => (b.dataset.act === 'give' ? give(ks, gid) : dropAsked(ks, gid, page)));
}
function shutMenu(ks) {
  ks.menu?.off();
  ks.menu?.card.remove();
  ks.menu = null;
}

// Geef aan…: the sheet put back, then the short list beside the scrap's card on the grid (bookassign.js)
async function give(ks, gid) {
  shutMenu(ks);
  const card = await closedTo(ks, gid);
  if (card) ks.book.assign?.give(viewOf(ks.book), gid, card.getBoundingClientRect(), card);
}
// Scrap weggooien: one an agent made asks once more, in the menu itself
function dropAsked(ks, gid, page) {
  const by = agentOf(page.groups.get(gid));
  if (!by) return drop(ks, gid);
  const { card } = ks.menu;
  card.innerHTML = `<p class="bk-scrap-ask">${esc(word('scrapByAgent', { name: by }))}</p><div class="bk-scrap-choose"
    >${row('keep', word('keepIt'))}${row('drop', word('throwAway'))}</div>`;
  for (const b of card.querySelectorAll('[data-act]'))
    onEveryTap(b, () => (b.dataset.act === 'drop' ? drop(ks, gid) : shutMenu(ks)));
}
// The sheet put back, its card crumpling and falling on the grid, Undo a step
async function drop(ks, gid) {
  shutMenu(ks);
  const card = await closedTo(ks, gid),
    view = viewOf(ks.book);
  if (card && view?.page.groups?.has(gid)) ks.book.groups.drop(view, gid);
}
// The sheet closed and its card back in its place on the grid (its flight down done): the card, or null
async function closedTo(ks, gid) {
  await ks.book.scrap.close();
  return viewOf(ks.book)?.el.querySelector(`.bk-unit[data-unit="${gid}"]`) ?? null;
}

// ---- shared

// The agent who made a group, by name, or null: the board's own and a guest's are nobody's to ask about
function agentOf(g) {
  const by = g?.by;
  if (!by || by === 'board' || by.startsWith('guest:')) return null;
  return g.by_name ?? g.owner_name ?? by.charAt(0).toUpperCase() + by.slice(1);
}
// A key on the sheet, labelled
function keyOf(label, kind) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `bk-scrap-key ${kind}`;
  b.setAttribute('aria-label', label);
  b.title = label;
  return b;
}
// A row of the menu
const row = (act, text) =>
  `<button type="button" class="bk-row bk-scrap-row" role="menuitem" data-act="${act}" style="--i:0"><span
    class="bk-name">${esc(text)}</span></button>`;

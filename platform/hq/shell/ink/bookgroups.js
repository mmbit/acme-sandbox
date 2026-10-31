// The groups on a Notebook page as the board sees them (knowledge/notes/platform/notebook.md), each a scrap unit the
// page lays (bookunits.js): picked with Select (bookselect.js), whose bar has its Move to page… and its Delete. A
// scrap's post-it words in its body under its picture (typed in and edited with the pen while its page is open:
// bookamend.js); and under each unit its answers (review mode's slips: a tick, and words written under one go as a
// reply) with the board's replies, a reply's Undo there in its seconds, then the agents' desk-phone cards about it
// (bookasks.js), one still open edged red (bookforyou.js). A group deleted crumples away at once, Undo a tap away in a
// toast and on the book's Undo; a scratch-out written over a group deletes it the same way. A sent page's own groups are read-only.
// What's saved is booksave.js's; the maths bookgroupmath.js's. Its look: bookgroups.css.
import { aiMark, notebookRequest, word } from './bookscope.js';
import { esc, stylesheet } from '../../util.js';
import { toast } from '../toast.js';
import { sfx } from '../audio.js';
import { crumple } from './bookpaper.js';
import { thingsPicture } from './bookpaperdraw.js';
import { boundsOf, union } from './bookselectmath.js';
import { CSS as SLIP_CSS, slipHtml, wireSlips } from '/__review/slip.js';
import { scribbled } from '/__review/gestures.js';
import { keepFromScribble } from '/__review/penwords.js';
import { scratched } from './bookgroupmath.js';
import { boxOf, slipsUnder } from './notebookstack.js';
import { edit, keep } from './bookedit.js';
import { readAgain, saved, shut, typed } from './booksave.js';
import { deleteReply, moveGroup, reply } from './notebookdata.js';
import { nameOf } from './bookhead.js';
import { asksHtml, wireAsks } from './bookasks.js';
import { mountShow } from './bookgroupshow.js';
import { markOpen } from './bookforyou.js';
import { tagsHtml } from './bookassignlist.js';

// a reply can be taken back this long after it's written (notebooksend.ts SEND_MS)
const REPLY_MS = 10_000;
const LISTS = { ink: 'ink', texts: 'texts', pictures: 'scraps' };
// book: bookpages.js's. hooks: { lay(), refresh(view), pages() (the notebook's open pages, [page]), turnTo(page) }.
// Returns { added(view), drawn(page), scratch(view, line), lone(view, picked) }: a view's layer made, a page's groups
// drawn again (read or saved), a line written over a group that deletes it (true: not ink), and what Select's bar does
// with one whole group picked.
export function mountGroups(book, hooks) {
  stylesheet('shell/ink/bookgroups.css');
  if (!document.querySelector('style[data-slips]')) {
    const style = Object.assign(document.createElement('style'), { textContent: SLIP_CSS });
    style.dataset.slips = '';
    document.head.append(style);
  }
  const gs = { book, hooks, menu: null };
  mountShow(book); // (a scrap just saved, shown)
  return {
    added: view => layerOf(gs, view),
    drawn: page => {
      const view = book.views.find(v => v.page === page);
      if (view) draw(gs, view);
    },
    scratch: (view, line) => scratchOut(gs, view, line),
    lone: (view, picked) => lone(gs, view, picked),
  };
}

// ---- drawn on the page

function layerOf(gs, view) {
  let layer = view.el.querySelector(':scope > .bk-groups');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'bk-groups';
    view.el.append(layer);
    // (a reply left empty: the groups drawn as they are now, if they waited for it)
    layer.addEventListener('input', () => view.groupsLater && draw(gs, view));
  }
  return layer;
}
// A page's groups drawn on it: the clip of one that holds two or more things, a scrap's words, its answers and replies
// under it. Not while a reply is being written under an answer, which drawing them anew would take away (or send half
// written, as its field's blur sends it): then once it's sent or left empty. A reply field the board is in and hasn't
// written in yet keeps the board in it.
function draw(gs, view) {
  const { page } = view,
    layer = layerOf(gs, view),
    open = !shut(page);
  view.groupsLater = [...layer.querySelectorAll('.slip-reply')].some(f => f.value.trim());
  if (view.groupsLater) return;
  const inReply = document.activeElement?.matches('.slip-reply') && layer.contains(document.activeElement);
  const focused = inReply && document.activeElement.closest('[data-slip]').dataset.slip;
  const caret = caretIn(layer);
  // (the page whose groups these are: book-check finds a page's things by it, a lone one having no clip)
  layer.dataset.page = page.id;
  layer.innerHTML = [...(page.groups?.values() ?? [])]
    .map(g => {
      // (a group whose elements are all off the page, deleted and not yet saved, is drawn no more)
      const { box } = partsNow(page, g.id);
      if (!box) return '';
      // (a scrap's words part of its body, under its picture; its answers and replies under the unit, and whom it
      // went to at its corner: bookunits.js places them. A scrap is a unit, no clip: Select's bar has its menu. job #14672)
      const words = g.kind === 'scrap' ? wordsHtml(page, g, open) : '';
      const under = slipsHtml(g.children ?? []) + asksHtml(g);
      return `${words ? `<div class="bk-words" data-g="${g.id}">${words}</div>` : ''}${
        under ? `<div class="bk-under" data-g="${g.id}">${under}</div>` : ''
      }${tagsHtml(g)}`;
    })
    .join('');
  wireSlips(layer, slipsOn(gs, view), word);
  wireAsks(layer, {
    dev: gs.book.dev,
    asks: new Map([...(page.groups?.values() ?? [])].flatMap(g => g.asks ?? []).map(a => [a.id, a])),
    answered: () => readAgain(gs.book, page),
  });
  wireWords(gs, page, layer);
  for (const b of layer.querySelectorAll('[data-unreply]'))
    b.addEventListener('click', () => unreply(gs, view, Number(b.dataset.unreply)));
  // (the words' and answers' touches are their own: never the page's pan or ink. A scrap's words kept from Scribble
  // for the pen take its strokes on the page: bookamend.js)
  for (const el of layer.querySelectorAll('.bk-words, .bk-under'))
    for (const type of ['pointerdown', 'touchstart'])
      el.addEventListener(type, e => e.target.matches('[data-pen]') || e.stopPropagation());
  if (focused) layer.querySelector(`[data-slip="${focused}"] .slip-reply`)?.focus();
  if (caret) caretBack(layer, caret);
  // (what hangs under each unit counted in its place, and moved to its foot: bookunits.js. job #14672)
  view.relay?.();
  markOpen(view, layer);
  gs.book.controls?.update();
}
// A scrap's words being typed in, whose caret and words as typed the groups drawn again keep: { g, at, words } (null:
// none). The words as typed go back while they're what's drawn but for the spaces at their ends, which the store
// trims: words changed on another screen meanwhile show.
function caretIn(layer) {
  const f = document.activeElement;
  if (!f?.matches('textarea.bk-scrap-words') || !layer.contains(f)) return null;
  return { g: f.closest('[data-g]').dataset.g, at: [f.selectionStart, f.selectionEnd], words: f.value };
}
function caretBack(layer, caret) {
  const f = layer.querySelector(`[data-g="${caret.g}"] textarea.bk-scrap-words`);
  if (!f) return;
  if (f.value === caret.words.trim()) f.value = f.parentElement.dataset.words = caret.words;
  f.focus({ preventScroll: true });
  f.setSelectionRange(...caret.at);
}
// The scraps' words fields: kept from Scribble for the pen, what's typed saved (and grown into)
function wireWords(gs, page, layer) {
  for (const f of layer.querySelectorAll('textarea.bk-scrap-words')) {
    const id = Number(f.closest('[data-g]').dataset.g);
    f.pen = keepFromScribble(f);
    f.addEventListener('input', () => {
      f.parentElement.dataset.words = f.value;
      typed(gs.book, page, id, f.value);
    });
  }
}
// A scrap's post-it words: while its page is open a field, its words typed in or edited with the pen saved to its
// group (booksave.js typed), growing with them (a copy of them under it, unseen, gives its height); once it's sent,
// read-only words
function wordsHtml(page, g, open) {
  const words = page.typed?.get(g.id) ?? g.words;
  if (!open) return words ? `<p class="bk-scrap-words">${esc(words)}</p>` : '';
  return words || page.typed?.has(g.id)
    ? `<div class="bk-scrap-post" data-words="${esc(words)}"><textarea class="bk-scrap-words" rows="1" aria-label="${word("The scrap's words")}">${esc(
        words,
      )}</textarea></div>`
    : '';
}
// The board's reply under an answer, and its Undo while it's in its seconds
function replyHtml(r) {
  const words = r.words || (r.ink?.length ? word('Written reply') : '');
  const fresh = Date.now() - Date.parse(r.created) < REPLY_MS;
  return `<p class="bk-reply" data-reply="${r.id}"><b>${word('You')}</b> ${esc(words)}${
    fresh ? ` <button type="button" class="bk-unreply" data-unreply="${r.id}">${word('Undo')}</button>` : ''
  }</p>`;
}
// A group's elements as they are on the page now: their box, for where its clip and answers go (null: none), how
// many there are, whether it has a clip, and themselves by kind
function partsNow(page, id) {
  const parts = { ink: [], texts: [], pictures: [] };
  for (const [kind, list] of Object.entries(LISTS))
    for (const el of page[list] ?? []) if (el.g === id) parts[kind].push(el);
  return { box: boxOf(parts), things: parts.ink.length + parts.texts.length + parts.pictures.length, parts };
}

// ---- the answers

// A group's children slipped under it, its answers and replies (notebookstack.js slipsUnder)
const slipsHtml = children =>
  slipsUnder(children)
    .map(c => (c.kind === 'reply' ? replyHtml(c) : slipHtml(c, {}, slipWords())))
    .join('');
// (the slip in the reader's words, and to a guest its agent's name says it's an AI's: charter rule 5.)
const slipWords = () => ({ say: word, mark: aiMark() });

const slipsOn = (gs, view) => ({
  tick: (id, ticked) => (gs.book.dev ? Promise.resolve() : notebookRequest('/api/book/slip/tick', { id, ticked })),
  reply: async (id, words) => {
    await reply(gs.book.dev, id, words);
    readAgain(gs.book, view.page);
    return { said: word('Sent: Undo under it for 10 seconds') };
  },
});
async function unreply(gs, view, id) {
  try {
    await deleteReply(gs.book.dev, id);
  } catch (e) {
    toast(esc(e.message));
  }
  readAgain(gs.book, view.page);
}

// ---- a group's menu

// (moving: opened at the pages a group can go to)
function menu(gs, view, from, id, moving = false) {
  shutMenu(gs);
  const others = elsewhere(gs, view);
  const card = document.createElement('div');
  card.className = 'bk-card bk-group-menu';
  card.setAttribute('role', 'menu');
  card.innerHTML = `<ul class="bk-menu"><li><button role="menuitem" data-act="delete">${word('Delete')}</button></li>${
    others.length
      ? `<li><button role="menuitem" data-act="move" aria-expanded="false">${word('Move to page…')}</button></li>`
      : ''
  }</ul>`;
  (view.el.closest('#book') ?? document.body).append(card);
  if (moving) listPages(card, others);
  const r = from.getBoundingClientRect();
  Object.assign(card.style, {
    left: `${Math.round(Math.min(innerWidth - card.offsetWidth - 8, r.left))}px`,
    top: `${Math.round(Math.min(innerHeight - card.offsetHeight - 8, r.bottom + 4))}px`,
  });
  card.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'move') return listPages(card, others);
    shutMenu(gs);
    if (b.dataset.act === 'delete') remove(gs, view, id);
    if (b.dataset.page)
      moveTo(
        gs,
        view,
        id,
        others.find(p => String(p.id) === b.dataset.page),
      );
  });
  const away = e => !card.contains(e.target) && !from.contains(e.target) && shutMenu(gs);
  const esc_ = e => e.key === 'Escape' && (shutMenu(gs), from.focus());
  addEventListener('pointerdown', away, true);
  addEventListener('keydown', esc_);
  gs.menu = { card, off: () => (removeEventListener('pointerdown', away, true), removeEventListener('keydown', esc_)) };
  card.querySelector('button').focus({ preventScroll: true });
}
const elsewhere = (gs, view) => gs.hooks.pages().filter(p => p !== view.page && !shut(p));
function shutMenu(gs) {
  gs.menu?.off();
  gs.menu?.card.remove();
  gs.menu = null;
}
// The pages a group can go to, in the menu in place of its first list
function listPages(card, pages) {
  card.querySelector('.bk-menu').innerHTML = pages
    .map(p => `<li><button role="menuitem" data-page="${p.id}">${esc(nameOf(p))}</button></li>`)
    .join('');
  card.querySelector('button').focus({ preventScroll: true });
}

// What's picked with Select ({ ink, scraps, texts }, the page's own elements) when it's one whole group on an open
// page: { move(from) (its menu at the pages, from the button pressed; null: no other open page), remove() }; else null
function lone(gs, view, picked) {
  const page = view.page;
  if (!page.groups || shut(page)) return null;
  const els = Object.values(LISTS).flatMap(list => picked[list] ?? []),
    id = els[0]?.g;
  if (!page.groups.has(id) || els.some(el => el.g !== id) || partsNow(page, id).things !== els.length) return null;
  return {
    move: elsewhere(gs, view).length ? from => menu(gs, view, from, id, true) : null,
    remove: () => remove(gs, view, id),
  };
}

// ---- delete, move, group

// A group deleted: its elements off the page at once as one step (booksave.js deletes it in the store, and restores
// it when Undo puts them back), the page drawn again without its ink and highlights, a copy of it crumpled up and
// dropped, and Undo in a toast
function remove(gs, view, id) {
  const { book, hooks } = gs,
    { box, parts } = partsNow(view.page, id);
  const ok = edit(book, view, hooks, page => {
    for (const list of Object.values(LISTS)) {
      const kept = page[list].filter(el => el.g !== id);
      page[list].splice(0, page[list].length, ...kept);
    }
  });
  if (!ok) return;
  const step = book.steps.at(-1);
  // (its unit's card goes with it, not when the save deletes the group in the store: bookunits.js unitsOf;
  view.page.groups.get(id).vanished = true;
  hooks.refresh(view);
  drop(gs, view, box, parts);
  sfx.tick();
  toast(word('<b>Deleted.</b> Tap to undo'), () => takeBack(book, step));
}
// A step taken back from a toast: Undo's own when it's the last, else on its own and off the list
function takeBack(book, step) {
  if (book.steps.at(-1) === step) return book.undo?.();
  keep(book.steps, s => s !== step);
  step.undo();
}
// The group's things as they were, crumpled up and dropped (bookpaper.js; nothing waits on it)
function drop(gs, view, box, { ink, texts, pictures }) {
  if (!box) return;
  // (the group's box, and the pictures' turned corners if they go past it)
  const drawn = boundsOf({ ink, scraps: pictures }, null),
    own = { x0: box.x, y0: box.y, x1: box.x + box.w, y1: box.y + box.h },
    extent = drawn ? union(own, drawn) : own;
  crumple(...thingsPicture(view, { ink, texts, scraps: pictures }, extent, gs.book.scale));
}
// A line written over a group, scribbled back and forth (a scratch-out), deletes it: not kept as ink
function scratchOut(gs, view, line) {
  if (shut(view.page) || !scribbled(line.points)) return false;
  const opened = [...(view.page.groups?.values() ?? [])].map(g => ({ id: g.id, box: partsNow(view.page, g.id).box }));
  const hit = scratched(line.points, opened);
  if (!hit) return false;
  remove(gs, view, hit.id);
  return true;
}
// A group onto another page of the notebook, its last unit there, both pages read again; Undo moves it back to its
// place, right after the unit before it
async function moveTo(gs, view, id, to) {
  const { book } = gs,
    from = view.page;
  if (!to) return;
  const go = async (g, a, b, after) => {
    await saved(book, a);
    await moveGroup(book.dev, g, b.id, after);
    for (const p of [a, b]) readAgain(book, p);
  };
  const place = unitBefore(from, id) ?? 'start';
  try {
    await go(id, from, to);
  } catch (e) {
    return toast(esc(e.message));
  }
  book.steps.push({ page: from, undo: () => go(id, to, from, place), redo: () => go(id, from, to) });
  toast(word('<b>Moved to {name}.</b> Tap to go there', { name: esc(nameOf(to)) }), () => gs.hooks.turnTo(to));
}
// The unit right before unit id in its page's order, its id (undefined: id is the first)
function unitBefore(page, id) {
  const { pos } = page.groups.get(id);
  return [...page.groups.values()].filter(g => g.pos < pos).sort((a, b) => b.pos - a.pos)[0]?.id;
}

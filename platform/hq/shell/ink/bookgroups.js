// The groups on a Notebook page as the board sees them (knowledge/notes/platform/notebook.md): each a paperclip at its
// box's top-left, tapped for a small menu (Delete, Move to page…); a scrap's post-it words under its picture (typed in
// and edited with the pen while its page is open: bookamend.js); and under
// each group its answers (review mode's slips: a tick, and words written under one go as a reply) with the board's
// replies, a reply's Undo there in its seconds, then the agents' desk-phone cards about it (bookasks.js). A group
// deleted crumples away at once, Undo a tap away in a toast and on the book's Undo; a scratch-out written over a group
// deletes it the same way. The lasso's Group makes what's picked one group: split out of the groups it's part of, then
// joined. A sent page's own groups have no clip: they're read-only.
// Which group a stroke joins, and what's saved, is booksave.js's; the maths bookgroupmath.js's. Its look: bookgroups.css.
import { esc, stylesheet } from '../../util.js';
import { act } from '../data.js';
import { toast } from '../hud.js';
import { sfx } from '../audio.js';
import { CSS as SLIP_CSS, slipHtml, wireSlips } from '/__review/slip.js';
import { scribbled } from '/__review/gestures.js';
import { keepFromScribble } from '/__review/penwords.js';
import { boxOf, keyOf, scratched } from './bookgroupmath.js';
import { edit, keep } from './bookedit.js';
import { readAgain, saved, shut, typed } from './booksave.js';
import { deleteReply, joinGroups, moveGroup, reply, splitGroup } from './notebookdata.js';
import { nameOf } from './bookhead.js';
import { asksHtml, wireAsks } from './bookasks.js';

// a reply can be taken back this long after it's written (notebooksend.ts SEND_MS)
const REPLY_MS = 10_000;
const LISTS = { ink: 'ink', texts: 'texts', pictures: 'scraps' };
// (a paperclip, as the answers' slips have)
const CLIP =
  '<svg viewBox="0 0 14 34" aria-hidden="true"><path d="M10 9v15a3.5 3.5 0 0 1-7 0V6a5 5 0 0 1 10 0v19"/></svg>';

// book: bookpages.js's. hooks: { lay(), refresh(view), pages() (the notebook's open pages, [page]), turnTo(page) }.
// Returns { added(view), drawn(page), scratch(view, line), group(view, picked) }: a view's layer made, a page's groups
// drawn again (read or saved), a line written over a group that deletes it (true: not ink), and the lasso's Group.
export function mountGroups(book, hooks) {
  stylesheet('shell/ink/bookgroups.css');
  if (!document.querySelector('style[data-slips]')) {
    const style = Object.assign(document.createElement('style'), { textContent: SLIP_CSS });
    style.dataset.slips = '';
    document.head.append(style);
  }
  const gs = { book, hooks, menu: null };
  return {
    added: view => layerOf(gs, view),
    drawn: page => {
      const view = book.views.find(v => v.page === page);
      if (view) draw(gs, view);
    },
    scratch: (view, line) => scratchOut(gs, view, line),
    group: (view, picked) => together(gs, view, picked),
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
// A page's groups drawn on it: each one's clip, a scrap's words, its answers and replies under it. Not while a reply
// is being written under an answer, which drawing them anew would take away (or send half written, as its field's
// blur sends it): then once it's sent or left empty. A reply field the board is in and hasn't written in yet keeps
// the board in it.
function draw(gs, view) {
  const { page } = view,
    layer = layerOf(gs, view),
    open = !shut(page);
  view.groupsLater = [...layer.querySelectorAll('.slip-reply')].some(f => f.value.trim());
  if (view.groupsLater) return;
  const inReply = document.activeElement?.matches('.slip-reply') && layer.contains(document.activeElement);
  const focused = inReply && document.activeElement.closest('[data-slip]').dataset.slip;
  const caret = caretIn(layer);
  layer.innerHTML = [...(page.groups?.values() ?? [])]
    .map(g => {
      // (a group whose elements are all off the page, deleted and not yet saved, is drawn no more)
      const box = boxNow(page, g.id);
      if (!box) return '';
      const clip = open
        ? `<button type="button" class="bk-clip" data-g="${g.id}" style="left:${box.x}px;top:${box.y}px" aria-label="${esc(
            labelOf(g),
          )}" aria-haspopup="menu">${CLIP}</button>`
        : '';
      const words = g.kind === 'scrap' ? wordsHtml(page, g, open) : '';
      const under =
        (g.children ?? []).map(c => (c.kind === 'reply' ? replyHtml(c) : slipHtml(c, {}))).join('') + asksHtml(g);
      return `${clip}${
        words || under
          ? `<div class="bk-under" data-g="${g.id}" style="left:${box.x}px;top:${box.y + box.h + 10}px;--w:${Math.max(
              280,
              Math.min(420, box.w),
            )}px">${words}${under}</div>`
          : ''
      }`;
    })
    .join('');
  wireSlips(layer, slipsOn(gs, view));
  wireAsks(layer, {
    dev: gs.book.dev,
    asks: new Map([...(page.groups?.values() ?? [])].flatMap(g => g.asks ?? []).map(a => [a.id, a])),
    answered: () => readAgain(gs.book, page),
  });
  wireWords(gs, page, layer);
  for (const b of layer.querySelectorAll('.bk-clip')) b.addEventListener('click', () => menu(gs, view, b));
  for (const b of layer.querySelectorAll('[data-unreply]'))
    b.addEventListener('click', () => unreply(gs, view, Number(b.dataset.unreply)));
  // (the clips' and answers' touches are their own: never the page's pan or ink. A scrap's words kept from Scribble
  // for the pen take its strokes on the page: bookamend.js)
  for (const el of layer.querySelectorAll('.bk-clip, .bk-under'))
    for (const type of ['pointerdown', 'touchstart'])
      el.addEventListener(type, e => e.target.matches('[data-pen]') || e.stopPropagation());
  if (focused) layer.querySelector(`[data-slip="${focused}"] .slip-reply`)?.focus();
  if (caret) caretBack(layer, caret);
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
    ? `<div class="bk-scrap-post" data-words="${esc(words)}"><textarea class="bk-scrap-words" rows="1" aria-label="The scrap's words">${esc(
        words,
      )}</textarea></div>`
    : '';
}
const labelOf = g =>
  g.kind === 'scrap' ? `A scrap${g.owner_name ? ` of ${g.owner_name}'s work` : ''}: its menu` : 'A group: its menu';
// The board's reply under an answer, and its Undo while it's in its seconds
function replyHtml(r) {
  const words = r.words || (r.ink?.length ? 'Written reply' : '');
  const fresh = Date.now() - Date.parse(r.created) < REPLY_MS;
  return `<p class="bk-reply" data-reply="${r.id}"><b>You</b> ${esc(words)}${
    fresh ? ` <button type="button" class="bk-unreply" data-unreply="${r.id}">Undo</button>` : ''
  }</p>`;
}
// A group's elements as they are on the page now, for where its clip and answers go (null: none)
function boxNow(page, id) {
  const parts = { ink: [], texts: [], pictures: [] };
  for (const [kind, list] of Object.entries(LISTS))
    for (const el of page[list] ?? []) if (el.g === id) parts[kind].push(el);
  return boxOf(parts);
}

// ---- the answers

const slipsOn = (gs, view) => ({
  tick: (id, ticked) => (gs.book.dev ? Promise.resolve() : act('/api/book/slip/tick', { id, ticked })),
  reply: async (id, words) => {
    await reply(gs.book.dev, id, words);
    readAgain(gs.book, view.page);
    return { said: 'Sent: Undo under it for 10 seconds' };
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

function menu(gs, view, from) {
  shutMenu(gs);
  const id = Number(from.dataset.g),
    others = gs.hooks.pages().filter(p => p !== view.page && !shut(p));
  const card = document.createElement('div');
  card.className = 'bk-card bk-group-menu';
  card.setAttribute('role', 'menu');
  card.innerHTML = `<ul class="bk-menu"><li><button role="menuitem" data-act="delete">Delete</button></li>${
    others.length ? `<li><button role="menuitem" data-act="move" aria-expanded="false">Move to page…</button></li>` : ''
  }</ul>`;
  (view.el.closest('#book') ?? document.body).append(card);
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

// ---- delete, move, group

// A group deleted: its elements off the page at once as one step (booksave.js deletes it in the store, and restores
// it when Undo puts them back), a crumpled ghost of it going, and Undo in a toast
function remove(gs, view, id) {
  const { book, hooks } = gs,
    box = boxNow(view.page, id);
  const ok = edit(book, view, hooks, page => {
    for (const list of Object.values(LISTS)) {
      const kept = page[list].filter(el => el.g !== id);
      page[list].splice(0, page[list].length, ...kept);
    }
  });
  if (!ok) return;
  const step = book.steps.at(-1);
  draw(gs, view);
  crumple(gs, view, box);
  sfx.tick();
  toast('<b>Deleted.</b> Tap to undo', () => takeBack(book, step));
}
// A step taken back from a toast: Undo's own when it's the last, else on its own and off the list
function takeBack(book, step) {
  if (book.steps.at(-1) === step) return book.undo?.();
  keep(book.steps, s => s !== step);
  step.undo();
}
// The group's ghost crumpled and gone (nothing waits on it)
function crumple(gs, view, box) {
  if (!box) return;
  const ghost = document.createElement('div');
  ghost.className = 'bk-crumple';
  Object.assign(ghost.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
  layerOf(gs, view).append(ghost);
  ghost.addEventListener('animationend', () => ghost.remove());
  setTimeout(() => ghost.remove(), 1000);
}
// A line written over a group, scribbled back and forth (a scratch-out), deletes it: not kept as ink
function scratchOut(gs, view, line) {
  if (shut(view.page) || !scribbled(line.points)) return false;
  const opened = [...(view.page.groups?.values() ?? [])].map(g => ({ id: g.id, box: boxNow(view.page, g.id) }));
  const hit = scratched(line.points, opened);
  if (!hit) return false;
  remove(gs, view, hit.id);
  return true;
}
// A group onto another page of the notebook (its place on the page kept), both pages read again; Undo moves it back
async function moveTo(gs, view, id, to) {
  const { book } = gs,
    from = view.page;
  if (!to) return;
  const go = async (g, a, b) => {
    await saved(book, a);
    await moveGroup(book.dev, g, b.id);
    for (const p of [a, b]) readAgain(book, p);
  };
  try {
    await go(id, from, to);
  } catch (e) {
    return toast(esc(e.message));
  }
  book.steps.push({ page: from, undo: () => go(id, to, from), redo: () => go(id, from, to) });
  toast(`<b>Moved to ${esc(nameOf(to))}.</b> Tap to go there`, () => gs.hooks.turnTo(to));
}
// What the lasso picked ({ ink, scraps, texts }, the page's own elements) as one group: the groups wholly picked and
// what's split out of the others, joined. (No Undo: lasso it again to change it.)
async function together(gs, view, picked) {
  const { book } = gs,
    page = view.page;
  if (shut(page)) return;
  try {
    // (saved first: what was just drawn has its group then)
    await saved(book, page);
    const of = new Map();
    for (const [kind, list] of Object.entries(LISTS))
      for (const el of picked[list] ?? []) {
        if (!of.has(el.g)) of.set(el.g, { ink: [], texts: [], pictures: [] });
        of.get(el.g)[kind].push(el);
      }
    const ids = [];
    for (const [id, els] of of) {
      const g = page.groups.get(id);
      if (!g) continue;
      const all = Object.values(LISTS).reduce((n, list) => n + page[list].filter(el => el.g === id).length, 0),
        some = Object.values(els).reduce((n, l) => n + l.length, 0);
      if (some === all) ids.push(id);
      else ids.push((await splitGroup(book.dev, id, indexesIn(g, els))).split.id);
    }
    if (ids.length > 1) await joinGroups(book.dev, ids);
  } catch (e) {
    toast(esc(e.message));
  }
  readAgain(book, page);
}
// Elements' indexes in their group as the store keeps it (each matched once, in order)
function indexesIn(g, els) {
  const picks = {};
  for (const [kind, list] of Object.entries(els)) {
    const left = g.base[kind].map((key, i) => ({ key, i }));
    picks[kind] = list.flatMap(el => {
      const at = left.findIndex(x => x.key === keyOf(el));
      return at < 0 ? [] : left.splice(at, 1).map(x => x.i);
    });
  }
  return picks;
}

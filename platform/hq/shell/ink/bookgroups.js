// The groups on a Notebook page as the board sees them (knowledge/notes/platform/notebook.md), each a scrap unit the
// page lays (bookunits.js): picked with Select (bookselect.js), whose bar has its Delete (Move to page…: bookmoveto.js). A
// scrap's post-it words in its body under its picture (typed in while its page is open; the pen's strokes over them
// are ink); and under each unit its answers (review mode's slips: a tick, and the room pulled out under one to
// answer in, drawn or typed with the text tool: bookslipreply.js) with the board's replies, a reply's Undo there in its seconds, the agent's face and pencil dots while an
// answer comes (or why none came), then the agents' desk-phone cards about it
// (bookasks.js), one still open edged red (bookforyou.js). A group deleted crumples away at once, Undo a tap away in a
// toast and on the book's Undo; a scratch-out written over a group deletes it the same way. A sent page's own groups are read-only.
// What's saved is booksave.js's; the maths bookgroupmath.js's. Its look: bookgroups.css.
import { aiMark, notebookRequest, word } from './bookscope.js';
import { esc, stylesheet } from '../../util.js';
import { toast } from '../toast.js';
import { toastHeard } from './booksounds.js';
import { crumple } from './bookpaper.js';
import { thingsPicture } from './bookpaperdraw.js';
import { boundsOf, union } from './bookselectmath.js';
import { CSS as SLIP_CSS, slipHtml, wireSlips } from '/__review/slip.js';
import { scribbled } from '/__review/gestures.js';
import { scratched } from './bookgroupmath.js';
import { boxOf, slipsUnder } from './notebookstack.js';
import { edit, keep } from './bookedit.js';
import { readAgain, shut, typed } from './booksave.js';
import { hung } from './bookarrive.js';
import { deleteReply, reply } from './notebookdata.js';
import { answering, slipRoomHtml, wireRooms } from './bookslipreply.js';
import { asksHtml, wireAsks } from './bookasks.js';
import { mountShow } from './bookgroupshow.js';
import { markOpen } from './bookforyou.js';
import { seenHtml, seenMarkHtml, tagsHtml } from './bookassignlist.js'; // (seenMarkHtml)
import { formHtml, formsIn, wireForms } from './bookanswerreply.js';
import { sendForm, sendReply } from './bookanswersdata.js';
import { waitingHtml } from './bookanswers.js';
import { slipInkHtml } from './bookanswerart.js';
import { CONTROLS } from './bookpan.js';
import { RESTING } from './bookwrite.js';
import { mountMoveTo } from './bookmoveto.js';

// a reply can be taken back this long after it's written (notebooksend.ts SEND_MS)
const REPLY_MS = 10_000;
const LISTS = { ink: 'ink', texts: 'texts', pictures: 'scraps' };
// book: bookpages.js's. hooks: { lay(), refresh(view), pages() (the notebook's open pages, [page]), pagesAgain(),
// turnTo(page) }.
// Returns { added(view), drawn(page), scratch(view, line), lone(view, picked), ...moves }: a view's layer made, a page's
// groups drawn again (read or saved), a line written over a group that deletes it (true: not ink), what Select's bar
// does with one whole group picked, and its Move to page… and the Pencil's (bookmoveto.js mountMoveTo's).
export function mountGroups(book, hooks) {
  stylesheet('shell/ink/bookgroups.css');
  if (!document.querySelector('style[data-slips]')) {
    const style = Object.assign(document.createElement('style'), { textContent: SLIP_CSS });
    style.dataset.slips = '';
    document.head.append(style);
  }
  const gs = { book, hooks, menu: null };
  mountShow(book); // (a scrap just saved, shown)
  // (an answer coming or a seen mark on a page drawn before the scene placed the agents shows its agent's initial: their
  // face once a look is worn, stage.js stage:look.: the seen mark's)
  document.addEventListener('stage:look', () => {
    for (const view of book.views)
      if ([...(view.page.groups?.values() ?? [])].some(g => g.waiting || g.seen)) draw(gs, view);
  });
  return {
    added: view => layerOf(gs, view),
    drawn: page => {
      const view = book.views.find(v => v.page === page);
      if (view) draw(gs, view);
    },
    scratch: (view, line) => scratchOut(gs, view, line),
    lone: (view, picked) => lone(gs, view, picked),
    ...mountMoveTo(book, hooks),
  };
}

// ---- drawn on the page

function layerOf(gs, view) {
  let layer = view.el.querySelector(':scope > .bk-groups');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'bk-groups';
    view.el.append(layer);
  }
  return layer;
}
// A page's groups drawn on it: the clip of one that holds two or more things, a scrap's words, its answers and replies
// under it. Not while the board answers in a room under an answer, which drawing them anew would take away: then once
// what it answered with has gone (or it left it empty). The rooms pulled out stay out.
function draw(gs, view) {
  const { page } = view,
    layer = layerOf(gs, view),
    open = !shut(page);
  view.groupsLater = answering(layer);
  if (view.groupsLater) return;
  view.rooms ??= new Map();
  const caret = caretIn(layer),
    forms = formsIn(layer);
  // (the page whose groups these are: book-check finds a page's things by it, a lone one having no clip)
  layer.dataset.page = page.id;
  layer.innerHTML = [...(page.groups?.values() ?? [])]
    .map(g => {
      // (a group whose elements are all off the page, deleted and not yet saved, is drawn no more)
      const { box } = partsNow(page, g.id);
      if (!box) return '';
      // A scrap's words are part of its body, under its picture. Its answers and replies go under the unit, whom it
      // went to at its corner, and who read it beside what they read (bookunits.js places them). A scrap is a unit, no
      // clip: Select's bar has its menu. (who read it)
      const words = g.kind === 'scrap' ? wordsHtml(page, g, open) : '';
      const under = slipsHtml(g, view.rooms) + asksHtml(g, view.rooms, gs.book.dev);
      return `${words ? `<div class="bk-words" data-g="${g.id}">${words}</div>` : ''}${
        under ? `<div class="bk-under" data-g="${g.id}">${under}</div>` : ''
      }${tagsHtml(g)}${seenMarkHtml(g)}`;
    })
    .join('');
  wireSlips(layer, slipsOn(gs), word);
  wireRooms(layer, view.rooms, roomsOn(gs, view));
  wireAsks(layer, {
    asks: new Map([...(page.groups?.values() ?? [])].flatMap(g => g.asks ?? []).map(a => [a.id, a])),
    answered: () => readAgain(gs.book, page),
    rooms: view.rooms,
    hooks: roomsOn(gs, view),
  });
  wireWords(gs, page, layer);
  wireForms(page, layer, forms, (a, sent) => sendForm(gs.book.dev, a.id, sent).then(() => readAgain(gs.book, page)));
  for (const b of layer.querySelectorAll('[data-unreply]'))
    b.addEventListener('click', () => unreply(gs, view, Number(b.dataset.unreply)));
  for (const el of layer.querySelectorAll('.bk-words, .bk-under'))
    for (const type of ['pointerdown', 'touchstart']) el.addEventListener(type, e => ownTouches(gs, e));
  if (caret) caretBack(layer, caret);
  // What hangs under each unit is counted in its place and moved to its foot (bookunits.js), again once the book's font
  // is in where the words were measured in another
  view.relay?.();
  if (document.fonts?.status === 'loading') document.fonts.ready.then(() => view.el.isConnected && view.relay?.());
  markOpen(view, layer);
  hung(gs.book, view);
  gs.book.controls?.update();
}
// A press on a scrap's words or its answers, kept from the page unless it's the page's: the pen's strokes over words
// kept from Scribble are ink, a finger's from words not being typed in too (a stroke starts anywhere: README, Our
// scraps), and a finger that moves the page (bookpan.js) moves it from a scrap's words as from bare paper, its tap
// still the field's.
function ownTouches(gs, e) {
  const t = e.target,
    penInk = t.matches('[data-pen]') || ((e.pointerType ?? 'touch') === 'touch' && t.matches(RESTING)),
    fingerPan = e.type === 'pointerdown' && e.pointerType === 'touch' && !!gs.book.input?.fingerPans?.(),
    onWords = !!t.closest('.bk-words') && !t.closest(CONTROLS);
  if (penInk || (fingerPan && onWords)) return;
  e.stopPropagation();
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
    keepFromScribble(f);
    f.addEventListener('input', () => {
      f.parentElement.dataset.words = f.value;
      typed(gs.book, page, id, f.value);
    });
  }
}
// A scrap's words field on a touch screen (an iPad's): read-only while it holds words and isn't being typed in, so
// Apple's Scribble never takes a Pencil touching it and the pen's strokes over its words are ink on the page. A
// finger's or a mouse's press, a tap that focuses it (the Pencil's too) or the keyboard's Tab make it editable again
// before it's focused, so typing after a tap works as before. data-pen marks it read-only for the pen (not for good).
function keepFromScribble(field) {
  if (!matchMedia('(any-pointer: coarse)').matches) return;
  const free = () => {
    field.readOnly = false;
    field.removeAttribute('data-pen');
  };
  const refresh = () => {
    if (field.matches(':focus') || !field.value.trim()) return free();
    field.readOnly = true;
    field.setAttribute('data-pen', '');
  };
  field.addEventListener('pointerdown', e => e.pointerType !== 'pen' && free(), true);
  field.addEventListener('focus', free);
  field.addEventListener('blur', refresh);
  refresh();
}
// A scrap's post-it words: while its page is open a field, its words typed in or edited with the pen saved to its
// group (booksave.js typed), growing with them (a copy of them under it, unseen, gives its height); once it's sent,
// read-only words
function wordsHtml(page, g, open) {
  const words = page.typed?.get(g.id) ?? g.words;
  if (!open) return words ? `<p class="bk-scrap-words">${esc(words)}</p>` : '';
  return words || page.typed?.has(g.id)
    ? `<div class="bk-scrap-post" data-words="${esc(words)}"><textarea class="bk-scrap-words" rows="1" aria-label="${word('scrapWords')}">${esc(
        words,
      )}</textarea></div>`
    : '';
}
// The board's reply under an answer: its words and ink as drawn, its Undo in its seconds, its seen tick
function replyHtml(r) {
  const fresh = Date.now() - Date.parse(r.created) < REPLY_MS;
  return `<div class="bk-reply" data-reply="${r.id}"><b>${word('you')}</b> ${esc(r.words ?? '')}${
    fresh ? ` <button type="button" class="bk-unreply" data-unreply="${r.id}">${word('undo')}</button>` : ''
  }${r.seen ? seenHtml(r.seen) : ''}${r.ink?.length ? slipInkHtml(r.ink) : ''}</div>`;
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

// A group's answers and replies slipped under it (notebookstack.js slipsUnder), an answer's drawing and form under its
// words (bookanswerart.js slipInkHtml, bookanswerreply.js formHtml), a fix's drawing in its box (slipExtras), then the
// answer still coming; at each slip's foot its room to answer in (bookslipreply.js), as pulled (rooms: id → h).
const slipsHtml = (g, rooms) =>
  slipsUnder(g.children ?? [])
    .map(c => (c.kind === 'reply' ? replyHtml(c) : slipHtml(c, {}, { ...slipWords(), ...slipExtras(c, rooms) })))
    .join('') + (g.waiting ? waitingHtml(g) : '');
function slipExtras(c, rooms) {
  const ink = c.ink?.length ? slipInkHtml(c.ink) : '';
  return { more: (c.fix ? '' : ink) + (c.form ? formHtml(c) : '') + slipRoomHtml(c, rooms), art: c.fix ? ink : '' };
}
// (the slip in the reader's words, and to a guest its agent's name says it's an AI's: charter rule 5.)
const slipWords = () => ({ say: word, mark: aiMark() });
// (a tick on the answers' route, which takes an answer not sent yet)
const slipsOn = gs => ({
  tick: (id, ticked) =>
    gs.book.dev ? Promise.resolve() : notebookRequest('/api/notebooks/answers/tick', { id, ticked }),
});
// What the board answers in a slip's room goes as its reply, drawn or typed, and the page is read again; groups held
// for it are drawn once it's gone
const roomsOn = (gs, view) => ({
  book: gs.book,
  send: async (id, { ink, words }) => {
    await (ink ? sendReply(gs.book.dev, id, ink) : reply(gs.book.dev, id, words));
    readAgain(gs.book, view.page);
  },
  settled: () => view.groupsLater && draw(gs, view),
  relay: () => {
    view.relay?.();
    const layer = layerOf(gs, view);
    for (const edge of layer.querySelectorAll(':scope > .bk-for-you')) edge.remove();
    markOpen(view, layer);
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

// ---- Select's bar

// What's picked with Select ({ ink, scraps, texts }, the page's own elements) when it's one whole group on an open
// page: { remove() } (its Delete); else null
function lone(gs, view, picked) {
  const page = view.page;
  if (!page.groups || shut(page)) return null;
  const els = Object.values(LISTS).flatMap(list => picked[list] ?? []),
    id = els[0]?.g;
  if (!page.groups.has(id) || els.some(el => el.g !== id) || partsNow(page, id).things !== els.length) return null;
  return { remove: () => remove(gs, view, id) };
}

// ---- delete

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
  crumpleAway(gs, view, box, parts);
  toastHeard(word('deletedToast'), () => takeBack(book, step));
}
// A step taken back from a toast: Undo's own when it's the last, else on its own and off the list
function takeBack(book, step) {
  if (book.steps.at(-1) === step) return book.undo?.();
  keep(book.steps, s => s !== step);
  step.undo();
}
// The group's things as they were, crumpled up and dropped, heard as it goes (bookpaper.js; nothing waits on it)
function crumpleAway(gs, view, box, { ink, texts, pictures }) {
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

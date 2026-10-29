// The agents' answers on a notebook page: a layer over the page (bookpage.js mounts it in .bk-answers), in the page's
// px, drawing each group's answers where the store put them (spot, from the group's box: never over the board's own
// groups), each with the hand-drawn bulb and its agent's face, its words written in by a small pen, a drawing drawn,
// a picture taped in, a form to fill in, and a strip under it where the board writes its reply. An answer still
// coming shows the agent's face and pencil dots where it will land. A note tried in versions gets a tab that turns to
// their page, and that page shows them (bookanswerversions.js). Read again whenever the store's book or notebook
// changes, and as a look is worn (stage.js stage:look): a page read before the scene placed the agents drew initials.
import { esc, stylesheet } from '../../util.js';
import * as world from '../../world/world.js';
import { inkOf } from './agentink.js';
import { portrait, faced } from './bookfaces.js';
import { BULB, DOTS, inkBox, pathsOf } from './bookanswerart.js';
import { writeWhenSeen } from './bookanswerwrite.js';
import { fitReplies, formHtml, replyHtml, wireForm, wireReply } from './bookanswerreply.js';
import { loadGroups, sendForm, sendReply } from './bookanswersdata.js';
import { versionsTab, drawVersions, paperOf } from './bookanswerversions.js';
import { scope, word } from './bookscope.js';
import { words } from './notebookwords.js';

for (const name of ['bookanswers', 'bookanswerform', 'bookanswerversions']) stylesheet(`shell/ink/${name}.css`);

// slot: the page's .bk-answers; page: its record (bookpages.js), whose id it reads by (none yet: nothing to read)
export function mountAnswers(slot, page) {
  const layer = { slot, page, drawn: new Map(), reading: 0 },
    events = ['book:changed', 'book:notebook', 'stage:look'];
  const again = () => {
    if (!slot.isConnected && layer.reading) return events.forEach(type => document.removeEventListener(type, again));
    read(layer);
  };
  for (const type of events) document.addEventListener(type, again);
  read(layer);
}

async function read(layer) {
  const { page } = layer,
    n = ++layer.reading;
  if (!page.id) return;
  let groups;
  try {
    groups = await loadGroups(world.dev, page.id);
  } catch (e) {
    return console.error('[hq] A page’s answers can’t be read:', e);
  }
  if (n !== layer.reading || !groups) return;
  if (groups.tried) drawVersions(layer, groups, parts(layer));
  else draw(layer, groups.groups);
}

// What a versions page draws with from here: an answer's face, its reply strip, and the pen on its frames: what it
// writes goes to the version to(ink) names ({ answer, frame }, null: none), read again once it's gone
const parts = layer => ({
  faceHtml,
  faced,
  replyHtml,
  wirePen: (el, { origin, to, done }) =>
    wireReply(el, {
      origin,
      done,
      // (the Pencil and a mouse anywhere on the frames; a finger on a version's picture or strip, so it moves the page
      // everywhere else)
      takes: e =>
        e.pointerType !== 'touch' ||
        !!e.target.closest?.('.bk-version[data-answer] :is(.bk-version-paper, .bk-answer-reply)'),
      send: ink => {
        const on = to(ink);
        if (!on) return Promise.reject(new Error('No version here yet'));
        return sendReply(world.dev, on.answer, ink, on.frame).then(() => read(layer));
      },
      refused: words => el.setAttribute('data-refused', words),
    }),
});

// Every group's answers, placeholders and versions tab, each kept as drawn while it's the same (a pen mid-word, a form
// half filled in), drawn again when it changed, and as the paper sizes (the screen turns)
function draw(layer, groups) {
  const wanted = new Map(),
    edge = edgeOf(layer, () => draw(layer, groups));
  for (const g of groups) {
    const replies = g.children.filter(c => c.kind === 'reply');
    for (const a of g.children.filter(c => c.kind === 'answer' && c.spot && c.style !== 'version')) {
      const spot = spotHere(g, a.spot, edge);
      wanted.set(`a${a.id}`, {
        key: JSON.stringify([a, spot, g.box, replies.filter(r => r.answers === a.id), faced(a.by)]),
        make: () => answerEl(layer, g, a, spot, replies),
      });
    }
    if (g.waiting?.spot) {
      const spot = spotHere(g, g.waiting.spot, edge);
      wanted.set(`w${g.id}`, {
        key: JSON.stringify([g.waiting, spot, g.box, faced(g.waiting.by)]),
        make: () => waitingEl(g, spot),
      });
    }
    const tab = versionsTab(g);
    if (tab) wanted.set(`t${g.id}`, { key: JSON.stringify([tab, g.box]), make: () => tabEl(layer, g, tab) });
  }
  for (const [id, old] of layer.drawn)
    if (wanted.get(id)?.key !== old.key) {
      old.el.remove();
      layer.drawn.delete(id);
    }
  for (const [id, { key, make }] of wanted) {
    if (layer.drawn.has(id)) continue;
    const el = make();
    layer.slot.append(el);
    layer.drawn.set(id, { key, el });
    el.dispatchEvent(new Event('bk:placed'));
  }
}

// ---- an answer

// Where an answer lies on this screen: the store's spot, or where that runs under the controls floating at the paper's
// right edge (one column or two: bookui.js --bk-stack) as this screen shows the page at 100%, the first of its narrow
// spots that doesn't (each placed below its group for a narrower paper: answerspot.ts), or its narrowest. Never moved or
// narrowed here: only paper the store cleared.
function spotHere(g, spot, edge) {
  if (edge === null) return spot;
  let s = spot;
  while (s.narrow && g.box.x + s.dx + s.w > edge) s = s.narrow;
  return s;
}
// The x the answers keep left of on this screen (null: the paper has no size yet); again() draws them again as it sizes,
// and as the controls' width settles (bookui.js bk:stack)
function edgeOf(layer, again) {
  const paper = paperOf(layer, again),
    book = layer.slot.closest('#book');
  if (book && !layer.hearsStack) {
    layer.hearsStack = true;
    const heard = () => (layer.slot.isConnected ? layer.again() : book.removeEventListener('bk:stack', heard));
    book.addEventListener('bk:stack', heard);
  }
  return paper && paper - (parseFloat(getComputedStyle(layer.slot).getPropertyValue('--bk-stack')) || 52) - 24;
}
const at = (g, spot) => `left:${g.box.x + spot.dx}px;top:${g.box.y + spot.dy}px;width:${spot.w}px`;

function answerEl(layer, g, a, spot, replies) {
  const el = document.createElement('article');
  el.className = 'bk-answer';
  // (data-g: its group's, whose live move by Select carries it: bookselectlift.js)
  Object.assign(el.dataset, { answer: a.id, style: a.style, g: g.id });
  el.toggleAttribute('data-ticked', !!a.ticked);
  // (to a guest the name says it's an AI's, in their language: charter rule 5)
  const name = scope ? `${a.name} · ${words[document.documentElement.lang].aiAgent}` : a.name;
  el.setAttribute(
    'aria-label',
    word(a.style === 'question' ? '{name} asks: {text}' : '{name} answers: {text}', { name, text: a.text ?? '' }),
  );
  el.style.cssText = `${at(g, spot)};--ink:${inkOf(a.by)}`;
  const mine = replies.filter(r => r.answers === a.id);
  el.innerHTML = `<header class="bk-answer-head">${a.style === 'question' ? '' : BULB}${faceHtml(a)}<b class="bk-answer-name">${esc(
    a.style === 'question' ? word('{name} asks', { name }) : name,
  )}</b></header>${wordsHtml(a.text)}${a.ink?.length ? inkHtml(a.ink) : ''}${
    a.picture ? `<figure class="bk-answer-picture"><img src="${esc(a.picture)}" alt="" draggable="false"></figure>` : ''
  }${a.style === 'form' && a.form ? formHtml(a) : ''}${replyHtml(mine, word('Write your reply to {name} here', { name: a.name }))}`;
  const strip = el.querySelector('.bk-answer-reply'),
    origin = () => ({ x: el.offsetLeft + strip.offsetLeft, y: el.offsetTop + strip.offsetTop });
  wireStrip(layer, strip, a, origin);
  const form = el.querySelector('.bk-answer-form');
  if (form) wireForm(form, a, answers => sendForm(world.dev, a.id, answers).then(() => read(layer)));
  // (laid out again whenever its size changes: its page shown, the hand's font come, a picture loaded)
  new ResizeObserver(() => {
    if (!el.offsetWidth) return;
    fitInk(el);
    fitReplies(strip, origin());
  }).observe(el);
  el.addEventListener('bk:placed', () => writeWhenSeen(el, a.id));
  return el;
}

// The agent's face as HQ's look draws them, or their initial in their ink
export function faceHtml({ by, name }) {
  const picture = portrait(by);
  return picture
    ? `<i class="bk-answer-face" style="background-image:url(${picture})" aria-hidden="true"></i>`
    : `<i class="bk-answer-face" aria-hidden="true">${esc([...(name ?? by)][0] ?? '')}</i>`;
}
// The words, a span written and a span held as room, the caret between them for the pen
const wordsHtml = text =>
  text
    ? `<p class="bk-answer-words" data-text="${esc(text)}"><span class="bk-written">${esc(text)}</span><span class="bk-caret"></span><span class="bk-rest"></span></p>`
    : '';
// A drawing's strokes in the answer's own px, from its top-left; the room under the words reaches down to its foot
const inkHtml = ink =>
  `<svg class="bk-answer-ink" width="1" height="1" aria-hidden="true">${pathsOf(ink)}</svg><div class="bk-answer-room" data-foot="${Math.ceil(
    inkBox(ink)?.y1 ?? 0,
  )}"></div>`;
function fitInk(el) {
  const room = el.querySelector('.bk-answer-room');
  if (room) room.style.height = `${Math.max(0, Number(room.dataset.foot) + 8 - room.offsetTop)}px`;
}

// The strip under an answer (or a version) taking the board's reply, read again once it's gone
function wireStrip(layer, strip, a, origin) {
  wireReply(strip, {
    origin,
    send: ink => sendReply(world.dev, a.id, ink).then(() => read(layer)),
    refused: words => strip.setAttribute('data-refused', words),
  });
}

// ---- an answer still coming, and the tab to a note's versions

function waitingEl(g, spot) {
  const el = document.createElement('div');
  el.className = 'bk-answer-waiting';
  el.dataset.group = el.dataset.g = g.id;
  el.style.cssText = `${at(g, spot)};--ink:${inkOf(g.waiting.by)}`;
  el.setAttribute('role', 'status');
  const reason = g.waiting.reason;
  el.setAttribute(
    'aria-label',
    reason ? `${g.waiting.name}: ${reason}` : word('{name} is writing an answer', { name: g.waiting.name }),
  );
  el.innerHTML = `${faceHtml(g.waiting)}${reason ? `<span>${esc(reason)}</span>` : DOTS}`;
  return el;
}
function tabEl(layer, g, tab) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'bk-versions-tab';
  el.dataset.g = g.id;
  el.style.cssText = `left:${g.box.x + g.box.w + 12}px;top:${g.box.y - 2}px`;
  el.textContent = `${tab.count} version${tab.count === 1 ? '' : 's'} →`;
  el.disabled = !g.tries_page;
  for (const type of ['pointerdown', 'touchstart']) el.addEventListener(type, e => e.stopPropagation());
  // (the book turns to it as to a find: bookpages.js)
  el.addEventListener('click', () =>
    document.dispatchEvent(new CustomEvent('book:find', { detail: { day: layer.page.day, page: g.tries_page } })),
  );
  return el;
}

// An agent's desk-phone card about a note (hq ask --note), under the note's group on its Notebook page
// (notebookgroups.ts asks): a slip in the answers' look, tinted as an ask, "Lark asks", the card's summary, its Choose:
// as chips and its questions drawn by the desk phone's own fields (questions.js). A tap on a choice answers it; or the
// board answers in the room pulled out under it as under an answer's slip (bookslipreply.js), drawn (the ink goes as a
// picture of it with the answer) or typed with the text tool: no field to type in. It goes to the
// desk phone's own route, so one answer closes the card in both places. Answered, it reads like a ticked slip with the
// pick, the words or the drawing.
// A card for a secret, a step or built work never comes here: it stays on the desk phone (bookasks.ts deskOnly). Its
// look: bookasks.css.
import { esc } from '../../util.js';
import { parseCard } from '../card.js';
import { chips, given, inputHtml } from '../questions.js';
import { sfx } from '../audio.js';
import { pictureUrl, uploadPicture } from '../data.js';
import { answerAsk } from './notebookdata.js';
import { openSpot } from './bookaskspot.js';
import { ROOM, roomHtml, wireRoom } from './bookslipreply.js';
import { inkPicture } from './bookpaperdraw.js';

// The desk phone's name, the company's (brand.js), told by the board's book (book.js): a guest's page has no HQ brand
// to read, and shows no asks of the board's
let phone = 'desk phone';
export const namePhone = name => {
  phone = name;
};

const ASK_CLIP =
  '<svg class="slip-clip" viewBox="0 0 14 34" aria-hidden="true"><path d="M10 9v15a3.5 3.5 0 0 1-7 0V6a5 5 0 0 1 10 0v19"/></svg>';
const ASK_TICK = '<svg class="ask-tick" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13l5.5 5L21 4"/></svg>';

// A group's cards, under its answers. A scrap of an ask about one thing on a page (hq ask --at --spot) says where it
// is, and a tap there opens it (bookaskspot.js). (spot) rooms: the page's rooms pulled out (bookgroups.js), dev: on the
// played store, whose pictures are this visit's
export const asksHtml = (g, rooms, dev) =>
  (g.asks ?? []).map(a => askHtml(a, g.anchor?.el ? spotHtml(g.anchor) : '', rooms, dev)).join('');
// (a card's room, among the page's: its own key, apart from the answers')
const roomKey = a => `ask-${a.id}`;
function askHtml(a, spot, rooms, dev) {
  const c = parseCard(a.body ?? ''),
    said = (c.summary[0] || a.title).trim();
  const by = `<b class="slip-by">${esc(a.name ?? 'An agent')} asks</b>`;
  const head = `${ASK_CLIP}${by}<p class="slip-text">${esc(said)}</p>${spot}`;
  const label = `${a.name ?? 'An agent'} asks: ${a.title}`;
  if (a.status === 'answered')
    return `<section class="ask-slip" data-ask="${a.id}" data-answered aria-label="${esc(label)}, answered">${head}${ASK_TICK}${answerHtml(
      a.answer,
      drawnHtml(a.pictures, dev),
    )}</section>`;
  const choices = c.choices.length ? c.choices.map(ch => ch.label) : c.options;
  const chosen = choices.length
    ? `<div class="ask-chips" role="group" aria-label="Your choice">${choices
        .map(o => `<button type="button" class="chip" data-choice="${esc(o)}" aria-pressed="false">${esc(o)}</button>`)
        .join('')}</div>`
    : a.kind === 'notice'
      ? '<div class="ask-chips"><button type="button" class="chip" data-choice="" aria-pressed="false">Got it</button></div>'
      : '';
  const asked = (a.questions ?? [])
    .map(
      (q, k) =>
        `<div class="ask-q" data-q="${k}"><span class="ask-qt">${esc(q.title)}</span>${
          q.detail ? `<span class="ask-qd">${esc(q.detail)}</span>` : ''
        }<div class="qa">${inputHtml(q, { id: `ask-${a.id}-${k}`, placeholder: q.optional ? 'Optional' : '' })}</div></div>`,
    )
    .join('');
  // (with nothing to tap, the room is what answers it: out from the start)
  const free = !choices.length && !asked && a.kind !== 'notice';
  const room = roomHtml(roomKey(a), a.name ?? 'the agent', rooms.get(roomKey(a)) ?? (free ? ROOM : 0));
  return `<section class="ask-slip" data-ask="${a.id}" aria-label="${esc(label)}">${head}${chosen}${asked}${room}<p class="ask-foot"><span>The same card is on your ${esc(phone)}.</span>${
    asked ? '<button type="button" class="ask-send">Send</button>' : ''
  }</p><p class="slip-said" hidden></p></section>`;
}
// What a card was answered with, under its tick: the words, and the drawing (drawn: its HTML) or else, with no words,
// Got it
const answerHtml = (words, drawn) =>
  `${words || !drawn ? `<p class="ask-answer">${esc(words || 'Got it')}</p>` : ''}${drawn}`;

// The drawings a card was answered with, the pictures that went: at their own px (each drawn at twice it, bookpaperdraw.js
// inkPicture), the same as it answers and once the page reads it again
const drawnHtml = (pictures, dev) =>
  (pictures ?? [])
    .map(id => `<img class="ask-drawn" srcset="${esc(pictureUrl(dev, id))} 2x" alt="Your drawing">`)
    .join('');

// Where an ask's thing is, as a tap that opens it there: the page's name and the thing's selector
function spotHtml(anchor) {
  const url = new URL(anchor.url),
    name = url.pathname.split('/').filter(Boolean).pop() ?? url.host.split('.')[0],
    where = `${name} page · ${anchor.el.selector}`;
  const data = `data-url="${esc(anchor.url)}" data-selector="${esc(anchor.el.selector)}" data-text="${esc(anchor.el.text)}"`;
  return `<button type="button" class="ask-spot" ${data} aria-label="${esc(`Open it: ${where}`)}">${esc(where)}<i aria-hidden="true">↗</i></button>`;
}

// The cards under root wired to the desk phone's answer: a choice tapped answers at once (with the questions' answers
// when it has some), as does Send, each with all that's drawn in its room; so does the room's own Send once something's
// drawn there, or words typed there once they're left, with the questions' answers too. asks: the cards drawn there, by id. answered(): one answered, for the page to read
// again. rooms: the page's pulled out rooms. hooks: wireRoom's hooks (bookslipreply.js), their send this card's
// answer, its book's dev on the played store
export function wireAsks(root, { asks, answered, rooms, hooks }) {
  const { dev } = hooks.book;
  for (const spot of root.querySelectorAll('.ask-spot'))
    spot.addEventListener('click', () => {
      const { url, selector, text } = spot.dataset;
      openSpot({ url, el: { selector, text } });
    });
  // (a drawing that went, once it's loaded: the page laid again round its height)
  for (const img of root.querySelectorAll('img.ask-drawn'))
    if (!img.complete) img.addEventListener('load', hooks.relay, { once: true });
  for (const slip of root.querySelectorAll('.ask-slip:not([data-answered])')) {
    const a = asks.get(Number(slip.dataset.ask));
    if (a) wireAsk(slip, a, { dev, answered }, rooms, hooks);
  }
}
function wireAsk(slip, a, on, rooms, hooks) {
  const said = slip.querySelector('.slip-said'),
    tell = text => Object.assign(said, { textContent: text, hidden: !text });
  for (const chip of slip.querySelectorAll('.ask-q .chip')) chip.addEventListener('click', () => toggled(chip, a));
  // (whatever answers it, what's drawn in its room goes with it)
  const room = wireRoom(slip.querySelector('.bk-slip-room'), rooms, {
    ...hooks,
    send: what => answer(slip, a, on, undefined, { ink: room.drawn(), ...what }),
  });
  const go = pick => answer(slip, a, on, pick, { ink: room.drawn() }).catch(e => tell(e.message));
  for (const chip of slip.querySelectorAll('[data-choice]'))
    chip.addEventListener('click', () => {
      chip.classList.add('on');
      chip.setAttribute('aria-pressed', 'true');
      go(chip.dataset.choice);
    });
  slip.querySelector('.ask-send')?.addEventListener('click', () => go(undefined));
}
// A question's chip tapped: a choice's one on (the others off), a pick-many's on or off
function toggled(chip, a) {
  const q = a.questions[Number(chip.closest('[data-q]').dataset.q)],
    on = !q.many || chip.getAttribute('aria-pressed') !== 'true';
  if (!q.many)
    for (const other of chip.parentElement.querySelectorAll('.chip')) {
      other.classList.remove('on');
      other.setAttribute('aria-pressed', 'false');
    }
  chip.classList.toggle('on', on);
  chip.setAttribute('aria-pressed', String(on));
}
// The card answered as the desk phone answers it (pick: the choice tapped; words typed in its room; ink drawn there,
// going as a picture of it, uploaded for the card as the desk phone's tray uploads one), then shown ticked with the
// answer. Refused, it throws why, the slip staying as it was.
async function answer(slip, a, on, pick, { words = '', ink = [] } = {}) {
  const said = slip.querySelector('.slip-said');
  const tell = text => Object.assign(said, { textContent: text, hidden: !text });
  if (slip.hasAttribute('aria-busy')) throw new Error('Sending…');
  const answers = (a.questions ?? []).map((q, k) => answerIn(slip.querySelector(`[data-q="${k}"]`), q));
  const missing = (a.questions ?? []).findIndex((q, k) => given(q, answers[k]) === null);
  if (missing >= 0) throw new Error(`Question ${missing + 1} still needs its answer`);
  const text = [pick, words.trim()].filter(Boolean).join('\n\n');
  slip.setAttribute('aria-busy', 'true');
  tell('Sending…');
  try {
    const picture = await inkPicture(ink),
      pictures = picture ? [(await uploadPicture(on.dev, picture, { request: a.id })).id] : undefined;
    await answerAsk(on.dev, a.id, text, a.questions?.length ? answers : undefined, pictures);
    sfx.jingle();
    tell('');
    slip.toggleAttribute('data-answered', true);
    for (const el of slip.querySelectorAll('.ask-chips, .ask-q, .bk-slip-room, .ask-foot')) el.remove();
    said.insertAdjacentHTML('beforebegin', `${ASK_TICK}${answerHtml(text, drawnHtml(pictures, on.dev))}`);
    on.answered();
  } catch (e) {
    tell('');
    throw e.status === 400 ? new Error('That didn’t go through: a question still needs its answer.') : e;
  } finally {
    slip.removeAttribute('aria-busy');
  }
}
// A question's answer as its field holds it: the chip (or chips) on, or the box's words
function answerIn(el, q) {
  if (!chips(q)) return el.querySelector('input')?.value ?? '';
  const on = [...el.querySelectorAll('.chip.on')].map(c => c.dataset.answer);
  return q.many ? on : (on[0] ?? '');
}

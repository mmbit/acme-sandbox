// A call drawing in (call.js): the Pencil and the call's agent on the same page.
//   - The Pencil down while the call's screen is in front makes the call small (its bubble): the page is there to
//     write on. That shares nothing by itself.
//   - Each note the Pencil puts on the call's page (shared/review/callnotes.js, told through the document's call:*
//     events) goes to the line as it lifts ({ type: 'note', id }), sent again on a new connection until the line has
//     it. The line fetches it from the book and gives the agent its snip and its words.
//   - The agent asks to see something by name: a card with Show and Not now, no countdown, blocking nothing, until it's
//     tapped. Show starts the watch-along as Show my screen does.
//   - The agent's ink comes down the call's own socket ({ type: 'ink' }); the Pencil draws it in the agent's colour,
//     kept on the call's page, and the line hears whether it could ({ type: 'inked' }).
//   - Hung up, a call that drew leaves its page in the board's day: kept, or thrown away with one tap.
import { esc } from '../util.js';
import { minimise, share } from './callscreen.js';

const $ = s => document.querySelector(s);
const event = (name, detail = null) => document.dispatchEvent(new CustomEvent(name, { detail }));
// An agent's ink: its own colour, the same on every look, readable on paper and HQ alike, and never the board's red
const INKS = ['#7b5ea7', '#12808a', '#4458c9', '#2e8b57', '#b06a12', '#b0417a'];
const inkOf = agent => INKS[[...agent].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % INKS.length];
// The Pencil taking the agent's ink, or nobody (no Pencil on this page) after this long; and how long a hang-up waits
// for the mark still settling to go into the book
const INK_WAIT_MS = 4000,
  FILED_WAIT_MS = 10_000;

// From pickup: the Pencil hears the call is on, and the call hears the Pencil
export function startDrawing(c) {
  if (c.drawing) return resend(c);
  c.notes = new Map(); // note id → sent on this connection
  c.color = inkOf(c.agent);
  const onNote = e => {
    if (e.detail?.call !== c.call) return;
    c.page = e.detail.page;
    if (c.over) return; // (the mark that settled as the call ended: on its page, nobody to hear it)
    c.notes.set(e.detail.id, false);
    resend(c);
  };
  const onPen = e => {
    if (e.pointerType !== 'pen' || c.small || c.over || e.target.closest?.('button, input, textarea, select, a'))
      return;
    minimise(c);
  };
  document.addEventListener('pencil:note', onNote);
  addEventListener('pointerdown', onPen, true);
  c.drawing = () => {
    document.removeEventListener('pencil:note', onNote);
    removeEventListener('pointerdown', onPen, true);
  };
  event('call:on', { call: c.call, agent: c.agent, name: c.name, color: c.color });
}
// Notes the line hasn't said it has, on this connection (a new one: all of them again)
export function resend(c) {
  if (c.ws?.readyState !== 1 || !c.live) return;
  for (const [id, sent] of c.notes ?? [])
    if (!sent) {
      c.notes.set(id, true);
      c.ws.send(JSON.stringify({ type: 'note', id }));
    }
}
export const reconnected = c => c.notes?.forEach((_, id) => c.notes.set(id, false));

// What the line says about drawing in (call.js FROM_LINE)
export const FROM_LINE = {
  // the line has a note, or gave up on it: either way, not sent again
  note: (c, ev) => c.notes?.delete(ev.id),
  heard: (c, ev) => event('call:heard', { text: ev.text }),
  ask: (c, ev) => askCard(c, ev),
  ink(c, ev) {
    let answered = false;
    const reply = ({ drawn, why }) => {
      if (answered || c.over) return;
      answered = true;
      c.ws?.send(JSON.stringify({ type: 'inked', id: ev.id, drawn: !!drawn, ...(why ? { why } : {}) }));
      if (drawn) c.drew = true;
    };
    const nobody = setTimeout(
      () => reply({ drawn: false, why: "HQ's page has no Pencil to draw with just now." }),
      INK_WAIT_MS,
    );
    const { ring = null, note = null, words = '' } = ev;
    event('call:ink', { ring, note, words, color: c.color, reply, taken: () => clearTimeout(nobody) });
  },
};

// ---- the agent's ask to see: one card at a time, the newest, until it's tapped
function askCard(c, ev) {
  if (c.asked?.id === ev.id) return; // (sent again on a new connection)
  c.asked = { id: ev.id };
  const card = cardOf(c, 'ask');
  card.innerHTML = `<p>${esc(c.name)} asks to see <b>${esc(ev.what ?? 'your screen')}</b></p>
    <div class="row"><button type="button" data-show>Show</button><button type="button" data-not>Not now</button></div>`;
  const answer = word => {
    card.remove();
    if (c.asked?.id === ev.id) c.asked = null;
    c.ws?.send(JSON.stringify({ type: 'asked', id: ev.id, answer: word }));
  };
  card.querySelector('[data-show]').onclick = () => {
    share(c);
    answer('show');
  };
  card.querySelector('[data-not]').onclick = () => answer('not now');
}
// A call's card over HQ and the call alike, never recorded (the call's own controls)
function cardOf(c, kind) {
  let box = $('#call-cards');
  if (!box) {
    box = Object.assign(document.createElement('div'), { id: 'call-cards' });
    box.setAttribute('data-watchalong-hide', '');
    document.body.append(box);
  }
  box.querySelector(`[data-card="${kind}"]`)?.remove();
  const card = Object.assign(document.createElement('div'), { className: 'toast call-card' });
  card.dataset.card = kind;
  card.setAttribute('role', 'status'); // (read out as it comes, and nothing waits on it)
  box.append(card);
  return card;
}

// ---- hung up: the Pencil hears it, and a call that drew leaves its page, kept unless thrown away now
export async function stopDrawing(c) {
  $('#call-cards [data-card="ask"]')?.remove();
  if (!c.drawing) return;
  await new Promise(done => {
    event('call:off', { done });
    setTimeout(done, FILED_WAIT_MS);
  });
  c.drawing();
  if (c.page || c.drew) pageCard(c);
}
// The card for the page the call left: its id from the board's notes, or (the agent's ink alone made it) found in
// today's book as Throw away is tapped
function pageCard(c) {
  const card = cardOf(c, 'page');
  card.innerHTML = `<p>Your call with ${esc(c.name)} left a page in today’s book.</p>
    <div class="row"><button type="button" data-keep>Keep</button><button type="button" data-away>Throw away</button></div>`;
  card.querySelector('[data-keep]').onclick = () => card.remove();
  card.querySelector('[data-away]').onclick = async () => {
    try {
      c.page ??= await callPage(c);
      const gone = await post('/api/book/page/delete', { id: c.page });
      if (!gone.ok) throw new Error(`the book answered ${gone.status}`);
      card.remove();
    } catch (err) {
      console.error("HQ: the call's page wasn't thrown away", err);
      card.querySelector('p').textContent = 'The page couldn’t be thrown away just now. Try again?';
    }
  };
}
async function callPage(c) {
  const day = await fetch('/api/book', { credentials: 'same-origin' });
  if (!day.ok) throw new Error(`today's book: ${day.status}`);
  const page = (await day.json()).pages.find(p => p.kind === 'call' && p.call === c.call);
  if (!page) throw new Error(`call ${c.call} has no page in today's book`);
  return page.id;
}
const post = (path, body) =>
  fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

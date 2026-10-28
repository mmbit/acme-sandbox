// A call drawing in (call.js): the Pencil and the call's agent on the same page.
//   - The Pencil down while the call's screen is in front makes the call small (its bubble): the page is there to
//     write on. That shares nothing by itself.
//   - Each note the Pencil puts on the call's page (shared/review/callnotes.js, told through the document's call:*
//     events) goes to the line as it lifts ({ type: 'note', id }), sent again on a new connection until the line has
//     it. The line fetches it from the book and gives the agent its snip and its words.
//   - News on one of them (the book's verdict on it, a try's version landed: a 'book' event naming the call and the
//     note) goes to the line too ({ type: 'noted', id }), which reads the note again.
//   - The agent asks to see something by name: a card with Show and Not now, no countdown, blocking nothing, until it's
//     tapped. Show starts the watch-along as Show my screen does.
//   - The agent's ink comes down the call's own socket ({ type: 'ink', at }): a ring where it aimed on its picture of the
//     board's screen (at: a box in fractions of the screen), drawn exactly there in its colour, over the page and never
//     kept (calldrive.js aimed: in the preview there when that's where it aimed), and the line hears whether it could
//     ({ type: 'inked' }). Nothing here picks what it rings: the agent did, from the picture.
//   - The Pencil down and lifted while the board's screen is shown goes to the line ({ type: 'pen', down }): it answers
//     once the pen rests, so the turn has what was drawn while the board spoke (server.py PEN_REST_SECONDS).
//   - Hung up, a call the board drew on leaves its page in the board's day: kept, or thrown away with one tap (one with
//     a notes page, below, or a page a notebook has since, needs neither: it goes in by itself).
//   - A walk-through (a card's Walk me through it) opens its page as it's picked up; hung up, the page stays only if the
//     board wrote on it, and goes by itself if not (walkthroughs.ts sweeps one HQ couldn't).
//   - The call's notes page (the coordinator's ink/callnotes.ts) is open from pickup: the book turns to it if it's open,
//     with a page brought by its folded corner on it first (bookshare.js), and the agent's scraps land there one by
//     one (asked twice at pickup, and a card says so if it couldn't be opened). A scrap doesn't open the shut book:
//     HQ's book doesn't draw a notebook's groups yet (the pin flow's layer). Hung up, the store sends the page and
//     archives it.
import { esc } from '../../util.js';
import { minimise, share, shown } from '../callscreen.js';
import { aimed } from '../calldrive.js';
import { cardOf } from '../callcards.js'; // (the call engine's)
import { inkOf } from './agentink.js'; // (an agent's ink, shared with the store's typed answers)

const $ = s => document.querySelector(s);
const event = (name, detail = null) => document.dispatchEvent(new CustomEvent(name, { detail }));
// How long a hang-up waits for the mark still settling to go into the book
const FILED_WAIT_MS = 10_000;

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
    if (e.pointerType !== 'pen' || c.over || e.target.closest?.('button, input, textarea, select, a, .callbubble'))
      return;
    minimise(c); // (the same bubble as its own key's.)
  };
  // (a lift goes whenever its touch went, shown or not since)
  const penMoved = e => {
    const down = e.type === 'pointerdown';
    if (e.pointerType !== 'pen' || !e.isPrimary || c.ws?.readyState !== 1 || down === !!c.penDown) return;
    if (down && (c.over || !shown(c) || e.target.closest?.('.callbubble'))) return;
    c.penDown = down;
    c.ws.send(JSON.stringify({ type: 'pen', down }));
  };
  // (news on one of this call's notes: its verdict, a version landed.)
  const onNoted = e => {
    if (e.detail?.call === c.call && !c.over && c.ws?.readyState === 1)
      c.ws.send(JSON.stringify({ type: 'noted', id: e.detail.note }));
  };
  const pen = ['pointerdown', 'pointerup', 'pointercancel'];
  document.addEventListener('pencil:note', onNote);
  document.addEventListener('call:noted', onNoted);
  addEventListener('pointerdown', onPen, true);
  for (const type of pen) addEventListener(type, penMoved, true);
  notesPage(c);
  c.drawing = () => {
    document.removeEventListener('pencil:note', onNote);
    document.removeEventListener('call:noted', onNoted);
    removeEventListener('pointerdown', onPen, true);
    for (const type of pen) removeEventListener(type, penMoved, true);
  };
  event('call:on', { call: c.call, agent: c.agent, name: c.name, color: c.color, walk: c.walk });
}
// The call's notes page, made as the call is picked up (with the page brought to it, c.brought), and the book turned to
// it if it's open. Asked once more if the network dropped the ask; one the store still can't make, the board hears of
// on a card.
async function notesPage(c) {
  const ask = () => post('/api/notebooks/call', { call: c.call, ...(c.brought ? { page: c.brought } : {}) });
  try {
    const r = await ask().catch(ask);
    if (!r.ok) throw new Error(`the store answered ${r.status}`);
    const { page } = await r.json();
    c.notesPage = { id: page.id };
    if (!c.over) event('book:paged', { page: page.id });
  } catch (err) {
    console.error("HQ: the call's notes page", err);
    if (!c.over) notesCard(c);
  }
}
function notesCard(c) {
  const card = cardOf(c, 'notes');
  card.innerHTML = `<p>This call’s notes page couldn’t be opened.</p>
    <div class="row"><button type="button" data-ok>OK</button></div>`;
  card.querySelector('[data-ok]').onclick = () => card.remove();
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
  async ink(c, ev) {
    const { at, words = '' } = ev;
    const answer = await aimed(c, { ring: at, words });
    if (!c.over)
      c.ws?.send(
        JSON.stringify({ type: 'inked', id: ev.id, drawn: !!answer.done, ...(answer.why ? { why: answer.why } : {}) }),
      );
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
  // (a share that doesn't start leaves the ask waiting, the card saying so: the agent hears Show only once it's shown)
  // (both buttons wait while it starts, so the ask is answered once)
  const show = card.querySelector('[data-show]');
  const not = card.querySelector('[data-not]');
  show.onclick = async () => {
    show.disabled = not.disabled = true;
    if (await share(c)) return answer('show');
    show.disabled = not.disabled = false;
    card.querySelector('p').textContent = 'Your screen couldn’t be shown. Tap Show to try again.';
  };
  not.onclick = () => answer('not now');
}
// ---- hung up: the Pencil hears it, and a call that drew leaves its page, kept unless thrown away now
export async function stopDrawing(c) {
  $('#call-cards [data-card="ask"]')?.remove();
  $('#call-cards [data-card="notes"]')?.remove();
  if (!c.drawing) return;
  await new Promise(done => {
    event('call:off', { done });
    setTimeout(done, FILED_WAIT_MS);
  });
  c.drawing();
  // (a call's notes page goes in by itself, sent and archived: the store's, callnotes.ts)
  if (c.notesPage || !(c.walk || c.page)) return;
  pageEnded(c);
}
// The call's page as the call ends, when it wasn't opened as the notes page: let be if My Notebook has it since (made
// the notes page by the agent's first scrap, or carried there: the store's); a walk-through's kept, with
// the card, if the board wrote on it (a note of its own, the book's ink or a picture), else thrown away; any other's,
// the card. Left as it is if the book can't say: the sweep takes an empty one.
async function pageEnded(c) {
  try {
    const page = await callPage(c);
    if (page.notebook) return;
    if (!c.walk) return pageCard(c);
    const notes = await fetch(`/api/book/notes?page=${page.id}`, { credentials: 'same-origin' });
    if (!notes.ok) throw new Error(`its notes: ${notes.status}`);
    const written = page.strokes || page.pictures || (await notes.json()).notes.some(n => n.by !== c.agent);
    if (written) return pageCard(c);
    const gone = await post('/api/book/page/delete', { id: page.id });
    if (!gone.ok) throw new Error(`the book answered ${gone.status}`);
    event('book:paged');
  } catch (err) {
    console.error('[hq] the call’s page wasn’t looked at:', err);
  }
}
// The card for the page the call left, its id from the board's notes
function pageCard(c) {
  const card = cardOf(c, 'page');
  card.innerHTML = `<p>Your call with ${esc(c.name)} left a page in today’s book.</p>
    <div class="row"><button type="button" data-keep>Keep</button><button type="button" data-away>Throw away</button></div>`;
  card.querySelector('[data-keep]').onclick = () => card.remove();
  card.querySelector('[data-away]').onclick = async () => {
    try {
      const gone = await post('/api/book/page/delete', { id: c.page });
      if (!gone.ok) throw new Error(`the book answered ${gone.status}`);
      card.remove();
      event('book:paged');
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
  return page;
}
const post = (path, body) =>
  fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

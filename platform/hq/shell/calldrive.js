// The call's agent opening a piece of work on the board's screen and driving it (call.js).
//   - It suggests opening something ({ type: 'open', id, what, url }): a card "Kit suggests opening …" with Open and Not
//     now, which blocks nothing and waits until it's tapped. Open makes the call small and opens it: a preview in HQ's
//     viewer, or one of HQ's own screens by its address (/?open=jobs&job=12, as a notification's: main.js), with a card
//     to go back to where the board was. The line hears the tap ({ type: 'opened' }), or why it couldn't open.
//   - It drives what's on screen ({ type: 'drive', id, to | by | point }): shared/review/drive.js (/__review/drive.js,
//     a part of review mode's, as the Pencil's are) scrolls or points in the agent's ink, on HQ's page or, with a
//     preview open, in the viewer's frame (review mode there answers: review.js). The line hears whether it could ({ type: 'driven' }). Nothing stops the board taking over: its own
//     touch, scroll or Pencil works throughout, and the agent rings things with its ink as before (calldraw.js).
import { esc } from '../util.js';
import { minimise } from './callscreen.js';
import { cardOf } from './calldraw.js';
import { PREVIEW, closeTool, openLink, viewerOrigin } from './desk.js';
import { closeProjects } from './projects.js';

const $ = s => document.querySelector(s);
// The preview in the viewer answering a drive, or not, within this (the line waits 5 s for HQ: driving.py)
const FRAME_MS = 4000;
const NO_ANSWER = "The preview didn't answer: review mode may not run on that page.";

export const FROM_LINE = {
  open: (c, ev) => openCard(c, ev),
  async drive(c, ev) {
    const { id, to, by, point } = ev,
      d = { ...(to != null ? { to } : by != null ? { by } : { point }), color: c.color, name: c.name };
    let answer;
    try {
      answer = viewerFrame() ? await inFrame(d) : await (await import('/__review/drive.js')).drive(d);
    } catch (err) {
      console.error('[hq] the agent’s drive:', err);
      answer = { done: false, why: `HQ couldn't do it (${err?.message || err}).` };
    }
    if (!c.over)
      c.ws?.send(
        JSON.stringify({ type: 'driven', id, done: !!answer.done, ...(answer.why ? { why: answer.why } : {}) }),
      );
  },
};

// ---- the agent's suggestion: one card at a time, the newest, until it's tapped
function openCard(c, ev) {
  if (c.suggested === ev.id) return; // (sent again on a new connection)
  c.suggested = ev.id;
  const card = cardOf(c, 'open');
  card.innerHTML = `<p>${esc(c.name)} suggests opening <b>${esc(ev.what ?? 'something')}</b></p>
    <div class="row"><button type="button" data-open>Open</button><button type="button" data-not>Not now</button></div>`;
  const answer = (word, why) => {
    card.remove();
    if (c.suggested === ev.id) c.suggested = null;
    c.ws?.send(JSON.stringify({ type: 'opened', id: ev.id, answer: word, ...(why ? { why } : {}) }));
  };
  card.querySelector('[data-not]').onclick = () => answer('not now');
  card.querySelector('[data-open]').onclick = async () => {
    const why = await opened(c, ev.url);
    if (why) return answer('failed', why);
    answer('open');
    backCard(c, ev.what, screenOf(ev.url));
  };
}
// The HQ screen an address opens (its first open), or none
const screenOf = address => {
  const own = String(address ?? '').startsWith('/') ? new URL(address, location.origin) : null;
  return (own?.pathname === '/' && own.searchParams.get('open')) || null;
};
// The work on the board's screen, the call small over it; or why not
async function opened(c, url) {
  const address = String(url ?? '');
  const own = address.startsWith('/') ? new URL(address, location.origin) : null;
  const tool = screenOf(address);
  if (!PREVIEW.test(address) && !tool) return `HQ opens only a preview's page or one of its own screens (${address}).`;
  await minimise(c);
  if (!tool) return void openLink(address);
  let shown = false;
  dispatchEvent(
    // (the first open is the screen asked for and the one the line allowed: a later one doesn't open another)
    new CustomEvent('hq:open', {
      detail: { ...Object.fromEntries(own.searchParams), open: tool, done: ok => (shown = ok) },
    }),
  );
  return shown ? '' : `HQ has no screen called ${tool}.`;
}
// Back to where the board was: what the agent opened closes (the viewer, or HQ's screen), and the card goes
function backCard(c, what, screen) {
  const card = cardOf(c, 'back'),
    viewer = !$('#viewer')?.hidden;
  card.innerHTML = `<p>${esc(c.name)} opened <b>${esc(what ?? 'something')}</b></p>
    <div class="row"><button type="button" data-back>‹ Back</button></div>`;
  card.querySelector('[data-back]').onclick = () => {
    card.remove();
    if (viewer)
      $('#viewer [data-close]')?.click(); // (the viewer's own Close)
    else if (screen === 'jobs' || screen === 'projects')
      closeProjects(); // (the projects view isn't a desk tool: closeTool doesn't know it)
    else closeTool();
  };
}

// ---- driving the preview in HQ's viewer: review mode there does it (review.js), and says how it went. The agent's
// ring goes there too (calldraw.js)
export const viewerFrame = () => (!$('#viewer')?.hidden && $('#viewer iframe')) || null;
let asks = 0;
export function inFrame(d) {
  const frame = viewerFrame(),
    origin = viewerOrigin(), // (the page review mode runs on: the frame may have gone on to another, which hears nothing)
    id = ++asks;
  if (!origin) return Promise.resolve({ done: false, why: NO_ANSWER });
  return new Promise(done => {
    const heard = e => {
      if (
        e.source !== frame.contentWindow ||
        e.origin !== origin ||
        e.data?.hq !== 'review' ||
        e.data.driven?.id !== id
      )
        return;
      finish(e.data.driven);
    };
    const finish = answer => {
      removeEventListener('message', heard);
      clearTimeout(late);
      done(answer);
    };
    const late = setTimeout(() => finish({ done: false, why: NO_ANSWER }), FRAME_MS);
    addEventListener('message', heard);
    // (the agent's words to find and its name: nothing the page may not see)
    frame.contentWindow.postMessage({ hq: 'hq', drive: { ...d, id } }, origin);
  });
}
// Hung up: its cards go with it, and its rings and pointer in the preview
export function stopDriving() {
  for (const kind of ['open', 'back']) $(`#call-cards [data-card="${kind}"]`)?.remove();
  const origin = viewerOrigin();
  if (origin) viewerFrame()?.contentWindow.postMessage({ hq: 'hq', drive: { wipe: true } }, origin);
}

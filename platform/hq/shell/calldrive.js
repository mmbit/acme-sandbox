// The call's agent opening a piece of work on the board's screen and driving it (call.js).
//   - It suggests opening something ({ type: 'open', id, what, url }): a card "Kit suggests opening …" with Open and Not
//     now, which blocks nothing and waits until it's tapped. Open makes the call small and opens it: a preview in HQ's
//     viewer, or one of HQ's own screens by its address (/?open=jobs&job=12, as a notification's: main.js). The line
//     hears the tap ({ type: 'opened', shown }), or why it couldn't open. What opened is all the board sees: no
//     card about it on top, and the desk's tool it was on (the intercom) closed under it, so the opened screen's own
//     close goes back to HQ.
//     Showing is the same step: with the board's screen not shown to the call, the key reads Open and show, and the tap
//     is the board's choice to show it, as Show my screen is (callscreen.js); nothing else starts a share. What's open
//     already (the book, the same preview) comes forward as it is, never loaded again.
//   - It drives what's on screen ({ type: 'drive', id, to | by | point }): shared/review/drive.js (/__review/drive.js,
//     a part of review mode's, as the Pencil's are) scrolls or points in the agent's ink, on HQ's page or, with a
//     preview open, in the viewer's frame (review mode there answers: review.js). It points, and rings (calldraw.js),
//     where it aimed on its picture of the screen, in the frame when that's where it aimed (aimed). The line hears
//     whether it could ({ type: 'driven' }). Nothing stops the board taking over: its own touch, scroll or Pencil works
//     throughout.
import { esc } from '../util.js';
import { minimise, share, shown } from './callscreen.js';
import { cardOf } from './calldraw.js';
import { PREVIEW, closeTool, openLink, viewerOrigin, viewerUrl } from './desk.js';

const $ = s => document.querySelector(s);
// The preview in the viewer answering a drive, or not, within this (the line waits 5 s for HQ: driving.py)
const FRAME_MS = 4000;
const NO_ANSWER = "The preview didn't answer: review mode may not run on that page.";

export const FROM_LINE = {
  open: (c, ev) => openCard(c, ev),
  async drive(c, ev) {
    const { id, to, by, point } = ev;
    let answer;
    if (point != null) answer = await aimed(c, { point });
    else
      try {
        const d = { ...(to != null ? { to } : { by }), color: c.color, name: c.name };
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
    <div class="row"><button type="button" data-open>${shown(c) ? 'Open' : 'Open and show'}</button><button type="button" data-not>Not now</button></div>`;
  const answer = (word, more = {}) => {
    card.remove();
    if (c.suggested === ev.id) c.suggested = null;
    c.ws?.send(JSON.stringify({ type: 'opened', id: ev.id, answer: word, shown: shown(c), ...more }));
  };
  card.querySelector('[data-not]').onclick = () => answer('not now');
  card.querySelector('[data-open]').onclick = async () => {
    const { why } = await opened(c, ev.url);
    if (why) return answer('failed', { why });
    await share(c); // (the tap's own choice to show, so the call sees what opened)
    answer('open');
  };
}
// The HQ screen an address opens (its first open), or none
const screenOf = address => {
  const own = String(address ?? '').startsWith('/') ? new URL(address, location.origin) : null;
  return (own?.pathname === '/' && own.searchParams.get('open')) || null;
};
// The work on the board's screen, the call small over it: { why } it couldn't, { already } when it was open and only
// came forward
async function opened(c, url) {
  const address = String(url ?? '');
  const own = address.startsWith('/') ? new URL(address, location.origin) : null;
  const tool = screenOf(address);
  if (!PREVIEW.test(address) && !tool)
    return { why: `HQ opens only a preview's page or one of its own screens (${address}).` };
  const already = tool
    ? tool === 'book' && document.documentElement.dataset.book !== 'folded'
    : address === viewerUrl();
  await minimise(c);
  // (the book sits beside the desk's tools, and opens over them; a preview's viewer opens over them too, so the tool
  // goes under it as well)
  if (!already && tool !== 'book') closeTool();
  if (!tool) {
    if (!already) openLink(address);
    return { already };
  }
  let found = false;
  dispatchEvent(
    // (the first open is the screen asked for and the one the line allowed: a later one doesn't open another)
    new CustomEvent('hq:open', {
      detail: { ...Object.fromEntries(own.searchParams), open: tool, done: ok => (found = ok) },
    }),
  );
  return found ? { already } : { why: `HQ has no screen called ${tool}.` };
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
// ---- where the agent aimed on its picture of the board's screen (fractions of it: the picture is the whole window),
// on HQ's page or in the preview's frame when that's what's there, the point or box in the frame's own px (it may be
// drawn smaller than its page is wide).
export async function aimed(c, { ring, point, words = '' }) {
  const at = ring ?? { ...point, width: 0, height: 0 },
    box = { x: at.x * innerWidth, y: at.y * innerHeight, w: at.width * innerWidth, h: at.height * innerHeight };
  const frame = viewerFrame(),
    f = frame?.getBoundingClientRect(),
    [mx, my] = [box.x + box.w / 2, box.y + box.h / 2],
    inside = f && mx >= f.left && mx < f.right && my >= f.top && my < f.bottom;
  const k = inside ? f.width / (frame.offsetWidth || f.width) : 1,
    local = inside ? { x: (box.x - f.left) / k, y: (box.y - f.top) / k, w: box.w / k, h: box.h / k } : box;
  const d = {
    ...(ring ? { ring: local, words } : { point: { x: local.x, y: local.y } }),
    color: c.color,
    name: c.name,
  };
  try {
    return inside ? await inFrame(d) : await (await import('/__review/drive.js')).drive(d);
  } catch (err) {
    console.error('[hq] the agent’s aim:', err);
    return { done: false, why: `HQ couldn't draw it (${err?.message || err}).` };
  }
}
// Hung up: its cards go with it, and its rings and pointer, on HQ's page and in the preview
export function stopDriving() {
  $('#call-cards [data-card="open"]')?.remove();
  import('/__review/drive.js')
    .then(m => m.drive({ wipe: true }))
    .catch(err => console.error('[hq] the agent’s rings weren’t wiped:', err));
  const origin = viewerOrigin();
  if (origin) viewerFrame()?.contentWindow.postMessage({ hq: 'hq', drive: { wipe: true } }, origin);
}

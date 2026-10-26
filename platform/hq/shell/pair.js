// A second screen: a phone or tablet paired with a desktop for one session by a code the book shows (its QR, and six
// digits to type). Both are the board's own HQ, signed in as ever; the code only joins them, good once, for a minute.
// Paired, one screen holds HQ's page full screen and the other the book beside its page, and the rail's swap trades
// them in a moment, as often as the board likes. Marks and notes are live both ways: a line drawn on either shows on
// the other as it's drawn (pairink.js), a mark made on the page's screen finishes on the book's (post-it and caret
// ready there: ring on the phone, type on the computer), and a post-it flicked away goes to the other screen
// (shared/review/handover.js). A note filed, a sheet changed or a page turned on one reads again on the other; each
// screen folds its own book. The channel is the coordinator's (pair.ts): one stream in, posts out, picked up again
// after a drop; nothing of it is kept.
import { esc, stylesheet } from '../util.js';
import { act } from './data.js';
import { toast } from './hud.js';
import { qrCode, qrPath } from '/shared/qr/qr.js';
import { foldBook, openBook, showBookPage } from './book.js';
import { refreshRail } from './bookrail.js';
import { forget, heard, mountInk } from './pairink.js';

// A code shows this long before the next replaces it, while the card is open (the coordinator's own minute, less the
// time a phone takes to read it); the card folds away after this long unused
const RENEW_MS = 50_000,
  CARD_MS = 4 * 60_000;
// A mark made on the page's screen goes to the book's this long after its last line, unless it's typed into here
const SETTLE_MS = 1500;
const KEPT = 'hq.pair'; // (this tab's pairing, kept across a reload: sessionStorage, so it ends with the tab)

const PHONE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10.5 18.5h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const SWAP =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// p: the pairing ({ pair, key, side, role: 'book' | 'page', other: 'phone' | 'tablet' | 'computer' }), or null
let p = null,
  stream = null,
  card = null,
  swapButton = null,
  renewing = 0,
  folding = 0,
  settling = 0,
  outbox = Promise.resolve(),
  unreached = false, // (a send didn't get there: told once, till one does again)
  opens = {},
  shown = null, // (what's open on HQ's page here: { open, app })
  lastMark = null, // (the Pencil's open mark here, as last told)
  turned = null, // (the book's page shown here, as last told)
  following = false;
// A code from a QR's link (?pair=123456), kept through a sign-in on the way
const asked = new URLSearchParams(location.search).get('pair');
if (asked) {
  sessionStorage.setItem(`${KEPT}.code`, asked);
  const q = new URLSearchParams(location.search);
  q.delete('pair');
  history.replaceState(null, '', location.pathname + (q.size ? `?${q}` : '') + location.hash);
}

// follow: what opens HQ's pages here, by what the other screen opened ({ phone, intercom, computer(app), close })
export function initPair(follow) {
  opens = follow;
  const leaf = document.querySelector('#book .bk-leaf'),
    foot = document.querySelector('#book .bk-rail .bk-foot');
  if (!leaf || !foot) return;
  stylesheet('shell/pair.css');
  card = document.createElement('section');
  card.className = 'pair-card';
  card.setAttribute('aria-label', 'Another screen');
  leaf.append(card);
  swapButton = document.createElement('button');
  swapButton.className = 'bk-swap';
  swapButton.hidden = true;
  swapButton.innerHTML = `${SWAP}<span class="sr">Swap screens</span>`;
  swapButton.addEventListener('click', swap);
  foot.prepend(swapButton);
  mountInk(events => tell(...events));
  card.addEventListener('click', clicked);
  card.addEventListener('submit', e => (e.preventDefault(), join(card.querySelector('input').value)));
  hear();
  const code = sessionStorage.getItem(`${KEPT}.code`);
  sessionStorage.removeItem(`${KEPT}.code`);
  const kept = JSON.parse(sessionStorage.getItem(KEPT) ?? 'null');
  if (code) join(code);
  else if (kept?.pair) connect(kept);
  else draw('rest');
}

// ---- the card at the book's foot
function draw(state, code) {
  if (!card) return;
  card.dataset.state = state;
  const other = p && esc(p.other); // (the other screen's own word for itself: text, never markup)
  if (state === 'rest')
    card.innerHTML = `<button class="pair-ask" data-do="ask">${PHONE}<span>Draw from your phone</span></button>`;
  else if (state === 'code') {
    const link = `${location.origin}/?pair=${code.code}`,
      qr = qrCode(link, { level: 'M' }),
      n = qr.size + 8;
    card.innerHTML = `<svg class="pair-qr" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="A code to scan"><rect width="${n}" height="${n}" fill="#fff"/><path d="${qrPath(qr)}"/></svg>
      <div class="pair-words"><b>Draw from your phone</b><span>Point its camera here, or type <b class="pair-digits">${esc(code.code.replace(/(\d{3})(\d{3})/, '$1 $2'))}</b> on it. Good once, for a minute.</span>
      <form class="pair-join"><input inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="A code from the other screen" aria-label="A code from the other screen"><button>Join</button></form></div>
      <button class="pair-x" data-do="close" aria-label="Not now">×</button>`;
  } else if (state === 'waiting') card.innerHTML = `<p class="pair-line">${PHONE}<span>Joining…</span></p>`;
  else if (state === 'paired' || state === 'away')
    card.innerHTML = `<p class="pair-line">${PHONE}<span>${
      state === 'away'
        ? `Your ${other} is out of reach: it picks up again by itself`
        : p.side === 'a'
          ? `Your ${other} draws here · live both ways`
          : `Paired with your ${other} · live both ways`
    }</span><button data-do="end">Close</button></p>`;
}
function clicked(e) {
  const what = e.target.closest('[data-do]')?.dataset.do;
  if (what === 'ask') ask();
  else if (what === 'close') rest();
  else if (what === 'end') end(true);
}
// A code for this screen, renewed while the card is open
async function ask() {
  clearTimeout(renewing);
  try {
    const kept = p && !p.paired ? { pair: p.pair, key: p.key } : {};
    const code = await act('/api/pair', kept);
    if (!p || p.pair !== code.pair) start({ pair: code.pair, key: code.key, side: code.side, role: 'book' });
    draw('code', code);
    renewing = setTimeout(ask, RENEW_MS);
    clearTimeout(folding);
    folding = setTimeout(rest, CARD_MS);
  } catch (err) {
    toast(`<b>No code just now.</b> ${esc(err.message)}`);
  }
}
function rest() {
  clearTimeout(renewing);
  clearTimeout(folding);
  if (p && !p.paired) end(true);
  else draw(p ? 'paired' : 'rest');
}
async function join(typed) {
  const code = String(typed ?? '').replace(/\D/g, '');
  if (code.length !== 6) return toast('<b>That code has six digits.</b> The other screen shows it under its QR.');
  try {
    const joined = await act('/api/pair/join', { code });
    start({ pair: joined.pair, key: joined.key, side: joined.side, role: 'page' });
  } catch (err) {
    const why =
      err.status === 410
        ? 'That code has gone: the other screen shows a new one.'
        : err.status === 404
          ? 'No screen shows that code.'
          : err.message;
    toast(`<b>Not paired.</b> ${esc(why)}`);
    draw('rest');
  }
}

// ---- the channel
function start(pairing) {
  forget();
  connect(pairing);
}
// (a reload's pairing picks up where it was: the code's card, if it still shows, stays as it is)
function connect(pairing) {
  p = { other: 'phone', ...pairing, paired: false };
  sessionStorage.setItem(KEPT, JSON.stringify({ pair: p.pair, key: p.key, side: p.side, role: p.role }));
  if (card.dataset.state !== 'code') draw(p.side === 'b' ? 'waiting' : 'rest');
  stream?.close();
  stream = new EventSource(`/api/pair/live?pair=${encodeURIComponent(p.pair)}&key=${encodeURIComponent(p.key)}`);
  stream.onmessage = e => {
    try {
      got(JSON.parse(e.data));
    } catch (err) {
      console.error('[hq] The other screen:', err);
    }
  };
  // (the browser picks a dropped stream up again by itself; one the coordinator refused for good is closed)
  stream.onerror = () => stream?.readyState === EventSource.CLOSED && ended();
}
// Events to the other screen, in order, one post at a time: whether they got there. One that didn't is told (a mark's
// by its sender, which keeps it), and a pairing the coordinator has ended ends here quietly
function tell(...events) {
  if (!p?.paired) return Promise.resolve(false);
  const { pair, key } = p;
  const sent = outbox.then(() => act('/api/pair/send', { pair, key, events }));
  outbox = sent.then(
    () => (unreached = false),
    err => {
      if (err.status === 410) return ended();
      if (!unreached && !events.some(e => e.tag === 'take'))
        toast(`<b>Your ${esc(p?.other ?? 'other screen')} wasn’t reached.</b> ${esc(err.message)}`);
      unreached = true;
    },
  );
  return sent.then(
    () => true,
    () => false,
  );
}
function got({ tag, payload = {} }) {
  if (tag === 'pair') return state(payload.state);
  if (heard({ tag, payload })) return;
  if (tag === 'hello') {
    p.other = payload.screen ?? p.other;
    if (payload.role) role(payload.role === 'book' ? 'page' : 'book');
    draw('paired');
  } else if (tag === 'swap') role(payload.role);
  else if (tag === 'take') take(payload);
  else if (tag === 'book') refreshRail();
  else if (tag === 'turn') showBookPage(payload.page);
  else if (tag === 'open') follow(payload);
}
function state(now) {
  if (now === 'paired') {
    const first = !p.paired;
    p.paired = true;
    document.documentElement.dataset.paired = p.role; // (which this screen holds)
    swapButton.hidden = false;
    clearTimeout(renewing);
    clearTimeout(folding);
    // (each says what it is and, the first time, which it holds: the screen that showed the code the book)
    tell({ tag: 'hello', payload: { screen: screenKind(), ...(first && p.side === 'a' && { role: p.role }) } });
    // (the screen that showed the code opens the other on its own page)
    if (first && p.side === 'a' && shown) tell({ tag: 'open', payload: shown });
    if (first) {
      role(p.role);
      toast(
        `<b>Paired.</b> ${p.role === 'book' ? 'The book stays here, the page goes there.' : 'The page here, the book there.'}`,
      );
    }
    draw('paired');
  } else if (now === 'away' && p.paired) draw('away');
  else if (now === 'back' && p.paired) {
    // (what it missed while away may be past the coordinator's memory: this screen's state again)
    tell({ tag: 'hello', payload: { screen: screenKind() } });
    if (shown) tell({ tag: 'open', payload: shown });
    if (lastMark) tell({ tag: 'mark', payload: { mark: lastMark } });
    draw('paired');
  } else if (now === 'ended') ended();
}
function screenKind() {
  const short = Math.min(screen.width, screen.height);
  return navigator.maxTouchPoints > 0 ? (short < 600 ? 'phone' : 'tablet') : 'computer';
}
// This screen holds the book (open beside its page) or the page (the book folded into the rail)
function role(r) {
  p.role = r === 'page' ? 'page' : 'book';
  document.documentElement.dataset.paired = p.role;
  sessionStorage.setItem(KEPT, JSON.stringify({ pair: p.pair, key: p.key, side: p.side, role: p.role }));
  if (p.role === 'book') openBook();
  else foldBook();
  swapButton.title =
    p.role === 'book'
      ? `Swap: the book to your ${p.other}, the page here`
      : `Swap: the book here, the page to your ${p.other}`;
}
function swap() {
  if (!p?.paired) return;
  const mine = p.role === 'book' ? 'page' : 'book';
  tell({ tag: 'swap', payload: { role: p.role } });
  role(mine);
}
async function end(asked) {
  const was = p;
  ended();
  if (asked && was) await act('/api/pair/end', { pair: was.pair, key: was.key }).catch(() => {});
}
function ended() {
  const was = p?.paired;
  stream?.close();
  stream = null;
  p = null;
  outbox = Promise.resolve();
  sessionStorage.removeItem(KEPT);
  delete document.documentElement.dataset.paired;
  if (swapButton) swapButton.hidden = true;
  forget();
  draw('rest');
  if (was) toast('<b>The other screen has gone.</b> This one carries on alone.');
}

// ---- what goes across
function hear() {
  document.addEventListener('pencil:mark', e => {
    const mark = (lastMark = e.detail?.mark ?? null);
    tell({ tag: 'mark', payload: { mark } });
    // a mark made here, on the page's screen, finishes on the book's once the pen has rested, its words said so far
    // with it (one being typed into here stays, and so does one the other screen sent here to finish)
    clearTimeout(settling);
    if (p?.paired && p.role === 'page' && mark && !mark.typed && !mark.taken)
      settling = setTimeout(handOver, SETTLE_MS);
  });
  document.addEventListener('pencil:flick', () => handOver());
  // notes and sheets changed here: the other screen's book reads them again
  const changed = () => tell({ tag: 'book', payload: {} });
  document.addEventListener('pencil:note', changed);
  document.addEventListener('book:wrote', changed);
  // (the book says which page it shows each time it comes to rest: only a new one goes across)
  document.addEventListener('book:turn', ({ detail: { page } }) => {
    if (page && page !== turned) tell({ tag: 'turn', payload: { page } });
    turned = page;
  });
  document.addEventListener('hq:open', e => {
    shown = e.detail.open ? e.detail : null;
    if (!following) tell({ tag: 'open', payload: e.detail });
  });
}
// (a mark that doesn't reach the other screen opens here again)
function handOver() {
  clearTimeout(settling);
  if (!p?.paired) return;
  const other = p.other;
  const reply = mark =>
    mark &&
    tell({ tag: 'take', payload: { mark } }).then(got => {
      if (got) return;
      toast(`<b>Your ${esc(other)} wasn’t reached.</b> The mark stays here.`);
      take({ mark, back: true });
    });
  document.dispatchEvent(new CustomEvent('pencil:hand', { detail: { give: true, reply } }));
}
// A mark from the other screen, to finish here. While one of this screen's own is open it goes back, nothing lost (and
// one that came back while a new one was begun there, or couldn't get back, is the board's to make again: it's told)
function take({ mark, back = false }) {
  if (!mark) return;
  const lost = () =>
    toast('<b>A mark from your other screen didn’t fit in.</b> One was open here already: make it again.');
  const reply = took => {
    if (took) return;
    if (back) return lost();
    tell({ tag: 'take', payload: { mark, back: true } }).then(got => got || lost());
  };
  // (back: this screen's own, which goes where it was drawn.)
  document.dispatchEvent(new CustomEvent('pencil:hand', { detail: { take: mark, back, reply } }));
}
// The other screen opened one of HQ's pages (or closed it): this one does too, without telling it back
function follow({ open, app }) {
  if (open === (shown?.open ?? null) && (open !== 'computer' || app === shown?.app)) return;
  following = true;
  try {
    if (!open) opens.close?.();
    else opens[open]?.(app);
  } finally {
    following = false;
  }
}

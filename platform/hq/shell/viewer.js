// HQ's viewer's stage: staging (the preview the viewer opened) beside the same page live, at a device's size, their
// scroll linked; tabs where both don't fit; the notebook over the frames or beside them; and a QR code that opens the
// same view on a phone or tablet. desk.js keeps the bar and the staging frame's review mode.
import { store } from '../util.js';
import * as world from '../world/world.js';
import { loadArtifacts } from './data.js';
import { sfx } from './audio.js';
import { DEVICES, GAP, HEAD, devicesFor, fit, chosen, bookChoice } from './viewerfit.js';
import { shapeOf } from './ink/booklayout.js';
import { openBook, foldBook } from './ink/book.js';
import { pairLink, qrSvg } from './ink/pair.js';

// A frame that scrolled leads for this long after its last scroll: the other's scrolls meanwhile are its own following
// (or stopping short at its end), never passed back
const LEAD_MS = 300;
const SIDES = { live: 'Live', after: 'Staging' };
const LINK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3.6-3.6a4 4 0 0 0-5.7-5.7L12 6.3M14 10a4 4 0 0 0-5.7 0l-3.6 3.6a4 4 0 0 0 5.7 5.7l1.6-1.6"/></svg>`;
const QR = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2v2h-2zM18 14h2v2h-2z"/></svg>`;
const shape = () => shapeOf(innerWidth, innerHeight);
const recalled = () => chosen(store.get(`viewer.${shape()}`, null), devicesFor(innerWidth), shape());

// The stage in the viewer v, for the preview at url. Returns { close }: the viewer's Close or its next page.
export function mountStage(v, url) {
  const me = {
    url,
    stage: v.querySelector('.stage'),
    choices: Object.assign(document.createElement('div'), { className: 'choices' }),
    qrCard: Object.assign(document.createElement('div'), { className: 'qrcard', hidden: true }),
    picked: recalled(),
    shape: shape(),
    live: null,
    tab: 'after',
    linked: true,
    leader: null,
    ledAt: 0,
    closed: false,
  };
  v.querySelector('.bar .pin').before(me.choices);
  v.append(me.qrCard);
  me.choices.addEventListener('click', e => choose(me, e.target.closest('button')));
  me.stage.querySelector('.head').addEventListener('click', e => tapHead(me, e.target.closest('button')));
  addLive(me);
  const sized = new ResizeObserver(() => lay(me)),
    turned = () => turn(me),
    scrolled = e => linkScroll(me, e);
  sized.observe(me.stage);
  addEventListener('resize', turned);
  addEventListener('message', scrolled);
  paintChoices(me);
  tellBook(me);
  lay(me);
  return {
    close() {
      me.closed = true;
      sized.disconnect();
      removeEventListener('resize', turned);
      removeEventListener('message', scrolled);
      tellBook(me);
    },
  };
}

// The book lies over the frames where the board picked Over, on a screen that offers the choice (book.js)
const tellBook = me =>
  document.dispatchEvent(
    new CustomEvent('viewer:over', { detail: !me.closed && bookChoice(shape()) && me.picked.book === 'over' }),
  );

// The bar's choices: the device's size (where the screen offers more than its own), Over or Beside (on its side), and
// the QR (a laptop's or a desktop's)
function paintChoices(me) {
  const offered = devicesFor(innerWidth),
    seg = (name, options, on) =>
      `<div class="seg" role="group" aria-label="${name}">${options
        .map(
          ([id, words]) => `<button type="button" data-${name}="${id}" aria-pressed="${id === on}">${words}</button>`,
        )
        .join('')}</div>`,
    devices = offered.map(id => [id, DEVICES[id].name]),
    books = [
      ['over', 'Over'],
      ['beside', 'Beside'],
    ];
  me.choices.innerHTML =
    (offered.length > 1 ? seg('device', devices, me.picked.device) : '') +
    (bookChoice(shape()) ? seg('book', books, me.picked.book) : '') +
    (shape() === 'wide'
      ? `<button type="button" class="glyph qr" aria-label="Open on your phone or tablet" aria-expanded="${!me.qrCard.hidden}">${QR}</button>`
      : '');
}
// A choice tapped, kept for this screen's shape. Beside opens the book, pinned beside the frames; Over puts it away for
// the frames side by side, its pull tab sliding it over them.
function choose(me, button) {
  if (!button) return;
  sfx.blip();
  if (button.classList.contains('qr')) return toggleQr(me);
  if (button.dataset.device) me.picked = { ...me.picked, device: button.dataset.device };
  if (button.dataset.book) {
    me.picked = { ...me.picked, book: button.dataset.book };
    if (me.picked.book === 'beside') openBook();
    else foldBook();
    tellBook(me);
  }
  store.set(`viewer.${shape()}`, me.picked);
  paintChoices(me);
  lay(me);
}
// A turn to a new screen shape: that shape's own choices
function turn(me) {
  if (shape() === me.shape) return;
  me.shape = shape();
  me.picked = recalled();
  paintChoices(me);
  tellBook(me);
  lay(me);
}

// The live frame, once HQ knows the page's live address: after staging's, drawn first, on the left (style.css)
async function addLive(me) {
  const live = await liveOf(me.url);
  if (me.closed || !live) return;
  me.live = live;
  const pane = Object.assign(document.createElement('div'), { className: 'pane live' });
  pane.dataset.side = 'live';
  pane.innerHTML = `<div class="sized"><iframe title="Live" allow="fullscreen" referrerpolicy="no-referrer"
    sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe></div>`;
  me.stage.querySelector('.frames').append(pane);
  pane.querySelector('iframe').src = live;
  lay(me);
}
// The same page live: a product's public address with the preview's path, where the product is live; else null
export async function liveOf(url) {
  const at = new URL(url),
    all = await loadArtifacts(world.dev),
    product = all.find(a => a.public.length && new URL(a.open).host === at.host);
  if (!product) return null;
  const base = product.public[0].endsWith('/') ? product.public[0] : `${product.public[0]}/`;
  return new URL(at.pathname.slice(1) + at.search + at.hash, base).href;
}

// Laid out for the stage's size now: the frames' widths and scale, side by side or as tabs
function lay(me) {
  if (me.closed) return;
  const f = fit(me.stage.clientWidth, me.stage.clientHeight, me.picked.device, !!me.live);
  me.stage.dataset.mode = f.columns ? 'columns' : 'tabs';
  me.stage.classList.toggle('headed', f.head);
  for (const [name, px] of Object.entries({
    gap: f.head ? GAP : 0,
    pad: f.pad,
    head: f.head ? HEAD : 0,
    column: f.column,
  }))
    me.stage.style.setProperty(`--${name}`, `${px}px`);
  for (const pane of me.stage.querySelectorAll('.pane')) {
    const frame = pane.querySelector('iframe'),
      sized = pane.querySelector('.sized');
    pane.classList.toggle('behind', !f.columns && pane.dataset.side !== me.tab);
    pane.style.setProperty('--scale', String(f.scale));
    frame.style.width = `${f.width}px`;
    frame.style.height = `${f.height}px`;
    sized.dataset.device = me.picked.device;
    sized.style.width = `${Math.round(f.width * f.scale)}px`;
  }
  paintHead(me, f);
}
// The head row: each side's name over its column, or the tabs that take turns, and the link between them
function paintHead(me, f) {
  const head = me.stage.querySelector('.head'),
    two = !!me.live,
    names = two ? ['live', 'after'] : ['after'],
    link = two
      ? `<button type="button" class="link" aria-pressed="${me.linked}" aria-label="Scroll both together">${LINK}<span>${me.linked ? 'Linked scroll' : 'Not linked'}</span></button>`
      : '';
  head.dataset.mode = f.columns ? 'columns' : 'tabs';
  head.innerHTML =
    f.columns || !two
      ? `${names.map(n => `<b data-side="${n}">${SIDES[n]}</b>`).join('')}${link}`
      : `<div class="tabs" role="tablist">${names
          .map(
            n =>
              `<button type="button" role="tab" data-tab="${n}" aria-selected="${me.tab === n}">${SIDES[n]}</button>`,
          )
          .join('')}</div>${link}`;
}
function tapHead(me, button) {
  if (!button) return;
  sfx.blip();
  if (button.dataset.tab) me.tab = button.dataset.tab;
  if (button.classList.contains('link')) me.linked = !me.linked;
  lay(me);
}

// Linked scroll: a frame's scroll passed to the other, by the scroll link in each page (shared/watchalong/scrolllink.js)
function linkScroll(me, e) {
  const frames = [...me.stage.querySelectorAll('.pane iframe')],
    from = frames.find(f => f.contentWindow === e.source),
    y = e.data?.y;
  if (!from || e.data?.hq !== 'scroll' || !Number.isFinite(y)) return;
  const now = performance.now();
  if (me.leader && me.leader !== from && now - me.ledAt < LEAD_MS) return;
  me.leader = from;
  me.ledAt = now;
  if (!me.linked) return;
  for (const f of frames) if (f !== from) f.contentWindow?.postMessage({ hq: 'hq', scrollTo: y }, '*');
}

// The QR: a one-time sign-in for a phone or tablet that opens this same view there, the notebook live on both. A new
// code takes the old one's place as it expires, while the card is open.
function toggleQr(me) {
  me.qrCard.hidden = !me.qrCard.hidden;
  paintChoices(me);
  if (me.qrCard.hidden) me.qrCard.innerHTML = '';
  else showQr(me);
}
async function showQr(me) {
  const card = me.qrCard;
  card.innerHTML ||= '<p>Making a code…</p>';
  try {
    const pair = await pairLink(me.url);
    if (card.hidden || me.closed) return;
    card.innerHTML = `${qrSvg(pair.link, 'Scan to open this on your phone or tablet')}
      <div><b>Open on your phone or tablet</b><p>Scan with the camera. The notebook stays live on both.</p></div>`;
    setTimeout(() => !card.hidden && !me.closed && showQr(me), Math.max(1000, pair.expires - Date.now()));
  } catch (error) {
    card.textContent = error.message;
  }
}

// HQ's viewer's stage: staging (the preview the viewer opened) beside the same page live or an earlier version of it, at
// a device's size, their scroll linked; tabs where both don't fit; the notebook over the frames or beside them; and a QR code that opens the
// same view on a phone or tablet. desk.js keeps the bar and the staging frame's review mode.
import { store } from '../util.js';
import { dayTime } from '../world/clock.js';
import * as world from '../world/world.js';
import { loadArtifacts, loadEarlierVersions } from './data.js';
import { sfx } from './audio.js';
import { DEVICES, GAP, HEAD, devicesFor, fit, chosen, bookChoice } from './viewerfit.js';
import { shapeOf } from './ink/booklayout.js';
import { openBook, foldBook, layOver } from './ink/book.js';
import { pairLink, qrSvg } from './ink/pair.js';

// A frame that scrolled leads for this long after its last scroll: the other's scrolls meanwhile are its own following
// (or stopping short at its end), never passed back
const LEAD_MS = 300;
const LINK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3.6-3.6a4 4 0 0 0-5.7-5.7L12 6.3M14 10a4 4 0 0 0-5.7 0l-3.6 3.6a4 4 0 0 0 5.7 5.7l1.6-1.6"/></svg>`;
const QR = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2v2h-2zM18 14h2v2h-2z"/></svg>`;
const shape = () => shapeOf(innerWidth, innerHeight);
const recalled = () => chosen(store.get(`viewer.${shape()}`, null), devicesFor(innerWidth), shape());

// The stage in the viewer v, for the preview at url. Returns { close, toStaging }: close for the viewer's Close or its
// next page, toStaging to bring staging to the front where the two take turns (the bar's Note pins there).
export function mountStage(v, url) {
  const me = {
    url,
    stage: v.querySelector('.stage'),
    choices: Object.assign(document.createElement('div'), { className: 'choices' }),
    qrCard: Object.assign(document.createElement('div'), { className: 'qrcard', hidden: true }),
    picked: recalled(),
    shape: shape(),
    befores: [],
    unlisted: 0,
    before: null,
    stagingY: 0,
    painted: '',
    tab: 'after',
    linked: true,
    leader: null,
    ledAt: 0,
    closed: false,
  };
  v.querySelector('.bar .pin').before(me.choices);
  // (its QR signs a device in as the board: never in a call's recording, shared/watchalong.)
  me.qrCard.setAttribute('data-watchalong-hide', '');
  v.append(me.qrCard);
  me.choices.addEventListener('click', e => choose(me, e.target.closest('button')));
  listenToHead(me);
  addBefore(me);
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
    toStaging() {
      me.tab = 'after';
      lay(me);
    },
    close() {
      me.closed = true;
      sized.disconnect();
      removeEventListener('resize', turned);
      removeEventListener('message', scrolled);
      tellBook(me);
    },
  };
}

// The book lies over the frames where the board picked Over, on a screen that offers the choice (book.js's layOver.
const tellBook = me => layOver(!me.closed && bookChoice(shape()) && me.picked.book === 'over');

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
    // Over is told once the book's on its way shut, so HQ's page dissolves into its whole width with the swing rather
    // than fading into it first.
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

// What can go beside staging, once HQ knows: the page live (on the left, style.css), where the product's live, and the
// page's earlier versions (the coordinator's earlier.ts), each { id, label, open, earlier }, and how many older changes
// it has past those. Live goes beside it to begin with, or nothing where it isn't live.
async function addBefore(me) {
  const [live, earlier] = await Promise.all([liveOf(me.url), loadEarlierVersions(world.dev, me.url)]);
  if (me.closed) return;
  const versions = earlier.versions.map(e => ({
    id: `earlier-${e.back}`,
    label: `Earlier, ${dayTime(e.at)}`,
    day: dayTime(e.at),
    open: e.open,
    earlier: true,
  }));
  me.befores = [...(live ? [{ id: 'live', label: 'Live', open: live, earlier: false }] : []), ...versions];
  me.unlisted = earlier.unlisted;
  me.before = live ? 'live' : null;
  paintChoices(me);
  showBefore(me);
}
const beside = me => me.befores.find(b => b.id === me.before) ?? null;
// One picked on the head's choice ('' for staging alone): its tab to the front where the two take turns
function pickBefore(me, id) {
  sfx.blip();
  me.before = id || null;
  me.tab = me.before ? 'before' : 'after';
  showBefore(me);
}
// The choice tapped where it's the left tab: what it shows comes to the front, the head left as it is so the choice
// stays open
function toFront(me) {
  if (!beside(me) || me.tab === 'before') return;
  me.tab = 'before';
  lay(me);
}
// The frame beside staging, for what's picked (its pane's made the first time, and goes with staging alone)
function showBefore(me) {
  const b = beside(me);
  let pane = me.stage.querySelector('.pane.before');
  if (!b) pane?.remove();
  else if (!pane) {
    pane = Object.assign(document.createElement('div'), { className: 'pane before' });
    pane.dataset.side = 'before';
    pane.innerHTML = `<div class="sized"><iframe allow="fullscreen" referrerpolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe></div>`;
    me.stage.querySelector('.frames').append(pane);
  }
  const frame = pane?.querySelector('iframe');
  if (b && frame.src !== b.open) {
    frame.title = b.label;
    frame.src = b.open;
    // (a page newly beside staging opens at its top: it goes where staging is, as the scroll link would take it)
    frame.addEventListener(
      'load',
      () => me.linked && frame.contentWindow?.postMessage({ hq: 'hq', scrollTo: me.stagingY }, '*'),
      { once: true },
    );
  }
  lay(me);
}
// The same page live: a product's public address with the preview's path, where the product is live; else null. The
// path goes in as a path, so nothing in it can name another scheme or host.
export async function liveOf(url) {
  const at = new URL(url),
    all = await loadArtifacts(world.dev),
    product = all.find(a => a.public.length && new URL(a.open).host === at.host);
  if (!product) return null;
  const live = new URL(product.public[0]);
  live.pathname = live.pathname.replace(/\/?$/, '/') + at.pathname.slice(1);
  live.search = at.search;
  live.hash = at.hash;
  return live.href;
}

// Laid out for the stage's size now: the frames' widths and scale, side by side or as tabs
function lay(me) {
  if (me.closed) return;
  const f = fit(me.stage.clientWidth, me.stage.clientHeight, me.picked.device, !!beside(me), pickable(me));
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
// Whether there's an earlier version to pick, in the head row: then it's there with staging alone too
const pickable = me => me.befores.some(b => b.earlier);
// The head row: each side's name over its column, or the tabs that take turns, and the link between them. Where there's
// an earlier version, the left side's name is the choice of what's beside staging, and with tabs it's the left tab.
// It's painted only when it changes, so a choice open stays open, and which tab is in front is marked after.
function paintHead(me, f) {
  const head = me.stage.querySelector('.head'),
    b = beside(me),
    pick = pickable(me) ? choiceOf(me, f.columns ? '' : 'before') : '',
    tab = (side, label) => `<button type="button" role="tab" data-tab="${side}">${label}</button>`,
    link = b
      ? `<button type="button" class="link" aria-pressed="${me.linked}" aria-label="Scroll both together">${LINK}<span>${me.linked ? 'Linked scroll' : 'Not linked'}</span></button>`
      : '';
  const html = !b
    ? pick || '<b data-side="after">Staging</b>'
    : f.columns
      ? `${pick ? `<span class="side">${pick}</span>` : `<b data-side="before">${b.label}</b>`}<b data-side="after">Staging</b>${link}`
      : `<div class="tabs" role="tablist">${pick || tab('before', b.label)}${tab('after', 'Staging')}</div>${link}`;
  head.dataset.mode = f.columns ? 'columns' : 'tabs';
  if (me.painted !== html) head.innerHTML = me.painted = html;
  for (const t of head.querySelectorAll('[data-tab]'))
    t.setAttribute('aria-selected', String(me.tab === t.dataset.tab));
}
// The choice of what's beside staging: its picked one's label shown, over the device's own list of them (side: the tab
// it is, with tabs). An earlier version's 'Earlier' gives way on a short row (style.css), its date never.
function choiceOf(me, side) {
  const b = beside(me),
    picked = b?.earlier ? `<span class="earlier">Earlier, </span>${b.day}` : (b?.label ?? 'Staging alone');
  return `<label class="pick"${side ? ` data-tab="${side}"` : ''}><span>${picked}</span><select class="beside" aria-label="Beside staging">${optionsOf(me)}</select></label>`;
}
// Its options: 'Staging alone' where the page isn't live, then what can go beside it, and how many older changes it
// doesn't list
function optionsOf(me) {
  const live = me.befores.some(b => b.id === 'live'),
    options = [...(live ? [] : [{ id: '', label: 'Staging alone' }]), ...me.befores],
    older = me.unlisted === 1 ? '1 older change' : `${me.unlisted} older changes`;
  return (
    options
      .map(o => `<option value="${o.id}"${o.id === (me.before ?? '') ? ' selected' : ''}>${o.label}</option>`)
      .join('') + (me.unlisted ? `<option disabled>${older}, not listed</option>` : '')
  );
}
// The head row's taps: a tab, the link, and the choice of what's beside staging, picked or tapped as the left tab
function listenToHead(me) {
  const head = me.stage.querySelector('.head');
  head.addEventListener('click', e => tapHead(me, e.target.closest('button')));
  head.addEventListener('change', e => pickBefore(me, e.target.value));
  head.addEventListener('focusin', e => e.target.matches('.beside') && toFront(me));
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
  if (from.closest('.pane.after')) me.stagingY = y;
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
    const pairing = await pairLink(me.url);
    if (card.hidden || me.closed) return;
    card.innerHTML = `${qrSvg(pairing.link, 'Scan to open this on your phone or tablet')}
      <div><b>Open on your phone or tablet</b><p>Scan with the camera. The notebook stays live on both.</p></div>`;
    setTimeout(() => !card.hidden && !me.closed && showQr(me), Math.max(1000, pairing.expires - Date.now()));
  } catch (error) {
    card.textContent = error.message;
  }
}

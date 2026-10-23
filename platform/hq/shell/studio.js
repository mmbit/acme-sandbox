// HQ-OS › Photos: the photo studio. The keeper (an agent) brings the photos the shop needs into the studio and edits
// each with the image model; the board checks them here. Which photos get made is the crew's, never the board's.
// Three tabs: Approvals (one photo at a time, big, with the page it goes on, what it should show and what to check;
// Accept or Reject with an optional comment), Queue (the darkroom: what the keeper is developing, to read only) and
// History (the approved ones, found by product or page, each one able to change). Only approved photos reach the
// agents. The one photo big is studiobig.js. An HQ app on the interface a company's own apps use
// (template/kits/README.md): desk.js loads it when the company runs the studio (GET /api/brand's studio).
import { esc, stylesheet } from '../util.js';
import { icon } from './icons.js';
import { loadStudio } from './data.js';
import { part, rows } from './parts.js';
import { sfx } from './audio.js';
import { names } from './brand.js';
import * as world from '../world/world.js';
import { companyFormats } from '../world/clock.js';
import { paintApproval, paintHistoryPhoto, pageOf } from './studiobig.js';
import {
  screen,
  LIGHT,
  plural,
  waitingOf,
  photoOf,
  nameIn,
  whatHtml,
  keeperHtml,
  dayOf,
  pictureHtml,
} from './studiophotos.js';

const TABS = [
  ['approvals', 'Approvals'],
  ['queue', 'Queue'],
  ['history', 'History'],
];

let shownEl = null;
let seq = 0;

// ---- what HQ calls
export const app = { name: 'Photos', what: 'Product photos to approve', icon: 'app-studio', group: 'business' };

// Each time the computer (re)draws it: on opening and every 15 s (not while a field has text). A new screen element is a
// fresh opening, always on Approvals.
export async function draw(el, hq) {
  screen.who = hq.who;
  if (el !== shownEl) {
    shownEl = el;
    Object.assign(screen, { tab: null, current: null, open: null, side: 'edited', query: '', changing: false });
    screen.lines.clear();
    el.innerHTML = '';
  }
  await stylesheet('shell/studio.css');
  await paint(el);
}

// The header's back button: from a photo of History's back to its list (true), else the computer's (false)
export function back() {
  if (screen.tab !== 'history' || !screen.open || !shownEl?.isConnected) return false;
  sfx.blip();
  Object.assign(screen, { open: null, changing: false });
  render(shownEl);
  return true;
}

export const count = async dev => waitingOf(await loadStudio(dev)).length;

// The desk phone's line while photos wait for the board ("Photos: 4 photos to approve"), opening the app. It follows
// GET /api/studio, read with every requests poll (fresh).
let lineCount = 0;
export async function phone(el, hq, { fresh, past }) {
  screen.who = hq.who;
  if (fresh) {
    const n = await count(world.dev).catch(() => null);
    if (n === null || n === lineCount) return;
    lineCount = n;
    el = document.querySelector('#phone-screen');
    if (!el) return;
  }
  await stylesheet('shell/studio.css');
  const line = el.querySelector(':scope > .studio-line');
  if (past || !lineCount) return line?.remove();
  const html = `<button class="app-line studio-line">${icon('app-studio')}<span><b>${esc(app.name)}:</b> ${plural(lineCount, 'photo', 'photos')} to approve</span><i aria-hidden="true">›</i></button>`;
  if (line) line.outerHTML = html;
  else el.insertAdjacentHTML('afterbegin', html);
  el.querySelector(':scope > .studio-line').onclick = () => {
    sfx.blip();
    hq.open('studio');
  };
}

// The keeper put photos in the batch, or an edit came back: the open screen follows at once
let lastStudio = '';
world.on('studio', () => {
  const now = JSON.stringify(world.studio);
  if (now === lastStudio) return;
  lastStudio = now;
  if (shownEl?.isConnected && screen.studio) repaint(shownEl);
});

// ---- the screen
async function paint(el) {
  const me = ++seq;
  let latest;
  try {
    latest = await loadStudio(world.dev);
  } catch (e) {
    if (me !== seq) return;
    if (el.querySelector(':scope > .sd')) return signal(el, true); // (keep what's shown)
    throw e;
  }
  if (me !== seq || !el.isConnected) return;
  screen.studio = latest;
  screen.tab ??= 'approvals';
  if (screen.open && photoOf(screen.open)?.status !== 'approved')
    Object.assign(screen, { open: null, changing: false });
  frame(el);
  signal(el, false);
  render(el);
}
const repaint = el => paint(el).catch(() => signal(el, true));
Object.assign(screen, { repaint, render });

// The screen's parts (parts.js), each drawn again only when its own words change
function frame(el) {
  if (el.querySelector(':scope > .sd')) return;
  el.closest('.device')?.classList.add('sd-wide');
  el.innerHTML = `<div class="sd">
    <div data-part="tabs"></div><p class="sd-signal" data-signal hidden>No signal · retrying</p>
    <section class="sd-sec" data-sec="queue"><div data-part="queue"></div><ul class="sd-rows" data-rows="queue"></ul><div data-part="foot"></div></section>
    <section class="sd-sec" data-sec="approvals"><div class="sd-big" data-part="approvals"></div></section>
    <section class="sd-sec" data-sec="history"><div data-part="search"></div><ul class="sd-grid" data-rows="history"></ul><div data-part="history-none"></div><div class="sd-big" data-part="history"></div></section></div>`;
}
function signal(el, lost) {
  el.querySelector('[data-signal]')?.toggleAttribute('hidden', !lost);
}
function render(el) {
  const waiting = waitingOf(screen.studio).length;
  part(el, 'tabs', tabsHtml(waiting), box => wireTabs(el, box));
  for (const [tab] of TABS) el.querySelector(`[data-sec="${tab}"]`).hidden = tab !== screen.tab;
  if (screen.tab === 'queue') paintQueue(el);
  if (screen.tab === 'approvals') paintApproval(el);
  if (screen.tab === 'history') paintHistory(el);
  crumb(el);
}
function crumb(el) {
  const s = el.closest('.device')?.querySelector('header b span');
  const open = screen.tab === 'history' && screen.open && photoOf(screen.open);
  if (s) s.textContent = ` › ${app.name}${open ? ` › ${nameIn(screen.studio.products, open.product)}` : ''}`;
}

// ---- the tabs: Approvals with what waits on it, as the app's icon
const tabsHtml = waiting =>
  `<nav class="jb-tabs sd-tabs" role="tablist" aria-label="${esc(app.name)}">${TABS.map(([tab, words]) => `<button role="tab" aria-selected="${tab === screen.tab}" data-tab="${tab}">${words}${tab === 'approvals' && waiting ? `<i aria-label="${waiting} waiting">${waiting}</i>` : ''}</button>`).join('')}</nav>`;
function wireTabs(el, box) {
  box.querySelectorAll('[data-tab]').forEach(
    b =>
      (b.onclick = () => {
        if (screen.tab === b.dataset.tab) return;
        sfx.blip();
        Object.assign(screen, { tab: b.dataset.tab, open: null, changing: false, side: 'edited' });
        render(el);
        el.scrollTop = 0;
      }),
  );
}

// ---- Queue: the darkroom, the shots the keeper is developing, each with the page it's for. The board only reads it.
function paintQueue(el) {
  const photos = screen.studio.photos.filter(p => ['new', 'editing', 'edited'].includes(p.status));
  part(el, 'queue', queueHtml(photos));
  const items = photos.map(p => ({ key: `p${p.id}`, html: queueRow(p) }));
  rows(el, 'queue', items);
  part(el, 'foot', footHtml(screen.studio.month));
}
function queueHtml(photos) {
  const key = screen.studio.key
    ? ''
    : `<p class="sd-key">The image model’s key isn’t in yet: its card is on the ${esc(names.phone)}. Photos wait here until it is.</p>`;
  return photos.length
    ? `${key}<p class="sd-sub">${LIGHT}${keeperHtml()} has ${plural(photos.length, 'photo', 'photos')} in the darkroom.</p>`
    : `${key}<p class="sd-empty">The darkroom is empty. ${keeperHtml()} brings in the photos the shop needs.</p>`;
}
const queueRow = p => `<li class="sd-row">
    <span class="sd-thumb">${pictureHtml(p, 'original')}</span>
    <div class="sd-about"><p class="sd-what">${whatHtml(p)}</p>${forHtml(p.request)}<p class="sd-state">${LIGHT}${keeperHtml()} is developing it</p></div></li>`;
// the page a shot is for: its request's first page, else the request's words for where
function forHtml(request) {
  const page = request?.pages[0] ? pageOf(request.pages[0]) : request?.where;
  return page ? `<p class="sd-for">For ${esc(page)}</p>` : '';
}
const footHtml = month => {
  // (the image model's dollars, as $)
  const usd = companyFormats('USD').money(month?.usd ?? 0, 'en', {
    unit: 'major',
    currencyDisplay: 'narrowSymbol',
  });
  return `<p class="sd-foot">THIS MONTH · ${plural(month?.edits ?? 0, 'EDIT', 'EDITS')} · ${usd}</p>`;
};

// ---- History: the approved photos, newest first, found by product or by a page they're on; one opens big
const approvedOf = studio =>
  studio.photos
    .filter(p => p.status === 'approved')
    .sort((a, b) => String(b.decided?.at ?? '').localeCompare(String(a.decided?.at ?? '')));
function matches(p, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const page = pageOf(q);
  return (
    nameIn(screen.studio.products, p.product).toLowerCase().includes(q) ||
    p.product.toLowerCase().includes(q) ||
    (p.places ?? []).some(u => pageOf(u).toLowerCase().includes(page))
  );
}
function paintHistory(el) {
  const p = screen.open && photoOf(screen.open);
  el.querySelector('[data-part="search"]').hidden = !!p;
  el.querySelector('[data-rows="history"]').hidden = !!p;
  el.querySelector('[data-part="history-none"]').hidden = !!p;
  paintHistoryPhoto(el, p);
  if (p) return;
  const approved = approvedOf(screen.studio),
    shown = approved.filter(x => matches(x, screen.query));
  part(
    el,
    'search',
    approved.length
      ? `<label class="sd-search"><span class="sd-sub">Find a photo</span><input type="search" data-search autocomplete="off" placeholder="Product or page address"></label>`
      : '',
    box => wireSearch(el, box),
  );
  rows(
    el,
    'history',
    shown.map(x => ({ key: `p${x.id}`, html: tileHtml(x) })),
    row => (row.querySelector('button').onclick = () => openPhoto(el, Number(row.dataset.key.slice(1)))),
  );
  part(
    el,
    'history-none',
    !approved.length
      ? '<p class="sd-empty">No approved photos yet.</p>'
      : !shown.length
        ? '<p class="sd-empty">None of the approved photos matches that.</p>'
        : '',
  );
}
const tileHtml = p =>
  `<li><button class="sd-tile" aria-label="${esc(nameIn(screen.studio.products, p.product))}, approved ${dayOf(p.decided?.at)}">${pictureHtml(p, 'edited')}<span>${esc(nameIn(screen.studio.products, p.product))}</span></button></li>`;
function wireSearch(el, box) {
  const input = box.querySelector('[data-search]');
  if (!input) return;
  input.value = screen.query;
  input.oninput = () => {
    screen.query = input.value;
    paintHistory(el);
  };
}
function openPhoto(el, id) {
  sfx.blip();
  Object.assign(screen, { open: id, changing: false, side: 'edited' });
  render(el);
  el.scrollTop = 0;
}

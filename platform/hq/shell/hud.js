// The HUD over the building: its buttons, the status line, the clock, toasts and count badges.
import { cap } from '../util.js';
import * as world from '../world/world.js';
import * as clock from '../world/clock.js';
import * as audio from './audio.js';
import { cv, scene, pointed, later } from './stage.js';
import { dropCard } from './overlay.js';
import { startTour, stopTour, touring } from './tour.js';
import { openAgent } from './panel.js';
import { openGazette } from './news.js';
import { openPhone, openIntercom, openComputer, ceoName } from './desk.js';
import { loadPiles } from './data.js';
import { openProjects } from './projects.js';
import { names } from './brand.js';

const $ = s => document.querySelector(s);

export function bindHud() {
  nameHud();
  const sound = $('#btn-sound'), music = $('#btn-music'), tourBtn = $('#btn-tour');
  addEventListener('pointerdown', () => { audio.unlock(); setTimeout(syncHud); }, { capture: true });
  sound.onclick = () => { if (!audio.justUnlocked() || !audio.prefs.sound) audio.setSound(!audio.prefs.sound); syncHud(); audio.sfx.blip(); };
  music.onclick = () => { if (!audio.prefs.sound) audio.setSound(true); audio.setMusic(!audio.prefs.music); syncHud(); };
  tourBtn.onclick = () => { touring() ? stopTour() : startTour(); syncHud(); };
  $('#btn-desk').onclick = e => { e.preventDefault(); openPhone(); };
  $('#btn-intercom').onclick = () => openIntercom();
  $('#btn-computer').onclick = () => openComputer();
  $('#btn-news').onclick = () => openGazette();
  // (the projects view, from what was tapped)
  const jobsAt = e => { const from = e.target.closest('[data-jobs]'); if (from) openProjects({ from }); };
  $('#status').onclick = jobsAt;
  $('#status').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jobsAt(e); } };
  setInterval(updateStatus, 15000);   // (jobs start and finish between the agents' status events)
  // (the hint above it, by its height)
  new ResizeObserver(() => document.documentElement.style.setProperty('--status-h', `${$('#status').offsetHeight}px`)).observe($('#status'));
  $('#zin').onclick = () => { scene.camera.zoom(1); audio.sfx.blip(); dropCard(); };
  $('#zout').onclick = () => { scene.camera.zoom(-1); audio.sfx.blip(); dropCard(); };
  $('#zfit').onclick = () => { scene.focus({ kind: 'home' }); audio.sfx.blip(); dropCard(); };
  syncHud();
  // the company's time, or a preview's hour
  const hhmm = h => [h | 0, Math.floor((h % 1) * 60)].map(n => String(n).padStart(2, '0')).join(':');
  const label = () => { const h = clock.hour(); $('#clock').textContent = (clock.real() ? clock.timeOf(Date.now()) : hhmm(h)) + (clock.darkness(h) > 0.5 ? ' · night' : ' · day'); };
  label(); setInterval(() => { label(); world.checkDay(); }, 15000);
}
// The scene's own buttons (scene.controls), each on the HUD's button of its id, bound to the scene on stage at every
// mount: a look without one hides it, and each look names it its own way (the brownstone's "Outside walls").
const CONTROLS = ['walls'];
export function bindControls() {
  for (const id of CONTROLS) {
    const b = $(`#btn-${id}`), c = scene.controls?.find(c => c.id === id);
    b.hidden = !c;
    if (!c) continue;
    b.title = c.title; b.setAttribute('aria-label', c.title); b.querySelector('.sr').textContent = c.title;
    b.onclick = () => { c.toggle(); syncHud(); audio.sfx.blip(); };
  }
  syncHud();
}
// the buttons that stay pressed: the scene's, sound, music and the tour
export function syncHud() {
  for (const c of scene.controls ?? []) $(`#btn-${c.id}`).setAttribute('aria-pressed', c.pressed());
  $('#btn-sound').setAttribute('aria-pressed', audio.ready()); $('#btn-music').setAttribute('aria-pressed', audio.prefs.music && audio.ready());
  $('#btn-tour').setAttribute('aria-pressed', touring());
}
// from the computer's directory: fly to someone and open their panel
export function flyTo(id) {
  const A = world.agents.get(id); if (!A) return;
  stopTour(); pointed.selected = id; openAgent(A);
  scene.focus({ kind: 'agent', id }, { close: true });
}
// fly to a mascot and pet it
export function visitMascot(id) {
  if (scene.focus({ kind: 'mascot', id }, { close: true })) { stopTour(); later(() => world.pet(id), 700); } // (once the camera's there)
}
// index.html's own words stand until boot, which names the building and the board's tools from the brand
function nameHud() {
  cv.setAttribute('aria-label', `Pixel-art view of the ${names.hq} building. The ${names.computer}'s People tab lists everyone in text.`);
  $('#hud .brand b').textContent = names.hq;
  $('#btn-desk').title = `${cap(names.phone)}: requests waiting for you`; $('#btn-desk .lbl').textContent = names.phoneShort;
  $('#btn-news').title = cap(names.newsletter); $('#btn-news .sr').textContent = names.newsletterShort;
  $('#btn-intercom').title = `${cap(names.intercom)}: a directive for ${ceoName()}`; $('#btn-intercom .sr').textContent = cap(names.intercom);
  $('#btn-computer').title = `${cap(names.computer)}: AI seats and jobs`; $('#btn-computer .sr').textContent = cap(names.computer);
}
// HQ's throughput, bottom left (the coordinator's work.ts piles), counted in tasks: those done in the last 24 hours, hour
// by hour as bars of work and, lighter, reviews, then those at work and those waiting, each over a bar split the same
// way, and a swatch of each shade by its count says which is which. A tap on one opens the projects view. Read at most
// every few seconds (agents' status events come in bursts), and redrawn only when it changed (aria-live).
let counting = false, counted = 0;
export async function updateStatus() {
  if (counting || Date.now() - counted < 5000) return;
  counting = true;
  const piles = await loadPiles(world.dev).catch(() => null);
  counting = false;
  counted = Date.now();
  if (!piles) return;
  const html = throughput(piles.done) + pile('active', 'at work', piles.active) + pile('waiting', 'waiting', piles.waiting);
  if ($('#status').innerHTML !== html) $('#status').innerHTML = html;
}
const many = (n, one) => `${n.toLocaleString('en')} ${one}${n === 1 ? '' : 's'}`;
function throughput({ work, review, hours }) {
  const W = 3, GAP = 1, H = 22, top = Math.max(1, ...hours.map(([w, r]) => w + r));
  const bar = ([w, r], i) => {
    const x = i * (W + GAP), hw = (w / top) * H, hr = (r / top) * H;
    return `<rect x="${x}" y="${H - hw}" width="${W}" height="${hw}"/><rect class="review" x="${x}" y="${H - hw - hr}" width="${W}" height="${hr}"/>`;
  };
  const words = `${many(work, 'task')} and ${many(review, 'review')} done in the last 24 hours, hour by hour`;
  return `<span role="button" tabindex="0" data-jobs="done" class="flow" title="${words}" aria-label="${words}">
    <svg class="flow-bars" viewBox="0 0 ${hours.length * (W + GAP) - GAP} ${H}" preserveAspectRatio="none" aria-hidden="true">${hours.map(bar).join('')}</svg>
    <span class="flow-words"><span><i class="flow-key"></i><b>${work.toLocaleString('en')}</b> ${work === 1 ? 'task' : 'tasks'} <i class="flow-key review"></i><b>${review.toLocaleString('en')}</b> ${review === 1 ? 'review' : 'reviews'}</span><small>done in 24 h</small></span></span>`;
}
function pile(key, label, { work, review }) {
  const n = work + review, words = `${n.toLocaleString('en')} ${label}: ${many(work, 'task')}, ${many(review, 'review')}`;
  return `<span role="button" tabindex="0" data-jobs="${key}" class="flow" title="${words}" aria-label="${words}">
    <span class="flow-words"><span><b>${n.toLocaleString('en')}</b></span><small>${label}</small></span><i class="flow-split" style="--review:${n ? (review / n).toFixed(2) : 0}"></i></span>`;
}

// What waits on the board in the computer's apps, their counts summed, on the computer's button (desk.js
// refreshWaitingNotes)
export function paintComputerCount(n) {
  const el = $('#computer-count'); if (!el) return;
  countBadge(el, n); el.setAttribute('aria-label', `${n} waiting on the computer`);
}

// A tap off a job's link in it is the toast's (prose.js covered).
export function toast(html, onClick, { sticky = false } = {}) {
  const t = document.createElement('div'), tap = document.createElement('button');
  t.className = 'toast covered' + (sticky ? ' sticky' : ''); t.innerHTML = html;
  tap.type = 'button'; tap.className = 'cover'; tap.setAttribute('aria-label', t.textContent);
  tap.onclick = () => { t.remove(); onClick?.(); };
  t.prepend(tap);
  // under the HUD as it stands: its rows of tools wrap to however many the company's apps need
  const hud = $('#hud')?.getBoundingClientRect();
  if (hud?.height) $('#toasts').style.top = `${Math.round(hud.bottom + 8)}px`;
  $('#toasts').append(t);
  if (sticky) return t; // stays until tapped
  setTimeout(() => t.classList.add('gone'), 5200);
  setTimeout(() => t.remove(), 5600);
  return t;
}

// Badge numbers use their own 5×7 pixel digits, drawn as SVG squares: at badge size the UI font's 2, 3,
// 5, 6 and 8 are near-identical blobs, while these stay distinct and keep the pixel look.
const DIGITS = {
  0: '01110 10001 10011 10101 11001 10001 01110', 1: '00100 01100 00100 00100 00100 00100 01110', 2: '01110 10001 00001 00110 01000 10000 11111',
  3: '11110 00001 00001 01110 00001 00001 11110', 4: '00010 00110 01010 10010 11111 00010 00010', 5: '11111 10000 11110 00001 00001 10001 01110',
  6: '00110 01000 10000 11110 10001 10001 01110', 7: '11111 00001 00010 00100 01000 01000 01000', 8: '01110 10001 10001 01110 10001 10001 01110',
  9: '01110 10001 10001 01111 00001 00010 01100', '+': '00000 00100 00100 11111 00100 00100 00000',
};
export function countBadge(el, n) {
  const s = n > 99 ? '99+' : String(n);
  let path = '';
  [...s].forEach((ch, i) => DIGITS[ch].split(' ').forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '1') path += `M${i * 6 + x} ${y}h1v1h-1z`;
  }));
  el.innerHTML = `<svg viewBox="0 0 ${s.length * 6 - 1} 7" style="width:${(s.length * 6 - 1) * 2}px;height:14px" aria-hidden="true"><path d="${path}"/></svg>`;
  el.dataset.n = s; // (a skin that draws no pixel digits shows this)
  el.setAttribute('aria-label', `${n} open ${n === 1 ? 'request' : 'requests'}`);
  el.hidden = !n;
}

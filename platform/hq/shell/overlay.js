// Over the canvas: speech bubbles and name cards, DOM placed per frame where the scene anchors them.
import { esc, clamp } from '../util.js';
import { scene, chrome } from './stage.js';

let bubbles = [], shown = null; // shown: the card up now

// agent id says something for s seconds: it replaces what they, or anyone standing right by them, were saying
export function bubble(id, text, to, s = 5.5) {
  if (scene.says) return; // (a look that shows messages its own way: Wire's fly from key to key)
  const target = { kind: 'agent', id };
  bubbles = bubbles.filter(b => (b.target.id !== id && !scene.near(b.target, target)) || dropBubble(b));
  bubbles.push({ target, text, to, life: s });
}
// a card over a target for s seconds (the scene's: the mascot's name, after a pat)
export function card(target, title, sub, s) { shown = { target, title, sub, life: s }; }
export const dropCard = () => { shown = null; }; // it closes as soon as the view moves

export function step(dt) {
  bubbles = bubbles.filter(b => (b.life -= dt) > 0 || dropBubble(b));
  if (shown && (shown.life -= dt) <= 0) shown = null;
}
export function draw() { drawBubbles(); drawCard(); }
// a filter callback: removes the bubble's element, and returns false so the bubble leaves the list
function dropBubble(b) { b.el?.remove(); return false; }

// a: the anchor (CSS px)
function place(el, a, w, h, taken) {
  const x = clamp(a.x - w / 2, 8, innerWidth - w - 8);
  let y = Math.max(chrome().top, a.y - h - 12);
  // stack above any bubble already placed here
  for (let moved = true, n = 0; moved && taken && n < 6; n++) { moved = false; for (const r of taken) if (x < r.x + r.w && x + w > r.x && y < r.y + r.h + 6 && y + h + 6 > r.y) { y = r.y - h - 8; moved = true; } }
  taken?.push({ x, y, w, h });
  el.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
  el.style.setProperty('--tx', `${Math.round(clamp(a.x - x, 10, w - 10))}px`);
}
function drawBubbles() {
  const root = document.getElementById('bubbles'), taken = [];
  for (const b of [...bubbles].reverse()) {
    if (!b.el) {
      b.el = document.createElement('div'); b.el.className = 'bubble';
      b.el.innerHTML = `${b.to ? `<small>${esc(b.to)}</small>` : ''}<span>${esc(b.text)}</span>`;
      root.append(b.el); b.w = b.el.offsetWidth; b.h = b.el.offsetHeight;
    }
    const a = scene.anchor(b.target);
    b.el.style.visibility = a ? '' : 'hidden';
    if (!a) continue;
    place(b.el, a, b.w, b.h, taken);
    b.el.style.opacity = Math.min(1, b.life * 2);
  }
}
// A card hangs over whoever it's about, in the world: it moves with them, and it isn't shown while they're off
// screen.
function drawCard() {
  const el = document.getElementById('namecard'), a = shown && scene.anchor(shown.target);
  if (!a || a.x < 0 || a.y < 0 || a.x > innerWidth || a.y > innerHeight) { if (!el.hidden) el.hidden = true; return; }
  if (el.hidden || el.dataset.id !== shown.target.id) { el.hidden = false; el.dataset.id = shown.target.id; el.innerHTML = `<b>${esc(shown.title)}</b><small>${esc(shown.sub)}</small>`; shown.w = el.offsetWidth; shown.h = el.offsetHeight; }
  place(el, a, shown.w, shown.h);
  el.style.opacity = Math.min(1, shown.life * 2);
}

// A card's pictures in one viewer over everything: a before-and-after pair shows both in one place at one size, so the
// change shows when it switches. ← and → (or a sideways swipe) switch before and after, ↑ and ↓ (or a swipe up or down)
// go to the previous or next pair or picture, and Escape, ✕ or a tap on the picture closes.
import { esc } from '../util.js';
import { sfx } from './audio.js';

// how far a finger moves, in CSS pixels, before a press is a swipe
const SWIPE = 40;

// items: { label, src } for a picture, { label, before, after } for a pair; it opens at items[at], on a pair's side
// ('before' or 'after'), in parent
export function viewPictures(items, at, side, parent) {
  const viewer = new Viewer(items, at, side);
  parent.append(viewer.box);
  sfx.blip();
}

const isPair = item => 'before' in item;
const sourcesOf = item => (isPair(item) ? [item.before, item.after] : [item.src]);
const altOf = (item, i) => (isPair(item) ? `${item.label} (${i ? 'after' : 'before'})` : item.label);

class Viewer {
  constructor(items, at, side) {
    Object.assign(this, { items, at, side, from: null, swiped: false });
    this.box = document.createElement('div');
    this.box.className = 'pic-zoom';
    this.box.setAttribute('role', 'dialog');
    this.box.setAttribute('aria-modal', 'true');
    this.box.innerHTML = `<div class="pic-head"><p aria-live="polite"></p><button type="button" class="pic-close" aria-label="Close">✕</button></div>
      <div class="pic-stage"></div>
      <div class="pic-keys"><button type="button" data-go="-1" aria-label="Previous">↑</button><span class="pic-sides"><button type="button" data-side="before">← Before</button><button type="button" data-side="after">After →</button></span><button type="button" data-go="1" aria-label="Next">↓</button></div>`;
    this.stage = this.box.querySelector('.pic-stage');
    this.keys = e => this.key(e);
    addEventListener('keydown', this.keys, true);
    this.stage.addEventListener('pointerdown', e => this.press(e));
    this.stage.addEventListener('pointerup', e => this.lift(e));
    this.stage.addEventListener('pointercancel', () => (this.from = null));
    this.box.onclick = e => this.tap(e);
    this.fitting = new ResizeObserver(() => this.fit());
    this.fitting.observe(this.stage);
    this.show();
  }

  // the picture or pair at this.at, on this.side
  show() {
    const item = this.items[this.at];
    this.stage.innerHTML = sourcesOf(item)
      .map((src, i) => `<img src="${esc(src)}" alt="${esc(altOf(item, i))}" draggable="false">`)
      .join('');
    this.stage.classList.toggle('pair', isPair(item));
    Promise.all([...this.stage.querySelectorAll('img')].map(img => img.decode())).then(() => this.fit());
    for (const b of this.box.querySelectorAll('[data-go]')) {
      const to = this.at + Number(b.dataset.go);
      b.disabled = to < 0 || to >= this.items.length;
      b.hidden = this.items.length < 2;
    }
    this.box.querySelector('.pic-sides').hidden = !isPair(item);
    this.flip(this.side);
    // (the next and previous ones load while this one is looked at)
    for (const near of [this.items[this.at + 1], this.items[this.at - 1]].filter(Boolean))
      for (const src of sourcesOf(near)) new Image().src = src;
  }

  // a pair's two pictures at one scale, the larger fitting the stage, both from its top centre, so the after lands where
  // the before was
  fit() {
    const pair = [...this.stage.querySelectorAll('img')];
    if (pair.length < 2 || !pair.every(img => img.naturalWidth)) return;
    const scale = Math.min(
      this.stage.clientWidth / Math.max(...pair.map(img => img.naturalWidth)),
      this.stage.clientHeight / Math.max(...pair.map(img => img.naturalHeight)),
    );
    for (const img of pair) {
      img.style.width = `${img.naturalWidth * scale}px`;
      img.style.height = `${img.naturalHeight * scale}px`;
    }
  }

  flip(side) {
    const item = this.items[this.at];
    this.side = side;
    if (!isPair(item)) return this.heading(item.label, '');
    const [before, after] = this.stage.querySelectorAll('img');
    before.hidden = side !== 'before';
    after.hidden = side !== 'after';
    for (const b of this.box.querySelectorAll('[data-side]'))
      b.setAttribute('aria-pressed', String(b.dataset.side === side));
    this.heading(item.label, side);
  }

  heading(label, side) {
    const count = this.items.length > 1 ? `<span class="pic-count">${this.at + 1} of ${this.items.length}</span>` : '';
    this.box.querySelector('.pic-head p').innerHTML =
      `<b>${esc(label)}</b>${side ? `<span class="pic-side ${side}">${side}</span>` : ''}${count}`;
    this.box.setAttribute('aria-label', side ? `${label} (${side})` : label);
  }

  // to the next (1) or previous (-1) pair or picture, at its before
  move(by) {
    if (!this.items[this.at + by]) return;
    this.at += by;
    this.side = 'before';
    this.show();
    sfx.blip();
  }

  switchTo(side) {
    if (!isPair(this.items[this.at]) || this.side === side) return;
    this.flip(side);
    sfx.blip();
  }

  close() {
    removeEventListener('keydown', this.keys, true);
    this.fitting.disconnect();
    this.box.remove();
  }

  // (taken before anything under the viewer sees it: a look's arrow keys pan its scene, Escape closes the phone)
  key(e) {
    if (!this.box.isConnected) return removeEventListener('keydown', this.keys, true); // (gone with what it was opened over)
    const KEYS = {
      ArrowLeft: () => this.switchTo('before'),
      ArrowRight: () => this.switchTo('after'),
      ArrowUp: () => this.move(-1),
      ArrowDown: () => this.move(1),
      Escape: () => this.close(),
    };
    if (!KEYS[e.key]) return;
    e.preventDefault();
    e.stopPropagation();
    KEYS[e.key]();
  }

  press(e) {
    this.from = { x: e.clientX, y: e.clientY };
    this.swiped = false;
    this.stage.setPointerCapture(e.pointerId);
  }

  lift(e) {
    if (!this.from) return;
    const dx = e.clientX - this.from.x,
      dy = e.clientY - this.from.y;
    this.from = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE) return;
    this.swiped = true;
    if (Math.abs(dx) > Math.abs(dy)) this.switchTo(dx < 0 ? 'after' : 'before');
    else this.move(dy < 0 ? 1 : -1);
  }

  // its keys; a tap on the picture closes it, unless it ends a swipe
  tap(e) {
    e.stopPropagation();
    const b = e.target.closest('button');
    if (b?.dataset.go) this.move(Number(b.dataset.go));
    else if (b?.dataset.side) this.switchTo(b.dataset.side);
    else if (b) this.close();
    else if (this.swiped) this.swiped = false;
    else if (!e.target.closest('.pic-keys, .pic-head')) this.close();
  }
}

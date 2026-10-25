// The player's scrubber (player.js): a track with the recording's taps, pages and ink ticked on it, how much has
// loaded, and a thumb to drag with a finger, a pen or a mouse (a tap on the track jumps there). It moves by transforms
// only, and reads its size on resize, never while dragged.
const TICKED = new Set(['tap', 'page', 'ink']);
const TICK_GAP_MS = 45; // the shortest gap between two tick sounds as a drag crosses the ticks
const DRAG_PX = 4; // a press that moves less is a tap

export class Scrubber {
  constructor(el, player, label) {
    Object.assign(this, { el, player, held: false, width: 0, done: 0 });
    const span = Math.max(1, player.end - player.start);
    el.setAttribute('role', 'slider');
    el.tabIndex = 0;
    el.setAttribute('aria-label', label);
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', String(Math.round(span / 1000)));
    // (the thumb and its time inside the track, at its left edge: a transform moves them along)
    el.innerHTML = `<div class="wp-track"><div class="wp-loaded"></div><div class="wp-done"></div><div class="wp-ticks"></div><div class="wp-thumb"></div><div class="wp-bubble" aria-hidden="true"></div></div>`;
    this.track = el.firstChild;
    [this.loadedBar, this.doneBar, this.tickBox, this.thumb, this.bubble] = this.track.children;
    Object.assign(el.style, {
      position: 'relative',
      touchAction: 'none',
      userSelect: 'none',
      webkitUserSelect: 'none',
    });
    this.track.style.position = 'absolute';
    for (const bar of [this.loadedBar, this.doneBar, this.tickBox])
      Object.assign(bar.style, { position: 'absolute', inset: 0, transformOrigin: '0 50%' });
    for (const bar of [this.loadedBar, this.doneBar]) bar.style.transform = 'scaleX(0)';
    for (const part of [this.thumb, this.bubble]) part.style.position = 'absolute';
    // the ticks, placed once: the same kind at the same place is one tick
    const ticked = player.moments.filter(m => TICKED.has(m.kind));
    this.ticks = ticked.map(m => (m.at - player.start) / span).sort((a, b) => a - b);
    const placed = new Set();
    for (const m of ticked) {
      const at = (m.at - player.start) / span,
        key = `${m.kind}${Math.round(at * 400)}`;
      if (placed.has(key)) continue;
      placed.add(key);
      const tick = document.createElement('i');
      tick.className = `wp-tick wp-tick-${m.kind}`;
      Object.assign(tick.style, { position: 'absolute', left: `${(at * 100).toFixed(3)}%` });
      this.tickBox.append(tick);
    }
    this.wire();
  }

  wire() {
    const el = this.el;
    let from = null; // where the press began: { x, at } (the time there, as a fraction)
    const fraction = e => Math.max(0, Math.min(1, (e.clientX - this.left) / Math.max(1, this.width)));
    el.addEventListener('pointerdown', e => {
      if (e.button > 0 || from) return;
      e.preventDefault();
      this.measure();
      from = { x: e.clientX, id: e.pointerId, moved: false };
      el.setPointerCapture(e.pointerId);
      el.focus({ preventScroll: true });
    });
    el.addEventListener('pointermove', e => {
      if (!from || e.pointerId !== from.id) return;
      if (!from.moved && Math.abs(e.clientX - from.x) < DRAG_PX) return;
      if (!from.moved) {
        from.moved = true;
        this.held = true;
        el.classList.add('held');
        this.player.grab();
      }
      const last = e.getCoalescedEvents?.().at(-1) ?? e;
      this.crossed(this.done, fraction(last));
      this.player.drag(this.player.start + fraction(last) * (this.player.end - this.player.start));
    });
    const end = e => {
      if (!from || e.pointerId !== from.id) return;
      const at = this.player.start + fraction(e) * (this.player.end - this.player.start);
      if (from.moved) {
        this.held = false;
        el.classList.remove('held');
        this.player.release(e.type === 'pointercancel' ? this.player.at : at);
      } else if (e.type === 'pointerup') this.player.jump(at);
      from = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // A tick sound for each tick a drag crosses, at most one every TICK_GAP_MS
  crossed(a, b) {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    if (!this.ticks.some(t => t > lo && t <= hi)) return;
    const now = performance.now();
    if (now - (this.lastTick ?? 0) < TICK_GAP_MS) return;
    this.lastTick = now;
    this.player.sound('tick');
  }

  // The track's size and place (on resize, and as a press begins: the page may have scrolled)
  measure() {
    const r = this.track.getBoundingClientRect();
    this.width = r.width;
    this.left = r.left;
    this.show(this.done, true);
  }

  // How far the replay is (0 to 1)
  show(done, again = false) {
    if (done === this.done && !again) return;
    this.done = done;
    const x = `translateX(${(done * this.width).toFixed(1)}px)`;
    this.thumb.style.transform = x;
    this.bubble.style.transform = x;
    this.doneBar.style.transform = `scaleX(${done.toFixed(4)})`;
    const span = this.player.end - this.player.start,
      seconds = String(Math.round((done * span) / 1000));
    if (this.el.getAttribute('aria-valuenow') === seconds) return;
    const now = clock(done * span);
    this.el.setAttribute('aria-valuenow', seconds);
    this.el.setAttribute('aria-valuetext', `${now} of ${clock(span)}`);
    this.bubble.textContent = now;
  }
  // How much has loaded (0 to 1)
  loaded(part) {
    this.loadedBar.style.transform = `scaleX(${Math.min(1, part).toFixed(4)})`;
  }

  destroy() {
    this.el.replaceChildren();
  }
}

// A span of time as m:ss (h:mm:ss from an hour)
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)),
    h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

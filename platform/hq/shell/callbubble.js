// A minimised call: a bubble floating over the page with the agent's face, alive with its voice, the live eye while
// the page is watched along, Pause, hang up and open. Dragged anywhere, it settles into the nearest corner on a spring.
// HQ's call (callscreen.js) and the join link's page (joinpage.js) both use it; each styles `.callbubble` in its own look.
//   words      { call, pause, resume, hangUp, open, watched, paused }: the buttons' and the eye's words
//   face       the element drawn in the bubble (a portrait canvas, an svg)
//   icons      { eye, hangUp }: the page's own drawings of them, as markup (else simple ones of this file's)
//   keep       a localStorage key for the corner it last settled in, or none
//   onPause, onResume, onHangUp, onOpen, onSound(name): name is 'settle' as it lands in a corner
// It's marked data-watchalong-hide: the call's own controls are never recorded.
const MARGIN_PX = 12;
// The spring that carries it to a corner: stiff enough to land in about 0.4 s, damped to settle with one small overshoot
const STIFFNESS = 380,
  DAMPING = 30;
// A drag shorter than this is a tap; a throw projects the bubble this far ahead along its speed, as iOS's picture in picture does
const DRAG_PX = 6,
  THROW_S = 0.18;
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

export class CallBubble {
  constructor({ words, face, icons = {}, keep = '', onPause, onResume, onHangUp, onOpen, onSound = () => {} }) {
    this.words = words;
    this.keep = keep;
    this.onSound = onSound;
    this.corner = (keep && localStorage.getItem(keep)) || 'bottom-right';
    if (!CORNERS.includes(this.corner)) this.corner = 'bottom-right';
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const el = (this.el = document.createElement('div'));
    el.className = 'callbubble';
    el.setAttribute('data-watchalong-hide', '');
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', words.call);
    el.innerHTML = `<button type="button" class="cb-face" aria-label="${attr(words.open)}" title="${attr(words.open)}"></button>
      <span class="cb-eye" role="img" aria-label="${attr(words.watched)}" title="${attr(words.watched)}" hidden>${icons.eye ?? EYE}</span>
      <div class="cb-keys">
        <button type="button" class="cb-pause" hidden>${attr(words.pause)}</button>
        <button type="button" class="cb-hangup" aria-label="${attr(words.hangUp)}" title="${attr(words.hangUp)}">${icons.hangUp ?? HANG_UP}</button>
      </div>`;
    el.querySelector('.cb-face').append(face);
    this.pauseKey = el.querySelector('.cb-pause');
    this.pauseKey.onclick = () => (this.isPaused ? onResume?.() : onPause?.());
    el.querySelector('.cb-hangup').onclick = () => onHangUp?.();
    this.onOpen = onOpen;
    this.wireDrag();
    this.fit = () => this.settle(false);
    // (the page's own size too: HQ's narrows beside its book.)
    this.fitting = new ResizeObserver(this.fit);
    addEventListener('resize', this.fit);
    visualViewport?.addEventListener('resize', this.fit);
  }

  // Shown over the page, growing out of `from` (the call screen's face, a DOMRect) when given
  show(from = null) {
    this.leaving?.cancel();
    this.leaving = null;
    document.body.append(this.el);
    this.fitting.observe(document.body);
    this.el.hidden = false;
    const home = this.home();
    this.place(home.x, home.y);
    if (!from || this.reduced) return;
    const box = this.el.getBoundingClientRect();
    const dx = from.left + from.width / 2 - (box.left + box.width / 2),
      dy = from.top + from.height / 2 - (box.top + box.height / 2);
    const scale = Math.max(1, Math.min(from.width / box.width, 3));
    this.el.animate(
      [
        { translate: `${dx}px ${dy}px`, scale, opacity: 0.4 },
        { translate: '0 0', scale: 1, opacity: 1 },
      ],
      { duration: 420, easing: 'cubic-bezier(.2, 1.3, .4, 1)' },
    );
  }

  // Gone (the call opened again, or over): toward `to` (a DOMRect) when given
  async hide(to = null) {
    if (!this.el.isConnected) return;
    if (to && !this.reduced) {
      const box = this.el.getBoundingClientRect();
      const dx = to.left + to.width / 2 - (box.left + box.width / 2),
        dy = to.top + to.height / 2 - (box.top + box.height / 2);
      const leaving = (this.leaving = this.el.animate([{}, { translate: `${dx}px ${dy}px`, scale: 1.6, opacity: 0 }], {
        duration: 260,
        easing: 'cubic-bezier(.4, 0, .6, 1)',
      }));
      // (show() cancels it: the bubble was called back before it left, and stays)
      await new Promise(done => Object.assign(leaving, { onfinish: done, oncancel: done }));
      if (this.leaving !== leaving) return;
      this.leaving = null;
    }
    this.el.remove();
  }

  close() {
    cancelAnimationFrame(this.frame);
    this.fitting.disconnect();
    removeEventListener('resize', this.fit);
    visualViewport?.removeEventListener('resize', this.fit);
    this.el.remove();
  }

  // The page is watched along (the eye, and Pause), paused (Pause says resume), or neither (the page isn't ours)
  watching(state) {
    this.isPaused = state === 'paused';
    this.el.querySelector('.cb-eye').hidden = state !== 'watched';
    this.pauseKey.hidden = state === 'off';
    this.pauseKey.textContent = this.isPaused ? this.words.resume : this.words.pause;
    this.pauseKey.setAttribute('aria-pressed', String(this.isPaused));
    this.el.classList.toggle('paused', this.isPaused);
  }

  // How loud the agent is now, 0 to 1, and whether anyone's talking: the face moves with it
  voice(level, talking = level > 0.02) {
    this.el.style.setProperty('--cb-level', level.toFixed(3));
    this.el.classList.toggle('talking', talking);
  }

  // listening | thinking | speaking | reconnecting | '': for the look to show, and for a screen reader
  state(state) {
    this.el.dataset.state = state;
  }

  // ---- dragging: the bubble follows the finger, then springs to the corner nearest where the throw would carry it
  // (followed on the window while held: a quick drag leaves the bubble before it catches up)
  wireDrag() {
    let grab = null;
    const move = e => {
      if (e.pointerId !== grab.id) return;
      if (!grab.moved && Math.hypot(e.clientX - grab.x0, e.clientY - grab.y0) < DRAG_PX) return;
      if (!grab.moved) {
        grab.moved = true;
        this.el.classList.add('held');
      }
      const x = e.clientX - grab.dx,
        y = e.clientY - grab.dy;
      this.place(x, y);
      grab.trail = [...grab.trail.filter(p => e.timeStamp - p.t < 100), { x, y, t: e.timeStamp }];
    };
    const drop = e => {
      if (e.pointerId !== grab.id) return;
      const { moved, trail, onFace } = grab;
      grab = null;
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', drop);
      removeEventListener('pointercancel', drop);
      this.el.classList.remove('held');
      if (!moved) {
        if (e.type === 'pointerup' && onFace) this.onOpen?.();
        return;
      }
      const first = trail[0],
        last = trail.at(-1),
        dt = Math.max(1, last.t - first.t) / 1000;
      this.throwTo((last.x - first.x) / dt, (last.y - first.y) / dt);
    };
    this.el.addEventListener('pointerdown', e => {
      if (grab || e.button || e.target.closest('.cb-keys button')) return;
      cancelAnimationFrame(this.frame);
      const box = this.el.getBoundingClientRect();
      grab = { id: e.pointerId, dx: e.clientX - box.left, dy: e.clientY - box.top, x0: e.clientX, y0: e.clientY };
      grab.trail = [{ x: box.left, y: box.top, t: e.timeStamp }];
      grab.moved = false;
      grab.onFace = !!e.target.closest('.cb-face');
      addEventListener('pointermove', move);
      addEventListener('pointerup', drop);
      addEventListener('pointercancel', drop);
    });
    // the face opens the call by keyboard too; by pointer, only a tap that didn't drag (drop) does
    this.el.querySelector('.cb-face').addEventListener('click', e => !e.detail && this.onOpen?.());
  }

  throwTo(vx, vy) {
    const { x, y } = this.at;
    const box = this.bounds();
    const ahead = { x: x + vx * THROW_S, y: y + vy * THROW_S };
    const right = ahead.x + this.size().w / 2 > (box.left + box.right) / 2,
      bottom = ahead.y + this.size().h / 2 > (box.top + box.bottom) / 2;
    this.corner = `${bottom ? 'bottom' : 'top'}-${right ? 'right' : 'left'}`;
    if (this.keep) localStorage.setItem(this.keep, this.corner);
    this.spring({ vx, vy });
  }

  // To its corner: on the spring, or at once (a resize, reduced motion)
  settle(animated = true) {
    if (!this.el.isConnected) return;
    if (!animated || this.reduced) {
      const home = this.home();
      return this.place(home.x, home.y);
    }
    this.spring({ vx: 0, vy: 0 });
  }

  spring(v) {
    cancelAnimationFrame(this.frame);
    if (this.reduced) return this.settle(false);
    let { x, y } = this.at,
      { vx, vy } = v,
      last = performance.now(),
      landed = false;
    const step = now => {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      const home = this.home();
      const ax = STIFFNESS * (home.x - x) - DAMPING * vx,
        ay = STIFFNESS * (home.y - y) - DAMPING * vy;
      vx += ax * dt;
      vy += ay * dt;
      x += vx * dt;
      y += vy * dt;
      if (!landed && Math.hypot(home.x - x, home.y - y) < 8) {
        landed = true;
        this.onSound('settle');
      }
      const resting = Math.hypot(home.x - x, home.y - y) < 0.5 && Math.hypot(vx, vy) < 5;
      this.place(resting ? home.x : x, resting ? home.y : y);
      if (!resting) this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  // Where its corner is now: inside the visible viewport (an on-screen keyboard, a phone's bars) and the page (HQ's
  // narrows beside its book), off the safe areas
  home() {
    const box = this.bounds(),
      { w, h } = this.size();
    return {
      x: this.corner.endsWith('left') ? box.left : box.right - w,
      y: this.corner.startsWith('top') ? box.top : box.bottom - h,
    };
  }

  bounds() {
    const vv = visualViewport,
      safe = safeArea();
    const x0 = vv?.offsetLeft ?? 0,
      y0 = vv?.offsetTop ?? 0;
    return {
      left: x0 + MARGIN_PX + safe.left,
      top: y0 + MARGIN_PX + safe.top,
      right: Math.min(x0 + (vv?.width ?? innerWidth), document.body.clientWidth) - MARGIN_PX - safe.right,
      bottom: y0 + (vv?.height ?? innerHeight) - MARGIN_PX - safe.bottom,
    };
  }

  size() {
    return { w: this.el.offsetWidth, h: this.el.offsetHeight };
  }

  place(x, y) {
    this.at = { x, y };
    this.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  }
}

const attr = text => String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
// The live eye, open, its pupil looking around (the look animates .cb-pupil)
const EYE = `<svg viewBox="0 0 16 10" aria-hidden="true"><path class="cb-lid" d="M1 5C3.5 1.5 6 1 8 1s4.5.5 7 4c-2.5 3.5-5 4-7 4S3.5 8.5 1 5Z"/><circle class="cb-pupil" cx="8" cy="5" r="2.4"/></svg>`;
const HANG_UP = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 14.5c4.9-4.6 13.1-4.6 18 0l-2.4 2.6-3.6-1.6v-2.4a11 11 0 0 0-6 0v2.4l-3.6 1.6Z"/></svg>`;

// The screen's safe areas (a notch, the home indicator), in px: env() reads only in a property that takes a length
let probe = null;
function safeArea() {
  if (!probe?.isConnected) {
    probe = document.createElement('div');
    Object.assign(probe.style, {
      position: 'fixed',
      visibility: 'hidden',
      pointerEvents: 'none',
      padding:
        'env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px)',
    });
    probe.setAttribute('data-watchalong-hide', '');
    document.body.append(probe);
  }
  const css = getComputedStyle(probe);
  return {
    top: parseFloat(css.paddingTop),
    right: parseFloat(css.paddingRight),
    bottom: parseFloat(css.paddingBottom),
    left: parseFloat(css.paddingLeft),
  };
}

// A minimised call floats over the page. Its first position keeps clear of controls and readable content.
// A pen or finger can then put it anywhere. The chosen position survives layout changes, clamped to the visible screen.
// HQ and the join page supply their face, words, icons and callbacks, and can keep the position in localStorage.
import { clearSpot, floating, inSight, keptClear, room } from './floating.js';

// A shorter movement is a tap, so opening the call never competes with dragging it.
const DRAG_PX = 6;

export class CallBubble {
  constructor({ words, face, icons = {}, keep = '', onPause, onResume, onHangUp, onOpen, onSound = () => {} }) {
    this.words = words;
    this.keep = keep;
    this.onSound = onSound;
    // Pause is an icon key when the page gives its icons (icons.pause, and icons.resume while paused, or the pause
    // icon both ways without one), with its words as the key's label and tooltip. A page without them, as the join
    // page, gets a key of words.
    this.pauseIcons = icons.pause && { pause: icons.pause, resume: icons.resume ?? icons.pause };
    this.position = readPosition(keep);
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const el = (this.el = document.createElement('div'));
    el.className = 'callbubble';
    el.setAttribute('data-no-ink', '');
    el.setAttribute('data-keep-clear', ''); // (the call's cards keep clear of it, as of the page's controls)
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', words.call);
    el.innerHTML = `<button type="button" class="cb-face" aria-label="${attr(words.open)}" title="${attr(words.open)}"></button>
      <span class="cb-eye" role="img" aria-label="${attr(words.watched)}" title="${attr(words.watched)}" hidden>${icons.eye ?? EYE}</span>
      <div class="cb-keys">
        <button type="button" class="cb-pause" hidden></button>
        <button type="button" class="cb-hangup" aria-label="${attr(words.hangUp)}" title="${attr(words.hangUp)}">${icons.hangUp ?? HANG_UP}</button>
      </div>`;
    el.querySelector('.cb-face').append(face);
    this.pauseKey = el.querySelector('.cb-pause');
    this.pauseKey.onclick = () => (this.isPaused ? onResume?.() : onPause?.());
    this.watching('off');
    el.querySelector('.cb-hangup').onclick = () => onHangUp?.();
    this.onOpen = onOpen;
    this.wireDrag();
    this.fit = () => this.settle();
    // (the page's own size too: HQ's narrows beside its book.)
    this.fitting = new ResizeObserver(this.fit);
    addEventListener('resize', this.fit);
    visualViewport?.addEventListener('resize', this.fit);
    // (and what it keeps clear of moved: a tool opened or closed, a swing ended)
    this.refit = () => {
      cancelAnimationFrame(this.refitting);
      this.refitting = requestAnimationFrame(() => this.settle());
    };
    this.changes = new MutationObserver(this.refit);
    for (const event of ['transitionend', 'animationend']) document.addEventListener(event, this.refit);
  }

  // Shown over the page, growing out of `from` (the call screen's face, a DOMRect) when given
  show(from = null) {
    this.leaving?.cancel();
    this.leaving = null;
    floating().append(this.el);
    this.fitting.observe(document.body);
    this.fitting.observe(this.el);
    // (a page or a tool shown or hidden, a part taking taps or not, the book's mode)
    const attributeFilter = ['hidden', 'inert', 'data-book'];
    this.changes.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter });
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
    cancelAnimationFrame(this.refitting);
    this.fitting.disconnect();
    this.changes.disconnect();
    removeEventListener('resize', this.fit);
    visualViewport?.removeEventListener('resize', this.fit);
    for (const event of ['transitionend', 'animationend']) document.removeEventListener(event, this.refit);
    this.el.remove();
  }

  // The page is watched along (the eye, and Pause), paused (Pause says resume), shown but not reaching the agent
  // ('unseen': Pause, no eye), or neither (the page isn't ours)
  watching(state) {
    this.isPaused = state === 'paused';
    this.el.querySelector('.cb-eye').hidden = state !== 'watched';
    this.pauseKey.hidden = state === 'off';
    const says = this.isPaused ? this.words.resume : this.words.pause;
    if (!this.pauseIcons) this.pauseKey.textContent = says;
    // (an icon only when its words change: HQ's icons are an empty <svg data-icon> that icons.js draws in after, and
    // writing the same one again would blank it until then, a blink at every call of watching)
    else if (this.pauseKey.title !== says) {
      this.pauseKey.innerHTML = this.isPaused ? this.pauseIcons.resume : this.pauseIcons.pause;
      this.pauseKey.title = says;
      this.pauseKey.setAttribute('aria-label', says);
    }
    this.pauseKey.setAttribute('aria-pressed', String(this.isPaused));
    this.el.classList.toggle('paused', this.isPaused);
  }

  // How loud the agent is now, 0 to 1, and whether anyone's talking: the face moves with it
  voice(level, talking = level > 0.02) {
    // (only a change: a watch-along records the bubble, and each write is an event.)
    const shown = level.toFixed(2);
    if (this.el.style.getPropertyValue('--cb-level') !== shown) this.el.style.setProperty('--cb-level', shown);
    this.el.classList.toggle('talking', talking);
  }

  // listening | thinking | speaking | reconnecting | '': for the look to show, and for a screen reader
  state(state) {
    this.el.dataset.state = state;
  }

  // The pointer stays on the window while held, including when it crosses between HQ and the notebook.
  wireDrag() {
    let grab = null;
    const move = e => {
      if (e.pointerId !== grab.id) return;
      if (!grab.moved && Math.hypot(e.clientX - grab.x0, e.clientY - grab.y0) < DRAG_PX) return;
      if (!grab.moved) {
        grab.moved = true;
        this.el.classList.add('held');
      }
      this.place(e.clientX - grab.dx, e.clientY - grab.dy, grab.bounds);
    };
    const drop = e => {
      if (e.pointerId !== grab.id) return;
      if (e.type === 'pointerup') move(e);
      const { moved, onFace } = grab;
      grab = null;
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', drop);
      removeEventListener('pointercancel', drop);
      this.el.classList.remove('held');
      if (!moved) {
        if (e.type === 'pointerup' && onFace) this.onOpen?.();
        return;
      }
      this.position = { ...this.at };
      if (this.keep) localStorage.setItem(this.keep, JSON.stringify(this.position));
      this.settle();
      this.onSound('settle');
    };
    this.el.addEventListener('pointerdown', e => {
      // (and a page's own key on it: HQ's raised hand, callhand.js.)
      if (grab || e.button || e.target.closest('.cb-keys button, .call-hand')) return;
      const box = this.el.getBoundingClientRect();
      grab = { id: e.pointerId, dx: e.clientX - box.left, dy: e.clientY - box.top, x0: e.clientX, y0: e.clientY };
      grab.bounds = this.bounds();
      grab.moved = false;
      grab.onFace = !!e.target.closest('.cb-face');
      addEventListener('pointermove', move);
      addEventListener('pointerup', drop);
      addEventListener('pointercancel', drop);
    });
    // A pointer tap opens in drop. A keyboard activation has no pointer detail.
    this.el.querySelector('.cb-face').addEventListener('click', e => !e.detail && this.onOpen?.());
  }

  // A page carried toward the call must keep the target it saw when it was picked up.
  holdCallPosition(held) {
    this.callPositionHeld = held;
    if (!held) this.settle();
  }

  settle() {
    if (this.callPositionHeld || !this.el.isConnected || this.el.classList.contains('held')) return;
    const home = this.home();
    this.place(home.x, home.y);
  }

  // Automatic placement is only for a call the board has not placed yet.
  home() {
    if (this.position) return this.position;
    const size = this.size(),
      places = [room(), room({ whole: true })].map(box => ({
        room: box,
        at: { x: box.right - size.w, y: box.bottom - size.h },
      }));
    return clearSpot(size, places, keptClear(this.el), inSight()) ?? places[0].at;
  }

  size() {
    return { w: this.el.offsetWidth, h: this.el.offsetHeight };
  }

  bounds() {
    return { box: room({ whole: true, margin: 0 }), ...this.size() };
  }

  place(x, y, { box, w, h } = this.bounds()) {
    x = Math.max(box.left, Math.min(x, box.right - w));
    y = Math.max(box.top, Math.min(y, box.bottom - h));
    this.at = { x, y };
    const transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0px)`;
    if (this.el.style.transform !== transform) this.el.style.transform = transform;
  }
}

// (JSON.parse(null) is null: nothing dropped yet)
const readPosition = key => (key ? JSON.parse(localStorage.getItem(key)) : null);

const attr = text => String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
// The live eye, open, its pupil looking around (the look animates .cb-pupil)
const EYE = `<svg viewBox="0 0 16 10" aria-hidden="true"><path class="cb-lid" d="M1 5C3.5 1.5 6 1 8 1s4.5.5 7 4c-2.5 3.5-5 4-7 4S3.5 8.5 1 5Z"/><circle class="cb-pupil" cx="8" cy="5" r="2.4"/></svg>`;
const HANG_UP = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 14.5c4.9-4.6 13.1-4.6 18 0l-2.4 2.6-3.6-1.6v-2.4a11 11 0 0 0-6 0v2.4l-3.6 1.6Z"/></svg>`;

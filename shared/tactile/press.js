// Keys that go down under a finger, a mouse or Enter and Space, and stay down until their click has landed, and a
// quick press for a key the page presses itself (a message landing on it).
import { reducedMotion } from './motion.js';

// A press stays down at least this long, so a quick tap's is seen
export const PRESS_MIN_MS = 90;
// A phone sends the click a moment after the finger lifts. A key let go waits this long for it before it comes up, so
// a tap goes down once and not twice.
export const CLICK_WAIT_MS = 500;
// The quick press: down and back up over PRESS_MS, the `down` class on for PRESS_DOWN_MS, a soft one a little gentler
export const PRESS_MS = 200;
export const PRESS_DOWN_MS = 140;
export const SOFT_PRESS_MS = 260;
export const SOFT_PRESS_DOWN_MS = 180;

// Every key under root (keys: a selector) wears the class `down` from its press until its click has landed, or the
// press is cancelled, and never for less than PRESS_MIN_MS. onDown(key) runs the moment it goes down, for its sound.
// A real input under a key (a choice: its label holds the input and the key) presses that key by Space, as it
// chooses, and a radio chosen by an arrow key presses the key of the one chosen. Returns a function that stops it.
// (the input under a key)
export function holdPresses(root, { keys = 'button, [role="button"]', onDown = () => {} } = {}) {
  const ownKey = target => (target instanceof Element ? target.closest(keys) : null),
    keyOf = target => ownKey(target) ?? target.labels?.[0]?.querySelector(keys) ?? null,
    // (Enter chooses nothing: on a choice it presses no key, and in a form it submits it)
    typedKey = event => (event.key === ' ' ? keyOf(event.target) : ownKey(event.target)),
    hold = holder(onDown);
  const listeners = [
    [root, 'pointerdown', event => event.isPrimary && event.button === 0 && hold.press(keyOf(event.target))],
    [document, 'pointerup', event => event.isPrimary && hold.letGo()],
    [document, 'pointercancel', event => event.isPrimary && hold.cancel()],
    [root, 'keydown', event => !event.repeat && pressing(event) && hold.press(typedKey(event))],
    [root, 'keyup', event => pressing(event) && hold.letGo()],
    [root, 'change', event => hold.tap(keyOf(event.target))],
    [root, 'click', event => hold.land(keyOf(event.target))],
  ];
  for (const [target, type, listener] of listeners) target.addEventListener(type, listener);
  return () => {
    for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
  };
}
const pressing = event => event.key === 'Enter' || event.key === ' ';
// The keys held down, each from its press until it comes up
function holder(onDown) {
  const held = new Map(); // key → { since, landed, timer }
  const lift = key => {
    const hold = held.get(key);
    clearTimeout(hold.timer);
    hold.timer = setTimeout(
      () => {
        held.delete(key);
        key.classList.remove('down');
      },
      Math.max(0, PRESS_MIN_MS - (performance.now() - hold.since)),
    );
  };
  return {
    press(key) {
      if (!key) return;
      clearTimeout(held.get(key)?.timer);
      held.set(key, { since: performance.now(), landed: false });
      key.classList.add('down');
      onDown(key);
    },
    // let go: up once its click has landed, or after CLICK_WAIT_MS without one (the pointer slid off the key)
    letGo() {
      for (const [key, hold] of held)
        if (!hold.landed) {
          clearTimeout(hold.timer);
          hold.timer = setTimeout(() => lift(key), CLICK_WAIT_MS);
        }
    },
    cancel: () => [...held.keys()].forEach(lift),
    land(key) {
      if (!held.has(key)) return;
      held.get(key).landed = true;
      lift(key);
    },
    // down and landed at once, unless it's held already (a choice by Space, a click): up after PRESS_MIN_MS
    tap(key) {
      if (held.has(key)) return;
      this.press(key);
      this.land(key);
    },
  };
}

// A key pressed down and let go at once (soft: a lighter press, as a message landing on it gives). How far it goes is
// the page's CSS: the transform in the key's --press-tile, or --hover-tile for a soft one. It wears `down` meanwhile,
// or `nudged` for a soft one.
export function pressBriefly(key, { soft = false } = {}) {
  if (reducedMotion()) return;
  const down = getComputedStyle(key)
    .getPropertyValue(soft ? '--hover-tile' : '--press-tile')
    .trim();
  key.animate([{ transform: 'none' }, { transform: down, offset: 0.35 }, { transform: 'none' }], {
    duration: soft ? SOFT_PRESS_MS : PRESS_MS,
    easing: 'ease-out',
  });
  const held = soft ? 'nudged' : 'down';
  key.classList.add(held);
  setTimeout(() => key.classList.remove(held), soft ? SOFT_PRESS_DOWN_MS : PRESS_DOWN_MS);
}

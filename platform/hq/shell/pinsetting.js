// HQ's pin (review mode, shared/review), the mouse's and a finger's way to mark HQ (the Pencil writes on it anyway): on or
// off for this device in Settings › Pin on HQ, off until the board turns it on. Review mode shows and hides it
// ('review:summon': dock.js) with its quick pop and shrink. The book has no say in it. On a call there's no pin: the board
// scribbles in red for the call's agent (calldraw.js's call:on and call:off), and after the call the setting holds again
// (the board, call 161.).
import { store } from '../util.js';

let calling = false;

export function mountPin() {
  document.addEventListener('call:on', () => onCall(true));
  document.addEventListener('call:off', () => onCall(false));
}
export const pinOn = () => store.get('pin', false);
export function setPin(on) {
  store.set('pin', on);
  tellPin();
}
// What the pin is now, told again (review mode just loaded)
export const tellPin = () => dispatchEvent(new CustomEvent('review:summon', { detail: pinOn() && !calling }));

function onCall(on) {
  calling = on;
  tellPin();
}

// Show me (tips.js): HQ dimmed around one real control, a ring that breathes round it, and the step beside it. The
// control still works and nothing else does: pressing it goes on to the next step, the last ends the tip, and so does
// Got it in the step.
import { esc } from '../util.js';
import { sfx } from './audio.js';

const PAD_PX = 8,
  FIND_MS = 4000, // a control that hasn't shown by then (its page didn't open, or it isn't there now): the step says so
  NEXT_MS = 350; // a pressed control's page opening before the next step looks for its control
let current = null;

// steps: [{ at: a CSS selector or a function finding the control, given details, say }]. details: the tip's event's.
// done(shown): the control of the last step pressed (shown) or Got it.
export function showMe(steps, details, done) {
  stopShowMe();
  const veil = Object.assign(document.createElement('div'), { className: 'showme-veil' }),
    ring = Object.assign(document.createElement('div'), { className: 'showme-ring' }),
    step = Object.assign(document.createElement('div'), { className: 'showme-step', role: 'dialog' });
  document.documentElement.append(over(veil, ring, step));
  const press = e => current?.control && hits(current.control, e) && pressed();
  document.addEventListener('click', press, true);
  current = { steps, details, i: -1, done, veil, ring, step, control: null, frame: 0, press };
  requestAnimationFrame(() => veil.classList.add('on'));
  goOn();
}
export const showingMe = () => !!current;
export function stopShowMe() {
  if (!current) return;
  const { veil, frame, press } = current;
  cancelAnimationFrame(frame);
  document.removeEventListener('click', press, true);
  veil.parentNode.remove();
  current = null;
}
// Show me's layers on <html>, over the book (book.js) as well as HQ's page: in <body> its layout containment would stack
// them under the book, where a control can be (the pin's key). They wear the look's colours and type, set on <body>.
const LOOK = ['--paper', '--ink', '--gold', '--shadow', '--r-lg'];
function over(...layers) {
  const look = getComputedStyle(document.body),
    el = document.createElement('div');
  el.style.cssText = `display:contents;font-family:${look.fontFamily}`;
  for (const v of LOOK) el.style.setProperty(v, look.getPropertyValue(v));
  el.append(...layers);
  return el;
}

// The next step: its control found (waiting for its page to open), then the ring, the step and the hole on it
function goOn() {
  const s = current.steps[++current.i],
    started = performance.now(),
    me = current;
  me.control = null;
  me.step.hidden = true;
  me.ring.hidden = true;
  const look = () => {
    if (current !== me) return;
    const control = visible(s.at, me.details);
    if (control) return point(control, s);
    if (performance.now() - started > FIND_MS) return missing(s);
    me.frame = requestAnimationFrame(look);
  };
  look();
}
const visible = (at, details) =>
  (typeof at === 'function' ? [at(details)].filter(Boolean) : [...document.querySelectorAll(at)]).find(e => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }) ?? null;

function point(control, s) {
  const me = current,
    n = me.steps.length;
  me.control = control;
  me.step.innerHTML = `<b>${n > 1 ? `${me.i + 1} of ${n}` : 'Show me'}</b><p>${esc(s.say)}</p><button class="got">Got it</button>`;
  me.step.querySelector('.got').onclick = () => end(false);
  me.step.hidden = false;
  me.ring.hidden = false;
  control.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  sfx.press();
  // (each frame: the control moves with its page, a panel sliding in or the window turned)
  const follow = () => {
    if (current !== me) return;
    if (!control.isConnected) return goBack();
    place(control.getBoundingClientRect());
    me.frame = requestAnimationFrame(follow);
  };
  follow();
}
// A control that never showed: the step says so in the middle of the dimmed HQ, and closing it leaves the tip on the phone
function missing(s) {
  const { veil, step } = current;
  veil.style.clipPath = '';
  step.removeAttribute('style'); // (where an earlier step's control was)
  step.innerHTML = `<b>Show me</b><p>${esc(s.say)}</p><p>That isn’t on screen now.</p><button class="got">Close</button>`;
  step.querySelector('.got').onclick = stopShowMe;
  step.classList.add('missing');
  step.hidden = false;
}
// The control gone before it was pressed (its page closed): look for it again, as the step's own start does
function goBack() {
  current.i--;
  goOn();
}

// A press on the control, or inside its box when it sits in a closed layer (review mode's pin): HQ's page hears that
// press from the layer's host
const hits = (control, e) => {
  if (control.contains(e.target)) return true;
  const r = control.getRootNode().host === e.target && control.getBoundingClientRect();
  return !!r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
};
function pressed() {
  const me = current;
  me.control = null;
  cancelAnimationFrame(me.frame);
  me.step.hidden = true; // (the pressed step's ring and words gone while the next one's page opens)
  me.ring.hidden = true;
  if (me.i === me.steps.length - 1) return end(true);
  setTimeout(() => current === me && goOn(), NEXT_MS);
}
function end(shown) {
  const { done } = current;
  stopShowMe();
  done(shown);
}

// The hole in the veil, the ring round it, and the step below the control (above it when there's no room)
function place(r) {
  const { veil, ring, step } = current,
    x = r.left - PAD_PX,
    y = r.top - PAD_PX,
    w = r.width + 2 * PAD_PX,
    h = r.height + 2 * PAD_PX;
  veil.style.clipPath = `path(evenodd, 'M0 0H${innerWidth}V${innerHeight}H0Z M${x} ${y}h${w}v${h}h${-w}Z')`;
  Object.assign(ring.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  const below = y + h + 16 + step.offsetHeight < innerHeight,
    left = Math.max(12, Math.min(innerWidth - step.offsetWidth - 12, r.left + r.width / 2 - step.offsetWidth / 2));
  step.classList.toggle('above', !below);
  step.style.left = `${left}px`;
  step.style.top = `${below ? y + h + 16 : y - 16 - step.offsetHeight}px`;
  step.style.setProperty('--arrow', `${Math.max(18, Math.min(step.offsetWidth - 18, r.left + r.width / 2 - left))}px`);
}

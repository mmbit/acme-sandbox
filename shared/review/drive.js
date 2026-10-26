// The call's agent driving the page the board sees (HQ's shell/calldrive.js): scroll to what it names, a screen at a
// time, or point at something with its own pointer, in its ink with its name. Runs on HQ's own page and, through review
// mode's answer to HQ (review.js), in a preview in HQ's viewer. Nothing here stops the board: a touch or a scroll of its
// own takes over at once.
//   drive({ to | by | point | ring, color, name, words }) → { done, why? }   to: words on the page; by: down | up | top |
//     bottom; ring: words to ring in its ink in a preview (ring.js), words beside it. drive({ wipe }): its rings gone.
//     (ring and wipe)
import { isPrivate } from './anchor.js';
import { ringOver, wipeRings } from './ring.js';

// The pointer stays this long where it points, then fades; it glides there in about a third of a second
const POINT_MS = 6000,
  GLIDE_MS = 360;

export async function drive(d) {
  if (d?.wipe) return wiped();
  if (typeof d?.by === 'string') return scrolled(d.by);
  const target = named(d?.to ?? d?.point ?? d?.ring);
  if (target.why) return { done: false, why: target.why };
  if (target.off || d.to) {
    target.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await settled(target.el);
  }
  if (d.point) pointAt(target.el, d.color, d.name);
  if (d.ring) await ringOver(target.el, d);
  const told = [target.off && !d.to && 'It was off their screen: scrolled to it first.', d.ring && RING_KEPT];
  const why = told.filter(Boolean).join(' ');
  return { done: true, ...(why ? { why } : {}) };
}
// What the agent hears of a ring in a preview: unlike one on HQ's pages, it isn't kept in the book
const RING_KEPT =
  "It's on the preview they have open, not kept in the book: it goes when the call ends or they leave the page.";

// What the agent names on the page: the innermost visible element whose words (or label) hold them, one on screen first,
// the smallest of those. Never inside private parts or the call's own controls. (callnotes.js rings it the same way.)
const flat = s =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
const SKIP = new Set(['script', 'style', 'template', 'noscript', 'head']);
export function named(words) {
  const want = flat(words);
  if (!want) return { why: 'Name it by the words they can see on it.' };
  const says = el =>
    flat(`${el.textContent} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('alt') ?? ''}`).includes(want);
  const hits = [...document.body.querySelectorAll('*')].filter(
    el => !SKIP.has(el.localName) && !el.closest('[data-watchalong-hide], [data-call-ink]') && says(el),
  );
  const shown = hits
    .filter(el => !hits.some(o => o !== el && el.contains(o)) && !isPrivate(el))
    .map(el => ({ el, box: el.getBoundingClientRect() }))
    .filter(({ el, box }) => box.width && box.height && getComputedStyle(el).visibility !== 'hidden');
  if (!shown.length)
    return { why: `Nothing on their screen says “${words}”: they're on ${location.pathname}${location.search}.` };
  const onScreen = ({ box }) => box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
  const best = (shown.some(onScreen) ? shown.filter(onScreen) : shown).sort(
    (a, b) => a.box.width * a.box.height - b.box.width * b.box.height,
  )[0];
  const b = best.box;
  return { el: best.el, box: { x: b.left, y: b.top, w: b.width, h: b.height }, off: !onScreen(best) };
}

// A screen down or up, or to the top or bottom, of what scrolls under the middle of the screen (an open panel's list,
// else the page)
function scrolled(by) {
  if (!['down', 'up', 'top', 'bottom'].includes(by)) return { done: false, why: `by is down, up, top or bottom` };
  const box = scrollerAt(innerWidth / 2, innerHeight / 2),
    room = box.scrollHeight - box.clientHeight,
    from = box.scrollTop;
  const to = { down: from + box.clientHeight * 0.8, up: from - box.clientHeight * 0.8, top: 0, bottom: room }[by];
  const clamped = Math.max(0, Math.min(room, to));
  if (Math.abs(clamped - from) < 1)
    return {
      done: false,
      why:
        room < 1 ? 'Nothing scrolls on their screen just now.' : `It's at the ${from < 1 ? 'top' : 'bottom'} already.`,
    };
  box.scrollTo({ top: clamped, behavior: 'smooth' });
  return { done: true };
}
function scrollerAt(x, y) {
  for (let el = document.elementFromPoint(x, y); el && el !== document.body; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if (/(auto|scroll)/.test(overflow) && el.scrollHeight > el.clientHeight + 1) return el;
  }
  return document.scrollingElement ?? document.documentElement;
}
// A smooth scroll's end: when what it scrolled to stops moving, or about a second
function settled(el) {
  return new Promise(done => {
    let last = NaN,
      still = 0,
      frames = 0;
    const look = () => {
      const top = el.getBoundingClientRect().top;
      still = top === last ? still + 1 : 0;
      last = top;
      if (still >= 4 || ++frames > 60) return done();
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
}

// The call ended: its rings and its pointer go
function wiped() {
  wipeRings();
  pointer?.el.remove();
  pointer = null;
  return { done: true };
}

// ---- the agent's pointer: an arrow in its ink with its name, gliding to the top left of what it points at (from where
// it last was, or the screen's left edge), a soft ring pulsing there until it fades. One at a time.
let pointer = null;
function pointAt(el, color = '#7b5ea7', name = '') {
  const b = el.getBoundingClientRect(),
    x = Math.min(innerWidth - 24, Math.max(4, b.left + Math.min(b.width / 2, 28))),
    y = Math.min(innerHeight - 24, Math.max(4, b.top + Math.min(b.height / 2, 18)));
  if (!pointer?.el.isConnected) pointer = { el: pointerEl(), x: 0, y: y };
  const p = pointer;
  p.el.style.setProperty('--ink', color);
  p.el.querySelector('b').textContent = name;
  p.el.classList.remove('gone');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  p.el.style.transform = `translate(${x}px, ${y}px)`;
  if (!reduced)
    p.el.animate([{ transform: `translate(${p.x}px, ${p.y}px)` }, {}], {
      duration: GLIDE_MS,
      easing: 'cubic-bezier(.3, 1.3, .5, 1)',
    });
  Object.assign(p, { x, y });
  clearTimeout(p.timer);
  p.timer = setTimeout(() => p.el.classList.add('gone'), POINT_MS);
}
function pointerEl() {
  const el = document.createElement('div');
  el.setAttribute('data-watchalong-hide', ''); // (the call's own: never recorded)
  el.setAttribute('aria-hidden', 'true');
  el.className = 'hq-pointer';
  el.innerHTML = `<style>
    .hq-pointer { position: fixed; left: 0; top: 0; z-index: 2147483646; pointer-events: none; transition: opacity .5s; }
    .hq-pointer.gone { opacity: 0; }
    .hq-pointer svg { display: block; filter: drop-shadow(0 1px 1.5px rgb(0 0 0 / .35)); }
    .hq-pointer i { position: absolute; left: -9px; top: -9px; width: 18px; height: 18px; border-radius: 50%;
      border: 2px solid var(--ink); animation: hq-pointer-pulse 1.4s ease-out infinite; }
    .hq-pointer b { position: absolute; left: 18px; top: 20px; padding: 2px 7px; border-radius: 9px; background: var(--ink);
      color: #fff; font: 600 12px/1.3 system-ui, sans-serif; white-space: nowrap; }
    @keyframes hq-pointer-pulse { from { transform: scale(.6); opacity: .9 } to { transform: scale(2); opacity: 0 } }
    @media (prefers-reduced-motion: reduce) { .hq-pointer i { animation: none; } }
  </style><i></i><svg width="22" height="26" viewBox="0 0 22 26"><path d="M2 2l17 11.5-7.6 1.4 4.3 8.2-3.3 1.6-4.2-8.3L2 21.5z"
    fill="var(--ink)" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><b></b>`;
  document.body.append(el);
  return el;
}

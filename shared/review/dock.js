// Review mode's pin: where it sits (out of the product's way, or where the board dragged it), its hints, and the bubble
// that explains it on a reviewer's first pages. Its menu's button sits beside it (menu.js).
import { ACCENT, PIN, keep, kept } from './base.js';
import { shut } from './menu.js';
import { toggle } from './tool.js';

// the dock holds the pin and its hints: bottom right above the home bar, lifted clear of the page's own buttons (--up),
// or where the board dragged it
export const CSS = `
      .dock { position: absolute; width: 60px; height: 60px; right: max(18px, calc(env(safe-area-inset-right) + 8px)); bottom: max(18px, calc(env(safe-area-inset-bottom) + 10px));
        transform: translateY(calc(-1 * var(--up, 0px))); transition: transform .35s cubic-bezier(.3,1.4,.5,1); }
      .dock.left { right: auto; left: max(18px, calc(env(safe-area-inset-left) + 8px)); }
      .dock.drag { left: var(--dx); top: var(--dy); right: auto; bottom: auto; transform: none; transition: none; }
      .dock[hidden] { display: none; }
      .fab { pointer-events: auto; position: absolute; inset: 0; touch-action: none;
        width: 60px; height: 60px; border-radius: 50%; background: ${ACCENT}; color: #fff; display: grid; place-items: center;
        box-shadow: 0 6px 0 #c23c44, 0 12px 24px rgba(43,34,48,.3); transition: transform .25s cubic-bezier(.3,1.6,.5,1), box-shadow .15s; animation: bob 3.2s ease-in-out infinite; }
      .dock.drag .fab { animation: none; transform: scale(1.12); box-shadow: 0 14px 0 #c23c44, 0 22px 34px rgba(43,34,48,.3); }
      .fab svg { width: 28px; height: 28px; transition: transform .3s cubic-bezier(.3,1.6,.5,1); }
      .fab:active { transform: translateY(5px); box-shadow: 0 1px 0 #c23c44, 0 4px 10px rgba(43,34,48,.3); }
      .fab.on { animation: none; background: #2b2230; box-shadow: 0 6px 0 #000, 0 12px 24px rgba(43,34,48,.3); }
      .fab.on svg { transform: rotate(45deg) scale(.9); }
      .fab[hidden] { display: none; }
      .fab.boing { animation: boing .6s cubic-bezier(.3,1.6,.5,1); }
      /* hints go over the pin: beside it sits the menu's button */
      .tip { position: absolute; right: 0; bottom: 72px; background: #2b2230; color: #fff; padding: 6px 12px; border-radius: 10px;
        font-size: 14px; white-space: nowrap; opacity: 0; transform: translateY(6px); transition: .25s; pointer-events: none; }
      .dock.left .tip { right: auto; left: 0; }
      .tip.show { opacity: 1; transform: none; }
      /* the first few pages a reviewer opens: a bubble that says what the pin is for, and a ring around the pin */
      /* (100cqw: .ui's width, base.js) */
      .coach { pointer-events: auto; position: absolute; right: -6px; bottom: 80px; width: max-content; max-width: min(260px, calc(100cqw - 32px)); background: #fff; color: #2b2230;
        border: 2px solid #2b2230; border-radius: 16px; padding: 12px 14px 8px; box-shadow: 0 4px 0 #2b2230, 0 14px 34px rgba(43,34,48,.3); font-size: 14px; line-height: 1.35;
        animation: pop-in .45s cubic-bezier(.3,1.5,.5,1) both; }
      .coach::after { content: ""; position: absolute; right: 26px; bottom: -9px; width: 14px; height: 14px; background: #fff; border: solid #2b2230; border-width: 0 2px 2px 0; transform: rotate(45deg); }
      .dock.left .coach { right: auto; left: -6px; } .dock.left .coach::after { right: auto; left: 26px; }
      .coach[hidden] { display: none; }
      .coach b { display: block; font-size: 16px; margin-bottom: 3px; }
      .coach button { display: block; margin: 4px 0 0 auto; padding: 6px 2px; font-weight: 700; color: #c23c44; }
      .dock.coaching .fab::after { content: ""; position: absolute; inset: -9px; border-radius: 50%; border: 3px solid ${ACCENT}; animation: ring 1.5s ease-out infinite; pointer-events: none; }
      @keyframes ring { from { transform: scale(.85); opacity: 1 } to { transform: scale(1.45); opacity: 0 } }
      @keyframes bob { 0%, 100% { transform: translateY(0) rotate(0) } 50% { transform: translateY(-3px) rotate(-4deg) } }`;

// the dock, the menu's markup (menu.js) beside the pin
export const html = menu => `<div class="dock"><div class="tip"></div>
        <div class="coach" hidden role="note"><b>Tap the red pin to leave a note</b>Then tap the bit you mean, and say or type what should change. In the way? Drag the pin.<button>Got it</button></div>
        ${menu}
        <button class="fab" aria-label="Review mode: pin a note">${PIN}</button></div>`;

export function say(r, t, ms = 4000) {
  r.tip.textContent = t;
  r.tip.classList.add('show');
  if (ms) setTimeout(() => r.tip.classList.remove('show'), ms);
}

// The first few pages a reviewer opens explain the pin, until it's used or waved off: counted by the coordinator for
// the person (/__review/coach), so the shop and each of its apps, each on a host of its own, don't ask again
const coaching = (r, body) =>
  fetch(new URL('coach', r.ROUTE), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
// "Got it" or using the pin puts it away for good; a tap on the page itself, until next time
export function uncoach(r, done = true) {
  if (r.coach.hidden) return;
  r.coach.hidden = true;
  r.dock.classList.remove('coaching');
  if (done)
    coaching(r, { done: true }).catch(() => {
      /* asks again next page */
    });
}
function coach(r) {
  // an outsider's hello names the crew
  if (r.outside) r.coach.querySelector('b').textContent = `Tap the red pin to leave a note for the ${r.OUTSIDE} crew`;
  setTimeout(
    () =>
      coaching(r, {})
        .then(res => res.ok && res.json())
        .then(said => {
          if (said?.show && r.mode === 'idle' && r.menu.hidden && !r.dock.classList.contains('drag')) {
            r.coach.hidden = false;
            r.dock.classList.add('coaching');
          }
        })
        .catch(() => {
          /* no bubble */
        }),
    700,
  );
  r.coach.querySelector('button').onclick = () => uncoach(r);
  addEventListener('pointerdown', e => !e.composedPath().includes(r.host) && uncoach(r, false), true);
}

// ---------------------------------------------------------------- where the pin sits
// Out of the product's way: when one of its buttons or links sits under the pin or its menu's button, the pin steps up
// above it (as long as it stays in the lower 60% of the screen), and back down once the page moves on. Dragged, it
// stays put on this product.
const PLACE = '__hq_review_pin',
  TAPPABLE = 'a[href], button, input, select, textarea, label, summary, [role=button], [role=link], [onclick]';
const lift = (r, up) => r.dock.style.setProperty('--up', `${Math.round(up)}px`);
// a dragged spot, as far as this screen allows: turned sideways or in a shorter frame it stops at the top, and the
// stored lift stays as it was, so a taller screen puts the pin back where the board left it
const liftPlaced = r => lift(r, Math.max(0, Math.min(r.placed.up, r.dock.offsetTop - 16)));
// the topmost of the page's tappable things under the pin and the menu's button beside it, at the pin's top
function tappableUnder(r, x, top) {
  let hit = null;
  // the pin, and the menu's button beside it (offsets in the dock)
  const spots = [8, 30, 52].flatMap(dx => [8, 30, 52].map(dy => [dx, dy]));
  if (r.more.isConnected)
    for (const dx of [10, 26]) for (const dy of [10, 26]) spots.push([r.more.offsetLeft + dx, r.more.offsetTop + dy]);
  for (const [dx, dy] of spots) {
    const el = document
      .elementsFromPoint(x + dx, top + dy)
      .find(e => e !== r.host && e !== document.documentElement && e !== document.body)
      ?.closest(TAPPABLE);
    const b = el?.getBoundingClientRect(); // a big one (a whole card that's a button) stays easy to tap around the pin
    if (b && b.width * b.height < (innerWidth * innerHeight) / 4 && (!hit || b.top < hit.top)) hit = b;
  }
  return hit;
}
export function settle(r) {
  if (r.mode !== 'idle' || r.dock.classList.contains('drag')) return;
  if (r.placed) return liftPlaced(r);
  const x = r.dock.offsetLeft,
    home = r.dock.offsetTop; // offsets ignore the lift (a transform): this is where the pin sits unlifted
  let top = home;
  for (let round = 0; round < 4; round++) {
    // clear of one button, the pin may land on the next one up
    const hit = tappableUnder(r, x, top);
    if (!hit) break;
    top = hit.top - 70;
  }
  lift(r, top < innerHeight * 0.4 ? 0 : home - top); // too far up: stay home, the board can scroll or drag
}
function settling(r) {
  r.placed = (() => {
    try {
      return JSON.parse(kept(localStorage, PLACE));
    } catch {
      return null;
    }
  })();
  if (r.placed) {
    r.dock.classList.toggle('left', !!r.placed.left);
    liftPlaced(r);
  }
  let timer;
  const soon = ms => {
    clearTimeout(timer);
    timer = setTimeout(() => settle(r), ms);
  };
  addEventListener('scroll', () => soon(250), { passive: true });
  addEventListener('resize', () => soon(250));
  addEventListener('click', e => !e.composedPath().includes(r.host) && soon(450), true); // a sheet or step the tap opened
  addEventListener('popstate', () => soon(300));
  addEventListener('load', () => soon(100));
  soon(400);
}
// drag: press and move the pin, or the menu's button beside it (it looks like a handle), and let go on either side.
// The pin follows the finger from where it was held; a plain tap on either still does what it does.
function dragging(r, b) {
  b.addEventListener('pointerdown', e => {
    if (r.mode !== 'idle' || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const d = r.dock.getBoundingClientRect();
    r.drag = {
      b,
      x: e.clientX,
      y: e.clientY,
      id: e.pointerId,
      moved: false,
      dx: e.clientX - d.left,
      dy: e.clientY - d.top,
    };
    b.setPointerCapture(e.pointerId); // (a quick drag leaves a small button before it has moved far enough to count)
  });
  b.addEventListener('pointermove', e => {
    const d = r.drag;
    if (!d || d.b !== b || e.pointerId !== d.id || (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 10))
      return;
    if (!d.moved) {
      d.moved = true;
      r.dock.classList.add('drag');
      uncoach(r);
      shut(r);
      r.tip.classList.remove('show');
    }
    // (within the host's box: the window, or HQ's page beside the book.)
    r.dock.style.setProperty('--dx', `${Math.min(r.host.clientWidth - 60, Math.max(0, e.clientX - d.dx))}px`);
    r.dock.style.setProperty('--dy', `${Math.min(innerHeight - 60, Math.max(0, e.clientY - d.dy))}px`);
  });
  const drop = e => {
    const d = r.drag;
    if (!d || d.b !== b) return;
    r.drag = null;
    if (!d.moved) return;
    r.dragged = e.type === 'pointerup';
    setTimeout(() => (r.dragged = false), 400); // no click after a drag
    const w = r.host.clientWidth,
      top = Math.min(innerHeight - 60, Math.max(0, e.clientY - d.dy)),
      left = Math.min(w - 60, Math.max(0, e.clientX - d.dx)) + 30 < w / 2;
    r.dock.classList.remove('drag');
    r.dock.classList.toggle('left', left);
    const up = Math.max(0, Math.min(r.dock.offsetTop - 16, r.dock.offsetTop - top));
    r.placed = { left, up };
    lift(r, up);
    keep(localStorage, PLACE, JSON.stringify(r.placed));
  };
  b.addEventListener('pointerup', drop);
  b.addEventListener('pointercancel', drop);
}

export function setupDock(r) {
  coach(r);
  settling(r);
  for (const b of [r.fab, r.more]) dragging(r, b);
  r.fab.onclick = () => {
    if (r.dragged) r.dragged = false;
    else toggle(r);
  };
}

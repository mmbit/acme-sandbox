// Review mode's pin: where it sits (out of the product's way, or where the board dragged it), its hints, the bubble
// that explains it on a reviewer's first pages, and when it shows.
import { ACCENT, PEN, keep, kept } from './base.js';
import { stopMic, toggle } from './acts.js';

// the pin's size in px, the dock's too
const SIZE = 52;
// the dock holds the pin and its hints: bottom right above the home bar, lifted clear of the page's own buttons (--up),
// or where the board dragged it
export const CSS = `
      /* (--side: how far from its side the board dropped it, kept on a narrower screen) */
      .dock { position: absolute; width: ${SIZE}px; height: ${SIZE}px; right: min(var(--side, max(18px, calc(env(safe-area-inset-right) + 8px))), calc(100% - ${SIZE}px)); bottom: max(18px, calc(env(safe-area-inset-bottom) + 10px));
        transform: translateY(calc(-1 * var(--up, 0px))); transition: transform .35s cubic-bezier(.3,1.4,.5,1), opacity .16s ease-out, visibility 0s; }
      .dock.left { right: auto; left: min(var(--side, max(18px, calc(env(safe-area-inset-left) + 8px))), calc(100% - ${SIZE}px)); }
      .dock.drag { left: var(--dx); top: var(--dy); right: auto; bottom: auto; transform: none; transition: none; }
      .dock[hidden] { display: none; }
      /* put away (HQ, unless its Settings turn it on; a preview, once a pen draws there), it shrinks into the corner
         and fades; summoned, it pops back, nothing else moving */
      .dock.away { opacity: 0; visibility: hidden; transform: translateY(calc(-1 * var(--up, 0px))) translate(10px, 14px) scale(.55);
        transition: transform .2s cubic-bezier(.5,0,.75,0), opacity .16s ease-in, visibility 0s .2s; }
      /* ...back while it says something (a mark the book didn't take: settle.js), so it's never told unseen */
      .dock.away:has(.tip.show) { opacity: 1; visibility: visible; transform: translateY(calc(-1 * var(--up, 0px))); }
      .fab { pointer-events: auto; position: absolute; inset: 0; touch-action: none;
        width: ${SIZE}px; height: ${SIZE}px; border-radius: 50%; background: ${ACCENT}; color: #fff; display: grid; place-items: center;
        box-shadow: 0 5px 0 #c23c44, 0 10px 21px rgba(43,34,48,.3); transition: transform .25s cubic-bezier(.3,1.6,.5,1), box-shadow .15s; animation: bob 3.2s ease-in-out infinite; }
      /* held and carried, the same button lifted a little: its face and its base stay one, never grown apart; a grab
         hand over it, a closed one while it's carried */
      .fab { cursor: grab; }
      .fab.on { cursor: pointer; }
      .dock.drag .fab { animation: none; transform: none; box-shadow: 0 5px 0 #c23c44, 0 14px 26px rgba(43,34,48,.36); }
      .dock.drag .fab { cursor: grabbing; }
      .fab svg { width: 24px; height: 24px; transition: transform .3s cubic-bezier(.3,1.6,.5,1); }
      .fab:active { transform: translateY(4px); box-shadow: 0 1px 0 #c23c44, 0 4px 10px rgba(43,34,48,.3); }
      .fab.on { animation: none; background: #2b2230; box-shadow: 0 5px 0 #000, 0 10px 21px rgba(43,34,48,.3); }
      .fab.on svg { transform: rotate(45deg) scale(.9); }
      .fab[hidden] { display: none; }
      /* hints go over the pin */
      .tip { position: absolute; right: 0; bottom: ${SIZE + 12}px; background: #2b2230; color: #fff; padding: 6px 12px; border-radius: 10px;
        font-size: 14px; white-space: nowrap; opacity: 0; transform: translateY(6px); transition: .25s; pointer-events: none; }
      .dock.left .tip { right: auto; left: 0; }
      .tip.show { opacity: 1; transform: none; }
      /* the first few pages a reviewer opens: a bubble that says what the pin is for, and a ring around the pin */
      /* (100cqw: .ui's width, base.js) */
      .coach { pointer-events: auto; position: absolute; right: -6px; bottom: ${SIZE + 20}px; width: max-content; max-width: min(260px, calc(100cqw - 32px)); background: #fff; color: #2b2230;
        border: 2px solid #2b2230; border-radius: 16px; padding: 12px 14px 8px; box-shadow: 0 4px 0 #2b2230, 0 14px 34px rgba(43,34,48,.3); font-size: 14px; line-height: 1.35;
        animation: pop-in .45s cubic-bezier(.3,1.5,.5,1) both; }
      .coach::after { content: ""; position: absolute; right: ${SIZE / 2 - 4}px; bottom: -9px; width: 14px; height: 14px; background: #fff; border: solid #2b2230; border-width: 0 2px 2px 0; transform: rotate(45deg); }
      .dock.left .coach { right: auto; left: -6px; } .dock.left .coach::after { right: auto; left: ${SIZE / 2 - 4}px; }
      .coach[hidden] { display: none; }
      .coach b { display: block; font-size: 16px; margin-bottom: 3px; }
      .coach button { display: block; margin: 4px 0 0 auto; padding: 6px 2px; font-weight: 700; color: #c23c44; }
      .dock.coaching .fab::after { content: ""; position: absolute; inset: -9px; border-radius: 50%; border: 3px solid ${ACCENT}; animation: ring 1.5s ease-out infinite; pointer-events: none; }
      @keyframes ring { from { transform: scale(.85); opacity: 1 } to { transform: scale(1.45); opacity: 0 } }
      @keyframes bob { 0%, 100% { transform: translateY(0) rotate(0) } 50% { transform: translateY(-3px) rotate(-4deg) } }`;

export const HTML = `<div class="dock"><div class="tip"></div>
        <div class="coach" hidden role="note"><b>Tap the red pin to leave a note</b>Then tap the bit you mean, and say or type what should change. In the way? Drag the pin.<button>Got it</button></div>
        <button class="fab" aria-label="Review mode: pin a note">${PEN}</button></div>`;

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
          if (said?.show && r.mode === 'idle' && !r.dock.classList.contains('drag')) {
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
// Out of the product's way: when one of its buttons or links sits under the pin, the pin steps up above it (as long as
// it stays in the lower 60% of the screen), and back down once the page moves on. Dragged, it stays put on this
// product: its side, how far from that side and its lift.
const PLACE = '__hq_review_pin',
  TAPPABLE = 'a[href], button, input, select, textarea, label, summary, [role=button], [role=link], [onclick]';
const lift = (r, up) => r.dock.style.setProperty('--up', `${Math.round(up)}px`);
// a dragged spot, as far as this screen allows: turned sideways or in a shorter frame it stops at the top, and the
// stored lift stays as it was, so a taller screen puts the pin back where the board left it
const liftPlaced = r => lift(r, Math.max(0, Math.min(r.placed.up, r.dock.offsetTop - 16)));
// the topmost of the page's tappable things under the pin, at the pin's top
function tappableUnder(r, x, top) {
  let hit = null;
  const across = [8, SIZE / 2, SIZE - 8],
    spots = across.flatMap(dx => across.map(dy => [dx, dy]));
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
    top = hit.top - SIZE - 10;
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
    if (r.placed.side != null) r.dock.style.setProperty('--side', `${r.placed.side}px`);
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
// where the pin is carried to, within the host's box (the window, or HQ's page beside the book), from 16 px under its
// top down to the pin's home
const spot = (r, d, e) => ({
  x: Math.min(r.host.clientWidth - SIZE, Math.max(0, e.clientX - d.dx)),
  y: Math.max(Math.min(16, d.home), Math.min(d.home, e.clientY - d.dy)),
});
// it lands where it was let go: anchored again at its side, its distance and its lift, all in one frame, nothing
// sliding there from the bottom or the side
function land(r, home, at) {
  const w = r.host.clientWidth,
    left = at.x + SIZE / 2 < w / 2;
  r.placed = { left, side: Math.round(left ? at.x : w - SIZE - at.x), up: home - at.y };
  r.dock.style.transition = 'none';
  r.dock.classList.remove('drag');
  r.dock.classList.toggle('left', left);
  r.dock.style.setProperty('--side', `${r.placed.side}px`);
  lift(r, r.placed.up);
  void r.dock.offsetTop; // (the landing laid out before its transition comes back)
  r.dock.style.transition = '';
  keep(localStorage, PLACE, JSON.stringify(r.placed));
}
// drag: press and move the pin, and let go anywhere it can rest. The pin follows the finger from where it was held, and
// stays where it's let go; a plain tap still does what it does.
function dragging(r) {
  const b = r.fab;
  b.addEventListener('pointerdown', e => {
    if (r.mode !== 'idle' || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const d = r.dock.getBoundingClientRect();
    r.drag = {
      x: e.clientX,
      y: e.clientY,
      id: e.pointerId,
      moved: false,
      dx: e.clientX - d.left,
      dy: e.clientY - d.top,
      home: r.dock.offsetTop, // (unlifted: the lift is a transform)
    };
    b.setPointerCapture(e.pointerId); // (a quick drag leaves the button before it has moved far enough to count)
  });
  b.addEventListener('pointermove', e => {
    const d = r.drag;
    if (!d || e.pointerId !== d.id || (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 10)) return;
    if (!d.moved) {
      d.moved = true;
      r.dock.classList.add('drag');
      uncoach(r);
      r.tip.classList.remove('show');
    }
    const at = (d.at = spot(r, d, e));
    r.dock.style.setProperty('--dx', `${at.x}px`);
    r.dock.style.setProperty('--dy', `${at.y}px`);
  });
  const drop = e => {
    const d = r.drag;
    if (!d) return;
    r.drag = null;
    if (!d.moved) return;
    r.dragged = e.type === 'pointerup';
    setTimeout(() => (r.dragged = false), 400); // no click after a drag
    land(r, d.home, d.at); // (where it was last carried: a cancelled pointer's own place says nothing)
  };
  b.addEventListener('pointerup', drop);
  b.addEventListener('pointercancel', drop);
}

// ---------------------------------------------------------------- when the pin shows
// Summoned or put away by the page ('review:summon': HQ's Settings › Pin on HQ, and a call puts it away). Away, the pin
// goes, and a marking the pin began stops; a note being written stays open. A page that doesn't summon it (a preview)
// shows it until a pen touches the page: the pen marks by itself there (surface.js), so from then on the pin stays away
// for the tab's session, the next page in HQ's viewer too.
const PENCIL = '__hq_review_pencil';
function summoning(r) {
  let penUsed = !r.summoned && kept(sessionStorage, PENCIL) === '1';
  const show = () => r.dock.classList.toggle('away', r.away || penUsed);
  addEventListener('review:summon', e => {
    r.away = !e.detail;
    show();
    if (r.away && r.mode === 'pick') toggle(r);
  });
  if (!r.summoned)
    addEventListener(
      'pointerdown',
      e => {
        if (e.pointerType !== 'pen' || penUsed) return;
        penUsed = true;
        keep(sessionStorage, PENCIL, '1');
        show();
      },
      true,
    );
  show();
}
// A page that frames another page with its own pin (HQ's viewer) hides this one meanwhile ('review:cover', detail true,
// then false). HQ's feature tip asks where the pin is ('review:pin'): the pin goes in the event's detail.
function covering(r) {
  addEventListener('review:cover', e => {
    r.covered = !!e.detail;
    if (r.covered) stopMic(r);
    r.host.style.display = r.covered ? 'none' : 'block';
  });
  if (r.covered) r.host.style.display = 'none'; // (covered while it loaded)
  // (away, there's no pin to show)
  if (r.summoned) addEventListener('review:pin', e => !r.covered && !r.away && !r.fab.hidden && (e.detail.pin = r.fab));
}

export function setupDock(r) {
  summoning(r);
  covering(r);
  coach(r);
  settling(r);
  dragging(r);
  r.fab.onclick = () => {
    if (r.dragged) r.dragged = false;
    else toggle(r);
  };
}

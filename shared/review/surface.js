// The page while the board marks it: tap an element, or draw on the page. The pen (ink.js): every line drawn stays
// until the note goes, open as drawn (circled, crossed out, underlined, scribbled), in the ink chosen on the strip, and
// the first mark opens the note. As the first mark a tap pins what's under it; Shift held as a mouse starts a line draws
// a rectangle. A pen drawn across the page starts all this by itself (a pen's tap stays the page's), and once a pen has
// drawn on a note only the pen draws: a palm resting on the screen doesn't, and a finger still scrolls and taps
// everything else.
import { ACCENT, PIN, button, keep, kept } from './base.js';
import * as inkjs from './ink.js';
import { uncoach } from './dock.js';
import { shut } from './menu.js';
import { showMark } from './change.js';
import { compose, develop } from './postit.js';
import { aim, boxOfLines } from './mark.js';
import { unpicture } from './pictures.js';
import { paint as paintMarks } from './marks.js';

const UNDO =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>';

export const CSS = `
      .veil { pointer-events: auto; position: absolute; inset: 0; touch-action: none; cursor: crosshair;
        box-shadow: inset 0 0 0 4px ${ACCENT}, inset 0 0 60px rgba(255,90,95,.25); background: rgba(255,246,216,.08); }
      .veil[hidden] { display: none; }
      /* over the page while the board marks it: what to do, and the inks */
      .bar { position: absolute; left: 50%; top: max(14px, env(safe-area-inset-top)); transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 12px; }
      .hint { background: #fff; border-radius: 999px; padding: 10px 18px;
        box-shadow: 0 4px 0 #2b2230, 0 10px 30px rgba(43,34,48,.25); border: 2px solid #2b2230; white-space: nowrap; font-weight: 600; font-size: 15px; display: flex; gap: 10px; align-items: center; }
      .veil.marked .hint { display: none; }
      /* the inks: little pots of paint on a strip of card, the one in hand lifted out of its well */
      .strip { display: flex; align-items: center; padding: 3px 4px; border-radius: 999px; cursor: default; touch-action: manipulation;
        background: linear-gradient(#fffdf6, #f1ead8); border: 2px solid #2b2230; box-shadow: 0 4px 0 #2b2230, 0 10px 30px rgba(43,34,48,.25), inset 0 1px 0 #fff; }
      .strip button { position: relative; width: 40px; height: 40px; display: grid; place-items: center; }
      .strip .pot i { width: 24px; height: 24px; border-radius: 50%; background: var(--c); transition: transform .2s cubic-bezier(.3,1.6,.5,1), box-shadow .2s;
        box-shadow: inset 0 2px 3px rgba(0,0,0,.28), inset 0 -1px 0 rgba(255,255,255,.35), 0 1px 0 #fff; }
      .strip .pot i::after { content: ""; position: absolute; width: 7px; height: 4px; margin: 5px 0 0 6px; border-radius: 50%; background: rgba(255,255,255,.55); opacity: 0; transition: opacity .2s; }
      .strip .pot.wide i { width: 26px; height: 15px; border-radius: 4px; opacity: .75; transform: rotate(-20deg); }   /* (the highlighter's chisel tip) */
      .strip .pot[aria-pressed="true"] i { transform: translateY(-3px) scale(1.12); box-shadow: 0 0 0 2px #fffdf6, 0 0 0 4px #2b2230, 0 5px 6px rgba(43,34,48,.35); }
      .strip .pot.wide[aria-pressed="true"] i { transform: translateY(-3px) rotate(-20deg) scale(1.12); }
      .strip .pot[aria-pressed="true"] i::after { opacity: 1; }
      .strip .sep { width: 2px; height: 24px; margin: 0 4px; border-radius: 1px; background: rgba(43,34,48,.18); }
      .strip .undo { color: #2b2230; } .strip .undo svg { width: 22px; height: 22px; } .strip .undo:disabled { opacity: .3; cursor: default; }
      .strip .undo:not(:disabled):active svg { transform: rotate(-40deg); transition: transform .1s; }
      .hint i { width: 20px; height: 20px; color: ${ACCENT}; animation: peck 1.2s ease-in-out infinite; } .hint i svg { width: 100%; height: 100%; }
      .hint small { font-weight: 400; color: #6d6275; }
      @keyframes peck { 0%, 100% { transform: translateY(0) } 40% { transform: translateY(4px) rotate(8deg) } }
      .hl { position: absolute; border: 2px dashed ${ACCENT}; border-radius: 6px; background: rgba(255,90,95,.08); transition: all .08s; pointer-events: none; }
      .hl[hidden] { display: none; }
      /* the live line's white edge, the strokes, the live line (ink.js) */
      .halo, .ink, .wet { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
      .drop { position: absolute; width: 34px; height: 34px; margin: -30px 0 0 -6px; color: ${ACCENT}; filter: drop-shadow(0 2px 0 #fff); animation: land .4s cubic-bezier(.3,1.6,.5,1); pointer-events: none; }
      @keyframes land { from { transform: translateY(-40px) scale(1.4); opacity: 0 } }`;

// (the ink and the outline sit outside the veil, so a mark shows while its note is changed; Redraw in the sheet)
export const HTML = `<div class="veil" hidden><div class="bar"><div class="hint"><i>${PIN}</i><span>Tap anything <small>or draw on it</small></span></div>
        <div class="strip" role="toolbar" aria-label="Inks"><span class="sep"></span><button class="undo" aria-label="Undo the last line" title="Undo" disabled>${UNDO}</button></div></div></div>
      <canvas class="halo" data-watchalong-hide></canvas>
      <canvas class="ink" data-watchalong-hide></canvas><canvas class="wet" data-watchalong-hide></canvas><div class="hl" hidden></div>`;

const MAX_LINES = 64; // a note's, as the coordinator keeps them (feedback.ts inkOf)
const INK_KEY = '__hq_review_ink';

// (shown: a walk-through's recording follows it) On HQ the page's numbered marks are drawn with them (marks.js).
export function paintInk(r, lines) {
  if (r.book) return paintMarks(r, lines);
  inkjs.draw(inkjs.fit(r.inkCanvas), lines, { halo: true });
  inkjs.shown(r.inkCanvas, lines, { halo: true });
}
export const redrawInk = r => (r.editing ? showMark(r) : paintInk(r, r.strokes));
export function pick(r) {
  r.undoTo = { mark: r.mark, shot: r.shot, exposure: r.exposure, editing: r.editing };
  r.mode = 'pick';
  r.strokes = [];
  r.veil.hidden = false;
  r.veil.classList.remove('marked');
  r.undoButton.disabled = true;
  r.fab.classList.add('on');
  r.more.hidden = true;
  paintInk(r, []);
  r.hl.hidden = true;
}
// what's under the finger, inside open shadow roots too: a tap in a chat's panel is the bubble or button there, not
// the chat's empty host element at the page's end
export function under(r, x, y) {
  let el =
    document.elementsFromPoint(x, y).find(e => e !== r.host && e !== document.documentElement && e !== document.body) ||
    document.body;
  for (let root; (root = el.shadowRoot);) {
    // the topmost of its own (ours is on top of everything)
    const inner = root.elementsFromPoint(x, y).find(e => e.getRootNode() === root);
    if (!inner) break;
    el = inner;
  }
  return el;
}
function stroked(r, stroke, e) {
  if (e.pointerType === 'pen') r.penSeen = true;
  const area = boxOfLines([stroke]);
  r.penOn.clear();
  if (area.w < 24 && area.h < 24) {
    // a tap: as the first mark, it pins the element under it; beside the note, nothing
    if (r.mode !== 'pick') return;
    r.mark = { kind: 'pin', x: e.clientX, y: e.clientY, el: under(r, e.clientX, e.clientY), area: null };
    const d = document.createElement('i');
    d.className = 'drop';
    d.innerHTML = PIN;
    Object.assign(d.style, { left: `${e.clientX}px`, top: `${e.clientY}px` });
    r.ui.append(d);
  } else if (r.strokes.length >= MAX_LINES) {
    // (beyond it, a change couldn't draw them all again)
    r.msg.textContent = `A note keeps ${MAX_LINES} lines at most: undo one to draw another.`;
    return;
  } else {
    r.strokes.push(stroke);
    if (r.mode === 'pick') r.mark = { kind: 'circle' };
    aim(r);
    // (dry at once as the wet goes, so the first line doesn't blink out until the note lands)
    paintInk(r, r.strokes);
  }
  r.undoButton.disabled = false;
  if (r.mode === 'pick') compose(r);
  else {
    redrawInk(r);
    develop(r);
  }
}
// Undo: the last line goes; the last mark gone, it's back to tapping or drawing, the words kept
export function undo(r) {
  if (r.mode !== 'note' || r.veil.hidden) return;
  if (r.strokes.length) {
    r.strokes.pop();
    if (r.strokes.length || r.mark.kind === 'pin') {
      aim(r);
      redrawInk(r);
      develop(r);
      return;
    }
  }
  if (r.framePic) unpicture(r, r.framePic);
  ({ mark: r.mark, shot: r.shot, exposure: r.exposure, editing: r.editing } = r.undoTo);
  r.framePic = null;
  r.root.querySelectorAll('.drop').forEach(d => d.remove());
  r.mode = 'pick';
  r.sheet.hidden = true;
  r.dock.hidden = false;
  r.veil.classList.remove('marked');
  r.undoButton.disabled = true;
  redrawInk(r);
  if (r.editing) paintInk(r, []);
}

// the inks on the strip, the one last chosen in hand
function inks(r) {
  r.inkNow = Math.min(Number(kept(localStorage, INK_KEY)) || 0, inkjs.INKS.length - 1);
  const choose = i => {
    r.inkNow = i;
    keep(localStorage, INK_KEY, String(i));
    r.strip.querySelectorAll('.pot').forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)));
  };
  r.strip.prepend(
    ...inkjs.INKS.map((k, i) => {
      const b = button('', `pot${k.alpha < 1 ? ' wide' : ''}`);
      b.setAttribute('aria-label', k.name);
      b.title = k.name;
      b.style.setProperty('--c', k.color);
      b.setAttribute('aria-pressed', String(i === r.inkNow));
      b.append(document.createElement('i'));
      b.onclick = () => choose(i);
      return b;
    }),
  );
}
// A pen on the page while review mode rests: its first move draws (the line from where it touched), and the page
// never scrolls under it. Its tap stays the page's own.
function penOnPage(r) {
  let penDown = null;
  addEventListener(
    'pointerdown',
    e => {
      const resting = r.mode === 'idle' && !r.covered && !r.fab.hidden && r.fab.isConnected && r.side.hidden;
      penDown = e.pointerType === 'pen' && e.isPrimary && resting && !e.composedPath().includes(r.host) ? e : null;
    },
    true,
  );
  addEventListener(
    'pointermove',
    e => {
      if (
        !penDown ||
        e.pointerId !== penDown.pointerId ||
        Math.hypot(e.clientX - penDown.clientX, e.clientY - penDown.clientY) < 4
      )
        return;
      const down = penDown;
      penDown = null;
      if (r.mode !== 'idle') return;
      uncoach(r);
      shut(r);
      pick(r);
      if (r.penOn.start(down)) {
        e.stopPropagation();
        r.penOn.move(e);
      }
    },
    true,
  );
  addEventListener('pointerup', e => penDown?.pointerId === e.pointerId && (penDown = null), true);
  // (Safari scrolls under a pen until its first touchmove says no)
  const marking = () => penDown || r.mode === 'pick' || r.mode === 'note';
  addEventListener(
    'touchmove',
    e => marking() && [...e.changedTouches].some(t => t.touchType === 'stylus') && e.preventDefault(),
    { capture: true, passive: false },
  );
}

export function setupSurface(r) {
  inks(r);
  const drawable = e =>
    (r.mode === 'pick' || (r.mode === 'note' && !r.veil.hidden)) &&
    !e.composedPath().includes(r.strip) &&
    (e.pointerType === 'pen' || !r.penSeen) &&
    !(e.pointerType === 'mouse' && e.button !== 0);
  const shape = e => (e.shiftKey && e.pointerType === 'mouse' ? 'rect' : '');
  r.penOn = inkjs.pen(r.veil, r.wet, {
    halo: true,
    under: r.haloCanvas,
    use: drawable,
    ink: () => inkjs.INKS[r.inkNow],
    shape,
    end: (s, e) => stroked(r, s, e),
  });
  if (!r.book) penOnPage(r); // (on HQ the Pencil draws without marking: pencil.js.)
  // a hover outline for a mouse, until the first mark
  r.veil.onpointermove = e => {
    if (e.pointerType !== 'mouse' || r.mode !== 'pick' || r.penOn.drawing) return;
    const b = under(r, e.clientX, e.clientY).getBoundingClientRect();
    Object.assign(r.hl.style, {
      left: `${b.left - 3}px`,
      top: `${b.top - 3}px`,
      width: `${b.width + 6}px`,
      height: `${b.height + 6}px`,
    });
    r.hl.hidden = false;
  };
  r.veil.addEventListener('pointerdown', () => (r.hl.hidden = true));
  // With lines on it, the page stays as it is under them (its screenshot was taken at the first mark)
  r.veil.addEventListener('wheel', e => r.mode !== 'pick' && e.preventDefault(), { passive: false });
  r.undoButton.onclick = () => undo(r);
}

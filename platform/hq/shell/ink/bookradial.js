// The radial menu: the strip's tools in a ring round the pen's tip, for a long press where this device's preferences
// want it (bookinput.js). Slide out to a tool and lift to take it, or lift where you are and tap one; a tap anywhere
// else, or Escape, closes it.
import { esc } from '../../util.js';
import { sfx } from '../audio.js';
import { word } from './bookscope.js';

// the ring's radius, how far out from the middle a slide picks, and the room kept round it at the screen's edges (px)
const RADIUS = 64,
  PICKS_PX = 26,
  EDGE = RADIUS + 28;

// down: the press held; tools: the strip's tools shown here, [{ mode, label, icon (its button's SVG) }]; mode: the
// one in use; use(mode): a tool taken
export function openRadial(down, { tools, mode, use }) {
  if (!tools.length) return null;
  // (the ring kept on the screen: its middle pulled in from the edges)
  const at = [
    Math.max(EDGE, Math.min(innerWidth - EDGE, down.clientX)),
    Math.max(EDGE, Math.min(innerHeight - EDGE, down.clientY)),
  ];
  const r = { at, down, sliding: true, over: null, use };
  Object.assign(
    r,
    ring(tools, mode, at, m => pick(r, m)),
  );
  sfx.tick();
  r.move = e => moved(r, e);
  r.up = e => lifted(r, e);
  // (the tap that closes it is only that: it draws nothing)
  r.away = e => {
    if (r.sliding || (e.type === 'keydown' ? e.key !== 'Escape' : r.el.contains(e.target))) return;
    if (e.type === 'pointerdown') e.stopPropagation();
    close(r);
  };
  addEventListener('pointermove', r.move, true);
  addEventListener('pointerup', r.up, true);
  addEventListener('pointercancel', r.up, true);
  addEventListener('pointerdown', r.away, true);
  addEventListener('keydown', r.away, true);
  return { close: () => close(r) };
}

// The ring: a button for each tool round the middle, the one in use ringed in ink
function ring(tools, mode, [x, y], pick) {
  const el = document.createElement('div');
  el.className = 'bk-radial';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', word('Tools'));
  Object.assign(el.style, { left: `${x}px`, top: `${y}px` });
  const step = (2 * Math.PI) / tools.length;
  const items = tools.map((t, i) => {
    const b = document.createElement('button'),
      a = -Math.PI / 2 + i * step;
    b.type = 'button';
    b.className = 'bk-btn';
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-label', t.label);
    b.setAttribute('aria-checked', String(t.mode === mode));
    b.innerHTML = `${t.icon}<span class="bk-radial-name">${esc(t.label)}</span>`;
    b.style.setProperty('--dx', `${Math.round(Math.cos(a) * RADIUS)}px`);
    b.style.setProperty('--dy', `${Math.round(Math.sin(a) * RADIUS)}px`);
    b.addEventListener('click', () => pick(t.mode));
    return { b, a, mode: t.mode };
  });
  el.append(...items.map(it => it.b));
  (document.getElementById('book') ?? document.body).append(el);
  return { el, items };
}

// The tool the pen points at, once it's out of the middle: the one whose angle is nearest
function aim(r, e) {
  const [x, y] = r.at;
  if (Math.hypot(e.clientX - x, e.clientY - y) < PICKS_PX) return null;
  const to = Math.atan2(e.clientY - y, e.clientX - x);
  let best = null,
    d = Infinity;
  for (const it of r.items) {
    const off = Math.abs(Math.atan2(Math.sin(to - it.a), Math.cos(to - it.a)));
    if (off < d) [best, d] = [it, off];
  }
  return best;
}
function moved(r, e) {
  if (!r.sliding || e.pointerId !== r.down.pointerId) return;
  const it = aim(r, e);
  if (it === r.over) return;
  r.over?.b.removeAttribute('data-sliding');
  r.over = it;
  r.over?.b.setAttribute('data-sliding', '');
}
// (lifted on a tool: taken; lifted in the middle: the ring stays for a tap)
function lifted(r, e) {
  if (!r.sliding || e.pointerId !== r.down.pointerId) return;
  r.sliding = false;
  if (e.type === 'pointerup' && r.over) pick(r, r.over.mode);
}
function pick(r, mode) {
  close(r);
  r.use(mode);
}
function close(r) {
  r.el.remove();
  removeEventListener('pointermove', r.move, true);
  removeEventListener('pointerup', r.up, true);
  removeEventListener('pointercancel', r.up, true);
  removeEventListener('pointerdown', r.away, true);
  removeEventListener('keydown', r.away, true);
}

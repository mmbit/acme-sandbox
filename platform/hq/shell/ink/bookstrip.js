// The tools' island on the right of the paper, roughly centred and short (bookui.js): the pen (the
// marker the same tool, by its card: bookpalette.js), shapes, the eraser, Select, Text and the mic (bookvoice.js). A
// tap picks a tool at once. A finger, a pen or the mouse pressed on the island and slid along it shows the tool under
// it and picks it on the lift. The tool in use pressed again opens its card (bookpalette.js). Ctrl held and the wheel
// over the page steps through the tools (bookpan.js asks cycle()).
//
// st: booktools.js's state (book, mode, buttons); setMode: bookpalette.js's.
import { stylesheet } from '../../util.js';
import { island, showTip, hide } from './bookui.js';
import { TOOLS } from './bookpalette.js';

// a press moved this far along the island (px) slides: less is a tap
const SLIDE_PX = 6;

export function mountStrip(st, setMode) {
  stylesheet('shell/ink/bookstrip.css');
  sliding(island('tools'), mode => setMode(st, mode));
  return {
    // One tool on along the island (by 1) or back (by −1), round from the last to the first; the pen and the marker one
    // stop, the one last used
    cycle(by) {
      const stops = TOOLS.map(t => t.mode).filter(m => m !== (st.ink === 'pen' ? 'highlighter' : 'pen')),
        i = stops.indexOf(st.mode === 'pen' || st.mode === 'highlighter' ? st.ink : st.mode);
      setMode(st, stops[(i + by + stops.length) % stops.length]);
      return true;
    },
  };
}

// A press on the island moved along it slides: the tool under it lit and named, the one it lifts on picked. A press that
// doesn't move is the button's own click (a tap, or the tool in use pressed again for its card). Only the tools are
// picked by a slide: lifted on the mic, nothing happens. (s: the slide under way, or null: { id, y, on, over })
function sliding(el, pick) {
  let s = null;
  el.addEventListener('pointerdown', e => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0) || !e.target.closest?.('.bk-btn')) return;
    s = { id: e.pointerId, y: e.clientY, on: false, over: null };
  });
  el.addEventListener('pointermove', e => {
    if (!s || e.pointerId !== s.id) return;
    if (!s.on && Math.abs(e.clientY - s.y) <= SLIDE_PX) return;
    if (!s.on) {
      s.on = true;
      el.dataset.sliding = '';
      try {
        el.setPointerCapture(s.id);
      } catch {
        /* lifted already */
      }
    }
    // (the tool level with the finger along the island, though it drifts off it to either side)
    const r = el.getBoundingClientRect(),
      y = Math.max(r.top + 1, Math.min(r.bottom - 1, e.clientY));
    over(document.elementFromPoint(r.left + r.width / 2, y)?.closest('.bk-btn[data-mode]'));
  });
  const over = b => {
    if (b === s.over) return;
    s.over?.removeAttribute('data-sliding');
    s.over = b && el.contains(b) ? b : null;
    if (s.over) {
      s.over.dataset.sliding = '';
      showTip(s.over);
    } else hide();
  };
  const lift = e => {
    if (!s || e.pointerId !== s.id) return;
    const was = s;
    s = null;
    if (!was.on) return;
    delete el.dataset.sliding;
    was.over?.removeAttribute('data-sliding');
    hide();
    // (the lift picks what's under it; the browser's own click after it, on wherever the press began, goes)
    noClick(el);
    if (e.type === 'pointerup' && was.over) pick(was.over.dataset.mode);
  };
  el.addEventListener('pointerup', lift);
  el.addEventListener('pointercancel', lift);
}
// (only the click that comes with the lift: a tap right after it is a tap. That click follows its pointerup at once, so
// 60 ms holds it and no tap is that quick; the page's arrows hold theirs longer, bookcontrols.js arrowKey().
function noClick(el) {
  const stop = c => {
    if (!c.isTrusted) return;
    c.stopPropagation();
    c.preventDefault();
    el.removeEventListener('click', stop, true);
  };
  el.addEventListener('click', stop, true);
  setTimeout(() => el.removeEventListener('click', stop, true), 60);
}

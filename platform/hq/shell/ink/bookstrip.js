// The tool strip down the page's right beside Undo's, on every device (the board's Controls): the tools (bookpalette.js), the tool in
// use named beside it, the zoom's − and +, and the cog for this device's preferences (bookprefs.js). A tool is a tap
// away, or a finger or a pen held on the strip slides along it, each tool's name showing under it, and lifts on the
// one it wants, level with the finger wherever it drifts across. Ctrl held and the wheel over the page steps through the
// tools (bookpan.js asks cycle()). The tool's name shows as it's picked and fades a moment after.
//
// st: booktools.js's state (book, mode, buttons); setMode: bookpalette.js's.
import { stylesheet } from '../../util.js';
import { button, island, showTip, hide, MOD, lineIcon } from './bookui.js';
import { mountPrefs } from './bookprefs.js';
import { zoomBy } from './bookview.js';
import { word } from './bookscope.js';

// a press on the strip slides once it has been held this long, or moved this far (px): less is a tap
const SLIDE_MS = 220,
  SLIDE_PX = 8;
// the tool's name fades this long after it's picked
const NAMED_MS = 1200;

const ICONS = {
  out: lineIcon('<path d="M6 12h12"/>'),
  in: lineIcon('<path d="M6 12h12M12 6v12"/>'),
  cog: lineIcon(
    '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/><circle cx="12" cy="12" r="6.4"/>',
  ),
};

export function mountStrip(st, setMode) {
  stylesheet('shell/ink/bookstrip.css');
  const el = island('tools'),
    strip = el.parentElement;
  const zoom = k => zoomed(st.book, k);
  const out = button({ icon: ICONS.out, label: word('Zoom out'), keys: `${MOD}−`, onClick: () => zoom(0.8) }),
    inn = button({ icon: ICONS.in, label: word('Zoom in'), keys: `${MOD}+`, onClick: () => zoom(1.25) }),
    cog = button({ icon: ICONS.cog, label: word('Preferences on this device') });
  cog.classList.add('bk-cog');
  el.append(document.createElement('hr'), out, inn, cog);
  mountPrefs(cog);
  named(st, el, strip);
  sliding(el);
  return {
    // One tool on through the strip (by 1) or back (by −1), round from the last to the first; a tool not shown on
    // this screen passed over
    cycle(by) {
      const shown = Object.entries(st.buttons).filter(([, b]) => b.offsetParent),
        i = shown.findIndex(([mode]) => mode === st.mode);
      if (!shown.length) return false;
      setMode(st, shown[(i + by + shown.length) % shown.length][0]);
      return true;
    },
  };
}

// The zoom a step in or out, as the controls' keys take it (bookpages.js): out past the page's whole width, the
// overview; in from the overview, a step of it
function zoomed(book, k) {
  if (book.far()) return k > 1 ? book.zoom.in() : book.zoom.out();
  if (!zoomBy(book, k)) book.zoom.out();
}

// The tool in use named beside its button, on the paper's side: a quiet slip that follows the tool, fades a moment
// after it's picked, and steps aside while a tooltip shows (bookstrip.css)
function named(st, el, strip) {
  const now = document.createElement('div');
  now.className = 'bk-now';
  now.setAttribute('aria-hidden', 'true');
  strip.append(now);
  let picked = null,
    fade = 0;
  const place = () => {
    if (st.mode !== picked) {
      picked = st.mode;
      now.classList.remove('bk-faded');
      clearTimeout(fade);
      fade = setTimeout(() => now.classList.add('bk-faded'), NAMED_MS);
    }
    const b = st.buttons[st.mode];
    now.textContent = b?.getAttribute('aria-label') ?? '';
    const s = strip.getBoundingClientRect(),
      r = b?.getBoundingClientRect(),
      seen = el.getBoundingClientRect();
    // (a tool scrolled out of a short screen's strip has no name beside it)
    now.hidden = !b?.offsetParent || r.top + r.height / 2 < seen.top || r.top + r.height / 2 > seen.bottom;
    if (now.hidden) return;
    now.style.top = `${Math.round(r.top + r.height / 2 - s.top)}px`;
  };
  new MutationObserver(place).observe(el, {
    attributes: true,
    subtree: true,
    attributeFilter: ['aria-pressed', 'aria-label'],
  });
  el.addEventListener('scroll', place, { passive: true });
  // (and whether its tools are taller than its room, so it scrolls: bookstrip.css)
  const widths = () => {
    el.toggleAttribute('data-scrolls', el.scrollHeight > strip.clientHeight);
    place();
  };
  const resized = new ResizeObserver(widths);
  resized.observe(el);
  resized.observe(strip);
  widths();
}

// A finger or a pen held on the strip, or moved along it, slides: each tool's name shows as it passes under, and the
// one it lifts on is picked, as a tap on it is. A quick tap is the button's own click. A strip that scrolls (a short
// screen's) slides only on a hold: a move scrolls it. (s: the slide under way, or null: { id, at, from, over, on,
// timer })
function sliding(el) {
  const sl = { el, s: null };
  el.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' || !e.isPrimary) return;
    const from = e.target.closest?.('.bk-btn');
    if (!from) return;
    const s = (sl.s = { id: e.pointerId, at: [e.clientX, e.clientY], from, over: null, on: false });
    s.timer = setTimeout(() => sl.s === s && slide(sl), SLIDE_MS);
  });
  el.addEventListener('pointermove', e => {
    const s = sl.s;
    if (!s || e.pointerId !== s.id) return;
    const moved = Math.hypot(e.clientX - s.at[0], e.clientY - s.at[1]) > SLIDE_PX;
    if (!s.on && moved && el.hasAttribute('data-scrolls')) {
      clearTimeout(s.timer);
      sl.s = null;
      return;
    }
    if (!s.on && moved) slide(sl);
    // (the tool level with the finger, though it drifts off the strip sideways)
    const across = el.getBoundingClientRect();
    if (s.on) overTool(sl, document.elementFromPoint(across.left + across.width / 2, e.clientY)?.closest('.bk-btn'));
  });
  el.addEventListener('pointerup', e => slid(sl, e));
  el.addEventListener('pointercancel', e => slid(sl, e));
  // (a slide never scrolls the page or selects)
  el.addEventListener('touchmove', e => sl.s?.on && e.preventDefault(), { passive: false });
}
function slide(sl) {
  const { el, s } = sl;
  clearTimeout(s.timer);
  if (s.on) return;
  s.on = true;
  el.dataset.sliding = '';
  try {
    el.setPointerCapture(s.id);
  } catch {
    /* lifted already */
  }
  overTool(sl, s.from);
}
// The tool under the slide: lit, its name shown
function overTool(sl, b) {
  const { el, s } = sl;
  if (b === s.over) return;
  s.over?.removeAttribute('data-sliding');
  s.over = b && el.contains(b) && !b.disabled ? b : null;
  if (s.over) {
    s.over.dataset.sliding = '';
    showTip(s.over);
  } else hide();
}
function slid(sl, e) {
  const { el, s } = sl;
  if (!s || e.pointerId !== s.id) return;
  sl.s = null;
  clearTimeout(s.timer);
  if (!s.on) return;
  delete el.dataset.sliding;
  s.over?.removeAttribute('data-sliding');
  hide();
  // (the lift picks what's under it; the browser's own click after it, on wherever the press began, goes)
  noClick(el);
  if (e.type === 'pointerup' && s.over) s.over.click();
}
// (only the click that comes with the lift: a tap right after it is a tap)
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

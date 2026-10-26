// Review mode's trail: the last few things the reviewer did on the product (clicks, scrolls and route changes), which go
// with each note. Kept in sessionStorage so it survives page loads within the tab; the last 50 go with each note.
import { selector } from './anchor.js';

const TRAIL_KEY = '__hq_review_trail';

export const here = () => location.pathname + location.search + location.hash;

// r.trail: the list; r.host: review mode's own element, whose taps nothing logs
export function startTrail(r) {
  r.trail = (() => {
    try {
      return JSON.parse(sessionStorage.getItem(TRAIL_KEY)) || [];
    } catch {
      return [];
    }
  })();
  const log = (type, extra) => {
    r.trail.push({ t: Date.now(), type, url: here(), ...extra });
    r.trail.splice(0, r.trail.length - 50);
    try {
      sessionStorage.setItem(TRAIL_KEY, JSON.stringify(r.trail));
    } catch {
      /* private mode: memory only */
    }
  };
  log('load');
  addEventListener(
    'click',
    e => {
      if (r.host && e.composedPath().includes(r.host)) return;
      const target = e.target instanceof Element ? selector(e.target) : '';
      log('click', { target, x: Math.round(e.clientX), y: Math.round(e.clientY) });
    },
    true,
  );
  let scrolled;
  addEventListener(
    'scroll',
    () => {
      clearTimeout(scrolled);
      scrolled = setTimeout(() => log('scroll', { y: Math.round(scrollY) }), 500);
    },
    { passive: true },
  );
  const push = history.pushState;
  history.pushState = function (...a) {
    const pushed = push.apply(this, a);
    log('route');
    return pushed;
  };
  addEventListener('popstate', () => log('route'));
  addEventListener('hashchange', () => log('route'));
}

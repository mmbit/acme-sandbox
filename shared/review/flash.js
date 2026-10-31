// A thing on the page flashed once where an agent's ask points at it (drive.js's flash, from HQ's book): a glow in the
// colour given, over it like a highlighter, fading in about a second. With reduced motion, a still outline that goes
// after a while. Over the page and never kept.

const FADE_MS = 1200,
  STILL_MS = 2500,
  PAD = 6;

export function flash(el, color) {
  const box = el.getBoundingClientRect(),
    still = matchMedia('(prefers-reduced-motion: reduce)').matches,
    glow = document.createElement('div');
  glow.setAttribute('aria-hidden', 'true');
  glow.setAttribute('data-watchalong-hide', ''); // (HQ's own: never recorded)
  glow.dataset.flash = still ? 'still' : 'glow';
  Object.assign(glow.style, {
    position: 'fixed',
    left: `${box.left - PAD}px`,
    top: `${box.top - PAD}px`,
    width: `${box.width + 2 * PAD}px`,
    height: `${box.height + 2 * PAD}px`,
    borderRadius: `${PAD + 4}px`,
    zIndex: '2147483646',
    pointerEvents: 'none',
    boxSizing: 'border-box',
    border: `3px solid ${color}`,
    ...(!still && {
      background: color,
      mixBlendMode: 'multiply',
      boxShadow: `0 0 0 4px ${color}, 0 0 28px 10px ${color}`,
    }),
  });
  document.body.append(glow);
  if (still) return setTimeout(() => glow.remove(), STILL_MS);
  glow
    .animate([{ opacity: 0 }, { opacity: 0.9, offset: 0.12 }, { opacity: 0.9, offset: 0.3 }, { opacity: 0 }], {
      duration: FADE_MS,
      easing: 'ease-out',
    })
    .finished.then(() => glow.remove());
}

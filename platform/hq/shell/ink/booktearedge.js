// The page's perforation along its spine (booktear.js; README, The book's frame, The tear): a faint line of punched
// slits a little in from the spine, along the stretch of it a hand takes the page by, and the strip beyond it lifting
// a little as it's drawn away. Nothing shows till a hand comes: while a press there holds, while the Pencil or the
// mouse hovers over it, and for a moment as the dots' Tear off and send is picked, to show where the page tears off.
// It takes no press, so nothing about it is ever in the way of drawing (bookshare.css .bk-perf).

// how long it shows as the dots' Tear off and send is picked, and how far in from the spine it's punched (px)
const FLASH_MS = 1600,
  IN_PX = 14;

// leaf: the book's (.bk-leaf), which it lies on, under the controls. → { show(grip, why), give(k) }
export function mountEdge(leaf) {
  const el = Object.assign(document.createElement('div'), { className: 'bk-perf' });
  el.setAttribute('aria-hidden', 'true');
  leaf.append(el);
  let timer = 0;
  return {
    // Shown along grip ({ right, top, bottom } on the screen: booktear.js grip()), or put away (null). why: 'hover'
    // (fainter), 'press', or 'flash' (put away by itself); a hover never puts away what a press or a flash shows
    show(grip, why = 'press') {
      if (why === 'hover' && ['press', 'flash'].includes(el.dataset.shown)) return;
      if (!grip && !el.dataset.shown) return;
      clearTimeout(timer);
      if (!grip) {
        delete el.dataset.shown;
        el.style.setProperty('--give', 0);
        return;
      }
      const at = leaf.getBoundingClientRect();
      Object.assign(el.style, {
        left: `${grip.right - IN_PX - at.left}px`,
        width: `${IN_PX}px`,
        top: `${grip.top - at.top}px`,
        height: `${grip.bottom - grip.top}px`,
      });
      el.dataset.shown = why;
      if (why === 'flash') timer = setTimeout(() => delete el.dataset.shown, FLASH_MS);
    },
    // The strip beyond it lifting as a press there is drawn away, k from 0 to 1 (then the page comes off)
    give(k) {
      el.style.setProperty('--give', Math.max(0, Math.min(1, k)).toFixed(2));
    },
  };
}

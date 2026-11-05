// An agent's steps, its job's log (data.js loadJobLog), as the agent's big key on HQ home shows them (Wire's scene.js)
// and a task's card turned over (jobsheet.js): oldest first, each on a line that a tap opens, the newest in full, each
// with its time. One drawing for both, styled once (style.css .steplog).
import { esc } from '../util.js';

// a line's key: what keeps it open across a redraw
export const stepKey = l => `${l.ts}|${l.text}`;
// lines: the steps ({ ts, text, agent }); open: the keys of those opened; time(ts): its time in words; text(l): its
// words as markup (escaped, by default)
export function stepLines(lines, { open = new Set(), time, text = l => esc(l.text) }) {
  return lines
    .map(
      l =>
        `<li data-k="${esc(stepKey(l))}"${open.has(stepKey(l)) ? ' class="open"' : ''}><span>${text(l)}</span><time>${esc(time(l.ts))}</time></li>`,
    )
    .join('');
}
// Redraw what scroller holds (redraw(read)) with the line read where it stood on screen: the first keyed line (data-k)
// in view, its foot below the scroller's top, in a list that starts at or above that top. Above a list's start, what's
// read is what's above it, which a line coming in below doesn't move: nothing is kept. read: that line before the
// redraw, if there was one.
export function keepRead(scroller, redraw) {
  const box = scroller.getBoundingClientRect(),
    read = [...scroller.querySelectorAll('li[data-k]')].find(li => {
      const r = li.getBoundingClientRect();
      return r.bottom > box.top && r.top < box.bottom && li.parentElement.getBoundingClientRect().top <= box.top;
    }),
    at = read?.getBoundingClientRect().top;
  redraw(read);
  const again = read && [...scroller.querySelectorAll('li[data-k]')].find(li => li.dataset.k === read.dataset.k);
  if (again) scroller.scrollTop += again.getBoundingClientRect().top - at;
}
// Fill ol with lines, unless it holds them already: opened lines stay open, and it stays at its bottom (the newest) as
// lines come in, unless it was scrolled up to read: then the line read stays where it is, and none drops off above it.
// first: it's filled for the first time, so it goes to its bottom. last: at most that many of the newest, at its
// bottom.
export function fillSteps(ol, lines, { time, text, empty, first = false, last = Infinity }) {
  const shown = [...ol.children],
    bottom = first || ol.scrollHeight - ol.scrollTop - ol.clientHeight < 24,
    from = bottom ? -1 : lines.findIndex(l => stepKey(l) === shown[0]?.dataset.k);
  lines = lines.slice(from < 0 ? Math.max(0, lines.length - last) : from);
  const keys = lines.map(stepKey);
  if (shown.map(li => li.dataset.k).join('\n') === keys.join('\n')) return;
  const draw = read => {
    const open = new Set([...ol.querySelectorAll('li.open')].map(li => li.dataset.k));
    if (read && read === shown.at(-1)) open.add(read.dataset.k); // (the newest, in full, read: it stays in full)
    ol.innerHTML = lines.length ? stepLines(lines, { open, time, text }) : `<li class="aside">${esc(empty)}</li>`;
  };
  if (!bottom) return keepRead(ol, draw);
  draw();
  ol.scrollTop = ol.scrollHeight;
}

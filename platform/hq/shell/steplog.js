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
// Fill ol with lines, unless it holds them already: opened lines stay open, and it stays at its bottom (the newest) as
// lines come in, unless it was scrolled up to read. first: it's filled for the first time, so it goes to its bottom.
export function fillSteps(ol, lines, { time, text, empty, first = false }) {
  const keys = lines.map(stepKey);
  if ([...ol.children].map(li => li.dataset.k).join('\n') === keys.join('\n')) return;
  const bottom = first || ol.scrollHeight - ol.scrollTop - ol.clientHeight < 24,
    open = new Set([...ol.querySelectorAll('li.open')].map(li => li.dataset.k));
  ol.innerHTML = lines.length ? stepLines(lines, { open, time, text }) : `<li class="aside">${esc(empty)}</li>`;
  if (bottom) ol.scrollTop = ol.scrollHeight;
}

// Statistics in plain SVG and the motion that brings them in: a figure's last days as bars, a few measures over time
// as lines on one graph, figures that roll like a slot machine's and bars that grow back up from their baseline. HQ's
// Slate look drew these first. Nothing here has a colour or a sound: the page's CSS colours the marks by their classes
// and plays its own sound when a count is done.
import { reducedMotion } from '../tactile/motion.js';

// Of its slot a bar fills, the rest air between bars
export const BAR_SHARE = 0.68;
// The least a bar stands, so a day of nothing (or not counted yet) still shows where it is
export const BAR_MIN_PX = 2;
export const BAR_ROUND_PX = 1.5;
// A bar growing back up, each this long after the one to its left
export const GROW_MS = 420;
export const GROW_STAGGER_MS = 30;
const GROW_EASE = 'cubic-bezier(.2, .9, .3, 1.3)'; // (a little past, and back)
// A figure rolling, its digits stopping one at a time, left to right, in this long
export const COUNT_MS = 900;
// The dot a line ends on, now
export const DOT_RADIUS_PX = 4;

// Words safe in SVG or HTML text and a double-quoted attribute
export const escape = text =>
  String(text).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

// bars(values, { width, height, tips, stubs, scale }): a bar per value, the last (now) with class now, one not counted
// yet (null) a stub with class none, so every row runs the whole width (stubs: false leaves it out). tips: what each bar
// is, shown on hover. scale: the top of a fixed scale (100 for percentages), else the highest value.
// → an <svg class="bars"> drawn to its box
export function bars(values, { width = 140, height = 24, tips = [], stubs = true, scale } = {}) {
  if (!values?.length) return '';
  const counted = values.filter(value => value !== null && value !== undefined),
    top = scale ?? Math.max(1, ...counted),
    slot = width / values.length;
  const bar = (value, index) => {
    const none = value === null || value === undefined;
    if (none && !stubs) return '';
    const tall = none ? BAR_MIN_PX : Math.max(BAR_MIN_PX, (value / top) * height),
      kind = none ? ' class="none"' : index === values.length - 1 ? ' class="now"' : '',
      tip = tips[index] ? `<title>${escape(tips[index])}</title>` : '';
    return `<rect x="${(index * slot + (slot * (1 - BAR_SHARE)) / 2).toFixed(1)}" y="${(height - tall).toFixed(1)}" width="${(slot * BAR_SHARE).toFixed(1)}" height="${tall.toFixed(1)}" rx="${BAR_ROUND_PX}"${kind}>${tip}</rect>`;
  };
  return `<svg class="bars" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"${tips.length ? '' : ' aria-hidden="true"'}>${values.map(bar).join('')}</svg>`;
}

// lineGraph(series, { scale }): each series ({ name, values }, the last value now) a line across one graph, ending on a
// dot, in a <g> named by its class (series.name). Its points are percentages of the graph's own box, never a stretched
// viewBox, which thickens a line unevenly (Safari, whatever vector-effect says); the page's CSS keeps the box clear of
// the graph's edges, so a line at 0 reads as a line, not as the graph's border. A series of one value draws nothing.
// → an <svg class="lines">
export function lineGraph(series, { scale = 100 } = {}) {
  const shown = series.filter(({ values }) => values?.length > 1);
  if (!shown.length) return '';
  const point = (value, index, all) =>
    [(index / (all.length - 1)) * 100, 100 - (Math.min(scale, Math.max(0, value)) / scale) * 100].map(
      n => `${n.toFixed(2)}%`,
    );
  const line = ({ name, values }) => {
    const points = values.map(point),
      [x, y] = points.at(-1);
    return `<g class="${escape(name)}">${points
      .slice(1)
      .map(([x2, y2], index) => `<line x1="${points[index][0]}" y1="${points[index][1]}" x2="${x2}" y2="${y2}"/>`)
      .join('')}<circle cx="${x}" cy="${y}" r="${DOT_RADIUS_PX}"/></g>`;
  };
  return `<svg class="lines" aria-hidden="true">${shown.map(line).join('')}</svg>`;
}

// A count made short for a small place: 940, 1.2k, 12k
export const compact = n => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

// growBars(within): every bar in it grows back up from its baseline, each a moment after the one to its left
export function growBars(within) {
  if (reducedMotion()) return;
  for (const svg of within.querySelectorAll('svg.bars'))
    svg.querySelectorAll('rect').forEach((rect, index) => {
      rect.style.transformBox = 'fill-box';
      rect.style.transformOrigin = '50% 100%';
      rect.animate([{ transform: 'scaleY(0)' }, { transform: 'none' }], {
        duration: GROW_MS,
        delay: index * GROW_STAGGER_MS,
        easing: GROW_EASE,
        fill: 'backwards',
      });
    });
}

const rolling = new WeakMap(); // figure → its roll now ({ text: the number it stops on })
// rollFigures(figures, { onDone }): each figure's digits spin and stop one at a time, left to right, its other
// characters (a comma, a k) standing still; onDone as the last digit stops (at once with reduced motion). A figure
// pressed again mid-roll starts over from its real number, and the roll it left ends without its onDone.
export function rollFigures(figures, { onDone = () => {} } = {}) {
  if (reducedMotion()) return onDone();
  const start = performance.now(),
    all = [...figures].map(figure => {
      const roll = { text: rolling.get(figure)?.text ?? figure.textContent };
      rolling.set(figure, roll);
      return [figure, roll];
    });
  const step = now => {
    const done = Math.min(1, (now - start) / COUNT_MS),
      mine = all.filter(([figure, roll]) => rolling.get(figure) === roll);
    if (!mine.length) return;
    for (const [figure, { text }] of mine) {
      let index = 0;
      figure.textContent = text.replace(/\d/g, digit =>
        ++index / (text.length + 1) < done ? digit : String(Math.floor(Math.random() * 10)),
      );
    }
    if (done < 1) return requestAnimationFrame(step);
    for (const [figure] of mine) rolling.delete(figure);
    onDone();
  };
  requestAnimationFrame(step);
}

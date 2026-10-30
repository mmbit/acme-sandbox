// A chart from data as an SVG in the notebook's line look, for an agent's answer on a scrap: a line or a bar chart, its
// title and unit over it. Where its numbers came from goes under it as the answer's source line (hq answer --source,
// which the book shows under the picture), so a chart with no source isn't drawn.
// { kind: 'line' | 'bar', title, unit, series: [[label, value], ...], source }

import { escape } from '../stats/stats.js';

// A scrap answer's width (the book's answer column) and the chart's height there, in CSS px
export const WIDTH = 400,
  HEIGHT = 230;
const RINGS_MAX = 24;
// The least room a bar or a line's point takes along the plot, in CSS px: a bar's two ink outlines and a gap, a line's
// points a pixel apart
const STEP_MIN = { bar: 3 * 2.5, line: 1 };
// A character's width at most, in ems: the font's widest common letters in bold, so a title that passes fits
const CHAR_EM = 0.62;
// One ink at one weight, a half weight for the guides, the paper bare and the dots for shade (shared/craft/line-art.md)
const LOOK = { paper: '#fffdf8', ink: '#1d1b17', muted: '#6b6459', line: 2.5, half: 1.25 };
const FONT = "'Atkinson Hyperlegible', 'Inter', system-ui, sans-serif";
// The plot's box inside the picture: room for the title over it, the labels left and under it, and right of it, a line's
// last number
const EDGE = 14,
  PLOT = { left: 50, right: WIDTH - 30, top: 52, bottom: HEIGHT - 32 };

export function chartSvg(spec) {
  const chart = checked(spec);
  const { values, top, floor } = scaleOf(chart.series.map(([, value]) => value));
  const lastWidth = chart.kind === 'line' ? 12 + numberOf(values[values.length - 1]).length * 9 : 0;
  const plot = { ...PLOT, right: Math.min(PLOT.right, WIDTH - 8 - lastWidth) };
  const y = v => plot.bottom - ((v - floor) / (top - floor)) * (plot.bottom - plot.top);
  const step = (plot.right - plot.left) / (chart.kind === 'bar' ? values.length : Math.max(1, values.length - 1));
  if (step < STEP_MIN[chart.kind])
    throw new Error(`series: ${values.length} ${chart.kind === 'bar' ? 'bars' : 'points'} don't fit ${WIDTH} px: \
at most ${Math.floor((plot.right - plot.left) / STEP_MIN[chart.kind])}`);
  const x = i => plot.left + (chart.kind === 'bar' ? (i + 0.5) * step : i * step);
  const marks = chart.kind === 'bar' ? barsOf(values, x, y, step, floor) : lineOf(values, x, y, floor);
  const labels = chart.series.map(([label], i) => [label, i]).filter((_, i) => shown(i, values.length));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" \
font-family="${FONT}">
<defs><pattern id="dots" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="0.9" \
fill="${LOOK.ink}" opacity=".55"/></pattern></defs>
<rect width="${WIDTH}" height="${HEIGHT}" fill="${LOOK.paper}"/>
${text(EDGE, 26, chart.title, { size: 15, weight: 700 })}
${text(WIDTH - EDGE, 26, chart.unit, { size: 12, anchor: 'end', fill: LOOK.muted })}
${[floor, (floor + top) / 2, top].map(v => guide(plot, y(v), v)).join('\n')}
${marks}
${labels.map(([label, i]) => text(x(i), plot.bottom + 18, label, { size: 11, anchor: 'middle', fill: LOOK.muted })).join('')}
</svg>`;
}

// The chart asked for, or an error that says what's missing: a source first of all
function checked(spec) {
  const line = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  const source = line(spec?.source);
  if (!source) throw new Error('a chart says where its numbers came from: source, one line');
  if (!['line', 'bar'].includes(spec.kind)) throw new Error("kind: 'line' or 'bar'");
  const title = line(spec.title);
  if (!title) throw new Error('title: what the chart shows, one line');
  const unit = line(spec.unit);
  // (the title in bold at 15 px and the unit at 12 on one line over the plot, a gap between them)
  const room = WIDTH - 2 * EDGE - 12;
  if ((title.length * 15 + unit.length * 12) * CHAR_EM > room)
    throw new Error(`title and unit: too long for one line over the chart (${room} px at 15 and 12 px type)`);
  const series = spec.series;
  const pairs =
    Array.isArray(series) &&
    series.every(p => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && Number.isFinite(p[1]));
  if (!pairs || series.length < (spec.kind === 'line' ? 2 : 1))
    throw new Error(`series: [[label, number], ...], at least ${spec.kind === 'line' ? 2 : 1} of them`);
  return { kind: spec.kind, title, unit, source, series };
}

// The values and the scale's top and floor: round numbers round them, 0 in it
function scaleOf(values) {
  const most = Math.max(0, ...values),
    least = Math.min(0, ...values);
  const span = most - least || 1;
  const unit = 10 ** Math.floor(Math.log10(span));
  const round = [1, 2, 2.5, 5, 10].map(k => k * unit).find(k => span / k <= 4) ?? 10 * unit;
  const top = most > 0 ? Math.ceil(most / round) * round : 0;
  const floor = least < 0 ? Math.floor(least / round) * round : 0;
  return { values, top: top === floor ? floor + round : top, floor };
}

// A dashed guide across the plot at a value, its number left of it; the zero line solid, in ink
function guide(plot, at, value) {
  const zero = value === 0;
  const stroke = zero ? `stroke="${LOOK.ink}" stroke-width="${LOOK.line}"` : dashed();
  return `<line x1="${plot.left}" y1="${at}" x2="${plot.right + 8}" y2="${at}" ${stroke} stroke-linecap="round"/>\
${text(plot.left - 8, at + 4, numberOf(value), { size: 11, anchor: 'end', fill: LOOK.muted })}`;
}
const dashed = () => `stroke="${LOOK.muted}" stroke-width="${LOOK.half}" stroke-dasharray="3 4" opacity=".7"`;

// A line through the values, dots shading under it, each point a ring (up to RINGS_MAX) and the last one's number
// beside it
function lineOf(values, x, y, floor) {
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const last = values.length - 1;
  const under = `M${x(0)},${y(floor)} L${points.join(' L')} L${x(last)},${y(floor)} Z`;
  return `<path d="${under}" fill="url(#dots)" opacity=".5"/>
<polyline points="${points.join(' ')}" fill="none" stroke="${LOOK.ink}" stroke-width="${LOOK.line}" \
stroke-linejoin="round" stroke-linecap="round"/>
${values.length <= RINGS_MAX ? values.map((v, i) => ring(x(i), y(v))).join('') : ''}
${text(x(last) + 8, y(values[last]) - 8, numberOf(values[last]), { size: 14, weight: 700 })}`;
}
const ring = (cx, cy) =>
  `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3.5" fill="${LOOK.paper}" stroke="${LOOK.ink}" \
stroke-width="${LOOK.half * 1.4}"/>`;

// A bar per value in ink outline, dots for its body, its number over it
function barsOf(values, x, y, step, floor) {
  const w = Math.min(36, step * 0.62);
  return values
    .map((v, i) => {
      const from = y(Math.max(v, 0, floor)),
        to = y(Math.min(v, 0));
      const box = `x="${(x(i) - w / 2).toFixed(1)}" y="${from.toFixed(1)}" width="${w.toFixed(1)}" \
height="${Math.max(0, to - from).toFixed(1)}"`;
      const label = values.length <= 16 ? text(x(i), from - 6, numberOf(v), { size: 11, anchor: 'middle' }) : '';
      return `<rect ${box} fill="${LOOK.paper}"/><rect ${box} fill="url(#dots)"/><rect ${box} fill="none" stroke="${LOOK.ink}" stroke-width="${LOOK.line}" \
stroke-linejoin="round"/>${label}`;
    })
    .join('\n');
}

// Whether the i-th of n labels shows: all of a dozen, else every so many and the last
const shown = (i, n) => n <= 12 || i === n - 1 || (i % Math.ceil(n / 8) === 0 && n - 1 - i >= Math.ceil(n / 16));
const numberOf = v => new Intl.NumberFormat('en', { maximumFractionDigits: Math.abs(v) < 10 ? 1 : 0 }).format(v);
function text(x, y, words, { size, weight = 400, anchor = 'start', fill = LOOK.ink }) {
  if (!words) return '';
  return `<text x="${typeof x === 'number' ? x.toFixed(1) : x}" y="${y.toFixed(1)}" font-size="${size}" \
font-weight="${weight}" text-anchor="${anchor}" fill="${fill}">${escape(words)}</text>`;
}

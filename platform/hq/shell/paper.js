// What Numbers' printouts are made of: figures, charts, cards and tiles
import { esc, hash, gridArt } from '../util.js';
import { icon } from './icons.js';
import { names } from './brand.js';
import { companyFormats, dayTime } from '../world/clock.js';

const digits = dec => ({ minimumFractionDigits: dec, maximumFractionDigits: dec });
export const number = (n, dec = 0) => companyFormats().number(Number(n), 'en', digits(dec));
export const count = n => number(Math.round(n ?? 0));
const unsignedEuros = (n, dec) => companyFormats('EUR').money(n, 'en', { unit: 'major', ...digits(dec) });
export const euros = (n, dec = 0) => (n == null ? '—' : `${n < 0 ? '−' : ''}${unsignedEuros(Math.abs(n), dec)}`);
// cents only where they matter
export const money = n => euros(n, Math.abs(n ?? 0) < 100 && n % 1 ? 2 : 0);
// a fraction as a percent, with as many decimals as a small one needs
export const percent = (f, dec) =>
  f == null || !isFinite(f) ? '—' : `${number(f * 100, dec ?? (f < 0.1 ? (f < 0.01 ? 2 : 1) : 0))}%`;
export const ratio = (a, b) => (b ? a / b : null);
export const sum = a => a.reduce((s, x) => s + (x ?? 0), 0);
// a figure in the millions or more as 3 digits and M or B (2.41 B), any other whole (30,800) or to the cent
export const compact = v => {
  const big = Math.abs(v) >= 999.5e6 ? [1e9, 'B'] : Math.abs(v) >= 1e6 ? [1e6, 'M'] : null;
  if (!big) return number(v, v % 1 ? 2 : 0);
  const r = +(v / big[0]).toPrecision(3);
  return `${number(r, Math.min(2, String(r).split('.')[1]?.length ?? 0))} ${big[1]}`;
};
export const unitValue = (v, u) =>
  u === 'EUR'
    ? euros(v, v % 1 ? 2 : 0)
    : u === '%'
      ? `${number(v, v % 1 ? 1 : 0)}%`
      : `${compact(v)}${u ? ` ${u}` : ''}`;
export const dayName = s => companyFormats().day(s, 'en', { weekday: true, short: true });
export const short = s => companyFormats().day(s, 'en', { short: true });
export const range = (from, to) => (from && to ? companyFormats().days(from, to, 'en') : '');
export const clock = ts => dayTime(ts, { weekday: false, separator: ' · ' });
export const country = c => {
  if (!c) return 'Unknown';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(c) || c;
  } catch {
    return c;
  }
};

export function sparkline(vals, { w = 104, h = 30, dot = 3 } = {}) {
  if (!vals?.length) return '';
  const max = Math.max(1, ...vals),
    pad = dot + 2,
    n = vals.length - 1 || 1;
  const X = i => (pad + (i * (w - 2 * pad)) / n).toFixed(1),
    Y = v => (h - pad - (v / max) * (h - 2 * pad)).toFixed(1);
  const pts = vals.map((v, i) => `${X(i)},${Y(v)}`),
    last = vals.length - 1;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <path d="M${X(0)},${h - pad} L${pts.join(' L')} L${X(last)},${h - pad} Z" class="wash"/>
    <path d="M${pts.join(' L')}" class="line" vector-effect="non-scaling-stroke"/>
    <circle cx="${X(last)}" cy="${Y(vals[last])}" r="${dot}" class="end"/></svg>`;
}

// A day's column each from one baseline, a dotted average and the busiest day labelled. The left gutter is as wide as
// the longest of the axis's figures, L at the least.
const COLS = { w: 340, h: 132, L: 24, R: 4, T: 16, B: 18 };
// a figure's 10px axis text runs about 6 units a character; the gutter adds the 5 before the gridline and 4 at the edge
const AXIS_CHAR_WIDTH = 6,
  AXIS_PAD = 9;
export function columns(daily, key = 'paid', label = 'Paid orders') {
  const { w, h, R, T, B } = COLS,
    vals = daily.map(d => Number(d[key]) || 0),
    top = Math.max(...vals, 0);
  const step = top <= 4 ? 1 : top <= 10 ? 2 : top <= 25 ? 5 : top <= 50 ? 10 : niceHalf(top);
  const max = Math.max(step, Math.ceil(top / step) * step),
    ih = h - T - B,
    axis = [0, max / 2, max].map(g => [g, Number.isInteger(g) ? compact(g) : '']);
  const gutter = AXIS_PAD + AXIS_CHAR_WIDTH * Math.max(...axis.map(([, t]) => t.length));
  const L = Math.max(COLS.L, gutter),
    band = (w - L - R) / vals.length;
  const bw = Math.max(1, Math.min(band - (band > 4 ? 2 : 1), 24)),
    r = Math.min(3, bw / 2),
    Y = v => T + ih - (v / max) * ih,
    base = T + ih;
  const f = n => n.toFixed(2);
  let s = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)} per day" data-l="${L}">`;
  for (const [g, t] of axis) {
    s += `<line class="grid" x1="${L}" x2="${w - R}" y1="${Y(g)}" y2="${Y(g)}"/>`;
    s += `<text x="${L - 5}" y="${Y(g) + 3.5}" text-anchor="end">${t}</text>`;
  }
  vals.forEach((v, i) => {
    if (!v) return;
    const x = L + i * band + (band - bw) / 2,
      y = Y(v);
    const [left, right, crest, shoulder] = [f(x), f(x + bw), f(y), f(y + r)];
    const corners = `Q${left},${crest} ${f(x + r)},${crest} H${f(x + bw - r)} Q${right},${crest} ${right},${shoulder}`;
    s += `<path class="col" d="M${left},${base} V${shoulder} ${corners} V${base} Z"/>`;
  });
  if (top) {
    const avg = Y(sum(vals) / vals.length).toFixed(1),
      peak = Math.min(w - 8, Math.max(L + 6, L + vals.lastIndexOf(top) * band + band / 2));
    s += `<line class="avg" x1="${L}" x2="${w - R}" y1="${avg}" y2="${avg}"/>`;
    s += `<text class="v" x="${peak}" y="${Y(top) - 4}" text-anchor="middle">${compact(top)}</text>`;
  }
  const week = vals.length <= 7,
    last = vals.length - 1;
  const ticks = week ? vals.map((_, i) => i) : [0, Math.round(last / 3), Math.round((2 * last) / 3), last];
  const anchor = i => (week ? 'middle' : i === 0 ? 'start' : i === last ? 'end' : 'middle');
  const day = i => (week ? companyFormats().weekday(daily[i].day, 'en', { short: true }) : short(daily[i].day));
  for (const i of ticks)
    s += `<text x="${L + i * band + band / 2}" y="${h - 4}" text-anchor="${anchor(i)}">${esc(day(i))}</text>`;
  s += `<rect class="cursor-col" x="0" y="${T}" width="${band}" height="${ih}"/></svg>`;
  return s;
}
// a chart's half-height line above 50: a round number at or over half its top (1, 1.2, 1.5 … 8 times a power of ten)
const niceHalf = top => {
  const p = 10 ** Math.floor(Math.log10(top / 2));
  return Math.round([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(m => m * p >= top / 2) * p);
};

// The per-day chart's reading line: pointing at a day, or the arrow keys, read it, words(day) its line
export function wireChart(el, daily, words) {
  const box = el.querySelector('[data-nx-cols]'),
    read = el.querySelector('[data-nx-read]');
  if (!box || !daily.length || !read) return;
  const svg = box.querySelector('svg'),
    cur = svg.querySelector('.cursor-col'),
    L = Number(svg.dataset.l),
    band = (COLS.w - L - COLS.R) / daily.length;
  let at = -1;
  const show = i => {
    at = Math.max(0, Math.min(daily.length - 1, i));
    cur.classList.add('on');
    cur.setAttribute('x', L + at * band);
    cur.setAttribute('width', band);
    read.innerHTML = words(daily[at]);
  };
  const pick = e => {
    const r = svg.getBoundingClientRect();
    show(Math.floor((((e.clientX - r.left) / r.width) * COLS.w - L) / band));
  };
  svg.addEventListener('pointermove', pick);
  svg.addEventListener('pointerdown', pick);
  box.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    show(at < 0 ? daily.length - 1 : at + (e.key === 'ArrowRight' ? 1 : -1));
  });
}

// Horizontal bars as HTML rows, so labels wrap: [{ key (html), v, soft?, cls?, val (html), title? }]
export function horizontalBars(rows, max) {
  const bar = (v, cls) => `<i class="${cls}" style="width:${((100 * v) / max).toFixed(2)}%"></i>`;
  const row = r => {
    const title = r.title ? ` title="${esc(r.title)}"` : '';
    const soft = r.soft != null ? bar(r.soft, 'soft') : '';
    const track = `<span class="tr"${title}>${soft}${bar(r.v, r.cls ?? '')}</span>`;
    return `<div class="row"><span class="k">${r.key}</span>${track}<span class="val">${r.val}</span></div>`;
  };
  return `<div class="hbox"><div class="hb">${rows.map(row).join('')}</div></div>`;
}
export const figure = (v, small = '') => `<b class="f">${v}</b>${small ? `<small>${small}</small>` : ''}`;

export const TEAR = '<div class="tear">End of printout · tear here</div>';
export const NOTHING = '<p class="nodata">Nothing counted yet.</p>';
const SIGNAL = '<span class="sig" data-nx-signal hidden>no signal · retrying</span>';
export const printerLine = (middle = '') =>
  `<div class="dot"><span>${esc(names.os)} Numbers · printout</span>${middle}${SIGNAL}</div>`;
export const title = (pic, name, line) =>
  `<div class="title">${pic}<div><h1>${esc(name)}</h1><p>${line}</p></div></div>`;
export const choice = (label, key, now, keys) => {
  const button = ([value, text]) => `<button data-${key}="${value}" aria-pressed="${value === now}">${text}</button>`;
  return `<div class="range" role="group" aria-label="${label}">${keys.map(button).join('')}</div>`;
};
const PERIODS = [7, 28, 90].map(p => [p, `${p} days`]);
export const periods = view => choice('Period', 'days', view.days, PERIODS);
// the cards' heads, numbered in the order they're made
export const numbered = () => {
  let n = 0;
  return text => `<h2><span class="n">${++n}</span>${esc(text)}</h2>`;
};
export const card = (head, body) => `<div class="card">${head}${body}</div>`;
export const tile = (label, value, rest = '', hero = false) =>
  `<div class="tile${hero ? ' hero' : ''}"><span class="l">${label}</span><span class="v">${value}</span>${rest}</div>`;
export const under = text => `<span class="s">${text}</span>`;
// A per-day chart, read by pointing at a day (wireChart), and its table folded under it
export function dayCard(head, sub, chart, empty, table) {
  const read = `<p class="read" data-nx-read>${empty ?? 'Tap or point at a day to read it.'}</p>`;
  return `<div class="card">${head}<p class="sub">${sub}</p>
    <div class="chart" data-nx-cols tabindex="0">${chart}</div>${read}
    <details data-k="days"><summary>As a table</summary>${table}</details></div>`;
}
export const dayTable = (heads, rows, cells) => {
  const body = [...rows].reverse().map(r => `<tr><td>${esc(dayName(r.day))}</td>${cells(r)}</tr>`);
  return `<table><thead><tr><th>Day</th>${heads}</tr></thead><tbody>${body.join('')}</tbody></table>`;
};
export function targetsCard(targets, heading, sub) {
  const now = k => (k.value == null ? '' : esc(unitValue(k.value, k.unit)));
  const goal = k => `<span class="nm">${esc(k.label)}</span><span class="tg">${esc(goalWords(k))}</span>`;
  const kpi = k => `
    <div class="kpi">${goal(k)}<span class="nw f">${now(k)}</span><span class="mk">${mark(k)}</span></div>`;
  const body = targets.length
    ? `<div class="kpis">${targets.map(kpi).join('')}</div>`
    : '<p class="nodata">No targets in this app’s file yet.</p>';
  return card(`${heading('The numbers we work from')}<p class="sub">${esc(sub)}</p>`, body);
}
function goalWords(k) {
  const most = k.max != null ? `, at ${k.lower ? 'most' : 'least'} ${unitValue(k.max, k.unit)}` : '';
  return `target ${unitValue(k.goal, k.unit)} or ${k.lower ? 'less' : 'more'}${most}`;
}
const mark = k =>
  k.mark === 'green'
    ? `<span class="ok">${icon('tick', 'small')}on target</span>`
    : k.mark === 'amber'
      ? `<span class="watch">${icon('eye', 'small')}watch</span>`
      : `<span class="nodat">${icon('dash', 'small')}no data yet</span>`;

// Each app's own little sigil: a mirrored 5×5 pattern from its slug, the same on every visit (the JSON names no icon)
export function sigil(slug) {
  const h = hash(slug);
  const rows = Array.from({ length: 5 }, (_, y) => {
    const half = [0, 1, 2].map(x => ((h >>> (y * 3 + x)) & 1 ? '#' : '.'));
    return [...half, half[1], half[0]].join('');
  });
  if (rows.join('').split('#').length < 8) rows[2] = '#####'; // never a near-empty one
  return gridArt(['.......', ...rows.map(r => `.${r}.`), '.......'], 'small sigil');
}
// A grid picture (pixel art) where the look wears pixel icons, else the name's initial in its place (numbers.css)
export const gridOr = (art, name, cls) =>
  `${art}<i class="${cls} grid-not" aria-hidden="true">${esc([...String(name)][0] ?? '?')}</i>`;

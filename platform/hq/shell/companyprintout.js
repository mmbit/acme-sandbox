// Numbers' printout of a company's own dashboard, a kit's dashboard()
import { esc, gridArt } from '../util.js';
import { icon } from './icons.js';
import {
  count,
  money,
  percent,
  sum,
  unitValue,
  dayName,
  range,
  columns,
  horizontalBars,
  figure,
  sigil,
  gridOr,
  printerLine,
  title,
  periods,
  numbered,
  card,
  tile,
  under,
  dayCard,
  dayTable,
  targetsCard,
  NOTHING,
  TEAR,
} from './paper.js';

// Its figures as the headline tiles, its daily the per-day chart (the first column) with the table, its bars and its
// targets. Its period switches like an app's: the home is asked for those days, and the dashboard taken from it.
export function companyIn(home, id) {
  const dashboard = (home.dashboards ?? []).find(x => x.id === id);
  return dashboard ? { ...dashboard, days: home.days, from: home.from, to: home.to } : { missing: true };
}
export function companyPrintout(dashboard, view) {
  const heading = numbered(),
    figures = (dashboard.figures ?? []).filter(f => f && f.label != null);
  const lead = dashboard.about ? `${esc(dashboard.about)} · ` : '';
  const about = `${lead}Last ${count(dashboard.days)} days · ${esc(range(dashboard.from, dashboard.to))}`;
  const top = `${printerLine()}
    ${title(companyIcon(dashboard, 'small sigil'), dashboard.name, about)}
    <div class="ranges">${periods(view)}</div>`;
  // the first figure a little wider, the rest in the same row
  const cols = `--cols: 1.6fr repeat(${Math.max(1, Math.min(figures.length, 5) - 1)}, minmax(0, 1fr))`;
  const row = figures.map(figureTile).join('');
  const tiles = figures.length
    ? `<section data-nx="top"><div class="tiles figs" style="${cols}">${row}</div></section>`
    : '';
  const days = dayCards(dashboard, heading),
    bars = (dashboard.bars ?? []).map(bar => barCard(bar, heading)),
    targets = dashboard.targets?.length ? [targetCard(dashboard.targets, heading)] : [];
  return `<div class="nx">${top}${tiles}
    ${balanced([...days, ...bars, ...targets])}
    ${TEAR}</div>`;
}
export const companyReading = dashboard => x => {
  const value = c => `${esc(c.label ?? c.key)} <b class="f">${cell(x[c.key], c.unit)}</b>`;
  return `<b>${esc(dayName(x.day))}</b>: ${dailyColumns(dashboard).map(value).join(' · ')}`;
};
const dailyColumns = dashboard => (dashboard.daily?.columns ?? []).filter(c => c?.key);

// The icon the kit names (as an app's), or its rows of # and ., else a sigil from its id
export function companyIcon(dashboard, cls = 'small') {
  const given = dashboard.icon;
  if (typeof given === 'string' && /^[\w-]+$/.test(given)) return icon(given, cls);
  const ok =
    Array.isArray(given) &&
    given.length &&
    given.length <= 32 &&
    given.every(r => typeof r === 'string' && /^[#.]{1,32}$/.test(r) && r.length === given[0].length);
  const edge = ok && '.'.repeat(given[0].length + 2);
  const pic = ok ? gridArt([edge, ...given.map(r => `.${r}.`), edge], cls) : sigil(dashboard.id);
  return gridOr(pic, dashboard.name, cls);
}
// euros as the apps' printouts show them: cents only under €100
const amount = (v, u) => (u === 'EUR' ? money(v) : unitValue(v, u));
// the number, and its unit apart in a smaller hand that may wrap under it (a euro or % stays whole)
const sized = (v, u) =>
  u === 'EUR' || u === '%' || !u ? esc(amount(v, u)) : `${esc(unitValue(v))} <span class="u">${esc(u)}</span>`;
const figureTile = (f, i) => {
  const value = f.value == null ? '—' : typeof f.value === 'string' ? esc(f.value) : sized(Number(f.value), f.unit);
  return tile(esc(f.label), value, f.sub ? under(esc(f.sub)) : '', !i);
};
// a count not known yet is a dash, never a 0
const cell = (v, u) => (v == null ? '—' : esc(amount(Number(v), u)));
// a table's column: its unit in the head, the figures bare under it (a euro or % keeps its sign in each cell)
const bare = u => (u === 'EUR' || u === '%' ? u : undefined);

function dayCards(dashboard, heading) {
  const daily = dashboard.daily,
    cols = dailyColumns(dashboard),
    rows = daily?.rows ?? [];
  if (!cols.length || !rows.length) return [];
  const [first] = cols,
    label = first.label ?? first.key;
  const sub = `${esc(label)} a day${daily.sub ? `. ${esc(daily.sub)}` : '.'}`;
  const empty = rows.some(r => Number(r[first.key])) ? null : 'Nothing on any day yet.';
  const unit = c => (c.unit && !bare(c.unit) ? `<small>${esc(c.unit)}</small>` : '');
  const heads = cols.map(c => `<th>${esc(c.label ?? c.key)}${unit(c)}</th>`).join('');
  const cells = r => cols.map(c => `<td>${cell(r[c.key], bare(c.unit))}</td>`).join('');
  const table = `<div class="scroll">${dayTable(heads, rows, cells)}</div>`;
  const html = dayCard(heading(daily.title ?? 'Per day'), sub, columns(rows, first.key, label), empty, table);
  return [{ html, lines: height(CHART_LINES, daily.sub) }];
}
// share: false, a bar whose values don't add up, a median or a rate: no share beside each
function barCard(bar, heading) {
  const rows = (bar.rows ?? []).map(r => ({ ...r, known: r.value != null, count: Number(r.value) || 0 }));
  const total = bar.share !== false && rows.every(r => r.known) ? sum(rows.map(r => r.count)) : null,
    max = Math.max(1, ...rows.map(r => r.count));
  const value = r => figure(r.known ? sized(r.count, r.unit) : '—', total ? percent(r.count / total, 0) : '');
  const row = r => ({ key: esc(r.label), v: r.count, val: value(r) });
  const sub = bar.sub ? `<p class="sub">${esc(bar.sub)}</p>` : '';
  const body = rows.length ? horizontalBars(rows.map(row), max) : NOTHING;
  const html = card(heading(bar.title ?? 'A breakdown'), sub + body);
  const rowLines = sum(rows.map(r => (String(r.label).length > BAR_LABEL_CHARS ? WRAPPED_BAR_LINES : BAR_LINES)));
  return { html, lines: height(rowLines || 1, bar.sub) };
}
const targetCard = (targets, heading) => ({
  html: targetsCard(targets, heading, 'What the team works from.'),
  lines: height(targets.length * TARGET_LINES),
});
// Two columns of cards on wide paper, each with its share of the height: the cards stay in their order, the first ones
// in the left column, as many as come closest to half. On a phone they're one column, in the same order.
function balanced(cards) {
  if (!cards.length) return '';
  const all = sum(cards.map(c => c.lines));
  let left = 0;
  const gaps = cards.map(c => Math.abs(all - 2 * (left += c.lines)));
  const split = gaps.indexOf(Math.min(...gaps)) + 1;
  const stack = list => (list.length ? `<div class="stack">${list.map(c => c.html).join('')}</div>` : '');
  return `<section class="grid two">${stack(cards.slice(0, split))}${stack(cards.slice(split))}</section>`;
}
// A card's height guessed in lines of its sub: its head and padding 3, its sub at about 55 characters a line (half the
// wide paper), and its rows. A bar's row is about 1.6 lines with its gap, 2.2 where its label wraps (past about 24
// characters, at the label column's width); a target is 2; the day by day 12 (its chart about 9, the reading and the
// table's switch 3 more).
const CARD_LINES = 3,
  LINE_CHARS = 55;
const BAR_LINES = 1.6,
  WRAPPED_BAR_LINES = 2.2,
  BAR_LABEL_CHARS = 24,
  TARGET_LINES = 2,
  CHART_LINES = 12;
const height = (rows, sub) => CARD_LINES + Math.ceil(String(sub ?? '').length / LINE_CHARS) + rows;

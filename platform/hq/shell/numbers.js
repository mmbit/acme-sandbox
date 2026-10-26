// HQ-OS › Numbers: each app's numbers for the board. The home is tiles on the CRT, Apps' and the company's own
// dashboards' (its kits' dashboard(), template/kits/README.md); a tile's dashboard comes out of the computer as a
// printout. Everything is drawn from the coordinator's /api/numbers and the app's own metrics.json (its `file`): a new
// app with a metrics.json, or a kit with a dashboard, shows up here with no change to HQ. Their labels are text from the
// repo, so every string is escaped. Numbers are figures, charts and tables here, never a sentence with a few of them in
// bold.
import { esc, hash, gridArt, stylesheet } from '../util.js';
import { icon } from './icons.js';
import { loadNumbers, loadNumbersApp, loadApps } from './data.js';
import { appTile, appGroups, showTiles } from './tiles.js';
import { sfx, tone, noise } from './audio.js';
import * as world from '../world/world.js';
import { companyFormats, dayTime } from '../world/clock.js';
import { names, brand } from './brand.js';

const PERIODS = [7, 28, 90];
let view = { slug: null, company: null, name: '', days: 28, mode: 'live', status: 'live' }; // (company: the id of a kit's dashboard, else null)
let shownEl = null, shown = '', seq = 0, feed = false;
// One app's dashboard opened from elsewhere in HQ-OS (Apps), and the way back there
let asked = null, away = null;
// desk.js's hooks: more, the company's own sections on a dashboard (its HQ apps' numbers(): template/kits/README.md);
// care(app, back), when the company runs care, opens Care › Numbers for the app, its back button calling back
let go = { more: [] };

// ---------------------------------------------------------------- what desk.js calls
// Each time the computer (re)draws Numbers: on opening it and every 15 s. A new screen element is a fresh opening.
export async function numbers(el, hooks) {
  if (hooks) go = { more: [], ...hooks };
  if (el !== shownEl) {
    shownEl = el; shown = ''; away = asked?.back ?? null;
    const status = asked?.status === 'live' ? 'live' : 'preview';
    const mode = status === 'live' && asked?.mode === 'preview' ? 'preview' : status;
    view = asked ? { ...view, slug: asked.slug, company: null, name: asked.name, status, mode } : { ...view, slug: null, company: null };
    feed = !!asked; asked = null;
  }
  await stylesheet('shell/numbers.css');
  await paint(el);
}
// The header's back button: from a dashboard back to the Numbers home (true), else it's the computer's (false).
export function numbersBack() {
  if (!(view.slug || view.company) || !shownEl?.isConnected) return false;
  if (away) { const back = away; away = null; back(); return true; } // to where the dashboard was opened from
  sfx.blip(); view = { ...view, slug: null, company: null }; shown = '';
  paint(shownEl).catch(() => { shownEl.innerHTML = '<p><i class="prompt">&gt; </i>No signal from the coordinator. Retrying…<i class="cursor"></i></p>'; });
  return true;
}

// Open Numbers on one app's dashboard ({ slug, name, status, mode? }): the next time the computer draws Numbers, it prints
// that app's, and the header's back button calls `back`
export function numbersFor(app, back) { asked = { ...app, back }; }

async function paint(el) {
  const me = ++seq, v = { ...view }, one = v.slug || v.company; // (one: a printout, else the home's tiles)
  let data;
  try {
    data = v.slug ? await loadNumbersApp(world.dev, v.slug, v.days, v.mode) : await homeData(v.days);
    if (v.company) data = companyIn(data, v.company);
  } catch (e) {
    if (me !== seq) return;
    if (v.slug && / 40[04]$/.test(e.message)) { data = { missing: true }; }
    else if (shown) { el.querySelector('[data-nx-signal]')?.removeAttribute('hidden'); return; } // keep what's shown
    else { printer(el, false); throw e; }
  }
  if (me !== seq || !el.isConnected) return;
  const key = JSON.stringify([v, data]);
  if (key === shown) { el.querySelector('[data-nx-signal]')?.setAttribute('hidden', ''); return; } // nothing new: no redraw
  const open = [...el.querySelectorAll('details[data-k]')].filter(d => d.open).map(d => d.dataset.k);
  shown = key;
  crumb(el, one ? v.name : '');
  printer(el, !!one);
  if (!one) { showTiles(el, homeHtml(data)); wireHome(el); return; }   // (tiles)
  // (the sheet: the window the printout feeds through, numbers.css)
  el.innerHTML = `<div class="nx-sheet">${data.missing ? missingHtml(v) : v.company ? companyHtml(data, v) : dashHtml(data, v)}</div>`;
  open.forEach(k => { const d = el.querySelector(`details[data-k="${k}"]`); if (d) d.open = true; });
  if (v.company) wireCompany(el, data); else wireDash(el, data);
  if (feed) { feed = false; printOut(el); }
}

// the header's breadcrumb: HQ-OS › Numbers › <app>
function crumb(el, name) {
  const s = el.closest('.device')?.querySelector('header b span');
  if (s) s.textContent = ` › Numbers${name ? ` › ${name}` : ''}`;
}
// a dashboard turns the CRT into the printer: the screen becomes paper coming out of a slot
function printer(el, on) {
  const dev = el.closest('.device');
  el.closest('.crt')?.classList.toggle('nx-printer', on); dev?.classList.toggle('nx-wide', on);
  dev?.classList.toggle('nx-px', /pixelify/i.test(getComputedStyle(el).fontFamily)); // (numbers.css: the digits a pixel font blurs)
}

// ---------------------------------------------------------------- formatting
// (in the company's formats, on its clock)
const num = (n, dec = 0) => companyFormats().number(Number(n), 'en', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const int = n => num(Math.round(n ?? 0));
// euros, whole or with cents (dec 2)
const eur = (n, dec = 0) => n == null ? '—' : `${n < 0 ? '−' : ''}${companyFormats('EUR').money(Math.abs(n), 'en', { unit: 'major', minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
const money = n => eur(n, Math.abs(n ?? 0) < 100 && n % 1 ? 2 : 0); // cents only where they matter
// a share or a rate (a fraction) as a percent, with as many decimals as a small one needs
const pct = (f, dec) => f == null || !isFinite(f) ? '—' : `${num(f * 100, dec ?? (f < 0.1 ? (f < 0.01 ? 2 : 1) : 0))}%`;
const ratio = (a, b) => b ? a / b : null;
const sum = a => a.reduce((s, x) => s + (x ?? 0), 0);
const dayName = s => companyFormats().day(s, 'en', { weekday: true, short: true });
const short = s => companyFormats().day(s, 'en', { short: true });
const range = (from, to) => from && to ? companyFormats().days(from, to, 'en') : '';
const clock = ts => dayTime(ts, { weekday: false, separator: ' · ' });
const country = c => { if (!c) return 'Unknown'; try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(c) || c; } catch { return c; } };

// ---------------------------------------------------------------- pictures
// Each app's own little sigil: a mirrored 5×5 pattern from its slug, the same on every visit (the JSON names no icon).
function sigil(slug) {
  const h = hash(slug);
  const rows = [];
  for (let y = 0; y < 5; y++) {
    const half = [0, 1, 2].map(x => (h >>> (y * 3 + x)) & 1 ? '#' : '.');
    rows.push([...half, half[1], half[0]].join(''));
  }
  if (rows.join('').split('#').length < 8) rows[2] = '#####'; // never a near-empty one
  return gridArt(['.......', ...rows.map(r => `.${r}.`), '.......'], 'small sigil');
}
// A grid picture (pixel art) where the look wears pixel icons, else the name's initial in its place (numbers.css)
const gridOr = (art, name, cls) => `${art}<i class="${cls} grid-not" aria-hidden="true">${esc([...String(name)][0] ?? '?')}</i>`;

// ---------------------------------------------------------------- charts (inline SVG, one series each)
function spark(vals, { w = 104, h = 30, dot = 3 } = {}) {
  if (!vals?.length) return '';
  const max = Math.max(1, ...vals), pad = dot + 2, n = vals.length - 1 || 1;
  const X = i => (pad + i * (w - 2 * pad) / n).toFixed(1), Y = v => (h - pad - v / max * (h - 2 * pad)).toFixed(1);
  const pts = vals.map((v, i) => `${X(i)},${Y(v)}`), last = vals.length - 1;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <path d="M${X(0)},${h - pad} L${pts.join(' L')} L${X(last)},${h - pad} Z" class="wash"/>
    <path d="M${pts.join(' L')}" class="line" vector-effect="non-scaling-stroke"/>
    <circle cx="${X(last)}" cy="${Y(vals[last])}" r="${dot}" class="end"/></svg>`;
}
// Paid orders per day: columns from one baseline, a dotted average, the busiest day labelled; every day readable by
// pointing at it (the caption under the chart) and in the table below it.
const COLS = { w: 340, h: 132, L: 24, R: 4, T: 16, B: 18 };
function columns(daily, key = 'paid', label = 'Paid orders') {
  const { w, h, L, R, T, B } = COLS, vals = daily.map(d => Number(d[key]) || 0), top = Math.max(...vals, 0);
  const step = top <= 4 ? 1 : top <= 10 ? 2 : top <= 25 ? 5 : top <= 50 ? 10 : Math.ceil(top / 50) * 10;
  const max = Math.max(step, Math.ceil(top / step) * step), ih = h - T - B, band = (w - L - R) / vals.length;
  const bw = Math.max(1, Math.min(band - (band > 4 ? 2 : 1), 24)), r = Math.min(3, bw / 2), Y = v => T + ih - v / max * ih, base = T + ih;
  let s = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)} per day">`;
  for (const g of [0, max / 2, max]) s += `<line class="grid" x1="${L}" x2="${w - R}" y1="${Y(g)}" y2="${Y(g)}"/><text x="${L - 5}" y="${Y(g) + 3.5}" text-anchor="end">${Number.isInteger(g) ? g : ''}</text>`;
  vals.forEach((v, i) => {
    if (!v) return;
    const x = L + i * band + (band - bw) / 2, y = Y(v);
    s += `<path class="col" d="M${x.toFixed(2)},${base} V${(y + r).toFixed(2)} Q${x.toFixed(2)},${y.toFixed(2)} ${(x + r).toFixed(2)},${y.toFixed(2)} H${(x + bw - r).toFixed(2)} Q${(x + bw).toFixed(2)},${y.toFixed(2)} ${(x + bw).toFixed(2)},${(y + r).toFixed(2)} V${base} Z"/>`;
  });
  if (top) {
    const avg = sum(vals) / vals.length, peak = vals.lastIndexOf(top);
    s += `<line class="avg" x1="${L}" x2="${w - R}" y1="${Y(avg).toFixed(1)}" y2="${Y(avg).toFixed(1)}"/>`;
    s += `<text class="v" x="${Math.min(w - 8, Math.max(L + 6, L + peak * band + band / 2))}" y="${Y(top) - 4}" text-anchor="middle">${top}</text>`;
  }
  const ticks = vals.length <= 7 ? vals.map((_, i) => i) : [0, Math.round((vals.length - 1) / 3), Math.round(2 * (vals.length - 1) / 3), vals.length - 1];
  for (const i of ticks) s += `<text x="${L + i * band + band / 2}" y="${h - 4}" text-anchor="${i === 0 && vals.length > 7 ? 'start' : i === vals.length - 1 && vals.length > 7 ? 'end' : 'middle'}">${esc(vals.length <= 7 ? companyFormats().weekday(daily[i].day, 'en', { short: true }) : short(daily[i].day))}</text>`;
  s += `<rect class="cursor-col" x="0" y="${T}" width="${band}" height="${ih}"/></svg>`;
  return s;
}
// horizontal bars as HTML rows (labels wrap, never clip): [{ key (html), v, soft?, val (html), title }]
const hbars = (rows, max) => `<div class="hb">${rows.map(r => `<span class="k">${r.key}</span><span class="tr"${r.title ? ` title="${esc(r.title)}"` : ''}>${r.soft != null ? `<i class="soft" style="width:${(100 * r.soft / max).toFixed(2)}%"></i>` : ''}<i class="${r.cls ?? ''}" style="width:${(100 * r.v / max).toFixed(2)}%"></i></span><span class="val">${r.val}</span>`).join('')}</div>`;
const fig = (v, small = '') => `<b class="f">${v}</b>${small ? `<small>${small}</small>` : ''}`;

// ---------------------------------------------------------------- tests, in plain words
// Dowel's states (coordinator metrics.ts): one plain line each, and how the stamp looks
function testWords(t) {
  const w = t.winner ?? 'B';
  return {
    'not-started': ['Not started', 'starts on ' + (t.start ? short(t.start) : 'its start day'), 'wait'],
    'not-called': ['Not called', 'yet', 'wait'],
    'split-drifted': ['Split drifted', 'stop and fix', 'bad'],
    won: [`${w} won`, 'switch to ' + w, 'good'],
    lost: [`${t.variants?.find(x => x !== 'A') ?? 'B'} lost`, 'keep A', 'bad'],
    'no-difference': ['No difference', 'keep A', 'flat'],
    'six-weeks': ['Six weeks', 'no winner: keep A', 'flat'],
  }[t.state] ?? [String(t.state ?? 'Unknown'), '', 'wait'];
}
const homeTest = s => ({ 'not-started': 'NOT STARTED YET', 'not-called': 'NOT CALLED YET', 'split-drifted': 'SPLIT DRIFTED: STOP AND FIX', won: 'A WINNER IS IN',
  lost: 'CALLED: KEEP A', 'no-difference': 'NO DIFFERENCE: KEEP A', 'six-weeks': 'SIX WEEKS, NO WINNER: KEEP A' })[s] ?? 'RUNNING';
const running = t => !t.end && t.state !== 'not-started';

// ---------------------------------------------------------------- the home (on the CRT)
// Tiles only: Apps' tiles for the apps that count something, in Apps' order, each with its revenue and paid orders (or
// that nothing has reported yet) and where its A/B test stands; then the company's own dashboards' tiles (kits.ts),
// in the order they come.
async function homeData(days) {
  const [counted, apps] = await Promise.all([loadNumbers(world.dev, days), loadApps(world.dev)]);
  const order = appGroups(apps, brand.computer?.appGroups).flatMap(g => g.apps).map(a => a.slug);
  const place = a => order.includes(a.slug) ? order.indexOf(a.slug) : order.length;   // (one Apps doesn't list: last)
  const listed = (counted.apps ?? []).map(a => { const app = apps.find(x => x.slug === a.slug); return { ...a, icon: app?.icon ?? null, about: app?.about ?? '' }; });
  return { ...counted, apps: listed.sort((a, b) => place(a) - place(b)) };
}
function homeHtml(d) {
  const apps = d.apps ?? [], dashboards = d.dashboards ?? [];
  const tile = a => appTile(a, { data: `data-nx-app="${esc(a.slug)}" data-status="${esc(a.status)}" data-name="${esc(a.name)}"`,
    lines: `<span class="dim">${a.updated ? `${money(a.revenue)} · ${int(a.paid)} paid` : 'no data yet'}</span>${a.test ? `<span class="dim">A/B · ${homeTest(a.test.state)}</span>` : ''}` });
  const companyTile = b => appTile({ name: String(b.name), about: String(b.about ?? '') }, { data: `data-nx-company="${esc(b.id)}" data-name="${esc(b.name)}"`,
    pic: companyIcon(b), lines: b.tile ? `<span class="dim">${esc(b.tile)}</span>` : '' });
  const tiles = [...apps.map(tile), ...dashboards.map(companyTile)];
  return `<div class="nxh">
    <p class="cap"><i class="prompt">&gt; </i>LAST ${int(d.days)} DAYS · ${esc(range(d.from, d.to).toUpperCase())}</p>
    ${tiles.length ? `<ul class="applist">${tiles.join('')}</ul>` : '<p><i class="prompt">&gt; </i>Nothing counts anything yet.</p>'}
    ${(d.broken ?? []).length ? `<p class="dim"><i class="prompt">&gt; </i>Can’t read the metrics file of ${d.broken.map(b => esc(b.slug)).join(', ')}.</p>` : ''}
    <p class="hint"><i class="prompt">&gt; </i>Tap a tile to print its dashboard<i class="cursor"></i></p>
    <p class="foot">COUNTED FROM PAGE LOADS AND ORDERS · NO COOKIES · NO IP ADDRESSES</p></div>`;   // (the visitors' hash)
}
function wireHome(el) {
  el.querySelectorAll('[data-nx-app]').forEach(b => b.onclick = () => {
    const status = b.dataset.status === 'live' ? 'live' : 'preview';
    view = { ...view, slug: b.dataset.nxApp, company: null, name: b.dataset.name, status, mode: status };
    print(el);
  });
  el.querySelectorAll('[data-nx-company]').forEach(b => b.onclick = () => {
    view = { ...view, slug: null, company: b.dataset.nxCompany, name: b.dataset.name, status: 'live', mode: 'live' };
    print(el);
  });
}
function print(el) {
  sfx.blip(); feed = true;
  paint(el).catch(() => { el.innerHTML = '<p><i class="prompt">&gt; </i>No signal from the coordinator. Retrying…<i class="cursor"></i></p>'; });
}

// ---------------------------------------------------------------- a dashboard (the printout)
const head = (n, t) => `<h2><span class="n">${n}</span>${esc(t)}</h2>`;
const how = t => t ? `<span class="how">${icon('server', 'small')}<span>counted: ${esc(t)}</span></span>` : '';

function dashHtml(d, v) {
  const f = d.file ?? {}, steps = new Map((f.steps ?? []).map(s => [s.id, s])), label = id => steps.get(id)?.label ?? id;
  const daily = d.daily ?? [], t = d.totals ?? {}, none = !d.updated, n = { i: 0 };
  const sec = title => head(++n.i, title);
  const page = d.steps?.page ?? 0, paid = t.paid ?? d.steps?.paid ?? 0;

  // The paper's top: the printer's line, the title, the range keys. An app not launched gets no notice: its zeros say it.
  const top = `<div class="dot"><span>${esc(names.os)} Numbers · printout</span><span>${d.updated ? `last report ${esc(clock(d.updated))}` : 'no report yet'}</span><span class="sig" data-nx-signal hidden>no signal · retrying</span></div>
    <div class="title">${gridOr(sigil(d.slug), d.name, 'small sigil')}<div><h1>${esc(d.name)}</h1><p><span class="st ${d.status === 'live' ? 'live' : 'pre'}">${d.status === 'live' ? 'LIVE' : 'PREVIEW'}</span> Last ${int(d.days)} days · ${esc(range(d.from, d.to))}</p></div></div>
    <div class="ranges"><div class="range" role="group" aria-label="Period">${PERIODS.map(p => `<button data-days="${p}" aria-pressed="${p === v.days}">${p} days</button>`).join('')}</div>
    ${v.status === 'live' ? `<div class="range" role="group" aria-label="Whose visits">${[['live', 'Live'], ['preview', 'Preview']].map(([m, l]) => `<button data-mode="${m}" aria-pressed="${m === v.mode}">${l}</button>`).join('')}</div>` : ''}</div>
    ${d.status === 'live' && d.mode === 'preview' ? '<p class="banner">Preview numbers: the board’s and the team’s own visits to the preview, never mixed with the real ones.</p>' : ''}
    ${none ? '<p class="banner empty">No data yet: this app hasn’t reported anything. The steps below are what it will count.</p>' : ''}`;

  // 1. headline tiles. Net shows only when every kept order's is known
  const perDay = daily.length ? paid / daily.length : 0;
  const tiles = `<div class="tiles">
    <div class="tile hero"><span class="l">Revenue</span><span class="v">${none ? '—' : money(t.eur ?? 0)}</span><span class="s">${int(t.kept)} orders kept${t.refunded ? ` · ${int(t.refunded)} refunded` : ''}${t.net != null && t.eur ? ` · ${money(t.net)} net` : ''}${t.netUnknown ? ' · net not known yet' : ''}</span>${none ? '' : `<span class="sp">${spark(daily.map(x => x.eur ?? 0), { w: 140, h: 40, dot: 4 })}<small>per day</small></span>`}</div>
    <div class="tile"><span class="l">Paid orders</span><span class="v">${none ? '—' : int(paid)}</span><span class="s">${none ? 'no data yet' : `${num(perDay, perDay < 10 ? 1 : 0)} a day`}</span></div>
    <div class="tile"><span class="l">Page load → paid</span><span class="v">${pct(ratio(paid, page), 2)}</span><span class="s">of ${int(page)} page loads</span></div>
    <div class="tile"><span class="l">Margin</span><span class="v">${t.margin == null || none ? '—' : money(t.margin)}</span><span class="s">${t.margin == null ? 'the app’s file gives no margin' : 'before ads'}</span></div></div>`;

  // 2. the funnel: each step by how it's counted, and the blind middle where the file says (its caption)
  const fun = (f.funnel ?? []).filter(id => steps.has(id) || id in (d.steps ?? {}));
  const max = Math.max(1, ...fun.map(id => d.steps?.[id] ?? 0));
  const funnel = `<div class="card">${sec('The funnel')}<p class="sub">Counts from page loads and orders, never names.</p><div class="fun">${fun.map((id, i) => {
    const c = d.steps?.[id] ?? 0, next = fun[i + 1], nc = d.steps?.[next] ?? 0;
    let gap = '';
    if (next && f.blind?.after === id) gap = `<div class="blind">${icon('mobile', 'small')}<b>The blind middle</b><span>${esc(f.blind.text ?? '')}</span><div class="conv"><b class="f">${pct(ratio(nc, c), 1)}</b> of ${esc(label(id))} reach ${esc(label(next))}</div></div>`;
    else if (next) gap = `<div class="conv"><b class="f">${pct(ratio(nc, c), 0)}</b> go on to ${esc(label(next))}</div>`;
    return `<div class="step"><span class="nm">${esc(label(id))}</span><span class="ct">${int(c)}</span>${how(steps.get(id)?.how)}<span class="bar"><i style="width:${(100 * c / max).toFixed(2)}%"></i></span></div>${gap}`;
  }).join('')}</div></div>`;

  // 3. orders per day, and per country
  const perday = `<div class="card">${sec('Orders per day')}<p class="sub">Paid orders, ${esc(range(d.from, d.to))}.${paid ? ` Dotted: ${num(perDay, 1)} a day on average.` : ''}</p>
    <div class="chart" data-nx-cols tabindex="0">${columns(daily)}</div><p class="read" data-nx-read>${paid ? 'Tap or point at a day to read it.' : 'No paid orders in this period.'}</p>
    <details data-k="days"><summary>As a table</summary><table><thead><tr><th>Day</th><th>Page loads</th><th>Pressed Pay</th><th>Paid</th><th>Kept €</th></tr></thead><tbody>${daily.slice().reverse().map(x => `<tr><td>${esc(dayName(x.day))}</td><td>${int(x.steps?.page)}</td><td>${int(x.orders)}</td><td>${int(x.paid)}</td><td>${money(x.eur)}</td></tr>`).join('')}</tbody></table></details></div>`;
  const cs = d.countries ?? [], cpaid = sum(cs.map(c => c.paid)), cmax = Math.max(1, ...cs.map(c => c.paid ?? 0)), margin = f.margin ?? {};
  const countries = `<div class="card">${sec('Where the orders go')}<p class="sub">From the delivery address, never from an IP address.</p>${cs.length ? `
    <div class="where"><span class="hd"></span><span class="hd"></span><span class="hd r">paid</span><span class="hd r">kept €</span>${Object.keys(margin).length ? '<span class="hd r" title="margin per order, from the app’s file">margin each</span>' : ''}
    ${cs.map(c => `<span class="k"><span class="cc">${esc(c.country ?? '??')}</span><span class="cn">${esc(country(c.country))}</span></span><span class="tr"><i style="width:${(100 * (c.paid ?? 0) / cmax).toFixed(2)}%"></i></span><span class="val">${fig(int(c.paid), pct(ratio(c.paid, cpaid), 0))}</span><span class="val">${fig(money(c.eur))}</span>${Object.keys(margin).length ? `<span class="val">${fig(margin[c.country] != null ? eur(margin[c.country], 2) : '—')}</span>` : ''}`).join('')}</div>` : '<p class="nodata">No orders yet.</p>'}</div>`;

  // 4. the app's own sections, from its file
  const own = (f.sections ?? []).map(s => section(s, d, f, label, sec)).join('');

  // 5. A/B tests: the running one in full, finished ones in a line
  const tests = (d.tests ?? []).slice().sort((a, b) => running(b) - running(a));
  const abHtml = tests.length ? tests.map((x, i) => running(x) || i === 0 ? abCard(x, label, sec) : abLine(x, label)).join('')
    : `<div class="card">${sec('A/B test')}<p class="nodata">No A/B test in this app’s file.</p></div>`;

  // 6. ad labels
  const camps = d.campaigns ?? [], labelled = camps.filter(c => c.campaign != null), loose = camps.find(c => c.campaign == null);
  const ads = `<div class="card">${sec('Ad labels')}<p class="sub">By campaign label: the same for everyone who taps that ad. No click IDs.</p>${labelled.length ? `<div class="camps">${labelled.map(c => `
    <div class="camp"><span class="lb"><code>${esc(c.campaign)}</code></span><span class="fx">${int(c.page)} page loads · ${int(c.orders)} orders · ${int(c.kept)} kept · ${money(c.eur)}</span>
      <span class="cpa"><b class="f">—</b><small>per order · spend —</small></span></div>`).join('')}${loose ? `
    <div class="camp none"><span class="lb">No ad label</span><span class="fx">${int(loose.page)} page loads · ${int(loose.orders)} orders · ${int(loose.kept)} kept · ${money(loose.eur)}</span></div>` : ''}</div>
    <p class="note">Spend and cost per order show once the ad platforms’ own reports reach HQ.</p>`
    : '<p class="nodata">No ad labels yet: no ad has sent anyone here with one.</p>'}</div>`;

  // 7. targets
  const targets = targetsHtml(d.targets ?? [], sec, 'The team’s own targets for this app.', 'No targets in this app’s file yet.');

  // 8. the promise
  const promise = `<div class="card promise-card">${sec('How we count')}<div class="promise">${icon('lock', 'small')}<b>No cookies · no IP addresses in our counts</b><span>Counted from page loads and orders, on our own server. Nothing is stored on anyone’s device. Where visitors are counted, a hash of address and browser is kept for that day only.</span></div></div>`;   // (the visitors' hash)

  const chat = d.chat ? chatLine(d.chat) : ''; // the support chat's line (Care › Numbers' way in)
  // the company's own sections, under the tiles: each app's { html } for these numbers, or nothing (this and ${more} below)
  const more = go.more.map(f => { try { return f(d, { ...v, back: away })?.html ?? ''; } catch (e) { console.warn('[hq] a section of Numbers failed:', e); return ''; } }).join('');
  return `<div class="nx${none ? ' empty' : ''}">${top}
    <section data-nx="top">${tiles}</section>
    ${chat}${more}
    <section class="grid two">${funnel}<div class="stack">${perday}${countries}</div></section>
    ${own ? `<section class="grid two own">${own}</section>` : ''}
    <section class="grid two"><div class="stack">${abHtml}</div>${ads}</section>
    <section class="grid two">${targets}${promise}</section>
    <div class="tear">End of printout · tear here</div></div>`;
}

function section(s, d, f, label, sec) {
  const name = w => w == null ? 'Unknown' : f.what?.labels?.[w] ?? w;
  if (s.kind === 'what-orders') {
    const rows = d.what ?? [], tot = sum(rows.map(r => r.paid)), max = Math.max(1, ...rows.map(r => r.paid ?? 0));
    return `<div class="card">${sec(s.title ?? f.what?.title ?? 'What was ordered')}${rows.length ? hbars(rows.map(r => ({ key: esc(name(r.what)), v: r.paid ?? 0, cls: r.what == null ? 'neutral' : '', val: fig(int(r.paid), pct(ratio(r.paid, tot), 0)), title: `${name(r.what)}: ${int(r.paid)} paid, ${money(r.eur)}` })), max) : '<p class="nodata">No orders yet.</p>'}</div>`;
  }
  if (s.kind === 'step-what') {
    const counts = d.stepWhat?.[s.step] ?? [], byWhat = new Map((d.what ?? []).map(r => [r.what, r]));
    const keys = [...new Set([...counts.map(c => c.what), ...byWhat.keys()])];
    const rows = keys.map(k => ({ k, n: counts.find(c => c.what === k)?.n ?? 0, paid: byWhat.get(k)?.paid ?? 0 })).sort((a, b) => b.n - a.n || b.paid - a.paid);
    const max = Math.max(1, ...rows.map(r => Math.max(r.n, r.paid)));
    return `<div class="card">${sec(s.title ?? `${label(s.step)} against orders`)}${rows.length ? `<p class="legend"><span><i class="sw soft"></i>${esc(label(s.step).toLowerCase())}</span><span><i class="sw"></i>paid orders</span></p>`
      + hbars(rows.map(r => ({ key: esc(name(r.k)), v: r.paid, soft: r.n, cls: r.k == null ? 'neutral' : '', val: fig(`${int(r.paid)}/${int(r.n)}`, pct(ratio(r.paid, r.n), 0)), title: `${name(r.k)}: ${int(r.n)} ${label(s.step).toLowerCase()}, ${int(r.paid)} paid` })), max) : '<p class="nodata">Nothing counted yet.</p>'}</div>`;
  }
  if (s.kind === 'note') return `<div class="card">${sec(s.title ?? 'A note')}<p class="text">${esc(s.text ?? '')}</p></div>`;
  return `<div class="card">${sec(s.title ?? 'A section')}<p class="nodata">HQ can’t draw a “${esc(s.kind)}” section yet.</p></div>`;
}

// ---------------------------------------------------------------- a company's own dashboard (the printout)
// A kit's dashboard (template/kits/README.md, "Numbers"; kits.ts): its figures as the headline tiles, its daily the
// per-day chart (the first column) with the table, its bars and its targets, all drawn the way an app's are. Its period
// switches like an app's: the home is asked for those days, and the dashboard taken from it.
function companyIn(home, id) {
  const b = (home.dashboards ?? []).find(x => x.id === id);
  return b ? { ...b, days: home.days, from: home.from, to: home.to } : { missing: true };
}
// its picture: the icon the kit names (as an app's), or its rows of # and ., else a sigil from its id (both grid
// pictures: its initial where the look isn't pixel).
function companyIcon(b, cls = 'small') {
  if (typeof b.icon === 'string' && /^[\w-]+$/.test(b.icon)) return icon(b.icon, cls);
  const ok = Array.isArray(b.icon) && b.icon.length && b.icon.length <= 32 && b.icon.every(r => typeof r === 'string' && /^[#.]{1,32}$/.test(r) && r.length === b.icon[0].length);
  return gridOr(ok ? gridArt(['.'.repeat(b.icon[0].length + 2), ...b.icon.map(r => `.${r}.`), '.'.repeat(b.icon[0].length + 2)], cls) : sigil(b.id), b.name, cls);
}
const amount = (v, u) => u === 'EUR' ? money(v) : unitVal(v, u); // (euros as the apps' printouts show them: cents only under €100)
const figure = (f, i) => `<div class="tile${i ? '' : ' hero'}"><span class="l">${esc(f.label)}</span><span class="v">${f.value == null ? '—' : esc(typeof f.value === 'string' ? f.value : amount(Number(f.value), f.unit))}</span>${f.sub ? `<span class="s">${esc(f.sub)}</span>` : ''}</div>`;
const cell = (v, u) => v == null ? '—' : esc(amount(Number(v), u)); // (a count not known yet is a dash, never a 0)
function companyHtml(b, v) {
  const n = { i: 0 }, sec = title => head(++n.i, title), figures = (b.figures ?? []).filter(f => f && f.label != null);
  const top = `<div class="dot"><span>${esc(names.os)} Numbers · printout</span><span class="sig" data-nx-signal hidden>no signal · retrying</span></div>
    <div class="title">${companyIcon(b, 'small sigil')}<div><h1>${esc(b.name)}</h1><p>${b.about ? `${esc(b.about)} · ` : ''}Last ${int(b.days)} days · ${esc(range(b.from, b.to))}</p></div></div>
    <div class="ranges"><div class="range" role="group" aria-label="Period">${PERIODS.map(p => `<button data-days="${p}" aria-pressed="${p === v.days}">${p} days</button>`).join('')}</div></div>`;
  // (wide paper: the first figure a little wider, the rest in the same row)
  const tiles = figures.length ? `<section data-nx="top"><div class="tiles figs" style="--cols: 1.6fr repeat(${Math.max(1, Math.min(figures.length, 5) - 1)}, minmax(0, 1fr))">${figures.map(figure).join('')}</div></section>` : '';
  const daily = b.daily, dailyColumns = (daily?.columns ?? []).filter(c => c?.key), dailyRows = daily?.rows ?? [];
  const days = dailyColumns.length && dailyRows.length ? `<div class="card">${sec(daily.title ?? 'Per day')}<p class="sub">${esc(dailyColumns[0].label ?? dailyColumns[0].key)} a day${daily.sub ? `. ${esc(daily.sub)}` : '.'}</p>
    <div class="chart" data-nx-cols tabindex="0">${columns(dailyRows, dailyColumns[0].key, dailyColumns[0].label ?? dailyColumns[0].key)}</div><p class="read" data-nx-read>${dailyRows.some(r => Number(r[dailyColumns[0].key])) ? 'Tap or point at a day to read it.' : 'Nothing on any day yet.'}</p>
    <details data-k="days"><summary>As a table</summary><table><thead><tr><th>Day</th>${dailyColumns.map(c => `<th>${esc(c.label ?? c.key)}</th>`).join('')}</tr></thead><tbody>${dailyRows.slice().reverse().map(r => `<tr><td>${esc(dayName(r.day))}</td>${dailyColumns.map(c => `<td>${cell(r[c.key], c.unit)}</td>`).join('')}</tr>`).join('')}</tbody></table></details></div>` : '';
  const bars = (b.bars ?? []).map(bar => {
    const barRows = (bar.rows ?? []).map(r => ({ ...r, known: r.value != null, count: Number(r.value) || 0 })), barTotal = barRows.every(r => r.known) ? sum(barRows.map(r => r.count)) : null, max = Math.max(1, ...barRows.map(r => r.count));
    return `<div class="card">${sec(bar.title ?? 'A breakdown')}${bar.sub ? `<p class="sub">${esc(bar.sub)}</p>` : ''}${barRows.length ? hbars(barRows.map(r => ({ key: esc(r.label), v: r.count, val: fig(cell(r.value, r.unit), barTotal ? pct(r.count / barTotal, 0) : '') })), max) : '<p class="nodata">Nothing counted yet.</p>'}</div>`;
  }).join('');
  const targets = (b.targets ?? []).length ? targetsHtml(b.targets, sec, 'What the team works from.', '') : '';
  return `<div class="nx">${top}${tiles}
    ${days || bars || targets ? `<section class="grid two">${days}<div class="stack">${bars}${targets}</div></section>` : ''}
    <div class="tear">End of printout · tear here</div></div>`;
}
function wireCompany(el, b) {
  wirePeriod(el);
  const dailyColumns = (b.daily?.columns ?? []).filter(c => c?.key);
  wireChart(el, b.daily?.rows ?? [], x => `<b>${esc(dayName(x.day))}</b>: ${dailyColumns.map(c => `${cell(x[c.key], c.unit)} ${esc(String(c.label ?? c.key).toLowerCase())}`).join(' · ')}`);
}

function abCard(t, label, sec) {
  const [word, small, kind] = testWords(t), arms = t.arms ?? [], m = t.metric ?? [], g = t.guardrail;
  const rate = r => r == null ? '—' : pct(r, r < 0.1 ? 2 : 1);
  const arm = (a, i) => `<div class="side"><div class="top"><span class="k k${i}">${esc(a.letter)}</span><span class="lbl">${a.letter === 'A' ? 'as it is' : 'the change'}</span>
      <span class="reading"><span class="r">${rate(a.metric?.rate)}</span><small>${running(t) && t.state === 'not-called' ? 'so far' : ''}</small></span></div>
    <div class="prog"><i class="k${i}" style="width:${Math.min(100, 100 * (a.metric?.of ?? 0) / (t.finish || 1)).toFixed(1)}%"></i>${icon('finish', 'small')}</div>
    <div class="pl"><span><b class="f">${int(a.metric?.of)}</b> of ${int(t.finish)} ${esc(label(m[0]))}</span><span>${int(a.metric?.n)} ${esc(label(m[1]))}</span></div>
    ${a.guardrail ? `<div class="gr">Guardrail, ${esc(label(g?.[1]))} ÷ ${esc(label(g?.[0]))}: <b>${rate(a.guardrail.rate)}</b></div>` : ''}</div>`;
  const prog = Math.max(0, t.progress ?? 0);
  return `<div class="card ab">${sec(running(t) ? 'A/B test, running' : 'A/B test')}
    <div class="head"><h3>“${esc(t.id)}”</h3><div class="stamp ${kind}">${esc(word)}${small ? `<small>${esc(small)}</small>` : ''}</div></div>
    <p class="sub">${esc(t.question ?? '')}</p>
    <div class="finish"><div class="meter" role="img" aria-label="${pct(Math.min(prog, 1), 0)} of the way to the finish line"><i style="width:${Math.min(100, prog * 100).toFixed(1)}%"></i></div>
      <div class="dayl"><span><b class="f">${pct(Math.min(prog, 1), 0)}</b> to the finish line</span><span>${t.days != null ? `day ${int(t.days)}` : ''}${t.start ? ` · since ${esc(short(t.start))}` : ''}${t.end ? ` · ended ${esc(short(t.end))}` : ''}</span></div></div>
    <div class="sides">${arms.map(arm).join('')}</div>
    ${t.reason ? `<div class="verdict ${kind}">${esc(t.reason)}</div>` : ''}
    <p class="fine">Measures ${esc(label(m[1]))} ÷ ${esc(label(m[0]))}${g ? `; the guardrail, ${esc(label(g[1]))} ÷ ${esc(label(g[0]))}, mustn’t get worse` : ''}. Called at the finish line and after 14 days at the earliest, never by peeking. The server picks a version for each page load: no cookie.</p></div>`;
}
const abLine = (t, label) => { const [word, small] = testWords(t); return `<div class="card abline"><span class="nm">A/B “${esc(t.id)}”</span><span class="w">${esc(word)}${small ? `: ${esc(small)}` : ''}</span><span class="q">${esc(t.question ?? '')}${t.end ? ` Ended ${esc(short(t.end))}.` : ''}</span></div>`; };

const targetsHtml = (tg, sec, sub, none) => `<div class="card">${sec('The numbers we work from')}<p class="sub">${esc(sub)}</p>${tg.length ? `<div class="kpis">${tg.map(k => `
    <div class="kpi"><span class="nm">${esc(k.label)}</span><span class="tg">${esc(goalWords(k))}</span><span class="nw f">${k.value == null ? '' : esc(unitVal(k.value, k.unit))}</span><span class="mk">${mark(k)}</span></div>`).join('')}</div>`
    : `<p class="nodata">${esc(none)}</p>`}</div>`;
const unitVal = (v, u) => u === 'EUR' ? eur(v, v % 1 ? 2 : 0) : u === '%' ? `${num(v, v % 1 ? 1 : 0)}%` : `${num(v, v % 1 ? 2 : 0)}${u ? ` ${u}` : ''}`;
function goalWords(k) {
  const g = unitVal(k.goal, k.unit), m = k.max != null ? unitVal(k.max, k.unit) : null;
  return k.lower ? `target ${g} or less${m ? `, at most ${m}` : ''}` : `target ${g} or more${m ? `, at least ${m}` : ''}`;
}
const mark = k => k.mark === 'green' ? `<span class="ok">${icon('tick', 'small')}on target</span>` : k.mark === 'amber' ? `<span class="watch">${icon('eye', 'small')}watch</span>` : `<span class="nodat">${icon('dash', 'small')}no data yet</span>`;

// The support chat's line: its conversations, resolved without a person beside emails to a person (always read together),
// each a figure, and the way to Care › Numbers for the same app and mode, whose back button prints this dashboard again
// (its own back button still going where it went). A count it doesn't send yet is null: a dash, never a 0.
function chatLine(c) {
  const n = v => v == null ? '—' : int(v), per = v => v == null ? '' : `<span class="s">${num(v, v % 1 ? 1 : 0)} per 100</span>`;
  const chatFigure = (label, v, rate = '') => `<div class="tile"><span class="l">${label}</span><span class="v">${n(v)}</span>${rate}</div>`;
  return `<section class="card chat"><h2>The support chat</h2><div class="tiles">${chatFigure('Conversations', c.conversations)}${chatFigure('Resolved without a person', c.resolved, per(c.resolvedRate))}${chatFigure('Emails to a person', c.person, per(c.personRate))}</div>
    ${go.care ? '<button data-nx-care>Care › Numbers ›</button>' : ''}</section>`;
}

const missingHtml = v => `<div class="nx"><div class="title"><div><h1>${esc(v.name)}</h1><p>${v.company ? 'This dashboard isn’t available right now.' : 'These numbers can’t be had: the app may have lost its metrics file.'}</p></div></div><div class="tear">End of printout</div></div>`;

// the switches, and the per-day chart's reading line
function wireDash(el, d) {
  wirePeriod(el);
  el.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { if (b.dataset.mode === view.mode) return; view = { ...view, mode: b.dataset.mode }; reload(el); });
  // Care › Numbers for this app and mode; Care's back button comes back here
  el.querySelector('[data-nx-care]')?.addEventListener('click', () => { sfx.blip(); go.care({ slug: view.slug, name: view.name, status: view.status, mode: view.mode }, away); });
  // the company's own sections wire themselves: with this app and mode, and where the dashboard's back button goes
  for (const f of go.more) try { f(d, { ...view, back: away })?.wire?.(el); } catch (e) { console.warn('[hq] a section of Numbers failed:', e); }
  wireChart(el, d.daily ?? [], x => `<b>${esc(dayName(x.day))}</b>: ${int(x.paid)} paid · ${int(x.orders)} pressed Pay · ${int(x.steps?.page)} page loads · ${money(x.eur)}`);
}
// the per-day chart's reading line: tapping or pointing at a day (or the arrow keys) reads it, words(day) its line
function wireChart(el, daily, words) {
  const box = el.querySelector('[data-nx-cols]'), read = el.querySelector('[data-nx-read]');
  if (!box || !daily.length || !read) return;
  const svg = box.querySelector('svg'), cur = svg.querySelector('.cursor-col'), band = (COLS.w - COLS.L - COLS.R) / daily.length;
  let at = -1;
  const show = i => {
    at = Math.max(0, Math.min(daily.length - 1, i)); const x = daily[at];
    cur.classList.add('on'); cur.setAttribute('x', COLS.L + at * band); cur.setAttribute('width', band);
    read.innerHTML = words(x);
  };
  const pick = e => { const r = svg.getBoundingClientRect(); show(Math.floor(((e.clientX - r.left) / r.width * COLS.w - COLS.L) / band)); };
  svg.addEventListener('pointermove', pick); svg.addEventListener('pointerdown', pick);
  box.addEventListener('keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); show(at < 0 ? daily.length - 1 : at + (e.key === 'ArrowRight' ? 1 : -1)); } });
}
const wirePeriod = el => el.querySelectorAll('[data-days]').forEach(b => b.onclick = () => { if (Number(b.dataset.days) === view.days) return; view = { ...view, days: Number(b.dataset.days) }; reload(el); });
function reload(el) {
  sfx.blip();
  el.querySelector('.nx')?.classList.add('busy'); // the old printout stays, dimmed, until the new numbers are in
  paint(el).catch(() => el.querySelector('[data-nx-signal]')?.removeAttribute('hidden'));
}

// ---------------------------------------------------------------- printing: the paper feeds out of the slot
// The whole page comes down out of the slot at the top of the screen, bottom first: its "tear here" end shows first and
// the title arrives last, as the paper comes to rest. It moves a line at a time, each line a quick ease in time with the
// printer's rattle: short lines as it starts and as it comes to rest, long ones in between, and more of them the longer
// the page. Only the paper's transform moves, so the compositor runs it at the screen's own rate, and the sheet it feeds
// through is a screen high, so the browser rasters the page as it passes rather than all of it at once. It starts once
// the dashboard is laid out with its fonts in, so the feed never fights the first paint.
const unhold = el => el.querySelector('.feeding') || (el.style.overflowY = ''); // (unless another printout is feeding)
const LINE = 110, FEED = 24, LINE_EASE = 'cubic-bezier(.5, .1, .3, .9)'; // (ms a line, px the shortest line feed; an ease that never stops dead)
// The paper's way down, a line at a time: 6 lines, 2 more for each screen of page, the feed longest mid-page (sin²)
function lines(page, screen) {
  const n = 6 + 2 * Math.ceil(page / screen), rest = page - n * FEED;
  let at = -page;
  return [{ offset: 0, at }, ...Array.from({ length: n }, (_, i) => ({ offset: (i + 1) / n, at: at += FEED + rest * Math.sin(Math.PI * (i + .5) / n) ** 2 / (n / 2) }))];
}
async function printOut(el) {
  el.scrollTop = 0;
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  if (still.matches) return;
  const sheet = el.querySelector('.nx-sheet'), paper = sheet?.firstElementChild;
  if (!paper) return;
  // laid out, so its fonts start loading; a feeding sheet is only a screen high: keep the scroller's scrollbar, and the
  // paper its width
  if (paper.offsetHeight > el.clientHeight) el.style.overflowY = 'scroll';
  sheet.classList.add('feeding'); // (out of sight above the slot until it moves)
  // whatever happens from here, the paper comes to rest: at the end, on a failure, at once if reduced motion comes on
  let move = null;
  const stop = () => still.matches && move?.finish();
  still.addEventListener('change', stop);
  try {
    await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 1500))]);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (!sheet.isConnected || still.matches) return; // printed over by now (another app, the back button), or no motion
    const steps = lines(paper.offsetHeight, sheet.offsetHeight); // (the page; the screen, the sheet's height while it feeds)
    move = paper.animate(steps.map(({ offset, at }) => ({ offset, easing: LINE_EASE, transform: `translateY(${Math.round(at)}px)` })),
      { duration: (steps.length - 1) * LINE, fill: 'forwards' });
    // a dot-matrix printer: the head's rattle a line at a time, the paper advancing between lines
    for (let i = 0; i < steps.length - 1; i++) {
      for (let k = 0; k < 7; k++) noise(0.018, { vol: 0.035, at: i * LINE / 1000 + k * 0.016, freq: 2600 + (k % 3) * 700, q: 6 });
      tone(110, 0.05, { type: 'triangle', vol: 0.05, at: (i + .8) * LINE / 1000, cut: 600 });
    }
    await move.finished.catch(() => {}); // (cancelled: printed over)
  } finally {
    still.removeEventListener('change', stop);
    sheet.classList.remove('feeding'); move?.cancel(); unhold(el);
  }
}

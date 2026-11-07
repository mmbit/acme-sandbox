// HQ-OS › Numbers: dashboards as tiles on the CRT, each printed out on a tap
import { esc, stylesheet } from '../util.js';
import { loadNumbers, loadNumbersApp, loadApps } from './data.js';
import { appTile, appGroups, showTiles } from './tiles.js';
import { sfx, tone, noise } from './audio.js';
import * as world from '../world/world.js';
import { brand } from './brand.js';
import { count, money, range, wireChart } from './paper.js';
import { appPrintout, appReading, missingPrintout } from './printout.js';
import { companyIn, companyPrintout, companyReading, companyIcon } from './companyprintout.js';

let view = { slug: null, company: null, name: '', days: 28, mode: 'live', status: 'live' };
let shownEl = null,
  shown = '',
  seq = 0,
  feed = false;
// One app's dashboard opened from elsewhere in HQ-OS (Apps), and the way back there
let asked = null,
  away = null;
// desk.js's hooks: more, the company's own sections on a dashboard (its HQ apps' numbers(): template/kits/README.md);
// care(app, back), when the company runs care, opens Care › Numbers for the app, its back button calling back
let go = { more: [] };

// ---------------------------------------------------------------- what desk.js calls
// Each time the computer (re)draws Numbers: on opening it and every 15 s. A new screen element is a fresh opening.
export async function numbers(el, hooks) {
  if (hooks) go = { more: [], ...hooks };
  if (el !== shownEl) {
    shownEl = el;
    shown = '';
    away = asked?.back ?? null;
    const status = asked?.status === 'live' ? 'live' : 'preview';
    const mode = status === 'live' && asked?.mode === 'preview' ? 'preview' : status;
    view = asked
      ? { ...view, slug: asked.slug, company: null, name: asked.name, status, mode }
      : { ...view, slug: null, company: null };
    feed = !!asked;
    asked = null;
  }
  await stylesheet('shell/numbers.css');
  await paint(el);
}
// The header's back button, from a dashboard to where it was opened or the Numbers home (true), else the computer's
export function numbersBack() {
  if (!(view.slug || view.company) || !shownEl?.isConnected) return false;
  if (away) {
    const back = away;
    away = null;
    back();
    return true;
  }
  sfx.blip();
  view = { ...view, slug: null, company: null };
  shown = '';
  repaint(shownEl);
  return true;
}
// Open Numbers on one app's dashboard ({ slug, name, status, mode? }): the next time the computer draws Numbers, it
// prints that app's, and the header's back button calls `back`
export function numbersFor(app, back) {
  asked = { ...app, back };
}

async function paint(el) {
  const me = ++seq,
    v = { ...view },
    one = v.slug || v.company; // (one: a printout, else the home's tiles)
  let data;
  try {
    data = v.slug ? await loadNumbersApp(world.dev, v.slug, v.days, v.mode) : await homeData(v.days);
    if (v.company) data = companyIn(data, v.company);
  } catch (e) {
    if (me !== seq) return;
    if (v.slug && / 40[04]$/.test(e.message)) data = { missing: true };
    else if (shown)
      return el.querySelector('[data-nx-signal]')?.removeAttribute('hidden'); // keeps what's shown
    else {
      printer(el, false);
      throw e;
    }
  }
  if (me !== seq || !el.isConnected) return;
  const key = JSON.stringify([v, data]);
  if (key === shown) return el.querySelector('[data-nx-signal]')?.setAttribute('hidden', '');
  const open = [...el.querySelectorAll('details[data-k]')].filter(d => d.open).map(d => d.dataset.k);
  shown = key;
  crumb(el, one ? v.name : '');
  printer(el, !!one);
  if (!one) {
    showTiles(el, homeHtml(data));
    wireHome(el);
    return;
  }
  const paper = data.missing
    ? missingPrintout(v)
    : v.company
      ? companyPrintout(data, v)
      : appPrintout(data, v, { more: sections(data, v, s => s?.html ?? '').join(''), care: !!go.care });
  el.innerHTML = `<div class="nx-sheet">${paper}</div>`; // (the window the printout feeds through, numbers.css)
  for (const k of open) el.querySelector(`details[data-k="${k}"]`)?.setAttribute('open', '');
  wireSwitch(el, 'days', Number);
  if (v.company) wireChart(el, data.daily?.rows ?? [], companyReading(data));
  else wireDash(el, data);
  if (feed) {
    feed = false;
    printOut(el);
  }
}
const NO_SIGNAL = '<p><i class="prompt">&gt; </i>No signal from the coordinator. Retrying…<i class="cursor"></i></p>';
const repaint = el => paint(el).catch(() => (el.innerHTML = NO_SIGNAL));

function crumb(el, name) {
  const s = el.closest('.device')?.querySelector('header b span');
  if (s) s.textContent = ` › Numbers${name ? ` › ${name}` : ''}`;
}
// a dashboard turns the CRT into the printer: the screen becomes paper coming out of a slot
function printer(el, on) {
  const dev = el.closest('.device');
  el.closest('.crt')?.classList.toggle('nx-printer', on);
  dev?.classList.toggle('nx-wide', on);
  dev?.classList.toggle('nx-px', /pixelify/i.test(getComputedStyle(el).fontFamily)); // (the digits a pixel font blurs)
}

// ---------------------------------------------------------------- the home (on the CRT)
// The apps that count something in Apps' order, then the company's own dashboards in the order they come
async function homeData(days) {
  const [counted, apps] = await Promise.all([loadNumbers(world.dev, days), loadApps(world.dev)]);
  const order = appGroups(apps, brand.computer?.appGroups).flatMap(g => g.apps.map(a => a.slug));
  const place = a => (order.includes(a.slug) ? order.indexOf(a.slug) : order.length); // (one Apps doesn't list: last)
  const listed = (counted.apps ?? []).map(a => {
    const app = apps.find(x => x.slug === a.slug);
    return { ...a, icon: app?.icon ?? null, about: app?.about ?? '' };
  });
  return { ...counted, apps: listed.sort((a, b) => place(a) - place(b)) };
}
const PROMPT = '<i class="prompt">&gt; </i>';
function homeHtml(d) {
  const tiles = [...(d.apps ?? []).map(appTileHtml), ...(d.dashboards ?? []).map(dashboardTile)];
  const list = tiles.length
    ? `<ul class="applist">${tiles.join('')}</ul>`
    : `<p>${PROMPT}Nothing counts anything yet.</p>`;
  const broken = (d.broken ?? []).map(b => esc(b.slug)).join(', ');
  return `<div class="nxh">
    <p class="cap">${PROMPT}LAST ${count(d.days)} DAYS · ${esc(range(d.from, d.to).toUpperCase())}</p>
    ${list}
    ${broken ? `<p class="dim">${PROMPT}Can’t read the metrics file of ${broken}.</p>` : ''}
    <p class="hint">${PROMPT}Tap a tile to print its dashboard<i class="cursor"></i></p>
    <p class="foot">COUNTED FROM PAGE LOADS AND ORDERS · NO COOKIES · NO IP ADDRESSES</p></div>`;
}
const dim = text => `<span class="dim">${text}</span>`;
function appTileHtml(a) {
  const data = `data-nx-app="${esc(a.slug)}" data-status="${esc(a.status)}" data-name="${esc(a.name)}"`;
  const sales = dim(a.updated ? `${money(a.revenue)} · ${count(a.paid)} paid` : 'no data yet');
  return appTile(a, { data, lines: sales + (a.test ? dim(`A/B · ${HOME_TESTS[a.test.state] ?? 'RUNNING'}`) : '') });
}
function dashboardTile(b) {
  const data = `data-nx-company="${esc(b.id)}" data-name="${esc(b.name)}"`;
  const lines = b.tile ? dim(esc(b.tile)) : '';
  return appTile({ name: String(b.name), about: String(b.about ?? '') }, { data, pic: companyIcon(b), lines });
}
const HOME_TESTS = {
  'not-started': 'NOT STARTED YET',
  'not-called': 'NOT CALLED YET',
  'split-drifted': 'SPLIT DRIFTED: STOP AND FIX',
  won: 'A WINNER IS IN',
  lost: 'CALLED: KEEP A',
  'no-difference': 'NO DIFFERENCE: KEEP A',
  'six-weeks': 'SIX WEEKS, NO WINNER: KEEP A',
};
// A tap prints the tile's dashboard: an app's in its own status, a company's live
function wireHome(el) {
  el.querySelectorAll('[data-nx-app], [data-nx-company]').forEach(b => {
    const { nxApp = null, nxCompany = null, name, status } = b.dataset;
    const mode = nxCompany || status === 'live' ? 'live' : 'preview';
    b.onclick = () => {
      view = { ...view, slug: nxApp, company: nxCompany, name, status: mode, mode };
      sfx.blip();
      feed = true;
      repaint(el);
    };
  });
}

// ---------------------------------------------------------------- a printout's switches and links
function wireDash(el, d) {
  wireSwitch(el, 'mode', String);
  // Care › Numbers for this app and mode; Care's back button comes back here
  el.querySelector('[data-nx-care]')?.addEventListener('click', () => {
    sfx.blip();
    go.care({ slug: view.slug, name: view.name, status: view.status, mode: view.mode }, away);
  });
  sections(d, view, s => s?.wire?.(el));
  wireChart(el, d.daily ?? [], appReading);
}
// The company's own sections, each its { html, wire }: given this app and mode, and where the back button goes
const sections = (d, v, use) =>
  go.more.map(f => {
    try {
      return use(f(d, { ...v, back: away }));
    } catch (e) {
      console.warn('[hq] a section of Numbers failed:', e);
      return '';
    }
  });
// A switch on the printout (data-days, data-mode) prints it again with its value
function wireSwitch(el, key, parse) {
  el.querySelectorAll(`[data-${key}]`).forEach(b => {
    b.onclick = () => {
      const picked = parse(b.dataset[key]);
      if (picked === view[key]) return;
      view = { ...view, [key]: picked };
      sfx.blip();
      el.querySelector('.nx')?.classList.add('busy'); // the old printout stays, dimmed, until the new numbers are in
      paint(el).catch(() => el.querySelector('[data-nx-signal]')?.removeAttribute('hidden'));
    };
  });
}

// ---------------------------------------------------------------- printing: the paper feeds out of the slot
// The page comes down out of the slot bottom first, a line at a time in time with the printer's rattle. Only the
// paper's transform moves, so the compositor runs it at the screen's own rate, and the sheet it feeds through is a
// screen high, so the browser rasters the page as it passes. It starts once the page is laid out with its fonts in, so
// the feed never fights the first paint.
const LINE = 110,
  FEED = 24,
  LINE_EASE = 'cubic-bezier(.5, .1, .3, .9)'; // (ms a line, px the shortest line feed; an ease that never stops dead)
// The paper's way down, a line at a time: 6 lines, 2 more for each screen of page, the feed longest mid-page (sin²)
function lines(page, screen) {
  const n = 6 + 2 * Math.ceil(page / screen),
    rest = page - n * FEED;
  let at = -page;
  return [
    { offset: 0, at },
    ...Array.from({ length: n }, (_, i) => ({
      offset: (i + 1) / n,
      at: (at += FEED + (rest * Math.sin((Math.PI * (i + 0.5)) / n) ** 2) / (n / 2)),
    })),
  ];
}
async function printOut(el) {
  el.scrollTop = 0;
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  if (still.matches) return;
  const sheet = el.querySelector('.nx-sheet'),
    paper = sheet?.firstElementChild;
  if (!paper) return;
  // laid out, so its fonts start loading; a feeding sheet is a screen high: keep the scrollbar, and the paper its width
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
    const steps = lines(paper.offsetHeight, sheet.offsetHeight); // (the screen: the sheet's height while it feeds)
    move = paper.animate(
      steps.map(({ offset, at }) => ({ offset, easing: LINE_EASE, transform: `translateY(${Math.round(at)}px)` })),
      { duration: (steps.length - 1) * LINE, fill: 'forwards' },
    );
    // a dot-matrix printer: the head's rattle a line at a time, the paper advancing between lines
    for (let i = 0; i < steps.length - 1; i++) {
      for (let k = 0; k < 7; k++)
        noise(0.018, { vol: 0.035, at: (i * LINE) / 1000 + k * 0.016, freq: 2600 + (k % 3) * 700, q: 6 });
      tone(110, 0.05, { type: 'triangle', vol: 0.05, at: ((i + 0.8) * LINE) / 1000, cut: 600 });
    }
    await move.finished.catch(() => {}); // (cancelled: printed over)
  } finally {
    still.removeEventListener('change', stop);
    sheet.classList.remove('feeding');
    move?.cancel();
    if (!el.querySelector('.feeding')) el.style.overflowY = ''; // (unless another printout is feeding)
  }
}

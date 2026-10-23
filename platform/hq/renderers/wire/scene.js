// Slate: the company at work as a board of square keys, one per agent, set out by department in thin frames, with the
// company's day on a wide key first and the lent machines and the mascots last. A key at work shows the job and the
// pace of its tokens; one at rest shows its week. They drop onto the board as HQ opens, a tap presses one out big (its
// work and its log; another tap turns it over to what it did last, its week and who it is), a message flies from key to
// key, and in "at work first" the keys slide into their new places like a slide puzzle. Drawn in the DOM, which scrolls
// natively; the shell's canvas lies under it, empty, and the page hands its taps to the shell (shell.tap), which asks
// hit() what's there.
import { esc, mins, store, rgb, roleHtml } from '../../util.js';
import { contrastChannels } from '/contrast.js'; // WCAG's contrast ratio (shared/contrast/contrast.js)
import { EMOTES, fade } from '../../world/emotes.js';
import { companyFormats } from '../../world/clock.js';
import { makeLook, spriteFrame, catFrame, penguinFrame } from '../brownstone/sprites.js';
import { loadWork, loadJobs, loadJobLog } from '../../shell/data.js';
import { titleHtml } from '../../shell/jobs.js';
import { jobNameLink } from '../../shell/prose.js';
import { engineMark } from '../../shell/engine.js';
import { icon } from '../../shell/icons.js';
import { sides } from '../../shell/sides.js';
import { theme } from '../../shell/brand.js';
import { sfx as keys } from './sounds.js';
import { pace } from './pace.js';
// Slate's motion, the brand guide's too (shared/tactile).
import { pressBriefly } from '../../../../shared/tactile/press.js';
import { flip } from '../../../../shared/tactile/flip.js';
import { flyOut, flyBack, zoomIn } from '../../../../shared/tactile/fly.js';
import { followSwipes, slideIn } from '../../../../shared/tactile/swipe.js';
import { dropTiles } from '../../../../shared/tactile/drop.js';

export const info = {
  id: 'wire', // (what a viewer's pick and theme/hq.yaml store)
  name: 'Slate',
  context: '2d',
  label: 'The work itself: a key per agent, what they are on and how fast it goes',
};

const HOLD = 8; // a tour stop
const GAP = 10, // between keys (skin.css --g)
  SIDE = 196; // a key's side on a wide screen; on a phone two fill the width
const ART = { cat: { frame: catFrame, sound: 'meow' }, penguin: { frame: penguinFrame, sound: 'squawk' } };
const STATE = { working: 'At work', waiting: 'Queued', sleeping: 'Asleep', idle: 'Idle' };
const COMPANY = '(company)'; // the company key's id (no agent's: ids are plain words)
const USE = [
  ['cpu', 'CPU'],
  ['memory', 'memory'],
  ['gpu', 'GPU'],
]; // a machine's use, as it reports it (the big rig's graph)
const TAIL = 6; // the big rig's lines of its run's output
const RESTING_BARS = 14; // a rig at rest's last reports, as bars on its key
const STATS = [
  ['lines', 'lines changed'],
  ['tests', 'tests passed'],
  ['prs', 'pull requests merged'],
  ['jobs', 'jobs finished'],
  ['tokens', 'tokens written'], // (the big key's)
];
// the rig's face: a desktop tower, its fan turning while it computes
const CLOSE = `<button class="close" aria-label="Close">${icon('close')}</button>`;
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// One scene at a time
let S, world, shell, cv, root;

export function createScene({ canvas, world: w, shell: s, settings }) {
  world = w;
  shell = s;
  cv = canvas;
  root = document.createElement('div');
  root.className = 'wire';
  root.innerHTML =
    '<div class="board"></div><div class="flights" aria-hidden="true"></div><div class="solo" hidden></div>';
  document.body.prepend(root);
  S = {
    tiles: [],
    top: 0,
    side: 150,
    solo: null,
    card: null,
    origin: null, // (what the big key flew out of, when not its own key: solo)
    days: null,
    week: {},
    jobs: null,
    lit: null,
  };
  appear();
  layout();
  build();
  numbers();
  touch();
  if (settings?.intro) drop();
  const offHud = hud();
  const poll = setInterval(numbers, 60_000),
    tick = setInterval(paintAll, 15_000),
    offs = listen(),
    dark = matchMedia('(prefers-color-scheme: dark)');
  dark.addEventListener('change', appear);
  const watch = new ResizeObserver(() => layout());
  for (const el of document.querySelectorAll('#status, #hud .brand, #hud .tools')) watch.observe(el);
  return {
    update,
    draw,
    hit,
    focus,
    resize,
    camera,
    anchor,
    act,
    portrait,
    says: true, // (a message flies from key to key: the shell shows no bubble for it)
    // (a focus on an agent brings their key out big, over whatever is open, so the shell opens no panel for it; carded:
    // whether one is out.)
    cards: true,
    carded: () => S.solo !== null,
    near: () => false,
    where: () => null,
    showcase,
    controls: [],
    highlight: t => {
      S.lit = t?.kind === 'agent' ? t.id : null;
    },
    dispose() {
      offHud();
      for (const off of offs) off();
      clearInterval(poll);
      clearInterval(tick);
      dark.removeEventListener('change', appear);
      watch.disconnect();
      document.body.classList.remove('wire-dark', 'keys');
      for (const k of [...WAY, 'font', 'tick']) document.body.style.removeProperty(`--k-${kebab(k)}`);
      root.remove();
    },
    dev: { S: () => S, focus },
  };
}

// ---------------------------------------------------------------- the HUD, Wire's way
// The brand's plate brings rain (its sound, and drops behind the keys) and takes it away again, kept on this device. A
// logo with a part in the accent (logo()) is drawn in the colourway in use, and its accent part turns on the next one. On
// a phone the sound, music and tour keys fold behind one (More), so the board keeps the screen.
function hud() {
  const plate = document.querySelector('#hud .brand'),
    tools = document.querySelector('#hud .tools'),
    more = Object.assign(document.createElement('button'), { id: 'btn-more', title: 'More' });
  more.setAttribute('aria-expanded', 'false');
  more.innerHTML = `${icon('more')}<span class="sr">More</span>`;
  more.onclick = () => {
    more.setAttribute('aria-expanded', String(tools.classList.toggle('more-open')));
    keys.press();
  };
  tools?.append(more);
  const drawn = logo(plate);
  const overAccent = e => {
    const o = plate.querySelector('.logo-accent')?.getBoundingClientRect();
    return !!o && Math.abs(e.clientX - o.left - o.width / 2) < o.width / 2 + 10; // (its column, roomy)
  };
  const rain = e => {
    if (overAccent(e)) return recolour(plate);
    S.rain = !S.rain;
    store.set('wire.rain', S.rain);
    keys.press();
  };
  plate?.addEventListener('click', rain);
  // (a mouse over the accent part presses it in a little, as over a tile: skin.css .over-accent)
  const over = e =>
    plate.classList.toggle('over-accent', e.type === 'pointermove' && e.pointerType === 'mouse' && overAccent(e));
  plate?.addEventListener('pointermove', over);
  plate?.addEventListener('pointerleave', over);
  S.rain = store.get('wire.rain', false);
  return () => {
    more.remove();
    tools?.classList.remove('more-open');
    plate?.removeEventListener('click', rain);
    plate?.removeEventListener('pointermove', over);
    plate?.removeEventListener('pointerleave', over);
    plate?.classList.remove('over-accent');
    drawn.then(svg => {
      svg?.remove();
      if (plate) plate.querySelector('img').hidden = false;
    });
    shell.sound.weather(0, 0, 0);
  };
}
// The logo inline, when it has a part in the accent: its parts drawn in the first colourway's accent, side and ink
// (theme/hq.yaml) take the colourway in use. Any other logo stays the picture it is.
async function logo(plate) {
  const img = plate?.querySelector('img'),
    [first] = ways(),
    text = img
      ? await fetch(img.src).then(
          r => (r.ok ? r.text() : ''),
          () => '',
        )
      : '',
    svg = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
  if (svg?.nodeName !== 'svg' || !img.isConnected) return null;
  for (const el of svg.querySelectorAll('script, foreignObject')) el.remove();
  for (const el of svg.querySelectorAll('[fill]')) {
    const part = ['accent', 'side', 'ink'].find(k => el.getAttribute('fill').toLowerCase() === first[k].toLowerCase());
    if (part) el.setAttribute('class', `logo-${part}`);
  }
  if (!svg.querySelector('.logo-accent')) return null;
  svg.setAttribute('class', 'logo');
  img.hidden = true;
  img.after(svg);
  return svg;
}
// the next colourway on, the logo's accent part pressed down
function recolour(plate) {
  const all = ways();
  store.set('wire.colourway', all[(all.indexOf(colourway()) + 1) % all.length].id);
  appear();
  keys.press();
  if (!still())
    for (const p of plate.querySelectorAll('.logo-accent'))
      p.animate([{ transform: 'none' }, { transform: 'translateY(90px)', offset: 0.35 }, { transform: 'none' }], 220);
}
// (every frame, as the brownstone's: the sound only sets in once a tap has woken it, and it skips a level it has)
const weather = () => shell.sound.weather(S.rain ? 0.7 : 0, document.body.classList.contains('wire-dark') ? 0.6 : 0, 0);
// the rain, drawn on the canvas behind the keys: thin slanted streaks in the colourway's muted ink
function rainfall(dt) {
  const g = cv.getContext('2d'),
    w = cv.width,
    h = cv.height;
  g.clearRect(0, 0, w, h);
  if (!S.rain) return (S.drops = []);
  S.drops ??= [];
  while (S.drops.length < (w * h) / 9000)
    S.drops.push({
      x: Math.random() * w,
      y: Math.random() * -h,
      v: 700 + Math.random() * 500,
      l: 10 + Math.random() * 14,
    });
  g.strokeStyle = getComputedStyle(document.body).getPropertyValue('--k-muted');
  g.globalAlpha = 0.35;
  g.lineWidth = 1.5;
  g.beginPath();
  for (const d of S.drops) {
    d.y += d.v * dt;
    d.x -= d.v * dt * 0.18;
    if (d.y > h) Object.assign(d, { y: -d.l, x: Math.random() * (w + 100) });
    g.moveTo(d.x, d.y);
    g.lineTo(d.x + d.l * 0.18, d.y - d.l);
  }
  g.stroke();
  g.globalAlpha = 1;
}

// ---------------------------------------------------------------- the look's own settings (Settings › Look)
// The company's colourways (theme/hq.yaml wire.colourways: id, name, ground, ink, muted, panel, accent, side,
// onAccent, as #hex; wire.font: family, href on Google Fonts), or a light and a dark one of Wire's own. Auto: the first
// light one, or the first dark one when the device is dark. And the keys' order: the org chart's, or everyone at work
// first. Each is kept on this device.
const WAY = ['ground', 'ink', 'muted', 'panel', 'accent', 'side', 'onAccent'];
const HEX = /^#[0-9a-f]{3,8}$/i;
const WIRE_WAYS = [
  {
    id: 'day',
    name: 'Day',
    ground: '#ece6da',
    ink: '#1d1b17',
    muted: '#5c554a',
    panel: '#f7f3ec',
    accent: '#d6ea3c',
    side: '#8f9f14',
    onAccent: '#1d1b17',
  },
  {
    id: 'night',
    name: 'Night',
    ground: '#15171c',
    ink: '#ece8e0',
    muted: '#a39e94',
    panel: '#20232a',
    accent: '#d6ea3c',
    side: '#7d8c10',
    onAccent: '#15171c',
  },
];
const ways = () => {
  const own = (theme.wire?.colourways ?? []).filter(w => w?.id && WAY.every(k => HEX.test(w[k] ?? '')));
  return own.length ? own : WIRE_WAYS;
};
const kebab = k => k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
// a ground dark enough for light letters (its relative luminance)
const darkGround = hex => {
  const [r, g, b] = (hex.length < 7 ? [...hex.slice(1, 4)].map(c => c + c) : hex.slice(1, 7).match(/../g)).map(
    c => parseInt(c, 16) / 255,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.4;
};
function colourway() {
  const all = ways(),
    pick = store.get('wire.colourway', 'auto'),
    dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return (pick !== 'auto' && all.find(w => w.id === pick)) || all.find(w => darkGround(w.ground) === dark) || all[0];
}
function appear() {
  const body = document.body,
    way = colourway(),
    font = theme.wire?.font;
  for (const k of WAY) body.style.setProperty(`--k-${kebab(k)}`, way[k]);
  body.style.setProperty('--k-tick', tickOn(way.onAccent));
  if (font?.family) body.style.setProperty('--k-font', `'${String(font.family).replace(/['"\\]/g, '')}'`);
  if (/^https:\/\/fonts\.googleapis\.com\//.test(font?.href ?? '') && !document.querySelector('link[data-wire-font]')) {
    const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: font.href });
    link.dataset.wireFont = '';
    document.head.append(link);
  }
  body.classList.toggle('wire-dark', darkGround(way.ground));
  body.classList.add('keys'); // (every button a key: style.css)
}
// A ticked box's tick, in the colour of the accent's words: a background image (skin.css), which takes no CSS colour.
const tickOn = colour =>
  `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${encodeURIComponent(colour)}' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'><path d='m4.5 12.5 5 5 10-11'/></svg>")`;
const rows = () => [
  {
    cap: 'COLOUR',
    key: 'wire.colourway',
    fallback: 'auto',
    picks: [['auto', 'Auto'], ...ways().map(w => [w.id, w.name ?? w.id, w])],
  },
  {
    cap: 'ORDER',
    key: 'wire.order',
    fallback: 'busy',
    then: () => build(),
    picks: [
      ['busy', 'At work first'],
      ['org', 'Org chart'],
    ],
  },
];
export function settings(el) {
  const draw = () => {
    const list = rows();
    el.innerHTML = list
      .map(
        ({ cap, key, fallback, picks }) =>
          `<p class="cap">&gt; ${cap}</p><p class="acts">${picks
            .map(
              ([k, label, w]) =>
                `<button data-key="${key}" data-pick="${esc(k)}" aria-pressed="${k === store.get(key, fallback)}">${w ? `<i class="swatch" style="--t:${w.ground};--s:${w.accent}"></i>` : ''}${esc(label)}</button>`,
            )
            .join('')}</p>`,
      )
      .join('');
    el.querySelectorAll('[data-pick]').forEach(b => {
      b.onclick = () => {
        store.set(b.dataset.key, b.dataset.pick);
        if (root?.isConnected) (list.find(x => x.key === b.dataset.key).then ?? appear)();
        draw();
      };
    });
  };
  draw();
}

// ---------------------------------------------------------------- the board: keys in one grid, by department
// The company's key (two wide), then everyone in the org chart's order (or everyone at work first, whatever their
// department, then the rest), then the lent machines, then the mascots by the room they live in. A key that moves
// slides to its new place.
function build() {
  const kept = new Map(S.tiles.map(t => [t.id, t])),
    busy = store.get('wire.order', 'busy') === 'busy',
    working = x => world.agents.get(x.id)?.state === 'working';
  let people = world.rooms
    .filter(r => r.deptId && r.agentIds.some(id => !world.agents.get(id)?.data.board))
    .flatMap(r => r.agentIds.filter(id => world.agents.has(id)).map(id => ({ kind: 'agent', id })));
  if (busy) people = [...people.filter(working), ...people.filter(x => !working(x))];
  const homes = new Map();
  for (const m of world.mascots) {
    const name = world.rooms.find(r => r.id === m.home)?.name ?? 'Mascots';
    homes.set(name, [...(homes.get(name) ?? []), { kind: 'mascot', id: m.id }]);
  }
  const list = [
    { name: '', tiles: [{ kind: 'company', id: COMPANY }] },
    { name: '', tiles: people },
    { name: '', tiles: machines().map(m => ({ kind: 'machine', id: machineId(m) })) },
    ...[...homes].map(([name, tiles]) => ({ name, tiles })),
  ];
  const was = S.tiles[S.solo]?.id,
    before = new Map(S.tiles.map(t => [t, t.slot.getBoundingClientRect()]));
  S.tiles = list.flatMap(g => g.tiles.map(x => kept.get(x.id) ?? tile(x)));
  for (const t of kept.values()) if (!S.tiles.includes(t)) t.slot.remove();
  const board = root.querySelector('.board');
  if ([...board.children].some((el, i) => el !== S.tiles[i]?.slot) || board.children.length !== S.tiles.length)
    board.replaceChildren(...S.tiles.map(t => t.slot));
  if (S.solo !== null) {
    const i = S.tiles.findIndex(t => t.id === was);
    if (i < 0) leave();
    else S.solo = i;
  }
  paintAll();
  slide(before);
}
function tile(t) {
  const x = { ...t };
  x.el = key(x);
  x.slot = document.createElement('div');
  x.slot.className = t.kind === 'company' ? 'slot wide' : 'slot';
  x.slot.append(x.el);
  return x;
}
// The machines lent to the company that are on, a key each beside the mascots (world.rigs), and a key's id
const machines = () => world.rigs();
const machineId = m => `(machine) ${m.id}`;
const machineOf = t => machines().find(m => machineId(m) === t.id);
// A key's markup: small on the board; big (solo) it has two faces, a close button and room for the log
function key(t, big = false) {
  const el = document.createElement('article');
  el.className = `key ${t.kind}${big ? ' big' : ''}`;
  if (t.kind === 'company') {
    el.innerHTML = `<header class="id"><b>Today</b><small class="date"></small></header><div class="stats"></div>`;
  } else if (t.kind === 'agent') {
    const A = world.agents.get(t.id),
      look = makeLook(A.data),
      head = `<header class="head"><div class="avatar"><div class="face"></div><svg viewBox="0 0 76 76" aria-hidden="true"><circle cx="38" cy="38" r="35"/></svg><b class="emote"></b></div>
        <div class="id"><b>${esc(A.data.name ?? A.id)}</b><small>${roleHtml(A.data)}</small></div></header>`;
    el.style.setProperty('--hue', look.shirt);
    // (each face's corner says it turns over, in the job sheet's icon for it.)
    const turns = `<span class="turns">${icon('redo')}</span>`;
    el.innerHTML = big
      ? `<div class="faces"><section class="front">${head}<span class="state"></span><p class="doing"></p><ol class="log"></ol><footer class="pace"></footer>${turns}</section>
        <section class="back">${head}<div class="last"><span class="lbl">Last finished</span><p></p></div><div class="next"><span class="lbl">Up next</span><p></p></div><div class="week"></div><p class="who"></p>${turns}</section></div>`
      : `${head}<b class="clock"></b><p class="doing"></p><footer class="foot"></footer>`;
    for (const face of el.querySelectorAll('.face'))
      face.append(sprite(spriteFrame(A.id, look, 'stand', true, true), 'me'));
  } else if (t.kind === 'machine') {
    const hint = big ? ' title="Status and settings"' : ''; // (big, its face opens them)
    const head = `<header class="head"><div class="avatar"${hint}><div class="face"></div><svg viewBox="0 0 76 76" aria-hidden="true"><circle cx="38" cy="38" r="35"/></svg></div>
      <div class="id"><b class="name"></b><small class="what"></small></div></header>`;
    el.innerHTML = big
      ? `${head}<p class="doing"></p><p class="whose"></p><footer class="foot"></footer><div class="usage"></div><ol class="tail"></ol>`
      : `${head}<p class="doing"></p><footer class="foot"></footer>`;
  } else {
    const m = world.mascots.find(x => x.id === t.id);
    el.innerHTML = `<div class="stage"><canvas width="14" height="12" aria-label="${esc(m.name)}"></canvas></div><div class="id"><b>${esc(m.name)}</b><small>${esc(m.role ?? '')}</small></div>`;
    Object.assign(el, { pet: { x: 0, dir: 1, doing: 'sit', until: 0 } });
  }
  if (big) el.insertAdjacentHTML('beforeend', CLOSE);
  return el;
}
// a pixel picture as its own canvas (a cached frame can't be in two places)
function sprite(src, cls) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.className = cls;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

// ---------------------------------------------------------------- what a key says, on the board and, the one out, big
function paintAll() {
  S.tiles.forEach(paint);
}
function paint(t) {
  for (const el of [t.el, S.tiles[S.solo] === t && S.card]) {
    if (!el) continue;
    if (t.kind === 'company') company(el);
    if (t.kind === 'agent') agent(el, t);
    if (t.kind === 'machine') machine(el, machineOf(t));
  }
}
function company(el) {
  const big = el.classList.contains('big');
  set(el.querySelector('.date'), companyFormats().day(companyFormats().today(), 'en', { weekday: true }));
  if (!S.days?.length) return;
  const today = S.days.at(-1),
    stat = ([k, label]) => {
      const all = S.days.map(d => d[k]),
        tips = S.days.map(
          (d, i) =>
            `${i === S.days.length - 1 ? 'Today' : long(d.day)}: ${d[k] === null ? 'not counted yet' : `${d[k].toLocaleString('en')} ${label}`}`,
        );
      return `<div class="stat"><b>${big && k === 'tokens' ? thousands(today[k] ?? 0) : (today[k] ?? 0).toLocaleString('en')}</b><small>${label}</small>${bars(all, big ? 280 : 140, big ? 40 : 24, { tips })}</div>`;
    };
  if (!big) return set(el.querySelector('.stats'), STATS.slice(0, 4).map(stat).join(''));
  // big: the day's five numbers, each over the last 14 days (a bar's title says which day), and the company now
  const people = [...world.agents.values()].filter(A => !A.data.board),
    at = s => people.filter(A => A.state === s).length,
    speed = people.reduce((n, A) => n + (A.state === 'working' ? (paceNow(A) ?? 0) : 0), 0),
    leaders = (k, label) => {
      const top = Object.entries(S.week)
        .filter(([id, w]) => w[k] > 0 && world.agents.has(id))
        .sort((a, b) => b[1][k] - a[1][k])
        .slice(0, 3);
      return top.length
        ? `<div class="board-list"><span class="lbl">${label}</span>${top.map(([id, w]) => `<p><b>${esc(world.agents.get(id).data.name ?? id)}</b><span>${w[k]}</span></p>`).join('')}</div>`
        : '';
    };
  set(
    el.querySelector('.stats'),
    `${STATS.map(stat).join('')}<p class="span">The bars: the last 14 days, today on the right.</p>
    <div class="now"><span class="lbl">Right now</span><p><b>${at('working')}</b> at work · <b>${at('waiting')}</b> queued · <b>${at('sleeping')}</b> asleep${speed ? ` · <b>${thousands(speed)}</b> tokens a minute` : ''}</p></div>
    ${leaders('jobs', 'Jobs this week')}${leaders('prs', 'Merged this week')}`,
  );
}
// A lent machine (the rig), keyed like an agent. Its ring turns while a run is on it, and its state says how long it's
// been at it; what it's doing is the run's title, and under it a light for each core the run's kind gives it, as many
// lit as its CPU is busy when it says so, with one figure (that CPU, or the cores). Big, whose job the run is and of
// which kind, then, when the machine reports them, its use over the last minutes and the run's last lines of output.
function machine(el, m) {
  if (!m) return;
  const run = m.running,
    big = el.classList.contains('big'),
    who = run && esc(world.agents.get(run.agent)?.data.name ?? run.agent),
    since = run?.since ? Date.parse(run.since) : null,
    cpu = m.cpu?.at(-1),
    shown = Math.min(run?.cores ?? 0, 32),
    lit = cpu === undefined ? shown : Math.round((shown * cpu) / 100),
    lights = Array.from({ length: shown }, (_, i) => (i < lit ? '<i></i>' : '<i class="off"></i>')).join(''),
    figure =
      !big && cpu !== undefined ? `<b>${Math.round(cpu)}%</b> CPU` : run?.cores ? `<b>${run.cores}</b> cores` : '';
  el.classList.toggle('working', !!run);
  el.classList.toggle('offline', !m.present);
  dress(el, m);
  set(el.querySelector('.name'), esc(m.name.charAt(0).toUpperCase() + m.name.slice(1)));
  set(
    el.querySelector('.what'),
    run ? (since ? `Computing · ${ago(since)}` : 'Computing') : m.present ? 'Ready for work' : 'Away',
  );
  set(
    el.querySelector('.doing'),
    run
      ? run.title
        ? titleHtml({ title: run.title })
        : `Job ${jobNameLink(run.job, run.job_code)}` // (its job a link to it)
      : m.present
        ? 'Waiting for a long run'
        : 'Not asking for work',
  );
  set(
    el.querySelector('.whose'),
    run ? `${who}’s job ${jobNameLink(run.job, run.job_code)}${run.kind ? `, a ${esc(run.kind)} run` : ''}` : '',
  );
  const load = [figure, !big && who].filter(Boolean).join(' · ');
  set(
    el.querySelector('.foot'),
    run ? `<span class="cores" aria-hidden="true">${lights}</span><small>${load}</small>` : big ? '' : resting(m),
  );
  set(el.querySelector('.usage'), usage(m));
  set(
    el.querySelector('.tail'),
    (run?.output ?? [])
      .slice(-TAIL)
      .map(line => `<li>${esc(line)}</li>`)
      .join(''),
  );
}
const LIGHT_INK = '#8b8b97',
  DARK_INK = '#1c1a17';
// Its face: a tower as big a build as it is, in the colours the board gave it: the case and, in its lights' colour, the
// ring, the fans and the bars.
function dress(el, m) {
  set(el.querySelector('.face'), tower(m));
  const body = m.body && rgb(m.body);
  const ink =
    body && (contrastChannels(rgb(LIGHT_INK), body) > contrastChannels(rgb(DARK_INK), body) ? LIGHT_INK : DARK_INK);
  for (const [name, value] of [
    ['--hue', m.glow],
    ['--rig-body', m.body],
    ['--rig-ink', ink],
  ])
    if (value) el.style.setProperty(name, value);
    else el.style.removeProperty(name);
}
// The tower (world.js rigSize): 1 a small case with a fan, 2 a tower with a bigger one, 3 a wide one with three fans down
// its front and, behind the glass, a card for each GPU (three at most) over a light strip
// (paths only: the avatar's ring is its one circle)
function tower({ size, gpuCount }) {
  const box = (x, y, w, h, r) =>
      `<path d="M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 -${r} ${r}h-${w - 2 * r}a${r} ${r} 0 0 1 -${r} -${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r} -${r}z"/>`,
    fan = (x, y, r) => `<path class="fan" d="M${x} ${y - r}a${r} ${r} 0 1 1 0 ${2 * r}a${r} ${r} 0 1 1 0 -${2 * r}z"/>`,
    cards = Array.from({ length: Math.min(gpuCount, 3) }, (_, i) => `<path class="card" d="M12.5 ${10 + i * 3.5}h5"/>`);
  const parts = [
    `${box(7, 7.5, 10, 14, 2)}<path d="M9.5 10.5h5"/>${fan(12, 16, 2.8)}`,
    `${box(6, 2.5, 12, 19, 2.5)}<path d="M9.5 6h5"/>${fan(12, 14, 3.5)}`,
    `${box(3.5, 1.5, 17, 21, 2)}${[6, 12, 18].map(y => fan(7.5, y, 2.2)).join('')}${cards.join('')}<path class="strip" d="M12.5 19.5h5"/>`,
  ];
  return `<svg class="tower size-${size}" viewBox="0 0 24 24" aria-hidden="true">${parts[size - 1]}</svg>`;
}
// A machine at rest on the board: its CPU over its last reports as bars, the way an agent's key shows its week, and its
// use now under them; nothing for a machine that doesn't say.
const resting = m =>
  m.cpu?.length
    ? `${bars(m.cpu.slice(-RESTING_BARS), 120, 22, { scale: 100 })}<small>${USE.filter(([k]) => m[k]?.length)
        .map(([k, label]) => `<b>${Math.round(m[k].at(-1))}%</b> ${label}`)
        .join(' · ')}</small>`
    : '';
// The machine's CPU, memory and GPU over the last minutes (each a list of percentages, the last now), a line each on
// one small graph, with their figures now under it; nothing for a machine that doesn't say. The lines keep clear of
// the graph's edges and end on a dot in their colour, so one at 0% reads as a line, not as the graph's border. Drawn in
// the graph's own pixels, its points in percentages, never a stretched viewBox: Safari thickens a stretched graph's
// lines whatever vector-effect says.
function usage(m) {
  const shown = USE.filter(([k]) => m[k]?.length > 1);
  if (!shown.length) return '';
  const point = (v, i, all) =>
    [(i / (all.length - 1)) * 100, 100 - Math.min(100, Math.max(0, v))].map(n => `${n.toFixed(2)}%`);
  const series = k => {
    const points = m[k].map(point),
      [x, y] = points.at(-1);
    return `<g class="${k}">${points
      .slice(1)
      .map(([x2, y2], i) => `<line x1="${points[i][0]}" y1="${points[i][1]}" x2="${x2}" y2="${y2}"/>`)
      .join('')}<circle cx="${x}" cy="${y}" r="4"/></g>`;
  };
  return `<div class="graph"><svg aria-hidden="true">${shown.map(([k]) => series(k)).join('')}</svg></div>
    <small>${shown.map(([k, label]) => `<span class="${k}"><b>${Math.round(m[k].at(-1))}%</b> ${label}</span>`).join('')}</small>`;
}
const long = day => companyFormats().day(day, 'en', { weekday: true, short: true });
// an agent's tokens a minute (pace.js)
const paceNow = A => pace(A.tokens, A.since)?.perMinute;
// A bar each, the last full in the key's colour; one not counted yet (null) a faint stub, so every row runs the whole
// width. tips: what each bar is, shown on hover. scale: the top of a fixed scale, such as 100 for percentages.
function bars(all, w = 140, h = 24, { tips = [], stubs = true, scale } = {}) {
  if (!all?.length) return '';
  const max = scale ?? Math.max(1, ...all.filter(v => v !== null && v !== undefined)),
    bw = w / all.length;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"${tips.length ? '' : ' aria-hidden="true"'}>${all
    .map((v, i) => {
      const none = v === null || v === undefined;
      if (none && !stubs) return '';
      const bh = none ? 2 : Math.max(2, (v / max) * h),
        tip = tips[i] ? `<title>${esc(tips[i])}</title>` : '';
      return `<rect x="${(i * bw + bw * 0.16).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(bw * 0.68).toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5"${none ? ' class="none"' : i === all.length - 1 ? ' class="now"' : ''}>${tip}</rect>`;
    })
    .join('')}</svg>`;
}
// how long ago, short: now, 4m, 2h, 3d
const ago = t => {
  const m = Math.round((Date.now() - (typeof t === 'string' ? Date.parse(t) : t)) / 60_000);
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};
const thousands = n => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
function agent(el, t) {
  const A = world.agents.get(t.id);
  if (!A) return;
  const q = s => el.querySelector(s),
    qa = s => el.querySelectorAll(s),
    big = el !== t.el,
    working = A.state === 'working',
    week = S.week[A.id] ?? { jobs: 0, days: [], prs: 0, last: null },
    mine = (S.jobs ?? []).filter(j => j.agent === A.id),
    run = mine.find(j => j.status === 'running'),
    next = mine.filter(j => j.status === 'queued' || j.status === 'blocked'),
    p = working ? pace(A.tokens, A.since) : null,
    last = week.last
      ? `${titleHtml(week.last)}<span class="aside"> · ${mins(Date.parse(week.last.finished))} ago</span>`
      : '<span class="aside">Nothing finished yet</span>';
  for (const [cls, on] of [
    ['working', working],
    ['waiting', A.state === 'waiting'],
    ['asleep', A.state === 'sleeping'],
    ['lit', S.lit === t.id],
  ])
    el.classList.toggle(cls, on);
  const job = run ? titleHtml(run) : titleHtml({ title: A.task || (working ? 'At work' : '') }),
    rate = p?.perMinute ? `<b>${thousands(p.perMinute)}</b> tokens a minute` : '',
    tokens = p?.bars.some(n => n > 0)
      ? bars(
          p.bars.map(n => n || undefined),
          120,
          22,
          { stubs: false },
        )
      : '',
    days = week.days.map(
      (n, i) =>
        `${i === week.days.length - 1 ? 'Today' : `${i - week.days.length + 1}d`}: ${n} job${n === 1 ? '' : 's'}`,
    );
  if (!big) {
    // on the board: at work, how long it's been at it (top right), the job and its pace; at rest, the last job finished
    // and the week
    set(q('.clock'), working && A.since ? ago(A.since) : '');
    set(q('.doing'), working || A.task ? job : last);
    set(
      q('.foot'),
      working
        ? `${tokens}<small>${rate}</small>`
        : `${bars(week.days, 120, 22, { tips: days })}<small><b>${week.jobs}</b> job${week.jobs === 1 ? '' : 's'} · <b>${week.prs}</b> merged</small>`,
    );
    return;
  }
  // big, its front: how they are, the job, its log and its pace; its back: the last job, what's next, the week and who
  for (const s of qa('.state'))
    set(s, working && A.since ? `<i></i>${STATE.working} · ${mins(A.since)}` : esc(STATE[A.state] ?? A.state));
  set(q('.doing'), job || '<span class="aside">Not on a job</span>');
  logFill(el);
  set(
    q('.pace'),
    working
      ? `${tokens}<small>${rate}${A.lines ? `<span class="since">+${A.lines.add} −${A.lines.del} lines</span>` : ''}</small>`
      : '',
  );
  set(q('.last p'), last);
  set(
    q('.next p'),
    next[0]
      ? titleHtml(next[0]) + (next.length > 1 ? `<span class="aside"> · ${next.length - 1} more</span>` : '')
      : '<span class="aside">Nothing queued</span>',
  );
  set(
    q('.week'),
    `${bars(week.days, 140, 30, { tips: days })}<p><b>${week.jobs}</b> job${week.jobs === 1 ? '' : 's'} · <b>${week.prs}</b> merged <span class="aside">this week</span></p>`,
  );
  const dept = world.rooms.find(r => r.id === A.roomId)?.name;
  // (their engine's mark, then where they work and how they look, on one line)
  set(q('.who'), engineMark(A.data.engine) + [dept, A.data.look].filter(Boolean).map(esc).join(' · '));
}
// a line's words, changed only when they change
function set(el, html) {
  if (el && el.innerHTML !== html) el.innerHTML = html;
}

// ---------------------------------------------------------------- the keys falling onto the board as HQ opens
// Each key in view drops from above the screen, a moment after the one before, lands with a clack and bounces to rest,
// as a tile dropped on a table would (dropTiles). The ones below the fold are simply there.
function drop() {
  const shown = S.tiles.filter(t => t.el.getBoundingClientRect().top < innerHeight);
  dropTiles(
    shown.map(t => t.el),
    { onBounce: (i, bounce) => bounce < 2 && keys.clack(bounce ? 0.35 : 1, (i * 5) % 12) },
  );
}

// ---------------------------------------------------------------- keys sliding to new places (at work first)
// Each moved key goes across first and then up or down, never cutting through the rest, and snaps into place.
function slide(before) {
  if (still() || !before.size) return;
  for (const [t, a] of before) {
    if (!t.slot.isConnected) continue;
    const b = t.slot.getBoundingClientRect(),
      dx = a.left - b.left,
      dy = a.top - b.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    t.slot.animate(
      [
        { transform: `translate(${dx}px, ${dy}px)`, easing: 'cubic-bezier(.5, 0, .3, 1)' },
        {
          transform: `translate(0, ${dy}px)`,
          easing: 'cubic-bezier(.3, 1.4, .5, 1)',
          offset: dx && dy ? 0.5 : dx ? 1 : 0,
        },
        { transform: 'none' },
      ],
      { duration: 620 },
    );
  }
}

// ---------------------------------------------------------------- solo: one key, big
// It flies out of its place on the board (and back into it), or out of origin (an element of the shell's, as a task in
// the projects view) and back into that; a swipe brings the next one in from the side, a tap turns it over.
function solo(i, from = 0, origin = null) {
  const t = S.tiles[(i + S.tiles.length) % S.tiles.length];
  if (!t) return false;
  S.solo = S.tiles.indexOf(t);
  S.card = key(t, true);
  if (t.kind === 'agent' && world.agents.get(t.id)?.state !== 'working') S.card.classList.add('flipped');
  const box = root.querySelector('.solo'),
    was = box.querySelector(':scope > .key');
  if (was) was.replaceWith(S.card);
  else box.replaceChildren(S.card);
  // (its sides, where a swipe goes on to another, kept from key to key)
  const beside = box.querySelector(':scope > .sides');
  if (S.tiles.length < 2) beside?.remove();
  else if (!beside) box.insertAdjacentHTML('beforeend', sides());
  box.hidden = false;
  root.classList.add('alone');
  paint(t);
  S.origin = origin;
  if (from) slideIn(S.card, from);
  else if (origin) flyOut(S.card, origin);
  else if (shown(t.el)) flyOut(S.card, t.el);
  else zoomIn(S.card);
  for (const x of S.tiles) x.el.classList.toggle('away', x === t);
  if (t.kind === 'agent') steps(t);
  return true;
}
// The big key's log: its job's own (Jobs' report: every step and what they said between), the running one's or the last
// finished one's, read again as new steps come in; without one, what HQ heard from them since it opened.
async function steps(t) {
  if (!S.card) return;
  const card = S.card,
    mine = (S.jobs ?? []).filter(j => j.agent === t.id),
    job =
      mine.find(j => j.status === 'running') ??
      mine.filter(j => j.finished).sort((a, b) => (b.finished > a.finished ? 1 : -1))[0];
  let lines = [];
  if (job)
    try {
      lines = await loadJobLog(world.dev, job.id);
    } catch {
      /* (no log: what HQ heard instead) */
    }
  if (S.card !== card) return;
  card.steps = lines.length ? lines : world.agents.get(t.id).logs.filter(l => l.type === 'log' || l.type === 'chat');
  logFill(card);
}
// The log's lines, the newest in full and the older ones on a line each (a tap opens one). It stays at the bottom as
// lines come in, unless it was scrolled up to read.
function logFill(card) {
  const ol = card.querySelector('.log');
  if (!ol || !card.steps) return;
  const all = card.steps.slice(-40),
    keyOf = l => `${l.ts}|${l.text}`;
  if ([...ol.children].map(li => li.dataset.k).join('\n') === all.map(keyOf).join('\n')) return;
  const bottom = !card.filled || ol.scrollHeight - ol.scrollTop - ol.clientHeight < 24,
    open = new Set([...ol.querySelectorAll('li.open')].map(li => li.dataset.k));
  ol.innerHTML = all.length
    ? all
        .map(
          l =>
            `<li data-k="${esc(keyOf(l))}"${open.has(keyOf(l)) ? ' class="open"' : ''}><span>${esc(l.text)}</span><time>${ago(l.ts)}</time></li>`,
        )
        .join('')
    : '<li class="aside">No steps yet</li>';
  card.filled = true;
  if (bottom) ol.scrollTop = ol.scrollHeight;
}
function leave() {
  const t = S.tiles[S.solo],
    el = S.card,
    box = root.querySelector('.solo'),
    back = S.origin?.isConnected ? S.origin : t && shown(t.el) ? t.el : null;
  S.solo = null;
  S.card = null;
  S.origin = null;
  root.classList.remove('alone');
  root.querySelector('.solo .sides')?.remove();
  keys.close();
  t?.el.classList.remove('away'); // (it fades back in as the big one shrinks into it and fades out)
  const done = () => {
    if (S.card) return; // (another key came out meanwhile)
    box.hidden = true;
    box.replaceChildren();
  };
  if (el && back) flyBack(el, back).onfinish = done;
  else done();
}
// The big key, turned over (its front: the work; its back: the rest): edge on, the other face, and back, its close
// button gone while it turns. Flat at rest (in 3D the log wouldn't scroll). Today, which has one face, counts its day
// up again.
function turn() {
  const card = S.card,
    faces = card?.querySelector('.faces');
  if (!faces) return card?.classList.contains('company') && recount(card);
  flip(faces, {
    onTurn: keys.flip,
    onEdge: () => card.classList.toggle('flipped'),
    hide: [card.querySelector('.close')],
  });
}
// Today's numbers spin like a slot machine's and stop one digit at a time, left to right, as its bars grow back up
function recount(el) {
  pressBriefly(el, { soft: true });
  keys.press();
  if (still()) return;
  el.querySelectorAll('.stats rect').forEach((r, i) =>
    r.animate([{ transform: 'scaleY(0)' }, { transform: 'none' }], {
      duration: 420,
      delay: (i % 14) * 30,
      easing: 'cubic-bezier(.2, .9, .3, 1.3)',
      fill: 'backwards',
    }),
  );
  const all = [...el.querySelectorAll('.stat b')].map(b => [b, b.textContent]),
    t0 = performance.now(),
    roll = now => {
      const k = Math.min(1, (now - t0) / 900);
      for (const [b, text] of all) {
        let i = 0;
        b.textContent = text.replace(/\d/g, d => (++i / (text.length + 1) < k ? d : (Math.random() * 10) | 0));
      }
      if (k < 1) requestAnimationFrame(roll);
      else keys.land();
    };
  requestAnimationFrame(roll);
}
// a key on the board in view (between the HUD's band and the bottom of the screen)
function shown(el) {
  const r = el.getBoundingClientRect();
  return r.bottom > S.top && r.top < innerHeight;
}
function step(by) {
  if (S.solo === null) return;
  solo(S.solo + by, by);
  keys.swipe();
}

// ---------------------------------------------------------------- a message: from one key to another
// A slip with its first words flies on an arc from the sender's key to the one it's for (the intercom, for the board),
// which goes down under it like a pressed key and shows the message, who it's from and all its words, for a while.
function message({ agent: from, to, text }) {
  const at = id => S.tiles.find(t => t.kind === 'agent' && t.id === id)?.el,
    a = at(from),
    b = at(to) ?? document.querySelector('#btn-intercom');
  if (S.solo !== null || !a || !b || still()) return;
  const ra = a.getBoundingClientRect(),
    rb = b.getBoundingClientRect(),
    slip = document.createElement('div'),
    words = String(text ?? '').replace(/\s+/g, ' ');
  slip.className = 'slip';
  slip.textContent = words.length > 46 ? `${words.slice(0, 44)}…` : words || '…';
  root.querySelector('.flights').append(slip);
  const w = slip.offsetWidth,
    h = slip.offsetHeight,
    x0 = Math.min(Math.max(8, ra.left + ra.width / 2 - w / 2), innerWidth - w - 8),
    y0 = Math.max(S.top, ra.top + 20) - h / 2,
    x1 = Math.min(Math.max(8, rb.left + rb.width / 2 - w / 2), innerWidth - w - 8),
    y1 = rb.top + rb.height / 2 - h / 2,
    lift = Math.min(160, 40 + Math.hypot(x1 - x0, y1 - y0) / 4),
    dur = Math.min(1900, 1100 + Math.hypot(x1 - x0, y1 - y0) / 1.5);
  slip.animate(
    [
      { transform: `translate(${x0}px, ${y0}px) scale(.4)`, opacity: 0 },
      { transform: `translate(${x0}px, ${y0 - 18}px) scale(1)`, opacity: 1, offset: 0.18 },
      { transform: `translate(${(x0 + x1) / 2}px, ${Math.min(y0, y1) - lift}px) scale(1) rotate(-4deg)`, offset: 0.58 },
      { transform: `translate(${x1}px, ${y1}px) scale(.55)`, opacity: 1, offset: 0.94 },
      { transform: `translate(${x1}px, ${y1}px) scale(.3)`, opacity: 0 },
    ],
    { duration: dur, easing: 'cubic-bezier(.45, .05, .55, .95)' },
  ).onfinish = () => {
    slip.remove();
    pressBriefly(b, { soft: true });
    keys.land();
    const t = S.tiles.find(x => x.el === b);
    if (t) shows(t, from, words);
  };
}

// A message shown on its key: from whom and what, over the key's own words, gone after a time to read it in
function shows(t, from, words) {
  const A = world.agents.get(from);
  t.el.querySelector('.said')?.remove();
  t.el.insertAdjacentHTML(
    'beforeend',
    `<div class="said"><small>From <b>${esc(A?.data.name ?? from)}</b></small><p>${esc(words)}</p></div>`,
  );
  const box = t.el.querySelector('.said');
  clearTimeout(t.saidUntil);
  t.saidUntil = setTimeout(
    () => {
      box.classList.add('gone');
      setTimeout(() => box.remove(), 300);
    },
    Math.min(12_000, 4000 + words.length * 60),
  );
}

// ---------------------------------------------------------------- a mascot: wandering across its key and back
function pet(el, id, dt) {
  const m = world.mascots.find(x => x.id === id),
    p = el.pet,
    now = performance.now(),
    room = el.querySelector('.stage').clientWidth / 2 - 30;
  if (now > p.until) {
    const r = Math.random();
    p.doing = r < 0.4 ? 'walk' : r < 0.75 ? 'sit' : 'loaf';
    p.until = now + (p.doing === 'walk' ? 2600 + r * 2000 : 4000 + r * 5000);
    if (p.doing === 'walk' && r < 0.2) p.dir = -p.dir;
  }
  const doing = m && ['nap', 'sleep'].includes(m.activity) ? 'sleep' : p.doing;
  if (doing === 'walk') {
    p.x += p.dir * dt * 24;
    if (Math.abs(p.x) > room) {
      p.x = Math.sign(p.x) * Math.max(0, room);
      p.dir = -p.dir;
    }
  }
  const frame = doing === 'walk' ? (((now / 180) | 0) % 2 ? 'walk1' : 'walk2') : doing,
    look = `${frame}|${p.dir}`,
    canvas = el.querySelector('.stage canvas');
  // (a kind without art: its key keeps its name and role, and no creature)
  if (look !== p.drawn && ART[m?.kind]) {
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, 14, 12);
    g.drawImage(ART[m.kind].frame(frame, p.dir > 0), 0, 0);
    p.drawn = look;
  }
  canvas.style.transform = `translateX(${p.x.toFixed(1)}px)`;
}

// ---------------------------------------------------------------- moving about
// The board scrolls itself (the browser's own scrolling). Its taps go to the shell, which asks hit() what's under them.
// On the big key, a sideways drag carries it, and far enough it goes on to the next one (followSwipes); the keys step
// through them, and - (or the zoom key) goes back to the board. A wheel only ever scrolls what's under it.
function touch() {
  const swipes = followSwipes(root.querySelector('.solo'), { card: () => S.card, onStep: step });
  root.addEventListener('click', e => {
    const line = e.target.closest('.log li[data-k]'),
      side = e.target.closest('.solo [data-side]');
    if (swipes.wasSwipe()) return; // (the end of a swipe, not a tap)
    if (side) step(Number(side.dataset.side));
    else if (line) line.classList.toggle('open');
    else shell.tap(e.clientX, e.clientY);
  });
}
const camera = {
  grab() {},
  drag() {},
  release() {},
  pinch() {},
  zoom(by) {
    if (by < 0) focus({ kind: 'home' });
    else if (S.solo === null) solo(firstShown());
  },
  nudge(dx, dy) {
    if (S.solo !== null) step(dx + dy > 0 ? 1 : -1);
    else root.querySelector('.board').scrollBy({ top: dy * 2, behavior: 'smooth' });
  },
};
// the first key in view (where the zoom key goes in)
function firstShown() {
  return Math.max(
    0,
    S.tiles.findIndex(t => t.el.getBoundingClientRect().bottom > S.top + 20),
  );
}

// ---------------------------------------------------------------- the step and the frame
function update(dt) {
  weather();
  if (S.rain || S.drops?.length) rainfall(dt);
  for (const t of S.tiles) if (t.kind === 'mascot' && S.solo === null) pet(t.el, t.id, dt);
  if (S.card?.pet) pet(S.card, S.tiles[S.solo].id, dt);
}
function draw() {
  // an emote rides on the figure's circle while it lasts
  for (const t of S.tiles) {
    if (t.kind !== 'agent') continue;
    const e = world.agents.get(t.id)?.emote,
      look = e ? `${e.kind}|${fade(e).toFixed(2)}` : '';
    if (look === t.emoted) continue;
    t.emoted = look;
    for (const el of [t.el, S.tiles[S.solo] === t && S.card]) {
      for (const b of el ? el.querySelectorAll('.emote') : []) {
        b.textContent = e ? (EMOTES[e.kind]?.glyph ?? '') : '';
        b.style.opacity = e ? fade(e) : 0;
        b.style.setProperty('--emote', e ? (EMOTES[e.kind]?.color ?? '') : '');
      }
    }
    t.el.classList.toggle('lit', S.lit === t.id);
  }
}
// The canvas under everything: the screen's size, empty. The board runs under the HUD (its band: --top, S.top) and the
// status line (--bottom), so its keys pass under them as it scrolls.
function resize(w, h) {
  Object.assign(cv, { width: w, height: h });
  Object.assign(cv.style, { width: `${w}px`, height: `${h}px` });
  layout();
}
function layout() {
  const h = parseFloat(cv.style.height) || innerHeight,
    status = document.querySelector('#status')?.getBoundingClientRect(),
    below = el => (el?.offsetHeight ? el.getBoundingClientRect().bottom + 18 : 0);
  // (below the HUD's tools, with More's row when it's open, and its brand plate, which can hang lower.)
  S.top = Math.max(
    shell.chrome().top,
    below(document.querySelector('#hud .brand')),
    below(document.querySelector('#hud .tools')),
  );
  root.style.setProperty('--top', `${S.top}px`);
  root.style.setProperty('--bottom', `${status?.height ? h - status.top + 10 : 16}px`);
  fit();
}
// A key's side: on a phone, two fill the width (as the company's key does); wider, SIDE, as many to a row as fit.
function fit() {
  const board = root.querySelector('.board'),
    pad = parseFloat(getComputedStyle(board).paddingLeft) || 14,
    room = (board.clientWidth || innerWidth) - 2 * pad,
    phone = room < 600;
  S.side = phone ? Math.floor((room - GAP) / 2) : SIDE;
  root.style.setProperty('--t', `${S.side}px`);
  root.style.setProperty('--cols', phone ? 2 : Math.max(2, Math.floor((room + GAP) / (SIDE + GAP))));
}

// ---------------------------------------------------------------- the numbers: today and the 13 days before, each agent's week
async function numbers() {
  try {
    const work = await loadWork(world.dev);
    S.days = work.days;
    S.week = work.agents ?? {};
  } catch {
    /* (no numbers: the keys keep what they have) */
  }
  try {
    S.jobs = await loadJobs(world.dev);
  } catch {
    /* (no jobs: an agent's key keeps what it says) */
  }
  paintAll();
}

// ---------------------------------------------------------------- taps
// What's under a point. On the board: a key, which comes out big. Big: its figure is its agent (the shell opens their
// panel) or its machine (the shell opens its settings), a creature's key its mascot (a pat), the close button or outside
// it goes back, the rest of it turns it over (Today's counts again).
function hit(x, y) {
  const inside = el => {
    const r = el?.getBoundingClientRect();
    return r && r.width && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  if (S.solo === null) {
    if (y < S.top) return null; // (under the HUD's band)
    const t = S.tiles.find(x => inside(x.el));
    return t ? { kind: 'object', id: `key:${t.id}` } : null;
  }
  const t = S.tiles[S.solo],
    el = S.card;
  if (!inside(el) || inside(el.querySelector('.close'))) return { kind: 'object', id: 'out' };
  const face = el.querySelector(el.classList.contains('flipped') ? '.back .avatar' : '.avatar');
  if (t.kind === 'agent' && inside(face)) return { kind: 'agent', id: t.id, room: world.agents.get(t.id)?.roomId };
  if (t.kind === 'machine' && inside(face)) return { kind: 'object', id: 'machine', machine: machineOf(t)?.id ?? null };
  if (t.kind === 'mascot') return { kind: 'mascot', id: t.id, room: world.mascots.find(m => m.id === t.id)?.home };
  return { kind: 'object', id: 'turn' };
}
function act({ kind, id }) {
  if (kind === 'mascot') {
    if (S.tiles[S.solo]?.id === id || S.solo === null) world.pet(id);
    return;
  }
  const [what, who] = String(id).split(':');
  if (what === 'out') return focus({ kind: 'home' });
  if (what === 'turn') return turn();
  const t = S.tiles.find(x => x.id === who);
  if (t && what === 'key' && S.solo === null) {
    keys.press();
    pressBriefly(t.el);
    setTimeout(() => solo(S.tiles.indexOf(t)), still() ? 0 : 90);
  }
}
// home: the board; an agent, a mascot or a room's agent: their key, big (out of from, an element of the shell's, where
// given)
function focus(target, { from = null } = {}) {
  if (target.kind === 'home') {
    if (S.solo !== null) leave();
    return true;
  }
  const i =
    target.kind === 'room'
      ? S.tiles.findIndex(t => t.kind === 'agent' && world.agents.get(t.id)?.roomId === target.id)
      : S.tiles.findIndex(t => t.id === target.id && t.kind === target.kind);
  if (i < 0) return false;
  if (S.solo !== i) solo(i, 0, from);
  return true;
}
// where a card hangs: over a key's figure (an agent's) or its creature; null when not in view
function anchor({ kind, id }) {
  const t = S.tiles.find(x => x.id === id && x.kind === kind);
  if (!t) return null;
  const el = S.solo !== null ? (S.tiles[S.solo] === t ? S.card : null) : t.el,
    spot = el?.querySelector(kind === 'agent' ? '.avatar' : '.stage canvas');
  if (!spot) return null;
  const r = spot.getBoundingClientRect();
  return r.bottom < S.top || r.top > innerHeight ? null : { x: r.left + r.width / 2, y: r.top };
}
function portrait({ kind, id }) {
  if (kind === 'mascot') {
    const m = world.mascots.find(x => x.id === id),
      a = ART[m?.kind];
    return a ? { img: sprite(a.frame('sit', true), 'portrait'), accent: '#9b72cf' } : null;
  }
  const A = world.agents.get(id);
  if (!A) return null;
  const look = makeLook(A.data);
  return { img: sprite(spriteFrame(id, look, 'stand', true, true), 'portrait'), accent: look.shirt };
}

// ---------------------------------------------------------------- the world's signals (after the shell's)
function listen() {
  const { play } = shell.sound;
  const mine = agent => S.tiles.find(t => t.kind === 'agent' && t.id === agent);
  const repaint = ({ agent }) => {
    const t = mine(agent);
    if (t) paint(t);
  };
  return [
    world.on('status', () => build()),
    // a step: the key's line (and the big key's log, with a soft tick); its tests onto today
    world.on('log', ({ agent, tests }) => {
      const t = mine(agent);
      if (!t) return;
      paint(t);
      if (S.tiles[S.solo] === t) {
        play('tick');
        clearTimeout(S.card.reread);
        S.card.reread = setTimeout(() => steps(t), 1500);
      }
      if (S.days?.length && tests) {
        S.days.at(-1).tests = (S.days.at(-1).tests ?? 0) + tests;
        paint(S.tiles[0]);
      }
    }),
    world.on('lines', repaint),
    world.on('tokens', repaint),
    world.on('say', m => {
      repaint(m);
      message(m);
    }),
    world.on('post', () => play('jingle')),
    world.on('feel', ({ mascot, emote }) => {
      if (mascot && emote === 'love') hearts(mascot);
    }),
    world.on('org', () => build()),
    world.on('machines', () => build()), // (a machine's key comes and goes with it, and shows what it says)
  ];
}
// a mascot, petted (world.pet): hearts over it and its sound (its key already says who it is)
function hearts(id) {
  const t = S.tiles.find(x => x.id === id && x.kind === 'mascot'),
    m = world.mascots.find(x => x.id === id);
  if (!t || !m) return;
  shell.sound.play(ART[m.kind]?.sound ?? 'twinkle');
  const el = S.tiles[S.solo] === t ? S.card : t.el,
    stage = el.querySelector('.stage');
  for (let k = 0; k < 5; k++) {
    const h = document.createElement('i');
    h.className = 'heart';
    h.style.left = `calc(50% + ${el.pet.x + (Math.random() - 0.5) * 60}px)`;
    h.style.animationDelay = `${k * 90}ms`;
    stage.append(h);
    setTimeout(() => h.remove(), 1600 + k * 90);
  }
}

// The tour: everyone at work and the mascots; with nobody at work, everyone at rest instead
function showcase(on) {
  if (!on) return null;
  drop();
  const agents = S.tiles.filter(t => t.kind === 'agent'),
    working = agents.filter(t => world.agents.get(t.id)?.state === 'working');
  const stops = [...(working.length ? working : agents), ...S.tiles.filter(t => t.kind === 'mascot')].map(t => {
    const A = t.kind === 'agent' && world.agents.get(t.id),
      m = t.kind === 'mascot' && world.mascots.find(x => x.id === t.id);
    return {
      target: { kind: t.kind, id: t.id },
      hold: HOLD,
      title: A ? A.data.name : m.name,
      sub: A ? A.task : m.role,
    };
  });
  return { lead: 0, stops };
}

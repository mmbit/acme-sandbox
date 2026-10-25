// The Sketchbook's tray: a fine pen, a marker, a highlighter and an eraser lying side by side (the one in hand stands up),
// three sizes, and the inks. Each tool keeps its own size and ink, and the tray remembers them on this device.
import { esc, store } from '../util.js';
import { sfx } from './audio.js';

// sizes in the sketch's px; the highlighter's ink shows through
export const TOOLS = {
  pen: { name: 'Pen', sizes: [2, 4, 8], size: 1, color: '#2b2230' },
  marker: { name: 'Marker', sizes: [8, 14, 22], size: 1, color: '#2f6bdc' },
  highlighter: { name: 'Highlighter', sizes: [14, 22, 32], size: 1, color: '#ffd23f', alpha: 0.4 },
  eraser: { name: 'Eraser', sizes: [10, 24, 48], size: 1 },
};
// prettier-ignore
export const COLOURS = [
  ['Ink', '#2b2230'], ['Graphite', '#77707c'], ['Red', '#ff5a5f'], ['Orange', '#ff8c2e'], ['Yellow', '#ffd23f'],
  ['Green', '#1d9a5b'], ['Teal', '#14a3a0'], ['Blue', '#2f6bdc'], ['Violet', '#7a4fd8'], ['Pink', '#ff6fae'],
  ['Brown', '#8a5a3b'], ['White', '#ffffff'],
];

// the size buttons' dots, the same for every tool
const DOTS = [6, 11, 17];

// Each tool drawn standing, its tip at the top in its ink (.tip), in a 24 × 64 box
const DRAWINGS = {
  pen: `<path class="body" d="M7 64V22l5-12 5 12v42z"/><path class="band" d="M7 30h10v5H7z"/><path class="tip" d="M10 15l2-6 2 6z"/>`,
  marker: `<path class="body" d="M4 64V24h16v40z"/><path class="band" d="M4 24h16v6H4z"/><path class="tip" d="M7 24l1-10 8-3v13z"/>`,
  highlighter: `<path class="body" d="M3 64V26h18v38z"/><path class="tip" d="M6 26V14l12-4v16z"/><path class="band" d="M3 26h18v4H3z"/>`,
  eraser: `<path class="body" d="M5 64V30h14v34z"/><path class="tip rubber" d="M5 30V14a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v16z"/>`,
};

// The tray in el; changed(tool) when the board picks another tool, size or ink. Returns what's in hand now.
export function tray(el, changed) {
  const kept = store.get('sketchbook.tray', {});
  const tools = Object.fromEntries(Object.entries(TOOLS).map(([id, t]) => [id, { ...t, ...kept.tools?.[id] }]));
  let held = TOOLS[kept.held] ? kept.held : 'pen';
  const inHand = () => {
    const t = tools[held];
    return { kind: held === 'eraser' ? 'eraser' : 'pen', color: t.color, size: t.sizes[t.size], alpha: t.alpha ?? 1 };
  };
  el.innerHTML = trayHtml(tools);
  const paint = () => {
    const t = tools[held];
    for (const b of el.querySelectorAll('[data-tool]')) {
      b.setAttribute('aria-checked', String(b.dataset.tool === held));
      if (tools[b.dataset.tool].color) b.style.setProperty('--tip', tools[b.dataset.tool].color);
    }
    el.querySelectorAll('[data-size]').forEach((b, i) => {
      b.setAttribute('aria-checked', String(i === t.size));
      b.style.setProperty('--dot', `${DOTS[i]}px`);
    });
    el.querySelector('.sk-colours').hidden = !t.color;
    for (const b of el.querySelectorAll('[data-colour]'))
      b.setAttribute('aria-checked', String(b.dataset.colour === t.color));
    el.style.setProperty('--ink', t.color ?? 'transparent');
    store.set('sketchbook.tray', {
      held,
      tools: Object.fromEntries(Object.entries(tools).map(([id, t]) => [id, { size: t.size, color: t.color }])),
    });
  };
  el.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) held = b.dataset.tool;
    else if (b.dataset.size) tools[held].size = Number(b.dataset.size);
    else if (b.dataset.colour) tools[held].color = b.dataset.colour;
    else return;
    sfx[b.dataset.tool ? 'clack' : 'tick']();
    paint();
    changed(inHand());
  });
  paint();
  return inHand;
}

function trayHtml(tools) {
  const tool = ([id, t]) =>
    `<button class="sk-tool sk-${id}" data-tool="${id}" role="radio" aria-label="${t.name}" title="${t.name}"><svg viewBox="0 0 24 64" aria-hidden="true">${DRAWINGS[id]}</svg></button>`;
  const size = (_, i) =>
    `<button data-size="${i}" role="radio" aria-label="${['Fine', 'Medium', 'Broad'][i]}"><i></i></button>`;
  const colour = ([name, hex]) =>
    `<button data-colour="${hex}" role="radio" aria-label="${esc(name)}" title="${esc(name)}" style="--swatch:${hex}"></button>`;
  return `<div class="sk-tools" role="radiogroup" aria-label="Tools">${Object.entries(tools).map(tool).join('')}</div>
    <div class="sk-sizes" role="radiogroup" aria-label="Size">${[0, 1, 2].map(size).join('')}</div>
    <div class="sk-colours" role="radiogroup" aria-label="Ink">${COLOURS.map(colour).join('')}</div>`;
}

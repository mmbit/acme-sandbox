// HQ-OS's tiles, as Artifacts and Numbers' home show them: an app's picture in the screen's colours, its name and a line
// or two under it, under a box that keeps only the tiles whose name holds what's typed.
import { esc } from '../util.js';

// The apps in Numbers' order, as groups, each { kind, apps } and a company group's caption: the front door on its
// own, then the company's groups (brand.yaml's computer.appGroups: a list of { caption, apps: [slug, …] }, in order),
// then what they don't name: our apps (live, test, preview, as /api/apps sorts them), the cycles' demos and the
// platform's own pieces. So a new app never goes missing or moves the others. A group keeps /api/apps' order, and an
// app named twice stays in the first.
// kind: 'front' | 'company' | 'ours' | 'demos' | 'platform'
export function appGroups(apps, wanted) {
  const placed = new Set(apps.filter(a => a.front));
  const take = slugs => {
    const group = apps.filter(a => slugs.includes(a.slug) && !placed.has(a));
    group.forEach(a => placed.add(a));
    return group;
  };
  const named = (Array.isArray(wanted) ? wanted : []).filter(g => typeof g?.caption === 'string' && Array.isArray(g.apps))
    .map(g => ({ kind: 'company', caption: g.caption, apps: take(g.apps) }));
  const left = apps.filter(a => !placed.has(a));
  return [
    { kind: 'front', apps: apps.filter(a => a.front) },
    ...named,
    { kind: 'ours', apps: left.filter(isOurs) },
    { kind: 'demos', apps: left.filter(a => !a.platform && a.status === 'demo') },
    { kind: 'platform', apps: left.filter(a => a.platform) },
  ].filter(g => g.apps.length);
}
// One of our own apps: not the front door, a cycle's demo or a piece of the platform
const isOurs = a => !a.front && !a.platform && a.status !== 'demo';

// One tile: Artifacts' opens the artifact (href), Numbers' is a button carrying its dashboard's data-* attributes.
// pic: a picture of its own (markup), for a tile that isn't an app (Numbers' company dashboards, an artifact's cover or kind); title: its tooltip,
// app.about without one
export function appTile(app, { href = '', data = '', lines = '', after = '', pic = '', newTab = false, title: tooltip = app.about } = {}) {
  const title = tooltip ? ` title="${esc(tooltip)}"` : '';
  const inner = `<span class="pic">${pic || picture(app)}</span><b>${esc(app.name)}</b>${lines}`;
  const open = href ? `<a class="open" href="${esc(href)}"${newTab ? ' target="_blank" rel="noopener"' : ''}${title}>${inner}</a>` : `<button class="open" ${data}${title}>${inner}</button>`;
  return `<li data-tile="${esc(app.name.toLowerCase())}">${open}${after}</li>`;
}
const letter = app => `<i aria-hidden="true">${esc([...app.name][0] ?? '?')}</i>`;
const picture = app => !app.icon ? letter(app)
  : `<img alt="" data-ink="${esc(app.icon)}" data-letter="${esc([...app.name][0] ?? '?')}"${inked.has(app.icon) ? ` src="${inked.get(app.icon)}"` : ''}>`;

// The tiles under the filter box: `html` replaces what's under the box, which stays, so a redraw never takes what's
// being typed (nor the phone's keyboard).
export function showTiles(el, html) {
  let tiles = el.querySelector(':scope > .tiles');
  if (!tiles) {
    el.innerHTML = '<input class="tilefilter" type="search" placeholder="Filter by name" aria-label="Filter by name" autocomplete="off" enterkeyhint="search"><div class="tiles"></div>';
    tiles = el.querySelector('.tiles');
    el.querySelector('.tilefilter').oninput = () => filter(el);
  }
  tiles.innerHTML = html;
  inkPictures(tiles);
  filter(el);
}
// A group whose tiles are all filtered out goes with its caption.
function filter(el) {
  const typed = el.querySelector('.tilefilter').value.trim().toLowerCase();
  el.querySelectorAll('[data-tile]').forEach(li => { li.hidden = !li.dataset.tile.includes(typed); });
  el.querySelectorAll('.tilegroup').forEach(group => { group.hidden = !group.querySelector('[data-tile]:not([hidden])'); });
}

// The picture as a plain image: dark ink, as see-through as the icon is light, over the tile's glow. That draws what a
// grey picture multiplied into the glow looks like. iPhones painted `filter` with `mix-blend-mode` (and lazy loading) as
// the bare glow, a green square, until the list scrolled or they repainted it.
const CONTRAST = 1.1, INK = 0.92;   // the look's: a touch more contrast, the glow showing through a little
const inked = new Map();   // an icon's address → its inked picture's object URL, once made (for this page's life)
const inking = new Map();   // an icon's address → the promise of it
export function inkPictures(el) {
  for (const img of el.querySelectorAll('img[data-ink]:not([src])')) {
    const address = img.dataset.ink;
    if (!inking.has(address)) inking.set(address, ink(address).then(src => { inked.set(address, src); return src; }));
    inking.get(address).then(src => { img.src = src; },
      () => img.outerHTML = `<i aria-hidden="true">${esc(img.dataset.letter)}</i>`);   // (an icon that won't load: the letter)
  }
}
async function ink(address) {
  const icon = new Image();
  icon.src = address;
  await icon.decode();
  const canvas = Object.assign(document.createElement('canvas'), { width: icon.naturalWidth, height: icon.naturalHeight });
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(icon, 0, 0);
  const image = context.getImageData(0, 0, canvas.width, canvas.height), pixels = image.data;
  for (let i = 0; i < pixels.length; i += 4) {
    const grey = (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]) / 255;   // (CSS grayscale's weights)
    const light = Math.min(1, Math.max(0, (grey - 0.5) * CONTRAST + 0.5));
    pixels[i + 3] = Math.round(pixels[i + 3] * INK * (1 - light));
    pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
  }
  context.putImageData(image, 0, 0);
  const png = await new Promise((done, fail) => canvas.toBlob(blob => blob ? done(blob) : fail(new Error('No picture from the canvas'))));
  return URL.createObjectURL(png);
}

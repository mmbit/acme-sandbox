// HQ's icons: one folder per icon style (icons/<style>/<name>.svg), each look drawing only from its own style's folder.
// An icon a folder lacks shows nothing and says so in the console, never another style's drawing. icons.test.js fails
// any folder that lacks one.
// A look the company dresses in a kit (theme/hq.yaml <look>.kit) draws from the kit's set instead: its hq/icons/<name>.svg,
// served at /kits/<kit>/icons/, under HQ's names, with hq/icons/names.json pointing HQ names that share one drawing to
// it ({ "mobile": "phone" }).

// The icon style a look of this style wears (its scene.js `style`): the pixel style its own, every other the smooth
// set.
export const iconStyle = style => (style === 'pixel' ? 'pixel' : 'smooth');

let worn = null; // where the look on stage draws from: { from: its folder, kit: the kit it's dressed in, or null }
const drawings = new Map(); // `${folder}/${file}` → a promise of the file's <svg>
const kitNames = new Map(); // kit → a promise of its names.json
const NONE = Promise.resolve({}); // (a style's folder: every drawing under its own name)

// An icon as markup: an empty <svg> that the style worn now fills in, now and on each change of look. With a label it's
// an image for screen readers, without one it's decoration.
export function icon(name, cls = '', label = '') {
  const role = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
  return `<svg class="icon i-${name}${cls ? ` ${cls}` : ''}" data-icon="${name}" ${role}></svg>`;
}

// The look on stage wears its style's icons (style: its scene.js `style`), or the set of the kit it's dressed in: every
// icon on the page redrawn, and every one added later drawn as it comes. The page says which style (data-icons), for a
// picture only one style draws (Numbers' grid pictures, pixel art).
export function wearIcons(style, kit = null) {
  if (!worn) watch();
  worn = { from: kit ? `/kits/${kit}/icons` : `icons/${iconStyle(style)}`, kit };
  document.documentElement.dataset.icons = iconStyle(style);
  for (const svg of document.querySelectorAll('svg[data-icon]')) draw(svg);
}

function watch() {
  const observer = new MutationObserver(changes => {
    for (const change of changes) for (const node of change.addedNodes) if (node.nodeType === 1) drawWithin(node);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function drawWithin(node) {
  if (node.matches('svg[data-icon]')) draw(node);
  for (const svg of node.querySelectorAll('svg[data-icon]')) draw(svg);
}

async function draw(svg) {
  const source = worn,
    name = svg.dataset.icon;
  if (svg.dataset.drawn === `${source.from}/${name}`) return;
  svg.replaceChildren();
  svg.removeAttribute('viewBox');
  delete svg.dataset.drawn;
  const drawing = await drawingOf(source.from, (await namesOf(source.kit))[name] ?? name);
  if (source !== worn) return;
  svg.setAttribute('viewBox', drawing.getAttribute('viewBox'));
  const g = document.createElementNS(drawing.namespaceURI, 'g');
  for (const { name: attr, value } of drawing.attributes)
    if (!['xmlns', 'viewBox', 'width', 'height'].includes(attr)) g.setAttribute(attr, value);
  g.append(...[...drawing.childNodes].map(n => document.importNode(n, true)));
  svg.replaceChildren(g);
  svg.dataset.drawn = `${source.from}/${name}`;
}

// A folder's drawing of an icon, fetched once
function drawingOf(from, file) {
  const url = `${from}/${file}.svg`;
  if (!drawings.has(url)) drawings.set(url, fetchDrawing(url));
  return drawings.get(url);
}

// A failed request is removed from the cache so the next drawing can fetch it again.
async function fetchDrawing(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const drawing = new DOMParser().parseFromString(await response.text(), 'image/svg+xml').documentElement;
    if (drawing.localName !== 'svg') throw new Error('Response is not an SVG');
    return drawing;
  } catch (error) {
    drawings.delete(url);
    throw new Error(`[hq] ${url}: ${error.message}`, { cause: error });
  }
}

// A kit's names for HQ names that share a drawing, fetched once: none when the kit has no names.json, or for a style's
// folder
function namesOf(kit) {
  if (!kit) return NONE;
  if (!kitNames.has(kit)) kitNames.set(kit, fetchNames(kit));
  return kitNames.get(kit);
}

// A failed request is removed from the cache so the next drawing can fetch it again.
async function fetchNames(kit) {
  const url = `/kits/${kit}/icons/names.json`;
  try {
    const response = await fetch(url);
    if (response.status === 404) return {};
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const names = await response.json();
    if (!names || typeof names !== 'object' || Array.isArray(names)) throw new Error('not a table of names');
    return names;
  } catch (error) {
    kitNames.delete(kit);
    throw new Error(`[hq] ${url}: ${error.message}`, { cause: error });
  }
}

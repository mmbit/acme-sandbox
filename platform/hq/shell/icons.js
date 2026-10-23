// HQ's icons: one folder per style (icons/<style>/<name>.svg), each look drawing only from its own style's folder. An
// icon a folder lacks shows nothing and says so in the console, never another style's drawing. icons.test.js fails
// any folder that lacks one.

// Each look's style: a new look adds its line here and a complete folder (icons.test.js checks both).
export const STYLES = { brownstone: 'pixel', holo: 'smooth', wire: 'smooth' };

let worn = null; // the style on stage now
const drawings = new Map(); // `${style}/${name}` → a promise of the file's <svg>

// An icon as markup: an empty <svg> that the style worn now fills in, now and on each change of look. With a label it's
// an image for screen readers, without one it's decoration.
export function icon(name, cls = '', label = '') {
  const role = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
  return `<svg class="icon i-${name}${cls ? ` ${cls}` : ''}" data-icon="${name}" ${role}></svg>`;
}

// The look on stage wears its style's icons: every icon on the page redrawn, and every one added later drawn as it
// comes.
export function wearIcons(look) {
  if (!worn) watch();
  worn = STYLES[look];
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
  const style = worn,
    name = svg.dataset.icon;
  if (svg.dataset.drawn === `${style}/${name}`) return;
  svg.replaceChildren();
  svg.removeAttribute('viewBox');
  delete svg.dataset.drawn;
  const drawing = await drawingOf(style, name);
  if (style !== worn) return;
  svg.setAttribute('viewBox', drawing.getAttribute('viewBox'));
  const g = document.createElementNS(drawing.namespaceURI, 'g');
  for (const { name: attr, value } of drawing.attributes)
    if (!['xmlns', 'viewBox', 'width', 'height'].includes(attr)) g.setAttribute(attr, value);
  g.append(...[...drawing.childNodes].map(n => document.importNode(n, true)));
  svg.replaceChildren(g);
  svg.dataset.drawn = `${style}/${name}`;
}

// A style's drawing of an icon, fetched once
function drawingOf(style, name) {
  const key = `${style}/${name}`;
  if (!drawings.has(key)) drawings.set(key, fetchDrawing(style, name));
  return drawings.get(key);
}

// A failed request is removed from the cache so the next drawing can fetch it again.
async function fetchDrawing(style, name) {
  const url = `icons/${style}/${name}.svg`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const drawing = new DOMParser().parseFromString(await response.text(), 'image/svg+xml').documentElement;
    if (drawing.localName !== 'svg') throw new Error('Response is not an SVG');
    return drawing;
  } catch (error) {
    drawings.delete(`${style}/${name}`);
    throw new Error(`[hq] ${url}: ${error.message}`, { cause: error });
  }
}

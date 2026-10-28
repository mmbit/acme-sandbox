// A page's picture in dev mode (notebookdata.js), for the overview's tiles: the store draws it from the page whole
// (bookpicture.ts); dev mode has no store, so the page's groups are drawn here, its ink, typed words and pictures on the
// paper, kept till the page changes. An address for an <img>.
import { draw as ink } from '/__review/ink.js';

const PICTURE_PX = 360, // (its width; at most 1.5 as tall: a grown page shows its top, as the grid does)
  TEXT_PX = 18,
  TEXT_LINE = 1.45;
const kept = new Map();

// page: as the store lists it ({ id, updated, x, y, w, h }); groups(): its groups, read
export function pagePicture(page, groups) {
  const key = `${page.id} ${page.updated}`;
  if (!kept.has(key))
    kept.set(
      key,
      groups()
        .then(gs => drawn(page, gs))
        .catch(() => ''),
    );
  return kept.get(key);
}

async function drawn(page, groups) {
  const s = PICTURE_PX / page.w,
    canvas = document.createElement('canvas');
  canvas.width = PICTURE_PX;
  canvas.height = Math.round(Math.min(page.h, page.w * 1.5) * s);
  const g = canvas.getContext('2d');
  g.fillStyle = '#fffaf0';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.setTransform(s, 0, 0, s, -page.x * s, -page.y * s);
  for (const c of groups.flatMap(gr => gr.pictures ?? [])) {
    const img = new Image();
    img.src = c.url;
    await img.decode().catch(() => {});
    if (img.naturalWidth) g.drawImage(img, c.x, c.y, c.w, c.h);
  }
  // (a highlighter's strokes under the ink, as on the page)
  const strokes = groups.flatMap(gr => gr.ink ?? []);
  ink(g, [...strokes.filter(st => st.alpha < 1), ...strokes.filter(st => !(st.alpha < 1))]);
  for (const t of groups.flatMap(gr => gr.texts ?? [])) typed(g, t);
  const blob = await new Promise(res => canvas.toBlob(res));
  return blob ? URL.createObjectURL(blob) : '';
}
// A text box typed on the page, wrapped at its width as the page sets it
function typed(g, { x, y, w, text, color }) {
  g.font = `${TEXT_PX}px 'Atkinson Hyperlegible', system-ui, sans-serif`;
  g.fillStyle = color || '#2a2352';
  g.textBaseline = 'top';
  const line = TEXT_PX * TEXT_LINE;
  let n = 0;
  for (const para of String(text).split('\n')) {
    let row = '';
    for (const word of para.split(' ')) {
      const next = row ? `${row} ${word}` : word;
      if (row && g.measureText(next).width > w) {
        g.fillText(row, x, y + n++ * line);
        row = word;
      } else row = next;
    }
    g.fillText(row, x, y + n++ * line);
  }
}

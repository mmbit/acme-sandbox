// A page shared as a file (bookshare.js): its name, the one-page PDF its picture goes in, written here byte by byte
// (each JPEG embedded as it is), and the pieces a long one goes on a call in. Plain functions, no DOM.

// A page px as a PDF point: CSS's 96 px to the inch over PDF's 72
export const POINTS_PER_PX = 0.75;
// what no system takes in a file's name
const UNSAFE = /[\\/:*?"<>|\p{Cc}]+/gu;

// The file's name: the page's title and day ("For Kit 2026-10-27.png"), or the Notebook's own words when it has none
export function fileName(title, day, ext) {
  const words = String(title ?? '')
    .replace(UNSAFE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${[words || 'Notebook page', day].filter(Boolean).join(' ')}.${ext}`;
}

// A PDF of one page, pictures filling it top to bottom: images each { jpeg (a baseline JPEG's bytes, RGB), w, h (its
// pixels) }, as wide as each other; pageW × pageH the page in points, title what a reader's window says. Returns the
// file's bytes. (several pictures: a browser draws a long page's in pieces.)
export function pdfOf({ images, pageW, pageH, title = '' }) {
  const w = num(pageW),
    h = num(pageH),
    tall = images.reduce((sum, i) => sum + i.h, 0);
  // (each picture stretched over its share of the page, from the top: PDF counts up from the bottom)
  let below = tall;
  const drawn = images
    .map((image, i) => {
      below -= image.h;
      return `q ${w} 0 0 ${num((pageH * image.h) / tall)} 0 ${num((pageH * below) / tall)} cm /Im${i} Do Q`;
    })
    .join('\n');
  const first = 6; // (the pictures' objects come after the five before them)
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << ${images
      .map((_, i) => `/Im${i} ${first + i} 0 R`)
      .join(' ')} >> >> /Contents 4 0 R >>`,
    [`<< /Length ${drawn.length} >>`, latin(drawn)],
    `<< /Title ${textString(title)} /Producer (Ink) >>`,
    ...images.map(({ jpeg, w: imageW, h: imageH }) => [
      `<< /Type /XObject /Subtype /Image /Width ${imageW} /Height ${imageH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`,
      jpeg,
    ]),
  ];
  return written(objects);
}
// A PDF's objects (each a dictionary, or [dictionary, stream bytes]) as its file's bytes, numbered from 1 in order, the
// fifth the file's information
function written(objects) {
  // (the binary comment line tells a reader the file holds bytes past ASCII)
  const parts = [latin('%PDF-1.4\n'), Uint8Array.of(0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a)],
    offsets = [];
  let at = parts.reduce((n, p) => n + p.length, 0);
  const add = bytes => {
    parts.push(bytes);
    at += bytes.length;
  };
  objects.forEach((o, i) => {
    offsets.push(at);
    const [dict, stream] = Array.isArray(o) ? o : [o, null];
    add(latin(`${i + 1} 0 obj\n${dict}\n`));
    if (stream) for (const bytes of [latin('stream\n'), stream, latin('\nendstream\n')]) add(bytes);
    add(latin('endobj\n'));
  });
  const xref = at,
    n = objects.length + 1;
  add(
    latin(
      `xref\n0 ${n}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}` +
        `trailer\n<< /Size ${n} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  );
  const file = new Uint8Array(at);
  let to = 0;
  for (const p of parts) {
    file.set(p, to);
    to += p.length;
  }
  return file;
}

// A number as PDF writes it: at most two decimals, no trailing zeros
const num = x => String(Math.round(x * 100) / 100);
// ASCII words as their bytes
const latin = s => Uint8Array.from(s, c => c.charCodeAt(0));
// Any words as a PDF text string: their UTF-16 code units (big-endian) after its byte-order mark, in hex
const textString = s =>
  `<FEFF${String(s)
    .split('')
    .map(c => c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase())
    .join('')}>`;

// A long page on a call in pieces each at most `tall` times as tall as wide, so the agent's model reads it at full
// size, at most `most` of them (the voice line's PICTURES), each repeating `overlap` px of the one before so no line
// is lost at a cut: a page dropped on a call (bookshare.js) and the call's sketch tool (the coordinator's
// bookreads.ts).
export const PIECES = { tall: 1.5, most: 6, overlap: 60 };
// How many pieces a page w × h wide goes in
export const piecesFor = (w, h) => Math.min(PIECES.most, Math.max(1, Math.ceil(h / w / PIECES.tall)));
// The n pieces down a picture height px tall: each one's top and height
export function cutsOf(n, height) {
  const step = Math.ceil(height / n);
  return Array.from({ length: n }, (_, i) => {
    const top = Math.max(0, i * step - PIECES.overlap);
    return { top, height: Math.min(height, (i + 1) * step) - top };
  });
}

// A page shared as a file (bookshare.js): its name, and the one-page PDF its picture goes in, written here byte by
// byte (a JPEG embedded as it is). Plain functions, no DOM.

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

// A PDF of one page, a picture filling it: jpeg its bytes (a baseline JPEG, RGB), imageW × imageH its pixels, pageW ×
// pageH the page in points, title what a reader's window says. Returns the file's bytes.
export function pdfOf({ jpeg, imageW, imageH, pageW, pageH, title = '' }) {
  const w = num(pageW),
    h = num(pageH),
    drawn = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`; // (the picture stretched over the whole page)
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
    [
      `<< /Type /XObject /Subtype /Image /Width ${imageW} /Height ${imageH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`,
      jpeg,
    ],
    [`<< /Length ${drawn.length} >>`, latin(drawn)],
    `<< /Title ${textString(title)} /Producer (Ink) >>`,
  ];
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
        `trailer\n<< /Size ${n} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
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

// Words and paper as a page's picture sets them, shared by what it draws (bookrender.ts, bookrenderasks.ts,
// bookrenderversions.ts): Pango's words at the book's line height, paper with its soft shadow, a picture's file fitted.
import sharp, { type OverlayOptions } from 'sharp';

// Typed words as the book sets them (booktools.js TEXT): the size and the line's height in page px. The book's own face
// is HQ's; here it's the first of these the machine has (DejaVu Sans comes with fontconfig on Debian).
export const TEXT = { size: 18, line: 1.4, font: 'Atkinson Hyperlegible, DejaVu Sans, sans-serif' };
// A scrap's words as the book sets them under it (bookgroups.css .bk-scrap-words): a yellow post-it, its padding and
// its soft shadow
export const WORDS = { size: 14, line: 1.45, pad: { x: 10, y: 8 }, ink: '#2a2352', paper: '#fff3a8', shadow: 0.18 };

// The book's hand where the machine has it, else a narrow face
export const HAND_FONT = 'Caveat, Comic Neue, DejaVu Sans Condensed, sans-serif';
// (Pango's own line in these faces is about 1.17 of the size: the rest of the book's line is spacing between lines)
export const FACE_LINE = 1.17;

// A picture of words at its place on the page's picture, in picture px
export type Layer = { input: Buffer; left: number; top: number; width: number; height: number };

export const escaped = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// An agent's initial on a disc in its ink, size page px across, at k picture px per page px
export function faceDisc(name: string, color: string, size: number, fontSize: number, k: number) {
  const px = Math.round(size * k);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${color}"/><text x="${size / 2}" y="${size / 2 + 4.5}" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="${fontSize}" font-weight="bold" fill="#fff">${escaped([...name][0] ?? '')}</text></svg>`,
  );
}

// Paper w × h at left, top (picture px) with its soft shadow and what's on it (each from the paper's top-left), with room
// round it for the shadow's blur; foot: the paper's foot.
export async function paper(
  left: number,
  top: number,
  w: number,
  h: number,
  k: number,
  look: { paper: string; shadow: number; on: OverlayOptions[] },
) {
  const m = Math.ceil(3 * k);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w + 2 * m}" height="${h + 2 * m}"><filter id="s"><feGaussianBlur stdDeviation="${1.5 * k}"/></filter><rect x="${m}" y="${m + k}" width="${w}" height="${h}" fill="${WORDS.ink}" fill-opacity="${look.shadow}" filter="url(#s)"/><rect x="${m}" y="${m}" width="${w}" height="${h}" fill="${look.paper}"/></svg>`;
  const on = look.on.map(o => ({ ...o, left: (o.left ?? 0) + m, top: (o.top ?? 0) + m })),
    input = await sharp(Buffer.from(svg)).composite(on).png().toBuffer();
  return { input, left: left - m, top: top - m, width: w + 2 * m, height: h + 2 * m, foot: top + h };
}
// A picture's file at most w page px wide and never past its own width, or as wide as w (fill), at k picture px a page px
export async function pictureAt(file: string, w: number, k: number, fill = false) {
  const { width = 1, height = 1 } = await sharp(file).metadata(),
    W = Math.max(1, Math.round((fill ? w : Math.min(w, width)) * k)),
    H = Math.max(1, Math.round((W * height) / width));
  return { input: await sharp(file).resize(W, H, { fit: 'fill' }).png().toBuffer(), width: W, height: H };
}

// (align: a paragraph's lines, left by default)
export type Face = { size: number; line: number; font?: string; align?: 'centre' };

// Words in Pango's markup set w page px wide
export const setMarkup = (markup: string, w: number, k: number, face: Face) =>
  sharp({
    text: {
      text: markup,
      font: `${face.font ?? TEXT.font} ${face.size}`,
      width: Math.max(1, Math.round(w * k)),
      dpi: Math.round(72 * k),
      rgba: true,
      align: face.align,
      wrap: 'word-char',
      spacing: Math.max(0, Math.round((face.line - FACE_LINE) * face.size * k)),
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
// Words set w page px wide as the book stands them: their picture (width × height), and how tall they stand at the
// face's line height (half a line's spacing above and below Pango's lines: their ink lead px down)
export async function block(markup: string, w: number, k: number, face: Face) {
  const set = await setMarkup(markup, w, k, face),
    spacing = (face.line - FACE_LINE) * face.size * k;
  return {
    ...{ input: set.data, width: set.info.width, height: set.info.height },
    ...{ tall: Math.round(set.info.height + spacing), lead: Math.round(spacing / 2) },
  };
}

// (what's drawn under a unit)
// A part: its picture and how tall it stands (words: their line's spacing; lead px down to their ink)
export type Part = { input: Buffer; height: number; tall: number; lead: number };
// Parts one under the other, gap px apart, W px wide: one part
export async function column(parts: Part[], W: number, gap: number): Promise<Part> {
  const on: OverlayOptions[] = [];
  let y = 0;
  for (const [i, p] of parts.entries()) {
    on.push({ input: p.input, left: 0, top: y + p.lead });
    y += p.tall + (i < parts.length - 1 ? gap : 0);
  }
  return { ...(await layered(on, W, y)), lead: 0 };
}
// What's on a see-through W × H picture
export async function layered(on: OverlayOptions[], W: number, H: number) {
  const height = Math.max(1, H),
    blank = { width: Math.max(1, W), height, channels: 4 as const, background: { r: 0, g: 0, b: 0, alpha: 0 } };
  const input = await sharp({ create: blank }).composite(on).png().toBuffer();
  return { input, height, tall: height };
}

// A picture taped into the book (a scrap): the photo taped straight onto what's under it (our scrap's post-it, or the
// page), a hair of an edge and a strip of tape whole across its top edge, no card or shadow of its own (README, Our
// scraps), and a picture file made ready for the store (at most UPLOAD_SIDE a side). Kept from the old Sketchbook's
// scraps, gone with its app. A scrap here: { x, y, w, h, tilt, img } in its page's units (its box, the photo inset in
// it by its margin; tilt in degrees; drawing: an agent's drawing on a clear ground, its lines straight on what's under it,
// no edge and no tape.).

// a picture as HQ uploads it: at most this long a side, and a PNG only while it's this small
const UPLOAD_SIDE = 2000,
  PNG_MAX = 2_500_000;

// the margin round the photo in its box, and the tape across its top edge, in its page's units
const matOf = s => Math.max(3, Math.min(s.w, s.h) * 0.035);
export const tapeOf = s => ({ w: Math.min(s.w * 0.36, 70), h: Math.max(9, Math.min(16, s.h * 0.09)) });
const TAPE = 'rgb(246 236 200 / 80%)';
// the tape's own turn on the scrap, and how far past its box a canvas keeps for it
const TAPE_TURN = -4,
  PAD = 4;

// The photo's own box in a scrap's (its page's units): inset by its margin
export function photoOf(s) {
  const m = matOf(s);
  return { x: s.x + m, y: s.y + m, w: s.w - 2 * m, h: s.h - 2 * m };
}

// A scrap on a canvas in its page's units, as the page shows it (our scraps' photos as bookpage.js lays them)
export function drawScrap(g, s) {
  const m = matOf(s),
    tape = tapeOf(s),
    [w, h] = [s.w - 2 * m, s.h - 2 * m];
  g.save();
  g.translate(s.x + s.w / 2, s.y + s.h / 2);
  g.rotate((s.tilt * Math.PI) / 180);
  if (s.img?.complete && s.img.naturalWidth) g.drawImage(s.img, -w / 2, -h / 2, w, h);
  if (s.drawing) return g.restore();
  g.strokeStyle = 'rgb(80 60 10 / 14%)';
  g.lineWidth = 1;
  g.strokeRect(-w / 2 - 0.5, -h / 2 - 0.5, w + 1, h + 1);
  g.translate(0, -h / 2);
  g.rotate((TAPE_TURN * Math.PI) / 180);
  g.fillStyle = TAPE;
  g.fillRect(-tape.w / 2, -tape.h / 2, tape.w, tape.h);
  g.restore();
}

// All drawScrap paints of a scrap, in its page's units: its box turned and the tape standing up past the photo's top
// edge, so a canvas this big cuts none of it (bookpage.js.)
export function drawnBox(s) {
  const tape = tapeOf(s),
    turn = (s.tilt * Math.PI) / 180,
    t = (TAPE_TURN * Math.PI) / 180,
    [hw, hh, tw, th] = [s.w / 2, s.h / 2, tape.w / 2, tape.h / 2],
    edge = matOf(s) - hh;
  const corners = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
    ...[
      [-tw, -th],
      [tw, -th],
      [tw, th],
      [-tw, th],
    ].map(([x, y]) => [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t) + edge]),
  ].map(([x, y]) => [
    s.x + hw + x * Math.cos(turn) - y * Math.sin(turn),
    s.y + hh + x * Math.sin(turn) + y * Math.cos(turn),
  ]);
  const xs = corners.map(c => c[0]),
    ys = corners.map(c => c[1]);
  return { x0: Math.min(...xs) - PAD, y0: Math.min(...ys) - PAD, x1: Math.max(...xs) + PAD, y1: Math.max(...ys) + PAD };
}

// A picture file as HQ uploads it, drawn again at most UPLOAD_SIDE a side (nothing of the file goes but its pixels):
// { blob, w, h }, or null if it can't be read here
export async function shrink(file) {
  const src = URL.createObjectURL(file),
    img = new Image();
  try {
    img.src = src;
    await img.decode();
    const k = Math.min(1, UPLOAD_SIDE / Math.max(img.naturalWidth, img.naturalHeight)),
      c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    const g = c.getContext('2d');
    const blob = type => new Promise(r => c.toBlob(r, type, 0.85));
    g.drawImage(img, 0, 0, c.width, c.height);
    let out = file.type === 'image/png' ? await blob('image/png') : null;
    if (!out || out.size > PNG_MAX) {
      // (a JPEG has no see-through: white under it, as the border is)
      g.globalCompositeOperation = 'destination-over';
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      out = await blob('image/jpeg');
    }
    return out && { blob: out, w: c.width, h: c.height };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(src);
  }
}

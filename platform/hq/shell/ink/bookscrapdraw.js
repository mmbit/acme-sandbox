// A picture taped into the book (a scrap): drawn in its white border with a strip of tape across its top edge, and a
// picture file made ready for the store (at most UPLOAD_SIDE a side). Kept from the old Sketchbook's scraps, gone with
// its app. A scrap here: { x, y, w, h, tilt, img } in its page's units (its box, border included; tilt in degrees).

// a picture as HQ uploads it: at most this long a side, and a PNG only while it's this small
const UPLOAD_SIDE = 2000,
  PNG_MAX = 2_500_000;

// its white border, and the tape across its top edge, in its page's units
const matOf = s => Math.max(3, Math.min(s.w, s.h) * 0.035);
const tapeOf = s => ({ w: Math.min(s.w * 0.36, 70), h: Math.max(9, Math.min(16, s.h * 0.09)) });
const TAPE = 'rgb(246 236 200 / 80%)';

// A scrap on a canvas in its page's units, as the page shows it
export function drawScrap(g, s) {
  const m = matOf(s),
    tape = tapeOf(s);
  g.save();
  g.translate(s.x + s.w / 2, s.y + s.h / 2);
  g.rotate((s.tilt * Math.PI) / 180);
  Object.assign(g, { shadowColor: 'rgb(40 30 50 / 28%)', shadowBlur: 6, shadowOffsetY: 2 });
  g.fillStyle = '#fff';
  g.fillRect(-s.w / 2, -s.h / 2, s.w, s.h);
  Object.assign(g, { shadowColor: 'transparent', shadowBlur: 0, shadowOffsetY: 0 });
  if (s.img?.complete && s.img.naturalWidth) g.drawImage(s.img, -s.w / 2 + m, -s.h / 2 + m, s.w - 2 * m, s.h - 2 * m);
  g.translate(0, -s.h / 2);
  g.rotate((-4 * Math.PI) / 180);
  g.fillStyle = TAPE;
  g.fillRect(-tape.w / 2, -tape.h / 2, tape.w, tape.h);
  g.restore();
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

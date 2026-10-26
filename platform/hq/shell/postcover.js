// A post's cover in the newsletter (news.js), drawn where it brings none: a meeting's notes' (meetingchair.ts) from the
// meeting itself, any other's from its author.
import { canvas, rng, pick } from '../util.js';
import * as world from '../world/world.js';
import { scene } from './stage.js';
import { keptPicture } from './covers.js';

const GROUNDS = ['#5b8def', '#ff8fab', '#7bd389', '#9b72cf', '#ffb86b']; // a cover's ground, by its post

// A post's cover: its own, else a meeting's drawn from the meeting, else its author on a ground of its own
export function coverFor(p) {
  if (p.cover) return p.cover;
  if (p.meeting) return (p.cover = meetingCover(p));
  const c = canvas(64, 36),
    g = c.getContext('2d'),
    r = rng(p.slug || p.title);
  g.fillStyle = pick(r, GROUNDS);
  g.fillRect(0, 0, 64, 36);
  g.fillStyle = 'rgba(255,255,255,.35)';
  for (let i = 0; i < 14; i++) g.fillRect((r() * 64) | 0, (r() * 36) | 0, 2, 2);
  if (world.agents.has(p.author)) {
    g.imageSmoothingEnabled = false;
    g.drawImage(scene.portrait({ kind: 'agent', id: p.author }).img, 21, -6, 21, 42);
  }
  return (p.cover = c.toDataURL());
}
// The projects whose plans it changed side by side (three at most), and everyone who sat in it behind a table in front
// of them, the chair first, on its ground (a meeting that changed none shows its ground).
// Its pictures are kept by the feed's load (news.js reloadGazette), so it draws at once.
function meetingCover(p) {
  const W = 640,
    H = 360,
    INK = '#1d1b18',
    c = canvas(W, H),
    g = c.getContext('2d');
  g.fillStyle = pick(rng(p.slug), GROUNDS);
  g.fillRect(0, 0, W, H);
  const shown = p.meeting.pictures.map(keptPicture).filter(Boolean).slice(0, 3),
    w = W / shown.length;
  shown.forEach((img, i) => {
    // the middle of it, filling its part of the cover
    const s = Math.max(w / img.naturalWidth, H / img.naturalHeight),
      sw = w / s,
      sh = H / s;
    g.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, i * w, 0, w, H);
    g.fillStyle = INK;
    if (i) g.fillRect(i * w - 2, 0, 4, H);
  });
  const people = p.meeting.people.flatMap(id =>
    world.agents.has(id) ? [scene.portrait({ kind: 'agent', id })?.img].filter(Boolean) : [],
  );
  if (!people.length) return c.toDataURL();
  // each to the waist behind the table, as big as the row fits (in quarter pixels of the portrait)
  const ph = people[0].height,
    pw = people[0].width,
    k = Math.max(0.25, Math.floor(4 * Math.min((H * 0.85) / ph, (W * 0.92) / (people.length * pw * 1.1))) / 4);
  const gap = pw * k * 0.1,
    row = people.length * pw * k + (people.length - 1) * gap,
    x0 = (W - row) / 2,
    top = Math.round(H * 0.86);
  g.imageSmoothingEnabled = false;
  people.forEach((img, i) =>
    g.drawImage(img, Math.round(x0 + i * (pw * k + gap)), top - Math.round(ph * k * 0.66), pw * k, ph * k),
  );
  g.fillStyle = '#f4efe6';
  g.strokeStyle = INK;
  g.lineWidth = 4;
  g.beginPath();
  g.roundRect(x0 - 16, top, row + 32, H, 10);
  g.fill();
  g.stroke();
  return c.toDataURL();
}

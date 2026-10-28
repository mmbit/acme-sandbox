// The pictures on a sketch's page (scraps): pasted, dropped, or brought from review mode, each under the ink in a white
// border with a strip of tape. A finger moves one (two pinch and turn it), its corner resizes it, its × takes it off, and
// every change is one step to undo, as a line is. The pen always draws, over them too.
//
// A scrap: { key, file, url, x, y, w, h, tilt, img } in the sketch's units (its box, border included; tilt in degrees).
// The coordinator keeps its picture (sketches.ts, `file`); until that's kept it has no file, shows, and can't be held.
// Without a pen (a mouse, or a finger before a pen has drawn) a press held still on a scrap picks it up, and on the bare
// paper offers Paste; once a pen has drawn, a finger never draws, so it moves a scrap at once.
import { sfx } from '../audio.js';

const HOLD_MS = 450,
  HOLD_SLOP_PX = 8,
  MIN_SIDE = 24,
  // a picture as HQ uploads it: at most this long a side, and a PNG only while it's this small
  UPLOAD_SIDE = 2000,
  PNG_MAX = 2_500_000;

// its white border, and the tape across its top edge, in the sketch's units
const matOf = s => Math.max(3, Math.min(s.w, s.h) * 0.035);
const tapeOf = s => ({ w: Math.min(s.w * 0.36, 70), h: Math.max(9, Math.min(16, s.h * 0.09)) });
const TAPE = 'rgb(246 236 200 / 80%)';
const copy = s => ({ ...s });
const stateOf = ({ x, y, w, h, tilt }) => ({ x, y, w, h, tilt });

// A scrap on a canvas in the sketch's units (the rendered picture's, sketchpen.js pictureOf), as the page shows it
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

// The scraps of `page` (sketchpen's: sheet, k, w, h, scraps, penSeen, tool()) in a layer under its canvases. steps: its
// undo history (apply, record). pen: the ink's pen, whose line a held press or a pinch cancels. paste(at): a press held
// still on the bare paper, at [x, y] in the sketch's units.
export function scrapLayer(page, steps, { pen, paste }) {
  const L = { page, steps, pen, paste, shown: new Map(), touches: new Map(), picked: null, held: null, hold: null };
  L.layer = Object.assign(document.createElement('div'), { className: 'sk-scraps' });
  L.chrome = Object.assign(document.createElement('div'), { className: 'sk-picked', hidden: true });
  L.chrome.innerHTML =
    '<button class="sk-unpin" aria-label="Take this picture off" title="Take it off">×</button>' +
    '<button class="sk-grip" aria-label="Resize this picture" title="Resize"></button>';
  page.sheet.prepend(L.layer);
  page.sheet.append(L.chrome);
  page.sheet.addEventListener('pointerdown', e => pressed(L, e), true);
  page.sheet.addEventListener('pointermove', e => moved(L, e));
  page.sheet.addEventListener('pointerup', e => lifted(L, e));
  page.sheet.addEventListener('pointercancel', e => lifted(L, e));
  return {
    render: () => render(L),
    add: (img, at) => add(L, img, at),
    unpin: () => unpin(L),
    unpick: () => pick(L, null),
    // every scrap's picture there to draw (before the page is rendered as a picture)
    ready: () => Promise.all(page.scraps.map(s => s.img?.decode())),
  };
}

// ---- showing them
const at = (L, e) => {
  const r = L.page.sheet.getBoundingClientRect();
  return [(e.clientX - r.left) / L.page.k, (e.clientY - r.top) / L.page.k];
};
// the topmost kept scrap under a point (its turn undone around its middle)
const hitAt = (L, [x, y]) =>
  L.page.scraps.findLast(s => {
    if (!s.file) return false;
    const a = (-s.tilt * Math.PI) / 180,
      dx = x - (s.x + s.w / 2),
      dy = y - (s.y + s.h / 2);
    return (
      Math.abs(dx * Math.cos(a) - dy * Math.sin(a)) <= s.w / 2 &&
      Math.abs(dx * Math.sin(a) + dy * Math.cos(a)) <= s.h / 2
    );
  }) ?? null;
function box(el, s, k) {
  Object.assign(el.style, {
    left: `${s.x * k}px`,
    top: `${s.y * k}px`,
    width: `${s.w * k}px`,
    height: `${s.h * k}px`,
    transform: `rotate(${s.tilt}deg)`,
  });
}
function show(L, s) {
  const k = L.page.k;
  let el = L.shown.get(s.key);
  if (!el) {
    el = Object.assign(document.createElement('div'), { className: 'sk-scrap' });
    s.img ??= Object.assign(new Image(), { src: s.url, alt: '' });
    L.shown.set(s.key, el);
  }
  // (a copy brought back by undo carries the same picture)
  if (s.img.parentNode !== el) el.replaceChildren(s.img);
  box(el, s, k);
  const tape = tapeOf(s);
  el.style.setProperty('--mat', `${matOf(s) * k}px`);
  el.style.setProperty('--tape-w', `${tape.w * k}px`);
  el.style.setProperty('--tape-h', `${tape.h * k}px`);
  el.classList.toggle('busy', !s.file);
  return el;
}
// every scrap as the list has them, in its order; the picked one's handles over the ink
function render(L) {
  const keys = new Set(L.page.scraps.map(s => s.key));
  for (const [key, el] of L.shown) {
    if (keys.has(key)) continue;
    el.remove();
    L.shown.delete(key);
  }
  for (const s of L.page.scraps) L.layer.append(show(L, s));
  if (L.picked) L.picked = L.page.scraps.find(s => s.key === L.picked.key) ?? null;
  L.chrome.hidden = !L.picked;
  if (L.picked) box(L.chrome, L.picked, L.page.k);
}
function pick(L, s) {
  L.picked = s;
  render(L);
}

// ---- gestures
function swallow(L, e) {
  e.stopImmediatePropagation();
  e.preventDefault();
  try {
    L.page.sheet.setPointerCapture(e.pointerId);
  } catch {
    /* gone already */
  }
}
function grab(L, kind, s, ids, points) {
  L.held = { kind, s, ids, from: copy(s), points };
  L.shown.get(s.key)?.classList.add('lifted');
}
function cancelHold(L) {
  clearTimeout(L.hold?.timer);
  L.hold = null;
}
// held still: the pen's line (a dot so far) goes, and the scrap under it is picked up, or the paper offers Paste
function holdFrom(L, e, hit) {
  if (e.pointerType === 'pen' || (L.page.tool().kind === 'eraser' && !L.page.penSeen)) return;
  const p = at(L, e),
    id = e.pointerId;
  const timer = setTimeout(() => {
    L.hold = null;
    L.pen.cancel();
    if (!hit) return L.paste(p);
    sfx.pop();
    pick(L, hit);
    grab(L, 'move', hit, [id], [p]);
  }, HOLD_MS);
  L.hold = { id, x: e.clientX, y: e.clientY, timer };
}
// a second finger: the two pinch the scrap held, or the one under them (a line the first began goes)
function secondFinger(L, e) {
  const [a, b] = [...L.touches.values()].map(t => t.now),
    s = L.held?.s ?? hitAt(L, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]) ?? hitAt(L, a);
  if (!s || (L.held && L.held.kind !== 'move')) return false;
  cancelHold(L);
  L.pen.cancel();
  if (L.held) end(L, false);
  pick(L, s);
  const ids = [...L.touches.keys()].slice(-2);
  grab(
    L,
    'pinch',
    s,
    ids,
    ids.map(id => L.touches.get(id).now),
  );
  swallow(L, e);
  return true;
}
function pressed(L, e) {
  if (e.pointerType === 'touch') L.touches.set(e.pointerId, { now: at(L, e) });
  if (e.pointerType === 'touch' && L.touches.size === 2 && secondFinger(L, e)) return;
  const { picked } = L;
  if (picked && e.target.closest('.sk-grip'))
    return (grab(L, 'size', picked, [e.pointerId], [at(L, e)]), swallow(L, e));
  if (picked && e.target.closest('.sk-unpin')) return (unpin(L), swallow(L, e));
  if (e.button !== 0 || L.held) return;
  const hit = hitAt(L, at(L, e));
  // the pen draws wherever it goes; anywhere but the picked scrap it puts the handles away
  if (e.pointerType === 'pen') return picked && hit !== picked && pick(L, null);
  if (picked && hit === picked) return (grab(L, 'move', picked, [e.pointerId], [at(L, e)]), swallow(L, e));
  // (a tap beside the picked scrap only puts its handles away)
  if (picked) return (pick(L, null), swallow(L, e));
  if (hit && L.page.penSeen && e.pointerType === 'touch') {
    pick(L, hit);
    grab(L, 'move', hit, [e.pointerId], [at(L, e)]);
    return swallow(L, e);
  }
  holdFrom(L, e, hit);
}
function moved(L, e) {
  if (L.touches.has(e.pointerId)) L.touches.get(e.pointerId).now = at(L, e);
  if (L.hold?.id === e.pointerId && Math.hypot(e.clientX - L.hold.x, e.clientY - L.hold.y) > HOLD_SLOP_PX)
    cancelHold(L);
  if (!L.held?.ids.includes(e.pointerId)) return;
  if (L.held.kind !== 'pinch') L.held.now = at(L, e);
  follow(L);
}
function lifted(L, e) {
  if (L.hold?.id === e.pointerId) cancelHold(L);
  L.touches.delete(e.pointerId);
  if (L.held?.ids.includes(e.pointerId)) end(L, true);
}

// How the fingers have gone since the hold began: { f: scale, turn: degrees, dx, dy: the sketch's units }, or null
function motion(L) {
  const { from, kind, points, now } = L.held,
    cx = from.x + from.w / 2,
    cy = from.y + from.h / 2;
  if (kind === 'move') return { f: 1, turn: 0, dx: now[0] - points[0][0], dy: now[1] - points[0][1] };
  const f = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (kind === 'size') return { f: f(now, [cx, cy]) / Math.max(1, f(points[0], [cx, cy])), turn: 0, dx: 0, dy: 0 };
  const [a, b] = L.held.ids.map(id => L.touches.get(id)?.now),
    [a0, b0] = points;
  if (!a || !b) return null;
  const angle = (p, q) => Math.atan2(q[1] - p[1], q[0] - p[0]);
  return {
    f: f(a, b) / Math.max(1, f(a0, b0)),
    turn: (angle(a, b) - angle(a0, b0)) * (180 / Math.PI),
    dx: (a[0] + b[0] - a0[0] - b0[0]) / 2,
    dy: (a[1] + b[1] - a0[1] - b0[1]) / 2,
  };
}
// the held scrap where the fingers are now: moved, resized about its middle, or pinched (scaled, turned and moved), its
// middle kept on the page
function follow(L) {
  const { s, from } = L.held,
    m = motion(L),
    { page } = L;
  if (!m) return;
  const most = 3 * Math.max(page.w, page.h),
    f = Math.min(Math.max(m.f, MIN_SIDE / Math.min(from.w, from.h)), most / Math.max(from.w, from.h)),
    w = from.w * f,
    h = from.h * f,
    mx = Math.min(Math.max(from.x + from.w / 2 + m.dx, 0), page.w),
    my = Math.min(Math.max(from.y + from.h / 2 + m.dy, 0), page.h);
  const tilt = ((((from.tilt + m.turn + 180) % 360) + 360) % 360) - 180;
  Object.assign(s, { x: mx - w / 2, y: my - h / 2, w, h, tilt });
  show(L, s);
  if (L.picked === s) box(L.chrome, s, page.k);
}
function end(L, record) {
  const { s, from } = L.held;
  L.shown.get(s.key)?.classList.remove('lifted');
  L.held = null;
  if (record && JSON.stringify(stateOf(s)) !== JSON.stringify(stateOf(from)))
    L.steps.record({ scrap: s.key, from, to: copy(s) });
}

// ---- what the page asks of it
// Taking the picked one off (its ×, or Delete): one step, undone as it was
function unpin(L) {
  const { picked, page } = L;
  if (!picked) return false;
  const op = { scrap: picked.key, from: copy(picked), to: null, at: page.scraps.indexOf(picked) };
  L.picked = null;
  L.steps.apply(op);
  render(L);
  L.steps.record(op);
  sfx.swipe();
  return true;
}
// A new picture on the page (img: loaded), its middle at [cx, cy] in the sketch's units, fitted to half the page,
// slightly turned. It shows at once; kept(file) once the coordinator has it, which makes it a step to undo, or gone()
// if it couldn't be.
function add(L, img, [cx, cy]) {
  const { page } = L,
    nw = img.naturalWidth,
    nh = img.naturalHeight,
    f = Math.min(1, (page.w * 0.5) / nw, (page.h * 0.55) / nh),
    w = Math.max(MIN_SIDE, nw * f),
    h = Math.max(MIN_SIDE, nh * f);
  const s = { key: `new-${Math.random().toString(36).slice(2)}`, file: null, url: img.src, img, w, h };
  Object.assign(s, {
    x: Math.min(Math.max(cx, w / 2), page.w - w / 2) - w / 2,
    y: Math.min(Math.max(cy, h / 2), page.h - h / 2) - h / 2,
    tilt: Math.round((Math.random() * 6 - 3) * 10) / 10,
  });
  page.scraps.push(s);
  render(L);
  const el = L.shown.get(s.key);
  el.classList.add('landing');
  el.addEventListener('animationend', () => el.classList.remove('landing'), { once: true });
  sfx.land();
  return {
    kept(file) {
      s.file = file;
      L.steps.record({ scrap: s.key, from: null, to: copy(s), at: page.scraps.indexOf(s) });
      pick(L, s);
    },
    gone() {
      page.scraps.splice(page.scraps.indexOf(s), 1);
      render(L);
    },
  };
}

// Undo and redo's own step for a scrap (sketchpen.js history): its state `to` (a copy of it, null: taken off), back at
// its place `at` if it had gone
export function setScrap(scraps, key, to, at) {
  const i = scraps.findIndex(s => s.key === key);
  if (!to) return i >= 0 && scraps.splice(i, 1);
  if (i >= 0) return Object.assign(scraps[i], stateOf(to));
  scraps.splice(Math.min(at ?? scraps.length, scraps.length), 0, copy(to));
}

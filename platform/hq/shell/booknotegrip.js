// A note held on its sheet: a finger (or a mouse) held still on it ~350 ms lifts it off the paper, and then it goes
// where it's let go. Between the other notes of its sheet on the page: there, the others making room. Over a face in
// the rail: onto that agent's sheet. Thrown sideways off the paper: wiped. Anywhere else it settles back. Each is a
// step the rail's Undo takes back (book.steps). No "are you sure?": everything undoes instead.
import { faceAt } from './bookrail.js';
import { moveNote, orderSheet, restoreNote, wipeNote, linkNotes } from './booksheetdata.js';
import { reordered, slotAt, whose } from './booksheetplace.js';

// how long a press is held still before the note lifts, and how far it may wander meanwhile (further: the table pans)
const HOLD_MS = 350,
  STILL_PX = 8;
// a throw: faster than this sideways (px per ms, over its last FLICK_MS) and mostly sideways
const THROW = 0.9,
  FLICK_MS = 100;

export function mountGrip(sh) {
  sh.book.world.addEventListener('pointerdown', e => {
    const el = e.target.closest?.('.bs-note[data-open]');
    if (!el || e.target.closest('textarea') || !e.isPrimary) return;
    if (!(e.pointerType === 'touch' || (e.pointerType === 'mouse' && e.button === 0))) return;
    if (sh.sheet(el.dataset.sheet)?.status !== 'open') return;
    hold(sh, el, e);
  });
}

// A press on a note: still for HOLD_MS, it lifts; moved first, it was the table's (or the mouse's ink)
function hold(sh, el, down) {
  const trail = [[down.timeStamp, down.clientX, down.clientY]];
  let lifted = null;
  const timer = setTimeout(() => (lifted = lift(sh, el, down)), HOLD_MS);
  const move = e => {
    if (e.pointerId !== down.pointerId) return;
    trail.push([e.timeStamp, e.clientX, e.clientY]);
    while (trail.length > 2 && trail[0][0] < e.timeStamp - FLICK_MS) trail.shift();
    if (lifted) return carry(sh, lifted, e);
    if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) > STILL_PX) end();
  };
  const up = e => {
    if (e.pointerId !== down.pointerId) return;
    end();
    if (lifted) drop(sh, lifted, e, e.type === 'pointercancel' ? [0, 0] : speed(trail, e));
  };
  function end() {
    clearTimeout(timer);
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
  }
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
}
function speed(trail, e) {
  const [t0, x0, y0] = trail[0],
    dt = Math.max(1, e.timeStamp - t0);
  return [(e.clientX - x0) / dt, (e.clientY - y0) / dt];
}

// Lifted: the table stops being the finger's (and the mouse's line is no line), and a paper copy of the note rises
// under the finger, the note's place on the sheet kept open under it
function lift(sh, el, down) {
  sh.book.ink.cancel();
  sh.hooks.release();
  sh.busy = true;
  const r = el.getBoundingClientRect(),
    ghost = el.cloneNode(true);
  ghost.classList.add('bs-ghost');
  ghost.removeAttribute('role');
  ghost.setAttribute('aria-hidden', 'true');
  Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px` });
  ghost.insertAdjacentHTML('beforeend', '<span class="bs-to" hidden></span>');
  (el.closest('#book') ?? document.body).append(ghost);
  el.classList.add('bs-lifted');
  navigator.vibrate?.(8);
  const group = el.closest('.bs-group'),
    others = [...group.querySelectorAll('.bs-note')].filter(x => x !== el);
  const gap = parseFloat(getComputedStyle(el).marginBottom) || 0;
  return {
    el,
    ghost,
    down,
    group,
    others,
    from: [...group.querySelectorAll('.bs-note')].indexOf(el),
    middles: others.map(o => {
      const b = o.getBoundingClientRect();
      return b.top + b.height / 2;
    }),
    height: r.height + gap,
    slot: null,
    face: undefined,
  };
}
// Carried: the copy follows the finger; over its sheet the others make room where it would land; over a face, it says
// whose sheet it would join
function carry(sh, l, e) {
  const dx = e.clientX - l.down.clientX,
    dy = e.clientY - l.down.clientY;
  l.ghost.style.transform = `translate(${dx}px, ${dy}px) rotate(${Math.max(-4, Math.min(4, dx / 60))}deg)`;
  l.face = faceAt(e.clientX, e.clientY);
  const to = l.ghost.querySelector('.bs-to');
  to.hidden = !l.face;
  if (l.face) to.textContent = `For ${sh.name(l.face.id)}`;
  const box = l.group.getBoundingClientRect();
  const over = !l.face && e.clientY > box.top - l.height && e.clientY < box.bottom + l.height && onPaper(sh, e);
  l.slot = over ? slotAt(l.middles, e.clientY) : null;
  makeRoom(l, l.slot ?? l.from);
}
// The others shift to open a gap at slot (their order without the lifted one), closing the one it left
function makeRoom(l, slot) {
  l.others.forEach((o, k) => {
    const was = k < l.from ? k : k + 1,
      shift = was > l.from && k < slot ? -l.height : was < l.from && k >= slot ? l.height : 0;
    o.style.transform = shift ? `translateY(${shift}px)` : '';
  });
}
const onPaper = (sh, e) => {
  const r = sh.book.desk.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
};

// Let go: onto a face, thrown off the paper, between its sheet's notes, or back where it was
async function drop(sh, l, e, [vx, vy]) {
  sh.busy = false;
  const note = sh.note(l.el.dataset.id),
    sheet = sh.sheet(l.el.dataset.sheet),
    page = sh.view(note?.page)?.page ?? sh.book.views.find(v => v.el.contains(l.el))?.page;
  const thrown = Math.abs(vx) > THROW && Math.abs(vx) > 1.5 * Math.abs(vy);
  if (l.face && note && l.face.id !== whose(sheet, sh.ceo()))
    return away(sh, l, 0, () => move(sh, note, sheet, l.face.owner, page));
  if ((thrown || (!l.face && !onPaper(sh, e))) && note)
    return away(sh, l, Math.sign(vx || e.clientX - l.down.clientX) || 1, () => wipe(sh, note, sheet, page));
  if (l.slot !== null && l.slot !== l.from && note) {
    const shown = [l.el, ...l.others].map(x => Number(x.dataset.id)).sort((a, b) => sh.note(a).n - sh.note(b).n);
    const ids = sheet.notes.filter(n => n.status === 'open').map(n => n.id);
    const order = reordered(ids, shown, note.id, l.slot);
    settleAt(l);
    return change(
      sh,
      page,
      () => orderSheet(sh.dev, sheet.id, order),
      () => orderSheet(sh.dev, sheet.id, ids),
    );
  }
  back(l);
}
// The copy settles back into its place
function back(l) {
  const r = l.el.getBoundingClientRect(),
    g = l.ghost.getBoundingClientRect(),
    move = l.ghost.style.transform || 'none';
  l.ghost
    .animate([{ transform: move }, { transform: `translate(${r.left - g.left}px, ${r.top - g.top}px) ${move}` }], {
      duration: 160,
      easing: 'ease-out',
    })
    .finished.then(() => done(l));
}
// The lifted note's new place on its sheet, at once (the store numbers it a moment later)
function settleAt(l) {
  const rest = l.others,
    before = rest[l.slot];
  if (before) l.group.insertBefore(l.el, before);
  else rest.at(-1)?.after(l.el);
  done(l);
}
// Gone from the sheet: the copy flies off sideways (dir) and fades, or shrinks into the face (dir 0)
function away(sh, l, dir, act) {
  const now = l.ghost.style.transform || 'none',
    end = dir ? `translate(${dir * innerWidth}px, 40px) rotate(${dir * 25}deg)` : 'scale(0.2)';
  l.ghost
    .animate(
      [
        { transform: now, opacity: 1 },
        { transform: `${dir ? '' : now} ${end}`, opacity: 0 },
      ],
      {
        duration: dir ? 320 : 220,
        easing: 'ease-in',
      },
    )
    .finished.then(() => {
      l.ghost.remove();
      for (const o of l.others) o.style.transform = '';
    });
  l.el.style.display = 'none';
  return act();
}
// (the others back in their places at once: a note put in its new place is already where it was shifted to)
function done(l) {
  l.ghost.remove();
  l.el.classList.remove('bs-lifted');
  for (const o of l.others) {
    o.style.transition = 'none';
    o.style.transform = '';
  }
  l.group.getBoundingClientRect(); // (the reset laid out before the transitions come back)
  for (const o of l.others) o.style.transition = '';
}

// ---- the changes, each a step Undo takes back

// One change to the store and the step that undoes it; the sheets read again after each
async function change(sh, page, act, undo) {
  try {
    await act();
    sh.book.steps.push({
      undo: async () => {
        try {
          await undo();
        } catch (e) {
          sh.tell(page, e);
        }
        sh.refresh();
      },
    });
  } catch (e) {
    sh.tell(page, e);
  }
  sh.refresh();
}
// Onto another agent's sheet (to: the face's owner, null for nobody's); Undo brings it back to its place on this one
function move(sh, note, sheet, to, page) {
  const ids = sheet.notes.filter(n => n.status === 'open').map(n => n.id);
  return change(
    sh,
    page,
    () => moveNote(sh.dev, note.id, to),
    async () => {
      const back = await moveNote(sh.dev, note.id, sheet.owner);
      await orderAgain(sh, back.sheet, ids, note.links ?? [], note.id);
    },
  );
}
// Wiped; Undo has the store bring the same note back (its writer, words and snip kept), in its place, still linked
function wipe(sh, note, sheet, page) {
  const ids = sheet.notes.filter(n => n.status === 'open').map(n => n.id);
  return change(
    sh,
    page,
    () => wipeNote(sh.dev, note.id),
    async () => {
      const back = await restoreNote(sh.dev, note.id);
      await orderAgain(sh, back.sheet, ids, note.links ?? [], note.id);
    },
  );
}
// A note back on its sheet put where it was among those still there, and linked again to those it went with
async function orderAgain(sh, sheet, ids, links, id) {
  const now = sheet.notes.filter(n => n.status === 'open').map(n => n.id),
    order = [...ids.filter(x => now.includes(x)), ...now.filter(x => !ids.includes(x))];
  if (order.join() !== now.join()) await orderSheet(sh.dev, sheet.id, order);
  for (const other of links) if (now.includes(other)) await linkNotes(sh.dev, id, other, true);
}

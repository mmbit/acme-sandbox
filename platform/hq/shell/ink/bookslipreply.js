// The room under an agent's answer on its slip, where the board answers it: pulled out by the handle at the slip's
// foot (a tap, or a drag for as much room as it wants), drawn in with the pen as on the page (circles round its
// words, arrows, a scribble, a little sketch), all its strokes kept as one drawing, however long the pen rests
// between them, till its Send sends them as the reply (bookanswerreply.js wirePen); or, with the text tool, words
// typed where it's pressed, gone with Enter or once left. No field waits under a slip to be typed in. An agent's desk-phone card has the same room (bookasks.js). Its look:
// bookslipreply.css.
import { esc, stylesheet } from '../../util.js';
import { word } from './bookscope.js';
import { wirePen } from './bookanswerreply.js';

stylesheet('shell/ink/bookslipreply.css');

// The room pulled out by a tap, and the most a drag makes of it, in page px
export const ROOM = 128,
  MOST = 480;
// A press that moves no further than this on the handle is a tap
const TAP_PX = 6;

// The room under a slip, drawn as it was (key: the page's for it, name: whom it answers, open: its height, else none)
export function roomHtml(key, name, open) {
  return `<div class="bk-slip-room" data-room="${esc(key)}"${open ? ` data-open style="--room:${open}px"` : ''}><div class="bk-slip-room-paper"><svg class="bk-reply-ink" aria-hidden="true"><g class="bk-reply-wet"></g></svg><button type="button" class="bk-answer-send bk-slip-room-send" hidden>${esc(
    word('send'),
  )}</button></div><button type="button" class="bk-slip-room-pull" aria-expanded="${!!open}" aria-label="${esc(
    word('slipRoom', { name }),
  )}"></button></div>`;
}

// The room under answer a, among the page's rooms (answer id → height)
export const slipRoomHtml = (a, rooms) => roomHtml(a.id, a.name ?? a.by, rooms.get(String(a.id)));

// Whether a room under the layer's slips holds what the board is answering with and hasn't gone yet: the page's
// groups aren't drawn again over it
export const answering = layer =>
  [...layer.querySelectorAll('.bk-slip-room-paper[data-inking], .bk-slip-room-words')].some(
    el => el.hasAttribute('data-inking') || el.textContent.trim() || el === document.activeElement,
  );

// The rooms under the layer's answer slips wired. rooms: the page's pulled out ones (key → height), kept across a
// redraw. hooks: wireRoom's, send(answer id, what)
export function wireRooms(layer, rooms, hooks) {
  for (const room of layer.querySelectorAll('.answer-slip .bk-slip-room'))
    wireRoom(room, rooms, { ...hooks, send: what => hooks.send(Number(room.dataset.room), what) });
}
// One room wired. hooks: { book, send({ ink } | { words }) → a promise, settled(): what was held for an answer may be
// drawn now, relay(): the page laid again, a room's height changed }; refused, the slip's last words say why and what
// was drawn stays there to send again. While what it holds goes (its own Send, or a card's: aria-busy on it or round
// it) it takes no stroke. Its drawing: drawn(), the strokes it holds in page px.
export function wireRoom(room, rooms, hooks) {
  const paper = room.querySelector('.bk-slip-room-paper'),
    button = paper.querySelector('.bk-slip-room-send'),
    said = room.closest('.answer-slip, .ask-slip').querySelector(':scope > .slip-said:last-child'),
    tell = text => Object.assign(said, { textContent: text, hidden: !text });
  wirePull(room, rooms, room.dataset.room, hooks.relay);
  // (the text tool's press: words typed there, before the pen's own listener, which leaves it be; while what it holds
  // goes, a press there is nobody's: not the pen's, nor the page's under it)
  paper.addEventListener('pointerdown', e => {
    const busy = room.closest('[aria-busy]');
    if (!busy && !typing(hooks.book)) return;
    e.stopPropagation();
    e.preventDefault();
    if (!busy) typeAt(paper, at(paper, e), words => hooks.send({ words }), tell, hooks.settled);
  });
  const pen = wirePen(paper, {
    origin: () => at(paper, null),
    takes: e =>
      room.hasAttribute('data-open') &&
      !room.closest('[aria-busy]') &&
      !typing(hooks.book) &&
      (e.pointerType !== 'touch' || !hooks.book.input?.fingerPans?.()),
    drew: () => (button.hidden = false),
  });
  for (const type of ['pointerdown', 'touchstart', 'touchmove'])
    button.addEventListener(type, e => e.stopPropagation());
  button.addEventListener('click', async () => {
    room.setAttribute('aria-busy', 'true');
    try {
      await hooks.send({ ink: pen.ink() });
      pen.clear();
      button.hidden = true;
      paper.removeAttribute('data-inking');
      hooks.settled();
    } catch (e) {
      tell(e.message);
    } finally {
      room.removeAttribute('aria-busy');
    }
  });
  return { drawn: pen.ink };
}
const typing = book => book.desk?.dataset.tool === 'text';

// The handle: a tap pulls the room out (or tucks it back in), a drag sizes it
function wirePull(room, rooms, id, relay) {
  const pull = room.querySelector('.bk-slip-room-pull');
  const show = h => {
    room.toggleAttribute('data-open', h > 0);
    room.style.setProperty('--room', `${h}px`);
    pull.setAttribute('aria-expanded', String(h > 0));
    rooms.set(id, h); // (0: tucked in, as the board left it)
    relay();
  };
  let down = null;
  pull.addEventListener('pointerdown', e => {
    e.stopPropagation();
    e.preventDefault();
    pull.setPointerCapture?.(e.pointerId);
    down = { y: e.clientY, h: rooms.get(id) ?? 0, moved: false, k: scaleOf(room) };
  });
  pull.addEventListener('pointermove', e => {
    if (!down) return;
    e.stopPropagation();
    const dy = (e.clientY - down.y) / down.k;
    if (!down.moved && Math.abs(dy) < TAP_PX) return;
    down.moved = true;
    show(Math.round(Math.min(MOST, Math.max(0, down.h + dy))));
  });
  const up = e => {
    if (!down) return;
    e.stopPropagation();
    if (!down.moved) show(down.h ? 0 : ROOM);
    down = null;
  };
  pull.addEventListener('pointerup', up);
  pull.addEventListener('pointercancel', up);
  // (the keyboard's Enter and Space: a click with no press before it)
  pull.addEventListener('click', e => e.detail === 0 && show(rooms.get(id) ? 0 : ROOM));
  for (const type of ['touchstart', 'touchmove']) pull.addEventListener(type, e => e.stopPropagation());
}

// Words typed in the room where the text tool pressed: gone as the reply with Enter, or once left with words in it
function typeAt(paper, [x, y], send, tell, settled) {
  paper.querySelector('.bk-slip-room-words')?.blur();
  const box = Object.assign(document.createElement('p'), { className: 'bk-slip-room-words' });
  box.setAttribute('contenteditable', 'plaintext-only');
  box.setAttribute('aria-label', word('slipRoomWords'));
  box.style.cssText = `left:${Math.round(x)}px;top:${Math.round(y)}px`;
  paper.append(box);
  for (const type of ['pointerdown', 'touchstart', 'touchmove']) box.addEventListener(type, e => e.stopPropagation());
  let gone = false;
  const go = async () => {
    const words = box.textContent.trim();
    if (gone) return;
    gone = true;
    if (words)
      try {
        await send(words);
      } catch (e) {
        gone = false;
        tell(e.message);
        return;
      }
    box.remove();
    settled();
  };
  box.addEventListener('keydown', e => {
    if (e.key === 'Escape') box.textContent = '';
    if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing)) {
      e.preventDefault();
      box.blur();
    }
  });
  box.addEventListener('blur', go);
  requestAnimationFrame(() => box.focus({ preventScroll: true }));
}

// Where a press is in the room's paper (e) or where the paper is on the page (null), in the page's px: the page may
// be shown scaled
function at(paper, e) {
  const r = paper.getBoundingClientRect(),
    k = scaleOf(paper);
  if (e) return [(e.clientX - r.left) / k, (e.clientY - r.top) / k];
  const page = paper.closest('.bk-groups').getBoundingClientRect();
  return { x: (r.left - page.left) / k, y: (r.top - page.top) / k };
}
const scaleOf = el => el.getBoundingClientRect().width / el.offsetWidth;

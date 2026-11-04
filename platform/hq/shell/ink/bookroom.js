// HQ's page in the room the open book leaves it (--book-room on <html>, style.css), moved there by book.js as the book
// is laid out. (Split out of book.js at its size limit)

// HQ's page going to its new room as the book lands: dimmed this quickly to this much (never to black: HQ's ground is
// dark), laid out, and back in, never an instant jump
export const ROOM_MS = { out: 70, in: 130 },
  ROOM_DIM = 0.35;

// HQ's page in its new room: at once at the start and on a new window size; when the board moved the book, a quick
// fade out, laid out, and in again, so the page never jumps. The page takes input all the while.
let roomFade = null;
export function toRoom(px, fade) {
  const html = document.documentElement.style,
    was = html.getPropertyValue('--book-room');
  roomFade?.cancel();
  roomFade = null;
  document.body.getAnimations().forEach(a => a.id === 'bk-room' && a.cancel());
  if (was === `${px}px`) return;
  if (!fade || !was) return html.setProperty('--book-room', `${px}px`);
  const out = (roomFade = fadeBody([1, ROOM_DIM], { duration: ROOM_MS.out, fill: 'forwards' }));
  // (a fade overtaken by the next move leaves the room to that one)
  out.finished.then(
    () => {
      if (roomFade !== out) return;
      html.setProperty('--book-room', `${px}px`);
      out.cancel();
      fadeBody([ROOM_DIM, 1], { duration: ROOM_MS.in, easing: 'ease-out' });
    },
    () => {},
  );
}
const fadeBody = ([from, to], timing) =>
  document.body.animate([{ opacity: from }, { opacity: to }], { id: 'bk-room', ...timing });

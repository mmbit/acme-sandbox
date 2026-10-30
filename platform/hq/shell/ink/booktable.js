// The table under the Notebook (book.css's .bk-table), in the ground of HQ's page: where HQ's page has given up its
// room to the book, or all round the book where it lies over HQ's page (the spread), so nothing of HQ (its logo, menus,
// unread badges) peeks past the book's margins. book.js lays it out; the swing brings the
// spread's in over HQ's page as the board lowers (bookswing.js).

// Its ground round the book and under it as it lifts off: the left side's own background, so what the book uncovers is
// of a piece with the page beside it. The page in HQ's viewer, as its review mode tells it (HQ's dark backdrop, the
// viewer's own, where it tells none); else HQ's own ground in its look (<html>'s where its page has none). Read as the
// book is laid out or starts to move (book.js), as a look is worn, and as the viewer opens, closes or hears its page.
// Set on <html>, so the table and <html>'s own ground while the book lifts off (bookswing.js) follow it when it changes
// midway.

let toned = null;

// The table's ground once HQ wears its look, and again as it changes (stage.js) and as the viewer does
export function mountTones(_table) {
  document.addEventListener('stage:look', tones);
  const viewer = document.getElementById('viewer');
  if (viewer) new MutationObserver(tones).observe(viewer, { attributeFilter: ['hidden', 'data-ground'] });
}
export function tones() {
  const viewer = document.getElementById('viewer'),
    ground =
      viewer && !viewer.hidden
        ? viewer.dataset.ground || getComputedStyle(viewer).backgroundColor
        : [document.body, document.documentElement]
            .map(box => getComputedStyle(box).backgroundColor)
            .find(c => c !== 'rgba(0, 0, 0, 0)');
  if (toned === ground) return;
  toned = ground;
  document.documentElement.style.setProperty('--bk-ground', ground);
}

// The table this wide (room, px) from the screen's right edge, or over all of HQ's page; coming in over it in fadeMs,
// as HQ's page fades into its new room when the board moved the book (the swing's landing has brought it in already)
export function cover(table, over, room = 0, fadeMs = 0) {
  if (over && fadeMs && !table.classList.contains('bk-over'))
    table.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fadeMs, easing: 'ease-out' });
  table.classList.toggle('bk-over', over);
  table.style.width = over ? '' : `${Math.round(room)}px`;
}

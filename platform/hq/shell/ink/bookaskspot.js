// An agent's ask about one thing on a page (hq ask --at --spot), opened from its scrap in the book: a preview opens in
// HQ's viewer, and once review mode there says hello, the thing is scrolled to and flashed in HQ's accent colour
// (shared/review/drive.js flash). Any other page (a live site, where review mode never runs) opens in a new tab at the
// thing's words, which the browser marks itself (a text fragment).
// HQ's viewer and call are loaded at the tap, never with the book: a guest's page has neither. A book lying over the viewer is put away first, so the thing and its flash show.
import { coversViewer, foldBook } from './book.js';

// anchor: the scrap's ({ url, el: { selector, text } })
export async function openSpot(anchor) {
  const [{ inFrame }, { openLink, PREVIEW }] = await Promise.all([import('../calldrive.js'), import('../desk.js')]);
  if (!PREVIEW.test(anchor.url)) return void window.open(textAt(anchor), '_blank', 'noopener');
  const heard = new Promise(done => {
    const hello = e => {
      if (e.detail.url !== anchor.url) return;
      document.removeEventListener('viewer:review', hello);
      done();
    };
    document.addEventListener('viewer:review', hello);
  });
  openLink(anchor.url);
  await heard;
  await bookAway();
  const color = getComputedStyle(document.documentElement).getPropertyValue('--gold').trim();
  const answer = await inFrame({ flash: anchor.el.selector, color });
  if (!answer.done) console.log(`[hq] ask's spot: ${answer.why}`);
}

// The book shut where it lies over the viewer's frames, done once it's laid out shut
async function bookAway() {
  if (!coversViewer()) return;
  const shut = new Promise(done => {
    const laid = e => {
      if (e.detail.mode !== 'folded') return;
      document.removeEventListener('book:layout', laid);
      done();
    };
    document.addEventListener('book:layout', laid);
  });
  foldBook();
  await shut;
}

// The page's address marked at the thing's words (a text fragment: its dashes and commas escaped, as its syntax needs)
function textAt(anchor) {
  const words = anchor.el.text.split(' ').slice(0, 8).join(' ');
  if (!words) return anchor.url;
  const url = new URL(anchor.url);
  url.hash = `${url.hash.slice(1)}:~:text=${encodeURIComponent(words).replaceAll('-', '%2D')}`;
  return url.href;
}

// A call's prototype saved (the coordinator's callprototypes.ts): its card slides in at the screen's top edge, its
// picture and its name with its version, on the board's screens (HQ's 'call:prototype', events.js) and its guest's
// (bookguest.js). In the top layer (a popover), over the book's spread too, which leaves what's under it untappable; it
// covers nothing being drawn on, and goes by itself. Tapped, the prototype opens (open: HQ's viewer, or the guest's
// room's frame); its clip on the call's page opens it again later.
import { esc, stylesheet } from '../../util.js';

stylesheet('shell/ink/bookprototype.css');
// How long the card shows: long enough to look up from the page
const SHOWN_MS = 12_000;

// p: { name, version, picture, link }
export function prototypeCard(p, open) {
  if (!p?.link) return;
  document.querySelector('.bk-proto-card')?.remove();
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'bk-proto-card';
  card.popover = 'manual';
  card.innerHTML = `${p.picture ? `<img src="${esc(p.picture)}" alt="" draggable="false">` : ''}<span><b>${esc(
    p.name,
  )}</b> <span class="bk-proto-v">v${esc(String(p.version))}</span></span>`;
  card.onclick = () => {
    card.remove();
    open(p.link);
  };
  document.body.append(card);
  card.showPopover();
  setTimeout(() => card.classList.add('gone'), SHOWN_MS);
  setTimeout(() => card.remove(), SHOWN_MS + 400);
}

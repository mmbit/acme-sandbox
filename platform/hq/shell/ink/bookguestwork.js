// A piece of work shared with a guest, open with their book beside it (Ink 1.1, the deck's Guests chapter): a slim bar
// back to the work's book and its address, and the work itself in a frame, its session handed on by the guest desk
// (/guest/onward). The book (book.js) takes its room on the right, open at their page on this work, where the notes
// they pin land and the asks for them wait in red. On a phone the book covers it, its handle folding it away.
// Its look: bookguest.css.
import { esc } from '../../util.js';

// work: one of a book's artifacts (GET /guest/notebooks/api/shelf), with book: its project's book
export function showWork(work, text) {
  const view = document.createElement('section');
  view.className = 'bk-guest-view';
  view.setAttribute('aria-label', work.name);
  view.innerHTML = `<div class="bk-guest-bar"><a href="?book=${encodeURIComponent(work.book.key)}">‹ ${esc(work.book.name)}</a>
    <a class="bk-guest-address" href="${esc(work.open)}" target="_blank" rel="noopener">${esc(work.where)}</a></div>
    <iframe title="${esc(text.workTitle)}: ${esc(work.name)}" src="${esc(work.open)}"
      allow="autoplay; fullscreen; clipboard-write"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"></iframe>`;
  document.body.classList.add('bk-guest-working');
  document.querySelector('main').before(view);
}

let heard = null; // (the open prototype's messages, while it's open: fromPrototype)
let closing = null; // (the open prototype's Back)
// A call's prototype (the coordinator's callprototypes.ts), open over the whole screen, the call's page under it: a
// bar back to the page, and the prototype live in a frame, its session handed on by the guest desk (/guest/onward).
// In the top layer (a popover), over the book's spread, which leaves what's under it untappable. Opened again, the
// frame shows the newer one. While it's open, the room's eye and Pause for their screen (bookguestscreen.js) are on its
// bar, and back on the book's after.
export function showPrototype(link, text) {
  closing?.();
  heard = new AbortController();
  const view = document.createElement('section');
  view.className = 'bk-guest-view bk-guest-proto';
  view.innerHTML = `<div class="bk-guest-bar"><button type="button" class="bk-guest-back">${esc(text.backToCall)}</button></div>
    <iframe title="${esc(text.workTitle)}" src="/guest/onward?to=${encodeURIComponent(link)}"
      allow="autoplay; fullscreen; clipboard-write"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"></iframe>`;
  view.popover = 'manual';
  const frame = view.querySelector('iframe');
  const screenKeys = [...document.querySelectorAll('#book .bk-guest-eye, #book .bk-guest-pause')],
    home = screenKeys[0]?.parentElement,
    after = screenKeys.at(-1)?.nextSibling ?? null;
  view.querySelector('.bk-guest-bar').append(...screenKeys);
  closing = () => {
    heard.abort();
    for (const key of screenKeys) home.insertBefore(key, after);
    view.remove();
    closing = null;
  };
  view.querySelector('button').onclick = closing;
  addEventListener('message', e => fromPrototype(e, frame, link), { signal: heard.signal });
  document.body.append(view);
  view.showPopover();
}
// Review mode in the prototype's frame (shared/review/review.js), and only from it: told the call is on, its Pencil's
// mark ({ callMark }) goes to the call's agent as the guest's, a note of the call's that points, as the board's from
// HQ's viewer (desk.js), never a scrap on the call's page; its ink goes once it's in.
function fromPrototype(e, frame, link) {
  const d = e.data;
  if (!frame.isConnected || e.source !== frame.contentWindow || e.origin !== new URL(link).origin) return;
  if (d?.hq !== 'review') return;
  const to = e.source;
  if (d.hello) to.postMessage({ hq: 'hq', call: true }, e.origin);
  else if (d.callMark && Number.isInteger(d.callMark.id)) {
    const { id, anchor, snip } = d.callMark;
    const answer = a => to.postMessage({ hq: 'hq', callMark: { id, ...a } }, e.origin);
    markOnCall(link, anchor, snip).then(
      note => {
        answer({ note });
        to.postMessage({ hq: 'hq', had: note }, e.origin);
      },
      err => answer({ failed: err.message }),
    );
  }
}
async function markOnCall(url, anchor, snip) {
  const r = await fetch('/guest/notebooks/api/prototype-mark', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, anchor, snip: typeof snip === 'string' ? snip : null }),
  });
  const answer = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(answer.error ?? 'Could not reach the call.');
  return answer.id;
}

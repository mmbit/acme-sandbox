// Review mode's controls and ink above the page, including its overlays.
// HQ's controls leave room for the Notebook. Its ink spans the viewport so an overlay above the Notebook can be marked too.

// The host and its shadow root, with css and the markup in it: r.host, r.root
export function makeHost(r, css, html) {
  const host = (r.host = document.createElement('review-mode'));
  host.setAttribute('data-review-ui', '');
  host.setAttribute(
    'style',
    `all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block${r.book ? ';contain:layout' : ''}`,
  );
  const root = (r.root = host.attachShadow({ mode: 'open' }));
  root.innerHTML = html;
  if (r.book)
    css += `
    .ui { right: var(--book-room, 0px); }
    .halo, .ink, .wet { width: 100vw; height: 100dvh; }
    :host([data-spread]) .dock, :host([data-covered]) .dock { display: none; }
    :host([data-under-book]) .bar { display: none; }
    :host([data-under-book]) :is(.halo, .ink, .wet, .hl) { visibility: hidden; }
  `;
  // (a stylesheet of its own rather than a <style>, so a page whose CSP admits no inline style, like HQ's, still draws it)
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  } catch {
    root.prepend(Object.assign(document.createElement('style'), { textContent: css }));
  }
  document.documentElement.append(host);
}

// Above the page's popups: a modal dialog (showModal) or a popover sits in the browser's top layer, over any z-index,
// and a modal one makes everything outside it inert. While one is open the host goes inside the topmost one a tap
// reaches (alive as part of it, and a tap on it is the popup's own, so a light dismiss leaves it be) and joins the top
// layer after it as a manual popover, placed by the viewport whatever the popup's transform. It goes back to the page's
// end once they're closed. A browser without popovers (Safari before 17) leaves it at the page's end, under them.
const isModal = el => el.matches(':modal');
export const inTopLayer = el => isModal(el) || el.matches(':popover-open');
// r.popups: the page's dialogs and popovers in the order they opened, which is the top layer's: a dialog as its open
// attribute changes, a popover at its beforetoggle (both as they happen: the dialogs' records are taken first). Those
// open before review mode started go in the page's order, the modal dialog a tap reaches over the rest: the browser
// tells no more.
export const openPopups = r => r.popups.filter(e => e.isConnected && inTopLayer(e));
// the modal dialog a tap reaches: the one opened last, as the others are inert and a hit test passes them by
function reachable(r, el) {
  const b = el.getBoundingClientRect();
  const x = Math.min(Math.max(b.left + b.width / 2, 0), innerWidth - 1),
    y = Math.min(Math.max(b.top + b.height / 2, 0), innerHeight - 1);
  return document.elementsFromPoint(x, y).some(e => e !== r.host && e.closest(':modal') === el);
}
const activeModal = r => openPopups(r).find(e => isModal(e) && reachable(r, e));
function opening(r, el) {
  r.popups = r.popups.filter(e => e !== el && e.isConnected);
  r.popups.push(el);
}
// reshow: a popup opened or closed, so the host joins the top layer again, after it
function liftHost(r, reshow) {
  const { host } = r;
  r.popups = r.popups.filter(e => e.isConnected);
  // Floating controls own their pen events and their lifetime, so the ink stays outside their layer.
  const modal = activeModal(r),
    topmost = openPopups(r).findLast(e => (!modal || modal.contains(e)) && !e.matches('[data-no-ink]'));
  if (!topmost) {
    if (host.parentNode !== document.documentElement) document.documentElement.append(host);
    if (r.book) showHost(host, reshow);
    else host.removeAttribute('popover');
    showSpread(r);
    return;
  }
  let showAgain = reshow;
  if (host.parentNode !== topmost) {
    topmost.append(host);
    showAgain = true;
  } // (out of the document, a popover is hidden)
  showHost(host, showAgain);
  showSpread(r);
}
// The book's spread covers HQ's page, and with it what's drawn on it here: the ink and the strip on HQ's page, though
// the host is in the top layer, are hidden under it (not the host in a popup over the book, whose ink is the popup's).
// While a part is marked data-takes-ink (a book's paper given to HQ's pen), the ink and the strip show over the book.
// (a part that shows: a closed popup marked so, the book's Shelf on a call, leaves them under it)
const takingInk = () => [...document.querySelectorAll('[data-takes-ink]')].some(el => el.checkVisibility());
function showSpread(r) {
  const spread = r.book && document.documentElement.dataset.book === 'spread';
  r.host.toggleAttribute('data-spread', spread);
  r.host.toggleAttribute('data-under-book', spread && r.host.parentNode === document.documentElement && !takingInk());
}
function showHost(host, again) {
  host.popover = 'manual';
  if (again && host.matches(':popover-open')) host.hidePopover();
  if (!host.matches(':popover-open')) host.showPopover();
}
// the dialogs whose open attribute changed, in order; true when there was one
function dialogsChanged(r, records) {
  const dialogs = records.filter(c => c.type === 'attributes' && c.target.localName === 'dialog').map(c => c.target);
  for (const dialog of dialogs) if (dialog.open) opening(r, dialog);
  return dialogs.length > 0;
}

export function followPopups(r) {
  r.popups = [];
  if (!('showPopover' in r.host && CSS.supports('selector(:modal)'))) return;
  r.popups = [...document.querySelectorAll('dialog[open], [popover]')].filter(el => el !== r.host && inTopLayer(el));
  const modal = activeModal(r);
  if (modal) r.popups = [...r.popups.filter(e => !modal.contains(e)), ...r.popups.filter(e => modal.contains(e))];
  const watch = new MutationObserver(records => {
    showSpread(r);
    const changed = dialogsChanged(r, records);
    // (or a popup, or the host in it, taken out)
    if (changed || !r.host.isConnected || r.popups.some(e => !e.isConnected)) liftHost(r, changed);
  });
  // (data-takes-ink too, for showSpread.)
  watch.observe(document, {
    attributes: true,
    attributeFilter: ['open', 'data-book', 'data-takes-ink'],
    childList: true,
    subtree: true,
  });
  addEventListener(
    'beforetoggle',
    e => {
      if (e.target === r.host || !e.target.hasAttribute?.('popover') || e.newState !== 'open') return;
      const changed = dialogsChanged(r, watch.takeRecords());
      opening(r, e.target);
      if (changed) queueMicrotask(() => liftHost(r, true));
    },
    true,
  );
  addEventListener(
    'toggle',
    e => {
      if (e.target !== r.host && e.target.hasAttribute?.('popover')) liftHost(r, true);
    },
    true,
  );
  liftHost(r, false);
}
// what's under the finger, inside open shadow roots too: a tap in a chat's panel is the bubble or button there, not
// the chat's empty host element at the page's end
export function under(r, x, y) {
  let el =
    document.elementsFromPoint(x, y).find(e => e !== r.host && e !== document.documentElement && e !== document.body) ||
    document.body;
  for (let root; (root = el.shadowRoot);) {
    // the topmost of its own (ours is on top of everything)
    const inner = root.elementsFromPoint(x, y).find(e => e.getRootNode() === root);
    if (!inner) break;
    el = inner;
  }
  return el;
}

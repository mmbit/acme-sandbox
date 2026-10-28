// Review mode's own element over the page: a closed shadow root (product styles can't touch it) at the page's end, and
// above the page's popups.
// On HQ's own pages (r.book) the page is <body>, beside the book (platform/hq/shell/ink/book.js; Ink's folder): the host lives in it, and its layout containment fits the host's fixed box to the
// page, so the Pencil never draws over the book's paper or rail, and the book's spread covers it with the page. In the
// top layer (over one of HQ's dialogs) the host leaves the book's room itself, and its own layout containment keeps the
// fixed .ui in its box.
const homeOf = r => (r.book ? document.body : document.documentElement);

// The host and its shadow root, with css and the markup in it: r.host, r.root
export function makeHost(r, css, html) {
  const host = (r.host = document.createElement('review-mode'));
  host.setAttribute(
    'style',
    `all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block${r.book ? ';contain:layout' : ''}`,
  );
  const root = (r.root = host.attachShadow({ mode: 'closed' }));
  root.innerHTML = html;
  // (a stylesheet of its own rather than a <style>, so a page whose CSP admits no inline style, like HQ's, still draws it)
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  } catch {
    root.prepend(Object.assign(document.createElement('style'), { textContent: css }));
  }
  homeOf(r).append(host);
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
  const modal = activeModal(r),
    topmost = openPopups(r).findLast(e => !modal || modal.contains(e));
  if (!topmost) {
    if (host.parentNode !== homeOf(r)) homeOf(r).append(host);
    host.removeAttribute('popover');
    host.style.right = '0';
    return;
  }
  let showAgain = reshow;
  if (host.parentNode !== topmost) {
    topmost.append(host);
    showAgain = true;
  } // (out of the document, a popover is hidden)
  host.popover = 'manual';
  // (the top layer is placed by the window: on HQ's pages it leaves the book's room, as HQ's own dialogs do.)
  if (r.book) host.style.right = 'var(--book-room, 0px)';
  if (showAgain && host.matches(':popover-open')) host.hidePopover();
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
  r.popups = [...document.querySelectorAll('dialog[open], [popover]')].filter(inTopLayer);
  const modal = activeModal(r);
  if (modal) r.popups = [...r.popups.filter(e => !modal.contains(e)), ...r.popups.filter(e => modal.contains(e))];
  const watch = new MutationObserver(records => {
    const changed = dialogsChanged(r, records);
    // (or a popup, or the host in it, taken out)
    if (changed || !r.host.isConnected || r.popups.some(e => !e.isConnected)) liftHost(r, changed);
  });
  watch.observe(document, { attributes: true, attributeFilter: ['open'], childList: true, subtree: true });
  addEventListener(
    'beforetoggle',
    e => {
      if (e.target === r.host || !e.target.hasAttribute?.('popover') || e.newState !== 'open') return;
      const changed = dialogsChanged(r, watch.takeRecords());
      opening(r, e.target);
      if (changed) liftHost(r, true);
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

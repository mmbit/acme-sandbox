// The page's top layer in a watch-along: what a page shows over everything (a popover, a modal dialog: HQ's small call,
// its cards, a picture opened large) is there by a call (showPopover, showModal), never by anything in the DOM, so rrweb
// records the element but not that it's shown, and a replay draws it hidden. The recorder, the page's and a framed
// page's alike, marks a `top` moment whenever its document's top layer changes, with rrweb's ids of what's in it from
// the bottom up, and the replay shows the same in each document before each picture. Whatever goes in the top layer is
// captured so, whichever part of a page or a preview in it put it there.
import { placer } from './strokes.js';

// What in a document is in its top layer (a page's popovers and modal dialogs). A browser without :popover-open has
// none open.
const OPEN = [':popover-open', 'dialog:modal'].filter(selector => CSS.supports(`selector(${selector})`));
const inTop = doc => OPEN.flatMap(selector => [...doc.querySelectorAll(selector)]);
// How often the top layer is read besides each toggle and change: a dialog's showModal fires no toggle in every browser
const READ_MS = 1000;
// rrweb's event types this file reads
const FULL_SNAPSHOT = 2,
  CUSTOM = 5;

// In the recording page or a page in its frame (watchalong.js, both): a `top` moment as recording starts and whenever
// its document's top layer changes, `{ id: [the document, ...its top layer from the bottom up] }`, rrweb's ids. One
// list under `id`, as rrweb makes a frame's ids the framing page's on the way up only there (a custom event's id,
// parentId, previousId and nextId). What was shown last goes last, as the browser stacks it. Read again as the DOM
// changes too (a popover's attribute taken off, an element in the layer removed: neither says so by an event), so the
// moment follows rrweb's of the change. → its stop
export function hearTopLayer(record) {
  let order = [],
    sent = null;
  const read = () => {
    const now = inTop(document);
    order = [...order.filter(el => now.includes(el)), ...now.filter(el => !order.includes(el))];
    const id = [document, ...order].map(node => record.mirror.getId(node));
    // (an element rrweb hasn't taken in yet is read again on the next toggle, change or tick)
    if (id.includes(-1) || String(id) === sent) return;
    sent = String(id);
    record.addCustomEvent('top', { id });
  };
  // (a popover shown again comes back on top: its toggle says so, after the change)
  const toggled = e => {
    if (e.newState === 'open') order = [...order.filter(el => el !== e.target), e.target];
    read();
  };
  document.addEventListener('toggle', toggled, true);
  document.addEventListener('close', read, true);
  // (after rrweb's own observer, made as recording started: its change goes first)
  const changes = new MutationObserver(read);
  changes.observe(document, { subtree: true, childList: true, attributeFilter: ['popover', 'open'] });
  const tick = setInterval(read, READ_MS);
  read();
  return () => {
    clearInterval(tick);
    changes.disconnect();
    document.removeEventListener('toggle', toggled, true);
    document.removeEventListener('close', read, true);
  };
}

// A recorded event's top layer, if it's a `top` moment: rrweb's ids, its document's then the layer's from the bottom up
export const topLayerIds = event =>
  event.type === CUSTOM && event.data?.tag === 'top' && Array.isArray(event.data.payload?.id)
    ? event.data.payload.id
    : null;
// The top layers as the events come: each document's (the page's, a frame's), last recorded last. A new page on top (its
// full snapshot; a frame's comes as a change) starts afresh.
export class Layers {
  byDocument = new Map(); // a document's id → its top layer's ids from the bottom up
  add(event) {
    if (event.type === FULL_SNAPSHOT) return this.byDocument.clear();
    const [doc, ...ids] = topLayerIds(event) ?? [];
    if (doc === undefined) return;
    this.byDocument.delete(doc);
    this.byDocument.set(doc, ids);
  }
}
// The events Layers reads (what the player keeps of a recording for it)
export const changesLayers = event => event.type === FULL_SNAPSHOT || !!topLayerIds(event);
// The top layers as they were at a time in a recording
export function topAt(events, time) {
  const layers = new Layers();
  for (const event of events) {
    if (event.timestamp > time) break;
    layers.add(event);
  }
  return layers;
}

// In a replay: rrweb's page and its frames show their recorded top layers, in order, before a picture. A document
// shown already as asked (the same elements) is left as it is. A frame's page recorded again (a page after page in it)
// is the same document in the replay: the layer last recorded for it is its own. One not on screen (its frame gone)
// shows nothing. An element that's not in its document there, or can't go in its top layer, is a replay that isn't
// the page: it throws, and the picture with it.
const raised = new WeakMap(); // a replay's document → the elements last put in its top layer
export function raise(replayer, layers) {
  const mirror = replayer.getMirror(),
    placeOf = placer(replayer),
    done = new Set();
  for (const [id, ids] of [...layers.byDocument].reverse()) {
    const doc = mirror.getNode(id);
    if (!placeOf(id) || done.has(doc)) continue;
    done.add(doc);
    const want = ids.map(el => {
      const node = mirror.getNode(el);
      if (node?.ownerDocument !== doc || !node.isConnected)
        throw new Error(`the top layer's element ${el} isn't in its document's replay`);
      return node;
    });
    const last = raised.get(doc);
    const now = inTop(doc);
    if (last && last.length === want.length && last.every((el, i) => el === want[i]) && now.length === want.length)
      continue;
    for (const el of now) shut(el);
    for (const el of want) show(el);
    raised.set(doc, want);
  }
}
function show(el) {
  if (el.localName !== 'dialog') return el.showPopover();
  el.removeAttribute('open'); // (rrweb's copy of a modal dialog is an open one, which showModal refuses)
  el.showModal();
}
function shut(el) {
  if (el.localName !== 'dialog') return el.hidePopover();
  // (back to rrweb's copy: open in the page, or closed there with only its attribute taken off, which close() needs)
  const open = el.hasAttribute('open');
  el.setAttribute('open', '');
  el.close();
  if (open) el.setAttribute('open', '');
}

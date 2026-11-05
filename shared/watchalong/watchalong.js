// The watch-along's recorder: a page of ours records itself so an agent can see along (a walk-through call, later the
// support chat) and anyone can watch it back. README.md has the design.
import { record } from './vendor/rrweb-record.js';
import { hearInk } from './strokes.js';
import { hearMedia } from './media.js';
import { hearTopLayer } from './toplayer.js';
import { frames, toFramer } from './frames.js';
import { FLUSH_MS, sender } from './sender.js';
import { STYLESHEETS } from './fonthosts.js';

// A tap: the pointer comes up within this far and this soon of where it went down
const TAP_PX = 10,
  TAP_MS = 800;
const LABEL_CHARS = 60;
// What never leaves the page: whatever is marked (a card's key fields; the call's own window
// and bubble no longer)
export const HIDE = '[data-watchalong-hide]';
// A person's private details on a page (an address, an email, a customer's case): their text and anything typed in
// them leave the page masked, for the board's own calls too, their elements keep only the attributes the replay draws
// them by, and their pictures (a style's too) go as empty boxes
export const PRIVATE = '[data-private]';
// rrweb's own (rr_width, _cssText...; never rr_dataURL, a picture's pixels), the layout's, the mark itself, and a
// popover's, which the replay shows it by (toplayer.js)
const DRAWN =
  /^(rr_(?!dataURL)\w+|_cssText|class|style|id|type|role|width|height|colspan|rowspan|dir|hidden|open|popover|data-private)$/;
// A frame in it goes as a box too, its page being outside the mark, and so does a marked part of a drawing (lettering
// as paths, a line of Budling's label).
const PRIVATE_PICTURES = ['img', 'picture', 'video', 'canvas', 'svg', 'iframe']
  .flatMap(tag => [`${PRIVATE} ${tag}`, `${tag}${PRIVATE}`])
  .concat(`svg ${PRIVATE}`)
  .join(', ');
// rrweb's event types and sources this file reads
const FULL_SNAPSHOT = 2,
  INCREMENTAL = 3,
  META = 4,
  MUTATION = 0;

// Starts recording this page and posting its events to `url` (the store's session route, its key in the query).
// typed: 'shown' keeps what is typed, except passwords (the board's own calls); 'hidden' keeps only that it was typed
// and how much (guests, customers). canvasFps: canvas frames a second, 0 for none. onEnd(why) runs once it stops for
// good: 'stopped', 'over', 'full', 'too big' (one event past what a post holds) or 'unreachable'. onSeen(seen) runs
// with each batch the server says whether the agent watching along sees the page (true or false; a session watched for
// no agent, or not known yet, says nothing).
export function watch({ url, typed = 'hidden', canvasFps = 0, onEnd = () => {}, onSeen = () => {} }) {
  let stopPage = null,
    stopping = false,
    ended = false;
  const finish = why => {
    if (ended) return;
    ended = true;
    stopPage?.();
    stopPage = null;
    outbox.close();
    onEnd(why);
  };
  const outbox = sender(url, finish, onSeen);
  const start = () => (stopPage = recordPage(typed, canvasFps, outbox.push));
  start();
  return {
    // A moment of the page's own, kept with its events (the pen's strokes it hears by itself: inks)
    mark: (tag, payload) => stopPage && record.addCustomEvent(tag, payload),
    pause() {
      if (!stopPage) return;
      record.addCustomEvent('paused', {});
      stopPage();
      stopPage = null;
    },
    resume() {
      if (stopPage || stopping || ended) return;
      start();
      record.addCustomEvent('resumed', {});
    },
    get paused() {
      return !stopPage;
    },
    // Recording stops at once, the page's and its frames'; then what was recorded until then is sent
    async stop() {
      stopping = true;
      stopPage?.();
      stopPage = null;
      await outbox.drain();
      finish('stopped');
    },
  };
}

// This page's recording with its taps and pages, and its frames asked to record too: what stops it all
function recordPage(typed, canvasFps, emit) {
  const frameChannels = frames();
  const stopRecording = record({ ...settings(typed), emit });
  // canvases on HQ's own page only (its building): no frame or preview loads canvas.js
  let stopped = false,
    stopCanvases = null,
    stopPictures = null;
  if (canvasFps > 0)
    import('./canvas.js').then(({ sampleCanvases }) => !stopped && (stopCanvases = sampleCanvases(canvasFps, emit)));
  // the page's pictures a replay can't load by their address, carried
  import('./routepictures.js').then(({ carryPictures }) => !stopped && (stopPictures = carryPictures()));
  const stopChanges = hearChanges();
  frameChannels.startAll(typed);
  const loaded = event => event.target instanceof HTMLIFrameElement && frameChannels.start(event.target, typed);
  document.addEventListener('load', loaded, true);
  return () => {
    document.removeEventListener('load', loaded, true);
    stopped = true;
    stopCanvases?.();
    stopPictures?.();
    stopChanges();
    stopRecording?.();
    frameChannels.stopAll();
  };
}

// In a page that may be shown in a frame of `framer` (HQ's origin): record while that page asks, as it says. It asks
// as it starts and as this page loads, which may be twice for one page: a second start goes on with the first.
// Returns what it does with a message, for one heard before it ran (review.js loads this file on HQ's first ask).
export function answerFrames(framer) {
  let stop = null,
    recording = '';
  const toParent = toFramer();
  const halt = () => {
    stop?.();
    stop = null;
    recording = '';
    toParent.connect(null);
  };
  const hear = event => {
    if (event.source !== window.parent || event.origin !== framer) return;
    const { watchalong } = event.data ?? {};
    const typed = event.data?.typed === 'shown' ? 'shown' : 'hidden';
    if (watchalong !== 'start' && watchalong !== 'stop') return;
    if (watchalong === 'stop') return halt();
    toParent.connect(event.ports[0]);
    if (recording === typed) return;
    stop?.();
    stop = watchFrame({ typed, emit: toParent.emit });
    recording = typed;
  };
  addEventListener('message', hear);
  addEventListener('pagehide', event => !event.persisted && halt());
  return hear;
}

// A page in a frame records itself: its events go up to the framing page's recorder, which keeps them as its own.
// Returns what stops it.
export function watchFrame({ typed = 'hidden', emit }) {
  const stopRecording = record({ ...settings(typed), recordCrossOriginIframes: false, emit });
  const stopChanges = hearChanges();
  return () => {
    stopChanges();
    stopRecording?.();
  };
}

// The main page and each framed page record the same visible changes.
function hearChanges() {
  const stops = [taps(), pages(), hearInk(record, named), hearTopLayer(record), hearMedia(record)];
  return () => stops.forEach(stop => stop());
}

// Every kind of field's value goes through maskInputFn: rrweb masks a field only where its options say so, and its
// maskAllInputs leaves out hidden fields (a page's tokens)
const MASKED_FIELDS = Object.fromEntries(
  'color date datetime-local email month number range search tel text time url week textarea select password hidden'
    .split(' ')
    .map(type => [type, true]),
);
// rrweb's options, both kinds of page alike
const settings = typed => ({
  recordCrossOriginIframes: true,
  blockSelector: `${HIDE}, ${PRIVATE_PICTURES}`,
  maskInputOptions: MASKED_FIELDS,
  maskInputFn: (value, field) => (typed === 'shown' && !secret(field) ? value : '*'.repeat(value.length)),
  // a page's title too: a page may put a person's words in it (a customer's name on their case)
  maskTextSelector: typed === 'shown' ? `${PRIVATE}, title` : `${PRIVATE}, title, [contenteditable]`,
  slimDOMOptions: 'all',
  // A shadow root's change event does not cross its host. Input does, including words still being typed.
  sampling: { mousemove: 100, scroll: 150, input: 'all' },
  plugins: [{ name: 'watchalong/address', eventProcessor: withoutSecrets }],
});
// A password (rrweb marks one a page has turned to plain text), a hidden field, or a field in a private part
const secret = field =>
  field.type === 'password' ||
  field.type === 'hidden' ||
  field.hasAttribute('data-rr-is-password') ||
  !!field.closest(PRIVATE);

// A page's address keeps its origin and path: no query or fragment (a one-time code, a search), and no path part that
// is a token (a join or guest link's). So do the links and frames on it, and a link of another kind keeps only its
// kind (mailto:, tel:). A picture keeps its whole address, which the replay loads it by, and so does a link to a
// stylesheet of Google's fonts, whose query names the fonts (a look's). Inside a
// private part, only the attributes the replay draws by stay, and its style without pictures.
const withoutSecrets = event => {
  if (event.type === META) event.data.href = address(event.data.href);
  if (event.type === FULL_SNAPSHOT) scrub(event.data.node, false);
  if (event.type === INCREMENTAL && event.data.source === MUTATION) {
    for (const added of event.data.adds) scrub(added.node, inPrivatePart(added.parentId));
    for (const changed of event.data.attributes) {
      const element = record.mirror.getNode(changed.id);
      withAddress(changed.attributes, element);
      scrubAttributes(changed.attributes, element?.tagName?.toLowerCase() ?? '', inPrivatePart(changed.id));
    }
  }
  return event;
};
// A node rrweb knows by this id is a private part or inside one
const inPrivatePart = id => !!record.mirror.getNode(id)?.closest?.(PRIVATE);
function scrub(node, inPrivate) {
  const isPrivate = inPrivate || Object.hasOwn(node.attributes ?? {}, 'data-private');
  if (node.attributes) {
    withAddress(node.attributes, record.mirror.getNode(node.id));
    scrubAttributes(node.attributes, node.tagName, isPrivate);
  }
  for (const child of node.childNodes ?? []) scrub(child, isPrivate);
}
// A linked stylesheet rrweb inlined (_cssText, its rules as this browser reads them back) keeps its address, which
// rrweb drops: a mirror replays it as its file says it (sheets.ts), as Chromium leaves out a shorthand with a var() in
// it (HQ's font).
function withAddress(attributes, element) {
  // (a framed page's link is of its own window's HTMLLinkElement)
  if (typeof attributes._cssText === 'string' && !attributes.href && element?.localName === 'link' && element.href)
    attributes.href = element.href;
}
// rr_src: where rrweb keeps a frame's address
function scrubAttributes(attributes, tag, isPrivate) {
  if (isPrivate) for (const name of Object.keys(attributes)) if (!DRAWN.test(name)) delete attributes[name];
  if (isPrivate && attributes.style) attributes.style = withoutPictures(attributes.style);
  for (const name of ['href', 'rr_src', ...(tag === 'iframe' ? ['src'] : [])])
    if (typeof attributes[name] === 'string' && !(name === 'href' && tag === 'link' && fonts(attributes.href)))
      attributes[name] = linkWithoutDetails(attributes[name]);
}
const fonts = href => URL.canParse(href) && new URL(href).hostname === STYLESHEETS;
// A private element's style keeps its layout but none of its pictures (a background, a mask, a cursor, a variable that
// holds one): every declaration whose value, as the browser reads it, has an address goes. rrweb sends a change as the
// whole attribute or as a diff ({ name: value | [value, priority] | false }). A shorthand using var() has no parsed
// values to look at, so a style still holding an address after that goes whole.
function withoutPictures(style) {
  const pictured = value => typeof value === 'string' && /url\(/i.test(value);
  if (typeof style !== 'string')
    return Object.fromEntries(Object.entries(style).filter(([, value]) => !pictured([value].flat()[0])));
  const parsed = document.createElement('i').style;
  parsed.cssText = style;
  for (const name of [...parsed]) if (pictured(parsed.getPropertyValue(name))) parsed.removeProperty(name);
  return pictured(parsed.cssText) ? '' : parsed.cssText;
}
const linkWithoutDetails = link => {
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(link)?.[1].toLowerCase();
  if (scheme && scheme !== 'http' && scheme !== 'https') return `${scheme}:`;
  return URL.canParse(link, location.href) ? address(new URL(link, location.href).href) : '';
};
export const address = href => {
  const url = new URL(href);
  const path = url.pathname
    .split('/')
    .map(part => (/^[\w-]{20,}$/.test(part) ? '…' : part))
    .join('/');
  return url.origin + path;
};

// A 'page' moment now and whenever the address changes (also within a single-page app, without touching history). Not
// the title, which the recording masks too: a page may put a person's words in it. Returns what stops looking.
function pages() {
  let last = '';
  const look = () => {
    const here = address(location.href);
    if (here === last) return;
    last = here;
    record.addCustomEvent('page', { address: here });
  };
  look();
  const tick = setInterval(look, FLUSH_MS);
  return () => clearInterval(tick);
}

// A 'tap' moment for every tap or click: where, with what, and on what (its own name and role, never a field's value)
function taps() {
  // (reach: the farthest the pointer got from where it went down, so a quick closed ring is no tap)
  let down = null;
  const onDown = e => (down = { x: e.clientX, y: e.clientY, at: e.timeStamp, reach: 0 });
  const onMove = e => down && (down.reach = Math.max(down.reach, Math.hypot(e.clientX - down.x, e.clientY - down.y)));
  const onUp = e => {
    const tapped =
      down &&
      Math.max(down.reach, Math.hypot(e.clientX - down.x, e.clientY - down.y)) < TAP_PX &&
      e.timeStamp - down.at < TAP_MS;
    down = null;
    if (!tapped || !(e.target instanceof Element)) return;
    const x = Math.round(e.clientX),
      y = Math.round(e.clientY);
    record.addCustomEvent('tap', { x, y, pointer: e.pointerType || 'mouse', ...described(e.target) });
  };
  const options = { capture: true, passive: true };
  addEventListener('pointerdown', onDown, options);
  addEventListener('pointermove', onMove, options);
  addEventListener('pointerup', onUp, options);
  return () => {
    removeEventListener('pointerdown', onDown, options);
    removeEventListener('pointermove', onMove, options);
    removeEventListener('pointerup', onUp, options);
  };
}

const CONTROL = 'a, button, input, select, textarea, label, summary, [role], [aria-label], [title], [tabindex]';
// What a person would call the thing an element is part of (described), and its box; null for one never recorded
// (strokes.js names what a pen stroke is over by it).
const named = element => {
  if (element === document.documentElement || element === document.body || element.closest(HIDE)) return null;
  const control = element.closest(CONTROL) ?? element;
  return { control, ...described(control) };
};
// What a person would call the thing they tapped
export function described(target) {
  const control = target.closest(CONTROL) ?? target;
  const tag = control.tagName.toLowerCase();
  const role = control.getAttribute('role') ?? (tag === 'input' ? `input ${control.type}` : tag);
  if (control.closest(`${HIDE}, ${PRIVATE}`)) return { role, label: '' };
  const field = ['input', 'select', 'textarea'].includes(tag);
  const named = control.getAttribute('aria-label') || (field ? fieldName(control) : ownWords(control));
  return { role, label: tidy(named ?? '') };
}
// A field's name is its label or placeholder, never what's in it
const fieldName = field =>
  field.labels?.[0]?.textContent || field.getAttribute('placeholder') || field.getAttribute('name');
// Anything else says what it shows, unless that's someone's typing or holds a hidden, private or typed-in part
const ownWords = control =>
  control.getAttribute('alt') ||
  control.getAttribute('title') ||
  (control.isContentEditable || control.querySelector(`${HIDE}, ${PRIVATE}, [contenteditable]`)
    ? ''
    : control.textContent);
const tidy = words => {
  const line = words.replace(/\s+/g, ' ').trim();
  return line.length > LABEL_CHARS ? `${line.slice(0, LABEL_CHARS - 1)}…` : line;
};

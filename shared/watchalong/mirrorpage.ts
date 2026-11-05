// The watch-along mirror's own page (mirror.ts): the replay its tabs open, the files it asks for of its own, and the
// answer to everything it asks for (answered).
import { readFileSync } from 'node:fs';
import type { Answer, Asked } from '../chromium/chromium.ts';

// The replay's own files, on an origin that never resolves
export const ORIGIN = 'https://mirror.invalid';
// The owner's answer to what the recorded page asks for, given the origins of the recording's pages it may show
export type Answering = (asked: Asked, pages: Set<string>) => Promise<Answer>;

// The replay's page: rrweb's replayer at the top left, at the recorded screen's size, its own cursor hidden. Live, every
// event is played as it's added (its baseline far ahead: no event waits for its time). A past moment plays to its time.
// Its policy runs only its own script files: rrweb's frame takes it on (an about:blank frame keeps its maker's), so
// nothing the recorded page carries runs (an onerror, a javascript: address, a script). The frame itself can't be the
// boundary: rrweb draws canvas frames only in a frame allowed scripts (UNSAFE_replayCanvas), as a canvas in one without
// shows nothing.
const PAGE = `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="script-src 'self'; object-src 'none'; base-uri 'none'">
<link rel="stylesheet" href="/replay.css">
<style>
  html, body { margin: 0; background: #fff; overflow: hidden; }
  .replayer-wrapper { position: absolute; left: 0; top: 0; transform: none !important; }
  .replayer-mouse, .replayer-mouse-tail { display: none !important; }
  .replayer-wrapper iframe { border: 0; display: block; }
  #ink, #ink div { position: absolute; left: 0; top: 0; z-index: 9; pointer-events: none; }
  #ink svg { overflow: visible; display: block; }
  .unshown { position: absolute; z-index: 8; box-sizing: border-box; display: grid; place-items: center; overflow: hidden;
    border: 2px dashed #6b6875; color: #2a2352; font: 600 12px/1.2 system-ui, sans-serif; text-align: center;
    background: repeating-linear-gradient(135deg, #f1efe9 0 8px, #e2dfd6 8px 16px); pointer-events: none; }
  #ring { position: absolute; z-index: 10; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%;
    border: 4px solid #ff2d55; box-shadow: 0 0 0 3px #fff; box-sizing: border-box; pointer-events: none; }
</style>
<script type="module" src="/mirror.js"></script>`;
const MIRROR = `window.process = { env: {} }; // (replay.js reads process.env in its error paths)
  const { Replayer } = await import('/replay.js');
  // the pen's ink (strokes.js), drawn over the screen with ink.js as SVG, so a picture at any scale is sharp
  const { Inks, inkAt, placer } = await import('/strokes.js');
  const ink = await import('/ink.js');
  // what the page shows over everything (toplayer.js), shown so in the replay.
  const { Layers, raise, topAt } = await import('/toplayer.js');
  const { Media, mediaAt, applyMedia } = await import('/media.js');
  // what rrweb's rebuild gets unlike the page, put right in the events it takes (rebuilt.js.)
  const { Rebuilt } = await import('/rebuilt.js');
  let media = new Media(), rebuilt = new Rebuilt();
  let inks = new Inks(), past = null, sized = null, tops = new Layers();
  // (useVirtualDom off: live, every event is older than the baseline, so rrweb plays each as a fast-forward, into its
  // virtual DOM, which only a fast-forward's end copies onto the screen: the live mirror showed the page as the share
  // found it, whatever changed after.)
  const OPTIONS = { root: document.body, mouseTail: false, triggerFocus: false, showWarning: false, showDebug: false,
    UNSAFE_replayCanvas: true, skipInactive: false, speed: 1, useVirtualDom: false };
  let replayer = null;
  const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  // Shadow trees and framed documents own their animations and pictures. The outer document doesn't list them.
  // A replayed document's viewport's place on the mirror's page (a frame's within its framing documents)
  function offset(doc) {
    let x = 0, y = 0;
    for (let frame = doc.defaultView?.frameElement; frame && frame.ownerDocument !== document; frame = frame.ownerDocument.defaultView?.frameElement) {
      const r = frame.getBoundingClientRect();
      x += r.left + frame.clientLeft;
      y += r.top + frame.clientTop;
    }
    return { x, y };
  }
  function* roots(root) {
    yield root;
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) yield* roots(element.shadowRoot);
      if (element.contentDocument) yield* roots(element.contentDocument);
    }
  }
  window.mirror = {
    async live(events) {
      replayer = new Replayer([], { ...OPTIONS, liveMode: true });
      replayer.startLive(8.64e15);
      inks = new Inks();
      tops = new Layers();
      media = new Media();
      rebuilt = new Rebuilt();
      return this.add(events);
    },
    async add(events) {
      for (const event of events) {
        inks.add(event);
        tops.add(event);
        media.add(event);
      }
      this.reload(events);
      for (const event of rebuilt.take(events)) replayer.addEvent(event);
      await frames();
    },
    // The pictures replayed before the recording carried them (routepictures.js sends one once it has loaded on the
    // page, often a batch after the element showing it): each failed when the replay asked for it, and is asked for
    // again now that the mirror has it.
    reload(events) {
      const came = new Set(events.filter(e => e.type === 5 && e.data.tag === 'picture').map(e => e.data.payload?.address));
      const doc = replayer?.iframe?.contentDocument;
      if (!came.size || !doc) return;
      for (const tree of roots(doc))
        for (const image of tree.querySelectorAll('img'))
          if (came.has(image.currentSrc || image.src) && !(image.complete && image.naturalWidth))
            image.hasAttribute('srcset') ? (image.srcset = image.srcset) : (image.src = image.src);
    },
    async at(events, time) {
      if (!events.length) return;
      past = inkAt(events, time);
      media = mediaAt(events, time + 1);
      tops = topAt(events, time + 1); // (as far as the replay plays)
      replayer = new Replayer(new Rebuilt().take(events), OPTIONS);
      replayer.pause(Math.max(0, time - events[0].timestamp) + 1); // (what happened at that time too)
      // (the screen's size as it was then: a past moment kept the size the share began at, a narrowed window's page laid
      // out wide.)
      sized = events.findLast(e => e.timestamp <= time && (e.type === 4 || (e.type === 3 && e.data.source === 4)));
      await frames();
    },
    // The screen's size once drawn (none before a full snapshot), the page made as big, and a tap ringed
    async drawn(ring) {
      await frames();
      const iframe = replayer && replayer.iframe;
      // (once rrweb's own sizing is done with)
      if (past && sized) for (const side of ['width', 'height']) iframe.setAttribute(side, String(sized.data[side]));
      const width = iframe && Number(iframe.width), height = iframe && Number(iframe.height);
      if (!width || !height || !iframe.contentDocument || !iframe.contentDocument.documentElement) return null;
      applyMedia(replayer, media);
      raise(replayer, tops);
      // (what was coming in or going shown as it ends: rrweb holds the page's CSS animations where they start, so an
      // overlay that fades in, HQ's intercom say, stayed invisible. One that never ends stays.)
      const trees = [...roots(iframe.contentDocument)];
      for (const tree of trees) for (const motion of tree.getAnimations())
        if (motion.effect && motion.effect.getComputedTiming().endTime !== Infinity) motion.finish();
      this.ink();
      if (ring) {
        const mark = document.createElement('div');
        mark.id = 'ring';
        mark.style.left = ring.x + 'px';
        mark.style.top = ring.y + 'px';
        document.body.append(mark);
      }
      // (the pictures on screen: one that never loads, a lazy one below the screen or in a hidden part, never decodes)
      const shown = image => {
        const r = image.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < height && r.left < width;
      };
      const images = trees.flatMap(tree => [...tree.querySelectorAll('img')]).filter(shown);
      await Promise.all(images.map(image => image.decode().catch(() => {})));
      this.unshown(images.filter(image => (image.getAttribute('src') || image.getAttribute('srcset')) && !image.naturalWidth));
      await frames();
      return { width, height };
    },
    // A picture on screen that didn't load in the replay (one only the page could load: a blob's, or a file gone) is
    // marked as not captured over its place, never shown broken as if it were the page's.
    unshown(images) {
      document.querySelectorAll('.unshown').forEach(mark => mark.remove());
      for (const image of images) {
        if (!image.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        const r = image.getBoundingClientRect(), at = offset(image.ownerDocument), mark = document.createElement('div');
        mark.className = 'unshown';
        Object.assign(mark.style, { left: at.x + r.left + 'px', top: at.y + r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
        if (r.width >= 60 && r.height >= 28) mark.textContent = 'picture not captured';
        document.body.append(mark);
      }
    },
    unring() {
      document.getElementById('ring')?.remove();
      document.querySelectorAll('.unshown').forEach(mark => mark.remove());
    },
    // the strokes on screen (as they were at a past moment's time), each in its page's or frame's place
    ink() {
      document.getElementById('ink')?.remove();
      const where = placer(replayer), layer = document.createElement('div');
      layer.id = 'ink';
      for (const s of past ?? inks.shown) {
        const at = where(s.id);
        if (!at || !s.stroke.points.length) continue;
        const box = document.createElement('div');
        box.style.left = at.x + s.left + 'px';
        box.style.top = at.y + s.top + 'px';
        box.innerHTML = ink.svg([s.stroke], 1, 1, { halo: s.halo });
        layer.append(box);
      }
      document.body.append(layer);
    },
  };`;
// (file: in @rrweb/replay's dist; url: one of ours)
export type Own = { type: string; file?: string; url?: URL; text?: string };
export const OWN: Record<string, Own> = {
  '/': { type: 'text/html; charset=utf-8', text: PAGE },
  '/mirror.js': { type: 'text/javascript', text: MIRROR },
  '/replay.js': { type: 'text/javascript', file: 'replay.js' },
  '/replay.css': { type: 'text/css', file: 'style.css' },
  '/strokes.js': { type: 'text/javascript', url: new URL('strokes.js', import.meta.url) },
  '/media.js': { type: 'text/javascript', url: new URL('media.js', import.meta.url) },
  '/toplayer.js': { type: 'text/javascript', url: new URL('toplayer.js', import.meta.url) },
  '/rebuilt.js': { type: 'text/javascript', url: new URL('rebuilt.js', import.meta.url) },
  '/ink.js': { type: 'text/javascript', url: new URL('../review/ink.js', import.meta.url) },
  // (ink.js's live line and the stroke's shapes, which it imports)
  '/inklive.js': { type: 'text/javascript', url: new URL('../review/inklive.js', import.meta.url) },
  '/inkshape.js': { type: 'text/javascript', url: new URL('../review/inkshape.js', import.meta.url) },
};

// What a mirror's tab gets for what it asks: a picture its recording carried by that address, the replay's own file,
// or, for any other address, the owner's answer to a GET. Anything else is refused (null). replay: @rrweb/replay's
// dist.
export function answered(
  asked: Asked,
  mirror: { replay: URL; answer: Answering; pages: Set<string>; pictures: Map<string, NonNullable<Answer>> },
): Promise<Answer> {
  const url = new URL(asked.url),
    get = asked.method === 'GET';
  if (get && mirror.pictures.has(asked.url)) return Promise.resolve(mirror.pictures.get(asked.url) ?? null);
  if (url.origin !== ORIGIN) return get ? mirror.answer(asked, mirror.pages) : Promise.resolve(null);
  const own = OWN[url.pathname];
  const body = (own: Own) =>
    own.file
      ? readFileSync(new URL(own.file, mirror.replay))
      : own.url
        ? readFileSync(own.url)
        : Buffer.from(own.text!);
  return Promise.resolve(own ? { type: own.type, body: body(own) } : null);
}

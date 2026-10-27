// The watch-along mirror's own page (mirror.ts): the replay its tabs open, and the files it asks for of its own.

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
  #ring { position: absolute; z-index: 10; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%;
    border: 4px solid #ff2d55; box-shadow: 0 0 0 3px #fff; box-sizing: border-box; pointer-events: none; }
</style>
<script type="module" src="/mirror.js"></script>`;
const MIRROR = `window.process = { env: {} }; // (replay.js reads process.env in its error paths)
  const { Replayer } = await import('/replay.js');
  // the pen's ink (strokes.js), drawn over the screen with ink.js as SVG, so a picture at any scale is sharp
  const { Inks, inkAt, placer } = await import('/strokes.js');
  const ink = await import('/ink.js');
  let inks = new Inks(), past = null, sized = null;
  // (useVirtualDom off: live, every event is older than the baseline, so rrweb plays each as a fast-forward, into its
  // virtual DOM, which only a fast-forward's end copies onto the screen: the live mirror showed the page as the share
  // found it, whatever changed after.)
  const OPTIONS = { root: document.body, mouseTail: false, triggerFocus: false, showWarning: false, showDebug: false,
    UNSAFE_replayCanvas: true, skipInactive: false, speed: 1, useVirtualDom: false };
  let replayer = null;
  const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  window.mirror = {
    async live(events) {
      replayer = new Replayer([], { ...OPTIONS, liveMode: true });
      replayer.startLive(8.64e15);
      inks = new Inks();
      return this.add(events);
    },
    async add(events) {
      for (const event of events) {
        replayer.addEvent(event);
        inks.add(event);
      }
      await frames();
    },
    async at(events, time) {
      if (!events.length) return;
      past = inkAt(events, time);
      replayer = new Replayer(events, OPTIONS);
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
      // (what was coming in or going shown as it ends: rrweb holds the page's CSS animations where they start, so an
      // overlay that fades in, HQ's intercom say, stayed invisible. One that never ends stays.)
      for (const motion of iframe.contentDocument.getAnimations())
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
      await Promise.all([...iframe.contentDocument.images].filter(shown).map(image => image.decode().catch(() => {})));
      await frames();
      return { width, height };
    },
    unring() { document.getElementById('ring')?.remove(); },
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
  '/ink.js': { type: 'text/javascript', url: new URL('../review/ink.js', import.meta.url) },
};

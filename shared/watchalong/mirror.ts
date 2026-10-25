// The watch-along's mirror: a live session replayed as it comes in, in a headless Chromium tab running rrweb's
// replayer, so an agent can have a picture of the screen now (about 0.2 s) or of any moment past (a second tab,
// replayed to that time). README.md has the design.
//   - One Chromium for every mirror, started with the first and closed with the last; a tab per live session. A
//     mirror closes when its session ends (close), or after IDLE_MS with nothing recorded and nothing asked.
//   - The replay never reaches outside: its own files come from here, and everything the recorded page asks for goes
//     to the owner's answer with the origins of the recording's pages that the owner lets it show (the coordinator's:
//     HQ's own pictures and stylesheets from disk, and a preview's pictures, fonts and stylesheets when the recording
//     was there and the session may show it), or is refused.
//   - Pictures are JPEG (PNG when asked), LONG px on their long side, a tap ringed where it was, the pen's ink drawn.
import { readFileSync } from 'node:fs';
import { launch, type Answer, type Asked, type Browser, type Tab } from '../chromium/chromium.ts';
import type { RecordedEvent } from './store.ts';

export const IDLE_MS = 10 * 60_000;
// The replay's own files, on an origin that never resolves
const ORIGIN = 'https://mirror.invalid';
const QUALITY = 80;
// The longest a replay waits for what the recorded page asks for (its pictures) before the picture is taken
export const LOADING_MS = 1_000; // (exported: the owner's answer takes no longer.)

// A tap to ring, a part of the screen (fractions of it, 0 to 1) to zoom into, and the long side in px
export type Shot = { long: number; ring?: { x: number; y: number }; region?: Region; png?: boolean };
export type Region = { x: number; y: number; width: number; height: number };
// (bytes: JPEG, or PNG when the shot asked for png)
export type Picture = { bytes: Buffer; width: number; height: number };

// pages: the origins of the pages its recording was on, frames' too, that shows lets it show: the owner's word, as the
// recording is its page's
type Mirror = {
  tab: Tab;
  loading: Set<string>;
  pages: Set<string>;
  shows: Shows;
  used: number;
  turn: Promise<unknown>;
  size: string;
};
type Answering = (asked: Asked, pages: Set<string>) => Promise<Answer>;
export type Shows = (origin: string) => boolean;

export class Mirrors {
  // (each as it opens: what comes meanwhile waits for it)
  private mirrors = new Map<number, Promise<Mirror>>();
  private browser: Promise<Browser> | null = null;
  private sweeper: NodeJS.Timeout | null = null;
  private tabs = 0; // open or opening, the past moments' too: Chromium closes when none is left

  // replay: @rrweb/replay's dist folder, in the app's own dependencies. answer: what a replay's page gets for each
  // request of the recorded page's, told the origins of the recording's pages it may show (null: refused)
  private replay: URL;
  private answer: Answering;
  constructor(replay: URL, answer: Answering) {
    this.replay = replay;
    this.answer = answer;
  }

  has = (id: number) => this.mirrors.has(id);

  // A live session's mirror, opened with what's recorded so far, and the other origins it may show
  open(id: number, events: RecordedEvent[], shows: Shows) {
    const opening =
      this.mirrors.get(id) ??
      this.opened(shows).then(async mirror => {
        addPages(mirror, events);
        await this.inTurn(mirror, () => evaluate(mirror.tab, `mirror.live(${JSON.stringify(events)})`));
        return mirror;
      });
    if (!this.mirrors.has(id)) {
      this.mirrors.set(id, opening);
      opening.catch(() => this.mirrors.get(id) === opening && this.mirrors.delete(id));
    }
    this.sweeper ??= setInterval(() => this.sweep(), 60_000).unref();
    return opening.then(() => undefined);
  }

  // Events as they come in, for a session that has a mirror
  feed(id: number, events: RecordedEvent[]) {
    void this.mirrors
      .get(id)
      ?.then(mirror => {
        mirror.used = Date.now();
        addPages(mirror, events);
        return this.inTurn(mirror, () => evaluate(mirror.tab, `mirror.add(${JSON.stringify(events)})`));
      })
      .catch(() => undefined);
  }

  // The screen now
  async now(id: number, shot: Shot) {
    const mirror = await this.mirrors.get(id);
    if (!mirror) return undefined;
    mirror.used = Date.now();
    return this.inTurn(mirror, () => picture(mirror, shot));
  }

  // The screen at a time on the page's clock, from the events up to it, in a tab of its own
  async at(events: RecordedEvent[], time: number, shot: Shot, shows: Shows) {
    const mirror = await this.opened(shows);
    try {
      addPages(mirror, events);
      await evaluate(mirror.tab, `mirror.at(${JSON.stringify(upTo(events, time))}, ${time})`);
      return await picture(mirror, shot);
    } finally {
      await this.closeTab(mirror);
    }
  }

  async close(id: number) {
    const opening = this.mirrors.get(id);
    if (!opening) return;
    this.mirrors.delete(id);
    const mirror = await opening.catch(() => undefined);
    if (mirror) await this.closeTab(mirror);
  }

  // Every mirror, and Chromium (the server stops)
  async closeAll() {
    await Promise.all([...this.mirrors.keys()].map(id => this.close(id)));
  }

  // The browser's process, for measuring its memory
  pid = async () => (await this.browser)?.pid;

  private sweep() {
    for (const [id, opening] of this.mirrors)
      void opening
        .then(async mirror => {
          if (Date.now() - mirror.used > IDLE_MS) await this.close(id);
        })
        .catch(() => undefined);
  }

  // A tab of the replay, ready (Chromium started for the first)
  private async opened(shows: Shows): Promise<Mirror> {
    const launching = (this.browser ??= launch().then(browser => {
      // (stopped on its own: every mirror goes with it, and the next opens a new one)
      void browser.closed.then(() => {
        if (this.browser !== launching) return;
        this.browser = null;
        this.mirrors.clear();
        this.tabs = 0;
      });
      return browser;
    }));
    this.tabs++;
    let tab: Tab | undefined;
    try {
      const loading = new Set<string>(),
        pages = new Set<string>();
      let asked = 0;
      tab = await (
        await launching
      ).tab(async request => {
        const id = ++asked;
        loading.add(`${id}`);
        try {
          return await this.served(request, pages);
        } finally {
          loading.delete(`${id}`);
        }
      });
      await tab.send('Runtime.enable');
      await tab.send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const navigated = await tab.send('Page.navigate', { url: `${ORIGIN}/` });
      if (navigated.errorText) throw new Error(`The mirror's page didn't open: ${navigated.errorText}`);
      await evaluate(tab, READY);
      return { tab, loading, pages, shows, used: Date.now(), turn: Promise.resolve(), size: '' };
    } catch (err) {
      await tab?.close().catch(() => undefined);
      this.tabs--;
      throw err;
    }
  }

  private async closeTab(mirror: Mirror) {
    await mirror.tab.close();
    if (--this.tabs || !this.browser) return;
    const browser = this.browser;
    this.browser = null;
    clearInterval(this.sweeper ?? undefined);
    this.sweeper = null;
    await (await browser).close();
  }

  private served(asked: Asked, pages: Set<string>): Promise<Answer> {
    const url = new URL(asked.url);
    if (url.origin !== ORIGIN) return asked.method === 'GET' ? this.answer(asked, pages) : Promise.resolve(null);
    const own = OWN[url.pathname];
    const body = (own: Own) =>
      own.file
        ? readFileSync(new URL(own.file, this.replay))
        : own.url
          ? readFileSync(own.url)
          : Buffer.from(own.text!);
    return Promise.resolve(own ? { type: own.type, body: body(own) } : null);
  }

  private inTurn<T>(mirror: Mirror, step: () => Promise<T>): Promise<T> {
    const turn = mirror.turn.then(step, step);
    mirror.turn = turn.catch(() => undefined);
    return turn;
  }
}

// The events a replay to this time needs: from the full snapshot last taken by then (and the page's size before it)
export function upTo(events: RecordedEvent[], time: number) {
  const before = events.filter(event => event.timestamp <= time);
  const full = before.findLastIndex(event => event.type === FULL_SNAPSHOT);
  const meta = before.findLastIndex((event, i) => event.type === META && i <= full);
  return before.slice(Math.max(0, meta));
}
const FULL_SNAPSHOT = 2,
  META = 4;

// The origins of the pages these events were on that the mirror may show: the recorded page's addresses, and the page
// moments its frames sent up
function addPages(mirror: Mirror, events: RecordedEvent[]) {
  for (const event of events) {
    const data = event.data as { href?: unknown; tag?: unknown; payload?: { address?: unknown } };
    const address =
      event.type === META ? data.href : event.type === CUSTOM && data.tag === 'page' && data.payload?.address;
    if (typeof address !== 'string' || !URL.canParse(address)) continue;
    const { origin } = new URL(address);
    if (mirror.shows(origin)) mirror.pages.add(origin);
  }
}
const CUSTOM = 5;

// The replay as it is now: what it asked for loaded (or LOADING_MS gone), drawn, then taken, its tap ringed
async function picture(mirror: Mirror, shot: Shot): Promise<Picture | undefined> {
  const { tab } = mirror;
  const screen = await evaluate(tab, `mirror.drawn(${JSON.stringify(shot.ring ?? null)})`);
  if (!screen) return undefined;
  // (the page as big as the screen it replays, so all of it is drawn)
  if (mirror.size !== `${screen.width}x${screen.height}`) {
    mirror.size = `${screen.width}x${screen.height}`;
    await tab.send('Emulation.setDeviceMetricsOverride', { ...screen, deviceScaleFactor: 1, mobile: false });
    await evaluate(tab, 'mirror.drawn(null)');
  }
  const until = Date.now() + LOADING_MS;
  while (mirror.loading.size && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  const region = shot.region ?? { x: 0, y: 0, width: 1, height: 1 };
  const clip = {
    x: region.x * screen.width,
    y: region.y * screen.height,
    width: Math.max(1, region.width * screen.width),
    height: Math.max(1, region.height * screen.height),
  };
  const scale = shot.long / Math.max(clip.width, clip.height);
  const taken = await tab.send('Page.captureScreenshot', {
    ...(shot.png ? { format: 'png' } : { format: 'jpeg', quality: QUALITY }),
    clip: { ...clip, scale },
    captureBeyondViewport: false,
  });
  await evaluate(tab, 'mirror.unring()');
  return {
    bytes: Buffer.from(taken.data, 'base64'),
    width: Math.round(clip.width * scale),
    height: Math.round(clip.height * scale),
  };
}

async function evaluate(tab: Tab, expression: string) {
  const answer = await tab.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (answer.exceptionDetails)
    throw new Error(
      `The mirror's page failed: ${answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text}`,
    );
  return answer.result?.value;
}
const READY = `new Promise(resolve => { const check = () => (window.mirror ? resolve(true) : setTimeout(check, 20)); check(); })`;

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
  let inks = new Inks(), past = null;
  const OPTIONS = { root: document.body, mouseTail: false, triggerFocus: false, showWarning: false, showDebug: false,
    UNSAFE_replayCanvas: true, skipInactive: false, speed: 1 };
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
      await frames();
    },
    // The screen's size once drawn (none before a full snapshot), the page made as big, and a tap ringed
    async drawn(ring) {
      await frames();
      const iframe = replayer && replayer.iframe;
      const width = iframe && Number(iframe.width), height = iframe && Number(iframe.height);
      if (!width || !height || !iframe.contentDocument || !iframe.contentDocument.documentElement) return null;
      this.ink();
      if (ring) {
        const mark = document.createElement('div');
        mark.id = 'ring';
        mark.style.left = ring.x + 'px';
        mark.style.top = ring.y + 'px';
        document.body.append(mark);
      }
      await Promise.all([...iframe.contentDocument.images].map(image => image.decode().catch(() => {})));
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
type Own = { type: string; file?: string; url?: URL; text?: string };
const OWN: Record<string, Own> = {
  '/': { type: 'text/html; charset=utf-8', text: PAGE },
  '/mirror.js': { type: 'text/javascript', text: MIRROR },
  '/replay.js': { type: 'text/javascript', file: 'replay.js' },
  '/replay.css': { type: 'text/css', file: 'style.css' },
  '/strokes.js': { type: 'text/javascript', url: new URL('strokes.js', import.meta.url) },
  '/ink.js': { type: 'text/javascript', url: new URL('../review/ink.js', import.meta.url) },
};

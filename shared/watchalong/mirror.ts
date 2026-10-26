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
//   - Every step has STEP_MS: one that fails or runs past it closes its mirror, which opens again from the recording
//     when next asked for, and until then the session isn't seen (seen), so its page can say so.
import { readFileSync } from 'node:fs';
import { launch, type Answer, type Asked, type Browser, type Tab } from '../chromium/chromium.ts';
import type { RecordedEvent } from './store.ts';
import { OWN, type Own } from './mirrorpage.ts';

export const IDLE_MS = 10 * 60_000;
// The replay's own files, on an origin that never resolves
const ORIGIN = 'https://mirror.invalid';
const QUALITY = 80;
// The longest a replay waits for what the recorded page asks for (its pictures) before the picture is taken
export const LOADING_MS = 1_000; // (exported: the owner's answer takes no longer.)
// The longest a step may take: opening a mirror with the recording so far, taking in a batch, a picture, a past moment.
// A hard limit, as a step that never ends held every later picture of its session behind it, silently, until the
// server restarted; 15 s as the voice line waits that long for any answer of the coordinator's (platform/voice/
// server.py's hq()), so a later one reaches nobody. A mirror opens from what the replay still shows (shown), so opening
// again late in a long share fits too: from the whole recording, HQ's canvas frames (0.5 a second, 40 KB each) took
// past 15 s from 30 minutes, its first picture waiting on 900 frames' pictures
export const STEP_MS = 15_000;

// A tap to ring, a part of the screen (fractions of it, 0 to 1) to zoom into, and the long side in px
export type Shot = { long: number; ring?: { x: number; y: number }; region?: Region; png?: boolean };
export type Region = { x: number; y: number; width: number; height: number };
// (bytes: JPEG, or PNG when the shot asked for png)
export type Picture = { bytes: Buffer; width: number; height: number };

// pages: the origins of the pages its recording was on, frames' too, that shows lets it show: the owner's word, as the
// recording is its page's
type Mirror = {
  tab: Tab;
  browser: Promise<Browser>; // (the Chromium it's in)
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
  // whether a live session's screen reaches its mirror: true once its replay took the recording in, false once a step
  // failed
  private reached = new Map<number, boolean>();

  // replay: @rrweb/replay's dist folder, in the app's own dependencies. answer: what a replay's page gets for each
  // request of the recorded page's, told the origins of the recording's pages it may show (null: refused)
  private replay: URL;
  private answer: Answering;
  constructor(replay: URL, answer: Answering) {
    this.replay = replay;
    this.answer = answer;
  }

  has = (id: number) => this.mirrors.has(id);
  // Whether the session's screen reaches its mirror, so an agent sees it: undefined while it opens or has none
  seen = (id: number) => this.reached.get(id);
  // Once the session's mirror has opened or failed to (within STEP_MS), so seen says which
  settled = async (id: number) => void (await this.mirrors.get(id)?.catch(() => undefined));

  // A live session's mirror, opened with what's recorded so far, and the other origins it may show
  open(id: number, events: RecordedEvent[], shows: Shows) {
    const had = this.mirrors.get(id);
    if (had) return had.then(() => undefined);
    const tab = this.opened(shows);
    const opening = timed(
      tab.then(async mirror => {
        addPages(mirror, events);
        await evaluate(mirror.tab, `mirror.live(${JSON.stringify(shown(events))})`);
        return mirror;
      }),
      'opening',
    );
    this.mirrors.set(id, opening);
    this.reached.delete(id);
    opening.then(
      () => this.mirrors.get(id) === opening && this.reached.set(id, true),
      async err => {
        this.failed(id, opening, err);
        // (its tab is this one's to close, the mirror closed meanwhile or not: close() had none from opening)
        const mirror = await tab.catch(() => undefined);
        if (mirror) await this.closeTab(mirror).catch(() => undefined);
      },
    );
    this.sweeper ??= setInterval(() => this.sweep(), 60_000).unref();
    return opening.then(() => undefined);
  }

  // Events as they come in, for a session that has a mirror
  feed(id: number, events: RecordedEvent[]) {
    const opening = this.mirrors.get(id);
    void opening
      ?.then(mirror => {
        mirror.used = Date.now();
        addPages(mirror, events);
        return this.inTurn(id, opening, mirror, () => evaluate(mirror.tab, `mirror.add(${JSON.stringify(events)})`));
      })
      .then(() => this.mirrors.get(id) === opening && this.reached.set(id, true))
      .catch(() => undefined);
  }

  // The screen now
  async now(id: number, shot: Shot) {
    const opening = this.mirrors.get(id);
    const mirror = await opening;
    if (!opening || !mirror) return undefined;
    mirror.used = Date.now();
    return this.inTurn(id, opening, mirror, () => picture(mirror, shot));
  }

  // The screen at a time on the page's clock, from the events up to it, in a tab of its own
  async at(events: RecordedEvent[], time: number, shot: Shot, shows: Shows) {
    const tab = this.opened(shows);
    try {
      return await timed(
        tab.then(async mirror => {
          addPages(mirror, events);
          await evaluate(mirror.tab, `mirror.at(${JSON.stringify(upTo(events, time))}, ${time})`);
          return picture(mirror, shot);
        }),
        'past moment',
      );
    } finally {
      // (once open: a tab that opens after its time ran out closes too)
      await tab.then(mirror => this.closeTab(mirror)).catch(() => undefined);
    }
  }

  async close(id: number) {
    this.reached.delete(id);
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

  // A tab of the replay, ready within STEP_MS (Chromium started for the first), or closed: one made after its time ran
  // out too
  private async opened(shows: Shows): Promise<Mirror> {
    const launching = (this.browser ??= launch().then(browser => {
      // (stopped on its own: every mirror goes with it, and the next opens a new one)
      void browser.closed.then(() => {
        if (this.browser !== launching) return;
        this.browser = null;
        for (const id of this.mirrors.keys()) this.reached.set(id, false);
        this.mirrors.clear();
        this.tabs = 0;
      });
      return browser;
    }));
    this.tabs++;
    const loading = new Set<string>(),
      pages = new Set<string>();
    let asked = 0;
    const made = launching.then(browser =>
      browser.tab(async request => {
        const id = ++asked;
        loading.add(`${id}`);
        try {
          return await this.served(request, pages);
        } finally {
          loading.delete(`${id}`);
        }
      }),
    );
    try {
      const tab = await timed(made.then(paged), 'page');
      return { tab, browser: launching, loading, pages, shows, used: Date.now(), turn: Promise.resolve(), size: '' };
    } catch (err) {
      void made.then(tab => tab.close()).catch(() => undefined);
      await this.release(launching).catch(() => undefined);
      throw err;
    }
  }

  private async closeTab(mirror: Mirror) {
    await mirror.tab.close();
    await this.release(mirror.browser);
  }

  // A tab fewer: Chromium closes with the last (a tab of one that stopped went with it, and was counted out then)
  private async release(browser: Promise<Browser>) {
    if (browser !== this.browser || --this.tabs) return;
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

  // A live mirror's steps, one at a time, each within STEP_MS
  private inTurn<T>(id: number, opening: Promise<Mirror>, mirror: Mirror, step: () => Promise<T>): Promise<T> {
    const run = () => timed(step(), 'step');
    const turn = mirror.turn.then(run, run);
    mirror.turn = turn.catch(() => undefined);
    turn.catch(async err => {
      if (this.failed(id, opening, err)) await this.closeTab(mirror).catch(() => undefined);
    });
    return turn;
  }

  // A live mirror whose step failed or ran out of time: not seen, and gone, so it holds nothing up and opens again from
  // the recording when next asked for; its tab is closed by the caller. False when it was closed meanwhile (close()
  // closed an open one's tab)
  private failed(id: number, opening: Promise<Mirror>, err: unknown) {
    if (this.mirrors.get(id) !== opening) return false;
    this.mirrors.delete(id);
    this.reached.set(id, false);
    console.error(`Watch-along #${id}: its mirror failed, and closed:`, err);
    return true;
  }
}

// A step, or its failure once it runs past STEP_MS
function timed<T>(step: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the mirror's ${what} took over ${STEP_MS / 1000} s`)), STEP_MS);
  });
  return Promise.race([step, late]).finally(() => clearTimeout(timer));
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

// The events a live mirror opens with: what the screen still shows, from the full snapshot last taken (upTo), each
// canvas's pictures but its latest. A picture that starts by wiping its whole canvas (canvas.js's, at the canvas's own
// size) leaves nothing of the ones before it, and each costs the replay a picture to decode.
export function shown(events: RecordedEvent[]) {
  const since = upTo(events, Infinity);
  const latest = new Map<number, number>();
  since.forEach((event, i) => {
    const wiped = wipes(event);
    if (wiped !== undefined) latest.set(wiped, i);
  });
  return since.filter((event, i) => {
    const wiped = wipes(event);
    return wiped === undefined || latest.get(wiped) === i;
  });
}
const INCREMENTAL = 3,
  CANVAS_MUTATION = 9;
// The canvas a canvas mutation wipes before it draws (its first command a clearRect from the corner), or undefined
function wipes(event: RecordedEvent) {
  const data = event.data as { source?: number; id?: number; commands?: { property?: string; args?: unknown[] }[] };
  if (event.type !== INCREMENTAL || data.source !== CANVAS_MUTATION || typeof data.id !== 'number') return undefined;
  const [wipe] = data.commands ?? [];
  const [x, y, width, height] = wipe?.args ?? [];
  const whole = wipe?.property === 'clearRect' && x === 0 && y === 0 && Number(width) > 0 && Number(height) > 0;
  return whole ? data.id : undefined;
}

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

// A new tab with the replay's page open in it, ready
async function paged(tab: Tab) {
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
  return tab;
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

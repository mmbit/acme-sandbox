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
//   - Every step has STEP_MS: one that fails or runs past it closes its own tab. A live session's mirror then opens
//     again from the recording when next asked for, and isn't seen until then (seen), so its page can say so. Chromium
//     closes too only when it doesn't answer within ANSWER_MS once a step ran past its time (outOfTime), and the next
//     mirror opens in a fresh one.
import { readFileSync } from 'node:fs';
import { launch, type Answer, type Asked, type Browser, type Tab } from '../chromium/chromium.ts';
import type { RecordedEvent } from './store.ts';
import { OWN, type Own } from './mirrorpage.ts';
import { shown, upTo } from './shown.ts';

export const IDLE_MS = 10 * 60_000;
// The replay's own files, on an origin that never resolves
const ORIGIN = 'https://mirror.invalid';
const QUALITY = 80;
// The longest a replay waits for what the recorded page asks for (its pictures) before the picture is taken
export const LOADING_MS = 1_000; // (exported: the owner's answer takes no longer.)
// The longest a step may take: opening a mirror with the recording so far, taking in a batch, a picture, a past moment.
// A hard limit, as a step that never ends held every later picture of its session behind it, silently, until the
// server restarted; 15 s as the voice line waits that long for any answer of the coordinator's (platform/voice/
// server.py's hq()), so a later one reaches nobody. A mirror opens with what the screen still shows (shown): the whole
// recording of a 30-minute share, with HQ's canvas frames (0.5 a second, 40 KB each), takes past 15 s to open.
export const STEP_MS = 15_000;
// How long Chromium's own process may take to answer once a step ran past its time. It answers apart from its tabs'
// pages: under a millisecond with a page that never yields, on the worker at a load of 13. One silent for 5 s has
// stopped answering, and every later tab of it would hang.
export const ANSWER_MS = 5_000;

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
  private launches = new WeakMap<Promise<Browser>, AbortController>(); // (each Chromium's, to kill it while it starts)
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
    const browser = this.launched();
    const tab = this.opened(browser, shows);
    const opening = timed(
      tab.then(async mirror => {
        addPages(mirror, events);
        await evaluate(mirror.tab, `mirror.live(${JSON.stringify(shown(events))})`);
        return mirror;
      }),
      'opening',
      () => this.outOfTime(browser),
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
    const browser = this.launched();
    const tab = this.opened(browser, shows);
    try {
      return await timed(
        tab.then(async mirror => {
          addPages(mirror, events);
          await evaluate(mirror.tab, `mirror.at(${JSON.stringify(upTo(events, time))}, ${time})`);
          return picture(mirror, shot);
        }),
        'past moment',
        () => this.outOfTime(browser),
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

  // The Chromium for a new tab, started for the first.
  private launched() {
    if (this.browser) return this.browser;
    const abort = new AbortController();
    const launching: Promise<Browser> = launch(abort.signal).then(browser => {
      // (stopped on its own: every mirror goes with it, and the next opens a new one)
      void browser.closed.then(() => this.dropped(launching));
      return browser;
    });
    this.launches.set(launching, abort);
    return (this.browser = launching);
  }

  // A tab of the replay in this Chromium, ready within STEP_MS, or closed: one made after its time ran out too
  private async opened(launching: Promise<Browser>, shows: Shows): Promise<Mirror> {
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
      const tab = await timed(made.then(paged), 'page', () => this.outOfTime(launching));
      return { tab, browser: launching, loading, pages, shows, used: Date.now(), turn: Promise.resolve(), size: '' };
    } catch (err) {
      void made.then(tab => tab.close()).catch(() => undefined);
      await this.release(launching).catch(() => undefined);
      throw err;
    }
  }

  // A step past STEP_MS in this Chromium. Its own tab closes (its caller closes it), and a slow page leaves the other
  // mirrors alone. A Chromium that doesn't answer goes, as every later tab of it would hang. Every mirror goes with it,
  // and the next opens in a fresh one. One still starting is killed. A Chromium that went already, or that another
  // step's check closes, is left as it is.
  private async outOfTime(browser: Promise<Browser>) {
    // (read at once, before the step's caller closes its tab: closing the last tab lets this Chromium go)
    if (this.browser !== browser || (await answers(browser))) return;
    const launch = this.launches.get(browser);
    if (!launch) return;
    this.launches.delete(browser);
    this.dropped(browser);
    console.error(
      `Watch-along mirrors: a step ran past ${STEP_MS / 1000} s and their Chromium doesn't answer: it closes`,
    );
    launch.abort();
    void browser.then(chromium => chromium.close()).catch(() => undefined);
  }

  // Chromium stopped, or is to: every mirror goes with it, not seen until it opens again in a new one. False when it
  // went already
  private dropped(browser: Promise<Browser>) {
    if (this.browser !== browser) return false;
    this.browser = null;
    for (const id of this.mirrors.keys()) this.reached.set(id, false);
    this.mirrors.clear();
    this.tabs = 0;
    return true;
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
    const run = () => timed(step(), 'step', () => this.outOfTime(mirror.browser));
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

// A step, or its failure once it runs past STEP_MS (and then outOfTime())
function timed<T>(step: Promise<T>, what: string, outOfTime: () => Promise<void>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`the mirror's ${what} took over ${STEP_MS / 1000} s`));
      void outOfTime();
    }, STEP_MS);
  });
  return Promise.race([step, late]).finally(() => clearTimeout(timer));
}

// Whether Chromium, started by then, answers within ANSWER_MS
async function answers(browser: Promise<Browser>) {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>(resolve => (timer = setTimeout(() => resolve(false), ANSWER_MS)));
  const answered = browser
    .then(chromium => chromium.answered())
    .then(
      () => true,
      () => false,
    );
  return Promise.race([answered, late]).finally(() => clearTimeout(timer));
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
const META = 4,
  CUSTOM = 5;

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

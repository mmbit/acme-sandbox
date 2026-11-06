// Watch-alongs on calls: a page in a live call records itself for the call's agent and to watch back
// (shared/watchalong).
//   - HQ starts one with the call's own key (pictures.ts callKey): the board's typing is kept, except passwords.
//   - The page posts its batches with the session's key alone, from HQ's origin (server.ts): the board's session
//     isn't needed, so a guest's page on a join link can post the same way once it can start one.
//   - A session ends with its call (call.ts handOver, or ledger.ts sweep for a line lost without one) and goes with it
//     when the call leaves nothing behind.
//   - What the call's agent sees: each live session is folded into moments as it comes and mirrored in
//     headless Chromium (shared/watchalong mirror.ts), and the voice line asks for both with each of the caller's turns
//     (screenTurn) and for its agent's screen tool (screen), by the session's purpose and the thing it belongs to.
//   - A guest's walk-through on a join link (callline.ts startWatching) keeps only that they typed, and ends or goes
//     with its call out (callouts.ts end).
//   - A guest in the room with the board, on a device of their own (callguests.ts), records their room for the call's
//     agent while the call is live (startOnGuest): the call's page and the prototypes they open there, only that they
//     typed. The agent sees each screen with whose it is (screenTurn, screen's who), and nothing of a guest's is kept
//     once the call ends.
//   - Each of the board's other HQ screens (its iPad beside the desktop that holds the call) records itself on the call
//     too while it's live (startOnScreen), as the board's screen 2, 3: what it opens and points at there. Nothing of
//     them is kept once the call ends either.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { db } from './db.ts';
import { DATA_DIR, KITS_DIR, ORIGIN } from './config.ts';
import { findFile, hqDir } from './files.ts';
import { timeZone } from './company.ts';
import * as store from '../../../shared/watchalong/store.ts';
import * as playback from '../../../shared/watchalong/playback.ts';
import { Moments, lines } from '../../../shared/watchalong/moments.ts';
import { LOADING_MS, Mirrors, type Shows } from '../../../shared/watchalong/mirror.ts';
import { WHEN_WORDS, when } from './watchtimes.ts';
import { regionOf } from './region.ts';
import { mirrored } from './previewfiles.ts';
import { webFonts } from './webfonts.ts';
import { readBody } from '../../../shared/routes/routes.ts';
import { opensCall } from './pictures.ts';
import { exclude } from './latency.ts';
import { refuse, reply } from './uploads.ts';

const kept = store.open(db, `${DATA_DIR}/watchalong`, (id, events, at) => heard(id, events, at));
// rrweb's recorder, which watchalong.js imports from beside itself (server.ts, feedback.ts serve it)
export const RECORDER = new URL('../node_modules/@rrweb/record/dist/record.js', import.meta.url);
// and its replayer's folder (dist/), which the mirror and HQ's player replay with.
export const REPLAY = new URL('../node_modules/@rrweb/replay/dist/', import.meta.url);
const CALL = 'call',
  CALLOUT = 'callout',
  GUEST = 'callguest',
  SCREEN = 'callscreen';

// POST /api/watchalong/start { call, key }: a watch-along for the board's live call, and where its page posts
export function startOnCall(call: number, key: string) {
  if (!opensCall(call, key)) return 409;
  return posting(store.start(kept, CALL, String(call), 'shown'));
}

// A guest's walk-through on a call out's join link (callline.ts checks the call is on), and where its page posts.
// previews: the origins of the preview hosts its share reaches
// One at a time: a new start (the guest's page loaded again) ends the earlier ones and their mirrors, so one link can't
// hold a mirror each for many
export function startOnCallout(callout: number, previews: string[]) {
  endCallout(callout);
  return posting(store.start(kept, CALLOUT, String(callout), 'hidden', previews));
}
// A call's guest's room on the live call (callguests.ts screenOf), and where it posts. guest: their room name; previews:
// the origin of the call's prototypes' host, which their room frames. One at a time, as a call out's: a new start (their
// room loaded again) ends their earlier one and its mirror.
export function startOnGuest(call: number, guest: string, previews: string[]) {
  endGuest(call, guest);
  return posting(store.start(kept, GUEST, guestRef(call, guest), 'hidden', previews));
}
// ...and ended, their Pause: the agent sees nothing more of it (live skips it).
export function endGuest(call: number, guest: string) {
  store.end(kept, GUEST, guestRef(call, guest));
  unwatchAll(GUEST, guestRef(call, guest));
}
const guestRef = (call: number | string, guest: string) => `${call}/${guest}`;
// A call's guests (their room name, and the name the call knows them by), as callguests.ts tells: guestsBy
export let guestsOf: (call: number) => { guest: string; name: string }[] = () => [];
export const guestsBy = (list: typeof guestsOf) => {
  guestsOf = list;
};
// POST /api/watchalong/screens/start { screen }: one of the board's HQ screens that isn't its live call's own (call: the
// board's call live now, call.ts liveNow), the call's agent, and where its page posts. screen: the page's own id, so a
// reload goes on as the same screen; one session at a time each, as a guest's. 404: no live call.
export function startOnScreen(call: { id: number; agent: string } | undefined, b: { screen?: unknown }) {
  if (!call) return 404;
  const screen = String(b.screen ?? '');
  if (!SCREEN_ID.test(screen)) return [400, 'screen is the page’s own id: 8 to 64 letters, digits, - or _'];
  const ref = screenRef(call.id, screen);
  store.end(kept, SCREEN, ref);
  return { call: call.id, agent: call.agent, ...posting(store.start(kept, SCREEN, ref, 'shown')) };
}
const SCREEN_ID = /^[\w-]{8,64}$/;
const screenRef = (call: number | string, screen: string) => `${call}/${screen}`;
// The board's other screens on a call, in the order they first showed it: screen 2 first
export const screensOf = (call: number | string) => store.refsOf(kept, SCREEN, `${call}/`);
const posting = (session: { id: number; key: string }) => ({
  id: session.id,
  events: `/api/watchalong/events?id=${session.id}&key=${session.key}`,
});

// POST /api/watchalong/events?id=<id>&key=<key>: one batch from the page. seen: whether the agent sees it, so a share
// reaching nobody says so, once a mirror opening for it opened or failed. A mirror that failed opens again with the
// batch, so the share comes back by itself, whether or not the agent asks to look meanwhile.
export async function addEvents(req: IncomingMessage, res: ServerResponse) {
  const query = new URL(req.url ?? '/', 'http://x').searchParams;
  const id = Number(query.get('id')),
    key = query.get('key') ?? '';
  const body = await readBody(req, store.BATCH_BYTES);
  if (!body) return refuse(req, res, 413, 'too large');
  const status = store.add(kept, id, key, body);
  if (status === 200) {
    posted.set(id, Date.now());
    const watch = mirrors.seen(id) === false ? watches.get(id) : undefined;
    if (watch) reopen(watch);
    await mirrors.settled(id); // (the page may send no other batch to be told by)
  }
  return reply(res, status, status === 200 ? { ok: true, seen: mirrors.seen(id) } : { error: ERRORS[status] });
}
const ERRORS: Record<number, string> = {
  400: 'not a batch of events',
  404: 'no such watch-along',
  409: 'the watch-along is over',
  413: 'the batch is too large',
  507: 'the watch-along is full',
};

// Recordings past their 90 days go at start and then every hour, whether or not another call records
const sweepOld = () => {
  try {
    store.sweep(kept);
  } catch (err) {
    console.error('Watch-along retention sweep:', err);
  }
};
export const startSweep = () => {
  sweepOld();
  return setInterval(sweepOld, 3_600_000).unref();
};

// The call ended, or left nothing behind (its mirror goes either way)
export function endCall(call: number) {
  store.end(kept, CALL, String(call));
  unwatchAll(CALL, String(call));
  forgetScreens(call);
}
export function forgetCall(call: number) {
  unwatchAll(CALL, String(call));
  store.forget(kept, CALL, String(call));
  forgetScreens(call);
}
// Its guests' screens and the board's other ones go either way: they were for the agent while the call was on, never to
// watch back.
const forgetScreens = (call: number) =>
  [
    ...guestsOf(call).map(({ guest }) => [GUEST, guestRef(call, guest)]),
    ...screensOf(call).map(ref => [SCREEN, ref]),
  ].forEach(([purpose, ref]) => {
    unwatchAll(purpose, ref);
    store.forget(kept, purpose, ref);
  });
// A call out's, the same
export function endCallout(callout: number) {
  store.end(kept, CALLOUT, String(callout));
  unwatchAll(CALLOUT, String(callout));
}
export function forgetCallout(callout: number) {
  unwatchAll(CALLOUT, String(callout));
  store.forget(kept, CALLOUT, String(callout));
}

// ---------------------------------------------------------------- what the call's agent sees
// Pictures: JPEG, TOOL_PX on the long side for the screen tool (watchturns.ts has a turn's)
export const TOOL_PX = 1568;
// A watched session: its moments, how far the page's clock runs behind the server's, how many events have changed what
// its screen shows (a turn's picture goes when that moved since the last one), and its last tap
type Watch = {
  id: number;
  moments: Moments;
  clockMs: number;
  version: number;
  tap?: { x: number; y: number; version: number };
};
const watches = new Map<number, Watch>();
// What the replay may load, never a page or a script: HQ's own pictures, fonts and stylesheets, found as HQ serves them
// (its files, a kit's HQ app's), and a preview's pictures, fonts and stylesheets when the recording was on that preview,
// its page or a frame's, and the session may show it (shows) (previewfiles.ts mirrored), and the fonts HQ's looks load
// from Google Fonts (webfonts.ts). Nothing from another host.
// (HQ's fonts: the Notebook's lettering)
const GUEST_ROOM = '/guest/notebooks';
const ASSETS = new Set(['.css', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.woff2']);
const webFont = webFonts();
export const mirrors = new Mirrors(REPLAY, async ({ url }, pages) => {
  const asked = new URL(url),
    { origin, pathname } = asked;
  // (fromGoogle)
  if (origin !== ORIGIN) return pages.has(origin) ? fromPreview(asked) : fromGoogle(asked);
  if (!ASSETS.has(extname(pathname).toLowerCase())) return null;
  // (a call guest's room has HQ's shell under its own address: notebookguestfiles.ts.
  const path = pathname.startsWith(`${GUEST_ROOM}/`) ? pathname.slice(GUEST_ROOM.length) : pathname;
  const kit = /^\/kits\/([a-z0-9][a-z0-9-]*)(\/.+)$/.exec(path);
  const found = kit ? findFile(`${KITS_DIR}/${kit[1]}/hq`, kit[2]) : findFile(hqDir(path), path);
  return found && { type: found.type, body: await readFile(found.real) };
});
// The previews a session's replay may show, decided here, as its recording is whatever its page posted: the board's
// call any, from any of its screens (its key opens each, and its viewer may open any on a call), a guest's walk-through
// only the ones its call out's share reached when it started (callline.ts walkOf)
const shows =
  (session: store.Session): Shows =>
  origin =>
    session.purpose === CALL || session.purpose === SCREEN || session.origins.includes(origin);
const fromPreview = (url: URL) =>
  mirrored(url, LOADING_MS).catch(err => {
    console.error(`Watch-along mirror: a file of ${url.host} didn't load:`, err);
    return null;
  });
const fromGoogle = (url: URL) =>
  webFont(url, LOADING_MS).catch(err => {
    console.error(`Watch-along mirror: a web font of ${url.host} didn't load:`, err);
    return null;
  });
// (a mouse or a finger moving changes nothing on screen)
const MOUSE_MOVE = 1,
  TOUCH_MOVE = 6;
const moves = (event: store.RecordedEvent) =>
  event.type === 3 && [MOUSE_MOVE, TOUCH_MOVE].includes((event.data as { source?: number }).source ?? -1);

// A batch kept: a live session's moments and mirror take it in (and a session first heard here, or since a restart,
// starts both from what's recorded so far)
function heard(id: number, events: store.RecordedEvent[], at: number) {
  const watch = watches.get(id);
  if (!watch) return void watchFrom(id);
  if (events.length) watch.clockMs = Math.min(watch.clockMs, at - events.at(-1)!.timestamp);
  taken(watch, events);
  mirrors.feed(id, events);
}
function watchFrom(id: number) {
  const recording = store.read(kept, id);
  if (!recording || recording.session.ended) return undefined;
  const watch: Watch = { id, moments: new Moments(), clockMs: recording.clockMs, version: 0 };
  watches.set(id, watch);
  taken(watch, recording.events);
  mirrorOf(recording);
  return watch;
}
const mirrorOf = ({ session, events }: store.Recording) =>
  mirrors
    .open(session.id, events, shows(session))
    .catch(err => console.error(`Watch-along #${session.id}: its mirror didn't open:`, err));
function taken(watch: Watch, events: store.RecordedEvent[]) {
  watch.moments.add(events);
  for (const event of events) {
    if (moves(event)) continue;
    watch.version++;
    const { tag, payload } = event.data as { tag?: string; payload?: { x?: number; y?: number } };
    if (event.type === 5 && tag === 'tap')
      watch.tap = { x: Number(payload?.x), y: Number(payload?.y), version: watch.version };
  }
}

// The live watch-along of this purpose and thing (its newest session not ended), watched; a session ended meanwhile
// lets its mirror go
function live(purpose: string, ref: string) {
  const sessions = store.sessionsOf(kept, purpose, ref);
  for (const session of sessions) if (session.ended && watches.has(session.id)) unwatch(session.id);
  const session = sessions.findLast(session => !session.ended);
  const watch = session && watches.get(session.id);
  if (!watch) return session && watchFrom(session.id);
  reopen(watch);
  return watch;
}
// A watched session's mirror, closed while idle or failed: it opens again from the recording, with what the screen
// still shows (mirror.ts)
function reopen(watch: Watch) {
  const recording = !mirrors.has(watch.id) && store.read(kept, watch.id);
  if (recording) mirrorOf(recording);
}
function unwatch(id: number) {
  watches.delete(id);
  posted.delete(id);
  void mirrors.close(id);
}
// A screen beside the board's call (another of the board's, a guest's) is on it while its page still posts: a page
// posts each second as it records, an empty batch when quiet or paused (sender.js), so one gone without a word (closed,
// asleep, or recording as the call's own screen since) leaves the agent's list and its mirror goes, and it comes back
// with its next post. QUIET_MS leaves room for a big batch on a slow line and a page in the background.
const posted = new Map<number, number>(),
  QUIET_MS = 20_000;
export function showing(purpose: string, ref: string) {
  const session = store.sessionsOf(kept, purpose, ref).findLast(session => !session.ended);
  if (!session) return undefined;
  if (Date.now() - (posted.get(session.id) ?? 0) < QUIET_MS) return live(purpose, ref);
  if (watches.has(session.id)) unwatch(session.id);
  return undefined;
}
const unwatchAll = (purpose: string, ref: string) =>
  store.sessionsOf(kept, purpose, ref).forEach(session => unwatch(session.id));

// The moments' times, on the company's clock (the page's time made the server's; clockMs 0: a time on the server's)
export const clockOf = (watch: Pick<Watch, 'clockMs'>) => {
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone(),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return (at: number) => format.format(at + watch.clockMs);
};
const settled = (watch: Watch) => watch.moments.settle(Date.now() - watch.clockMs);

// What the call's agent sees of it, with each turn and by its screen tool: watchturns.ts, from these.
export { CALL, CALLOUT, GUEST, SCREEN, guestRef, kept, live, settled, shows, type Watch };
export const NOTHING = 'Nothing of the screen was recorded by then.';

// ---------------------------------------------------------------- watching a call back
// A call's recording, every session of it in order (a call minimised again after a restore records anew), read on
// playback.ts's thread: its moments folded and settled, its times, the events a replay to a time needs (at) and every
// event (every), as HQ's player and hq call's moments and screen read them. undefined: nothing recorded. A request's
// waits on that thread hold nothing of HQ's (latency.ts exclude).
export async function callPlayback(call: number) {
  const sessions = store.sessionsOf(kept, CALL, String(call)).filter(session => session.bytes > 0);
  const recording = sessions.length ? await exclude(playback.played(kept.dir, sessions)) : undefined;
  if (!recording) return undefined;
  // (shows: what its sessions may show, for the mirror.)
  const shown = sessions.map(shows);
  return {
    ...recording,
    shows: (origin: string) => shown.some(may => may(origin)),
    at: (time: number) => exclude(playback.at(kept.dir, sessions, time)),
    every: () => exclude(playback.every(kept.dir, sessions)),
  };
}

// Whether a call has something recorded to watch back (the call log's "Watch it back")
export const recorded = (call: number) => store.sessionsOf(kept, CALL, String(call)).some(session => session.bytes > 0);

// Every mirror closed (a test's end).
export const closeMirrors = () => mirrors.closeAll();

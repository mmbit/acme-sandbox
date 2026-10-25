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
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { db } from './db.ts';
import { DATA_DIR, KITS_DIR, ORIGIN } from './config.ts';
import { findFile, hqDir } from './files.ts';
import { timeZone } from './company.ts';
import * as store from '../../../shared/watchalong/store.ts';
import { Moments, lines } from '../../../shared/watchalong/moments.ts';
import { LOADING_MS, Mirrors, type Region, type Shows } from '../../../shared/watchalong/mirror.ts';
import { mirrored } from './previewfiles.ts';
import { readBody } from '../../../shared/routes/routes.ts';
import { opensCall } from './pictures.ts';
import { refuse, reply } from './uploads.ts';

const kept = store.open(db, `${DATA_DIR}/watchalong`, (id, events, at) => heard(id, events, at));
// rrweb's recorder, which watchalong.js imports from beside itself (server.ts, feedback.ts serve it)
export const RECORDER = new URL('../node_modules/@rrweb/record/dist/record.js', import.meta.url);
// and its replayer's folder (dist/), which the mirror and HQ's player replay with.
export const REPLAY = new URL('../node_modules/@rrweb/replay/dist/', import.meta.url);
const CALL = 'call',
  CALLOUT = 'callout';

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
const posting = (session: { id: number; key: string }) => ({
  id: session.id,
  events: `/api/watchalong/events?id=${session.id}&key=${session.key}`,
});

// POST /api/watchalong/events?id=<id>&key=<key>: one batch from the page
export async function addEvents(req: IncomingMessage, res: ServerResponse) {
  const query = new URL(req.url ?? '/', 'http://x').searchParams;
  const id = Number(query.get('id')),
    key = query.get('key') ?? '';
  const body = await readBody(req, store.BATCH_BYTES);
  if (!body) return refuse(req, res, 413, 'too large');
  const status = store.add(kept, id, key, body);
  return reply(res, status, status === 200 ? { ok: true } : { error: ERRORS[status] });
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
}
export function forgetCall(call: number) {
  unwatchAll(CALL, String(call));
  store.forget(kept, CALL, String(call));
}
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
// A turn's lines: at most TURN_LINES. Pictures: JPEG, TURN_PX on the long side with a turn, TOOL_PX for the screen tool.
// The tool's moment list: at most LIST_LINES, the latest.
const TURN_LINES = 20,
  LIST_LINES = 60,
  TURN_PX = 1024;
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
// What the replay may load, never a page or a script: HQ's own pictures and stylesheets, found as HQ serves them (its
// files, a kit's HQ app's), and a preview's pictures, fonts and stylesheets when the recording was on that preview, its
// page or a frame's, and the session may show it (shows) (previewfiles.ts mirrored). Nothing from another host.
const ASSETS = new Set(['.css', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
export const mirrors = new Mirrors(REPLAY, async ({ url }, pages) => {
  const asked = new URL(url),
    { origin, pathname } = asked;
  if (origin !== ORIGIN) return pages.has(origin) ? fromPreview(asked) : null;
  if (!ASSETS.has(extname(pathname).toLowerCase())) return null;
  const kit = /^\/kits\/([a-z0-9][a-z0-9-]*)(\/.+)$/.exec(pathname);
  const found = kit ? findFile(`${KITS_DIR}/${kit[1]}/hq`, kit[2]) : findFile(hqDir(pathname), pathname);
  return found && { type: found.type, body: await readFile(found.real) };
});
// The previews a session's replay may show, decided here, as its recording is whatever its page posted: the board's
// call any (its key opens each, and its viewer may open any on a call), a guest's walk-through only the ones its call
// out's share reached when it started (callline.ts walkOf)
const shows =
  (session: store.Session): Shows =>
  origin =>
    session.purpose === CALL || session.origins.includes(origin);
const fromPreview = (url: URL) =>
  mirrored(url, LOADING_MS).catch(err => {
    console.error(`Watch-along mirror: a file of ${url.host} didn't load:`, err);
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
  // (its mirror closed while idle: it opens again with the whole recording)
  const recording = !mirrors.has(watch.id) && store.read(kept, watch.id);
  if (recording) mirrorOf(recording);
  return watch;
}
function unwatch(id: number) {
  watches.delete(id);
  void mirrors.close(id);
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

// The briefing's paragraph on a walk-through, for whoever shows the screen (who: 'the board', 'they'; their: 'its',
// 'their'): it comes with the caller's turn once the screen is shown, as the call's briefing was written before
export const briefing = (who: string, their: string) => {
  const Who = who.charAt(0).toUpperCase() + who.slice(1),
    whose = who === 'they' ? their : `${who}'s`;
  return `(You can now see ${whose} screen: a walk-through of our pages. With each of ${their} turns you get what was \
done since your last turn, one line each (pages opened, taps, scrolls, typing: how much and where, never what), and a \
picture of the screen as ${their} words ended when it changed, the last tap ringed. Your screen tool shows the screen \
now, a moment before, a part zoomed in, or the moments since a time. ${Who} may describe things loosely ("this one", \
"up here"): trust the screen, and ask about what's on it when it isn't clear. Talk about what you see as someone \
looking over ${their} shoulder would ("the blue button at the bottom"), and never read the lines, their numbers or \
times out. While the screen is paused you see nothing of it.)`;
};

// POST /api/voice/screen-turn { purpose, ref, after, seen, briefed, picture }: for a caller's turn, the moments since the agent's
// last (after: the last moment it had), and a picture of the screen now when it changed since the one it has (seen: that
// picture's version), the last tap since then ringed. While paused, the lines up to the pause and no picture. brief:
// what the agent is told of a walk-through, for a session that hasn't had it (briefed false). picture false: none (the
// call has had all it can hold).
export async function screenTurn(b: Record<string, unknown>, brief: string) {
  const watch = live(String(b.purpose ?? ''), String(b.ref ?? ''));
  if (!watch) return { on: false };
  settled(watch);
  const after = Number(b.after) || 0,
    seen = Number(b.seen) || 0;
  const moments = watch.moments.after(after);
  const paused = watch.moments.paused;
  const answer = {
    on: true,
    paused,
    lines: turnLines(moments, clockOf(watch)),
    last: watch.moments.list.at(-1)?.n ?? 0,
    version: watch.version,
    ...(b.briefed === true ? {} : { brief }),
  };
  if (paused || watch.version === seen || b.picture === false) return answer;
  const ring = watch.tap && watch.tap.version > seen ? watch.tap : undefined;
  const picture = await mirrors.now(watch.id, { long: TURN_PX, ring });
  return picture ? { ...answer, picture: { type: 'image/jpeg', data: picture.bytes.toString('base64') } } : answer;
}
// At most TURN_LINES: the latest, and how many earlier ones the screen tool lists
function turnLines(moments: Moments['list'], clock: (at: number) => string) {
  const all = lines(moments, clock);
  if (all.length <= TURN_LINES) return all;
  const left = all.length - TURN_LINES + 1;
  return [`(${left} earlier lines left out: the screen tool lists them)`, ...all.slice(-TURN_LINES + 1)];
}

// POST /api/voice/screen { purpose, ref, at?, region?, since? }: the screen tool. since: the moments since then
// ('-2m', '17:03', '#12'). Otherwise a picture, TOOL_PX on its long side: now, or at ('-20s', '17:03:12', '#12'; a
// moment's own tap ringed), all of it or region { x, y, width, height } in fractions of the screen.
export async function screen(b: Record<string, unknown>) {
  const watch = live(String(b.purpose ?? ''), String(b.ref ?? ''));
  if (!watch) return [404, 'No screen is being shown on this call.'];
  settled(watch);
  if (watch.moments.paused)
    return [409, "They've paused showing their screen: you see nothing of it until they resume."];
  const clock = clockOf(watch);
  if (b.since != null) {
    const since = when(String(b.since), watch);
    if (since === undefined) return [400, WHEN_WORDS];
    const listed = lines(
      watch.moments.list.filter(moment => moment.at >= since),
      clock,
    ).slice(-LIST_LINES);
    return { lines: listed.length ? listed : ['(nothing since then)'] };
  }
  const region = regionOf(b.region);
  if (region === null) return [400, 'region is { x, y, width, height }, each a fraction of the screen from 0 to 1'];
  const spec = String(b.at ?? 'now').trim();
  if (spec === 'now' || spec === '') {
    const picture = await mirrors.now(watch.id, { long: TOOL_PX, region });
    return picture ? pictured(picture.bytes, `The screen now (${clock(Date.now() - watch.clockMs)})`) : [404, NOTHING];
  }
  const time = when(spec, watch);
  if (time === undefined) return [400, WHEN_WORDS];
  const moment = spec.startsWith('#') ? watch.moments.list.find(m => m.n === Number(spec.slice(1))) : undefined;
  const ring = moment?.kind === 'tap' ? { x: moment.x!, y: moment.y! } : undefined;
  const recording = store.read(kept, watch.id);
  const picture =
    recording && (await mirrors.at(recording.events, time, { long: TOOL_PX, region, ring }, shows(recording.session)));
  return picture
    ? pictured(picture.bytes, `The screen at ${clock(time)}${moment ? ` (#${moment.n})` : ''}`)
    : [404, NOTHING];
}
export const NOTHING = 'Nothing of the screen was recorded by then.';
const WHEN_WORDS =
  "a time is 'now', some seconds or minutes ago ('-20s', '-2m'), a time of day ('17:03:12') or a moment ('#12')";
const pictured = (jpeg: Buffer, words: string) => ({
  picture: { type: 'image/jpeg', data: jpeg.toString('base64') },
  line: words,
});

// A time asked for, on the page's clock: some seconds or minutes ago, a time of day today on the company's clock, or a
// moment's. undefined: none of those
export function when(spec: string, watch: { moments: Pick<Moments, 'list'>; clockMs: number }, now = Date.now()) {
  const ago = /^-(\d+)\s*(s|m)$/.exec(spec);
  if (ago) return now - Number(ago[1]) * (ago[2] === 'm' ? 60_000 : 1000) - watch.clockMs;
  const moment = /^#(\d+)$/.exec(spec);
  if (moment) return watch.moments.list.find(m => m.n === Number(moment[1]))?.at;
  const time = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(spec);
  if (!time) return undefined;
  const [hours, minutes, seconds] = [time[1], time[2], time[3] ?? '0'].map(Number);
  if (hours > 23 || minutes > 59 || seconds > 59) return undefined;
  // (today's date on the company's clock, and how far that clock is from UTC now)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone(),
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(now)
      .map(part => [part.type, Number(part.value)]),
  );
  const offset =
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
    Math.floor(now / 1000) * 1000;
  let at = Date.UTC(parts.year, parts.month - 1, parts.day, hours, minutes, seconds) - offset;
  if (at > now + 60_000) at -= 86_400_000; // (a time later than now: yesterday's, a call past midnight)
  return at - watch.clockMs;
}
function regionOf(asked: unknown): Region | undefined | null {
  if (asked == null) return undefined;
  const { x, y, width, height } = asked as Record<string, unknown>;
  const all = [x, y, width, height];
  if (!all.every(v => typeof v === 'number' && v >= 0 && v <= 1)) return null;
  const region = { x: x as number, y: y as number, width: width as number, height: height as number };
  return region.width > 0 &&
    region.height > 0 &&
    region.x + region.width <= 1.0001 &&
    region.y + region.height <= 1.0001
    ? region
    : null;
}

// ---------------------------------------------------------------- watching a call back
// A call's recording, every session of it in order (a call minimised again after a restore records anew), with its
// moments folded and settled: what HQ's player and hq call's moments and screen read. clockMs: how far the page's clock
// ran behind the server's (the sessions are one page's, so one gap). undefined: nothing recorded.
export function playback(purpose: string, ref: string) {
  const recordings = store
    .sessionsOf(kept, purpose, ref)
    .map(session => store.read(kept, session.id))
    .filter(recording => recording?.events.length) as store.Recording[];
  if (!recordings.length) return undefined;
  const events = recordings.flatMap(recording => recording.events);
  const moments = new Moments();
  moments.add(events);
  moments.settle(Infinity);
  // (shows: what its sessions may show, for the mirror.)
  const shown = recordings.map(recording => shows(recording.session));
  return {
    events,
    clockMs: Math.min(...recordings.map(recording => recording.clockMs)),
    moments: moments.list,
    shows: (origin: string) => shown.some(may => may(origin)),
  };
}
export const callPlayback = (call: number) => playback(CALL, String(call));

// Whether a call has something recorded to watch back (the call log's "Watch it back")
export const recorded = (call: number) => store.sessionsOf(kept, CALL, String(call)).some(session => session.bytes > 0);

// The mirrors' Chromium, for measuring its memory; every mirror closed (a test's end)
export const mirrorPid = () => mirrors.pid();
export const closeMirrors = () => mirrors.closeAll();

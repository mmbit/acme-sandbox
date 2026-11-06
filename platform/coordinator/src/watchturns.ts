// What a call's agent sees of a watch-along (watchalong.ts): with each of the caller's turns, what was done since its
// last and a picture of the screen when it changed (screenTurn), and its screen tool's closer look (screen). On the
// board's call, every screen on it: the board's, its other screens' and each guest's who shows theirs, under whose
// screen it is.
import * as store from '../../../shared/watchalong/store.ts';
import * as playback from '../../../shared/watchalong/playback.ts';
import { lines, type Moments } from '../../../shared/watchalong/moments.ts';
import { WHEN_WORDS, when } from './watchtimes.ts';
import { regionOf } from './region.ts';
import { exclude } from './latency.ts';
import { boardAway } from './callaway.ts';
import { boardScreen } from './callguestnames.ts';
import {
  CALL,
  CALLOUT,
  GUEST,
  NOTHING,
  SCREEN,
  TOOL_PX,
  clockOf,
  guestRef,
  guestsOf,
  kept,
  live,
  mirrors,
  screensOf,
  settled,
  showing,
  shows,
  type Watch,
} from './watchalong.ts';

// A turn's lines: at most TURN_LINES. Pictures: JPEG, TURN_PX on the long side with a turn (TOOL_PX for the screen
// tool). The tool's moment list: at most LIST_LINES, the latest.
const TURN_LINES = 20,
  LIST_LINES = 60,
  TURN_PX = 1024,
  TURN_PICTURE_MS = 1_000; // (a picture of an open mirror takes about 0.2 s: server.py)

// The briefing's paragraph on a walk-through, for whoever shows the screen (who: 'the board', 'they'; their: 'its',
// 'their'): it comes with the caller's turn once the screen is shown, as the call's briefing was written before
const briefing = (who: string, their: string) => {
  const Who = who.charAt(0).toUpperCase() + who.slice(1),
    whose = who === 'they' ? their : `${who}'s`;
  return `(You can now see ${whose} screen: a walk-through of our pages. With each of ${their} turns you get what was \
done since your last turn, one line each (pages opened, taps, scrolls, typing: how much and where, never what), and a \
picture of the screen as ${their} words ended when it changed, the last tap ringed. Your screen tool shows the screen \
now, a moment before, a part zoomed in, or the moments since a time. ${Who} may describe things loosely ("this one", \
"up here"): trust the screen, and ask about what's on it when it isn't clear. Talk about what you see as someone \
looking over ${their} shoulder would ("the blue button at the bottom"), and never read the lines, their numbers or \
times out. A box marked "picture not captured" stands for a picture your copy of the screen couldn't show: it is \
there on ${their} screen, so never raise it. While the screen is paused you see nothing of it.)`;
};

// ...and on the board's call, that its other screens and a guest's come too
const OTHER_SCREENS = `(The board's other screens on the call show themselves to you too, such as an iPad beside the one \
the call is on: what it opens and points at there, as "The board's screen 2" and so on. A guest in the room who joined \
the call from a device of their own shows you their screen too: the call's page and the prototypes they open there, as \
they see it, with what they draw on it. Each screen's lines and picture come under whose screen it is, and your screen \
tool looks at one by who: "screen 2" for the board's, a guest's by their name. A guest's typing shows only as typing, \
never its words.)`;

// What each purpose's agent is told once the screen is shown. A purpose without a briefing is never watched for an agent.
const BRIEFS = new Map([
  [CALL, `${briefing('the board', 'its')}\n\n${OTHER_SCREENS}`],
  [CALLOUT, briefing('they', 'their')],
]);

// POST /api/voice/screen-turn { purpose, ref, after, seen, briefed, picture }: for a caller's turn, the moments since the agent's
// last (after: the last moment it had), and a picture of the screen now when it changed since the one it has (seen: that
// picture's version), the last tap since then ringed. While paused, the lines up to the pause and no picture. brief:
// what the agent is told of a walk-through (BRIEFS), for a session that hasn't had it (briefed false). picture false:
// none (the call has had all it can hold). A picture not there within TURN_PICTURE_MS (its mirror opening, stalled or
// failed) leaves the lines to go without it, saying so, and comes with a later turn: the line waits 1.5 s for the
// whole answer (platform/voice/server.py SCREEN_TURN_SECONDS) and drops the lines with it.
export async function screenTurn(b: Record<string, unknown>) {
  const purpose = String(b.purpose ?? ''),
    brief = BRIEFS.get(purpose);
  const watch = brief ? live(purpose, String(b.ref ?? '')) : undefined;
  // (with another screen on the board's call, every screen: screensTurn.)
  const others = purpose === CALL ? otherScreens(String(b.ref ?? '')) : [];
  if (others.length) return screensTurn(b, watch, others, brief!);
  if (!watch) return { on: false };
  settled(watch);
  // (by session, as screensTurn gave them, once the last other screen has gone)
  const after = cursor(b.after, watch)[watch.id] ?? 0,
    seen = cursor(b.seen, watch)[watch.id] ?? 0;
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
  const picture = await pictureNow(watch, seen);
  return picture
    ? { ...answer, picture: { type: 'image/jpeg', data: picture.bytes.toString('base64') } }
    : { ...answer, lines: [...answer.lines, NO_PICTURE] };
}
// A turn's picture of a screen as it is now, the last tap since the one the agent has (seen) ringed: undefined when it
// isn't there within TURN_PICTURE_MS
function pictureNow(watch: Watch, seen: number) {
  const ring = watch.tap && watch.tap.version > seen ? watch.tap : undefined;
  return inTime(mirrors.now(watch.id, { long: TURN_PX, ring }), TURN_PICTURE_MS);
}

// ---------------------------------------------------------------- every screen on the board's call
// A screen on the board's call: who the screen tool knows it by, and the heading its lines come under
type Screen = { who: string; whose: string; watch: Watch };
// The board's other live screens on a call (screen 2, 3, by the order they first showed it: never by a name), none while
// it has left the call to a guest (what the agent sees then reaches the guest: callaway.ts), then its guests', by the
// name the call knows each by; each while its page still posts (showing)
const otherScreens = (call: string): Screen[] => [
  ...(boardAway(Number(call)) ? [] : screensOf(call)).flatMap((ref, i) => {
    const watch = showing(SCREEN, ref);
    return watch ? [{ who: `screen ${i + 2}`, whose: `The board's screen ${i + 2}`, watch }] : [];
  }),
  ...guestsOf(Number(call)).flatMap(({ guest, name }) => {
    const watch = showing(GUEST, guestRef(call, guest));
    return watch ? [{ who: name, whose: `${name}'s screen`, watch }] : [];
  }),
];
// The board's call with another screen on it: each screen's moments since the agent's last turn under whose screen it
// is, and a picture of each that changed since the one the agent has (pictures, in the order the lines name them),
// taken side by side so the turn waits TURN_PICTURE_MS at most however many screens there are.
// after and seen are as the last such answer gave them (last, version: by each screen's session), or a number, the
// board's screen's alone, from before another came. A screen whose picture isn't there in time says so, and it comes
// with a later turn. paused is never said: a screen paused is one among them, its lines up to the pause.
async function screensTurn(b: Record<string, unknown>, board: Watch | undefined, others: Screen[], brief: string) {
  const screens = [...(board ? [{ who: 'the board', whose: "The board's screen", watch: board }] : []), ...others];
  const after = cursor(b.after, board),
    seen = cursor(b.seen, board);
  const lines: string[] = [],
    last: Record<string, number> = {},
    version: Record<string, number> = {};
  const pictures: { type: string; data: string }[] = [];
  const taken = await Promise.all(
    screens.map(async ({ whose, watch }) => {
      const key = String(watch.id),
        had = seen[key] ?? 0;
      settled(watch);
      const own = turnLines(watch.moments.after(after[key] ?? 0), clockOf(watch));
      last[key] = watch.moments.list.at(-1)?.n ?? 0;
      version[key] = had;
      const changed = !watch.moments.paused && watch.version !== had && b.picture !== false;
      return { whose, watch, key, own, changed, picture: changed ? await pictureNow(watch, had) : undefined };
    }),
  );
  for (const { whose, watch, key, own, changed, picture } of taken) {
    if (picture) {
      version[key] = watch.version;
      pictures.push({ type: 'image/jpeg', data: picture.bytes.toString('base64') });
    }
    const said = picture ? ' (its picture comes with this turn)' : changed ? ` ${NO_PICTURE}` : '';
    if (own.length || said) lines.push(`${whose}${said}:`, ...own);
  }
  return { on: true, paused: false, lines, last, version, pictures, ...(b.briefed === true ? {} : { brief }) };
}
// A turn's after or seen, by each screen's session: as an earlier answer gave it, or a number for the board's alone
function cursor(given: unknown, board: Watch | undefined): Record<string, number> {
  if (given && typeof given === 'object')
    return Object.fromEntries(Object.entries(given).map(([key, n]) => [key, Number(n) || 0]));
  return board ? { [board.id]: Number(given) || 0 } : {};
}
const NO_PICTURE = '(no picture of their screen came with this turn: it comes with a later one)';
// What a step gives within ms, else undefined (failed too)
const inTime = <T>(step: Promise<T>, ms: number) =>
  Promise.race([step.catch(() => undefined), new Promise<undefined>(done => setTimeout(done, ms))]);
// At most TURN_LINES: the latest, and how many earlier ones the screen tool lists
function turnLines(moments: Moments['list'], clock: (at: number) => string) {
  const all = lines(moments, clock);
  if (all.length <= TURN_LINES) return all;
  const left = all.length - TURN_LINES + 1;
  return [`(${left} earlier lines left out: the screen tool lists them)`, ...all.slice(-TURN_LINES + 1)];
}

// POST /api/voice/screen { purpose, ref, at?, region?, since? }: the screen tool. since: the moments since then
// ('-2m', '17:03', '#12'). Otherwise a picture, TOOL_PX on its long side: now, or at ('-20s', '17:03:12', '#12'; a
// moment's own tap ringed), all of it or region { x, y, width, height } in fractions of the screen. who: on the board's
// call, another of the board's screens ('screen 2') or a guest's by their name, the call's own without.
export async function screen(b: Record<string, unknown>) {
  const purpose = String(b.purpose ?? '');
  // (who: another screen, as its lines come under.)
  if (purpose === CALL && typeof b.who === 'string' && boardScreen(b.who) !== 'the board') return otherScreen(b);
  const watch = BRIEFS.has(purpose) ? live(purpose, String(b.ref ?? '')) : undefined;
  if (!watch) return [404, purpose === CALL ? UNSHOWN : 'No screen is being shown on this call.'];
  return screenOf(watch, b);
}
// Another screen on the board's call: the board's by its number ('screen 2', "the board's screen 2"), a guest's by their
// name.
function otherScreen(b: Record<string, unknown>) {
  const who = boardScreen(String(b.who)) ?? String(b.who).trim().toLowerCase(),
    screens = otherScreens(String(b.ref ?? ''));
  const found = screens.find(s => s.who.toLowerCase() === who);
  if (found) return screenOf(found.watch, b);
  const names = screens.map(s => s.who).join(', ');
  return [404, `No screen of ${b.who} on this call: ${names ? `the others shown are ${names}` : 'no other is shown'}.`];
}
// The screen tool on one screen
async function screenOf(watch: Watch, b: Record<string, unknown>) {
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
    const picture = await exclude(mirrors.now(watch.id, { long: TOOL_PX, region }));
    return picture ? pictured(picture.bytes, `The screen now (${clock(Date.now() - watch.clockMs)})`) : [404, NOTHING];
  }
  const time = when(spec, watch);
  if (time === undefined) return [400, WHEN_WORDS];
  const moment = spec.startsWith('#') ? watch.moments.list.find(m => m.n === Number(spec.slice(1))) : undefined;
  const ring = moment?.kind === 'tap' ? { x: moment.x!, y: moment.y! } : undefined;
  // (read on playback.ts's thread: a long share's recording would hold the loop.)
  // (its waits there and on Chromium hold nothing of HQ's: latency.ts exclude.)
  const session = store.find(kept, watch.id);
  const events = session && (await exclude(playback.at(kept.dir, [session], time)));
  const picture = events && (await exclude(mirrors.at(events, time, { long: TOOL_PX, region, ring }, shows(session))));
  return picture
    ? pictured(picture.bytes, `The screen at ${clock(time)}${moment ? ` (#${moment.n})` : ''}`)
    : [404, NOTHING];
}
const UNSHOWN = "Their screen isn't shown to you: ask to see it with ask_to_see, and they answer yes or no.";
const pictured = (jpeg: Buffer, words: string) => ({
  picture: { type: 'image/jpeg', data: jpeg.toString('base64') },
  line: words,
});

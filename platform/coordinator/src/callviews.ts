// hq call <id> moments and hq call <id> screen <time>: an ended walk-through call's recording for agents, stepped back
// through, on hq call's own access (server.ts 'GET /api/agent/call', view).
//   - Times are the server's: a moment's (the page's clock) + the recording's clockMs, a transcript line's its own
//     (calls.line_times, from the voice line, whose clock is the server's). A call from before they were kept has none,
//     and says so.
//   - A live call's screen is its own agent's (the voice line's screen tool), never these.
// And the board's: the recording to watch back in HQ's player (forBoard).
import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { db } from './db.ts';
import { timeZone } from './company.ts';
import { reply } from './uploads.ts';
import { NOTHING, TOOL_PX, callPlayback, clockOf, mirrors, when } from './watchalong.ts';
import type { Moment } from '../../../shared/watchalong/moments.ts';

type Refusal = 404 | [number, string];

function transcriptOf(call: number) {
  const row = db.prepare('select lines, line_times, status from calls where id = ?').get(call) as
    { lines: string; line_times: string | null; status: string } | undefined;
  if (!row) return undefined;
  const lines = JSON.parse(row.lines) as string[],
    times = row.line_times ? (JSON.parse(row.line_times) as number[]) : null;
  return { lines, times: times?.length === lines.length ? times : null, live: row.status === 'live' };
}
// The call's transcript and recording, or why not
function watchedBack(call: number) {
  const said = transcriptOf(call);
  if (!said) return 404;
  if (said.live) return [409, `Call #${call} is still going on: its screen is the call's own.`] as Refusal;
  const recording = callPlayback(call);
  if (!recording) return [404, `Call #${call} has no recording: nothing of a screen was shown on it.`] as Refusal;
  return { said, recording };
}
const refused = (watched: ReturnType<typeof watchedBack>): watched is Refusal =>
  typeof watched === 'number' || Array.isArray(watched);

// The call's moments and its transcript's lines in one timeline, each with its time on the company's clock, the moments
// by number (#14) and the lines by theirs ([12], as hq call numbers them). The same moment's words in a row (no line
// between) are one line, counted, as the call's agent reads them.
export function timeline(call: number) {
  const watched = watchedBack(call);
  if (refused(watched)) return watched;
  const { said, recording } = watched;
  const clock = clockOf({ clockMs: 0 });
  type Entry = { at: number; moments?: Moment[]; line?: string };
  const entries: Entry[] = recording.moments.map(moment => ({ at: moment.at + recording.clockMs, moments: [moment] }));
  if (said.times) entries.push(...said.lines.map((line, i) => ({ at: said.times![i], line: `[${i + 1}] ${line}` })));
  entries.sort((a, b) => a.at - b.at); // (stable: a moment and a line at the same ms keep their order)
  const merged: Entry[] = [];
  for (const entry of entries) {
    const run = merged.at(-1)?.moments,
      moment = entry.moments?.[0];
    if (run && moment && run[0].kind === moment.kind && run[0].words === moment.words) run.push(moment);
    else merged.push(entry);
  }
  const lines = merged.map(({ at, moments, line }) => {
    if (line) return `${clock(at)}  ${line}`;
    const [first, ...more] = moments!;
    return more.length
      ? `${clock(at)}  #${first.n}–${more.at(-1)!.n} ${first.words} (×${more.length + 1})`
      : `${clock(at)}  #${first.n} ${first.words}`;
  });
  const untimed =
    said.times || !said.lines.length
      ? {}
      : {
          untimed: `the transcript's lines have no times (call #${call} is from before they were kept): hq call ${call} reads them`,
        };
  return { timeZone: timeZone(), lines, ...untimed };
}

// A PNG of the screen then, TOOL_PX on its long side, the pen's ink drawn and a moment's own tap ringed. at: a time of
// day on the company's clock ('17:03:12'), a moment ('#14') or a time from the call's start ('+2m10s': its first line,
// or the recording's start when that came first or the lines have no times). After the recording's end: its last screen.
export async function screenAt(call: number, spec = '') {
  const watched = watchedBack(call);
  if (refused(watched)) return watched;
  const { said, recording } = watched;
  const { events, clockMs, moments, shows } = recording;
  const first = events[0].timestamp,
    last = events.at(-1)!.timestamp;
  const start = Math.min(first + clockMs, said.times?.[0] ?? Infinity);
  const asked = spec.trim(),
    from = FROM_START.exec(asked);
  const time =
    from && from.slice(1).some(Boolean)
      ? start + ((Number(from[1] ?? 0) * 60 + Number(from[2] ?? 0)) * 60 + Number(from[3] ?? 0)) * 1000 - clockMs
      : asked.startsWith('+')
        ? undefined
        : when(asked, { moments: { list: moments }, clockMs }, last + clockMs);
  if (time === undefined) return [400, AT_WORDS] as Refusal;
  const clock = clockOf(recording);
  if (time < first)
    return [
      404,
      `Nothing of the screen was recorded by then: the recording runs from ${clock(first)} to ${clock(last)}.`,
    ] as Refusal;
  const moment = asked.startsWith('#') ? moments.find(m => m.n === Number(asked.slice(1))) : undefined;
  const ring = moment?.kind === 'tap' ? { x: moment.x!, y: moment.y! } : undefined;
  const shown = Math.min(time, last);
  const picture = await mirrors.at(events, shown, { long: TOOL_PX, png: true, ring }, shows);
  if (!picture) return [404, NOTHING] as Refusal;
  const ended = time > last ? ` (the recording ended at ${clock(last)})` : '';
  return {
    picture: { type: 'image/png', data: picture.bytes.toString('base64') },
    width: picture.width,
    height: picture.height,
    at: shown + clockMs,
    line: `The screen at ${clock(shown)}${moment ? ` (#${moment.n})` : ''}, ${lasted(shown + clockMs - start)} into the call${ended}`,
  };
}
const FROM_START = /^\+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
const AT_WORDS =
  "a time is a time of day on the company's clock ('17:03:12'), a moment ('#14') or a time from the call's start ('+2m10s')";
const lasted = (ms: number) => {
  const s = Math.round(Math.max(0, ms) / 1000),
    h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}h` : ''}${h || m ? `${m}m` : ''}${s % 60}s`;
};

// GET /api/calls/recording?call=<id>, the board's: a call's recording to watch back in HQ's player, as gzipped NDJSON. Its
// first line is the head, { clockMs, moments, start, end } (the first and last event's time, on the page's clock) with
// `about` (the call's notes and items, server.ts), then one event a line in order, so the player shows the screen from
// the first lines while the rest comes. Never the transcript: the board isn't shown its own calls' words.
export async function forBoard(res: ServerResponse, call: number, about: Record<string, unknown>) {
  const recording = callPlayback(call);
  if (!recording) return reply(res, 404, { error: 'nothing recorded' });
  const { events, clockMs, moments } = recording;
  const head = { clockMs, moments, start: events[0].timestamp, end: events.at(-1)!.timestamp, ...about };
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'content-encoding': 'gzip',
    'cache-control': 'private, no-store',
  });
  // (a few lines to a chunk: a canvas frame's event is tens of KB, a tap's a hundred bytes)
  function* chunks() {
    yield `${JSON.stringify(head)}\n`;
    for (let i = 0; i < events.length; i += LINES_A_CHUNK)
      yield events
        .slice(i, i + LINES_A_CHUNK)
        .map(event => `${JSON.stringify(event)}\n`)
        .join('');
  }
  await pipeline(Readable.from(chunks()), createGzip({ level: GZIP_LEVEL }), res);
}
// Gzip's level 4: the canvas frames (base64 WebP) hardly shrink further, the DOM's text does at any level
const LINES_A_CHUNK = 64,
  GZIP_LEVEL = 4;

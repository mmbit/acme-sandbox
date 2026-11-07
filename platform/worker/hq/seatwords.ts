// A seat's admission and active work in words, for the hq command and the coordinator's reports (the worker's
// seatstatus.ts judges them). Here, under hq/, so the installed command carries it.
import { plural } from './output.ts';
import { waitWords, type Wait } from './waits.ts';

// A seat's state as the worker reports it (HQ also hears 'paused': the worker's reportSeat)
export type SeatState = 'login' | 'ready' | 'draining' | 'sleeping' | 'closed';
// Why an unavailable seat takes no new work: no usage read, at its stop level until a window resets, or a hold the
// worker reported (held by its provider while asleep, or drained at its stop)
type SeatReason = 'usage' | 'quota' | 'provider' | 'drained';
export type SeatStatus = {
  admission: 'open' | 'paced' | 'unavailable';
  until: number | null;
  running: number;
  // a paced seat's runs at a time, its week's allowance per hour (a share of it), and the end of its rest after a run
  // its allowance can't keep up with (the worker's pace.ts pacedRuns and pacedRest)
  pace?: { runs: number; perHour: number; restUntil?: number };
  state: SeatState | 'paused';
  reason?: SeatReason;
  // a held Codex seat's next check, before its hold's end (until)
  nextCheck?: number;
  // why its claims come back empty, while they do (the coordinator's emptyclaims.ts)
  empty?: EmptyClaim & { since: number; seen: number };
};
// The first check the best job for a seat failed when its claim came back empty (the coordinator's jobs.ts claim). The
// job is null when the seat takes nothing queued. What the check held the job against is words, a time, or what the
// plan waits for.
export type EmptyClaim = {
  check: EmptyCheck;
  job: number | null;
  against?: string | null;
  until?: number | null;
  wait?: Wait | null;
};
export type EmptyCheck =
  | 'none'
  | 'not before'
  | 'company paused'
  | 'runs held'
  | 'paused'
  | 'waits'
  | 'spare'
  | 'pacing'
  | 'room kept'
  | 'memory'
  | 'meeting';

export function seatStatusWords(status: SeatStatus, at: (ms: number) => string) {
  const words = admissionWords(status, at);
  return status.empty ? `${words}. ${emptyWords(status.empty, at)}` : words;
}
function admissionWords(status: SeatStatus, at: (ms: number) => string) {
  const running = `${status.running} running`;
  const when = status.until === null ? undefined : at(status.until);
  if (status.admission === 'unavailable') {
    if (status.reason === 'usage')
      return `${running}. Usage reading missing. Return time unknown until the account is read`;
    const check = status.nextCheck ? `, checked again ${at(status.nextCheck)}` : '';
    if (status.reason === 'quota')
      return `${running}. New work waits at its quota stop${when ? ` until ${when}` : '. Reset time not reported'}${check}`;
    const held = status.reason && HELD[status.reason];
    if (held) return `${running}. ${held}${when ? `, back ${when}` : '. Return time not reported'}${check}`;
    const waitsFor = when ? `until ${when}` : (UNTIMED[status.state] ?? 'with no return time reported');
    return `${running}. New work waits ${waitsFor}`;
  }
  if (status.admission === 'paced' && status.pace) {
    const { runs, perHour, restUntil } = status.pace;
    const percent = perHour < 0.0001 ? 'under 0.01%' : `${(perHour * 100).toFixed(2)}%`;
    const allowance = `${percent} of its week per hour`;
    const rate =
      restUntil !== undefined
        ? `resting until ${at(restUntil)}, so its runs keep to the ${allowance} available`
        : `${plural(runs, 'run')} at a time, ${allowance} available`;
    return `${running}. Paced${when ? ` until ${when}` : ''}: ${rate}. Urgent work may bypass this rate`;
  }
  return `${running}. Takes new work within available room`;
}
// What a seat with no return time waits for, by its state
const UNTIMED: Partial<Record<SeatState | 'paused', string>> = {
  login: 'until the board signs the seat in again',
  paused: 'until the board resumes the seat',
  closed: 'until the board decides on the account its provider closed',
};
// What a seat held by its provider or at its stop says, by its reason
const HELD: Partial<Record<SeatReason, string>> = { provider: 'Held by its provider', drained: 'Held at its stop' };

// "Its claims came back empty from 5 Nov 03:00 to 5 Nov 15:59, at pacing: #19426 isn't urgent, and the seat is paced
// until 8 Nov 16:00"
export function emptyWords(e: NonNullable<SeatStatus['empty']>, at: (ms: number) => string) {
  const job = `#${e.job}`,
    until = e.until == null ? '' : at(e.until),
    waits = e.wait ? waitWords(e.wait, at) : '';
  const why: Record<EmptyCheck, string> = {
    none: 'nothing queued that it takes',
    'not before': `${job} starts no earlier than ${until}`,
    'company paused': `${job} waits for the board's pause of the company`,
    'runs held': `${job}'s agent is held ${e.against}`,
    paused: `${job} is paused with ${e.against}`,
    waits: e.wait?.on === 'stalled' ? `${job} is stalled: ${waits}` : `${job} waits on ${waits}`,
    spare: `${job} is spare work, for a seat with room to spare`,
    pacing: `${job} isn't urgent, and the seat's paced places are occupied`,
    'room kept': `the room is kept for ${e.against}, ahead of ${job}`,
    memory: `${job} needs ${e.against}`,
    meeting: `${job} waits for its meeting's seats`,
  };
  const check = e.check === 'none' ? '' : `, at ${e.check}`;
  return `Its claims came back empty from ${at(e.since)} to ${at(e.seen)}${check}: ${why[e.check]}`;
}

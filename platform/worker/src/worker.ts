// The worker: runs agent jobs from the coordinator, each in its own git worktree, with Claude Code or Codex.
// Seats (subscription logins) form a pool per engine: every job gets the healthiest seat, several jobs run
// at once (slots), a seat nearing its usage limit takes no new work, and a job that hits a limit resumes
// in the same session on another seat (sessions are shared between seats). Codex seats share their work out instead:
// each Codex job is for one seat, which alone runs it, so a full account never hands its share to another
// (pickSeat). A job that needs the board
// parks on a request (or, for team leads, waits in session); a restart hands jobs back to the queue.
//
// Trust: this process runs as root and alone holds GITHUB_TOKEN and WORKER_TOKEN. Every slot has its own uid and
// gid (slots.ts): a job, and everything that touches its files (git in its clone, reading its .hq), runs as the
// uid of the slot running it, with an allowlisted environment, so it can't read our tokens or another job's files,
// processes or HQ_TOKEN. Sign-ins and token checks run as uid 1500, the keeper of /seats, which runs no job.
import { seatPlaces } from './places.ts';
import { assertOwned, ownRun, ownershipSignal, requestSignal, sleepOwned, waitOwned } from './ownership.ts';
import { readAs, returnSignIn } from './signin.ts';
import { REFRESH_URL_VAR, codexRefreshes, exchangeWithOpenAI, serveRefreshes } from './refreshes.ts';
import { measurement } from '../tooling/metrics.ts';
import { DEFAULT_ESTIMATE_SCALE } from './estimating.ts';
import { handedUpLines, lighterLine, lightLines } from './lighter.ts';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { existsSync, mkdirSync, chmodSync, lchownSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { keepRenders } from './renders.ts';
import { agentEnv, redact, redactJson, PROFILE_BRANCH, workRunsOn, BRANCH_CONFIG, REVIEW_STRIP, claudeArgs, codexAskArgs, SIGN_IN } from './safety.ts';
import { TOUCHUP_LINES, FetchUnreachedError, PushUnreachedError, answerMainMerge, branchLines, gitFlow, pinnedGitEnv, runAs } from './git.ts';   // (pinnedGitEnv)
import { see as account, relaunched, report, spentOn, type Spent } from './spent.ts';
import { giveBack, handOut, masked, plainName, type Files, type Folders, type Snap } from './copyback.ts';
import { roomTurns } from './roomturns.ts';
import { capacityCapture, capacitySample } from './capacity.ts';
import { pacedUntil, paceTo, windowUsed } from './pace.ts';
import { checkDue, claimAnswered, codexLimits, codexLogLine, codexReading, codexTokens, drainOf, healthiest, keepsToPlan, limitsReading, readDue, reserveFor, heard, takeRead, takeReading, inTurn, lineSeat, reportedUntil, retryAt, sleepUntil, unpacedFirst, type Asked } from './downtime.ts';
import { FREE_MB, JOB_MB, SEAT_MB, STARTING_MS } from './reserve.ts';
import { admission, cgroup, hostAvailableBytes } from './admission.ts';
import { CHAT_SLOT, KEEPER, SLOT_IDS, WORK_SLOTS, askHome, jobDirs, killAll, makeDir, own, rootDir, sweep, type Ids } from './slots.ts';
import { limitReset, observe, outcome, parkedRequest, preview, tail, verdict, whole } from './outcome.ts';   // (parkedRequest)
import { detailOf, stepOf, shown, guard, memberReturned, memberOf, writtenTokens, type Shown } from './steps.ts';
import { completionHooks } from './completion.ts';
import { claudeEnv, cliOf, codexArgs, credentialFile, modelFor, type SeatProvider } from './providers.ts';
import { CLIS, CLI_CONFIG, resumeOn, sessionTag, type Cli } from './clis.ts';
import { carrySession, closingLines, project, type ClosingReports, type Resumes } from './carry.ts';
import { applyList, carryOut, creditsNote, off, type Listed, type SeatAction } from './seatlist.ts';
import { SEAT_NAME } from './seatid.ts';
import { moveSeats } from './seatmoves.ts';
import { closing, type OwnedProject } from './closing.ts';
import { bringUpToDate, ownCommit, profilePaths, rebuildProfile, repairFrom, restoreProfile, splitProfile, startRepair, threadBriefing, type InThread, type Pull } from './threads.ts';
import { DiskShares } from './disk.ts';
import { warnDisk } from './diskwarnings.ts';
import { Reload } from './reload.ts';
import { cliProcesses, processesFor, overShare, tally, type JobUse, type ProcessSnapshot } from './shares.ts';
import { enforceShares } from './sharepass.ts';
import { type MemoryVerdict } from './lowmemory.ts';
import { overloadWatch, type Pressure } from './overload.ts';
import { callsAsTheyCome } from './smallturns.ts';
import { fewAtOnce } from './turns.ts';
import { handBack, noteHandBacks } from './handback.ts';
import { hqReports, ResponseError } from './reports.ts';
import { openPullRequest as openOn } from './pulls.ts';
import { tellMainLine, type ToldMain } from './mainline.ts';
import { alive, dropRun, endOf, endSeen, exitOf, follow, keepRecord, launch as launchDetached, launchesOf, processesOf, procStat, recordOf, records, sweepRuns, type CheckRun, type Checks, type Launched, type RunRecord } from './detached.ts';
import { inChecks, runChecks, testsOnce, type CheckOutcome, type CheckSpec, type TestsOutcome } from './pushchecks.ts';
import { testsCheckout as testsAt, type TestsCheckout } from './testscheckout.ts';
import { answering, askAgainPrompt, cantAsk, lacksVerdict, see, seeSessionLogs, touchedFiles, verdictFromAnswer, verdictOf, written } from './verdict.ts';

const HQ = process.env.HQ_URL ?? 'http://coordinator:8080';
const { WORKER_TOKEN, REPO, GITHUB_TOKEN } = process.env;
const transport = hqReports(HQ, WORKER_TOKEN);
const hq = {
  api: async (path: string, body: unknown = {}, signal?: AbortSignal) => {
    const reply = await transport.api(path, body, requestSignal(signal));
    assertOwned();
    return reply;
  },
  report: async (path: string, body: Record<string, unknown>, ms?: number, signal?: AbortSignal) => {
    const reply = await transport.report(path, body, ms, requestSignal(signal));
    assertOwned();
    return reply;
  },
  blocked: (body: Record<string, unknown>, signal?: AbortSignal) => transport.blocked(body, requestSignal(signal)),
};
const BASE = process.env.BASE_BRANCH ?? process.env.BRANCH ?? 'main';
export type SeatState = 'login' | 'ready' | 'draining' | 'sleeping' | 'closed';   // (HQ also hears 'paused': reportSeat)
// util: the share of the 5-hour window used, unknown until the seat reports it (its first run or recheck after a
// start), and for a Codex seat whose plan reports no 5-hour window (only the week);
// week: the weekly window's share, when the seat reports one (downtime work counts the fuller of the two, windowUsed);
// measured: when a Codex seat's latest reading was written (codexWindow); probing: a Codex seat's one claim that may
// start downtime work to measure an unknown window, kept after a run that found no reading (slotLoop). limits: its runs
// in a row that hit a usage limit, for the backoff when the CLI names no reset time (a job's attempts restart at each).
// checked: when a held Codex seat last let a job through to measure it (checkSeat), or had its account read (readLimits). hasCredits: a Codex seat's account
// pays for use past its limits (codexReading); credits: it may run on them past its limits, only while the board lets it
// (useCredits, seatlist.ts spendCredits): it runs on them only once a window is full (creditsNote). confirmed: its reading is the worker's own read of
// its account (readLimits), not a job's log, and readFailed: the latest such read failed. refusals: its runs in a row whose first request the
// API refused, for the backoff, and refused: the latest one's error, for its note. closed: when its provider closed its account, and what it
// said (close). The rest is the board's, from HQ's Seats (syncSeats): its provider (providers.ts), paused, and gone once
// the board removed it. signInRead: its sign-in has been looked at since this process started (loginLoop): until then
// its state is only the 'login' it starts with.
type Seat = SeatProvider & { id: string; state: SeatState; until: number; util?: number; resets: number;
  fiveHourObservedAt?: number; weekObservedAt?: number;
  week?: number; weekResets: number; measured?: number; probing?: boolean; limits?: number; checked?: number; credits?: boolean;
  hasCredits?: boolean; useCredits?: boolean; creditsLeft?: number; confirmed?: boolean; readFailed?: boolean;
  refusals?: number; refused?: string; closed?: string; paused?: boolean; gone?: boolean; drainAt?: number;
  signInRead?: boolean };
// A seat's id names its folder under /seats, by seatid.ts's one rule (codex-board, claude-team-2). Anything else is left out, loudly. SEATS is the company's first list: HQ keeps
// the list from then on, and the board changes it in Seats (syncSeats). A seat's drain level, the share of its windows it
// runs to (downtime.ts drainLevel), is the board's too, its stop level in HQ's Settings › Seats (applyList). A SEATS entry
// may give one in percent (claude-1:claude:95, for a plan big enough that DRAIN_AT's reserve is more than the board
// needs): HQ takes it once, for a seat the board hasn't set (the coordinator's seedSeats), and until HQ's list comes the
// seat runs to it.
const ENGINES = ['claude', 'codex'];
const SEATS_ENTRY = new RegExp(`^${SEAT_NAME}:(${ENGINES.join('|')})(:(5[0-9]|[6-9][0-9]))?$`);
const DRAIN_AT: Map<string, number> = new Map((process.env.SEATS ?? '').split(',').filter(s => SEATS_ENTRY.test(s) && s.split(':')[2])
  .map(s => [s.split(':')[0], Number(s.split(':')[2]) / 100]));
const newSeat = (id: string, engine: string): Seat => ({ id, engine, cli: listedCli.get(id) ?? engine, signIn: 'login', state: 'login', until: 0, resets: 0, weekResets: 0,
  ...(DRAIN_AT.has(id) ? { drainAt: DRAIN_AT.get(id) } : {}) });
// HQ's list as the worker last had it (syncSeats) comes first, so a restart takes over the runs on the board's seats before
// HQ answers.
const SEAT_LIST = '/seats/list.json';
const listedCli = new Map<string, string>();
const SEATS: Seat[] = (lastList() ?? (process.env.SEATS ?? 'claude-1:claude,codex-1:codex').split(','))
  .filter(s => SEATS_ENTRY.test(s) || (console.log(`SEATS: ${JSON.stringify(s)} isn't a seat (name-1:claude), left out`), false))
  .map(s => newSeat(s.split(':')[0], s.split(':')[1]));
function lastList() {
  try {
    const list = JSON.parse(readFileSync(SEAT_LIST, 'utf8')) as { id: string; engine: string; cli?: string }[];
    for (const s of list) if (s.cli) listedCli.set(s.id, s.cli);
    return list.map(s => `${s.id}:${s.engine}`);
  } catch { return undefined; }
}
// How many runs one Codex seat carries at once: as many as the room lets start, like a Claude seat, unless CODEX_SEAT_RUNS
// sets a cap. Each run signs in with its own copy of the seat's sign-in, and refreshes it through the worker
// (refreshes.ts), so no run spends another's copy. A seat's runs are counted from the pick (slotLoop), so two slots can't
// both take a capped seat's last place.
const CODEX_RUNS = Math.floor(Number(process.env.CODEX_SEAT_RUNS));
const SEAT_RUNS: Record<string, number> = CODEX_RUNS >= 1 ? { codex: CODEX_RUNS } : {};
const places = seatPlaces(SEAT_RUNS), { roomOn } = places;
const lastClaimAt = new Map<string, number>();   // when each Codex seat last claimed (inTurn)
// How many jobs run at once is the room's to decide: the worker has a hard memory cap (infra/compose.yaml), and a free
// slot (WORK_SLOTS, any engine's) only starts an ordinary job if its JOB_MB allowance fits above FREE_MB in both the
// worker and server, after reservations for young starts and held meeting seats. Young starts reserve JOB_MB
// each until they reach their full size. Usage limits are watched per seat (drainUntil in downtime.ts), and a Codex
// seat carries SEAT_RUNS at most when it's set.
// Below a full starting allowance a slot may claim a job whose measured memory fits above FREE_MB, once a minute for each
// engine's slots: the claim carries that room (the coordinator's claim `room`, room.ts measuredMb). Undefined: no claim
// now.
const SHORT_EVERY_MS = 60_000;
const shortAskedAt = new Map<string, number>();
function shortClaim(engine: string) {
  const free = reserve.claimMb();
  if (Date.now() - (shortAskedAt.get(engine) ?? 0) < SHORT_EVERY_MS || free <= 0) return undefined;
  shortAskedAt.set(engine, Date.now());
  return free;
}
// The claims' starts and the slots holding a meeting's seat (reserve.ts): a hold also keeps its seat's place (places).
const reserve = admission<Seat>(), holding = reserve.holding;
// The seat a slot holds on, while it can still take work as pickSeat takes it (ready, not off, still listed): one that hit
// its limit, drains, signed out or was held off gives the hold's room and place back, and the slot claims as any other
// (HQ then lets the hold go: its runner changed or isn't ready).
function heldOn(slot: string) {
  const seat = holding.get(slot);
  if (!seat) return undefined;
  wakeSeats();
  if (seat.state === 'ready' && !off(seat) && SEATS.includes(seat)) return seat;
  holding.delete(slot);
  places.release(seat);
  return undefined;
}
const { freeMb, room } = reserve;

// --- Each job's share ---
// Each job's share of the room (shares.ts): past JOB_MOST_MB in all a job has its heavy run blocked (blocks.ts blockRun).
// Past JOB_SHARE_MB too once no slot could start for STARVED_MS while work waits (HQ says so, and tells the CEO once: the
// coordinator's room.ts); so does a job running more than JOB_PROCESSES processes. Past half the cores its processes get
// nice 10, and past them for JOB_HOT_MS its busiest run is blocked. Looked at every SHARES_MS, reported to HQ every
// REPORT_MS. (The company's infra.env sets the memory lines, the defaults suiting a 7168m worker; the offload machine has caps
// of its own: org.yaml's runs.)
const JOB_MOST_MB = Number(process.env.JOB_MOST_MB || 2560), JOB_SHARE_MB = Number(process.env.JOB_SHARE_MB || 1536);
const JOB_PROCESSES = Number(process.env.JOB_PROCESSES ?? 400), JOB_HOT_MS = Number(process.env.JOB_HOT_MINUTES ?? 10) * 60_000;
const JOB_CORES = Math.max(2, availableParallelism() / 2), STARVED_MS = 5 * 60_000, SHARES_MS = 15_000, REPORT_MS = 60_000;
const ROOM_REQUEST_MS = 10_000, ROOM_FRESH_MS = 3 * REPORT_MS;
// Under LOW_MEMORY_MB free HQ tells the running agents to start nothing heavy, and that memory is back at MEMORY_BACK_MB
// (lowmemory.ts). Busy, the worker starts jobs down to FREE_MB + JOB_MB free, so the low line sits under that and the
// line back above it. A verdict that changes is reported at once.
const LOW_MEMORY_MB = Number(process.env.LOW_MEMORY_MB || 2048), MEMORY_BACK_MB = Number(process.env.MEMORY_BACK_MB || 3072);
const { samples: CAPACITY_SAMPLES, job: CAPACITY_JOB } = JSON.parse(readFileSync(new URL('../capacity.json', import.meta.url), 'utf8')) as { samples: number; job: number };
const inSlot = new Map<string, { job: Job; me: Me; seat: string }>();   // (each slot's job, from its claim to its end: runJob)
const SESSION = procStat(process.pid)!.sid;   // (this process's session, which the CLIs it launches share)
const checking = new Map<number, CheckRun>();   // a push's checks running (afterPush), by pid: what the shares stopped of each
const reload = new Reload();
// A job in a slot, its slot's ids looked up once, and its CLI's launch while one runs (none during its push's checks)
type SlotJob = { job: Job; me: Me; uid: number; gid: number; launch?: Launched };
// The room as the watch last saw it: since when it's been short, and the work HQ counts as waiting only for memory
// and the memory verdict last sent (lowmemory.ts)
type RoomWatch = { shortSince?: number; waiting: number; reportedAt: number; answeredAt: number; reporting: boolean; memory?: MemoryVerdict; meetingRoom?: string };

async function watchShares() {
  const watch: RoomWatch = { waiting: 0, reportedAt: 0, answeredAt: 0, reporting: false };
  let before: ProcessSnapshot[] = [], at = Date.now();
  const pending = new Set<string>();   // (the session groups asked for: overShare)
  const diskShares = new DiskShares(WORK);
  const hotSince = new Map<number, number>();   // each job (uid) past the cores, since when
  const pressureOf = overloadWatch(LOW_MEMORY_MB, MEMORY_BACK_MB);
  while (!shuttingDown) {
    await sleep(SHARES_MS);
    try {
      const jobs = slotJobs(), procs = await processesFor(jobs), t = Date.now();
      const processReadingErrors = new Map<number, string>();
      for (const p of procs) if (p.processReadingError) processReadingErrors.set(p.uid, p.processReadingError);
      for (const [uid, processReadingError] of processReadingErrors) {
        const line = `Shares uid ${uid}: ${processReadingError}`;
        log(line);
        capacityTrial.note(line);
      }
      const intervalMs = t - at, uses = tally(procs, before, intervalMs);
      const previous = before; before = procs; at = t;
      const short = !room(false);
      watch.shortSince = short ? watch.shortSince ?? t : undefined;
      const pressure = pressureOf({ freeMb: freeMb(false), uses: new Map(jobs.map(j => [j.job.id, uses.get(j.uid)?.memoryMb ?? 0])),
        room: room() });
      if (!watch.reporting && (t - watch.reportedAt >= REPORT_MS || pressure.verdict !== watch.memory)) void reportRoom(watch, jobs, uses, short, t, pressure);
      const starved = watch.shortSince !== undefined && t - watch.shortSince >= STARVED_MS && t - watch.answeredAt <= ROOM_FRESH_MS && watch.waiting > 0;
      const cli = new Set(jobs.flatMap(j => j.launch ? [...cliProcesses(procs, j.launch)] : []));
      for (const uid of hotSince.keys()) if (!((uses.get(uid)?.cores ?? 0) > JOB_CORES)) hotSince.delete(uid);
      for (const [uid, use] of uses) if (use.cores > JOB_CORES && !hotSince.has(uid)) hotSince.set(uid, t);
      const hot = new Set([...hotSince].filter(([, since]) => t - since >= JOB_HOT_MS).map(([uid]) => uid));
      for (const pid of diskShares.scanners()) cli.add(pid);
      const limits = { mostMb: JOB_MOST_MB, shareMb: JOB_SHARE_MB, cores: JOB_CORES, processes: JOB_PROCESSES, starved, hot, workerSessionId: SESSION };
      await enforceShares({
        jobs, procs, previous, intervalMs, uses, cli, limits, pending, hotSince,
        applyBlock: block => blockShare(block, jobs, procs),
        disk: diskUses => sampleDisk(diskShares, jobs, diskUses, cli),
      });
      capacityTrial.record(() => sampleCapacity(jobs, uses, intervalMs, t));
    } catch (err) { log('shares:', err); capacityTrial.note(`Shares failed: ${err}`); }
  }
  diskShares.close();
}
async function sampleDisk(shares: DiskShares, jobs: SlotJob[], uses: Map<number, JobUse>, cli: Set<number>) {
  const reserve = await hq.api('disk', {}, AbortSignal.timeout(ROOM_REQUEST_MS));
  const owners = jobs.map(j => ({ job: j.job.id, uid: j.uid, gid: j.gid }));
  const disk = await shares.measure(owners, reserve);
  await warnDisk(owners, disk, uses, cli, shares, hq.blocked);
  return disk;
}
async function blockShare(block: ReturnType<typeof overShare>['block'], jobs: SlotJob[], procs: ProcessSnapshot[]) {
  const owner = block && jobs.find(j => j.uid === block.uid);
  if (block && owner) await reload.block({ job: owner.job.id, uid: owner.uid, gid: owner.gid }, block, procs, {
    ask: hq.blocked, checking,
    stopped: text => { log(text); capacityTrial.note(text); },
  });
}
// (a worker that runs jobs as itself, in a local test, keeps no shares)
const slotJobs = (): SlotJob[] => [...inSlot].flatMap(([slot, { job, me }]) =>
  me.uid === undefined || me.gid === undefined ? [] : [{ job, me, uid: me.uid, gid: me.gid, launch: running.get(slot)?.cli }]);

function sampleCapacity(sampled: SlotJob[], uses: Map<number, JobUse>, intervalMs: number, at: number) {
  const occupants = [...inSlot].flatMap(([slot, { job, me, seat }]) => me.uid === undefined ? [] : [{
    job: job.id, slot, uid: me.uid, seat, engine: job.engine, kind: job.kind, cliPid: running.get(slot)?.cli.pid,
  }]);
  const currentJobs = new Map([...inSlot.values()].map(({ job, me }) => [me.uid, job]));
  const stableJobs = sampled.filter(j => currentJobs.get(j.uid) === j.job);
  const stableUids = new Set(stableJobs.map(j => j.uid));
  const stableEntries = [...uses].filter(([uid]) => stableUids.has(uid));
  const stableUses = new Map(stableEntries);
  const starting = reserve.starting(at);
  const seats = SEATS.map(seat => ({ id: seat.id, engine: seat.engine,
    occupiedOrHeld: places.count(seat), limit: SEAT_RUNS[seat.engine] ?? null,
    state: seat.state, windowUsed: windowUsed(seat) ?? null, eligible: seat.state === 'ready' && !off(seat) && roomOn(seat) }));
  const vmstat = readFileSync('/proc/vmstat', 'utf8');
  const host = { availableBytes: hostAvailableBytes(),
    swapInPages: Number(vmstat.match(/^pswpin (\d+)/m)![1]), swapOutPages: Number(vmstat.match(/^pswpout (\d+)/m)![1]) };
  const sample = capacitySample({ at, intervalMs, occupants, uses: stableUses, seats, host,
    starting, held: holding.size, reservationMb: reserve.reservedMb(starting) });
  return sample;
}

// HQ hears the room and each job's share, and answers how much ready work only memory keeps from starting (room.ts):
// what the claims of the engines with a free slot and a seat to start on would take (memoryClaims).
async function reportRoom(watch: RoomWatch, jobs: SlotJob[], uses: Map<number, JobUse>, short: boolean, t: number, pressure: Pressure) {
  watch.reportedAt = t;
  watch.reporting = true;
  watch.memory = pressure.verdict;   // (a failed report's verdict goes with the next minute's)
  const shares = jobs.flatMap(j => {
    const use = uses.get(j.uid);
    return use ? [{ job: j.job.id, mb: Math.round(use.memoryMb), cores: use.cores }] : [];
  });
  try {
    const answer = await hq.api('room', { short, since: watch.shortSince, free: Math.round(freeMb(false)), jobs: shares, claims: memoryClaims(), capacity: plannerCapacity(shares, t), memory: pressure, gathering: gatheringRoom() }, AbortSignal.timeout(ROOM_REQUEST_MS));
    const meeting = answer?.meeting;
    const meetingRoom = meeting ? `Meeting room: ${meeting.state}, ${meeting.held}/${meeting.seats} held, ready ${meeting.ready}` : '';
    if (meetingRoom !== watch.meetingRoom) { if (meetingRoom) log(meetingRoom); watch.meetingRoom = meetingRoom; }
    watch.waiting = Number(answer?.waiting) || 0;
    watch.answeredAt = t;
  } catch (err) { log('room:', err); }
  finally { watch.reporting = false; }
}
function gatheringRoom() {
  const occupied = [...inSlot.keys()].filter(slot => slot !== CHAT_SLOT).length;
  return Math.max(0, Math.min(reserve.gathering(), WORK_SLOTS.length - occupied - holding.size));
}
function plannerCapacity(shares: { job: number; mb: number }[], at: number) {
  const starts = reserve.starts(),
    occupied = [...inSlot.keys()].filter(slot => slot !== CHAT_SLOT).length;
  const slots = Object.fromEntries(ENGINES.map(engine => [engine, WORK_SLOTS.length]));
  const room = Math.min(WORK_SLOTS.length - holding.size, occupied + starts);
  const measured = new Map(shares.map(share => [share.job, share.mb]));
  const runningMb = Object.fromEntries([...inSlot].filter(([slot]) => slot !== CHAT_SLOT)
    .map(([, occupant]) => [occupant.job.id, measured.get(occupant.job.id) ?? null]));
  const memory = { at, availableMb: reserve.availableMb(), freeReserveMb: FREE_MB, defaultRunMb: JOB_MB,
    totalSlots: WORK_SLOTS.length, heldSlots: holding.size, heldMb: holding.size * SEAT_MB,
    starting: reserve.startupReservations(), runningMb };
  return { slots, seatRuns: SEAT_RUNS, room, memory };
}
const memoryClaims = () => allSlotsTaken([...inSlot.keys()]) ? [] : ENGINES.flatMap(engine => {
  const seat = pickSeat(engine);
  return seat ? [claimOn(seat, engine)] : [];
});

// Which engine a free slot claims for: each in turn (roomturns.ts).
const turns = roomTurns();
const pct = (s: Seat) => s.util === undefined ? 'not measured yet' : `${Math.round(s.util * 100)}%`;
// What stands in the way of waiting work, for the coordinator's pause rule (jobs.ts makesRoom), the same in every run's
// heartbeat so the coordinator picks the same runs from each: short, every slot busy or memory short (not counting jobs
// just starting), which any run's pause frees, since the engines share both; capped, the ready seats at their run cap,
// which only a pause of a run on that seat frees.
const inTheWay = () => ({ short: allSlotsTaken([...running.keys()]) || !room(false),
  capped: SEATS.filter(s => s.state === 'ready' && !off(s) && !roomOn(s)).map(s => s.id) });
const allSlotsTaken = (slots: string[]) => slots.filter(slot => slot !== CHAT_SLOT).length >= WORK_SLOTS.length;
// stop: SIGTERM to its CLI; keep: its record as it stands, for a new worker to take it over (detached.ts).
// steady: its CLI runs and nothing is asked of it (no stop, no second launch), so a new worker process can take it over.
type Running = { job: number; seat: string; session?: string; spent: Spent; uid?: number; cli: Launched; steady: boolean; stop: () => void;
  keep: (look?: boolean) => void };
const running = new Map<string, Running>();

// The Codex items that end a step (a tool's result is in): where a yielding Codex run may stop.
const CODEX_STEPS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'collab_tool_call', 'web_search']);

const sleep = sleepOwned;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// Agents never share a uid with the token holder, or with each other, except in an explicit local test setup.
const ROOT = process.getuid!() === 0;
const DEV = process.env.WORKER_DEV_SAME_UID === '1';
const WORK = '/work';
const capacityTrial = capacityCapture(CAPACITY_SAMPLES, line => log(line), `${WORK}/capacity-${CAPACITY_JOB}`);
const idsOf = (slot: string): Ids => ROOT ? SLOT_IDS.get(slot)! : {};
const keeperIds: Ids = ROOT ? { uid: KEEPER, gid: KEEPER } : {};
const envFor = (set: Record<string, string | undefined>, keys?: Record<string, unknown>, seatVars?: string[]) =>
  agentEnv(process.env, { SHELL: '/bin/bash', ...set }, keys, seatVars);
// (names: another CLI's own variables in set, which pass as SET's do: safety.ts seatVars)
const keeperEnv = (set: Record<string, string> = {}, names?: string[]) => envFor({ ...(ROOT ? { HOME: '/home/worker', USER: 'worker' } : {}), ...set }, undefined, names);
const keeper = { ...keeperIds, env: keeperEnv() };
const as = (cmd: string, args: string[], input?: string) => runAs(keeper, cmd, args, input);
// A file of the keeper's written whole or not at all
const saveAs = (file: string, text: string) => as('sh', ['-c', 'umask 077 && cat > "$1.new" && mv -f "$1.new" "$1"', 'sh', file], text);
const flow = gitFlow({ mirror: `${WORK}/mirror.git`, remote: `https://github.com/${REPO}.git`, base: BASE, log,
  clones: () => readdirSync(`${WORK}/jobs`).map(n => `${WORK}/jobs/${n}`) });
// A run's report must arrive: a deploy restarts the coordinator for a few seconds, and a report lost then counts a
// finished run as failed (an intercom reply lost, its turn tried again). So one that can't reach it (fetch throws) is
// sent again for two minutes; a second report of a finished run changes nothing (jobs.ts finish). Whether a job holds a
// customer's details at its run's end is asked the same way (holdsCustomerData), and so is the mask (masked).
const finish = (body: Record<string, unknown>) => hq.report('finish', body);

// The job's own token for what it shows in HQ; team members speak `as` themselves (the coordinator checks the team).
const agentApi = (token: string, path: string, body: unknown) => ownershipSignal()?.aborted ? Promise.resolve() : fetch(`${HQ}/api/agent/${path}`, { method: 'POST',
  body: JSON.stringify(body), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, signal: ownershipSignal() }).catch(() => {});

// /work and its jobs/, homes/, asks/ and tests/ (a push's tests, testsCheckout) are root's, so agents can't swap the
// mirror or another job's folder; each job's folders are its slot's (slots.ts). /seats is the keeper's alone.
// The renders jobs pushed, by sha256 (renders.ts): the server puts them back in its checkout (infra/renders.py), and
// a job reads them here as HQ_RENDERS (shared/demo/renders.mjs fetch), so a fix round on a branch HQ hasn't merged
// takes the last round's renders instead of making them all again
const RENDERS = `${WORK}/renders`;
// The runs a stop cut off, until the next start hands them back (handback.ts): root's alone.
const HANDBACK = `${WORK}/handback.json`;
// Each run's output, record and marker (detached.ts): root's alone.
const RUNS = `${WORK}/runs`;
const STALE_FOLDER = 14 * 86400e3;
// taken: the runs the last worker process left running (takeOver), whose folders and slots stay as they are.
function takeVolumes(taken: Map<string, RunRecord>) {
  const busy = new Set([...taken.values()].map(r => String(r.job.id)));
  lchownSync(WORK, 0, 0); chmodSync(WORK, 0o755);
  lchownSync('/seats', KEEPER, KEEPER); chmodSync('/seats', 0o700);
  if (existsSync(VOICE_SEAT)) { lchownSync(VOICE_SEAT, KEEPER, KEEPER); chmodSync(VOICE_SEAT, 0o700); }
  rootDir(RENDERS, 0o755);
  for (const d of ['jobs', 'homes', 'asks', 'tests']) {   // (tests)
    const p = `${WORK}/${d}`;
    rootDir(p, 0o711);
    // Nothing runs yet but the runs taken over, so every other job's folders are waiting: root's until a slot takes the job. A folder whose job
    // hasn't run for two weeks (settle stamps it) belongs to a job that won't come back (failed for good, or
    // cancelled): it goes.
    for (const n of readdirSync(p)) {
      const q = `${p}/${n}`, st = lstatSync(q);
      if (busy.has(n)) continue;
      else if (Date.now() - st.mtimeMs > STALE_FOLDER) remove(q);
      else own([q], { uid: 0, gid: 0 });
    }
  }
  // A job's memory start outlives its run only if the run's end was never seen; like the job's folders, it goes after two
  // weeks. A copy that resumes after that has no start, so it's replaced and nothing from it goes back (copyback.ts handOut).
  try { as('sh', ['-c', 'cd "$1" && find . -mindepth 1 -maxdepth 1 -mtime +14 -exec rm -rf -- {} +', 'sh', MEMORY_START]); } catch {}
  // Deleted memory files wait in the trash for 30 days (a day's folder counts from the last file put in it), then go
  // for good: one deleted because it held a secret or a customer's details isn't kept forever.
  try { as('sh', ['-c', 'cd "$1" && find . -mindepth 1 -maxdepth 1 -mtime +30 -exec rm -rf -- {} +', 'sh', MEMORY_TRASH]); } catch {}
  for (const [slot, ids] of SLOT_IDS) if (!taken.has(slot)) { killAll(ids); sweep(ids); }
}

// The folders of jobs that have ended (done, failed, stopped or cancelled) go now, not after STALE_FOLDER: a 1.7 GB folder per
// failed review run, kept for two weeks, filled the disk on 2026-10-07. A chat job's home stays (its session goes on at
// the board's next message). Asked of the coordinator at the start and every hour; a folder whose job runs is never asked.
async function sweepEnded() {
  try {
    const busy = new Set([...running.values()].map(r => String(r.job)));
    const ids = [...new Set(['jobs', 'homes', 'tests'].flatMap(d => readdirSync(`${WORK}/${d}`)))].filter(n => /^\d+$/.test(n) && !busy.has(n));   // (tests)
    if (!ids.length) return;
    const ended = await hq.api('ended', { ids: ids.map(Number) }) as { id: number; kind: string }[];
    for (const { id, kind } of ended) {
      if ([...running.values()].some(r => r.job === id)) continue;   // (started since it was asked)
      remove(`${WORK}/jobs/${id}`);
      remove(`${WORK}/tests/${id}`);
      if (kind !== 'chat') remove(`${WORK}/homes/${id}`);
    }
    if (ended.length) log(`folders of ${ended.length} ended job(s) removed`);
  } catch (err) { log('sweeping ended jobs\' folders:', err); }
}

let mirrorReady = false, refreshing: Promise<void> | undefined;
function syncMirror() {
  if (!mirrorReady) flow.ensureMirror();
  mirrorReady = true;
  flow.fetchMirror();
}
// Between jobs too, every minute, so a running job's own `git fetch` sees what landed since it started (the server's
// status branch included). Never two fetches at once: a job's start waits for this one (runJobIn).
// The mirror's gc goes after each fetch, held in `refreshing` too, so no clone or merge starts while it repacks.
// A merge's asynchronous push can overlap the next refresh.
const gcMirror = () => flow.gcMirror().catch(err => log('mirror gc:', err));
function refreshLoop() {
  setInterval(() => {
    if (refreshing || !mirrorReady) return;
    refreshing = flow.refreshMirror().catch(err => log('mirror refresh:', err)).then(gcMirror).finally(() => { refreshing = undefined; });
    void refreshing.then(tellMain);
  }, 60_000);
}

// Main's line, told to HQ each time main moves (mainline.ts). Outside `refreshing`, so no job's start waits on HQ, and
// never two at once (a later line would move HQ past the pages left); each request is given up well before the next
// refresh: what HQ didn't hear is told again then.
const TELL_MAIN_MS = 10_000;
let toldMain: string | undefined, tellingMain = false;
async function tellMain() {
  if (tellingMain) return;
  tellingMain = true;
  const tell = async (told: ToldMain) =>
    await hq.api('main-moved', told, AbortSignal.timeout(TELL_MAIN_MS)) as { seen?: string };
  try { toldMain = await tellMainLine(flow, tell, toldMain); }
  catch (err) { log('main moved:', err); }
  finally { tellingMain = false; }
}

// Main merged into a passed pull request that GitHub calls conflicting, when the coordinator asks (git.ts mergeBase): after
// the mirror's fetch, as a job's start is. Its pushes end before the coordinator stops waiting, the time spent on the
// requests before it included (answerMainMerge).
async function mainMergeLoop() {
  while (!shuttingDown) {
    const askedAt = Date.now();
    const asked = await safe(() => hq.api('main-merges')) as { pr: number; branch: string; head: string; msLeft?: unknown; author: { name: string; email: string } }[] | undefined;
    for (const { pr, branch, head, msLeft, author } of asked ?? []) {
      const merged = await answerMainMerge(askedAt, msLeft, async by => {
        await refreshing;
        syncMirror();
        // (the identity a job's clone commits as when the company names none: company())
        return flow.mergeBase(branch, head, { name: 'Agents', email: 'agents@agents.invalid', ...author }, by);
      });
      log(`PR #${pr}: ${merged.sha ? `merged ${BASE} into ${branch} as ${merged.sha.slice(0, 7)}`
        : merged.conflicts ? `${BASE} conflicts with ${branch} in ${merged.conflicts.length} files` : `${BASE} not merged into ${branch}: ${merged.why}`}`);
      await hq.report('main-merged', { pr, head, ...merged }).catch(err => log(`PR #${pr}: main merge report:`, err));
    }
    await sleep(15_000);
  }
}

// Removed as root: GNU rm never follows a symlink inside the folder, and every folder above p is root's.
const remove = (p: string) => { if (lstatSync(p, { throwIfNoEntry: false })) execFileSync('rm', ['-rf', '--', p]); };
// A job's tests checkout once its checks have ended. Their verdicts are in by then, so a removal that fails (a process
// still writing in it: the run's end kills the slot's, runJob) never fails the job: the folder goes with the job's other
// folders once it has ended (sweepEnded).
const removeTested = (job: Job) => {
  try { remove(`${TESTED}/${job.id}`); } catch (err) { log(`job #${job.id}: its tests checkout is left for the ended jobs' sweep:`, err); }
};

// --- Seats and logins -------------------------------------------------------------------------

// /seats is the keeper's alone: seat credentials are created, read and replaced as uid 1500, never by a job.
const seatDir = (id: string) => { const d = `/seats/${id}`; if (!existsSync(d)) as('mkdir', ['-p', d]); return d; };

// Renamed seats' logins move before any sign-in (seatmoves.ts); a seat whose move failed or couldn't be told stays off the list
// until the next start.
const heldOff = new Set<string>();   // (HQ's list doesn't bring them back either: syncSeats)
function moveLogins() {
  const held = moveSeats(process.env.SEAT_MOVES ?? '', '/seats', { read: p => readAs(keeper, p), run: as, log });
  for (const id of held) heldOff.add(id);
  SEATS.splice(0, SEATS.length, ...SEATS.filter(s => !held.includes(s.id)));
  if (held.length) log(`Seats after the moves: ${SEATS.map(s => `${s.id} (${s.engine})`).join(', ')}`);
}

// The healthiest seat of an engine: not signed out, not sleeping or draining, least used (by the fuller of its 5-hour
// and weekly windows, as the coordinator decides downtime work: a seat with a spare day but a full week is the last pick).
// The intercom (the board's chat with the CEO, and call summaries) may also use a draining seat: the last 10% of one
// seat's window is kept for it (reserveElsewhere), so the board's conversation doesn't wait for a reset behind the team's jobs. So is the voice line
// (voiceSeat). The reserve holds because a Claude seat that drains also stops the jobs running on it, at their next step
// (drain): left running, a handful of jobs spend a seat's last 10% in minutes, and a call then finds nothing left.
// A slot claiming for Codex takes the Codex seats in turn instead (inTurn), each claiming only its own share of the work, and a seat at
// its cap of runs (roomOn) takes no more. A Claude seat whose last claim came back empty while paced (pacedEmpty) comes
// after the engine's other free seats, so work it holds back starts on one that isn't paced. It's still picked when it's
// the only one, for the work it does take.
function pickSeat(engine: string, not?: Seat, board = false) {
  wakeSeats();
  const free = SEATS.filter(s => roomOn(s) && !off(s));
  const pick = (seats: Seat[]) => engine === 'codex' ? inTurn(seats, lastClaimAt, not) : healthiest(seats, engine, board, not);
  return board || engine === 'codex' ? pick(free) : unpacedFirst(free, pacedEmpty, pacedOf, pick);
}
const pacedEmpty = new Set<Seat>();   // (slotLoop: claimAnswered)
// (back from a limit or a drain, its 5-hour window counts as reset; a Codex seat that reports only the week has none,
// and one never measured stays unmeasured, not 0%; a weekly figure with no known reset is dropped, so a Codex seat's next
// job measures it again.)
function wakeSeats() {
  const now = Date.now();
  for (const s of SEATS) if ((s.state === 'sleeping' || s.state === 'draining') && s.until <= now) {
    s.state = 'ready'; if (s.util !== undefined) { s.util = 0; s.fiveHourObservedAt = now; } if (!s.weekResets) s.week = undefined;
    s.measured = now; reportSeat(s);
  }
}

// Seat health from a Claude rate-limit event: the seat's windows as it reports them, then whether it drains.
function windows(seat: Seat, e: any) {
  const w = e.rate_limit_info?.unifiedWindows ?? {};
  if (w.five_hour?.utilization !== undefined) seat.fiveHourObservedAt = Date.now();
  if (w.seven_day?.utilization !== undefined) seat.weekObservedAt = Date.now();
  seat.util = w.five_hour?.utilization ?? seat.util;
  if (w.five_hour?.resetsAt) seat.resets = w.five_hour.resetsAt * 1000;
  seat.week = w.seven_day?.utilization ?? seat.week;
  if (w.seven_day?.resetsAt) seat.weekResets = w.seven_day.resetsAt * 1000;
  drain(seat);
}

// Stop giving a seat new work when either window is nearly used up, until that window resets (drainUntil), and take it
// back as soon as a reading shows room again (a reset, or a bigger plan). Claude's readings come from its rate-limit
// events, Codex's from its session log (codexWindow). A sleeping seat (it hit the limit) is left to its own wake-up.
function drain(seat: Seat) {
  const { until, pause: jobs } = drainOf(seat, SEATS.filter(s => !off(s)), running, CHAT_SLOT);
  if (until && (seat.state === 'ready' || seat.state === 'draining')) {
    // A Claude seat's running jobs stop at their next step and resume in their sessions on a seat with room, or after the
    // reset (runJobIn): the rest of the window is the board's (pickSeat). The intercom's own run goes on. A Codex seat's
    // stop the same way while it keepsToPlan (drainOf), so they don't run on into credits the board hasn't allowed.
    for (const id of jobs) if (!drained.has(id)) drained.set(id, Date.now());
    if (seat.state === 'ready') {
      log(`${seat.id}: draining at ${seatNote(seat)}, until ${new Date(until).toISOString()}${jobs.length ? `; jobs ${jobs.map(j => `#${j}`).join(', ')} pause at their next step` : ''}`);
      seat.checked = Date.now();
    }
    seat.state = 'draining'; seat.until = until;
  } else if (!until && seat.state === 'draining') {
    seat.state = 'ready'; seat.until = 0;
    for (const r of running.values()) if (r.seat === seat.id) drained.delete(r.job);   // (room again: they carry on)
  }
  reportSeat(seat);
}

// A held Codex seat's hourly job (checkDue says when); marked as it's picked, so only one slot takes it (nextClaim).
const checkSeat = (engine: string) => SEATS.find(s => s.engine === engine && roomOn(s) && !off(s) && checkDue(s));

// A draining or sleeping Claude seat is re-checked every 10 minutes with a one-line call, so a plan
// upgrade (or an early reset) puts it back to work without waiting for the old reset time. A ready seat whose window
// isn't measured yet (after a restart, before any job has run on it) is checked the same way, for downtime work. A held
// Codex seat that keepsToPlan has its account read on the hour (readLimits).
async function recheckLoop() {
  const checked = new Map<string, number>();
  while (!shuttingDown) {
    await sleep(60_000);
    for (const seat of SEATS.filter(s => cliOf(s) === 'claude' && s.signIn === 'login' && ((s.state === 'draining' || s.state === 'sleeping') && s.until > Date.now()
      || s.state === 'ready' && windowUsed(s) === undefined))) {
      if (Date.now() - (checked.get(seat.id) ?? 0) < 10 * 60_000) continue;
      checked.set(seat.id, Date.now());
      const token = readAs(keeper, `${seatDir(seat.id)}/token`)?.trim();
      if (!token) continue;
      const r = await oneLine(seat, token, ['--model', 'haiku', '--output-format', 'stream-json', '--verbose']);
      const out = r.code === 0 ? r.out : '';
      const events = out.split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
      const result = events.find(e => e.type === 'result');
      if (!result || result.is_error) {   // still limited; a ready seat says why it stays unmeasured
        if (seat.state === 'ready') log(`${seat.id}: recheck failed (exit ${r.code}): ${redact(String(result?.result ?? r.err)).trim().slice(-200) || 'no result'}`);
        continue;
      }
      if (seat.state === 'sleeping') { seat.state = 'ready'; seat.until = 0; }
      const rl = events.findLast(e => e.type === 'rate_limit_event');
      rl ? windows(seat, rl) : reportSeat(seat);
      log(`${seat.id}: rechecked, now ${seat.state} at ${pct(seat)}`);
    }
    for (const seat of SEATS.filter(s => readDue(s))) await readLimits(seat);
  }
}

// A live meeting's bubbles (the coordinator's meetinggist.ts): the new lines of its transcript put in a few plain words by
// the same small model, one call at a time. The room shows the latest point, so the loop asks again soon after each
// answer: GIST_POLL_MS is how late a bubble may come after its line, beside the call's own time.
const GIST_POLL_MS = 5_000;
async function gistLoop() {
  while (!shuttingDown) {
    await sleep(GIST_POLL_MS);
    try { const call = await claimSmallCall('gists', ['lines']); if (call) await call.answered; }
    catch (err) { log('meeting bubbles:', err); }
  }
}

// The names the board reads (the coordinator's plainnames.ts): each new or changed name put in plain words by the same
// small model, a thread's or a project's at a time. The board reads the agent's words until then, so the loop looks
// often: up to NAMES_PER_TURN calls every NAMES_POLL_MS while names are due.
const NAMES_POLL_MS = 15_000, NAMES_PER_TURN = 3;
async function namesLoop() {
  while (!shuttingDown) {
    await sleep(NAMES_POLL_MS);
    try {
      for (let i = 0; i < NAMES_PER_TURN; i++) {
        const call = await claimSmallCall('names', ['names']);
        if (!call) break;
        await call.answered;
      }
    }
    catch (err) { log('board names:', err); }
  }
}

// The board's handwriting read into type (the coordinator's handwriting.ts) and the book's judge (bookjudge.ts): the
// board waits for the words as it writes, and for the answer a verdict starts, so the loop asks often and makes its calls
// as they come, READS_AT_ONCE at most (smallturns.ts).
const READ_POLL_MS = 1_000, READS_AT_ONCE = 3;
function readLoop() {
  return callsAsTheyCome({ claim: () => claimSmallCall('reads', ['reading']), atOnce: READS_AT_ONCE,
    idleMs: READ_POLL_MS, going: () => !shuttingDown, sleep,
    failed: err => log("handwriting and the book's judge:", err) });
}

// One call of the coordinator's small model (smallmodel.ts), claimed from HQ's `${kind}/claim` and answered to
// `${kind}/answer` with the claim's own `keys`: on the healthiest ready Claude seat, one short call with no tools (the
// prompt holds outside input) and the prompt on stdin: words, or a message's content (a picture with them) as the CLI's
// stream-json. Its spend counts on the seat, and its rate-limit reading updates the seat's windows as a run's does.
// The call claimed, going until it's answered; false when there was none to make.
type SmallKind = 'gists' | 'names' | 'reads';
async function claimSmallCall(kind: SmallKind, keys: string[]) {
  wakeSeats();
  const seat = healthiest(SEATS.filter(s => cliOf(s) === 'claude' && s.signIn === 'login' && !off(s)), 'claude');
  if (!seat) return false;
  const next = await hq.api(`${kind}/claim`);
  if (!next?.prompt && !next?.content) return false;   // (nothing due: an empty claim)
  return { answered: makeSmallCall(kind, keys, seat, next) };
}
async function makeSmallCall(kind: SmallKind, keys: string[], seat: Seat, next: Awaited<ReturnType<typeof hq.api>>) {
  const claimed = Object.fromEntries(keys.map(k => [k, next[k]]));
  // (the token read once there's a call to make: reads asks every few seconds.)
  const token = readAs(keeper, `${seatDir(seat.id)}/token`)?.trim();
  if (!token) {
    await hq.api(`${kind}/answer`, { ...claimed, error: `${seat.id} has no sign-in to call with` });
    return;
  }
  // (thinking off: the CLI gives Haiku a 31,999-token thinking budget by default, which can outrun oneLine's 90 s
  // kill.)
  // (content: one user message on stdin.)
  const content = next.content ? ['--input-format', 'stream-json'] : [];
  const args = ['--model', next.model, '--tools', '', '--strict-mcp-config', '--no-session-persistence',
    '--settings', '{"alwaysThinkingEnabled":false}', ...content,
    '--output-format', 'stream-json', '--verbose', '--json-schema', next.schema];
  const prompt = next.content ? `${JSON.stringify({ type: 'user', message: { role: 'user', content: next.content } })}\n` : next.prompt;
  const r = await oneLine(seat, token, args, prompt);
  const events = r.out.split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
  const rl = events.findLast(e => e.type === 'rate_limit_event');
  if (rl) windows(seat, rl);
  const result = events.find(e => e.type === 'result');
  const error = result ? undefined : redact(unkey(plain(r.err), token)).trim().slice(-300) || `exit ${r.code}`;
  await hq.api(`${kind}/answer`, { ...claimed, ...(result ? { result } : { error }) });
}

const seatNote = (s: Seat) => (s.util !== undefined ? `${pct(s)} of the 5-hour window`
  : s.week === undefined ? '5-hour window not measured yet' : 'no 5-hour window') +
  (s.week === undefined ? '' : `, ${Math.round(s.week * 100)}% of the week`) +   // a full week drains a seat too
  (s.credits ? `, ${creditsNote(s)}` : '');
// (each seat's pacing as last reported, whether paced and on credits: keepSeats reports a change)
const reportedPace = new Map<string, string>();
const paceKey = (s: Seat) => `${pacedOf(s)}:${!!s.credits}`;
const reported = new Map<string, SeatState>();   // (each seat's state as last reported, for the voice line's)
// Pacing (pace.ts pacedUntil): on unless the board turned it off in HQ's Settings › Seats (keepSeats). A paced seat
// says so to HQ, which draws it, and its claims carry its weekly reset. HQ's play uses the switch and the seats'
// windows for its pacing level (the coordinator's playseats.ts). Each seat also reports whether it runs on credits.
let pacing = true;
const paceToOf = (s: Seat) => paceTo(s, pacing, reserveFor(s, SEATS));
const pacedOf = (s: Seat) => pacedUntil(s, paceToOf(s));
// (a held Codex seat reports its next check as `until`, and the hold's own end in its note: reportedUntil)
// The windows go as numbers (HQ draws them as bars, the status report prints them), the note says the rest.
function reportSeat(s: Seat) {
  if (s.gone) return;   // (a removed seat's last run ending mustn't bring its row back)
  // Nor one whose sign-in isn't read yet: a run taken over after a reload reports its seat before HQ's list starts the
  // seat's loginLoop, and its 'login' would put a "needs signing in again" card on the desk phone. The loop's first
  // look reports everything.
  if (!s.signInRead) return;
  const until = reportedUntil(s), held = until !== s.until ? `held until ${new Date(s.until).toISOString()}, ${!keepsToPlan(s) ? 'one job an hour' : s.readFailed ? 'account read failed, read again in an hour' : 'its account read an hour'}` : '';
  const paced = pacedOf(s), pace = paced === undefined ? undefined : true;
  reportedPace.set(s.id, paceKey(s));
  const rest = [s.util === undefined && s.week === undefined ? '5-hour window not measured yet' : '', s.credits ? creditsNote(s) : s.hasCredits ? 'keeps to its plan: its credits wait for the board' : '', held];
  const note = s.paused ? 'Paused: it takes no new work'
    : s.state === 'login' ? s.signIn === 'key' ? 'Needs a key' : 'Needs signing in'
    : s.state === 'closed' ? `closed by its provider (${s.closed ?? 'no reason given'}): its share of the work waits, and no other account takes it over until the board decides`
    : s.state === 'sleeping' && s.refused ? [`its runs are refused: ${s.refused}`, held].filter(Boolean).join('; ') : rest.filter(Boolean).join('; ');
  const windows = { util: s.util, resets: s.util === undefined ? undefined : s.resets || undefined, week: s.week, weekResets: s.week === undefined ? undefined : s.weekResets || undefined, pace, credits: s.credits || undefined,
    fiveHourObservedAt: s.fiveHourObservedAt ?? null, weekObservedAt: s.weekObservedAt ?? null };
  hq.api('seat', { seat: s.id, engine: s.engine, state: off(s) ? 'paused' : s.state, until: until || undefined, note, ...windows }).catch(() => {});
  // a Claude seat that changed state may change the voice line's: at once, not at the next minute (voiceLoop). (Only on a
  // change: a reading comes with every model request of every job.)
  if (cliOf(s) === 'claude' && reported.get(s.id) !== s.state) {
    reported.set(s.id, s.state);
    try { voiceSeat(); } catch (err) { log('voice seat:', err); }
  }
}

// A Codex seat's windows, from the run's session log: Codex's --json output doesn't carry them, but the log's
// token_count entries do (codexReading says which count), and they drain the seat as Claude's do. It runs from a timer
// and the agent can write the log, so nothing in it may throw or block (codexLogLine): a reading that can't be read is
// skipped. It returns the tokens the session has written so far, when the line says (codexTokens).
async function codexWindow(seat: Seat, me: Me, home: string, session: string | undefined, since: number) {
  if (!session) return;
  try {
    const line = await codexLogLine(me, `${home}/.codex/sessions`, session);
    if (!line) return;   // no log, or no figures in it yet
    const r = codexReading(line, since, seat.measured);
    if (!r) return;
    takeReading(seat, r, false);
    drain(seat);
    return codexTokens(line);
  } catch (err) { log(`${seat.id}: unreadable Codex window reading:`, err); }
}

// A held Codex seat that keepsToPlan, on the hour (readDue): its account read by the worker (codexLimits), whose reading
// keeps its hold or lifts it (takeRead).
async function readLimits(seat: Seat) {
  seat.checked = Date.now();
  // (its app server may refresh the seat's sign-in: through the worker, like a run's)
  const signIn = readAs(keeper, `${seatDir(seat.id)}/auth.json`), holder = `limits ${seat.id}`;
  const vars = { CODEX_HOME: seatDir(seat.id), ...refreshVars(signIn && refreshes.handOut(holder, seat.id, signIn)) };
  const answer = await codexLimits({ ...keeperIds, env: keeperEnv(vars, Object.keys(vars)) }).finally(() => refreshes.end(holder));
  const r = limitsReading(answer);
  if (seat.gone) return;
  takeRead(seat, r);
  log(`${seat.id}: account read ${r ? `at ${seatNote(seat)}` : 'failed: held, no job through, read again in an hour'}`);
  drain(seat);
}

const loggedIn = (seat: Seat) => existsSync(`${seatDir(seat.id)}/${credentialFile(seat)}`);

// The board may paste the code, or (when the callback page stays blank) the whole address: take code and state from it.
function claudeCode(answer: string) {
  const a = answer.trim();
  try { const u = new URL(a); const code = u.searchParams.get('code'); if (code) return `${code}#${u.searchParams.get('state') ?? ''}`; } catch {}
  return a;
}

// Strip every terminal control sequence (CSI incl. private modes like ESC[>4m, OSC links, charset
// switches, keypad modes) so text drawn by terminal UIs can be read.
const plain = (s: string) => s
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
  .replace(/\x1b[()*+][\x20-\x7e]|\x1b[\x20-\x7e]/g, '')
  .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

// Possible readings of the token Claude prints after sign-in (terminal UIs draw it in pieces, so one
// reading may be cut short). Each candidate is verified with a real call before it is stored.
const TOKEN = /sk-ant-[a-z]{2,4}\d{2}-[A-Za-z0-9_-]{40,}/g;
const tokenCandidates = (raw: string) =>
  [...new Set([plain(raw.replace(/\x1b\[\d*C/g, ' ')), plain(raw), raw].flatMap(t => t.match(TOKEN) ?? [])
    // the CLI only accepts sk-ant-oat01-…; a terminal redraw can swallow the "o", so try both spellings
    .flatMap(t => [t.replace(/^sk-ant-o?at(\d{2})-/, 'sk-ant-oat$1-'), t]))]
    .sort((a, b) => b.length - a.length);

// A one-line call with a seat's token, as the keeper, in a fresh config dir (so no settings planted in /tmp apply):
// checks a new token, and rechecks a limited seat. With a prompt (makeSmallCall's), that goes on stdin, never in argv, and
// the call runs in the empty config dir, so no project's files are read with it.
function oneLine(seat: SeatProvider, token: string, args: string[], prompt?: string) {
  return new Promise<{ code: number; out: string; err: string }>(resolve => {
    const config = as('mktemp', ['-d']).trim();
    const env = keeperEnv({ ...claudeEnv(seat), CLAUDE_CONFIG_DIR: config });   // (the sign-in on its pipe: SIGN_IN)
    const asked = prompt === undefined ? ['Reply with just: ok'] : [];
    const c = spawn('claude', ['-p', ...asked, ...args], { env, ...keeperIds, cwd: config, stdio: [prompt === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe', 'pipe'] });
    SIGN_IN.hand(c, token);
    if (prompt !== undefined) { c.stdin!.on('error', () => {}); c.stdin!.end(prompt); }   // (a call that died early: its close says so)
    let out = '', err = '';
    c.stdout!.on('data', d => { out += d; }); c.stderr!.on('data', d => { err += d; });
    const t = setTimeout(() => c.kill(), 90_000);
    c.on('close', code => {
      clearTimeout(t);
      try { as('rm', ['-rf', config]); } catch {}
      resolve({ code: code ?? 1, out, err });
    });
  });
}

// A service may print the key back in its refusal, in a shape redact() doesn't know: the key itself is masked.
const unkey = (text: string, key: string) => text.split(key).join('[redacted]');

async function tokenWorks(seat: SeatProvider, token: string) {
  const model = modelFor(seat, undefined);
  const { code, out, err } = await oneLine(seat, token, ['--output-format', 'json', ...(model ? ['--model', model] : [])]);
  let ok = false, why = err;
  try { const r = JSON.parse(out); ok = code === 0 && !r.is_error; why = r.result ?? err; } catch {}
  return { ok, why: redact(unkey(plain(String(why)), token)).trim().slice(-200) };
}

// The voice line (platform/voice, its own container) signs in with a copy of the healthiest Claude seat's token,
// in a volume of its own that the keeper fills: the voice container never sees /seats (every seat, Codex's too,
// and every session). It reads the copy as uid 1500 as well; no slot can reach the folder (0700).
// A call is the last thing to go: the seat with the most room, a draining one too (the board's reserve, as the
// intercom's), and with none, the first to wake (lineSeat), never simply the first on the list, which may be asleep at its
// limit while another still has its reserve. The line says so itself when its seat can't answer, and starts its call
// agent again on the new token (server.py).
const VOICE_SEAT = '/voice-seat';
let voiceToken: string | undefined, voicePicking = false;
function voiceSeat() {
  if (!existsSync(VOICE_SEAT) || voicePicking) return;
  voicePicking = true;   // (waking a seat reports it, and the report comes back here)
  let seat: Seat | undefined;
  try { wakeSeats(); seat = lineSeat(SEATS.filter(s => cliOf(s) === 'claude' && s.signIn === 'login' && !off(s))); } finally { voicePicking = false; }
  const token = seat && readAs(keeper, `${seatDir(seat.id)}/token`)?.trim();
  if (token === voiceToken) return;
  if (seat) log(`voice line: on ${seat.id} now (${seat.state})`);
  if (token) saveAs(`${VOICE_SEAT}/token`, token);
  else as('rm', ['-f', `${VOICE_SEAT}/token`]);   // signed out everywhere: a dead token only makes calls fail later
  voiceToken = token || undefined;
}
async function voiceLoop() {
  while (!shuttingDown) {
    try { voiceSeat(); } catch (err) { log('voice seat:', err); }
    await sleep(60_000);
  }
}

// A coordinator restart must not abort a sign-in in progress (that would invalidate the board's link).
async function safe<T>(f: () => Promise<T>) { try { return await f(); } catch { return undefined; } }

// --- The board's changes from HQ's Seats -------------------------------------------------------

// A sign-in the board started on the seat's row in Seats. The sign-in tool runs as the keeper, and its page (and Codex's
// code to type there) shows on the row. Claude's tool wants the code the page shows back: the board pastes it on the
// row, and the token it gives is tried in a test call before it's kept. Codex's tool sees the sign-in by itself. The
// row shows how it ended, with what the tool said. A newer sign-in of the seat, or its removal, stops this one.
const signing = new Map<string, () => void>();
const SIGNIN_MS = 30 * 60_000, CODE_TAKEN_MS = 90_000;
async function signIn(seat: Seat, action?: number) {
  signing.get(seat.id)?.();
  const cli = cliOf(seat), other = CLIS[cli];
  const asks = other ? other.signIn?.asks ?? 'nothing' : cli === 'claude' ? 'code' : 'nothing';
  const report = (b: Record<string, unknown>) => safe(() => hq.api('signin', { seat: seat.id, asks, ...b }));
  // the old sign-in goes (a plan changed, a token stopped working), and a closed account is tried again
  as('rm', ['-f', ...signInFiles(seat), `${seatDir(seat.id)}/closed`]);
  Object.assign(seat, { state: 'login', closed: undefined, until: 0, limits: 0 });
  reportSeat(seat);
  await report({ status: 'starting' });
  // A wide terminal, so long tokens and links aren't wrapped across lines.
  const tool = other ? [other.bin, ...other.signIn?.args ?? []].map(shellWord).join(' ') : cli === 'codex' ? 'codex login --device-auth' : 'claude setup-token';
  const cmd = `stty cols 500 rows 50 2>/dev/null; ${tool}`;
  // Claude signs in with a fresh config dir: nothing left in the old shared one (hooks, settings) applies. Another CLI
  // signs in with the seat's folder as its home, where it leaves its sign-in.
  const config = cli === 'claude' ? as('mktemp', ['-d']).trim() : '';
  const seatVars = other && { ...other.home(seatDir(seat.id)), ...other.signIn?.env };
  const vars: Record<string, string> = seatVars ? { HOME: seatDir(seat.id), ...seatVars }
    : cli === 'codex' ? { CODEX_HOME: seatDir(seat.id) } : { CLAUDE_CONFIG_DIR: config };
  const child = spawn('script', ['-qfc', cmd, '/dev/null'], { env: keeperEnv(vars, seatVars && Object.keys(seatVars)), ...keeperIds });
  let out = '', url: string | undefined, code: string | undefined, pastedAt = 0, why = '', stopped = false;
  const stop = () => { stopped = true; child.kill(); };
  signing.set(seat.id, stop);
  child.stdout!.on('data', d => { out += d; });
  const typed = other?.signIn?.typed;
  if (typed) setTimeout(() => { if (child.exitCode === null) child.stdin!.write(typed); }, 3000);
  const deadline = Date.now() + SIGNIN_MS;
  while (child.exitCode === null && !stopped && !seat.gone && Date.now() < deadline) {
    await sleep(2000);
    const text = plain(out);
    // eslint-disable-next-line no-control-regex -- a link ends where the terminal's next control sequence starts
    url ??= (cli === 'claude' ? out : text).match(/https:\/\/[^\s\x07\x1b]+/)?.[0];
    if (!url) continue;
    code ??= cli === 'codex' ? text.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/)?.[0] : other?.signIn?.code ? text.match(other.signIn.code)?.[0] : undefined;
    // (another CLI's tool may stay open once it's signed in: its sign-in file says it is)
    if (other && loggedIn(seat)) { child.kill(); break; }
    if (cli === 'claude' || (other && asks === 'code')) {
      const candidates = cli === 'claude' && /Store this token|Storethistoken/.test(text) ? tokenCandidates(out) : [];
      if (candidates.length) { child.kill(); why = await keepToken(seat, candidates); break; }
      if (pastedAt && Date.now() - pastedAt > CODE_TAKEN_MS) { why = `The sign-in tool didn't take the code. It said: "${lastLines(out)}"`; break; }
    }
    const answer = await report({ status: pastedAt ? 'checking' : 'open', url, code });
    if (answer?.stop) stopped = true;
    else if (asks === 'code' && answer?.code && !pastedAt) {
      child.stdin!.write(cli === 'claude' ? claudeCode(String(answer.code)) : String(answer.code).trim());   // paste, then Enter separately
      await sleep(800);
      child.stdin!.write('\r');
      pastedAt = Date.now();
    }
  }
  child.kill();
  if (config) try { as('rm', ['-rf', config]); } catch {}
  if (signing.get(seat.id) === stop) signing.delete(seat.id);
  if (stopped || seat.gone) {
    if (action) await settleChange(action, 'failed', seat.gone ? 'The seat was removed.' : 'A newer sign-in took its place.');
    return;
  }
  // (another CLI's sign-in is kept once a test run with it works)
  const tried = other && loggedIn(seat) ? await cliWorks(seat) : undefined;
  if (tried && !tried.ok) as('rm', ['-f', ...signInFiles(seat)]);
  if (tried && !tried.ok) why = `It signed in, but a test run with it failed: ${tried.why || 'no reason given'}`;
  const done = loggedIn(seat);
  const words = done ? cli === 'claude' || other ? 'Signed in: a test call with it worked.' : 'Signed in.'
    : why || (Date.now() >= deadline ? 'The sign-in wasn\'t finished within 30 minutes. Tap Try again for a new page.'
      : `The sign-in didn't finish. The sign-in tool said: "${lastLines(out)}"`);
  log(`${seat.id}: sign-in ${done ? 'done' : `failed: ${words}`}`);
  if (done && seat.state === 'login') { seat.state = 'ready'; reportSeat(seat); }
  await report({ status: done ? 'done' : 'failed', words });
  if (action) await settleChange(action, done ? 'done' : 'failed', words);
}
// A word as the shell reads it back whole
const shellWord = (word: string) => `'${word.replace(/'/g, "'\\''")}'`;
// What a tool said last, for the board: its last three lines, keys masked
const lastLines = (out: string) => redact(plain(out)).split('\n').map(l => l.trim()).filter(Boolean).slice(-3).join(' ').slice(0, 300);

// The token Claude's sign-in printed, kept once a test call with it works: '' then, else why not.
async function keepToken(seat: Seat, candidates: string[]) {
  let why = '';
  for (const token of candidates) {
    const r = await tokenWorks(seat, token);
    if (seat.gone) return 'The seat was removed.';
    if (r.ok) { as('sh', ['-c', 'umask 077 && cat > "$1"', 'sh', `${seatDir(seat.id)}/token`], token); return ''; }
    why = r.why;
  }
  return `Claude gave a token, but it didn't work in a test call: ${why}`;
}

// A key the board gave on the seat's row, tried with a one-line call before it's kept: a key that doesn't work changes
// nothing, and the row says why.
async function takeKey(seat: Seat) {
  const { key } = (await safe(() => hq.api('seat-key', { seat: seat.id }))) ?? {};
  if (typeof key !== 'string' || !key) return { ok: false, words: 'The key didn\'t reach the worker (HQ restarted in between). Paste it again.' };
  const cli = cliOf(seat);
  const r = CLIS[cli] ? await otherKey(seat, key) : cli === 'codex' ? await codexKey(seat, key) : await tokenWorks(seat, key);
  if (seat.gone) return { ok: false, words: 'The seat is off the worker\'s list, so the key was not kept.' };   // (it left the list while the test call ran)
  if (!r.ok) return { ok: false, words: `The key didn't work in a test call, so nothing changed: ${r.why || 'no reason given'}` };
  if (cli === 'claude') saveAs(`${seatDir(seat.id)}/key`, key);
  if (seat.state === 'login') { seat.state = 'ready'; reportSeat(seat); }
  log(`${seat.id}: a new key, tried and kept`);
  return { ok: true, words: 'The key works: a test call went through.' };
}

// A Codex key: signed in in a home of its own, tried with a one-line run there, and its auth.json then becomes the seat's.
async function codexKey(seat: Seat, key: string) {
  const home = as('mktemp', ['-d']).trim();
  try {
    as('sh', ['-c', 'CODEX_HOME="$1" codex login --with-api-key >/dev/null', 'sh', home], key);
    const model = modelFor(seat, undefined);
    const args = codexArgs(seat, ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', ...(model ? ['-m', model] : []), 'Reply with just: ok']);
    const r = await keeperRun('codex', args, { CODEX_HOME: home }, home);
    const failed = r.out.split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } })
      .find(e => e.type === 'error' || e.type === 'turn.failed');
    if (r.code !== 0 || failed) return { ok: false, why: redact(unkey(String(failed?.message ?? failed?.error?.message ?? lastLines(unkey(r.err || r.out, key))), key)).slice(0, 200) };
    if (seat.gone) return { ok: false, why: 'The seat was removed.' };
    as('sh', ['-c', 'umask 077 && cat "$1/auth.json" > "$2.new" && mv -f "$2.new" "$2"', 'sh', home, `${seatDir(seat.id)}/auth.json`]);
    return { ok: true, why: '' };
  } finally { try { as('rm', ['-rf', home]); } catch (err) { log(`${seat.id}: couldn't remove the key's test home:`, err); } }
}

// Another CLI's key: its files (clis.ts key) made in a home of their own, tried with a one-line run there, then the seat's.
async function otherKey(seat: Seat, key: string) {
  const other = CLIS[cliOf(seat)]!, home = as('mktemp', ['-d']).trim();
  try {
    if (!other.key) return { ok: false, why: `${other.name} signs in with its account, not a key.` };
    const files = Object.entries(other.key(key));
    for (const [f, text] of files) as('sh', ['-c', 'umask 077 && mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', `${home}/${f}`], text);
    const r = await cliWorks(seat, home);
    if (!r.ok) return { ok: false, why: unkey(r.why, key) };
    if (seat.gone) return { ok: false, why: 'The seat was removed.' };
    for (const [f] of files)
      as('sh', ['-c', 'umask 077 && mkdir -p "$(dirname "$2")" && cat "$1" > "$2.new" && mv -f "$2.new" "$2"', 'sh', `${home}/${f}`, `${seatDir(seat.id)}/${f}`]);
    return { ok: true, why: '' };
  } finally { try { as('rm', ['-rf', home]); } catch (err) { log(`${seat.id}: couldn't remove the key's test home:`, err); } }
}

// A one-line run of another CLI with the sign-in in home (the seat's folder, or a key's test home), as the keeper, in an
// empty folder: its read-only ask, so the reply is all it can do. ok once its stream ends without an error.
async function cliWorks(seat: Seat, home = seatDir(seat.id)) {
  const other = CLIS[cliOf(seat)]!, cwd = as('mktemp', ['-d']).trim(), model = modelFor(seat, undefined);
  try {
    const own = { ...other.home(home), ...other.env?.({ model }) };
    const r = await keeperRun(other.bin, other.ask({ home, model }), { HOME: home, ...own }, cwd, other.input?.('Reply with just: ok') ?? 'Reply with just: ok', Object.keys(own));
    const state: Record<string, unknown> = {}, read = (line: string) => { const e = jsonOf(line); return e === undefined ? [] : other.events(e, state); };
    const events: any[] = r.out.split('\n').flatMap(read);
    const ended = other.export ? readAs(keeper, `${home}/${other.export}`) : undefined;
    if (other.export) as('rm', ['-f', `${home}/${other.export}`]);
    state.exitCode = r.code;
    if (ended !== undefined) events.push(...read(ended.replace(/\n/g, ' ')));
    const result = events.findLast(e => e.type === 'result');
    const ok = r.code === 0 && !!result && !result.is_error;
    const said = result?.result ?? ((result?.errors ?? []).join(' ') || lastLines(r.err || r.out));
    return { ok, why: ok ? '' : redact(plain(String(said))).trim().slice(0, 200) };
  } finally { try { as('rm', ['-rf', cwd]); } catch (err) { log(`${seat.id}: couldn't remove the test run's folder:`, err); } }
}
const jsonOf = (line: string) => { try { return JSON.parse(line); } catch { return undefined; } };

// A command as the keeper, in its own cwd, ended after 90 seconds
function keeperRun(cmd: string, args: string[], vars: Record<string, string>, cwd: string, input?: string, names?: string[]) {
  return new Promise<{ code: number; out: string; err: string }>(resolve => {
    const c = spawn(cmd, args, { env: keeperEnv(vars, names), ...keeperIds, cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (input !== undefined) { c.stdin!.on('error', () => {}); c.stdin!.end(input); }
    let out = '', err = '';
    c.stdout!.on('data', d => { out += d; }); c.stderr!.on('data', d => { err += d; });
    const t = setTimeout(() => c.kill(), 90_000);
    c.on('close', code => { clearTimeout(t); resolve({ code: code ?? 1, out, err }); });
  });
}

// HQ's list, taken by the worker's seats (seatlist.ts), and kept for the worker's next start (SEAT_LIST)
// A seat whose stop level the board changed, or whether it spends credits, drains, or goes back to work, by its windows at
// once (drain).
function syncSeats(list: Listed[]) {
  const levels = new Map(SEATS.map(s => [s, `${s.drainAt}:${!!s.credits}`]));
  applyList(SEATS, list, { held: heldOff, make: newListed, start: loginLoop, drop: dropSeat,
    changed: seat => { log(`${seat.id}: ${off(seat) ? 'takes no new work now' : 'takes work again'}`); reportSeat(seat); } });
  for (const [seat, was] of levels) if (!seat.gone && `${seat.drainAt}:${!!seat.credits}` !== was && (seat.state === 'ready' || seat.state === 'draining')) {
    log(`${seat.id}: ${seat.credits ? 'may spend credits past its limits' : `stops at ${seat.drainAt === undefined ? 'its level' : `${Math.round(seat.drainAt * 100)}%`}`} now`);
    drain(seat);
  }
  // (a seat not read since this process started is paced by the week HQ last heard)
  for (const l of list) {
    const seat = SEATS.find(s => s.id === l.id);
    if (seat && seat.week === undefined && l.week !== undefined && l.weekResets && l.weekResets > Date.now())
      Object.assign(seat, { week: l.week, weekResets: l.weekResets });
  }
  const kept = JSON.stringify(list.map(l => ({ id: l.id, engine: l.engine, cli: l.cli })));
  if (kept !== keptList) { saveAs(SEAT_LIST, kept); keptList = kept; }
}
let keptList = '';
// (a seat its provider closed before stays closed: close)
function newListed(id: string, engine: string) {
  const seat = newSeat(id, engine), closed = readAs(keeper, `${seatDir(id)}/closed`);
  if (closed !== undefined) Object.assign(seat, { state: 'closed', closed: closed.trim() });
  log(`${id}: on the list`);
  return seat;
}

// A seat off HQ's list takes no new work. Its sign-in is deleted only by the board's Remove (forgetSignIn), never because
// a list came without it.
function dropSeat(seat: Seat) {
  seat.gone = true;
  signing.get(seat.id)?.();
  SEATS.splice(SEATS.indexOf(seat), 1);
  log(`${seat.id}: off the list`);
}
const forgetSignIn = (id: string) => as('rm', ['-f', ...['token', 'key', 'auth.json', 'closed', ...OTHER_SIGN_INS].map(f => `${seatDir(id)}/${f}`)]);
const OTHER_SIGN_INS = Object.values(CLIS).flatMap(c => c.credentials);
// The files that hold a seat's sign-in in its folder
const signInFiles = (seat: Seat) => [credentialFile(seat), ...(CLIS[cliOf(seat)]?.credentials ?? [])].map(f => `${seatDir(seat.id)}/${f}`);

// The board's changes the worker hasn't taken up: each is carried out once (seatlist.ts carryOut), and HQ hears how it went.
const taken = new Set<number>();
// A change's last word is sent again until HQ answers (hq.report), or the board's row would wait forever.
const settleChange = (id: number, status: 'working' | 'done' | 'failed', words?: string) =>
  safe(() => status === 'working' ? hq.api('seat-action', { id, status, words }) : hq.report('seat-action', { id, status, words }));
const doers = { runsOn: (id: string) => [...running.values()].filter(r => r.seat === id).length, signIn, takeKey, drop: dropSeat,
  forget: forgetSignIn, settle: settleChange, pacing: () => pacing };

// A seat whose account its provider closed (outcome.ts 'closed', OpenAI's "account has been deactivated"): its sign-in
// goes (it can't work again) and a `closed` file in its folder says when and what it was told, so a restart keeps it
// closed. It asks for no sign-in, and its share of the work waits for it (the coordinator's codexShare: a normal review
// round goes on without Codex meanwhile) until the board decides: Sign in again on its row in HQ's seats, or the seat off
// SEATS.
function close(seat: Seat, words: string) {
  seat.closed = `${new Date().toISOString().slice(0, 10)}: ${words}`;
  as('sh', ['-c', 'umask 077 && cat > "$1"', 'sh', `${seatDir(seat.id)}/closed`], seat.closed);
  seat.state = 'closed'; seat.until = 0;
  as('rm', ['-f', ...signInFiles(seat)]);
  log(`${seat.id}: its account was closed: ${words}`);
  reportSeat(seat);
}

// --- Running a job -----------------------------------------------------------------------------

type Job = { id: number; agent: string; title: string; prompt: string; engine: string; branch: string | null;
  quickReply?: boolean;
  quickReplyUntil?: number;
  code: string | null;   // its task's code (the coordinator's jobcodes.ts).
  session: string | null; note: string | null; attempts: number; kind: string; pr: number | null; stage?: string | null;
  customers: number;     // it held a customer's own details as it was claimed (jobs.ts holdsCustomerData)
  token: string; sha?: string | null;   // the job's HQ_TOKEN; for reviews, the exact commit to review
  writes?: string | null;   // JSON: the files a ruling may touch up (review.ts).
  inFlight?: string;   // the other open jobs when this run was claimed, and what to do about them (jobs.ts inFlight)
  archiving?: number | null;   // the agent's open pull request that already moves lines to its archive (review.ts archiving)
  cut?: string;   // what a stop of the worker's container cut in its last run (jobs.ts finish).
  resumes?: Resumes;   // its author's last session on its branch (jobs.ts claim)
  closingReports?: ClosingReports;   // or its author's closing reports there, once that session went cold
  ownsProject?: OwnedProject;   // the project its agent owns through its thread (closing.ts).
  inThread?: InThread;   // a task in a thread (threads.ts).
  resize?: { size: string | null };   // its saved size and author (sizes.ts withSize)
  stopping?: string | null;   // hq stop: who stopped it, and why (jobs.ts stopJob)
  landing?: string | null;   // JSON: its last run ended well, but its push or pull request snagged; this run only lands it (land).
  carry?: string | null;   // a commit main took outside a pull request: this run only checks it (carryChecks).
  // a run on the lighter model its queuer chose (lightLines), and the run after its hand-up (handedUpLines).
  lighter?: { name: string; own: string };
  handedUp?: { from: string; note: string };
  agentInfo?: { name: string; role: string; department: string; charter: string; model?: string | null; effort?: string | null;
    autocompact?: number | string | null };
  company: Partial<Company> & Pick<Company, 'stylePrompt'> };
// The company the job works for, as the coordinator reads it (brand.yaml's names, infra.env's addresses: jobs.ts claim)
type Company = { name: string; phone: string; newsletter: string; intercom: string; agentEmailDomain: string; agentsEmail: string;
  language?: string; timeZone?: string; stylePrompt: string;
  lighter?: { id: string; name: string }[] };   // the lighter models a hand-off can run on (lighterLine)
const company = (job: Job): Company => ({ name: 'the company', phone: 'desk phone', newsletter: 'the newsletter', intercom: 'intercom',
  agentEmailDomain: 'agents.invalid', agentsEmail: 'agents@agents.invalid', ...job.company });

// A JSON list of files (job.writes), empty when it's anything else
const parseList = (json: string | null | undefined) => {
  try { const list = JSON.parse(json ?? '[]'); return Array.isArray(list) ? list.filter((f): f is string => typeof f === 'string') : []; }
  catch { return []; }
};

// Reviewers (and the consolidator) read a pull request; they never change it, but for a ruling's touch-ups: edits to the
// files it may write (job.writes), which the worker commits and pushes itself (touchUp, below).
const reviewBriefing = (job: Job) => `You are ${job.agentInfo?.name ?? job.agent}, ${job.agentInfo?.role ?? 'reviewer'} at ${company(job).name}, an AI-run company.
${job.prompt}

You run with automatic safety review. ${parseList(job.writes).length ? `Edit only the files your instructions list, at most ${TOUCHUP_LINES} changed lines in all, `
  + 'and don\'t commit or push' : 'Don\'t modify, commit or push anything'}, and never contact people outside the company.

${DEFENSIVE}`;
// Every review, security focus or not, is a defensive one: OpenAI's Usage Policies count "circumventing our safeguards"
// (rephrasing a refused request) as a violation, and it closes an account it reads as doing cyber abuse.
const DEFENSIVE = 'This is a defensive review of our own repository: describe a flaw and its fix, prove it with a local test at most, '
  + 'write no working exploit or payload aimed at anything live, and probe nothing outside your clone and its test containers. '
  + 'If the model refuses a request, limits it or routes it to another model, say so in your report and drop that line: '
  + 'never rephrase it to get past the refusal.';

// A meeting's seat (the coordinator's meetings.ts): its agent talks with the others and changes only its own plans, with
// hq, and hands them in. Nothing it writes in its clone is kept.
const meetingBriefing = (job: Job) => {
  const a = job.agentInfo ?? { name: job.agent, role: 'agent', department: '' };
  return `You are ${a.name}, ${a.role} at ${company(job).name}, an AI-run company (department: ${a.department}).
Before anything else read company/CHARTER.md and your profile company/people/${job.agent}.md.

Your job #${job.id}: ${job.title}

${job.prompt}

How a meeting goes:
- You're in a meeting with colleagues whose sessions started together with yours. \`hq meeting listen --wait 60\` gives
  what they say (in Claude Code their lines also reach you by themselves between steps), and \`hq meeting say "..."\`
  speaks to all of them: short lines, one point each.
- Change your own plans during the meeting with hq (\`hq job\`, \`hq deliverable\`, \`hq propose\`, whatever your brief
  names), never with files: nothing you write in files is kept, committed or pushed. No team members in a meeting.
- Nobody leaves early, and the meeting has no time limit. When you think you're finished, hand your changes in (the
  chair doesn't: its part is in the brief above):
  \`hq meeting hand-in "what I changed"\`. You stay in it, hearing only the lines said to you (\`hq meeting say --to
  <agent>\`): keep waiting with \`hq meeting listen --wait 600\`. Feedback or a question that needs a change: take your
  hand-in back (\`hq meeting withdraw\`; a plan change you make does it too), change, and hand in again.
- Once everyone has handed in, the chair (the CEO) plays the combined changes against every deadline, reviews the
  whole, may send changes back, and closes the meeting. Then end with a one-line report.
- Nobody reads it live. Its transcript is kept (\`hq meeting <id>\`, \`hq search\`).`;
};

// A try run (the coordinator's ink/booktry.ts): its owner makes versions of what a board's note asks to see, shot in its
// scratch clone and clipped onto the note with hq answer. Nothing in the clone is kept, committed or pushed.
const tryBriefing = (job: Job) => {
  const a = job.agentInfo ?? { name: job.agent, role: 'agent', department: '' };
  return `You are ${a.name}, ${a.role} at ${company(job).name}, an AI-run company (department: ${a.department}).
Before anything else read company/CHARTER.md and your profile company/people/${job.agent}.md. Before you shoot anything,
read shared/craft/'s note on it (its README lists them). AGENTS.md has the few things every agent here knows.

Your job #${job.id}: ${job.title}

${job.prompt}

How a try goes:
- This is a scratch copy of the repository: change anything in it to make a version, but never commit, push or open a
  pull request. It's thrown away when you end; what you made lives in the board's book, clipped on with hq answer.
- \`hq status "..."\` shows what you're doing. Team members (helpers) are welcome, one version each.
- Nobody reads it live. Be quick: the board is watching the frames fill in.`;
};

// A company file the briefing names, from the job's clone: the company's own, else the foundation's default in template/
// (a company that hasn't copied it in yet), else null.
const companyFile = (dir: string, path: string) => existsSync(`${dir}/${path}`) ? path : existsSync(`${dir}/template/${path}`) ? `template/${path}` : null;

// A team member's name goes in the Agent call's description where the tool has no `name` (Claude Code offers it only
// with agent teams on); the stream reads name ?? description below.
// What the seats this job runs on have left of their week, for its briefing: work is sized knowing the budget.
function budget(engine: string) {
  const seats = SEATS.filter(s => s.engine === engine && s.week !== undefined);
  if (!seats.length) return '';
  const used = Math.round(seats.reduce((n, s) => n + s.week!, 0) / seats.length * 100);
  const resets = Math.min(...seats.map(s => s.weekResets || Infinity)), name = engine === 'claude' ? 'Claude' : 'Codex';
  const when = Number.isFinite(resets) ? ` (it resets ${new Date(resets).toLocaleString('en-GB',
    { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC)` : '';
  return `\n- The ${name} seats have used ${used}% of their week${when}, and every job, team member and review spends from it.
  Size the work to what it's worth: no extra rounds, variants or research past what the decision needs.`;
}

// The board's language (the coordinator's language.ts), for what agents write it and say to it; none for English, the
// language the rest of the briefing is in.
const boardLanguage = (c: Company) => !c.language || c.language === 'English' ? '' : `
- The board reads and hears ${c.language}: write everything that reaches it in ${c.language} (${c.phone} cards, ${c.newsletter},
  the board report, slide decks, the ${c.intercom}'s answers, a call's notes) and speak it on calls. The plan
  is the board's too: name work in ${c.language} (job and proposal titles, codes' words in plain capitals, deliverables' names
  and done-when lines, projects' names). Code and the company's own documents (briefs, notes, profiles, DECISIONS.md,
  commit messages) stay English.`;
// The board's clock (the coordinator's company.ts timeZone): every time it reads or hears is on it. The intercom's run
// has hq's times on it too, as a call has (HQ_TIME_ZONE: hq's estimate.ts at); other jobs keep UTC. What an agent gives
// hq is on the board's clock, with its date and no zone (the coordinator's windows.ts parse).
const boardClock = (c: Company, intercom: boolean) => !c.timeZone || c.timeZone === 'UTC' ? '' : `
- The board lives on ${c.timeZone} time: every time that reaches it (${c.phone} cards, ${c.newsletter}, the board report,
  the ${c.intercom}'s answers, a call's notes) is its own, never UTC. ${intercom ? `hq's answers here name each time's
  zone, on the board's clock where they can: one marked UTC is UTC, so convert it` : "hq's times are UTC: convert them for the board"}. Its offset from UTC
  changes with summer and winter time: convert a time at the offset of its own date. Give hq (--by, --deadline, --when)
  the board's own time with its date and no zone (2026-10-26 09:00): HQ reads it on the board's clock at that date's
  offset. A time with Z, or a time of day alone (14:30), is UTC.`;
const boardTimes = (job: Job) => job.kind === 'chat' && job.company?.timeZone ? { HQ_TIME_ZONE: job.company.timeZone } : {};

// A profile past what its template keeps: every job of the agent reads it, and each turn reads it again. A busy agent's is
// never swept by others, and a union merge of an old branch can bring archived lines back, so its owner hears of it here.
// Not while one of its open pull requests already moves lines to its archive (job.archiving): each job would move the same
// lines again, and their merges conflict or keep lines twice.
const PROFILE_BYTES = 40_000;
function oversized(dir: string, job: Job, readme: string | null) {
  if (job.archiving) return '';
  const size = lstatSync(`${dir}/company/people/${job.agent}.md`, { throwIfNoEntry: false })?.size ?? 0;
  return size > PROFILE_BYTES ? `\nYour profile is ${Math.round(size / 1000)} KB, over ${PROFILE_BYTES / 1000} KB: before you stop, move its older lines to the archive${
    readme ? ` as ${readme} says` : ''}, so your jobs stop paying for them on every turn.` : '';
}

// Its "Plan in AI time" line: size work with hq estimate. (The outside-contact line's hq mail draft.)
// (Its gates line after the code-style line) (Its AI hour and hq estimate)
// (Its hq request and hq ask with --topic)
// (Its hq ask, and the step after the card) (Its hq job --when line)
// (A thread read by its name: hq projects <words>.)
// A job whose session was another CLI's starts a new one here, in its kept clone (clis.ts resumeOn)
const SWITCHED = 'This job ran before on another CLI, whose session can\'t go on here, so this is a new session in the same clone. ' +
  'Your work so far is in it (git log, git status and .hq/): pick up from there rather than starting over.';
// A job on a pull request's branch going on in its author's last session there (carry.ts), which is told where it is now
const carriedNote = (job: Job, dir: string) => `This is job #${job.id}, on the branch you pushed, going on in your session from ` +
  `before. Its clone is a fresh one at ${dir}, with the branch as it is on GitHub: the folder you worked in before is gone, so work here.`;
function carry(job: Job, from: Resumes, cli: string, seat: Seat, me: Me) {
  try {
    const session = carrySession(WORK, { id: job.id, engine: job.engine, resumes: from }, { id: seat.id, cli }, me);
    if (session) log(`job #${job.id}: going on in job #${from.job}'s session`);
    return session;
  } catch (err) {
    log(`job #${job.id}: job #${from.job}'s session couldn't come along, so it starts afresh:`, err);
    return null;
  }
}
// (the board's places in the company's names, c.phone and c.intercom, all through)
function briefing(job: Job, dir: string, conflicts: string[] = [], closingBriefing = '') {
  const a = job.agentInfo ?? { name: job.agent, role: 'agent', department: '', charter: '' }, c = company(job);
  const people = companyFile(dir, 'company/people/README.md'), charter = a.charter && existsSync(`${dir}/company/${a.charter}`);
  return `You are ${a.name}, ${a.role} at ${c.name}, an AI-run company (department: ${a.department}).
Before anything else read company/CHARTER.md, your profile company/people/${job.agent}.md (create it${people ? ` from the
template in ${people}` : ''} if it doesn't exist)${charter ? ` and your charter company/${a.charter}` : ''}.${oversized(dir, job, people)}
Search the knowledge base before researching anything (\`hq search "..."\`: the Handbook, playbooks, notes, the shared
craft library and your own past work). Before you make anything people will see (a picture, a print file, a deck, a
film or an ad, sound, copy, a product page), read the craft notes on it in shared/craft/ (its README lists them): what
works, the checks and the tools. Where the company's own notes or brand say otherwise, they win. AGENTS.md has the few
things every agent here knows.

Your job #${job.id}: ${job.title}${unnamed(job)}

${inThreadLines(job, conflicts)}${job.prompt}${closingBriefing}${job.inFlight ? `\n\n${job.inFlight}` : ''}${lightLines(job)}

How work happens here:
- Before you change code, read CODE_STYLE.md at the repo root and follow it: among other things, the platform is
  generic and anything only this company's goes in its own folders (products/, kits/, company/, theme/).${gatesLine(dir)}
- You are in a git worktree on branch ${job.branch ?? `job/${job.id}`}. Don't commit or push; when you stop, the
  worker commits your changes and ${job.inThread ? THREAD_PUSH : 'opens a pull request for review.'}
- Use the \`hq\` command to show what you're doing (\`hq status "..."\`), hand off work (\`hq job [--after <job id>]
  <agent> "title" [file | -]\`: the brief in a file, or - on stdin; it prints the job number, and --after waits
  until that job is merged; a hand-off is done once it's a job) or ask the board (\`hq ask ... --topic "a word or two"\`).
  Only the step that needs the board's answer waits for it: queue that step \`hq job --after request:<id>\` and finish the
  rest, so it goes to review. Park this job (\`hq request\`, then stop) only when nothing can go on without the answer.
  A step that must wait for a deploy, work going live or a time is queued the same way, \`hq job --when <event>\`
  (\`hq\` lists the events), with what you found so far in its brief: never poll for it in your session.
  \`hq say <agent> "..."\` reaches a colleague's running job at its next step, or becomes a job for them; \`hq sent\`
  shows whether it arrived.
  Run \`hq\` without arguments for details.
- Available tools include node, git, ffmpeg, Playwright with Chromium, ImageMagick, python3 and sqlite3.
- Every job shares the worker's memory and cores. Send heavy work (many-seed simulations, long renders) off it with
  \`hq run\` (\`hq run helper\` shows the machines that take it), even when that's slower; what runs here goes in small
  batches, one at a time, never left running in the background. Commit a short summary of the results, never the raw
  output. A job past its share (memory, cores or processes) has that run blocked: the command ends Killed, after HQ's
  words on where to run it instead. Don't run it here again.
- Never push to or merge into main yourself, never put secrets in files or command arguments (other jobs can read
  those; pass keys through the environment or stdin), and never contact people outside the company. To ask a named
  outside colleague for documents, answers or tasks, write them a checklist (\`hq guest <name> "title" <file.json>\`,
  \`hq\` shows its shape): the board shares its link, and each step they take comes back to you. Never email anyone
  yourself: an email the board has to send goes to it as a draft (\`hq mail draft\`), which it edits and sends from HQ.
- You run with automatic safety review. If an action is refused, don't look for a way around it: choose a safer
  approach, or ask the board with \`hq request\` if the action is really needed.
- Commit your own work with your own name: \`git commit --author "${a.name} (${c.name}) <${job.agent}@${c.agentEmailDomain}>"\`.
  Anything left uncommitted when you stop is committed for you.
- Work of another department is a job for its people (\`hq job\`), who bring their own helpers; a colleague in
  org.yaml is never your team member, nor is one you're hiring in this job: their work is a job for them too
  (\`hq job --after ${job.id} <their id> ...\`), which starts once your hiring is merged.
  Big work of your own: lead a team inside this session. Start named team members with the Agent tool
  (subagent_type "team-member", a new lowercase name, never reused; check company/org.yaml and its alumni). The name goes in the call's \`name\`, or in its \`description\` (the name
  alone) if the tool has no \`name\`: HQ registers the member under it, and it's their id for \`hq --as\`.
  They can start their own helpers and message each other with SendMessage; HQ shows them all live. Give each a
  profile in company/people/ so they can be brought back later with their memory. Run independent work in
  parallel (background agents), and wait for them before you finish.
- Need the board mid-work? \`hq ask ... --topic "..."\` then \`hq wait <id>\` (repeat until answered): your team stays alive.
- Plan in AI time, never developer time. An AI hour is one agent working for an hour, from its start to its end (a wait
  that ends the run, for a seat, a deploy or a card filed with \`hq request\`, is left out; an \`hq wait\` is not).
  Inspect \`hq estimate "..."\` for clean past jobs and compare their scope, briefs, reports and changes.
  Choose the agent time yourself, then queue with \`hq job ... --size <90m> --refs <job,job> --why "scope comparison"\`.
  Omit --refs only when no comparable job fits, and say why. HQ saves this estimate once, when queued.
  ${DEFAULT_ESTIMATE_SCALE}${lighterLine(job)}
  For new work, get the time for the board with \`hq when "..." --size <90m>\`,
  with its dependencies and \`--by\` the board's time when it named one. For queued work, read \`hq deliverable <project>/<slug>\` (by its name or words: \`hq projects <words>\`). Give one plain time.${resizeLine(job)}${budget(job.engine)}${boardLanguage(c)}${boardClock(c, job.kind === 'chat')}${job.kind === 'chat' ? '' : `
- Nobody reads this session live, the board included: you run in the background, and your messages go to the job's
  log. Write them as a report on the work, never as a reply to the board, even when you're acting on its answer.
  The board sees only the ${c.phone}, ${c.newsletter} and the ${c.intercom} (and a call's notes, when your job says so).
  Anything that needs its judgment goes on the ${c.phone} (\`hq ask\`/\`hq request\`); thanks and "on it" go nowhere.`}
${closing(job)}`;
}

// Quick replies read their own context, without the work job's housekeeping or shared CLI memory.
// (no charter or profile read first: they cost a turn and thousands of tokens before each answer.)
function quickBriefing(job: Job) {
  const a = job.agentInfo, c = company(job);
  return `You are ${a?.name ?? job.agent}, ${a?.role ?? 'agent'} at ${c.name}.
This is one immediate reply to the board: the brief below says where it appears and how to give it.
Use tools only when the answer needs them: read no charter or profile for it unless the answer is in one.
Do not run gates or update your profile. If you cannot answer, say why. Answer now.
Current time: ${new Date().toISOString()}.${boardLanguage(c)}${boardClock(c, true)}

${job.prompt}`;
}

// A task HQ made without a code (a bug report, a call's follow-up): its agent names it, having read it.
const unnamed = (job: Job) => job.code || job.kind !== 'work' || job.pr !== null ? '' : `
Its task has no code yet: name it first, \`hq code WORD\`, a word for what it does (as hq job --code), so the board and
calls can say it.`;
// A task in a thread: its place in the thread before its brief, and where its work goes (threads.ts).
const inThreadLines = (job: Job, conflicts: string[]) => job.inThread ? `${threadBriefing(job.inThread, conflicts)}\n\n` : '';
// (a thread is a deliverable in the board's word)
const THREAD_PUSH = `pushes them to the deliverable's branch, which opens the deliverable's one pull request for review, or
  starts its next round if it's open. Your own
  profile and archive lines go to main by themselves. A step that needs this deliverable's work live is no task of it:
  Propose it to the project's owner with \`hq propose\`. The owner or CEO queues it with
  \`hq job --when deployed:<this job>\`, which gives it a task of its own after the release.`;

// The saved size stays fixed until the CEO changes it after reported slippage.
const resizeLine = (job: Job) => !job.resize ? '' : `
  ${job.resize.size ? `This job is sized at ${job.resize.size}. ` : ''}When the work turns out bigger than its brief, tell
  the CEO what scope changed and your new estimate through \`hq say\` or a follow-up job, and go on with it on your
  best judgment rather than stop to wait for an answer. Only the CEO changes the
  saved estimate. Hourly checks and plan updates replay the saved sizes without re-estimating.`;

// The gates' line in the briefing, once the branch has them.
const gatesLine = (dir: string) => existsSync(`${dir}/${GATES}`) ? `
- Before you stop, run \`npm run gates\` and fix what it reports: Prettier, ESLint and the type check, on what you
  changed. The worker runs them on your pull request too, and one that fails comes back to you before any review.` : '';

// A job's folders, its clone and its home, are its slot's while it runs. When a run ends they go back to root:
// removed once the job is done; kept while it waits (the clone only when it paused mid-run, so uncommitted work
// survives a usage limit or restart; the home, with its session, until it's done). The finish is reported only
// after that, so no other slot can pick the job up while this one still holds its folders.
// One run per job at a time: if the coordinator hands out a job again while a slot here still has it (a stale
// heartbeat requeues it), this slot leaves the job and its folders alone. The heartbeat starts before setup, so
// a long clone or import doesn't make the run look stale in the first place.
const active = new Set<number>();
// Claims and finish reports in flight: a reload (handOver) waits for them, or the job they carry is lost with the process.
let reporting = 0;
// Downtime jobs asked to yield (downtime.ts): stopped when a step ends (a tool returns), or after YIELD_MS regardless.
const yielding = new Map<number, Asked>();
const YIELD_MS = 5 * 60_000;
const LINES_MS = 15_000;   // how often a run's lines are read from its clone (runJobIn countLines)
const TOKENS_MS = 10_000;   // how often a run's tokens go to HQ, when they grew (runJobIn tellTokens)
// Jobs whose Claude seat drained while they ran (drain), and since when: stopped the same way, and back in the queue as
// limited, for a seat with room or the reset.
const drained = new Map<number, number>();
// Jobs stopped with hq stop (the heartbeat's `stop`, or the claim's for a paused one), with who and why: ended at once,
// and ended stopped, their work committed on their branch without opening a pull request.
const stopAsked = new Map<number, string>();
// probe: the job was claimed to measure its seat's unknown window (slotLoop), so its first reading decides whether it
// may go on (the coordinator holds that reading to the start threshold).
// adopted: a run the last worker process handed over (takeOver), its CLI still running or ended since.
async function runJob(seat: Seat, job: Job, slot: string, probe = false, adopted?: RunRecord) {
  if (active.has(job.id)) { log(`${slot}: job #${job.id} is already running here; leaving it to that run`); return; }
  active.add(job.id);
  if (adopted?.handed) handed.set(job.id, adopted.handed);
  if (job.stopping) stopAsked.set(job.id, job.stopping);
  const me = slotAgent(slot, job.id);
  inSlot.set(slot, { job, me, seat: seat.id });
  capacityTrial.note(`Job #${job.id}: ${adopted ? 'taken over' : 'claimed'}, slot ${slot}, seat ${seat.id}, engine ${job.engine}, kind ${job.kind}`);
  // A downtime job may be asked to yield (to other work, or a filling window): runJobIn stops it at its next step. A
  // probe stays one until a heartbeat with its first reading is answered (and read: not reined, downtime.ts heard).
  await ownRun({ job: job.id, runs: RUNS,
    heartbeat: async () => {
      const util = windowUsed(seat), first = probe && util !== undefined;
      return { reply: await hq.api('heartbeat', { job: job.id, seat: seat.id, util, probe: first || undefined, ...inTheWay() }), first };
    },
    answered: ({ reply, first }) => { if (first && !reply?.reined) probe = false; heartbeatAnswered(job, slot, reply, first); },
    stop: () => { killAll(me); running.get(slot)?.stop(); running.delete(slot); inChecks.delete(job.id); }, log,
  }, async () => {
    let body: Record<string, unknown> | undefined, thrown: unknown;
    const spent = spentOn(cliOf(seat)), launches: Launched[] = [];
    const measured = ['claude', 'codex'].includes(cliOf(seat));
    const tooling = measurement(Date.now(), !adopted && measured);
    try { body = await runJobIn(seat, job, slot, me, spent, launches, adopted, tooling); assertOwned(); }
    catch (err) { thrown = err; if (!ownershipSignal()?.aborted) dropRun(RUNS, job.id, ...launches); throw err; }   // (the slot reports it, snagOf: nothing for a next process to take over)
    finally {
      if (!ownershipSignal()?.aborted) hq.api('team', { job: job.id, done: true }).catch(() => {});
      killAll(me); sweep(me);
      try {
        if (!shuttingDown && !ownershipSignal()?.aborted) await settle(seat, job, me, body ? body.status as string | undefined : snagOf(thrown));
      } finally {
        if (ownershipSignal()?.aborted) { parkRun(seat, job, me); dropRun(RUNS, job.id, ...launches); }
        active.delete(job.id); yielding.delete(job.id); drained.delete(job.id); stopAsked.delete(job.id); inSlot.delete(slot);
      }
    }
    if (shuttingDown) return;
    assertOwned();
    reporting++;
    try { await finish({ job: job.id, seat: seat.id, ...body, ...report(spent),
      tooling: tooling.snapshot(), toolingEngine: measured ? cliOf(seat) : 'other' }); }
    catch (err) {
      // (a refused report stays refused: its record would be taken over as a run that never ends. A coordinator that can't
      // be reached or fails (5xx, as handback.ts retries it) is tried by a next process.)
      if (err instanceof ResponseError && err.status < 500) dropRun(RUNS, job.id, ...launches);
      throw err;
    }
    finally { reporting--; }
    capacityTrial.note(`Job #${job.id}: reported ${body!.status}`);
    dropRun(RUNS, job.id, ...launches);   // (reported: nothing left for a next worker process to take over)
  });
}

// A deadline yield stops the CLI as soon as the coordinator answers, without a tool-boundary wait.
function heartbeatAnswered(job: Job, slot: string, reply: any, first: boolean) {
  if (!active.has(job.id)) return;
  if (reply?.stop && !stopAsked.has(job.id)) {
    stopAsked.set(job.id, String(reply.stop));
    log(`job #${job.id}: hq stop heard`);
  }
  const change = heard(yielding, job.id, reply, { first });
  if (reply?.immediate) running.get(slot)?.stop();
  if (change) log(`job #${job.id}: ${change} (downtime${change === 'yielding' ? `, ${reply.yield}` : ''})`);
}

// HQ may have requeued this job. Keep its clone and session until the normal ended-job sweep can settle them.
function parkRun(seat: Seat, job: Job, me: Me) {
  try { keepSignIn(me, seat, jobDirs(WORK, job.id).home, job.id); }
  catch (err) { log(`job #${job.id}: ${cliOf(seat)} sign-in:`, err); }
  removeTested(job);
  handed.delete(job.id);
  handedFiles.delete(job.id);
  refreshes.end(runRefreshes(job.id));
  for (const folder of Object.values(jobDirs(WORK, job.id))) if (existsSync(folder)) {
    own([folder], { uid: 0, gid: 0 });
    const now = new Date(); utimesSync(folder, now, now);
  }
}

// Claude's auto memory, shared by work jobs.
const MEMORY = '/seats/shared/claude/projects/-work-repo/memory';

// A slot's uid with the env its git and file commands run with: the job's home, nothing else.
function slotAgent(slot: string, id: number) {
  const { home } = jobDirs(WORK, id), s = SLOT_IDS.get(slot);
  return { ...idsOf(slot), env: envFor({ HOME: home, TMPDIR: `${home}/tmp`, ...(ROOT && s ? { USER: s.name } : {}) }) };
}
type Me = ReturnType<typeof slotAgent>;

async function settle(seat: Seat, job: Job, me: Me, status?: string) {
  const { dir, home } = jobDirs(WORK, job.id);
  if (cliOf(seat) === 'claude' && runModeOf(job).sharesMemory) {
    const customers = await holdsCustomerData(job);
    assertOwned();
    try {
      const f = memoryFolders(me, job, dir, home), out = customers ? f : await masked(f, mask);
      if (out) giveBack(out, customers);
    } catch (err) { assertOwned(); log(`job #${job.id}: memory:`, err); }
  }
  assertOwned();
  try { keepSignIn(me, seat, home, job.id); } catch (err) { log(`job #${job.id}: ${cliOf(seat)} sign-in:`, err); }
  handed.delete(job.id);
  handedFiles.delete(job.id);
  refreshes.end(runRefreshes(job.id));
  // Waiting folders are root's, stamped now: takeVolumes clears a folder by when its job last ran.
  const park = (p: string) => { own([p], { uid: 0, gid: 0 }); const now = new Date(); utimesSync(p, now, now); };
  // (a snagged run's clone holds what its next run lands, or picks up from: land.)
  // (and a handed-up run's, which its next run goes on in)
  if (status === 'interrupted' || status === 'limited' || status === 'yielded' || status === 'snagged' || status === 'up') { if (existsSync(dir)) park(dir); } else remove(dir);
  // a home holds the CLI's session: the intercom's goes on at the board's next message, so a chat job keeps its home
  // when a turn ends done too (takeVolumes clears it once it's long unused, like any other)
  if ((status !== 'done' || job.kind === 'chat') && existsSync(home)) park(home);
  // a done work job keeps its sessions alone, for a fix round on its branch to go on in (carry.ts), until the
  // coordinator says it ended (sweepEnded: its pull request merged or closed)
  else if (job.kind === 'work' && existsSync(home)) {
    execFileSync('find', [home, '-mindepth', '1', '-maxdepth', '1', '!', '-name', '.claude', '!', '-name', '.codex', '-exec', 'rm', '-rf', '--', '{}', '+']);
    park(home);
  } else remove(home);
}

// Whether the job holds a customer's own details as its run ends (copyback.ts giveBack): it can be handed them while it
// runs (hq mail, a customer card), so the coordinator is asked now. One it can't tell counts as holding them, so nothing
// goes back.
async function holdsCustomerData(job: Job) {
  try { return !!(await hq.report('customers', { job: job.id })).customers; }
  catch (err) { log(`job #${job.id}: memory: customer data unknown, so nothing goes back:`, err); return true; }
}

// Text the worker sends out on its own goes through the coordinator's mask first (secrets.redact: a key's value
// becomes its name), the memory a job is handed and gives back included (copyback.ts masked).
const mask = async (text: string) => {
  const maskedText = (await hq.report('redact', { text })).text;
  if (typeof maskedText !== 'string') throw new Error('The coordinator gave no masked text');
  return maskedText;
};

const realDir = (p: string) => { try { return lstatSync(p).isDirectory() && realpathSync(p) === p; } catch { return false; } };

// Each run: the job's config in its home (or the one a reviewer is asked again in: askHome, slots.ts). Codex gets the
// seat's sign-in (Claude's comes on a pipe: SIGN_IN); a Claude work job gets the shared memory, a reviewer none (nothing
// another job wrote reaches a verdict that way).
async function prepareHome(seat: Seat, job: Job, me: Me, home = jobDirs(WORK, job.id).home) {
  const { dir } = jobDirs(WORK, job.id);
  runAs(me, 'mkdir', ['-p', '-m', '700', `${home}/tmp`, `${home}/.claude`, `${home}/.codex`]);
  // Only the sign-in: the seat's config.toml was writable by every agent before, and could start a command.
  const auth = cliOf(seat) === 'codex' ? readAs(keeper, `${seatDir(seat.id)}/auth.json`) : undefined;
  if (auth !== undefined) { runAs(me, 'sh', ['-c', 'umask 077 && cat > "$1"', 'sh', `${home}/.codex/auth.json`], auth); handed.set(job.id, auth); refreshes.handOut(runRefreshes(job.id), seat.id, auth); }
  if (CLIS[cliOf(seat)]) handOutSignIn(me, seat, home, job.id);
  if (cliOf(seat) === 'claude' && runModeOf(job).sharesMemory) {
    // One it can't mask isn't handed out, and its copy is removed; one that can't be removed throws: the job doesn't
    // start with it
    const out = await masked(memoryFolders(me, job, dir, home), mask);
    if (out) try { handOut(out, !!job.customers); } catch (err) { log(`job #${job.id}: memory:`, err); }
  }
}

// A memory folder's plain .md files, each read as `who`, so a planted symlink or odd name is skipped: the first 500
// by name, and every name there (copyBack takes a name without a file as unknown). Undefined if it can't be listed.
function memoryFiles(who: Me | typeof keeper, path: string): Snap | undefined {
  let names: string[];
  try { names = runAs(who, 'find', [path, '-maxdepth', '1', '-type', 'f', '-name', '*.md', '-printf', '%f\\n']).split('\n'); }
  catch { return undefined; }
  names = names.filter(plainName).sort();
  const files: Files = new Map();
  for (const n of names.slice(0, 500)) {
    const text = readAs(who, `${path}/${n}`);
    if (text !== undefined) files.set(n, text);
  }
  return { files, names: new Set(names) };
}

// What a work job learned goes back to the shared memory (copyback.ts), read as the slot and written as the
// keeper, so nothing the job planted (a symlink, a huge file) is followed or kept. The start each job's copy was made
// from is the keeper's, next to the shared memory: it outlives a restart, so a run cut off by one still gives back only
// what it changed. A deleted file goes to a dated trash folder for 30 days, not at once: the memory isn't in git.
const MEMORY_START = `${MEMORY}-start`, MEMORY_TRASH = `${MEMORY}-trash`;
function memoryFolders(me: Me, job: Job, dir: string, home: string): Folders {
  const copy = `${home}/.claude/projects/${project(dir)}/memory`, start = `${MEMORY_START}/${job.id}`;
  const write = (who: Me | typeof keeper, path: string, text: string) => runAs(who, 'sh', ['-c', 'cat > "$1"', 'sh', path], text);
  return {
    shared: () => realDir(MEMORY) ? memoryFiles(keeper, MEMORY) : { files: new Map(), names: new Set() },
    readShared: n => readAs(keeper, `${MEMORY}/${n}`),
    copy: () => memoryFiles(me, copy),
    // `names` is written last: without it the start is incomplete, so there's none
    start: () => {
      const names = readAs(keeper, `${start}/names`), snap = names === undefined ? undefined : memoryFiles(keeper, start);
      return snap && { files: snap.files, names: new Set(names?.split('\n').filter(plainName)) };
    },
    keep: plan => {
      // Into a new file, then renamed over the name: a symlink left in the shared memory (agents could write there before
      // each slot had its own uid) is replaced, never written through.
      for (const [n, text] of plan.write) as('sh', ['-c', 'mkdir -p "$1" && t=$(mktemp "$1/.new.XXXXXX") && cat > "$t" && mv -fT -- "$t" "$1/$2"', 'sh', MEMORY, n], text);
      // the time in the name: a file the same job deletes again the same day doesn't overwrite the one trashed before
      const now = new Date().toISOString(), trash = `${MEMORY_TRASH}/${now.slice(0, 10)}`, at = now.slice(11, 23).replace(/\D/g, '');
      for (const n of plan.remove) as('sh', ['-c', 'mkdir -p "$2" && mv -f -- "$1/$3" "$2/job-$4-$5-$3"', 'sh', MEMORY, trash, n, String(job.id), at]);
    },
    // A folder the job locked (chmod 500, on the copy or a folder above it) is unlocked first, as the slot: GNU chmod
    // skips symlinks inside the folder, and the slot can only change what's its own.
    setCopy: files => {
      runAs(me, 'sh', ['-c', 'chmod u+rwx -- "$2" "$2/projects" "$3" 2>/dev/null; chmod -R u+rwX -- "$1" 2>/dev/null; rm -rf -- "$1"',
        'sh', copy, `${home}/.claude`, `${home}/.claude/projects/${project(dir)}`]);
      if (!files) return;
      runAs(me, 'mkdir', ['-p', copy]);
      for (const [n, text] of files) write(me, `${copy}/${n}`, text);
    },
    // `names` goes first, so a removal cut short never leaves what looks like a whole start
    setStart: snap => {
      as('rm', ['-f', '--', `${start}/names`]);
      as('rm', ['-rf', '--', start]);
      if (!snap) return;
      as('mkdir', ['-p', start]);
      for (const [n, text] of snap.files) write(keeper, `${start}/${n}`, text);
      write(keeper, `${start}/names`, [...snap.names].join('\n'));
    },
    log: note => log(`job #${job.id}: memory: ${note}`),
  };
}

// Codex refreshes its sign-in now and then; a refreshed one goes back to the seat, so the next job doesn't start
// from a spent refresh token. Only a refresh is taken: the same fields, and everything but the tokens and the
// refresh time unchanged, the account included. (A job can still spoil its seat's tokens: that costs a sign-in.)
// And only from a run whose copy is still the seat's own (from: the sign-in as prepareHome handed it out). Once one run's
// refresh is back, or a new sign-in replaced the seat's, every other copy is of a sign-in that's gone, and its refresh
// could only put an older one back: so one run at a time writes a refresh back, the first to settle. (A run launched with
// the worker's refreshes, REFRESH_URL_VAR, has nothing to write back: the worker saved each of its refreshes as it came.)
const handed = new Map<number, string>();
// Another CLI's sign-in (clis.ts credentials) goes into the job's home as Codex's does, and a refresh of it comes back the
// same way: only from a run whose copy is still the seat's own, the first to settle.
const handedFiles = new Map<number, Record<string, string>>();
function handOutSignIn(me: Me, seat: Seat, home: string, job: number) {
  const files: Record<string, string> = {};
  for (const f of CLIS[cliOf(seat)]?.credentials ?? []) {
    const text = readAs(keeper, `${seatDir(seat.id)}/${f}`);
    if (text === undefined) continue;
    runAs(me, 'sh', ['-c', 'umask 077 && mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', `${home}/${f}`], text);
    files[f] = text;
  }
  handedFiles.set(job, files);
}
function keepSignIn(me: Me, seat: Seat, home: string, job: number) {
  returnSignIn({ me, keeper, seat, home, directory: seatDir(seat.id), cli: cliOf(seat),
    from: handed.get(job), files: handedFiles.get(job) });
}
// Each Codex seat's refreshes, which its runs send to the worker (refreshes.ts), each run on a secret path of its own.
// They come in on supervise.py's socket, which outlives a reload of the worker's process, so no job can take its port
// and the runs a new worker takes over still reach it. What the refreshes know (the sign-ins handed out, the tokens
// spent, the runs' paths) is kept in a file only root reads, so a new worker carries on where the last one stopped.
const REFRESHES_FILE = `${WORK}/codex-refreshes.json`;
const refreshes = codexRefreshes({
  read: id => SEATS.some(s => s.id === id && !s.gone && cliOf(s) === 'codex') ? readAs(keeper, `${seatDir(id)}/auth.json`) : undefined,
  save: (id, text) => saveAs(`${seatDir(id)}/auth.json`, text),
  exchange: exchangeWithOpenAI,
  state: existsSync(REFRESHES_FILE) ? JSON.parse(readFileSync(REFRESHES_FILE, 'utf8')) : { lineages: {}, holders: {} },
  keep: state => {
    writeFileSync(`${REFRESHES_FILE}.new`, JSON.stringify(state), { mode: 0o600 });
    renameSync(`${REFRESHES_FILE}.new`, REFRESHES_FILE);
  },
});
let refreshPort: number;
const runRefreshes = (job: number) => `job ${job}`;
const refreshVars = (capability: string | undefined): Record<string, string> =>
  capability ? { [REFRESH_URL_VAR]: `http://127.0.0.1:${refreshPort}/codex/${capability}` } : {};
// supervise.py binds the socket and hands it down (WORKER_REFRESH_FD). A worker started on its own (a local test run)
// listens on a free port.
async function serveCodexRefreshes() {
  const fd = process.env.WORKER_REFRESH_FD;
  if (ROOT && !fd) throw new Error('No refresh socket from supervise.py (WORKER_REFRESH_FD): Codex runs would have nowhere to refresh');
  ({ port: refreshPort } = await serveRefreshes(refreshes.refresh, fd ? { fd: Number(fd) } : { port: 0 }, log));
  refreshes.endAllBut([...adopted.values()].map(r => runRefreshes(r.job.id)));
  log(`Codex refreshes on port ${refreshPort}`);
}

// A paused run's clone, if it's still on the job's branch.
function resumable(me: Me, dir: string, branch: string) {
  try { return existsSync(dir) && runAs(me, 'git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']).trim() === branch; } catch { return false; }
}

// A paused review's kept clone is still on the commit it reviews: its session may have checked out another (a baseline).
function atCommit(me: Me, dir: string, sha: string | null | undefined) {
  try { return runAs(me, 'git', ['-C', dir, 'rev-parse', 'HEAD']).trim() === sha; } catch { return false; }
}

// The team-member agent the briefing tells a lead to start: the company's own (.claude/agents/team-member.md), else the
// foundation's default from template/, read as the job's user (the clone is the agent's: a link there mustn't read for root).
function teamMember(dir: string, me: Me) {
  const file = companyFile(dir, '.claude/agents/team-member.md');
  if (file !== 'template/.claude/agents/team-member.md') return [];
  const m = readAs(me, `${dir}/${file}`)?.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const description = m?.[1].match(/^description: *(.+)$/m)?.[1];
  return m && description ? ['--agents', JSON.stringify({ 'team-member': { description, prompt: m[2].trim() } })] : [];
}

// What a job's auto mode safety check knows about where it runs, next to its own rules, which all still stand (the
// board's call, 2026-10-02: a card's Share part rewritten into Dutch was refused twice as a real-world transaction).
// A work job's settings also carry the hooks that bring it its colleagues' messages (inbox.ts).
const AUTO_MODE = { environment: ['$defaults',
  "`hq` is the company's own command-line tool for its HQ. Its commands (status, job, say, request, ask, rewrite, close, " +
  "search and the rest) change only the company's internal records: its jobs, messages between its agents, and the " +
  "cards on the board's desk phone.",
  "The board is the company's human owner. Only the board reads the desk phone's cards: writing or rewriting one (hq " +
  'request, hq ask, hq rewrite), its Share part included, sends nothing to anyone. Nothing on a card reaches anyone ' +
  'outside the company unless the board passes it on itself.'] };

// adopted: a run another worker process launched and handed over (a reload, detached.ts), taken over where it got to.
async function runJobIn(seat: Seat, job: Job, slot: string, me: Me, spent: Spent, launches: Launched[], adopted: RunRecord | undefined, tooling: ReturnType<typeof measurement>): Promise<Record<string, unknown>> {
  const mode = runModeOf(job), { reviewing, meeting, trying } = mode;
  const branch = job.branch ?? `job/${job.id}`;
  if (!reviewing && !workRunsOn(branch, job.pr)) throw new Error(`Refused branch ${branch}: work jobs only run on job/<n>, or a profile pull request's fix on its profile/<n>`);   // (workRunsOn)
  const { dir, home } = jobDirs(WORK, job.id);
  const g = flow.forAgent(me);
  const hqDir = `${dir}/.hq`;
  // A run taken over in its push's checks goes on from there: its commit, push and pull request are behind it.
  if (adopted?.checks) {
    log(`job #${job.id}: taken over from the last worker process in its push's checks`);
    launches.push(...launchesOf(adopted));
    Object.assign(spent, adopted.checks.spent);
    return await afterPush(job, me, dir, adopted.checks, checks => { if (!ownershipSignal()?.aborted) keepRecord(RUNS, { ...adopted, checks }); }, launches);
  }
  const { effort, autocompact } = job.agentInfo ?? {};   // company/models.yaml, overridable per agent in org.yaml
  const cli = cliOf(seat), other: Cli | undefined = CLIS[cli];   // (another CLI than Claude Code or Codex: clis.ts)
  // The job's own model is its engine's: a seat on another CLI (Mistral's or Google's, with a share of the second opinion or an agent the
  // board gave a model there) takes its provider's, else the CLI's own.
  const model = modelFor(seat, cli === job.engine ? job.agentInfo?.model ?? undefined : undefined);   // (providers.ts)
  // What a launch runs with: test-environment partner keys the board entered on the desk phone (PRINTAPI_CLIENT_ID, ...),
  // and Claude's sign-in, which goes on a pipe, never in the env the job's commands could read (SIGN_IN).
  // In a home h: the job's, or the one a reviewer is asked again in (askVerdictAgain, below).
  const launchEnv = async (h = home) => {
    const keys = reviewing ? {} : await safe(() => hq.api('secrets')) ?? {};
    const signIn = cli !== 'claude' ? undefined : readAs(keeper, `${seatDir(seat.id)}/${credentialFile(seat)}`)?.trim() ?? '';
    const seatVars = other ? { ...other.home(h), ...other.env?.({ model, effort: effort ?? undefined }) } : cli === 'codex' ? { CODEX_HOME: `${h}/.codex`, ...refreshVars(refreshes.capabilityOf(runRefreshes(job.id))) } : { CLAUDE_CONFIG_DIR: `${h}/.claude`, ...claudeEnv(seat),
      // A lead's session waits for its background team members instead of exiting after its own turn.
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(3 * 3600e3), CLAUDE_CODE_DISABLE_AUTO_MEMORY: reviewing ? '1' : undefined };
    return { signIn, env: envFor({ ...me.env, HOME: h, TMPDIR: `${h}/tmp`, ...seatVars, HQ_URL: HQ, HQ_TOKEN: job.token, HQ_AGENT: job.agent,
      HQ_JOB: String(job.id), HQ_JOB_DIR: hqDir, HQ_RENDERS: RENDERS, ...boardTimes(job),
      ...(job.lighter && !reviewing && { HQ_LIGHTER: job.lighter.own }) }, keys, Object.keys(seatVars)) };   // (hq up)
  };
  // Both read the prompt from stdin, so a long one (a long message from the board) is never cut short, and it's on
  // no command line (any uid can read /proc/<pid>/cmdline). A launch of its own, so a reviewer can be asked about its
  // verdict once more (askVerdictAgain, below). Its output goes to files the worker follows, so a reload of the worker's
  // own process never stops it (detached.ts).
  const launch = (name: string, args: string[], input: string, cwd: string, e: Awaited<ReturnType<typeof launchEnv>>) => {
    assertOwned();
    const { child, launched } = launchDetached(RUNS, name, other?.bin ?? cli, args,
      { cwd, env: e.env, uid: me.uid, gid: me.gid, fd3: e.signIn !== undefined });
    capacityTrial.note(`Job #${job.id}: CLI launched, pid ${launched.pid}, run ${name}`);
    child.stdin!.on('error', () => {}); child.stdin!.end(other?.input ? other.input(input) : input);
    if (e.signIn !== undefined) SIGN_IN.hand(child, e.signIn);
    const piped = [child.stdin, child.stdio[3]].filter(p => p).map(p => new Promise<void>(done => p!.once('close', done)));
    let over = false, code = 1;
    const exit = exitOf(child).then(c => { over = true; code = c; });
    // both pipes written to their end, or the CLI gone: only then may a reload end this process
    const sent = Promise.race([Promise.all(piped), exit]).then(() => {});
    return { launched, sent, ended: () => over, code: () => exit.then(() => code), stop: () => { child.kill('SIGTERM'); } };
  };
  let first: ReturnType<typeof launch>, resumed: boolean;
  if (adopted) {
    // its CLI is no child of this process: its end is seen by its pid going, and its exit code is supervise.py's
    const l = adopted.launched;
    first = { launched: l, sent: Promise.resolve(), ended: () => !alive(l.pid, l.start), code: async () => await endOf(RUNS, l) ?? 1,
      stop: () => { if (alive(l.pid, l.start)) process.kill(l.pid, 'SIGTERM'); } };
    resumed = adopted.resumed;
    log(`job #${job.id}: taken over from the last worker process, its CLI ${alive(l.pid, l.start) ? 'still running' : 'ended meanwhile'}`);
  } else {
    await waitOwned(Promise.resolve(refreshing));
    assertOwned();
    syncMirror();
    if (job.carry) return await carryChecks(job, me, launches);
    // A fresh run starts clean. A paused review keeps its verdict file with its session.
    if (!job.session) remove(home);
    if (!job.session && !job.handedUp) remove(dir);   // (a hand-up's next run keeps its clone)
    for (const p of [dir, home]) if (existsSync(p)) own([p], me);
    if (existsSync(dir) && !(reviewing ? atCommit(me, dir, job.sha) : resumable(me, dir, branch))) remove(dir);
    const newHome = !existsSync(home), fresh = !existsSync(dir);
    if (newHome) makeDir(home, me);
    if (fresh) { makeDir(dir, me); g.clone(dir, branch, reviewing ? { sha: job.sha } : undefined, cloneIdentity(job)); }
    else { log(`job #${job.id}: resuming in its clone`); g.ag(dir, 'fetch', '-q', 'origin'); }
    // A profile branch's repair keeps the publication it starts from (threads.ts startRepair).
    if (fresh && !reviewing && PROFILE_BRANCH.test(branch)) startRepair(g, dir, branch);
    // A thread's later task starts with main merged into its branch; the files of a merge left in progress go in its
    // briefing (threads.ts).
    const conflicts = fresh && !reviewing && job.inThread && !job.session ? bringUpToDate(g, dir, branch, BASE) : [];
    if (conflicts.length) log(`job #${job.id}: bringing ${branch} up to date left a merge in progress: ${conflicts.length} files conflict`);

    // A paused job that was stopped saves its work and ends.
    if (job.stopping && !reviewing) return await stopWork(g, dir, branch, job, job.session ?? undefined, job.stopping);
    // A run that ended well but snagged on its push or pull request: this run lands it, from its kept clone or its
    // pushed branch and before the config strip below, without the agent (land).
    if (job.landing && !reviewing) {
      log(`job #${job.id}: landing its last run's work, which ended well`);
      g.settle(dir, cloneIdentity(job));
      // (no CLI ran, so there's no run record: a reload in its push's checks leaves the job to go stale and be requeued,
      // still landing, and it lands again: the push changes nothing, the pull request is found, the checks run again)
      return await land({ g, dir, branch, job, me, session: job.session ?? undefined, ...JSON.parse(job.landing) as Landing, spent, launches, failure: failed(0), keep: () => {}, again: true });
    }
    if (!job.session || fresh) runAs(me, 'rm', ['-rf', hqDir]);   // a new clone never reads a report planted on the branch
    // A branch's own project config (a planted hook or MCP server) never runs in a job: strip it from the clone each run,
    // a resumed one too (BRANCH_CONFIG, safety.ts).
    // Another CLI's own project config goes from a work job's clone it runs in, and every CLI's from a reviewer's.
    for (const f of [...BRANCH_CONFIG, ...other?.strip ?? []]) runAs(me, 'rm', ['-rf', '--', `${dir}/${f}`]);
    if (reviewing) for (const d of [...REVIEW_STRIP, ...CLI_CONFIG]) runAs(me, 'rm', ['-rf', '--', `${dir}/${d}`]);   // REVIEW_STRIP, safety.ts
    // A session of another CLI than this seat's can't go on here
    const { session: ownSession, switched } = resumeOn(cli, job.engine, job.session);
    const carried = ownSession || reviewing || !job.resumes ? null : carry(job, job.resumes, cli, seat, me);
    const session = ownSession ?? carried;
    const closingBriefing = session || reviewing || !job.closingReports ? ''
      : `\n\n${closingLines(job.closingReports, g.ag(dir, 'log', '--no-merges', '--format=%h %s', `origin/${BASE}..HEAD`))}`;
    runAs(me, 'mkdir', ['-p', hqDir]);
    runAs(me, 'chmod', ['700', hqDir]);
    await prepareHome(seat, job, me);
    const gatesRoots = { checkout: dir, readable: [`${WORK}/mirror.git`] };   // what a work job's gates may touch (completion.ts)
    // (a Codex work run hears HQ's word on memory after each tool call: inbox.ts)
    if (cli === 'codex') runAs(me, 'sh', ['-c', 'cat > "$1"', 'sh', `${home}/.codex/hooks.json`], JSON.stringify({ hooks: completionHooks(job.kind, { messages: (job.kind === 'work' || trying) && 'steps', ...gatesRoots }) }));
    const prompt = `${promptOf(job, mode, { dir, conflicts, ownSession, carried, switched, fresh, closing: closingBriefing })}\n\n${job.company.stylePrompt}`;
    const args = other ? other.run({ home, model, effort: effort ?? undefined, session, reviewing })
      : cli === 'codex'
      // Codex: automatic review of each action, sandboxed to the worktree (network allowed for installs and APIs).
      ? codexArgs(seat, ['exec', '--json', '--approve-for-me', '--dangerously-bypass-hook-trust', '-c', 'sandbox_workspace_write.network_access=true', '--skip-git-repo-check',
         ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
         ...(session ? ['resume', session] : []), '-'])
      // Claude Code: auto mode, where a classifier approves safe actions and blocks risky ones. A reviewer loads only user
      // settings (claudeArgs, safety.ts), so no branch-committed config runs while it reviews.
      : claudeArgs({ reviewing, model, effort, autocompact: autocompact == null ? undefined : String(autocompact), session,
          settings: { autoMode: AUTO_MODE, hooks: completionHooks(job.kind, { messages: true, ...gatesRoots }) },
          agents: reviewing || meeting ? [] : teamMember(dir, me) });
    first = launch(String(job.id), args, prompt, dir, await launchEnv());
    resumed = !!carried || (!!session && !newHome);
  }
  tooling.resumed = resumed;
  const run: Running = { job: job.id, seat: seat.id, session: job.session ?? undefined, spent, uid: me.uid, cli: first.launched,
    steady: false, stop: () => current.stop(), keep: () => {} };
  running.set(slot, run);
  let last = '', errors = '';
  let asking = false;   // the second launch runs: its session is its own, never the one the job resumes in
  const tagged = (id: string) => sessionTag(cli, job.engine, id);   // (clis.ts resumeOn)
  const verdictFile = written(dir, `${hqDir}/review.json`);   // a reviewer's, as its stream wrote it (verdict.ts).
  let how = outcome();   // how the run ended, as the CLI reports it (outcome.ts)
  // A downtime job asked to yield is stopped between steps, unless its run already ended; `stopped` then decides its
  // outcome, whatever the exit code.
  let ended = false, stopped = false;
  let current = first;   // (the second launch, once it runs)
  // What a pause stops besides the session, for the run that resumes it (the coordinator's cut): the commands it had
  // going (a test run in the background) and the team members still at work, whose sessions end with the lead's.
  let cut: { lost?: string[]; lostAt?: string } = {};
  const endRun = () => {
    cut = { lost: me.uid === undefined ? [] : processesOf(me.uid, first.launched.pid), lostAt: new Date().toISOString() };
    stopped = true; run.steady = false; current.stop();
  };
  const stop = () => { if (!ended && !stopped) endRun(); };
  // hq stop's: even a session that has answered and only waits for its background team members
  const halt = () => { if (!stopped) endRun(); };
  run.stop = halt;
  // A run taken over reads its output again from the start, for its state (its session, last message, verdict, team),
  // but what the last worker process already sent (HQ's lines, team, seat readings, a yield) isn't sent twice: quiet is

  let quiet = false;
  let replayTo = adopted?.read.out ?? 0;
  const lastSaid = new Map<string, number>();
  // (a job holding a customer's details: what agents can read gets the kind of step, the board's own view the step;
  // one handed them mid-run from the coordinator's next answer on, steps.ts guard)
  const guarded = guard(!!job.customers);
  // Everything the job shows in HQ is redacted first (agents echo command lines and error text). board: a job holding a
  // customer's details, its line itself for the board's own HQ session alone (steps.ts shown); guarded: the line is as
  // such a job shows it.
  const event = (e: { type: string; to?: string; add?: number; del?: number; grew?: number; total?: number; board?: string }, text: string, agent: string, max: number) =>
    quiet || ownershipSignal()?.aborted ? undefined : guarded.follow(agentApi(job.token, 'event', { ...e, text: preview(redact(text), max), ...(e.board ? { board: preview(redact(e.board), max) } : {}),
      ...(guarded.on ? { guarded: true } : {}), ...(agent !== job.agent ? { as: agent } : {}) }));
  const say = (text: string, agent = job.agent, board?: string) => {
    if (Date.now() - (lastSaid.get(agent) ?? 0) < 3000) return;
    lastSaid.set(agent, Date.now());
    event({ type: 'log', board }, text, agent, 200);
  };
  // The lines the job's branch changes against main (git.ts branchLines), read as the run begins and every LINES_MS,
  // sent when they change: HQ shows what this run changed (the branch may hold earlier rounds' work: from its first
  // reading). A day's lines come from main's history (the coordinator's commitlines.ts). A reviewer or a meeting's seat changes nothing to count.
  let lines: { add: number; del: number } | undefined, start: { add: number; del: number } | undefined, reading = false, unread = false;
  const countLines = async () => {
    if (ownershipSignal()?.aborted || !mode.changesBranch || reading) return;
    reading = true;
    try {
      const n = await branchLines(me, dir, BASE), was = lines;
      lines = n;
      start ??= n;
      if (!was) log(`job #${job.id}: its branch changes +${n.add} −${n.del} lines so far (read every ${LINES_MS / 1000} s)`);
      if (was && n.add === was.add && n.del === was.del) return;
      event({ type: 'lines', add: Math.max(0, n.add - start.add), del: Math.max(0, n.del - start.del) }, '', job.agent, 0);
    } catch (err) {
      // (a clone mid-rebase or without main: no reading this time; said once a run)
      if (!unread) log(`job #${job.id}: couldn't read its lines:`, (err as Error).message.split('\n')[0]);
      unread = true;
    } finally { reading = false; }
  };
  countLines();
  const lineCheck = setInterval(countLines, LINES_MS);
  // The tokens the run has written so far (what its steps wrote, steps.ts writtenTokens; for Codex at least its session
  // log's count, measure below), sent when they grew: HQ draws the work's pace with them.
  let tokensOut = 0, tokensTold = 0;
  const tellTokens = () => {
    if (ownershipSignal()?.aborted || tokensOut <= tokensTold) return;
    const grew = tokensOut - tokensTold;
    tokensTold = tokensOut;
    event({ type: 'tokens', total: tokensOut, grew }, '', job.agent, 0);
  };
  const tokenCheck = setInterval(tellTokens, TOKENS_MS);
  // a line of the job's own log in HQ's projects view (detailOf, steps.ts; the coordinator's log.ts), every one of them
  const logged = (line: Shown | null, agent = job.agent) => {
    if ((line?.text || line?.board) && !quiet) guarded.follow(agentApi(job.token, 'step', { text: redact(line.text ?? ''), ...(line.board ? { board: redact(line.board) } : {}),
      ...(guarded.on ? { guarded: true } : {}), ...(agent !== job.agent ? { as: agent } : {}) }));
  };
  // what an agent says between steps: a job holding a customer's details keeps it out of events and job_log text
  const speak = (words: string, agent = job.agent) => {
    const said = shown(guarded.on, g => g ? null : words);
    say(said?.text ?? '', agent, said?.board);
    logged(said, agent);
  };
  // Team members: sub-agents the lead (or a member) starts, keyed by the Agent tool call that started them.
  const members = new Map<string, { id: string; name: string }>(), working = new Set<string>();
  const who = (parentToolUse?: string | null) => (parentToolUse && members.get(parentToolUse)?.id) || job.agent;
  const slug = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'helper';
  const memberDone = (call: string) => {
    const m = members.get(call)!;
    working.delete(call);
    if (!quiet) hq.api('team', { job: job.id, lead: job.agent, id: m.id, name: m.name, state: 'idle', task: 'Done' }).catch(() => { /* HQ's team list is best effort */ });
  };
  // The output, a line (one event) at a time, split as bytes so a character cut between two reads stays whole. read: how
  // far it's been taken in, which a new worker process starts from (keep).
  let pending = Buffer.alloc(0);
  function onOut(piece: Buffer, end: number) {
    if (ownershipSignal()?.aborted) return;
    const all = Buffer.concat([pending, piece]), chunkStart = end - all.length;
    let from = 0;
    for (let nl; (nl = all.indexOf(10, from)) >= 0; from = nl + 1) {
      quiet = chunkStart + nl + 1 <= replayTo;
      onLine(all.subarray(from, nl).toString('utf8'));
    }
    quiet = false;
    pending = all.subarray(from);
  }
  // another CLI's stream line, as the Claude Code events it stands for (clis.ts)
  const cliState: Record<string, unknown> = {};
  function onLine(line: string) {
    let e: any; try { e = JSON.parse(line); } catch { return; }
    if (!other) {
      if (!quiet && !asking) tooling.observe(e);
      return onEvent(e);
    }
    for (const event of other.events(e, cliState)) onEvent(event);
  }
  function onEvent(e: any) {
    {
      // Claude Code stream-json
      if (e.session_id && !asking && tagged(e.session_id) !== run.session) { run.session = tagged(e.session_id); if (!quiet) run.keep(); }
      if (reviewing) see(verdictFile, e);
      tokensOut += writtenTokens(e);
      if (e.type === 'assistant') for (const c of e.message?.content ?? []) {
        const from = who(e.parent_tool_use_id);
        if (c.type === 'text') { if (!e.parent_tool_use_id && !e.error) last = c.text; speak(c.text, from); }
        if (c.type === 'tool_use') logged(shown(guarded.on, g => detailOf(c.name, c.input, g)), from);
        if (c.type === 'tool_use' && (c.name === 'Agent' || c.name === 'Task')) {
          const { name, task } = memberOf(c.input);
          members.set(c.id, { id: slug(name), name }); working.add(c.id);
          if (!quiet) hq.api('team', { job: job.id, lead: job.agent, id: slug(name), name, parent: from, state: 'working',
            task: redact(task).slice(0, 120) }).catch(() => {});
        } else if (c.type === 'tool_use' && c.name === 'SendMessage') {
          event({ type: 'chat', to: slug(c.input?.to ?? '') }, String(c.input?.summary ?? c.input?.message ?? ''), from, 160);
        } else if (c.type === 'tool_use') {
          const s = shown(guarded.on, g => stepOf(c.name, c.input, g)?.text);
          if (s?.text) say(s.text, from, s.board);   // a step in plain words (steps.ts).
        }
      }
      // A member is done when its Agent call comes back with its work (steps.ts memberReturned), or a background one's

      if (e.type === 'user') {
        for (const c of e.message?.content ?? []) {
          const startedMember = c.type === 'tool_result' && members.has(c.tool_use_id);
          if (startedMember && memberReturned(e, c)) memberDone(c.tool_use_id);
        }
      }
      if (e.type === 'system' && e.subtype === 'task_notification' && members.has(e.tool_use_id)) memberDone(e.tool_use_id);
      // Seat health: stop giving this seat new work when its 5-hour (or weekly) window is nearly used up.
      if (e.type === 'rate_limit_event' && !quiet) windows(seat, e);
      if (e.type === 'result') { ended = true; if (e.result && !e.is_error) last = e.result; }
      observe(how, e);
      // Codex JSONL
      if (e.type === 'thread.started' && !asking && tagged(e.thread_id) !== run.session) { run.session = tagged(e.thread_id); if (!quiet) run.keep(); }
      if (e.type === 'item.completed' && e.item?.type === 'agent_message') { last = e.item.text; speak(e.item.text); }
      if (e.type === 'item.started' && e.item?.type === 'command_execution') {
        const s = shown(guarded.on, g => g ? 'Running a command' : `$ ${e.item.command}`)!;
        say(s.text!, job.agent, s.board);
        logged(s);
      }
      account(spent, e, model, resumed, quiet ? undefined : Date.now());   // its token use, and whether it started anyone (spent.ts; now)
      if (e.type === 'turn.completed') ended = true;
      // yielding: stop between steps (a tool's result is in, Claude's or Codex's), so it resumes cleanly. Not after a
      // Codex reply: its last one comes just before turn.completed, and a finished job would be reported as paused.
      if (!quiet && (yielding.has(job.id) || drained.has(job.id)) && (e.type === 'user' || e.type === 'item.completed' && CODEX_STEPS.has(e.item?.type))) stop();
    }
  }
  // Its record, written at launch and kept up to date: a new worker process takes the run over from it (handOver), and a
  // start after a stop the run never heard of (the server went down) hands it back, with what it had running at its last

  const at = { out: 0, err: 0 };   // (a run taken over reads its files again from the start: replayTo)
  let lastLook: Pick<RunRecord, 'lost' | 'lostAt'> = { lost: adopted?.lost, lostAt: adopted?.lostAt };   // (kept by every save, not only the ones that look)
  const recordNow = (): RunRecord => ({ job, seat: seat.id, slot, resumed, launched: first.launched,
    read: { out: at.out - pending.length, err: at.err }, session: run.session, usage: spent.usage, handed: handed.get(job.id), ...lastLook });
  run.keep = (look = false) => {
    if (ownershipSignal()?.aborted) return;
    if (look) lastLook = { lost: me.uid === undefined ? [] : processesOf(me.uid, first.launched.pid), lostAt: new Date().toISOString() };
    keepRecord(RUNS, recordNow());
  };
  run.keep(true);
  launches.push(first.launched);
  await first.sent;   // (a reload before the prompt is in the CLI's pipe would cut a long one)
  run.steady = true;
  if (stopAsked.has(job.id)) halt();   // (a paused job stopped while it waited)
  const looking = setInterval(() => { try { run.keep(true); } catch (err) { log(`job #${job.id}: run record:`, err); } }, 60_000);
  // a step that never ends (a long build, no output) still yields in time
  // (and a job stopped with hq stop, at once)
  // A quick run stops at the end of its turn on the chat slot (the coordinator's quickruns.ts QUICK_RUN_MS), which a
  // reload doesn't renew: its run record keeps the job as claimed.
  let overtime = false;
  const yieldCheck = setInterval(() => {
    if (mode.quickRun && Date.now() >= mode.quickRun.until) {
      overtime = true;
      killAll(me);
      stop();
      return;
    }
    if (stopAsked.has(job.id)) {
      halt();
      return;
    }
    const asked = yielding.get(job.id)?.at ?? drained.get(job.id);
    if (yielding.get(job.id)?.immediate || (asked && Date.now() - asked > YIELD_MS)) stop();
  }, 5_000);
  // a Codex seat's window is read from the run's session log while it runs, and once more at the end
  const started = Date.now(), measure = async () => {
    if (ownershipSignal()?.aborted) return;
    const output = await codexWindow(seat, me, home, resumeOn(cli, job.engine, run.session).session ?? undefined, started);
    if (output !== undefined) tokensOut = Math.max(tokensOut, output);
  };
  const measuring = cli === 'codex' ? setInterval(measure, 60_000) : undefined;
  const stopTimers = () => {
    clearInterval(looking); clearInterval(yieldCheck); clearInterval(measuring); clearInterval(lineCheck); clearInterval(tokenCheck);
  };
  ownershipSignal()?.addEventListener('abort', stopTimers, { once: true });
  // Another CLI's own account of how its run ended (clis.ts export), read once it has exited, as its stream's last line
  function cliEnded(h: string, exitCode: number) {
    if (!other?.export) return;
    const file = `${h}/${other.export}`, text = readAs(me, file);
    runAs(me, 'rm', ['-f', file]);
    cliState.exitCode = exitCode;
    if (text !== undefined && text.length < 1_000_000) onLine(text.replace(/\n/g, ' '));
  }
  // the stderr handler, for the second launch too
  function onErr(d: Buffer) {
    if (ownershipSignal()?.aborted) return;
    errors += d;
    if (errors.length > 20_000) errors = errors.slice(-10_000);
  }
  await follow(first.launched, at, first.ended, onOut, onErr);
  run.steady = false;
  clearInterval(looking);
  let code = await first.code();
  cliEnded(home, code);
  // CLIs without completion hooks may confirm a witnessed verdict after exit (askAgainPrompt, verdict.ts), in an
  // empty home that inherits no branch instructions. Claude Code and Codex correct answers in their Stop hooks.
  async function askVerdictAgain(ask: string) {
    const reviewAuth = handed.get(job.id), reviewFiles = handedFiles.get(job.id);
    let confirmationHome: string | undefined;
    try {
      killAll(me);
      keepSignIn(me, seat, home, job.id);
      confirmationHome = askHome(me, jobDirs(WORK, job.id).confirmationHome);
      await prepareHome(seat, job, me, confirmationHome);
      runAs(me, 'mkdir', ['-m', '700', `${confirmationHome}/work`]);
      log(`job #${job.id}: ended without its verdict as JSON, asking a fresh session once whether the verdict it wrote stands`);
      // the second launch's own state: its outcome, errors and events, its tokens on top of the first's
      how = outcome();
      errors = '';
      pending = Buffer.alloc(0);
      replayTo = 0;
      ended = false;
      relaunched(spent);
      asking = true;
      answering(verdictFile, { logRequired: cli === 'codex' });
      const askArgs = other ? other.ask({ home: confirmationHome, model, effort: effort ?? undefined })
        : cli === 'codex' ? codexArgs(seat, codexAskArgs({ model: model ?? undefined, effort: effort ?? undefined }))
        : [...claudeArgs({ reviewing, model: model ?? undefined, effort: effort ?? undefined, settings: { autoMode: AUTO_MODE } }), '--tools', ''];
      current = launch(`${job.id}.ask`, askArgs, ask, `${confirmationHome}/work`, await launchEnv(confirmationHome));
      launches.push(current.launched);
      run.cli = current.launched;
      await follow(current.launched, { out: 0, err: 0 }, current.ended, onOut, onErr);
      code = await current.code();
      cliEnded(confirmationHome, code);
      if (cli === 'codex') {
        killAll(me);
        seeSessionLogs(verdictFile, sessionLogs(`${confirmationHome}/.codex/sessions`));
      }
      last = verdictFromAnswer(verdictFile, last);
    } catch (err) {
      // A confirmation that failed part-way has no verdict, whatever it answered.
      if (asking) last = 'No verdict: the session asked whether the verdict stands ended in an error.';
      log(`job #${job.id}: ended without its verdict as JSON, and couldn't be asked again:`, err);
    } finally {
      if (confirmationHome !== undefined) {
        try { keepSignIn(me, seat, confirmationHome, job.id); } catch (err) { log(`job #${job.id}: ${cli} sign-in:`, err); }
        try { remove(confirmationHome); } catch (err) { log(`job #${job.id}: couldn't remove the confirmation's home:`, err); }
      }
      // settle saves from the review's home, whose sign-in has its own baseline.
      if (reviewAuth === undefined) handed.delete(job.id);
      else handed.set(job.id, reviewAuth);
      if (reviewFiles === undefined) handedFiles.delete(job.id);
      else handedFiles.set(job.id, reviewFiles);
    }
  }
  // A Codex session's logs under `sessions`, each read as the job's slot, or undefined if any can't be.
  function sessionLogs(sessions: string) {
    const files = runAs(me, 'find', [sessions, '-type', 'f', '-name', '*.jsonl']).split('\n').filter(Boolean);
    const logs = files.map(f => readAs(me, f));
    return logs.every(l => l !== undefined) ? logs : undefined;
  }
  // one it can't ask says why in the log (cantAsk, verdict.ts).
  const askable = !ownershipSignal()?.aborted && !!other && reviewing && code === 0 && !stopped && !shuttingDown;
  const ask = askable ? askAgainPrompt(verdictFile, last) : undefined;
  if (ask !== undefined) await askVerdictAgain(ask);
  else if (askable && lacksVerdict(verdictFile, last)) log(`job #${job.id}: ended without its verdict as JSON, not asked again: ${cantAsk(verdictFile)}`);
  clearInterval(yieldCheck); clearInterval(measuring); clearInterval(lineCheck); clearInterval(tokenCheck);
  ownershipSignal()?.removeEventListener('abort', stopTimers);
  assertOwned();
  await countLines();   // (its last edits, before the commit at the end)
  if (cli === 'codex') await measure();
  running.delete(slot);
  killAll(me);   // whatever it left running can't change its report or commits from here on

  if (shuttingDown) return {};
  const session = run.session;
  if (overtime) return { status: 'failed', session, overtime, result: 'Stopped at its quick-run deadline' };
  // An emergency stop preserves its work without starting review.
  const stopWhy = stopAsked.get(job.id);
  const pauseCut = () => ({ ...(cut.lost?.length ? cut : {}), ...(working.size ? { members: [...working].map(c => members.get(c)!.name) } : {}) });
  if (stopWhy) log(`job #${job.id}: ended by hq stop`);
  // A job stopped because its seat drained: it resumes in this session, from its kept clone, on a seat with room or after
  // the reset (a Codex job waits for its own seat, whatever the others have free). A downtime job stopped to make room: the same, at the next spare capacity.
  if (stopped && !stopWhy && drained.has(job.id)) {
    log(`job #${job.id}: paused at a step, ${seat.id} is draining (the rest is the board's)`);
    return { status: 'limited', session, resetAt: retryAt(seat, !!pickSeat(seat.engine, seat)), ...pauseCut() };
  }
  if (stopped && !stopWhy) return { status: 'yielded', session, ...pauseCut() };
  if (stopWhy) {
    const lastMessage = last.trim();
    const quoted = lastMessage ? `\n\nIts last message:\n\n${lastMessage}` : '';
    last = `Stopped by ${stopWhy}.${quoted}`;
  }
  // The job's report (a chat's reply, a call's notes) is its whole last message; the cap only stops a runaway, visibly.
  const result = whole(redact(last.trim()), 100_000);
  // A limit or a sign-out is decided from the CLI's own signals, never from what the model wrote (outcome.ts).
  const cause = code !== 0 && !stopWhy ? verdict(how, cli, errors, other?.errors) : undefined;
  seat.limits = cause === 'limited' ? (seat.limits ?? 0) + 1 : 0;
  seat.refusals = cause === 'refused' ? (seat.refusals ?? 0) + 1 : 0;
  const failure = failed(code);
  // What the seat was told, in the CLI's own error (Codex's turn's, Claude's own message), or the first line of a CLI
  // that died before any event, as for a failed job below: never stderr past that.
  const told = cause && preview(redact(plain(how.failure ?? (how.cli.trim() || (how.events ? '' : errors.trim().split('\n')[0])))).trim(), 200);
  // An account its provider closed: no sign-in card that can't work, and no other seat takes its share (close). The job
  // goes back to the queue, for its seat.
  if (cause === 'closed') { close(seat, told || 'account deactivated'); return { status: 'interrupted', session }; }
  // A Codex run's failed sign-in that isn't the seat's (refreshes.ts signedOut) failed only its own copy.
  if (cause === 'auth' && cli === 'codex' && !refreshes.signedOut(seat.id)) {
    log(`job #${job.id}: its sign-in failed, but the provider hasn't refused ${seat.id}'s: back to the queue, the seat still signed in`);
    return { status: 'interrupted', session };
  }
  if (cause === 'auth') {
    log(`${seat.id}: signed out, the board signs it in again in Seats: ${told}`);
    as('rm', ['-f', ...signInFiles(seat)]);
    seat.state = 'login'; reportSeat(seat);
    return { status: 'interrupted', session };
  }
  if (cause === 'limited') {
    // This seat sleeps; the job resumes in the same session on another seat if one is free (a Codex job waits for its own
    // seat instead), else after the reset (a full window's, when the seat's readings show one: sleepUntil).
    seat.state = 'sleeping'; seat.until = sleepUntil(limitReset(how, errors, seat.limits), seat); seat.checked = Date.now(); reportSeat(seat);
    log(`${seat.id}: limit reached, sleeping until ${new Date(seat.until).toISOString()}: ${told}`);
    // (back in the queue until the seat's next check if it's a held Codex seat, not the hold's end: retryAt)
    return { status: 'limited', session, resetAt: retryAt(seat, !!pickSeat(seat.engine, seat)) };
  }
  // A seat whose first request the API refused (outcome.ts) sends something wrong for every job: it sleeps, 30 minutes
  // doubling up to 5 hours, so the panel counts it out (the coordinator's codexSeatOut: normal rounds go on without
  // Codex) instead of every review failing on it while it reads ready. Held, it still takes one job an hour as its
  // check (checkDue), and a run that isn't refused ends it. The job fails as before, with the error in its report.
  seat.refused = cause === 'refused' ? told || 'invalid request' : undefined;
  if (cause === 'refused') {
    seat.state = 'sleeping'; seat.until = Date.now() + Math.min(30 * 60e3 * 2 ** ((seat.refusals ?? 1) - 1), 5 * 3600e3);
    seat.checked = Date.now(); reportSeat(seat);
    log(`${seat.id}: its runs are refused, sleeping until ${new Date(seat.until).toISOString()}: ${told}`);
  }

  // A quick run's answer is its last message: nothing in its clone is committed or pushed, and one stopped has none.
  if (mode.quickRun) return code !== 0 || stopWhy
    ? { status: 'failed', session, result: failure(result, `${how.cli} ${errors}`) }
    : { status: 'done', session, result };

  g.settle(dir, cloneIdentity(job));   // (nothing the session set in its clone's git config runs in the worker's git)
  if (reviewing) {
    // The verdict whole (review.ts parses the consolidator's as JSON: a cut one would read as no verdict at all), redacted
    // like the report, value by value so it stays JSON: it goes into the consolidator's and the author's prompts. It's
    // taken from the CLI's stream, never from the file, which a process the review left behind can rewrite (verdict.ts).
    const verdictText = verdictOf(verdictFile, last);
    const touchup = code === 0 ? await touchUp(g, dir, job, verdictText) : undefined;
    return { status: code === 0 ? 'done' : 'failed', session, output: whole(redactJson(verdictText), 200_000), result: code === 0 ? result : failure(result, `${how.cli} ${errors}`), touchup };
  }
  // A meeting's seat leaves its outcome in its agent's plans, so nothing in its clone is committed or pushed; nor a try
  // run's, whose versions are in the book.
  if (meeting || trying) return code !== 0 && !stopWhy ? { status: 'failed', session, result: failure(result, `${how.cli} ${errors}`) } : { status: 'done', session, result };

  if (stopWhy) return await stopWork(g, dir, branch, job, session, stopWhy, result);
  const parked = readAs(me, `${hqDir}/request.json`);
  // A run handed up to its agent's own model (hq up) keeps its work on its branch and in its clone, like a parked one,
  // whatever its exit code: the coordinator queues the job again at once (jobs.ts handUp).
  const up = parked === undefined ? readAs(me, `${hqDir}/up.json`) : undefined;
  // A run that didn't end well keeps its work on its branch, with no pull request. A refused push (say, workflow files
  // with a token that may not change them), or one that never reached GitHub in all its tries (git.ts pushToGitHub),
  // fails the job with the reason.
  if (parked !== undefined || up !== undefined || code !== 0) {
    const to: Pushed = {};
    try { await pushRun(g, dir, branch, job, to); }
    catch (err) { return { status: 'failed', session, branch, profile: to.profile, result: failure(result, `the push failed: ${String((err as Error).message ?? err)}`) }; }
    // (photo and document fields too: outcome.ts parkedRequest.)
    // (its own pushed commit, kept for a later run that adds none: threads.ts ownCommit)
    const sha = to.pushed && ownCommit(g, dir, branch, BASE, to.pushed.sha);
    if (parked !== undefined) return { status: 'parked', session, branch, sha, profile: to.profile, request: parkedRequest(parked) };
    if (up !== undefined) return { status: 'up', session, branch, sha, profile: to.profile, up: upNote(up) };
    // how it failed, in the CLI's own signals and never its words, for the server's log: a report may hold a
    // customer's details, which stay out of logs (an intercom turn failing on every resume, 2026-10-02)
    log(`job #${job.id}: failed, exit ${code}${how.error ? `, ${how.error}` : ''}${how.status ? `, HTTP ${how.status}` : ''}${how.events ? `, after ${how.events} events` : ', before any event'}${job.session ? ', resumed' : ''}`
      // one that died starting up (no reply yet): the CLI's own first error line, which holds no conversation
      + (how.events <= 1 ? `: ${preview(redact(plain(errors)).trim().split('\n')[0] ?? '', 200)}` : ''));
    return { status: 'failed', session, branch, sha, profile: to.profile, result: failure(result, `${how.cli} ${errors}`) };
  }
  return await land({ g, dir, branch, job, me, session, summary: last, result, spent, launches, failure, keep: checks => { if (!ownershipSignal()?.aborted) keepRecord(RUNS, { ...recordNow(), checks }); } });
}

// How a job's run differs by its kind: a reviewer's (review, consolidate) judges one commit, a meeting's seat and a try
// run leave their outcome in HQ, and a quick run (the coordinator's quickruns.ts) gives one answer within its turn on
// the chat slot. Every Claude run but a reviewer's and a quick run's shares the agent's memory (copyback.ts), and only
// a run that may change its branch has lines to count and commits.
function runModeOf(job: Job) {
  const reviewing = job.kind === 'review' || job.kind === 'consolidate', meeting = job.kind === 'meeting', trying = job.kind === 'try';
  const quickRun = job.quickReply ? { until: job.quickReplyUntil! } : undefined;
  return { reviewing, meeting, trying, quickRun, sharesMemory: !reviewing && !quickRun, changesBranch: !reviewing && !meeting && !trying && !quickRun };
}
type RunMode = ReturnType<typeof runModeOf>;

// A run's prompt: a quick run's own briefing; a resumed session's note (the intercom's every turn, work back from the
// board) with what's in flight now and what a stop of the worker's container cut (the coordinator's cut); a session
// carried from its author's last run on the branch (carry); else its kind's briefing (a work run's with its closing
// reports), saying so when its CLI switched.
function promptOf(job: Job, mode: RunMode, run: { dir: string; conflicts: string[]; ownSession?: string | null; carried?: string | null; switched: boolean; fresh: boolean; closing: string }) {
  const note = job.note ? `\n\n${job.note}` : '', cut = job.cut ? `\n\n${job.cut}` : '', inFlight = job.inFlight ? `\n\n${job.inFlight}` : '';
  if (mode.quickRun) return quickBriefing(job);
  if (run.ownSession) return (job.note ?? 'Continue where you left off.') + cut + inFlight;
  if (run.carried) return `${carriedNote(job, run.dir)}\n\n${inThreadLines(job, run.conflicts)}${job.prompt}${note}${inFlight}`;
  const newSession = run.switched && !mode.reviewing && !run.fresh ? `\n\n${SWITCHED}${cut}` : '';
  // (a hand-up's run hears why it was handed up: lighter.ts handedUpLines)
  const handedUp = job.handedUp && !mode.reviewing ? `\n\n${handedUpLines(job.handedUp)}` : '';
  const brief = BRIEFINGS[job.kind]?.(job, run.dir, run.conflicts) ?? briefing(job, run.dir, run.conflicts, run.closing);
  return brief + newSession + handedUp + note;
}
const BRIEFINGS: Record<string, (job: Job, dir: string, conflicts: string[]) => string> = { review: reviewBriefing, consolidate: reviewBriefing, meeting: meetingBriefing, try: tryBriefing };

// hq up's note (up.json), whole as the agent wrote it: a file hq up didn't write fails the run, as a request.json that doesn't parse does.
function upNote(json: string) {
  const { note } = JSON.parse(json) as { note?: unknown };
  if (typeof note !== 'string' || !note.trim()) throw new Error('up.json has no note: hq up writes one');
  return whole(redact(note.trim()), 20_000);
}

async function stopWork(g: ReturnType<typeof flow.forAgent>, dir: string, branch: string, job: Job, session: string | undefined, why: string, result = `Stopped by ${why}`) {
  const to: Pushed = {};
  g.settle(dir, cloneIdentity(job));
  try { await pushRun(g, dir, branch, job, to); }
  catch (err) { return { status: 'failed', session, branch, profile: to.profile, result: failed(0)(result, `the push failed: ${String((err as Error).message ?? err)}`) }; }
  // (its own pushed commit: threads.ts ownCommit)
  return { status: 'stopped', session, branch, sha: to.pushed && ownCommit(g, dir, branch, BASE, to.pushed.sha), profile: to.profile, result: whole(redact(result), 100_000) };
}

// What went wrong, in the CLI's words, for a failed job's report (after the model's own last message).
const failed = (code: number) => (report: string, why: string) =>
  [report, `The run ended with an error: ${tail(redact(plain(why)).trim(), 1500) || `exit code ${code}`}`].filter(Boolean).join('\n\n');

// A run's work pushed (into `to`, so a push that fails partway still says what got through). A thread's task sends its
// own profile lines to main first, and every finish after says so (profileToMain).
type Pushed = { pushed?: { sha: string; files: string[]; links: string[]; frontmatter: { path: string; text: string | null }[]; knowledge: { docs: { path: string; text: string }[]; files: string[] };
  pushedSince?: { sha: string; files: string[] }; lines: Record<string, [number, number][]>; settings: { path: string; before: string | null; after: string | null }[] }; profile?: Profile; withdrawn?: boolean };   // (settings; lines)
async function pushRun(g: ReturnType<typeof flow.forAgent>, dir: string, branch: string, job: Job, to: Pushed, landing = false) {
  commitWork(g, dir, job);
  if (job.inThread) to.profile = await profileToMain(g, dir, branch, job);
  if (PROFILE_BRANCH.test(branch)) {
    to.pushed = await profileRepair(g, dir, branch, job);
    to.withdrawn = !to.pushed;
  }
  else to.pushed = await pushWork(g, dir, branch, landing && job.stage === 'fix');
}

// A run that ended well lands: its work pushed (pushRun), its pull request opened (its body the session's last message,
// summary), then its push's checks (afterPush). A push that never reached GitHub (git.ts PushUnreachedError), or a pull
// request GitHub couldn't be reached for, is the worker's own snag, not the agent's: the job goes back in the queue with
// what landing it takes (jobs.ts finish), and its next run only does this (again), where a clone and branch without the
// work fail it, visibly.
type Landing = { summary: string; result: string };
async function land(o: Landing & { g: ReturnType<typeof flow.forAgent>; dir: string; branch: string; job: Job; me: Me; session?: string; spent: Spent;
  launches: Launched[]; keep: (checks: Checks) => void; failure: (report: string, why: string) => string; again?: boolean }): Promise<Record<string, unknown>> {
  const { g, dir, branch, job, session, summary, result } = o, to: Pushed = {};
  // (its own pushed commit, which a later landing run's push of the same head doesn't report: threads.ts ownCommit)
  const own = () => to.pushed && ownCommit(g, dir, branch, BASE, to.pushed.sha);
  const snagged = (why: string) => {
    log(`job #${job.id}: ${why}, so it goes back in the queue to land`);
    return { status: 'snagged', session, branch, sha: own(), profile: to.profile, result: o.failure(result, why), landing: { summary, result } };
  };
  try { await pushRun(g, dir, branch, job, to, true); }
  catch (err) {
    const why = `the push failed: ${String((err as Error).message ?? err)}`;
    return err instanceof PushUnreachedError ? snagged(why) : { status: 'failed', session, branch, profile: to.profile, result: o.failure(result, why) };
  }
  const { pushed, profile, withdrawn } = to;
  if (!pushed && !withdrawn && o.again) return { status: 'failed', session, branch, profile, result: o.failure(result, 'its work was in neither its clone nor its branch any more, so there was nothing to land') };
  // A thread's task opens the thread's pull request, under the thread's name.
  let thread: { pull?: Pull } | undefined;
  try { if (pushed && job.inThread) thread = await hq.report('thread-push', { job: job.id }); }
  catch (err) { return { status: 'failed', session, branch, sha: own(), profile, result: o.failure(result, `the deliverable's pull request couldn't be named: ${String((err as Error).message ?? err)}`) }; }
  const pr = pushed ? await openPullRequest(branch, await jobPullRequest(job, summary, thread?.pull)) : undefined;
  if (pr === 'unreached') return snagged("GitHub couldn't be reached to open its pull request");
  // Refused, the work stays on its branch, and the run fails with GitHub's reason: its sha makes the branch its thread's
  // (the coordinator's threadorder.ts pushed), so a task taking its place pushes there and opens the pull request
  if (typeof pr === 'object') return { status: 'failed', session, branch, sha: pushed!.sha, profile, result: o.failure(result, `its work is pushed to ${branch}, but GitHub refused its pull request: ${pr.refused}`) };
  const body = { status: 'done', session, branch, pr, files: pr ? pushed!.files : [], links: pr ? pushed!.links : [], frontmatter: pr ? pushed!.frontmatter : [], knowledge: pr ? pushed!.knowledge : undefined, pushedSince: pr ? pushed!.pushedSince : undefined,
    lines: pr ? pushed!.lines : undefined, settings: pr ? pushed!.settings : [], sha: pr ? pushed!.sha : undefined, result, profile, ...(withdrawn && { withdrawn }) };   // (settings) (withdrawn: profileRepair)
  if (!pr) {
    if (pushed) await keepRendersOf(job, o.me, dir, pushed.files);
    return body;
  }
  return await afterPush(job, o.me, dir, { body, spent: { ...o.spent }, runs: {} }, o.keep, o.launches);
}

// The consolidator's touch-ups on a ruling (review.ts): its own safe fixes, pushed as one commit when the coordinator let
// it write (job.writes) and its verdict lists them with a merge or changes. The commit holds only the files the verdict
// lists them in. Refused, the reason goes back instead, and the author makes those fixes.
type Touchup = { sha: string; files: string[] } | { refused: string };
async function touchUp(g: ReturnType<typeof flow.forAgent>, dir: string, job: Job, verdictText: string): Promise<Touchup | undefined> {
  const writes = parseList(job.writes), listed = touchedFiles(verdictText);
  if (job.kind !== 'consolidate' || !writes.length || !listed.length || !job.sha || !job.branch) return undefined;
  const name = job.agentInfo?.name ?? job.agent;
  const commit = { message: `${name}: touch-ups from the review (job #${job.id})`, name: `${name} (${company(job).name})`, email: `${job.agent}@${company(job).agentEmailDomain}` };
  try { return await g.touchUp(dir, job.branch, job.sha, writes.filter(f => listed.includes(f)), commit); }
  catch (err) {
    const refused = redact(String((err as Error).message ?? err)).slice(0, 300);
    log(`job #${job.id}: touch-ups not pushed: ${refused}`);
    return { refused };
  }
}

// The identity of a job's clone, for commits made in it without an author of their own (git.ts clone, settle)
const cloneIdentity = (job: Job) => ({ name: `${company(job).name} agents`, email: company(job).agentsEmail });

// Commits as the agent, completing a merge of main the session was left to resolve (threads.ts bringUpToDate). The push
// goes through root's mirror (git.ts), which only accepts job/<n>.
function commitWork(g: ReturnType<typeof flow.forAgent>, dir: string, job: Job) {
  const { ag } = g, author = authorOf(job);
  ag(dir, 'add', '-A');
  if (ag(dir, 'status', '--porcelain') !== '')
    ag(dir, '-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-q', '-m', `${nameOf(job)}: ${job.title} (job #${job.id})`);
}
async function pushWork(g: ReturnType<typeof flow.forAgent>, dir: string, branch: string, resync: boolean) {
  const files = g.ag(dir, 'diff', '--name-only', `origin/${BASE}...HEAD`);
  const remote = `refs/remotes/origin/${branch}`;
  const onOrigin = g.ag(dir, 'for-each-ref', '--format=%(refname)', remote);
  const updated = onOrigin && g.ag(dir, 'diff', '--name-only', remote, 'HEAD');
  if (!files && !updated) return undefined;
  return resync ? g.pushUpdated(dir, branch) : g.push(dir, branch);
}
const nameOf = (job: Job) => job.agentInfo?.name ?? job.agent;
const authorOf = (job: Job) => ({ name: `${nameOf(job)} (${company(job).name})`, email: `${job.agent}@${company(job).agentEmailDomain}` });

// A thread task's own profile and archive lines go to main on profile/<its id>, as a pull request the coordinator merges
// unreviewed, so the agent's next job elsewhere reads them, and off the thread's branch once published (threads.ts
// splitProfile). A failure fails the run before the thread's push, and the run again sends what was never published.
// Its pull request goes in the finish.
type Profile = { pr: number; branch: string; sha: string; files: string[] };
async function profileToMain(g: ReturnType<typeof flow.forAgent>, dir: string, branch: string, job: Job): Promise<Profile | undefined> {
  const author = authorOf(job), paths = profilePaths(job.agent), profileBranch = `profile/${job.id}`;
  const title = `${nameOf(job)}: profile lines from job #${job.id}`;
  const body = `${nameOf(job)}'s own profile and archive lines from job #${job.id}, apart from its deliverable's branch (${branch}).`;
  const lines = splitProfile(g, dir, { base: BASE, branch: profileBranch, paths, message: title, author });
  if (!lines) return undefined;
  const pushed = lines.push ? await g.pushProfile(dir, profileBranch, lines.ref, paths, lines.over) : { sha: lines.sha, files: lines.files };
  restoreProfile(g, dir, { ...lines, sha: pushed.sha }, { base: BASE, branch: profileBranch, message: `${nameOf(job)}: profile lines to main on ${profileBranch} (job #${job.id})`, author });
  if (!lines.open) return undefined;
  const pr = await openPullRequest(profileBranch, { title, body });
  if (typeof pr !== 'number') throw new Error(`no pull request opened for ${profileBranch}${typeof pr === 'object' ? `: GitHub refused it (${pr.refused})` : ''}`);
  return { pr, branch: profileBranch, sha: pushed.sha, files: pushed.files };
}
// A fix job on a profile branch (a merge with main, a key taken out: review.ts fixJob) pushes its repair as the branch's
// one commit on main again (threads.ts rebuildProfile), never as a job branch. A repair that leaves nothing for main
// withdraws the branch, and its finish says so (withdrawn), for HQ to close the pull request. Either only while the
// branch is still at the publication the repair started from.
async function profileRepair(g: ReturnType<typeof flow.forAgent>, dir: string, branch: string, job: Job) {
  const paths = profilePaths(job.agent);
  const lines = rebuildProfile(g, dir, { base: BASE, paths, message: `${nameOf(job)}: ${job.title} (job #${job.id})`, author: authorOf(job) });
  if (!lines) {
    await g.withdrawProfile(branch, repairFrom(g, dir));
    return undefined;
  }
  const { sha, files } = await g.pushProfile(dir, branch, lines.ref, paths, lines.over);
  return { sha, files, links: [], frontmatter: [], knowledge: { docs: [], files: [] }, lines: {}, settings: [] };
}

// A job's pull request: its title, and its body the session's last message, masked by the coordinator first; one it
// can't mask stays in HQ. A thread's (thread-push's pull): the thread's name, its "done when" and tasks before the report.
async function jobPullRequest(job: Job, summary: string, thread?: Pull) {
  const report = await mask(summary).catch(err => { log(`job #${job.id}: PR body not masked:`, err); return null; });
  // (GitHub takes 65,536 characters: a longer body would leave the job without a pull request, and unreviewed)
  const body = `${thread ? `${whole(redact(thread.body), 4_000)}\n\n` : ''}${report === null ? `The report is in HQ (job #${job.id}).` : whole(redact(report), 55_000)}\n\nJob #${job.id}, by ${job.agent}. Awaiting the review panel.`;
  return { title: thread ? thread.title : `${nameOf(job)}: ${job.title}`, body };
}

// The pull request for a branch, opened or found (pulls.ts)
const openPullRequest = (branch: string, pull: { title: string; body: string }) => openOn({ repo: REPO!, token: GITHUB_TOKEN!, base: BASE }, branch, pull, log, ownershipSignal());

// The gates (shared/gates/gates.ts: Prettier, ESLint, the type check) and the tests of the areas it touches
// (shared/gates/tests.ts) on what the pushed branch changes against main, each run as the job's own user in its clone,
// without holding up the other slots. Passed, failed (the review sends it back before the panel: review.ts startReview)
// or not run (null: they broke, which the review logs). A branch from before them has no script, and no report.
// Each runs to its end, its seconds in the log (pushchecks.ts outcomeOf).
const GATES = 'shared/gates/gates.ts';
// The gates' launch that sends them to a lent machine's helper (gates.ts --helper) has a limit of its own: the wait for a
// helper to take them (HQ's takeMinutes), their run's time on the helper (gates.ts HELPER_MINUTES, which HQ's runs.ts
// needs), and a minute to bundle and send them. Its stop ends the run on HQ (lent.ts), and with no verdict from there
// they launch here, to their end (pushchecks.ts).
const GATES_HELPER_MS = 5 * 60_000;
const gatesLentMs = (takeMinutes: number) => takeMinutes * 60_000 + GATES_HELPER_MS + 60_000;
const TESTS = 'shared/gates/tests.ts';
type CheckName = 'gates' | 'tests';   // (each one's field in the finish report)
const CHECKS: Record<CheckName, string> = { gates: GATES, tests: TESTS };
// Two pushes' tests at a time here, the rest waiting their turn: a node --test run takes every core, so more at once
// slow each other down. While a lent machine has a helper of the `tests` kind (the coordinator's runs.ts), they go
// there instead, with no turn: tests.ts --helper sends them as a run of the job, waits for it while it's there, and runs
// them here only once it's gone.
// The gates go there too (gates.ts --helper), when their type check runs.
const testsTurn = fewAtOnce(2);
const TESTS_KIND = 'tests';
// HQ's takeMinutes while a lent machine has a helper of the kind, else undefined
async function testsHelper(job: Job) {
  try {
    const res = await fetch(`${HQ}/api/agent/runs/helper`, { headers: { authorization: `Bearer ${job.token}` }, signal: requestSignal(AbortSignal.timeout(10_000)) });
    const { kinds, takeMinutes } = await res.json() as { kinds?: { name: string; present: boolean }[]; takeMinutes: number };
    return kinds?.some(kind => kind.name === TESTS_KIND && kind.present) ? takeMinutes : undefined;
  } catch { return undefined; }
}
// The suites the change would run (shared/gates/suites.ts), asked first and with no turn: a change with none has its
// report at once, so a job that changed only notes or profiles ends with its push, never behind other pushes' suites
// (where it would also hold a reload's handover, which waits for it). Any other answer (suites to run, a branch from
// before the script) waits its turn for the tests.
const SUITES = 'shared/gates/suites.ts';
const SUITES_MS = 60_000;
async function testsTurnOf(job: Job, me: Me, at: TestsCheckout, run: () => Promise<TestsOutcome>): Promise<TestsOutcome> {
  const { cwd, env } = at.made();
  if (existsSync(`${cwd}/${SUITES}`)) {
    const none = await new Promise<string | undefined>(resolve => execFile('node', [SUITES, '--base', at.tested.base],
      { cwd, uid: me.uid, gid: me.gid, env, timeout: SUITES_MS, maxBuffer: 16 << 20 },
      (error, stdout) => resolve(error ? undefined : whole(redact(String(stdout).trim()), 30_000))));
    if (none !== undefined) {
      log(`job #${job.id}: ${TESTS}: none to run, no turn taken`);
      return { passed: true, report: none, tests: 0 };
    }
  }
  const heardWait = (ms: number) => log(`job #${job.id}: ${TESTS} waited ${Math.round(ms / 1000)} s for its turn`);
  return waitOwned(testsTurn(() => { assertOwned(); return run(); }, heardWait));
}

// A push's tests run once on the same code (pushchecks.ts testsOnce), claimed in HQ by the git trees of the pushed commit
// and of its base on main as the mirror has them (git.ts testedCode), and kept with their tests that passed (tests.ts
// --outcomes).
const CLAIM_POLL_MS = 15_000;
const CLAIM_AGAIN_MS = 3 * 60_000;   // (a claim that didn't reach HQ, once)
type TestedCode = ReturnType<typeof flow.testedCode>;
function testsOnceOf(job: Job, tested: TestedCode, run: (ticket: string) => Promise<TestsOutcome>) {
  const code = { tree: tested.tree, base: tested.baseTree, job: job.id };
  return testsOnce(async () => {
    let ticket: string;
    try {
      ticket = JSON.stringify(await hq.report('tests/comparison', { ...code, commit: tested.base }));
    } catch (err) {
      return { passed: null, tests: 0, report: `The base comparison ticket couldn't be issued: ${(err as Error).message}` };
    }
    return run(ticket);
  }, {
    claim: async () => hq.report('tests/claim', code),
    done: async ({ passed, report, tests }) => hq.report('tests/done', { ...code, passed, report, tests }),
    wait: () => sleep(CLAIM_POLL_MS),
    later: () => sleep(CLAIM_AGAIN_MS),
    said: words => log(`job #${job.id}: ${TESTS} ${words}`),
  });
}

// A push's tests run in a checkout of their own (testscheckout.ts), under root's tests/.
const TESTED = `${WORK}/tests`;
const testsCheckout = (job: Job, me: Me, tested: TestedCode) => testsAt(TESTED, job.id, me, flow.forAgent(me), tested);

// What's left of a run once its work is pushed: its checks (pushchecks.ts), then its renders kept. A reload doesn't
// wait for it, and the next worker process takes the run on from its checks.
// keep: writes the run's record with its checks in it.
async function afterPush(job: Job, me: Me, dir: string, checks: Checks, keep: (checks: Checks) => void, launches: Launched[]) {
  // (the pushed commit, tested as such against its base, in a checkout of its own)
  const at = testsCheckout(job, me, flow.testedCode(String(checks.body.sha)));
  const body = await pushChecks(job, me, dir, at, { checks, keep, launches });
  await keepRendersOf(job, me, dir, checks.body.files as string[]);
  return body;
}

// A commit main took outside a pull request HQ merged (a foundation carry, any direct commit: the coordinator's
// carries.ts) gets a push's checks all the same, and nothing else: no agent runs. The gates run in the job's clone of the
// commit, the tests in their own checkout, both against main before it. Like a landing it keeps no run record: a reload
// leaves the job to go stale and be queued again, and the checks run again.
async function carryChecks(job: Job, me: Me, launches: Launched[]) {
  const { dir, home } = jobDirs(WORK, job.id), sha = job.carry!;
  log(`job #${job.id}: the checks of ${sha.slice(0, 9)}, a commit main took outside a pull request`);
  for (const p of [dir, home]) remove(p);
  makeDir(home, me);
  runAs(me, 'mkdir', ['-m', '700', `${home}/tmp`]);
  makeDir(dir, me);
  flow.forAgent(me).clone(dir, `job/${job.id}`, { sha }, cloneIdentity(job));
  const at = testsCheckout(job, me, flow.testedCode(sha, 'parent'));
  const base = at.tested.base;
  const checks = { body: { status: 'done' }, spent: {}, runs: {} };
  const body = await pushChecks(job, me, dir, at, { checks, keep: () => {}, launches, gatesBase: base });
  const passed = (name: CheckName) => (body[name] as CheckOutcome | undefined)?.passed;
  const said = (name: CheckName) => `${name} ${passed(name) ? 'passed' : passed(name) === false ? 'failed' : 'not run'}`;
  // (done only with both verdicts: a check that couldn't run fails the job, and HQ hands the commit to the keeper)
  const status = (['gates', 'tests'] as const).every(name => typeof passed(name) === 'boolean') ? 'done' : 'failed';
  return { ...body, status, carry: { sha, base }, result: `On ${sha} against ${base}: ${said('gates')}, ${said('tests')}.` };
}

// A push's gates and tests (pushchecks.ts) on the commit `at` checks out, the gates in `dir` against `gatesBase` (main,
// unless it's given).
async function pushChecks(job: Job, me: Me, dir: string, at: TestsCheckout,
  { checks, keep, launches, gatesBase }: { checks: Checks; keep: (checks: Checks) => void; launches: Launched[]; gatesBase?: string }) {
  const takeMinutes = await testsHelper(job);
  assertOwned();
  const helper = takeMinutes !== undefined;
  if (helper) log(`job #${job.id}: ${TESTS} and ${GATES}: helper dispatch enabled`);
  const lent: Record<string, string> = helper ? { HQ_URL: HQ, HQ_TOKEN: job.token } : {};
  const count = (run: () => Promise<CheckOutcome>) => async () => at.counted(await run());
  const comparison: Record<string, string> = { HQ_URL: HQ, HQ_TOKEN: job.token };
  const tests = checkSpec(job, me, dir, 'tests', launches, run => testsOnceOf(job, at.tested, ticket => {
    comparison.TESTS_COMPARISON = ticket;
    const counted = count(run);
    return helper ? counted() : testsTurnOf(job, me, at, counted);
  }),
    { args: [...helper ? ['--helper'] : [], ...at.args], base: at.tested.base, env: comparison, where: at.launching });
  const gates = checkSpec(job, me, dir, 'gates', launches, undefined,
    { args: [], base: gatesBase, env: {}, lent: helper ? { args: ['--helper'], env: lent, ms: gatesLentMs(takeMinutes) } : undefined });
  const specs = [gates, tests];
  const body = await waitOwned(runChecks(job.id, checks, specs.filter(spec => spec !== undefined), { runs: RUNS, keep,
    watch: (pid, check) => checking.set(pid, check), unwatch: pid => checking.delete(pid),
    said: (name, words) => log(`job #${job.id}: ${CHECKS[name]} ${words}`), signal: ownershipSignal(), reachable: hqAnswers,
    roomy: roomBack }));
  removeTested(job);
  return body;
}

// Resolves once HQ answers its /health (as infra/hq-up.sh asks it after a deploy), for a check that lost HQ to run again
// (pushchecks.ts).
const HEALTH_POLL_MS = 15_000;
async function hqAnswers() {
  for (;;) {
    assertOwned();
    try {
      if ((await fetch(`${HQ}/health`, { signal: requestSignal(AbortSignal.timeout(10_000)) })).ok) return;
    } catch { /* not yet */ }
    await sleep(HEALTH_POLL_MS);
  }
}

// Resolves once the worker has room again, for a check it had none for to run again (pushchecks.ts): memory for a job
// to start (no longer short, so no share block for the run) and more disk free than the jobs leave for a deploy's build
// and the database (HQ's disk reserve).
async function roomBack() {
  for (;;) {
    assertOwned();
    try {
      if (room(false)) {
        const disk = await hq.api('disk', {}, AbortSignal.timeout(ROOM_REQUEST_MS)) as { freeBytes: number; reserveBytes: number };
        if (disk.freeBytes > disk.reserveBytes) return;
      }
    } catch { /* not yet */ }
    await sleep(HEALTH_POLL_MS);
  }
}

// Each check's outcome and time go to the worker's log, for what the pipeline costs a push. One runs as the job's own
// user in its clone, at nice 10: a push's checks are the pipeline's, and the jobs running meanwhile come first. It's
// held to the job's share like the rest of its processes (shares.ts). A branch from before it has no script, and no
// report. Its git takes nothing from the session (git.ts pinnedGitEnv, forAgent's settle).
// extra: arguments, base and environment of its own, and where it runs, made as it launches (the tests: in their
// checkout, testsCheckout, and the job's token for a lent machine's run). lent: a launch first that sends it to a lent
// machine's helper, with arguments, environment and a time limit of its own (pushchecks.ts CheckSpec).
function checkSpec(job: Job, me: Me, dir: string, name: CheckName, launches: Launched[], turn?: CheckSpec['turn'],
  extra: { args: string[]; base?: string; env: Record<string, string>; where?: () => { cwd: string; env: Record<string, string> };
    lent?: { args: string[]; env: Record<string, string>; ms: number } } = { args: [], env: {} }): CheckSpec<CheckName> | undefined {
  const script = CHECKS[name];
  if (!existsSync(`${dir}/${script}`)) return undefined;
  const launchWith = (args: string[], env: Record<string, string>) => () => {
    assertOwned();
    const where = extra.where?.() ?? { cwd: dir, env: { ...me.env, ...pinnedGitEnv } };
    const { child, launched } = launchDetached(RUNS, `${job.id}.${name}`, 'nice', ['-n', '10', 'node', script, '--base', extra.base ?? `origin/${BASE}`, ...args],
      { cwd: where.cwd, uid: me.uid, gid: me.gid, env: { ...where.env, ...env } });
    child.on('error', () => { /* no pid: it could not start, and says so */ });
    child.stdin!.end();
    launches.push(launched);
    return launched;
  };
  const { lent } = extra;
  const lentLaunch = lent && { ms: lent.ms, launch: launchWith([...extra.args, ...lent.args], { ...extra.env, ...lent.env }) };
  return { name, launch: launchWith(extra.args, extra.env), turn, lent: lentLaunch };
}

const keepRendersOf = async (job: Job, me: Me, dir: string, files: string[]) => {
  for (const why of await keepRenders(RENDERS, me, dir, files)) log(`job #${job.id}: ${why}`);
};

// --- Main loop ---------------------------------------------------------------------------------

// The board's seats, from HQ: the worker's first list (SEATS) goes once, at its start, and is HQ's first list if it has
// none. Then the list and the board's changes to it are fetched every few seconds (syncSeats, carryOut), so a change in
// Seats takes effect at once, and HQ hears how it went. Tried again until the coordinator answers (a deploy restarts both).
const SEAT_LIST_MS = 3000;
// A seat's own stop level (SEATS') goes with the first list, for HQ to take where the board hasn't set one, and pacing
// follows the board's switch before its changes are carried out, so "done" means it's in effect.
async function keepSeats() {
  let list: { seats: Listed[]; actions: SeatAction[]; pacing?: boolean } | undefined;
  for (let wait = 5000; !shuttingDown && !list; wait = Math.min(wait * 2, 300_000)) {
    // (each seat's own stop level)
    try { list = await hq.api('seats', { seats: SEATS.map(s => ({ id: s.id, engine: s.engine, ...(s.drainAt === undefined ? {} : { stop: Math.round(s.drainAt * 100) }) })) }); }
    catch (err) { log('seat list:', err); await sleep(wait); }
  }
  while (!shuttingDown) {
    try {
      list ??= await hq.api('seat-list');
      if (Array.isArray(list?.seats)) syncSeats(list.seats);
      if (typeof list?.pacing === 'boolean' && list.pacing !== pacing) {
        pacing = list.pacing;
        log(`pacing ${pacing ? 'on' : 'off'}`);
        for (const s of SEATS) if (s.state !== 'login') reportSeat(s);   // (each seat's note says it, or not)
      }
      for (const s of SEATS) if (s.state !== 'login' && reportedPace.get(s.id) !== paceKey(s)) reportSeat(s);
      for (const a of list?.actions ?? []) if (!taken.has(a.id)) {
        taken.add(a.id);
        carryOut(a, SEATS, doers).catch(err => { log(`seat change #${a.id}:`, err); settleChange(a.id, 'failed', 'The worker ran into an error carrying this out. Try again.'); });
      }
    } catch (err) { log('seat list:', err); }
    list = undefined;
    await sleep(SEAT_LIST_MS);
  }
}

// Each seat says whether it's signed in. One that isn't waits for the board to sign it in (or give its key) in Seats.
async function loginLoop(seat: Seat) {
  let first = true;   // (a seat found closed at the start reports it)
  while (!shuttingDown && !seat.gone) {
    try {
      seat.signInRead = true;
      const closed = readAs(keeper, `${seatDir(seat.id)}/closed`);
      if (closed !== undefined) {
        if (seat.state !== 'closed' || first) { seat.closed = closed.trim(); seat.state = 'closed'; seat.until = 0; reportSeat(seat); }
      } else if (!loggedIn(seat)) {
        if (seat.state !== 'login' || first) { seat.state = 'login'; reportSeat(seat); }
      } else if (seat.state === 'login' || seat.state === 'closed' || first) {
        if (seat.state === 'login' || seat.state === 'closed') seat.state = 'ready';
        reportSeat(seat);
      }
      first = false;
    } catch (err) { log(`${seat.id}:`, err); }
    await sleep(signing.has(seat.id) ? 5000 : 30_000);
  }
}

// A slot's claim on a seat (the coordinator's claim): the seat's window used, and the week's pace: while the seat is
// paced, only the board's word and work that must start before its weekly reset, unless it's the intercom's turn.
const claimOn = (seat: Seat, engine: string, kind?: string) => ({ seat: seat.id, engine, kind, util: windowUsed(seat),
  pacedUntil: kind === 'chat' ? undefined : pacedOf(seat) });

// A slot runs one job at a time, for whichever engine's seat it claims on (nextClaim). The intercom has a slot of its own
// (kind 'chat') on the healthiest Claude seat, so the board's chat with the CEO never waits behind long jobs.
// The idle chat slot asks for a quick run this often: its answer is due within seconds of the board's question, and an
// empty claim is one small request to HQ.
const CHAT_POLL_MS = 1_000;
// adopted: the run the last worker process left running in this slot (takeOver), which goes on here first.
async function slotLoop(slot: string, kind?: string, adopted?: RunRecord) {
  if (adopted) await takeBack(slot, adopted);
  while (!shuttingDown && !reload.handingOver) {
    let seat: Seat | undefined;
    const attempt: { job: Job | null } = { job: null };
    try {
      // (a slot holding a meeting's seat claims again on its seat and with its room, both kept for it: holding)
      const held = heldOn(slot), next: NextClaim | undefined = held ? { engine: held.engine, seat: held } : nextClaim(kind);
      if (!next) { await sleep(15_000); continue; }
      const { engine, check, room } = next, checked = check ? next.seat.checked : undefined;
      seat = next.seat;
      const t = reserve.take(); // room taken before the claim, so idle slots can't all start at once
      // A Codex seat's window is only measured by a Codex run: while it's unknown, one claim at a time may start
      // downtime work to measure it (a Claude seat's is measured by recheckLoop). A run that found no reading keeps the
      // seat probing, so no more downtime work starts on it unmeasured until a reading arrives (any Codex run's) or a restart.
      const claimed = claimOn(seat, engine, kind);
      const probe = !kind && !held && !check && claimed.util === undefined && cliOf(seat) === 'codex' && seat.signIn === 'login' && !seat.probing;   // (a key seat has no window)
      if (probe) seat.probing = true;
      const picked = seat;   // (seat is reassigned, so the finally below keeps this one)
      lastClaimAt.set(picked.id, Date.now());
      await places.hold(picked, !!held, () => holding.has(slot), async () => {
        try {
          reporting++;
          // (slot: a meeting holds slots by name until every seat can start)
          let answer;
          try { answer = await hq.api('claim', { ...claimed, slot, probe: probe || undefined, room }); }
          finally { reporting--; }
          if (reserve.keepsHold(slot, picked, t, answer)) { await sleep(5_000); return; }
          const job = attempt.job = answer as Job | null;
          if (!kind && room === undefined) turns.found(engine, !!job);
          if (!kind && !held && !check && engine === 'claude') claimAnswered(pacedEmpty, picked, claimed.pacedUntil !== undefined, !!job);
          if (!job) { if (check) picked.checked = 0; reserve.giveBack(t); await sleep(kind === 'chat' ? CHAT_POLL_MS : 15_000); return; }
          reserve.started();
          log(`${slot} on ${picked.id}: job #${job.id} ${job.title}${check ? ` (held ${picked.state}: its check)` : ''}`);
          if (check) reportSeat(picked);   // (its next check)
          await runJob(picked, job, slot, probe);
          // a check that ran without hitting the limit wakes a sleeping seat; its reading (or the last one) decides the rest
          if (check && picked.state === 'sleeping' && picked.checked === checked) { picked.state = 'ready'; picked.until = 0; drain(picked); }
        } finally { if (probe && (!attempt.job || windowUsed(picked) !== undefined)) picked.probing = false; }
      });
    } catch (err) {
      log(`${slot}:`, err);
      // A crash must never leave a job "running": report it (snagOf).
      if (attempt.job) await finish({ job: attempt.job.id, seat: seat?.id, status: snagOf(err), result: `Worker error: ${redact(String(err)).slice(0, 250)}` }).catch(() => {});
      await sleep(30_000);
    }
  }
}
// What a free slot claims next, on which seat: of the engines with a seat to start on (or, room allowing, a held seat's
// check: checkSeat), the one whose turn it is (turns). Short of room, only a claim with that room goes (shortClaim). The
// intercom claims on the healthiest Claude seat, always.
type NextClaim = { engine: string; seat: Seat; check?: boolean; room?: number };
function nextClaim(kind?: string): NextClaim | undefined {
  if (kind === 'chat') {
    const seat = pickSeat('claude', undefined, true);
    return seat && { engine: 'claude', seat };
  }
  const roomy = room();
  const ready = ENGINES.flatMap((engine): NextClaim[] => {
    const seat = pickSeat(engine), check = !seat && roomy ? checkSeat(engine) : undefined;
    return seat ? [{ engine, seat }] : check ? [{ engine, seat: check, check: true }] : [];
  });
  const next = turns.next(ready, roomy, shortClaim);
  if (next?.check) next.seat.checked = Date.now();
  return next;
}

// On restart, hand running jobs back to the queue so they resume in the same session: written down here, sent by the
// next worker (handback.ts), since a deploy may be recreating the coordinator at this very moment.
let shuttingDown = false;
// What each run had running besides its CLI goes with it, looked at before anything is stopped: its next run hears what
// was cut (jobs.ts finish). Handed back, its record goes (the next start neither takes it over nor hands it back again).
process.on('SIGTERM', () => {
  shuttingDown = true;
  capacityTrial.end('worker stopping');
  const runs = [...running.values()], at = new Date().toISOString();
  const lost = runs.map(r => { try { return r.uid === undefined ? [] : processesOf(r.uid, r.cli.pid); } catch { return []; } });
  for (const r of runs) r.stop();
  try {
    noteHandBacks(HANDBACK, runs.map(({ job, seat, session, spent }, i) => ({ job, seat, session, usage: spent.usage, lostAt: at,
      ...(lost[i].length ? { lost: lost[i] } : {}) })));
    for (const r of runs) dropRun(RUNS, r.job);
  } catch (err) { log('runs not written down for the next start, so they count as abandoned:', err); }
  process.exit(0);
});

// A deploy that changes only the worker's code reloads this process (supervise.py passes SIGUSR2 on), not the container:
// no new run starts, each started one is let reach its steady state (its CLI running, or its push's checks: inChecks)
// or its end, and then their records are written as they stand and this process ends, its runs' CLIs and checks still
// running. The next process takes them over (takeOver). A run not steady after HANDOVER_MS is left: one with a record
// (its CLI launched) is taken over all the same, one without goes back to the queue once it's stale.
const HANDOVER_MS = 10 * 60_000;
reload.listen({
  stopping: () => shuttingDown,
  start: () => log(`reloading for new code: no new runs; ${active.size ? `jobs ${[...active].map(id => `#${id}`).join(', ')} go on, taken over by the next worker process` : 'nothing running'}`),
  ready: () => ![...active].some(id => !steady(id)) && reporting === 0,
  keep: keepRuns,
  finish: () => capacityTrial.end('worker reloading'),
  failed: err => { log('hand-over failed, the runs go on and the next process takes them over:', err); capacityTrial.end('hand-over failed'); },
}, HANDOVER_MS);
const steady = (id: number) => [...running.values()].some(r => r.job === id && r.steady) || inChecks.has(id);
function keepRuns() {
  for (const r of running.values()) if (r.steady) r.keep();
  for (const keep of inChecks.values()) keep();
  const left = [...active].filter(id => !steady(id)), listed = (ids: number[]) => ids.map(id => `#${id}`).join(', ');
  const [recorded, unrecorded] = [left.filter(id => existsSync(recordOf(RUNS, id))), left.filter(id => !existsSync(recordOf(RUNS, id)))];
  if (recorded.length) log(`reloading with jobs ${listed(recorded)} not steady after ${HANDOVER_MS / 60_000} minutes: the next process takes them over from their records`);
  if (unrecorded.length) log(`reloading with jobs ${listed(unrecorded)} not steady after ${HANDOVER_MS / 60_000} minutes and never launched: they go back to the queue once stale`);
}

// The runs the last worker process left (detached.ts), sorted before anything touches the jobs' folders or slots: one
// whose CLI still runs (a reload, or this process crashed) or ended unreported is taken over by its slot (takeBack); one
// whose CLI is gone with nobody having seen it end (the container stopped, the server went down) is handed back
// (handBack) with what it had running at its last look. What's left of runs gone is cleared.
let adopted = new Map<string, RunRecord>();
function takeOver() {
  rootDir(RUNS, 0o700);
  const adopt = new Map<string, RunRecord>(), back: Parameters<typeof noteHandBacks>[1] = [];
  const found = records(RUNS, log).map(r => ({ r, live: !!r.launched.start && alive(r.launched.pid, r.launched.start) }));
  for (const { r, live } of found.sort((a, b) => Number(b.live) - Number(a.live))) {   // (a run still going keeps its slot over one ended)
    const l = r.launched;
    if (SEATS.some(s => s.id === r.seat) && SLOT_IDS.has(r.slot) && !adopt.has(r.slot) && (live || endSeen(RUNS, l) !== undefined)) {
      adopt.set(r.slot, r);
      continue;
    }
    for (const c of launchesOf(r)) if (c.start && alive(c.pid, c.start)) process.kill(c.pid, 'SIGTERM');   // (its seat or slot is gone: it starts again)
    back.push({ job: r.job.id, seat: r.seat, session: r.session ?? r.job.session ?? undefined, usage: r.usage, lostAt: r.lostAt,
      ...(r.lost?.length ? { lost: r.lost } : {}) });
    dropRun(RUNS, r.job.id);
  }
  if (back.length) noteHandBacks(HANDBACK, back);
  sweepRuns(RUNS, [...adopt.values()]);
  if (adopt.size || back.length) log(`runs left by the last worker process: ${adopt.size} taken over (${[...adopt.values()].map(r => `#${r.job.id}`).join(', ') || 'none'}), ${back.length} handed back`);
  return adopt;
}
// One that fails still lets the worker start: its runs are left, and their jobs go back to the queue once stale.
function tryTakeOver() {
  try { return takeOver(); }
  catch (err) { log('the runs the last worker process left could not be sorted, so none is taken over:', err); return new Map<string, RunRecord>(); }
}
// How a run that threw ends: snagged when the mirror's fetch at its start couldn't reach GitHub (git.ts
// FetchUnreachedError), so it goes back in the queue a few times (jobs.ts finish); any other throw failed it.
const snagOf = (err: unknown) => (err instanceof FetchUnreachedError ? 'snagged' : 'failed');
// A run taken over goes on in its slot, on its seat, like one this slot claimed.
async function takeBack(slot: string, r: RunRecord) {
  const seat = SEATS.find(s => s.id === r.seat)!;
  places.take(seat);
  try { await runJob(seat, r.job as unknown as Job, slot, false, r); }
  catch (err) {
    log(`${slot}: job #${r.job.id}, taken over:`, err);
    await finish({ job: r.job.id, seat: seat.id, status: snagOf(err), result: `Worker error: ${redact(String(err)).slice(0, 250)}` }).catch(() => {});
  } finally { places.release(seat); }
}

// The slot isolation tests (slots.test.ts) run for real here, as root, before any job: if one slot could reach
// another's folders or processes, or a test didn't run, no job runs.
function slotsIsolated() {
  // chown -R hands a job's folder over; a hard link in it could only point at a file its maker owned if this is on.
  for (const k of ['protected_hardlinks', 'protected_symlinks'])
    if (readFileSync(`/proc/sys/fs/${k}`, 'utf8').trim() !== '1') { log(`fs.${k} is off`); return false; }
  // A review's verdict comes from the CLI's stream (verdict.ts): with Yama's ptrace scope at 0, a command the review runs
  // could take the CLI's stdout from it (pidfd_getfd, ptrace) and write a verdict of its own after the CLI's.
  let scope = ''; try { scope = readFileSync('/proc/sys/kernel/yama/ptrace_scope', 'utf8').trim(); } catch {}
  if (!(Number(scope) >= 1)) { log(`kernel.yama.ptrace_scope is ${scope || 'missing'}, not 1 or more`); return false; }
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', new URL('./slots.test.ts', import.meta.url).pathname],
    { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 120_000 });
  const ok = r.status === 0 && /^# fail 0$/m.test(r.stdout) && /^# skipped 0$/m.test(r.stdout);
  if (!ok) log('slot isolation test failed:', redact(`${r.stdout ?? ''}${r.stderr ?? ''}`).slice(-2000));
  return ok;
}

const capacitySettings = JSON.stringify({ freeMb: FREE_MB, jobMb: JOB_MB, seatMb: SEAT_MB, shareMb: JOB_SHARE_MB, mostMb: JOB_MOST_MB,
  lowMemoryMb: LOW_MEMORY_MB, memoryBackMb: MEMORY_BACK_MB,
  jobCores: JOB_CORES, jobProcesses: JOB_PROCESSES, jobHotMs: JOB_HOT_MS, sampleMs: SHARES_MS, captureSamples: CAPACITY_SAMPLES, startReservationMs: STARTING_MS, workSlots: WORK_SLOTS.length, seatRuns: SEAT_RUNS });
log('capacity settings:', capacitySettings);
capacityTrial.note(`Capacity settings: ${capacitySettings}`);
// (its container's limits as the kernel holds them, beside what compose.yaml declares: memory.max and memory.swap.max;
// and the figures the environment can change, as this process took them.)
log(`Worker starting: seats ${SEATS.map(s => `${s.id} (${s.engine})`).join(', ')}; ${WORK_SLOTS.length} slots and the intercom's; base ${BASE}; ` +
  `memory ${cgroup('memory.max') || '?'}, swap ${cgroup('memory.swap.max') || '?'} (${cgroup('memory.swap.current') || '?'} swapped); ` +
  `Codex runs a seat ${SEAT_RUNS.codex ?? 'as the room allows'}, a job's share ${JOB_SHARE_MB} MB starved, ${JOB_MOST_MB} MB at most`);
const refuse = (why: string) => { log(why); return setInterval(() => log(why), 60_000); };
if (!ROOT && !DEV) {
  // Not root means agents would run with our uid and could read our tokens: run nothing, and say so.
  refuse('REFUSING TO RUN JOBS: the worker must run as root so agents (a uid per slot) cannot read its tokens. '
    + 'Set WORKER_DEV_SAME_UID=1 only for local testing.');
} else if (ROOT && (takeVolumes(adopted = tryTakeOver()), !slotsIsolated())) {
  // The test is run again every 5 minutes, and the worker starts once it passes: a cause that goes away by itself (a
  // full disk, 2026-10-07) mustn't leave it refusing until someone restarts it.
  const saying = refuse('REFUSING TO RUN JOBS: the slot isolation test failed (see above), so one job could reach another\'s files.');
  const retry = setInterval(() => { if (slotsIsolated()) { clearInterval(retry); clearInterval(saying); log('slot isolation test passed now'); startWork(); } }, 5 * 60_000);
} else startWork();

function startWork() {
  mkdirSync(RUNS, { recursive: true, mode: 0o700 });   // (takeOver makes it as root: a local test run needs it too)
  if (DEV && !ROOT) log('WARNING: WORKER_DEV_SAME_UID=1: agents share this uid and can read the worker tokens. Local testing only.');
  sweepEnded(); setInterval(sweepEnded, 3600e3);
  try { syncMirror(); } catch (err) { log('mirror sync:', err); }
  if (mirrorReady) refreshing = gcMirror().finally(() => { refreshing = undefined; });
  refreshLoop();
  mainMergeLoop();
  moveLogins();
  keepSeats();   // (each seat on HQ's list starts its loginLoop: syncSeats)
  recheckLoop();
  gistLoop();
  namesLoop();
  readLoop();
  voiceLoop();
  watchShares();
  const serving = serveCodexRefreshes();   // (no slot starts without it: a run's refreshes go only through it)
  // The runs the last worker's stop cut off go back first, or a claim would count them abandoned. A file that can't be
  // read or kept still lets the slots start (a worker that runs nothing is worse than runs counted as abandoned), and

  handBack(HANDBACK, b => hq.api('finish', b), log).catch(err => {
    log('hand-back failed, so its runs count as abandoned:', err);
    try { renameSync(HANDBACK, `${HANDBACK}.failed-${Date.now()}`); } catch { /* no file left to set aside */ }
  }).then(() => serving).then(() => {
    for (const slot of WORK_SLOTS) slotLoop(slot, undefined, adopted.get(slot));
    slotLoop(CHAT_SLOT, 'chat', adopted.get(CHAT_SLOT));
  });
}

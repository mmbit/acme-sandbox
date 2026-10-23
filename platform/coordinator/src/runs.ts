// Runs: a long headless command an agent sends off its job (hq run) to a helper, which asks HQ for work
// (platform/helper). The helpers of the machines the board lends take them (machines.ts, each machine on a key of its
// own), the fastest free one first, and this server's own (infra/run_helpers.py, its key the server's RUNS_TOKEN). This
// server's takes a run no lent machine does: when none is asking for work, none has taken the run in time, or one went
// quiet with it. Agents call /api/agent/runs* with their job's token (inside Docker only), the helpers /api/helper/*
// with their own keys. The settings are org.yaml's `runs:`, the kinds of run among them: a run is of one kind, and each
// lent machine and this server run a helper per kind, each in the kind's image, taking only that kind's runs. A kind can
// keep its runs off this server, and departments' work in the queue, until a lent machine has finished a run of it
// (holds). The board's HQ sees each machine live (listMachines, the 'machines' event).
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { publish } from './events.ts';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { RouteRequest, RouteTable } from '../../../shared/routes/routes.ts';
import { roles, yamlFile } from './company.ts';
import { DATA_DIR, ORIGIN, REPO_DIR, RUNS_TOKEN } from './config.ts';
import { db } from './db.ts';
import * as jobs from './jobs.ts';
import * as machines from './machines.ts';
import { secret } from './secrets.ts';
import { reply } from './uploads.ts';

type RunState = 'waiting' | 'running' | 'done' | 'withdrawn' | 'stopped' | 'lost';
type HelperName = 'lent' | 'server';
// A helper as its key names it: one of this server's, or of a lent machine (its id, machines.SERVER for this server)
type Helper = { name: HelperName; machine: number };
// A machine as the board's HQ shows it: asking for work, running a run, not heard from, or paused by the board
type MachineState = 'taking' | 'running' | 'away' | 'paused';
type Job = { id: number; agent: string };
type RunRow = {
  id: number;
  slot: number | null;
  job: number;
  agent: string;
  command: string;
  kind: string | null;
  cwd: string;
  bring: string;
  minutes: number;
  state: RunState;
  // the helper that has it, or last had it, and its machine
  helper: HelperName | null;
  machine: number | null;
  // 1 once a lent machine's helper lost it: this server's helper alone takes it then
  passed: number | null;
  // the id its helper's calls name, the run's id and its take's number (57-2): a call of an earlier take is never the
  // run's
  attempt: string | null;
  // how many times a helper took it
  takes: number | null;
  created: string;
  taken: string | null;
  beat: string | null;
  ended: string | null;
  exit_code: number | null;
  timed_out: number | null;
  why: string | null;
};
type Kind = {
  name: string;
  about: string;
  image: string;
  cpus: number;
  memoryGb: number;
  diskGb: number;
  gpus: boolean;
  // only lent machines take its runs (work on a graphics card the server hasn't): this server has no helper of it, and a
  // run waits while they're away, however long
  lentOnly: boolean;
  // this server's helper takes the kind's runs only once a lent machine has finished one
  serverAfterLent: boolean;
  // the departments whose work waits in the queue until then
  holdUntilLent: string[];
  // how many helpers of it each lent machine runs, each taking a run at once, each with the caps above
  helpers: number;
  // its runs keep their sockets (a test's local servers): only on a machine set up with its install command, where the
  // helpers' network reaches HQ and the package registries alone (manager.mjs), so it's for the lent machines only
  sockets: boolean;
};

const DIR = `${DATA_DIR}/runs`;
const HELPER_CODE = `${REPO_DIR}/platform/helper/helper.mjs`;
const MANAGER_CODE = `${REPO_DIR}/platform/helper/manager.mjs`;
// Debian, for the perl and tar the helper uses
const DEFAULT_IMAGE = 'node:24.22.1-slim';
// every kind's container mounts it, so each machine has one key
const VOLUME = 'run-helper';
const KIND_NAME = /^[a-z][a-z0-9-]{0,23}$/;
// (pasted into PowerShell, cmd and sh alike: nothing any of them reads as more than a word)
const IMAGE_NAME = /^[a-z0-9][a-z0-9._/:@-]{0,199}$/;
// (a job's whole tree, as a push's tests send it: a company's is a few hundred MB)
const BUNDLE_MAX_BYTES = 2 ** 30;
const FILES_MAX_BYTES = 200 * 2 ** 20;
// the helper's last MB of output, and a few lines of its own after it
const OUTPUT_MAX_BYTES = 2 ** 20 + 64 * 1024;
// a beat's readings and the run's new output (4 KB at most, escaped in JSON)
const BEAT_MAX_BYTES = 64 * 1024;
const COMMAND_MAX_CHARS = 4000;
const BRING_MAX = 100;
// A job's runs waiting for a helper, those still coming in counted: each holds its bundle on HQ's volume until a helper
// takes it
const WAITING_MAX = 4;
const receiving = new Map<number, number>();
// A helper asks for work every 10 s and beats every 10 s while it runs one (platform/helper)
const PRESENT_MS = 90_000;
// A faster machine that asked for work this recently, and has no run, takes the next on its next ask
const READY_MS = 20_000;
// The board's HQ hears of the machines at most this often
const SAY_MS = 2_000;
const QUIET_MS = 3 * 60_000;
// Time for a run's files to reach HQ after its command's limit
const UPLOAD_GRACE_MS = 20 * 60_000;
const KEPT_MS = 2 * 24 * 3600_000;
const SWEEP_MS = 60_000;

// slot: which of its machine's helpers of its kind has it (the kind's `helpers`).
db.exec(`create table if not exists helper_runs (id integer primary key, job integer not null, agent text not null,
  command text not null, cwd text not null, bring text not null, minutes integer not null, state text not null,
  helper text, passed integer, created text not null, taken text, beat text, ended text, exit_code integer,
  timed_out integer, why text, kind text, attempt text, takes integer, machine integer, slot integer)`);
db.exec("create index if not exists helper_runs_open on helper_runs (state) where state in ('waiting', 'running')");
db.exec('create unique index if not exists helper_runs_attempt on helper_runs (attempt)');
mkdirSync(DIR, { recursive: true });

// org.yaml's runs: what the helper is called where agents read it, how long a run may take and wait to be taken, and
// the kinds of run. A company that declares no kinds has one, 'default', on the platform's image and caps. A kind that
// breaks a rule is left out, with why.
function runSettings() {
  const given = yamlFile('company/org.yaml').runs ?? {};
  const declared = given.kinds === undefined ? { default: {} } : given.kinds;
  const kinds: Kind[] = [];
  const leftOut: { name: string; why: string }[] = [];
  if (!isMap(declared)) leftOut.push({ name: 'kinds', why: 'a map of kinds, keyed by name' });
  for (const [name, entry] of Object.entries(isMap(declared) ? declared : {})) {
    const why = kindProblem(name, entry);
    if (why) leftOut.push({ name, why });
    else kinds.push(kindOf(name, entry as Record<string, unknown>));
  }
  return {
    helper: typeof given.helper === 'string' && given.helper ? given.helper : 'the helper',
    maxMinutes: whole(given.maxMinutes, 240),
    takeMinutes: whole(given.takeMinutes, 3),
    // the memory a lent machine's runs may hold in all, in GB (0: no cap but each kind's): the offload machine's own cap,
    // sized to it, apart from this server's worker
    machineMemoryGb: whole(given.machineMemoryGb, 0),
    kinds,
    leftOut,
  };
}

function kindProblem(name: string, entry: unknown) {
  if (!KIND_NAME.test(name)) return 'its name: a to z, 0 to 9 and -, starting with a letter, at most 24 characters';
  if (entry === null || entry === undefined) return '';
  if (!isMap(entry))
    return 'its settings: a map (about, image, cpus, memoryGb, diskGb, gpus, lentOnly, serverAfterLent, holdUntilLent, helpers, sockets)';
  if (entry.about !== undefined && typeof entry.about !== 'string') return 'about: a line of text';
  if (entry.image !== undefined && !(typeof entry.image === 'string' && IMAGE_NAME.test(entry.image)))
    return 'image: a plain Docker reference (a to z, 0 to 9 and . _ / : @ -)';
  if (entry.gpus !== undefined && typeof entry.gpus !== 'boolean') return 'gpus: true or false';
  if (entry.lentOnly !== undefined && typeof entry.lentOnly !== 'boolean') return 'lentOnly: true or false';
  if (entry.sockets !== undefined && typeof entry.sockets !== 'boolean') return 'sockets: true or false';
  if (entry.serverAfterLent !== undefined && typeof entry.serverAfterLent !== 'boolean')
    return 'serverAfterLent: true or false';
  if (entry.holdUntilLent !== undefined && !isDepartmentList(entry.holdUntilLent))
    return "holdUntilLent: a list of org.yaml's department ids";
  for (const cap of ['cpus', 'memoryGb', 'diskGb', 'helpers'])
    if (entry[cap] !== undefined && !(Number.isSafeInteger(entry[cap]) && (entry[cap] as number) > 0))
      return `${cap}: a whole number above 0`;
  return '';
}

const kindOf = (name: string, entry: Record<string, unknown> | null): Kind => ({
  name,
  about: (entry?.about as string | undefined) ?? '',
  image: (entry?.image as string | undefined) ?? DEFAULT_IMAGE,
  cpus: whole(entry?.cpus, 4),
  memoryGb: whole(entry?.memoryGb, 8),
  diskGb: whole(entry?.diskGb, 16),
  gpus: entry?.gpus === true,
  lentOnly: entry?.lentOnly === true || entry?.sockets === true,
  serverAfterLent: entry?.serverAfterLent === true,
  holdUntilLent: (entry?.holdUntilLent as string[] | undefined) ?? [],
  helpers: whole(entry?.helpers, 1),
  sockets: entry?.sockets === true,
});

const isDepartmentList = (given: unknown) => {
  const departments = new Set(departmentsOf().map(department => department.id));
  return Array.isArray(given) && given.every(id => departments.has(id));
};

const departmentsOf = (): { id: string; name?: string; agents?: { id: string }[] }[] =>
  yamlFile('company/org.yaml').departments ?? [];

const whole = (value: unknown, fallback: number) =>
  Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fallback;

const forJob = (handle: (job: Job, request: RouteRequest) => unknown) => async (request: RouteRequest) => {
  const job = jobs.tokenJob(bearer(request.req));
  if (!job) return reply(request.res, 401, { error: 'agent token' });
  return handle(job, request);
};
const forHelper = (handle: (helper: Helper, request: RouteRequest) => unknown) => async (request: RouteRequest) => {
  const helper = helperOf(bearer(request.req));
  if (!helper) return reply(request.res, 401, { error: 'helper key' });
  return handle(helper, request);
};
const runId = (request: RouteRequest) => Number(request.params.id);
const attemptOf = (request: RouteRequest) => request.params.attempt;

// HQ's server spreads these into its own table
export const routeTable: RouteTable = {
  'POST /api/agent/runs': forJob(async (job, { req, res }) => answer(res, await createRun(job, specOf(req), req))),
  'GET /api/agent/runs/helper': forJob((job, { res }) => answer(res, helperState())),
  'GET /api/agent/runs/:id(\\d+)': forJob((job, request) => answer(request.res, showRun(job, runId(request)))),
  'POST /api/agent/runs/:id(\\d+)/withdraw': forJob((job, request) =>
    answer(request.res, withdrawRun(job, runId(request))),
  ),
  'POST /api/agent/runs/:id(\\d+)/stop': forJob((job, request) => answer(request.res, stopRun(job, runId(request)))),
  'GET /api/agent/runs/:id(\\d+)/output': forJob((job, request) =>
    sendFile(request.res, resultFile(job, runId(request), 'output.txt'), 'text/plain; charset=utf-8'),
  ),
  'GET /api/agent/runs/:id(\\d+)/files': forJob((job, request) =>
    sendFile(request.res, resultFile(job, runId(request), 'files.tar.gz'), 'application/gzip'),
  ),
  'GET /api/helper/code': ({ res }) => sendFile(res, HELPER_CODE, 'text/javascript; charset=utf-8'),
  'GET /api/helper/manager': ({ res }) => sendFile(res, MANAGER_CODE, 'text/javascript; charset=utf-8'),
  'POST /api/helper/setup': forHelper((helper, { res }) => answer(res, managerSetup(helper))),
  'POST /api/helper/pull': forHelper(async (helper, { res, jsonBody }) =>
    answer(res, pullAuth(helper, await jsonBody())),
  ),
  'POST /api/helper/take': forHelper(async (helper, { res, jsonBody }) =>
    answer(res, takeRun(helper, await jsonBody())),
  ),
  'GET /api/helper/runs/:attempt(\\d+-\\d+)/bundle': forHelper((helper, request) =>
    sendFile(request.res, bundleFor(helper, attemptOf(request)), 'application/gzip'),
  ),
  'POST /api/helper/runs/:attempt(\\d+-\\d+)/beat': forHelper(async (helper, request) =>
    answer(request.res, beat(helper, attemptOf(request), await request.jsonBody(BEAT_MAX_BYTES))),
  ),
  'POST /api/helper/runs/:attempt(\\d+-\\d+)/output': forHelper(async (helper, request) =>
    answer(request.res, await saveOutput(helper, attemptOf(request), request.req)),
  ),
  'POST /api/helper/runs/:attempt(\\d+-\\d+)/finish': forHelper(async (helper, request) =>
    answer(request.res, await finishRun(helper, attemptOf(request), request.req)),
  ),
};

export function start() {
  publishKinds();
  publishHolds();
  setInterval(() => {
    try {
      sweep();
      publishKinds();
      publishHolds();
    } catch (error) {
      console.error('Runs: the sweep failed:', error);
    }
  }, SWEEP_MS);
}

// The kinds this server's own helpers are made for, by name and image: those runSettings takes, as this parser read
// them, but a kind for lent machines only. infra/run_helpers.py makes one per kind from this file at each deploy, and
// sync.sh deploys again when it changes, so org.yaml is read by HQ alone and every kind it takes has a helper here.
// Written at start and with each sweep.
const KINDS_FILE = `${DATA_DIR}/run-kinds.json`;
export function publishKinds() {
  const text = JSON.stringify(
    runSettings()
      .kinds.filter(kind => !kind.lentOnly)
      .map(({ name, image }) => ({ name, image })),
  );
  if (existsSync(KINDS_FILE) && readFileSync(KINDS_FILE, 'utf8') === text) return;
  writeFileSync(`${KINDS_FILE}.new`, text); // (whole or not at all, for a deploy reading it meanwhile)
  renameSync(`${KINDS_FILE}.new`, KINDS_FILE);
}

// ---- the agent's side

class Refusal {
  status: number;
  error: string;
  constructor(status: number, error: string) {
    this.status = status;
    this.error = error;
  }
}

// What hq run sends: { command, kind, cwd, bring, minutes } as base64url JSON in a header, the bundle (a gzipped tar of
// the job's tree, the folders the run needs) as the body
function specOf(req: IncomingMessage) {
  try {
    return JSON.parse(Buffer.from(String(req.headers['x-run'] ?? ''), 'base64url').toString());
  } catch {
    return null;
  }
}

async function createRun(job: Job, spec: any, body: IncomingMessage) {
  const problem = specProblem(spec);
  if (problem) return new Refusal(400, problem);
  const kind = kindNamed(spec.kind);
  if (kind instanceof Refusal) return kind;
  const waiting = db
    .prepare("select count(*) as n from helper_runs where job = ? and state = 'waiting'")
    .get(job.id) as {
    n: number;
  };
  if (waiting.n + (receiving.get(job.id) ?? 0) >= WAITING_MAX)
    return new Refusal(
      429,
      `${WAITING_MAX} of this job's runs wait for a helper already: send this one once one is taken`,
    );
  receiving.set(job.id, (receiving.get(job.id) ?? 0) + 1);
  // (received in full before the run is there for a helper to take)
  const incoming = `${DIR}/incoming-${randomUUID()}.tar.gz`;
  let received: boolean;
  try {
    received = await receive(body, incoming, BUNDLE_MAX_BYTES);
  } finally {
    const left = receiving.get(job.id)! - 1;
    if (left) receiving.set(job.id, left);
    else receiving.delete(job.id);
  }
  if (!received)
    return new Refusal(413, `the bundle is over ${BUNDLE_MAX_BYTES / 2 ** 20} MB: name only the folders the run needs`);
  const { id } = db
    .prepare(
      "insert into helper_runs (job, agent, command, kind, cwd, bring, minutes, state, created) values (?, ?, ?, ?, ?, ?, ?, 'waiting', ?) returning id",
    )
    .get(
      job.id,
      job.agent,
      spec.command,
      kind.name,
      spec.cwd,
      JSON.stringify(spec.bring),
      spec.minutes,
      new Date().toISOString(),
    ) as {
    id: number;
  };
  mkdirSync(`${DIR}/${id}`, { recursive: true });
  renameSync(incoming, `${DIR}/${id}/bundle.tar.gz`);
  return { id, kind: kind.name, helper: kindHelper(kind.name) };
}

function specProblem(spec: any) {
  if (!spec || typeof spec !== 'object') return 'no run described';
  if (typeof spec.command !== 'string' || !spec.command.trim()) return 'no command';
  if (spec.command.length > COMMAND_MAX_CHARS) return `the command is over ${COMMAND_MAX_CHARS} characters`;
  if (spec.kind !== undefined && typeof spec.kind !== 'string') return 'kind: the name of a kind of run';
  if (spec.cwd !== '' && !isInside(spec.cwd)) return "the run's folder must be a path inside the repo";
  if (!Array.isArray(spec.bring) || spec.bring.length > BRING_MAX || !spec.bring.every(isInside))
    return `bring: at most ${BRING_MAX} paths inside the repo`;
  const { maxMinutes } = runSettings();
  if (!Number.isSafeInteger(spec.minutes) || spec.minutes < 1 || spec.minutes > maxMinutes)
    return `minutes: a whole number from 1 to ${maxMinutes}`;
  return '';
}

// The kind a run or a helper names: the only one declared when it names none, a kind whose runs keep their sockets left
// out (it's named always: the push's tests name theirs)
function kindNamed(given: unknown) {
  const { kinds } = runSettings();
  const declared = kinds.map(kind => (kind.about ? `${kind.name} (${kind.about})` : kind.name)).join(', ');
  if (!kinds.length)
    return new Refusal(400, "no kind of run is declared (org.yaml's runs.kinds): hq run helper says why");
  const plain = kinds.filter(kind => !kind.sockets);
  if (given === undefined || given === '')
    return plain.length === 1 ? plain[0] : new Refusal(400, `name the kind of run (--kind): ${declared}`);
  const kind = kinds.find(declaredKind => declaredKind.name === given);
  return kind ?? new Refusal(400, `no kind of run is called ${String(given).slice(0, 40)}: the kinds are ${declared}`);
}

// A relative path with no . or .. part, no backslash and nothing a shell or tar reads as an option
const isInside = (path: unknown) =>
  typeof path === 'string' &&
  path.length > 0 &&
  path.length < 500 &&
  !path.startsWith('-') &&
  !/[\\\0\n]/.test(path) &&
  path.split('/').every(part => part !== '' && part !== '.' && part !== '..');

function showRun(job: Job, id: number) {
  const row = ownRun(job, id);
  if (!row) return new Refusal(404, 'no such run of this job');
  const settled = settle(row);
  return {
    id: settled.id,
    state: settled.state,
    minutes: settled.minutes,
    created: settled.created,
    taken: settled.taken,
    ended: settled.ended,
    exitCode: settled.exit_code,
    timedOut: settled.timed_out === 1,
    why: settled.why,
    kind: settled.kind,
    on: settled.helper,
    // the lent machine that has it or had it, by its name
    machine: settled.helper === 'lent' ? (machines.findMachine(settled.machine)?.name ?? null) : null,
    passed: settled.passed === 1,
    bring: JSON.parse(settled.bring),
    helper: kindHelper(settled.kind ?? ''),
  };
}

// A waiting run its job gave up on, with no helper there to take it. One a helper took meanwhile stays running.
function withdrawRun(job: Job, id: number) {
  if (!ownRun(job, id)) return new Refusal(404, 'no such run of this job');
  end(id, 'waiting', 'withdrawn', 'no helper was asking for work');
  return showRun(job, id);
}

function stopRun(job: Job, id: number) {
  if (!ownRun(job, id)) return new Refusal(404, 'no such run of this job');
  end(id, 'waiting', 'stopped', 'its job stopped it');
  end(id, 'running', 'stopped', 'its job stopped it');
  return showRun(job, id);
}

function resultFile(job: Job, id: number, name: string) {
  const row = ownRun(job, id);
  return row?.state === 'done' ? `${DIR}/${id}/${name}` : '';
}

// HQ hears of the machines when they change, at most every SAY_MS: a run taken, finished or lost, a helper's ask or beat
// with its readings, a machine coming or going (the sweep, each minute).
let machinesSaid = '';
let saying: NodeJS.Timeout | null = null;
function sayMachines() {
  saying ??= setTimeout(() => {
    saying = null;
    try {
      const list = listMachines(),
        listed = JSON.stringify(list);
      if (listed === machinesSaid) return;
      machinesSaid = listed;
      publish({ type: 'machines', machines: list });
    } catch (error) {
      console.error('Runs: the machines went unsaid:', error);
    }
  }, SAY_MS).unref();
}

// The lent machines and each kind of run on them: whether that kind's helper is asking for work on any machine, the
// size of the fastest there, the run it has, and the commands a person pastes on a machine (a changed helper.mjs needs
// the new start commands). Then the kinds left out of the settings. With each kind, this server's helper of it.
function helperState() {
  const settings = runSettings();
  const setup = machineSetup();
  return {
    ...machineState(settings),
    machines: lentMachines().map(({ name, state, speed, cpus, memoryGb, gpu, kinds }) => ({
      name,
      state,
      speed,
      cpus,
      memoryGb,
      gpu,
      kinds,
    })),
    kinds: settings.kinds.map((kind, index) => ({
      name: kind.name,
      about: kind.about,
      image: kind.image,
      gpus: kind.gpus,
      lentOnly: kind.lentOnly,
      ...presence('lent', kind.name),
      server: presence('server', kind.name),
      serverTakes: serverTakes(kind),
      holds: holdsWork(kind) ? holdLine(kind, settings.helper) : '',
      setup: setup.kinds[index].commands,
    })),
    leftOut: settings.leftOut,
    removeKey: setup.removeKey,
    install: setup.install,
    remove: setup.remove,
  };
}

// A run's kind on the lent machines, and this server's helper of that kind: who may take it
function kindHelper(kind: string) {
  const settings = runSettings();
  const declared = settings.kinds.find(found => found.name === kind);
  return {
    ...machineState(settings),
    kind,
    lentOnly: declared?.lentOnly === true,
    ...presence('lent', kind),
    server: presence('server', kind),
    serverTakes: !declared || serverTakes(declared),
  };
}

const machineState = (settings: ReturnType<typeof runSettings>) => ({
  name: settings.helper,
  lent: machines.listMachines().length,
  takeMinutes: settings.takeMinutes,
  maxMinutes: settings.maxMinutes,
  machineMemoryGb: settings.machineMemoryGb,
});

// The lent machines' helpers of that kind (on the machines the board hasn't paused), or this server's: whether one is
// asking for work, when one last did, the fastest one's size, and a run one has
function presence(helper: HelperName, kind: string) {
  const helpers = machines.kindHelpers(kind, helper === 'lent');
  const latest = helpers.toSorted((a, b) => b.seen.localeCompare(a.seen))[0];
  const fastest = helpers.filter(found => isPresent(found.seen)).toSorted(bySpeed)[0] ?? latest;
  const running = db
    .prepare("select id from helper_runs where state = 'running' and helper = ? and kind = ? order by id limit 1")
    .get(helper, kind) as { id: number } | undefined;
  return {
    present: helpers.some(found => isPresent(found.seen)),
    seen: latest?.seen ?? null,
    cpus: fastest?.cpus ?? null,
    memoryGb: fastest?.memory_gb ?? null,
    running: running?.id ?? null,
  };
}

const bySpeed = (a: machines.KindHelper, b: machines.KindHelper) => (b.speed ?? 0) - (a.speed ?? 0);

const ownRun = (job: Job, id: number) =>
  db.prepare('select * from helper_runs where id = ? and job = ?').get(id, job.id) as RunRow | undefined;

// ---- the machines, for the board's HQ

// Each lent machine as the board's HQ shows it (Settings › Machines, a look's machines), then this server: its state,
// speed and size, the run it has now (since when, and on how many cores) and, while it's heard from, its load and that
// run's newest output. A machine running runs of two kinds shows its oldest. HQ's looks draw the rig from it too.
export const listMachines = () => [...lentMachines(), machineView(machines.SERVER, null)];

const lentMachines = () => machines.listMachines().map(machine => machineView(machine.id, machine));

function machineView(id: number, machine: machines.Machine | null) {
  const helpers = machines.machineKinds(id);
  const present = helpers.filter(helper => isPresent(helper.seen));
  const run = runOn(id);
  const state: MachineState = machine?.paused ? 'paused' : run ? 'running' : present.length ? 'taking' : 'away';
  const most = (values: (number | null)[]) => Math.max(0, ...values.map(value => value ?? 0)) || null;
  const lastSeen = helpers
    .map(helper => helper.seen)
    .sort()
    .at(-1);
  const live = machines.liveOf(id);
  // the cores its run's kind gets there, as its helper said, else as org.yaml gives them
  const cores = run
    ? (helpers.find(helper => helper.kind === run.kind)?.cpus ??
      runSettings().kinds.find(kind => kind.name === run.kind)?.cpus ??
      null)
    : null;
  return {
    id: machine ? id : 'server',
    name: machine?.name ?? 'This server',
    state,
    speed: most(helpers.map(helper => helper.speed)),
    cpus: most(helpers.map(helper => helper.cpus)),
    memoryGb: most(helpers.map(helper => helper.memory_gb)),
    gpu: machine?.gpu ?? null,
    gpuCount: gpuCount(machine?.gpu ?? null),
    body: machine?.body ?? null,
    glow: machine?.glow ?? null,
    kinds: present.map(helper => helper.kind),
    paused: !!machine?.paused,
    added: machine?.added ?? null,
    seen: machine ? machine.seen : (lastSeen ?? null),
    ...(run
      ? {
          run: {
            kind: run.kind,
            job: run.job,
            job_code: run.job_code,
            agent: run.agent,
            title: run.title,
            since: run.taken,
            cores,
          },
        }
      : {}),
    ...(live ? { live: { ...live, lines: run ? machines.linesOf(run.id) : [] } } : {}),
  };
}

// The run a machine is on (its oldest), with its job's title and code (job_code, as HQ names it).
type MachineRun = {
  id: number;
  job: number;
  job_code: string | null;
  agent: string;
  kind: string;
  taken: string;
  title: string | null;
};
const runOn = (machine: number) =>
  db
    .prepare(
      "select r.id, r.job, j.code job_code, r.agent, r.kind, r.taken, j.title from helper_runs r left join jobs j on j.id = r.job where r.state = 'running' and r.machine = ? order by r.id limit 1",
    )
    .get(machine) as MachineRun | undefined;

// How many GPUs a machine has: its helper names more than one as '2× <name>' (platform/helper's load).
const gpuCount = (gpu: string | null) => (gpu ? Number(/^(\d+)× /.exec(gpu)?.[1] ?? 1) : 0);

// A new machine, and what the board pastes on it: its install command, with its key, shown this once (or the command
// that saves its key, then its helpers' start commands, for a machine started by hand)
export function addMachine(name: unknown) {
  const added = machines.addMachine(name);
  if (typeof added === 'string') return added;
  return { ...machineSetup(), id: added.id, install: installCommand(added.key), keyCommand: keyCommand(added.key) };
}

// A machine's install command again, on a new key (the old one is let in no more), shown this once: for a machine
// whose helpers were started by hand, or whose manager changed (its code is pinned by its hash)
export function newInstall(id: number) {
  const key = machines.newKey(id);
  return key ? { install: installCommand(key) } : "There's no such machine.";
}

// The install command: pasted once on a machine with Docker, it starts the manager (manager.mjs), which from then on
// keeps the machine's helpers in step with HQ, one container per kind's helper, on a network that reaches HQ and the
// package registries alone. The manager's code is the code it trusts by its hash; the helpers' follows HQ. Pasted in
// PowerShell, cmd and sh alike, as the start commands are.
function installCommand(key?: string) {
  return managerCommand('install', key);
}

const managerCommand = (action: 'install' | 'remove', key?: string) =>
  [
    'docker run --rm --user 0:0 --entrypoint node -v /var/run/docker.sock:/var/run/docker.sock',
    `${action === 'install' ? `-v ${managedVolume()}:/state ` : ''}-e MANAGER=${action} -e HQ_URL=${ORIGIN}${key ? ` -e HELPER_KEY=${key}` : ''}`,
    `${DEFAULT_IMAGE} -e "${managerBootstrap()}"`,
  ].join(' ');

// The volume the manager keeps the machine's key in, named for this HQ, so a machine can lend itself to several
// (manager.mjs names its containers and network the same way)
const managedVolume = () =>
  new URL(ORIGIN).host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function managerBootstrap() {
  const hash = createHash('sha256').update(readFileSync(MANAGER_CODE)).digest('hex');
  return (
    "fetch(process.env.HQ_URL+'/api/helper/manager',{redirect:'error'}).then(r=>r.text()).then(t=>{" +
    `if(require('crypto').createHash('sha256').update(t).digest('hex')!='${hash}')` +
    "throw Error('this is not the manager code the command trusts');" +
    "const f=require('os').tmpdir()+'/manager.mjs';require('fs').writeFileSync(f,t);return import(f)})"
  );
}

// What a lent machine's manager keeps it in step with: every kind's helpers, with their image and caps, and the ones of
// them that have a run now, which it changes only once that run has ended
function managerSetup(helper: Helper) {
  if (helper.name !== 'lent') return new Refusal(403, 'a lent machine sets itself up, never this server');
  const kinds = runSettings().kinds.map(({ name, image, cpus, memoryGb, diskGb, gpus, helpers, sockets }) => ({
    name,
    image,
    cpus,
    memoryGb,
    diskGb,
    gpus,
    helpers,
    sockets,
  }));
  const busy = openRuns('running')
    .filter(row => row.machine === helper.machine)
    .map(row => ({ kind: row.kind, slot: row.slot ?? 1 }));
  return { kinds, busy };
}

// Docker's sign-in for the manager's pull of a kind's image from a private registry (manager.mjs signIn), for that pull
// alone: from the registry's key in HQ's keys, and only for an image a kind names, so a machine's key signs in for
// nothing else. None ({}) for another registry. Without the key yet, the board gets a card for it (askForKey), and the
// pull is tried again at the manager's next minute.
const REGISTRY_KEYS: Record<string, string> = { 'ghcr.io': 'REGISTRY_GHCR_TOKEN' };
function pullAuth(helper: Helper, body: unknown) {
  if (helper.name !== 'lent') return new Refusal(403, 'a lent machine pulls its own images, never this server');
  const image = (body as { image?: unknown } | null)?.image;
  const kind = runSettings().kinds.find(kind => kind.image === image);
  if (typeof image !== 'string' || !kind) return new Refusal(404, 'no kind of run has that image');
  const [host, owner] = image.split('/');
  if (!Object.hasOwn(REGISTRY_KEYS, host)) return {};
  const token = secret(REGISTRY_KEYS[host]);
  if (!token) return askForKey(REGISTRY_KEYS[host], kind.name, image);
  const auth = { username: owner, password: token, serveraddress: host };
  // (base64url with its padding: Docker reads it with Go's padded decoder, and without one it pulls anonymously)
  return { auth: Buffer.from(JSON.stringify(auth)).toString('base64').replaceAll('+', '-').replaceAll('/', '_') };
}

// One card for the registry key while none is open, the process team's as HQ's own keys are (secrets.ts PROCESS_ONLY)
function askForKey(name: string, kind: string, image: string) {
  if (!db.prepare("select 1 from requests where kind = 'credential' and secrets = ? and status = 'open'").get(name))
    jobs.createRequest({
      kind: 'credential',
      urgency: 'today',
      agent: roles().process,
      secrets: name,
      title: "A key for the lent machines to pull a kind of run's private image",
      body:
        `A lent machine is setting up its ${kind} runs, and their image (${image.split('@')[0]}) is private on ` +
        "GitHub's registry. Make a classic token with the read:packages scope alone, nothing else " +
        '(https://github.com/settings/tokens/new?scopes=read:packages&description=HQ%20lent%20machines), and paste it ' +
        'here. HQ hands it to a machine for each pull of an image one of its kinds names, and the machine never keeps it.',
    });
  return new Refusal(409, `HQ has no key for ${image.split('/')[0]} yet: the board has a card for it`);
}

// The commands that set a machine's helpers up, one per kind and the same on every machine (Settings › Machines, hq run
// helper), and the removal of their volume once every kind's helper is gone (the key goes with it)
export function machineSetup() {
  const bootstrap = bootstrapCode();
  return {
    kinds: runSettings().kinds.map(kind => ({
      name: kind.name,
      about: kind.about,
      commands: kindCommands(kind, bootstrap),
    })),
    removeKey: `docker volume rm ${VOLUME}`,
    install: installCommand(),
    remove: managerCommand('remove'),
  };
}

// Saves a new machine's key in the volume its helpers share, whole or not at all, before or after they start: each waits
// for it. Pasted like the start commands, so it keeps their rule (below).
function keyCommand(key: string) {
  const image = runSettings().kinds[0]?.image ?? DEFAULT_IMAGE;
  const save =
    "const f=process.env.KEY_FILE||'/state/key',fs=require('fs');" +
    `fs.writeFileSync(f+'.new','${key}\\n',{mode:0o600});fs.renameSync(f+'.new',f)`;
  return `docker run --rm --network none --user 0:0 --entrypoint node -v ${VOLUME}:/state ${image} -e "${save}"`;
}

// Fetches the helper code, checks it's the code the command trusts by its hash, and runs it. Node's -e, in double quotes
// with no $, " or ` inside, reads the same in PowerShell, cmd and a Unix shell.
function bootstrapCode() {
  const code = readFileSync(HELPER_CODE);
  const hash = createHash('sha256').update(code).digest('hex');
  return (
    "fetch(process.env.HQ_URL+'/api/helper/code',{redirect:'error'}).then(r=>r.text()).then(t=>{" +
    `if(require('crypto').createHash('sha256').update(t).digest('hex')!='${hash}')` +
    "throw Error('this is not the helper code the command trusts');" +
    "const f=require('os').tmpdir()+'/helper.mjs';require('fs').writeFileSync(f,t);return import(f)})"
  );
}

function kindCommands(kind: Kind, bootstrap: string) {
  const name = container(kind.name);
  // (--init reaps what a run leaves behind once kill(-1) ends it)
  const start = [
    `docker run -d --init --name ${name} --restart unless-stopped`,
    '--user 0:0 --entrypoint node --cap-drop ALL --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges',
    `--read-only --tmpfs /tmp:size=64m,mode=755 --tmpfs /work:exec,mode=1777,size=${kind.diskGb}g`,
    `--cpus ${kind.cpus} --memory ${kind.memoryGb}g --pids-limit 4096${kind.gpus ? ' --gpus all' : ''}`,
    `-v ${VOLUME}:/state -e HQ_URL=${ORIGIN} -e RUN_KIND=${kind.name}`,
    `${kind.image} -e "${bootstrap}"`,
  ].join(' ');
  return { start, stop: `docker stop ${name}`, startAgain: `docker start ${name}`, remove: `docker rm -f ${name}` };
}

const container = (kind: string) => `${VOLUME}-${kind}`;

// ---- the helper's side

// Which helper a key is: this server's own, or a lent machine's
function helperOf(given: string): Helper | null {
  if (RUNS_TOKEN && sameKey(given, RUNS_TOKEN)) return { name: 'server', machine: machines.SERVER };
  const machine = machines.keyMachine(given);
  return machine ? { name: 'lent', machine: machine.id } : null;
}

const sameKey = (given: string, key: string) => !!given && timingSafeEqual(digest(given), digest(key));

// This server's helper, a lent machine by its name, or the lent machines as agents read them
const helperName = (helper: HelperName | null, machine: number | null = null) =>
  helper === 'server' ? "this server's helper" : (machines.findMachine(machine)?.name ?? runSettings().helper);

// The oldest waiting run whose job still runs and that this helper may take, now its. A run it still held goes on
// without it: it asks for work only between runs, so it started again mid-run. Each helper, a lent machine's and this
// server's, asks for its kind's runs ({ kind, cpus, memoryGb, bench, gpu, live }: machines.ts heard). The id it gets is
// this take's attempt, which its later calls name. helper.mjs calls it the run's id and prints it, so it starts with the
// run's: the code is pinned by its hash on the lent machines, and a change to it stops their helpers until new start
// commands are pasted.
// A machine set up with its install command runs `helpers` of a kind, each saying which it is (slot) and that its
// network is the manager's closed one (locked): a kind whose runs keep their sockets goes to none other.
function takeRun(helper: Helper, asked: unknown) {
  const named = kindNamed(isMap(asked) ? asked.kind : undefined);
  if (named instanceof Refusal) return named;
  const kind = named.name;
  if (named.sockets && !(isMap(asked) && asked.locked === true))
    return new Refusal(
      400,
      `${kind}'s runs keep their sockets: only a machine set up with its install command takes them`,
    );
  const given = isMap(asked) ? asked.slot : undefined;
  const slot =
    Number.isSafeInteger(given) && (given as number) >= 1 && (given as number) <= named.helpers ? (given as number) : 1;
  machines.heard(helper.machine, kind, asked, true);
  for (const row of openRuns('running'))
    if (row.machine === helper.machine && row.kind === kind && (row.slot ?? 1) === slot)
      lose(row, `${helperName(helper.name, helper.machine)} started again during the run`);
  for (const row of openRuns('waiting')) if (!jobRuns(row.job)) end(row.id, 'waiting', 'withdrawn', 'its job ended');
  const row = openRuns('waiting').find(waiting => mayTake(helper, named, waiting));
  sayMachines();
  if (!row) return 204;
  const now = new Date().toISOString();
  const takes = (row.takes ?? 0) + 1;
  const attempt = `${row.id}-${takes}`;
  const taken = db
    .prepare(
      "update helper_runs set state = 'running', helper = ?, machine = ?, slot = ?, attempt = ?, takes = ?, taken = ?, beat = ? where id = ? and state = 'waiting'",
    )
    .run(helper.name, helper.machine, slot, attempt, takes, now, now, row.id);
  if (!taken.changes) return 204;
  sayMachines();
  const sockets = named.sockets || undefined;
  return {
    id: attempt,
    command: row.command,
    cwd: row.cwd,
    bring: JSON.parse(row.bring),
    minutes: row.minutes,
    sockets,
  };
}

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// A helper takes only runs of its kind. A lent machine's takes none while the board has it paused. It takes one no lent
// machine lost (or any, of a kind this server doesn't take), unless a faster machine is free for it (firstInLine). This
// server's takes one a lent machine lost, or once no lent machine's helper of its kind is asking for work or none has
// taken the run in takeMinutes.
function mayTake(helper: Helper, kind: Kind, row: RunRow) {
  if (row.kind !== kind.name) return false;
  if (helper.name === 'lent')
    return (
      (!row.passed || !serverTakes(kind)) &&
      !machines.findMachine(helper.machine)?.paused &&
      fitsMachine(helper.machine, kind) &&
      firstInLine(helper.machine, kind, row)
    );
  if (!serverTakes(kind)) return false;
  return row.passed === 1 || !lentPresent(kind.name) || waited(row) > runSettings().takeMinutes * 60_000;
}

// The fastest free machine first. A faster machine whose helper of the kind asked for work in the last READY_MS and has
// no run takes it on its next ask, so a slower one leaves it. While the faster ones are busy, a slower one takes it once
// it has waited takeMinutes, as this server's helper would.
// (a machine is busy with a kind once each of its helpers of it has a run)
function firstInLine(machine: number, kind: Kind, row: RunRow) {
  const helpers = machines.kindHelpers(kind.name, true);
  const own = helpers.find(helper => helper.machine === machine)?.speed ?? 0;
  const faster = helpers.filter(helper => (helper.speed ?? 0) > own);
  const busy = (helper: machines.KindHelper) =>
    openRuns('running').filter(running => running.machine === helper.machine && running.kind === kind.name).length >=
    kind.helpers;
  const ready = (helper: machines.KindHelper) =>
    helper.asked !== null && Date.now() - Date.parse(helper.asked) < READY_MS && !busy(helper);
  if (faster.some(ready)) return false;
  return !faster.some(busy) || waited(row) > runSettings().takeMinutes * 60_000;
}

const waited = (row: RunRow) => Date.now() - Date.parse(row.created);

// A lent machine takes a run only while it fits the memory its runs may hold in all (runs.machineMemoryGb), each running
// run counted at its kind's memoryGb: its helpers of several kinds, each capped alone, never ask more of it together.
function fitsMachine(machine: number, kind: Kind) {
  const settings = runSettings();
  if (!settings.machineMemoryGb) return true;
  const memoryOf = new Map(settings.kinds.map(declared => [declared.name, declared.memoryGb]));
  const held = openRuns('running')
    .filter(running => running.machine === machine)
    .reduce((sum, running) => sum + (memoryOf.get(running.kind ?? '') ?? 0), 0);
  return held + kind.memoryGb <= settings.machineMemoryGb;
}

// Where a run blocked on the worker can go instead (blocks.ts): the lent machines the board hasn't paused, each with its
// size (its runs' memory cap, else its biggest helper's) and the kinds whose helper is there now; and each kind, whether
// this server's own helper takes it now.
export function offloadPlaces() {
  const settings = runSettings();
  return {
    machines: lentMachines()
      .filter(machine => !machine.paused)
      .map(({ name, cpus, memoryGb, kinds }) => ({
        name,
        cpus,
        memoryGb: settings.machineMemoryGb || memoryGb,
        kinds,
      })),
    kinds: settings.kinds.map(kind => ({
      name: kind.name,
      about: kind.about,
      server: serverTakes(kind) && presence('server', kind.name).present,
    })),
  };
}

const serverTakes = (kind: Kind) => !kind.lentOnly && (!kind.serverAfterLent || lentFinished(kind.name));

// A lent machine's helper of that kind has finished a run (whatever its command's exit code)
const lentFinished = (kind: string) =>
  !!db.prepare("select 1 from helper_runs where helper = 'lent' and kind = ? and state = 'done' limit 1").get(kind);

// Any lent machine the board hasn't paused has a helper of that kind asking for work or beating
const lentPresent = (kind: string) => machines.kindHelpers(kind, true).some(helper => isPresent(helper.seen));

// The running run this helper's attempt is still on, or none: not once the run was stopped, lost, its job ended, or
// another take, by any helper, has it now
const attemptRun = (helper: Helper, attempt: string) => {
  const row = db
    .prepare("select * from helper_runs where attempt = ? and state = 'running' and machine = ?")
    .get(attempt, helper.machine) as RunRow | undefined;
  return row ?? null;
};

function bundleFor(helper: Helper, attempt: string) {
  const row = attemptRun(helper, attempt);
  return row ? `${DIR}/${row.id}/bundle.tar.gz` : '';
}

// The helper's word that its attempt goes on, with its machine's readings and the run's new output ({ live, lines }).
// The answer says whether it should.
function beat(helper: Helper, attempt: string, said: unknown) {
  const row = attemptRun(helper, attempt);
  if (!row) return { go: false };
  machines.heard(helper.machine, row.kind ?? '', said, false);
  if (isMap(said)) machines.heardLines(row.id, said.lines);
  if (!jobRuns(row.job)) end(row.id, 'running', 'stopped', 'its job ended');
  else
    db.prepare("update helper_runs set beat = ? where attempt = ? and state = 'running'").run(
      new Date().toISOString(),
      attempt,
    );
  sayMachines();
  return { go: !!attemptRun(helper, attempt) };
}

// (received under a name of its own, and kept only if the attempt still has the run: a late upload never lands on the
// run another take has now, the same helper's included)
async function saveOutput(helper: Helper, attempt: string, body: IncomingMessage) {
  const row = attemptRun(helper, attempt);
  if (!row) return new Refusal(409, 'this run is no longer running');
  const received = `${DIR}/${row.id}/output-${randomUUID()}.txt`;
  if (!(await receive(body, received, OUTPUT_MAX_BYTES))) return new Refusal(413, 'too much output');
  if (!attemptRun(helper, attempt)) {
    rmSync(received, { force: true });
    return new Refusal(409, 'this run is no longer running');
  }
  renameSync(received, `${DIR}/${row.id}/output.txt`);
  return { ok: true };
}

// The run's files and exit code, and it's done. One that ended or moved on meanwhile keeps nothing of it.
async function finishRun(helper: Helper, attempt: string, body: IncomingMessage) {
  const row = attemptRun(helper, attempt);
  if (!row) return new Refusal(409, 'this run is no longer running');
  const id = row.id;
  const exitCode = Number(body.headers['x-run-exit']);
  if (!Number.isSafeInteger(exitCode)) return new Refusal(400, 'x-run-exit: the exit code');
  const received = `${DIR}/${id}/files-${randomUUID()}.tar.gz`;
  if (!(await receive(body, received, FILES_MAX_BYTES))) return new Refusal(413, 'too many files');
  const timedOut = body.headers['x-run-timed-out'] === '1' ? 1 : 0;
  const finished = db
    .prepare(
      "update helper_runs set state = 'done', ended = ?, exit_code = ?, timed_out = ? where id = ? and state = 'running' and machine = ? and attempt = ?",
    )
    .run(new Date().toISOString(), exitCode, timedOut, id, helper.machine, attempt);
  if (!finished.changes) {
    rmSync(received, { force: true });
    return new Refusal(409, 'this run is no longer running');
  }
  renameSync(received, `${DIR}/${id}/files.tar.gz`);
  rmSync(`${DIR}/${id}/bundle.tar.gz`, { force: true });
  machines.dropLines(id);
  sayMachines();
  if (helper.name === 'lent') publishHolds();
  return { ok: true };
}

// ---- states

// A running run whose machine the board removed, whose helper went quiet, or that's well past its time, goes on without
// that helper (lose).
function settle(row: RunRow) {
  if (row.state !== 'running') return row;
  const now = Date.now();
  const name = helperName(row.helper, row.machine);
  if (row.helper === 'lent' && !machines.findMachine(row.machine)) lose(row, 'its machine was removed');
  else if (now - Date.parse(row.beat ?? row.created) > QUIET_MS) lose(row, `${name} went quiet`);
  else if (now - Date.parse(row.taken ?? row.created) > row.minutes * 60_000 + UPLOAD_GRACE_MS)
    lose(row, `${name} sent nothing back in time`);
  return runRow(row.id)!;
}

// A running run its helper won't finish. A lent machine's waits again, with its bundle, for this server's helper to take
// it (or a lent machine again, of a kind this server doesn't take yet), and nothing the lent one sent of it is kept.
// This server's is lost, and its job hears why.
function lose(row: RunRow, why: string) {
  machines.dropLines(row.id);
  if (row.helper === 'server') return end(row.id, 'running', 'lost', why);
  const kind = runSettings().kinds.find(found => found.name === row.kind);
  const next =
    !kind || serverTakes(kind) ? "this server's helper takes it" : `it waits for ${helperName('lent')} again`;
  const passed = db
    .prepare(
      "update helper_runs set state = 'waiting', helper = null, machine = null, attempt = null, passed = 1, taken = null, beat = null, why = ? where id = ? and state = 'running' and helper = 'lent'",
    )
    .run(`${why}: ${next}`, row.id);
  if (passed.changes) rmSync(`${DIR}/${row.id}/output.txt`, { force: true });
  sayMachines();
}

// Moves a run from one state to an ended one, if it's still in the first. The bundle is no longer needed, nor any
// result of a run that didn't finish.
function end(id: number, from: RunState, to: RunState, why: string) {
  const ended = db
    .prepare('update helper_runs set state = ?, why = ?, ended = ? where id = ? and state = ?')
    .run(to, why, new Date().toISOString(), id, from);
  if (ended.changes) {
    clearFiles(id);
    machines.dropLines(id);
  }
  sayMachines();
}

function clearFiles(id: number) {
  rmSync(`${DIR}/${id}`, { recursive: true, force: true });
}

// Every minute: lost runs found without waiting for their job to ask, runs of ended jobs ended, and the files of runs
// that ended days ago gone
function sweep() {
  for (const row of openRuns('running')) {
    if (!jobRuns(row.job)) end(row.id, 'running', 'stopped', 'its job ended');
    else settle(row);
  }
  for (const row of openRuns('waiting')) if (!jobRuns(row.job)) end(row.id, 'waiting', 'withdrawn', 'its job ended');
  const before = new Date(Date.now() - KEPT_MS).toISOString();
  const old = db.prepare("select id from helper_runs where state = 'done' and ended < ?").all(before) as {
    id: number;
  }[];
  for (const { id } of old) if (existsSync(`${DIR}/${id}`)) clearFiles(id);
  sayMachines();
}

const runRow = (id: number) => db.prepare('select * from helper_runs where id = ?').get(id) as RunRow | undefined;

const openRuns = (state: 'waiting' | 'running') =>
  db.prepare('select * from helper_runs where state = ? order by id').all(state) as RunRow[];

const jobRuns = (job: number) => !!db.prepare("select 1 from jobs where id = ? and status = 'running'").get(job);

// Asking for work or beating within the last 90 s
const isPresent = (seen: string | null | undefined) => !!seen && Date.now() - Date.parse(seen) < PRESENT_MS;

// ---- holds

// The work a kind holds until a lent machine has finished a run of it, in settings 'runs.held' for the job queue
// (jobs.ts held) and the status report, absent while nothing is held: the agents of the kinds' departments, what
// their queued work waits for (`until`), and a line saying so.
export function publishHolds() {
  const settings = runSettings();
  const holding = settings.kinds.filter(holdsWork);
  if (!holding.length) {
    db.prepare("delete from settings where key = 'runs.held'").run();
    return;
  }
  const held = new Set(holding.flatMap(kind => kind.holdUntilLent));
  const agents = departmentsOf()
    .filter(department => held.has(department.id))
    .flatMap(department => (department.agents ?? []).map(agent => agent.id));
  const until = holdUntil(holding, settings.helper);
  const line = holding.map(kind => holdLine(kind, settings.helper)).join(' ');
  db.prepare("insert or replace into settings (key, value) values ('runs.held', ?)").run(
    JSON.stringify({ agents, until, line }),
  );
}

const holdsWork = (kind: Kind) => kind.holdUntilLent.length > 0 && !lentFinished(kind.name);

const holdUntil = (holding: Kind[], helper: string) =>
  `until ${helper} has finished a ${holding.map(kind => kind.name).join(' and a ')} run`;

function holdLine(kind: Kind, helper: string) {
  const named = departmentsOf()
    .filter(department => kind.holdUntilLent.includes(department.id))
    .map(department => department.name ?? department.id);
  return `${named.join(' and ')} work waits ${holdUntil([kind], helper)}.`;
}

// ---- HTTP

// A body to a file, at most max bytes: false (and no file) past that or when it's cut off
async function receive(body: IncomingMessage, file: string, maxBytes: number) {
  if (Number(body.headers['content-length'] ?? 0) > maxBytes) return false;
  let size = 0;
  const capped = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      done(size > maxBytes ? new RangeError('over the limit') : null, chunk);
    },
  });
  try {
    await pipeline(body, capped, createWriteStream(file));
    return true;
  } catch {
    rmSync(file, { force: true });
    return false;
  }
}

function answer(res: ServerResponse, response: unknown) {
  if (typeof response === 'number') return res.writeHead(response).end();
  if (response instanceof Refusal)
    return reply(res, response.status, { error: response.error }, response.status === 413);
  return reply(res, 200, response);
}

function sendFile(res: ServerResponse, file: string, type: string) {
  if (!file || !existsSync(file)) return reply(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  return pipeline(createReadStream(file), res).catch(error => console.error(`Runs: ${file} not sent:`, error.message));
}

const bearer = (req: IncomingMessage) => {
  const header = String(req.headers.authorization ?? '');
  return header.startsWith('Bearer ') ? header.slice(7) : '';
};

const digest = (text: string) => createHash('sha256').update(text).digest();

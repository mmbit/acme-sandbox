// The lent machines: hardware the board lends HQ for long runs (runs.ts, platform/helper). Each has the name the board
// gives it and a key HQ made, kept here by its hash alone, and runs one helper per kind of run, all on that key. The
// board adds, pauses, renames, colours and removes them in HQ's Settings › Machines. Each time one of its helpers asks for work or
// beats, it says what it has (cores, memory, a GPU), its speed and its load. While it runs one, it sends the run's newest
// output. The load and the output live in memory alone, for HQ's live view.
import { createHash, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { yamlFile } from './company.ts';
import { db } from './db.ts';
import { redact } from './events.ts';
import * as secrets from './secrets.ts';

export type Machine = {
  id: number;
  name: string;
  key_hash: string;
  gpu: string | null;
  paused: number;
  added: string;
  seen: string | null;
  // its case's colour and its lights', as '#rrggbb', or null for the look's own
  body: string | null;
  glow: string | null;
};
// A machine's helper of a kind: when it last asked for work, and asked or beat, with the size and speed it gave
export type KindHelper = {
  machine: number;
  kind: string;
  asked: string | null;
  seen: string;
  cpus: number | null;
  memory_gb: number | null;
  speed: number | null;
};
// A load reading, in percent
type Reading = { at: number; cpu: number; mem: number; gpu?: number };

// This server's own helpers, where a lent machine has its id (here and in runs.ts's helper_runs)
export const SERVER = 0;
const NAME_MAX_CHARS = 40;
const HISTORY_MS = 5 * 60_000;
// Readings closer than this are one point of the history: every kind's helper on a machine reads the same load
const POINT_MS = 5_000;
// A GPU reading older than this is gone: the GPU kind's helper sends one with each ask or beat
const GPU_MS = 60_000;
const LINES_KEPT = 100;
const LINE_MAX_CHARS = 300;
// The helper sends at most 4 KB of a run's output a beat (platform/helper)
const LINES_MAX_CHARS = 8_000;
// An ended run's lines stay this long for its job to read the last of them (hq run lines polls every 5 s)
const ENDED_LINES_MS = 10 * 60_000;

db.exec(`create table if not exists machines (id integer primary key autoincrement, name text not null,
  key_hash text not null unique, gpu text, paused integer not null default 0, added text not null, seen text, body text,
  glow text)`);
db.exec(`create table if not exists machine_kinds (machine integer not null, kind text not null, asked text,
  seen text not null, cpus integer, memory_gb integer, speed integer, primary key (machine, kind))`);

// A key still saved on a desk-phone card (one lent machine's, with no list of them) is the first machine's, named as
// org.yaml's runs.helper names it, its key kept by its hash alone (runs.ts gives it the runs it had). Where each helper
// was last seen goes: each asks again within seconds.
const CARD_KEY = 'RUN_HELPER_KEY';
const carded = secrets.secret(CARD_KEY);
if (carded && !db.prepare('select 1 from machines limit 1').get()) {
  const named = yamlFile('company/org.yaml').runs?.helper;
  const name = typeof named === 'string' && named.trim() ? named.trim().slice(0, NAME_MAX_CHARS) : 'The first machine';
  db.prepare('insert into machines (name, key_hash, added) values (?, ?, ?)').run(
    name.charAt(0).toUpperCase() + name.slice(1),
    hashOf(carded),
    new Date().toISOString(),
  );
  rmSync(`${secrets.DIR}/${CARD_KEY}`, { force: true }); // (no longer a key any card asks for: secrets.ts)
}
db.exec("delete from settings where key like 'runs.helper.%' or key like 'runs.server.%'");

// ---- the board's

// A new machine: its id and its key, which the board's answer shows once (in its key command) and HQ never again

export function addMachine(given: unknown) {
  const name = nameOf(given);
  if (typeof name !== 'string') return name.refusal;
  const key = `helper_${randomBytes(32).toString('base64url')}`;
  const { id } = db
    .prepare('insert into machines (name, key_hash, added) values (?, ?, ?) returning id')
    .get(name, hashOf(key), new Date().toISOString()) as { id: number };
  return { id, key };
}

// A machine's new key, the old one let in no more (its new install command carries it), or none for no such machine
export function newKey(id: number) {
  if (!findMachine(id)) return null;
  const key = `helper_${randomBytes(32).toString('base64url')}`;
  db.prepare('update machines set key_hash = ? where id = ?').run(hashOf(key), id);
  return key;
}

export function renameMachine(id: number, given: unknown) {
  if (!findMachine(id)) return "There's no such machine.";
  const name = nameOf(given, id);
  if (typeof name !== 'string') return name.refusal;
  db.prepare('update machines set name = ? where id = ?').run(name, id);
  return { ok: true };
}

// Its case's colour and its lights', both or neither (null: the look's own).
export function colourMachine(id: number, body: unknown, glow: unknown) {
  if (!findMachine(id)) return "There's no such machine.";
  const colours = [body, glow];
  const isColour = (value: unknown) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  if (!colours.every(isColour) && !colours.every(value => value === null))
    return "A machine's colours are two, its case's and its lights', each as #rrggbb, or none for the look's own.";
  db.prepare('update machines set body = ?, glow = ? where id = ?').run(
    ...colours.map(value => (value === null ? null : String(value).toLowerCase())),
    id,
  );
  return { ok: true };
}

// A paused machine's helpers take no run, and finish the one they have
export function pauseMachine(id: number, paused: boolean) {
  if (!findMachine(id)) return "There's no such machine.";
  db.prepare('update machines set paused = ? where id = ?').run(paused ? 1 : 0, id);
  return { ok: true };
}

// Its key goes with it, so its helpers are let in no more (a run one of them had goes on without it: runs.ts settle)
export function removeMachine(id: number) {
  if (!findMachine(id)) return "There's no such machine.";
  db.prepare('delete from machines where id = ?').run(id);
  db.prepare('delete from machine_kinds where machine = ?').run(id);
  readings.delete(id);
  return { ok: true };
}

function nameOf(given: unknown, id?: number) {
  const name = typeof given === 'string' ? given.trim() : '';
  if (!name || name.length > NAME_MAX_CHARS || /\p{Cc}/u.test(name))
    return { refusal: `A machine's name is a line of at most ${NAME_MAX_CHARS} characters.` };
  const taken = db.prepare('select id from machines where name = ? collate nocase').get(name) as
    { id: number } | undefined;
  if (taken && taken.id !== id) return { refusal: `There's a machine called ${name} already. Pick another name.` };
  return name;
}

export const listMachines = () => db.prepare('select * from machines order by id').all() as Machine[];

export const findMachine = (id: number | null | undefined) =>
  db.prepare('select * from machines where id = ?').get(id ?? -1) as Machine | undefined;

// The machine a helper's key is (by its hash, so a lookup's timing tells nothing of the key)
export const keyMachine = (key: string) =>
  key ? (db.prepare('select * from machines where key_hash = ?').get(hashOf(key)) as Machine | undefined) : undefined;

// ---- what the helpers say

// A helper's ask for work (asked) or beat, and what it says of its machine: { cpus, memoryGb, bench, gpu, live: { cpu,
// mem, gpu } }, each part left out when it has none. Its speed is its benchmark on one core times the cores its runs get.
export function heard(machine: number, kind: string, report: unknown, asked: boolean) {
  const given = isMap(report) ? report : {};
  const before = kindHelper(machine, kind);
  const cpus = whole(given.cpus) ?? before?.cpus ?? null;
  const bench = typeof given.bench === 'number' && given.bench > 0 && given.bench < 1e6 ? given.bench : null;
  const now = new Date().toISOString();
  db.prepare(
    `insert or replace into machine_kinds (machine, kind, asked, seen, cpus, memory_gb, speed) values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    machine,
    kind,
    asked ? now : (before?.asked ?? null),
    now,
    cpus,
    whole(given.memoryGb) ?? before?.memory_gb ?? null,
    bench && cpus ? Math.round(bench * cpus) : (before?.speed ?? null),
  );
  const gpu = typeof given.gpu === 'string' ? given.gpu.replace(/\p{Cc}/gu, '').slice(0, 80) : null;
  if (machine !== SERVER)
    db.prepare('update machines set seen = ?, gpu = coalesce(?, gpu) where id = ?').run(now, gpu || null, machine);
  if (isMap(given.live)) read(machine, given.live);
}

export const kindHelper = (machine: number, kind: string) =>
  db.prepare('select * from machine_kinds where machine = ? and kind = ?').get(machine, kind) as KindHelper | undefined;

// Each running machine's helpers of a kind: those of this server, or of the lent machines the board hasn't paused
export const kindHelpers = (kind: string, lent: boolean) =>
  db
    .prepare(
      lent
        ? 'select k.* from machine_kinds k join machines m on m.id = k.machine where k.kind = ? and m.paused = 0'
        : 'select * from machine_kinds where kind = ? and machine = 0',
    )
    .all(kind) as KindHelper[];

export const machineKinds = (machine: number) =>
  db.prepare('select * from machine_kinds where machine = ? order by kind').all(machine) as KindHelper[];

// ---- live: the load and output, in memory

const readings = new Map<
  number,
  { history: Reading[]; gpu: { at: number; value: number } | null; free?: { freeMb: number; cores: number } }
>();
// A run's output as its beats brought it: its last lines, how many it has heard in all, and when it ended
type RunLines = { lines: string[]; heard: number; ended: number | null };
const runLines = new Map<number, RunLines>();
// When this HQ started keeping them: a restart keeps none, and numbers them anew
const LINES_SINCE = new Date().toISOString();

function read(machine: number, live: Record<string, unknown>) {
  const cpu = percent(live.cpu);
  const mem = percent(live.mem);
  const gpu = percent(live.gpu);
  const at = Date.now();
  const kept = readings.get(machine) ?? { history: [], gpu: null };
  if (gpu !== null) kept.gpu = { at, value: gpu };
  // what's free of the whole machine now, for the board and the agents sizing work for it
  const [freeMb, cores] = [whole(live.freeMb), whole(live.cores)];
  if (freeMb && cores) kept.free = { freeMb, cores };
  const gpuNow = kept.gpu && kept.gpu.at > at - GPU_MS ? { gpu: kept.gpu.value } : {};
  if (cpu !== null && mem !== null) {
    const history = kept.history.filter(point => point.at > at - HISTORY_MS && point.at < at - POINT_MS);
    kept.history = [...history, { at, cpu, mem, ...gpuNow }];
  }
  readings.set(machine, kept);
}

// The machine's load now and over the last few minutes (its GPU's too, where it has one), or null with no reading in
// that time
export function liveOf(machine: number) {
  const kept = readings.get(machine);
  const history = kept?.history.filter(point => point.at > Date.now() - HISTORY_MS) ?? [];
  if (!history.length) return null;
  const { cpu, mem } = history[history.length - 1];
  const gpu = kept?.gpu && kept.gpu.at > Date.now() - GPU_MS ? { gpu: kept.gpu.value } : {};
  const points = history.map(({ at, ...reading }) => ({ at: new Date(at).toISOString(), ...reading }));
  return { cpu, mem, ...gpu, ...kept?.free, history: points };
}

// A beat's new output of a run: its last lines kept as plain text, each cut short, with any key in them redacted.
// Redacted whole before either cut, so a key the cut crosses leaves no piece too short to know
export function heardLines(run: number, given: unknown) {
  if (typeof given !== 'string' || !given) return;
  const lines = (redact(given.replace(/[\p{Cc}--[\t\n\r]]/gv, '')) ?? '')
    .slice(-LINES_MAX_CHARS)
    .split(/\r\n|\r|\n/)
    .map(line => line.slice(0, LINE_MAX_CHARS));
  if (lines.at(-1) === '') lines.pop();
  const kept = keptLines(run);
  const all = [...kept.lines, ...lines].slice(-LINES_KEPT);
  runLines.set(run, { lines: all, heard: kept.heard + lines.length, ended: null });
}

export const linesOf = (run: number) => keptLines(run).lines;

// A run's lines after the first `after` it heard (by number, so a line said again is new each time), the number to
// read after next, and how many of them are no longer kept, numbered since this HQ started
export function linesAfter(run: number, after: number) {
  const { lines, heard } = keptLines(run);
  const first = heard - lines.length;
  const missed = Math.max(0, first - after);
  return { since: LINES_SINCE, next: heard, missed, lines: lines.slice(Math.max(0, after - first)) };
}

// A take its helper lost: its lines go, and the next take's are numbered on from them
export const clearLines = (run: number) => runLines.set(run, { ...keptLines(run), lines: [] });

// An ended run's lines, kept a while for its job (and those of runs that ended longer ago gone)
export function endLines(run: number) {
  const kept = runLines.get(run);
  if (kept) runLines.set(run, { ...kept, ended: kept.ended ?? Date.now() });
  for (const [id, { ended }] of runLines) if (ended && ended < Date.now() - ENDED_LINES_MS) runLines.delete(id);
}

function keptLines(run: number): RunLines {
  const kept = runLines.get(run);
  const gone = kept?.ended && kept.ended < Date.now() - ENDED_LINES_MS;
  return kept && !gone ? kept : { lines: [], heard: 0, ended: null };
}

// ---- helpers

function hashOf(key: string) {
  return createHash('sha256').update(key).digest('hex');
}

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const whole = (value: unknown) => (Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null);

const percent = (value: unknown) =>
  typeof value === 'number' && value >= 0 && value <= 100 ? Math.round(value) : null;

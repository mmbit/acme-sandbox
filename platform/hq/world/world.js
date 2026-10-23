// The company as HQ knows it: its rooms and people (each one's state, task, log and emote), its mascots (mascots.js),
// open requests and the party.
// Imported whole (`import * as world`): the shell and the renderers read it, and hear its signals. No DOM.
import { titleCase } from '../util.js';
import * as clock from './clock.js';
import * as mascots from './mascots.js';
import { EMOTES, EMOTE_S } from './emotes.js';

export { hour, lapse } from './clock.js';
export { mascots, pet, visit } from './mascots.js';

export let dev = false, company = {}, rooms = [], alumni = [], requests = 0, party = 0;
// The machines the board lends for long runs, each live, then this server (the coordinator's runs.ts listMachines), from
// the org's read and the 'machines' event. Every look draws the rig from them: `machine`, the lent machine at work (the
// fastest of those), else the fastest, none without one; Wire draws a key for each lent machine that's on (rigs()). Each
// in the shape the looks draw: { id, name, present, running: { job, agent, kind, title, since, cores, output } | null,
// size, gpuCount, body, glow, cpu, memory, gpu }, the last three its last minutes in percent (the last now) when it says,
// output its run's last lines. size: how big a build it is (rigSize), gpuCount how many it has; body and glow the colours the
// board gave its case and its lights (#rrggbb), null for the look's own.
export let machines = [], machine = null;
// On Air's shows ({ id, name, hosts }): whoever makes an episode of one is recording, and its free co-hosts join them
export let shows = [];
// The photo studio, from the org's read and the 'studio' event: null when the company doesn't run one, else { keeper (an
// agent id or null), waiting (photos in the board's batch), developing (photos with the keeper), editing (in the model now) }
export let studio = null;
// The agents' meetings (the coordinator's GET /api/meetings): live ones ({ id, topic, at, started, chair, seats: agent ids
// still in it, projects: the projects whose plans changed in it so far, once the plan step sends them }) and planned
// ones (the same, not started), each in time order. Brownstone seats a live meeting's people in its meeting room and
// shows its topic; the next planned ones go on the room's door. undefined until the first read finishes, null when the
// latest read failed: the room and its panel then say the meetings can't be read.
export let meetings;
// id → { id, data (the org's record), roomId, state, task, logs, emote ({ kind, s, left } or null), since (when its task
// began, ms), lines ({ add, del }: what its job's branch changes so far, the worker's reading), tokens ([ms, total]: what
// its job has written so far, the worker's readings over the last minutes), heard (when this page got its latest status
// from the feed, ms on this device's clock, to order it against an org read: setStatuses) }: one record per id for as
// long as HQ runs
export const agents = new Map();
const PARTY_S = 12;  // how long a party lasts
const TOKENS_KEPT_MS = 16 * 60_000;  // an agent's token readings, as the coordinator keeps them (events.ts)
const LOG_MAX = 80;  // log lines kept per agent

// ---- signals: fn(payload) after each change of that type, in the order they were added
const listeners = new Map();
// off() stops only this listening, not the same fn listening for a scene that replaced this one.
export function on(type, fn) {
  const own = payload => fn(payload);
  listeners.set(type, [...listeners.get(type) || [], own]);
  return () => listeners.set(type, listeners.get(type).filter(f => f !== own));
}
// (for world/'s own modules: the shell and the renderers only listen)
export const emit = (type, payload) => { for (const fn of listeners.get(type) || []) fn(payload); };

// The day n days on from today on the company's clock, where the server starts a day (later.ts), wherever this device is.
// Counted as a UTC date at noon, so this device's zone and clock changes move nothing.
export const dayIn = (n, now = Date.now()) => {
  const d = new Date(`${clock.companyFormats().dayAt(now)}T12:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
};
// How many days on the nth working day from today is: Monday to Friday, less the company's public holidays (GET /api/org's
// company.holidays, from Care's calendar). first: the first day it may be, 0 for today.
export function daysToWorkday(n, now = Date.now(), first = 1) {
  let days = first - 1;
  for (let left = n; left > 0;) {
    days += 1;
    const day = dayIn(days, now);
    const weekend = [0, 6].includes(day.getUTCDay());
    if (!weekend && !company.holidays?.has(day.toISOString().slice(0, 10))) left -= 1;
  }
  return days;
}

// The first day a card put aside now comes back on (later.ts always brings it back at 08:00 on the company's clock): today
// while its 08:00 is still ahead, so a card put aside after midnight comes back that morning; else tomorrow.
const BACK_HOUR = 8;
export function firstMorning(now = Date.now()) {
  return clock.companyFormats().hourAt(now) < BACK_HOUR ? 0 : 1;
}

// ---- the org chart
// The board, the commons and the departments become rooms, their people agents. Someone already here keeps
// their state, task and log; a newcomer starts from the org's status. mock: the org is dev mode's mock data. The company's
// clock is the coordinator's (GET /api/org).
export function setOrg(org, mock = dev) {
  dev = mock;
  company = { name: org.company?.brand, legal: org.company?.legal, ceo: org.company?.ceo, timeZone: org.company?.timeZone,
    holidays: new Set(org.company?.holidays ?? []) };
  clock.setTimeZone(company.timeZone);
  const members = org.board?.members || [], known = new Map(agents);
  rooms = []; agents.clear();
  const room = (id, name, r = {}, people, extra) => {
    rooms.push({ id, name, kind: r.kind || 'office', size: r.size || 'm', features: [], agentIds: people.map(a => a.id), board: false, deptId: null, asleep: false, ...extra });
    for (const a of people) agents.set(a.id, Object.assign(known.get(a.id) || { id: a.id, state: a.status?.state || 'idle', task: a.status?.task, since: Date.parse(a.status?.since) || undefined, lines: a.status?.lines, tokens: a.status?.tokens, jobs: a.status?.jobs, logs: [], emote: null }, { data: a, roomId: id }));
  };
  if (org.board) room('board', 'The Board', org.board.room || { kind: 'boardroom' },
    members.map(m => ({ role: 'Board', engine: m.human ? 'human' : m.engine, look: 'suit, tie, gold star pin', ...m, board: true })), { board: true });
  for (const c of org.commons || []) room(c.id, c.name || titleCase(c.id), c.room, [], { features: c.features || [] });
  for (const d of org.departments || []) room(d.id, d.name || titleCase(d.id), d.room, d.agents || [], { deptId: d.id });
  alumni = org.alumni || [];
  setMachines(org.machines);
  shows = org.shows ?? [];
  studio = org.studio ?? null; // (the org's signal says so)
  sleepCheck();
  emit('org', { added: [...agents.keys()].filter(id => !known.has(id)), removed: [...known.keys()].filter(id => !agents.has(id)) });
}
// a room goes dark when everyone in it is asleep; the board's never does
function sleepCheck() {
  for (const r of rooms) r.asleep = !r.board && r.agentIds.length > 0 && r.agentIds.every(id => agents.get(id).state === 'sleeping');
}

// ---- events from the company
const STATUS_LOG = { working: 'Working', waiting: 'Queuing for a seat', sleeping: 'Went to sleep', idle: 'Idle' };
const statusLine = (state, text) => `${STATUS_LOG[state] || state}${text ? ': ' + text : ''}`;
// A: the agent, B: whom they spoke to. unknown: the event names someone the org chart doesn't have yet (the
// shell reads the org again). Two feelings follow from events on their own: a job finished (working to idle) is happy,
// a post of one's own a celebration.
export function apply(ev) {
  const A = agents.get(ev.agent), B = agents.get(ev.to), was = A?.state;
  const log = (X, type, txt) => { if (!X) return; X.logs.push({ ts: ev.ts || Date.now(), type, text: txt }); if (X.logs.length > LOG_MAX) X.logs.shift(); };
  // (the feed's replay on (re)connecting: what was, for the logs; its current statuses follow.)
  if (ev.type === 'status' && A && ev.history) log(A, 'status', statusLine(ev.state || A.state, ev.text));
  else if (ev.type === 'status' && A) {
    const task = A.task;
    A.heard = Date.now();
    if (ev.state) A.state = ev.state;
    A.task = ev.text || (ev.state === 'idle' ? '' : A.task);
    // (since: a job's own start, when the status gives one: its clock goes on across its runs.)
    if (A.state === 'working' && (ev.since || was !== 'working' || A.task !== task)) A.since = Date.parse(ev.since ?? ev.ts) || Date.now();
    if (A.state !== 'working') A.lines = A.tokens = undefined;   // (a job's lines and tokens stay with it while it's at work)
    A.jobs = A.state !== 'working' ? undefined : ev.jobs ?? said(A.jobs, ev);
    const of = A.jobs?.find(j => j.id === ev.job);   // (with its jobs, the lines of the one it's of.)
    if (of) A.lines = of.lines;
    log(A, 'status', statusLine(A.state, ev.text));
    sleepCheck();
    emit('status', { agent: A.id, was });
    if (was === 'working' && A.state === 'idle') emote(A.id, 'happy');
  } else if (ev.type === 'chat' && A) {
    log(A, 'chat', `To ${B?.data.name || ev.to || 'everyone'}: ${ev.text}`);
    log(B, 'chat', `From ${A.data.name}: ${ev.text}`);
    emit('say', { agent: A.id, to: ev.to, text: ev.text });
  } else if (ev.type === 'post') {
    log(A, 'post', `Published “${ev.text}”`);
    emit('post', { agent: ev.agent, title: ev.text, board: ev.state === 'board' });
    emote(ev.agent, 'celebrate');
  } else if (ev.type === 'log' && A) {
    log(A, 'log', ev.text);

    if (A.data.steps && A.state === 'working' && ev.text) A.task = ev.text;
    emit('log', { agent: A.id, text: ev.text, tests: ev.tests || 0 });
  } else if (ev.type === 'lines' && A) {   // the lines their job's branch changes so far (the worker reads its clone)
    A.lines = { add: ev.add || 0, del: ev.del || 0 };
    const running = A.jobs?.find(j => j.id === ev.job);
    if (running) running.lines = A.lines;
    emit('lines', { agent: A.id });
  } else if (ev.type === 'tokens' && A) {   // what its job has written so far (a new job starts again from its first reading)
    const at = Date.parse(ev.ts) || Date.now(), kept = (A.tokens ?? []).filter(([t, n]) => t > at - TOKENS_KEPT_MS && n <= ev.total);
    A.tokens = [...kept, [at, ev.total || 0]];
    emit('tokens', { agent: A.id });
  } else if (ev.type === 'feel') emote(ev.agent, ev.emote);
  else if (ev.type === 'machines') setMachines(ev.machines);
  else if (ev.type === 'studio') setStudio(ev.studio);
  else if (ev.type === 'statuses') hydrate(ev.statuses);
  return { unknown: (ev.agent && !A && ev.agent !== 'board') || (ev.to && !B && ev.to !== 'board') };
}
// An agent's running jobs (the coordinator's events.ts RunningJob: id, task, project, thread, since, lines), newest
// first, once it said what it's doing in one of them: that one reads its words.
const said = (jobs, ev) => jobs?.map(j => (j.id === ev.job && ev.text ? { ...j, task: ev.text } : j));
// Who is at work, as the org's read has it (the coordinator's status of each): the feed alone misses what happened while
// it was cut off (a tablet asleep, a reconnect that replays only the latest events), and the ring and the order would
// keep that for good. asked: when the read was asked for; a status the feed brought since is newer and stays. One still at
// work takes the read's task and jobs too: the feed misses one job ending and the next starting just the same (the
// board's picture #67.)
export function setStatuses(org, asked) {
  for (const d of org.departments || []) for (const a of d.agents || []) {
    const A = agents.get(a.id), s = a.status;
    if (!A || !s?.state || (A.heard ?? 0) > asked) continue;
    take(A, s);
  }
  emit('read', { asked });
}
// One's status as the coordinator has it now, whole (events.ts Status)
function take(A, s) {
  const was = A.state, now = { state: s.state, task: s.task ?? '', since: Date.parse(s.since) || undefined, jobs: s.jobs };
  if (JSON.stringify(now) === JSON.stringify({ state: A.state, task: A.task ?? '', since: A.since, jobs: A.jobs })) return;
  Object.assign(A, now, { lines: s.lines, tokens: s.tokens });
  sleepCheck();
  emit('status', { agent: A.id, was });
}
// Who's at work as the feed opens, after its replay (the coordinator's status of each, as the org's read gives it: one
// it has none of is idle, a team member as its lead's session last said, the board as it is): as new as any status the feed brings, so
// newer than an org read asked before.
function hydrate(statuses) {
  for (const A of agents.values()) {
    const s = statuses[A.id] ?? (A.data.temp || A.data.board ? null : { state: 'idle' });
    if (!s) continue;
    A.heard = Date.now();
    take(A, s);
  }
}
export function setRequests(n) { requests = n; }
// The show an agent is making an episode of: its job's title is "On Air: <show>" (the coordinator's schedule.ts names it)
export const recording = A => (A?.state === 'working' && shows.find(s => A.task?.startsWith(`On Air: ${s.name}`))) || null;
// A free co-host of a show being recorded (idle, a host of it) joins at the mics
export const joining = A => (A?.state === 'idle' && shows.find(s => s.hosts.includes(A.id) && [...agents.values()].some(B => recording(B) === s))) || null;
export const onAir = () => [...agents.values()].some(A => recording(A));
// The machines from the org's read or their event; the looks hear each
export function setMachines(list) {
  machines = Array.isArray(list) ? list : [];
  const first = lent().toSorted((a, b) => (b.state === 'running') - (a.state === 'running') || (b.speed ?? 0) - (a.speed ?? 0))[0];
  machine = first ? rigOf(first) : null;
  emit('machines');
}
// The meetings from their read, or null when it failed; the looks hear them only when they changed
export function setMeetings(m) {
  const next = m && { live: m.live, planned: m.planned };
  if (JSON.stringify(next) === JSON.stringify(meetings)) return;
  meetings = next;
  emit('meetings');
}
// The live meeting an agent sits in (null: none, or the meetings can't be read), and the live meetings a meeting room
// holds: the rooms of kind 'meeting' take them in turn, so with one room it holds every one
export const meetingOf = id => meetings?.live.find(m => m.seats.includes(id)) ?? null;
export function meetingsIn(roomId) {
  const held = rooms.filter(r => r.kind === 'meeting'),
    k = held.findIndex(r => r.id === roomId);
  return k < 0 || !meetings ? [] : meetings.live.filter((_, i) => i % held.length === k);
}
// The photo studio, from a later read of the org or its event (null: none); the looks hear it
export function setStudio(s) { studio = s ?? null; emit('studio'); }
// The lent machines that are on: asking for work or running one
export const rigs = () => lent().filter(m => m.state === 'taking' || m.state === 'running').map(rigOf);
const lent = () => machines.filter(m => m.id !== 'server');
const rigOf = m => {
  const history = m.live?.history ?? [], gpu = history.filter(p => p.gpu !== undefined);
  return { id: m.id, name: m.name, present: m.state !== 'away', running: m.run ? { ...m.run, output: m.live?.lines ?? [] } : null,
    size: rigSize(m), gpuCount: m.gpuCount, body: m.body, glow: m.glow,
    ...(history.length ? { cpu: history.map(p => p.cpu), memory: history.map(p => p.mem) } : {}), ...(gpu.length ? { gpu: gpu.map(p => p.gpu) } : {}) };
};
// How big a build a machine is, from what it has: 3 a workstation (two or more GPUs, a GPU and at least 16 CPU cores,
// or at least 32 CPU cores), 1 a small one (under 8 CPU cores and no GPU), else 2, as for one that hasn't said yet
const rigSize = ({ cpus, gpuCount }) =>
  gpuCount > 1 || (gpuCount && cpus >= 16) || cpus >= 32 ? 3 : cpus && cpus < 8 && !gpuCount ? 1 : 2;
// the shell's look at the calendar: a new day, or a holiday starting or ending
export function checkDay() { const on = clock.checkDay(); if (on) emit('day', { holidays: on }); }

// How hard the company is working: the share of agents at it, how many on each engine, and whether anyone
// working sits by the loading dock (deliveries).
export function load() {
  const working = [...agents.values()].filter(A => A.state === 'working'), engines = {};
  for (const A of working) engines[A.data.engine] = (engines[A.data.engine] || 0) + 1;
  const dock = new Set(rooms.filter(r => r.kind === 'dock').map(r => r.id));
  return { busy: working.length / Math.max(1, agents.size), engines, deliveries: working.some(A => dock.has(A.roomId)) };
}

// id feels kind (one of EMOTES) for s seconds, over whatever they felt before (feel {agent, emote}). Someone the org
// chart doesn't have, or a kind HQ doesn't know (a newer coordinator's), is ignored: false.
export function emote(id, kind, s = EMOTE_S) {
  const A = agents.get(id);
  if (!A || !EMOTES[kind]) return false;
  A.emote = { kind, s, left: s };
  emit('feel', { agent: id, emote: kind });
  return true;
}

// ---- the board's own fun
export function startParty() { party = PARTY_S; emit('party'); }

// the shell's frame: the clock, the mascots, and the party and everyone's emote counting down
export function tick(dt) {
  clock.tick(dt); mascots.tick(dt, clock.darkness(clock.hour()));
  for (const A of agents.values()) if (A.emote && (A.emote.left -= dt) <= 0) A.emote = null;
  if (party > 0 && (party -= dt) <= 0) party = 0;
}

// Recurring work from company/schedule.yaml: every minute, due entries become jobs (once per slot).
import { readFileSync } from 'node:fs';
import { db } from './db.ts';
import { REPO_DIR } from './config.ts';
import { createJob, WORK_LEAD } from './jobs.ts';
import { codeIn, codeOf } from './jobcodes.ts';
import { companyFormats } from './company.ts';
import * as meetings from './meetings.ts';
import { oneTaskThread } from './made.ts';
import { projectDone } from './projectdone.ts';
import { endedEmpty } from './threadends.ts';
// (the entries and their projects in schedulelist.ts, which tools read too)
import { type Entry, entries, projectOf, routineProjectsOf } from './schedulelist.ts';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// A moment on the company's clock: its weekday as schedule.yaml writes it, its day and its time
function local(d: Date) {
  const f = companyFormats(), date = f.dayAt(d.getTime());
  return { day: DAYS[new Date(`${date}T12:00:00Z`).getUTCDay()], date, time: f.time(d.getTime(), 'en') };
}

// An entry is due from its time until the end of that day, so a restart around the slot doesn't skip it. Its runs go to
// its routine's project, so the projects come first: if they fail, no entry runs.
export function tick(now = new Date()) {
  const t = local(now), list = entries();
  keepProjects(list);
  // One bad entry (say, a job for the board, which createJob refuses) is logged and skipped, not fatal.
  for (const e of list) try { due(e, t); } catch (err) { console.error(`Schedule entry ${e.id}:`, err); }
}

// Weeks count from Monday 1970-01-05, so turns don't jump at New Year as ISO week numbers would.
function turn(week: string, date: string) {
  const m = week.match(/^(\d+) of (\d+)$/);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) throw new Error(`week must be "k of n", not "${week}"`);
  return Math.floor((Date.parse(date) - Date.parse('1970-01-05')) / 6048e5) % Number(m[2]) === Number(m[1]) - 1;
}

function due(e: Entry, t: ReturnType<typeof local>) {
  if (!e.at) return;
  if (e.week && !turn(e.week, t.date)) return;
  const every = e.at.match(/^every (\d+)h$/);   // every N hours, counted from local midnight
  if (every) {
    const n = Number(every[1]), hour = Number(t.time.slice(0, 2)), slot = `${t.date} ${String(hour - hour % n).padStart(2, '0')}h`;
    if (n > 0 && db.prepare('insert or ignore into schedule_runs (id, slot) values (?, ?)').run(e.id, slot).changes > 0)
      run(e, slot);
    return;
  }
  const [day, time] = e.at.includes(' ') ? e.at.split(' ') : [null, e.at];
  if ((day && day !== t.day) || !DAYS.includes(t.day) || t.time < time) return;
  const slot = t.date;
  const fresh = db.prepare('insert or ignore into schedule_runs (id, slot) values (?, ?)').run(e.id, slot).changes > 0;
  if (fresh) run(e, slot);
}

// The job's prompt: the shared routine's text with the company's own additions after it, or the entry's prompt alone.
function prompt(e: Pick<Entry, 'prompt' | 'routine'>) {
  if (!e.routine) return e.prompt ?? '';
  if (!/^[a-z0-9-]+$/.test(e.routine)) throw new Error(`routine must be a name in shared/routines/, not "${e.routine}"`);
  const base = readFileSync(`${REPO_DIR}/shared/routines/${e.routine}.md`, 'utf8').trim();
  return e.prompt ? `${base}\n\nOur own additions:\n${e.prompt.trim()}` : base;
}

// A routine that can't be read, or an entry whose project isn't its routine's,
// leaves the slot open, so the entry runs once it can (and logs every minute till then).
function run(e: Entry, slot: string) {
  let text, project;
  try { text = prompt(e); project = routineProject(e); } catch (err) { db.prepare('delete from schedule_runs where id = ? and slot = ?').run(e.id, slot); throw err; }
  // (an entry's runs share its code, the entry's `code:` word: a standing task.)
  // (in its routine's project, each job a one-task thread there)
  const word = e.code?.toUpperCase(), code = word && codeIn({ project }, word);
  const title = `${e.title} (${slot})`;
  const jobs = e.with ? meet(e, slot, text, code) : [createJob({ agent: e.agent, title, prompt: text,
    schedule: { entry: e.id, routine: e.routine ?? null, slot },
    downtime: e.downtime === true, model: e.model, effort: e.effort, thread: null, code: code || undefined }).id];
  db.prepare('update schedule_runs set job = ?, kind = ?, routine = ? where id = ? and slot = ?')
    .run(jobs[0], typeof e.kind === 'string' ? e.kind : null, e.routine ?? null, e.id, slot);
  // (a meeting's seats share its thread: they aren't tasks, so its order holds none of them. threadorder.ts isTask)
  const thread = oneTaskThread(project, { id: jobs[0], title: runName(e, slot) })!;
  db.prepare('update jobs set thread = ? where id in (select value from json_each(?))').run(thread, JSON.stringify(jobs));
}
// A run's thread's name: the entry's title and its slot in plain words ("Weekly books check, 26 Oct", "Morning round,
// 21 Oct 04:00")
const runName = (e: Pick<Entry, 'title'>, slot: string) => {
  const [, date, hour, time] = slot.match(/^(\d{4}-\d\d-\d\d)(?: (\d\d)h| (\d\d:\d\d))?/)!;
  return `${e.title}, ${companyFormats().day(date, 'en', { short: true })}${hour ? ` ${hour}:00` : time ? ` ${time}` : ''}`;
};

// An entry with `with:` sets a meeting now: its seats' jobs, its agent's first (the job its run records). An agent whose
// engine no seat runs, or an entry without its `code:`, leaves the slot open, like a routine that can't be read.
function meet(e: Entry, slot: string, brief: string, code: string | undefined) {
  const agents = [e.agent, ...(Array.isArray(e.with) ? e.with.map(String) : [])];
  const made = code
    ? meetings.create({ topic: `${e.title} (${slot})`, agents: [...new Set(agents)], at: Date.now(), calledBy: e.agent,
      brief, schedule: e.id, code })
    : "an entry with `with:` needs its `code:`, the word its meeting's seats carry";
  if (typeof made === 'string') {
    db.prepare('delete from schedule_runs where id = ? and slot = ?').run(e.id, slot);
    throw new Error(made);
  }
  return made.seats.toSorted((a, b) => Number(b.agent === e.agent) - Number(a.agent === e.agent)).map(s => s.job);
}

// A routine is a project like any other, whose threads its schedule opens: each entry's runs go to the project it names
// (`project:`, else its id), which HQ keeps from the schedule (by 'schedule.yaml'), named after its first entry's title,
// owned by its agent and in no business. So the board sees a routine's runs as its threads, with their plans and times.
// A routine no entry names any more ends as any project does, once its threads and work have settled (projectdone.ts),
// and opens again if one comes back. An entry whose project id another project holds runs nowhere till it names its own
// (routineProject).
export const ROUTINES = 'schedule.yaml';
function keepProjects(list: Entry[]) {
  const now = new Date().toISOString(), projects = routineProjectsOf(list), kept = new Set(projects.map(p => p.id));
  const keep = db.prepare(`insert into projects (id, name, owner, created, by) values (?, ?, ?, ?, '${ROUTINES}')
    on conflict(id) do update set name = excluded.name, owner = excluded.owner, status = 'open', done = null
    where projects.by = '${ROUTINES}' and (name, owner, status) is not (excluded.name, excluded.owner, 'open')`);
  for (const p of projects) keep.run(p.id, p.name, p.owner, now);
  for (const p of routineProjects()) if (!kept.has(p.id)) projectDone(p.id, p.owner);
  intoThreads(list);
}
const routineProjects = () =>
  db.prepare(`select id, owner from projects where by = ? and status = 'open'`).all(ROUTINES) as { id: string; owner: string }[];

// The runs recorded before their routines had projects, whatever became of them since, each a thread of its own there
// with its meeting's other seats and its review loop's jobs, which then settles as a run's own does (threadends.ts
// endedEmpty: done once its work is all in). An entry gone has no project to take its runs.
function intoThreads(list: Entry[]) {
  const runs = db.prepare(`select r.id entry, r.slot, r.job from schedule_runs r join jobs j on j.id = r.job
    where j.thread is null`).all() as { entry: string; slot: string; job: number }[];
  const threadOf = new Map<number, string>();
  for (const run of runs) {
    const e = list.find(x => x.id === run.entry);
    if (!e) continue;
    const thread = oneTaskThread(routineProject(e), { id: run.job, title: runName(e, run.slot) })!;
    const seat = meetings.seatOfJob(run.job);
    for (const job of seat ? meetings.seats(seat.meeting).map(s => s.job) : [run.job]) threadOf.set(job, thread);
  }
  if (!threadOf.size) return;
  const family = db.prepare(`select j.id, ${WORK_LEAD} lead from jobs j where j.thread is null
    and ${WORK_LEAD} in (select value from json_each(?))`).all(JSON.stringify([...threadOf.keys()])) as
    { id: number; lead: number }[];
  const move = db.prepare('update jobs set thread = ? where id = ?');
  for (const j of family) move.run(threadOf.get(j.lead)!, j.id);
  for (const thread of new Set(threadOf.values())) endedEmpty(thread);
}
// The project an entry's runs go to: its routine's, which keepProjects keeps open while an entry names it
function routineProject(e: Pick<Entry, 'id' | 'project'>) {
  const id = projectOf(e);
  if (!routineProjects().some(p => p.id === id))
    throw new Error(`its project ${id} is another project's: give the entry a project of its own (project:)`);
  return id;
}

// When an entry runs next, in the company's time and plain words: "today 18:00", "tomorrow 07:45", "Monday 07:30", "Mon 12
// Oct 07:30" (a week or more away: a rotation's turn). One whose time has come today but hasn't run is "due now" (it runs
// within the minute). `soon` orders them: minutes from the start of today, in the company's time.
function nextRun(e: Pick<Entry, 'id' | 'at' | 'week'>, now = new Date()) {
  const t = local(now), ran = (slot: string) => !!db.prepare('select 1 from schedule_runs where id = ? and slot = ?').get(e.id, slot);
  const day = (d: number) => { const x = new Date(Date.parse(`${t.date}T12:00:00Z`) + d * 864e5); return { date: x.toISOString().slice(0, 10), x }; };
  const f = companyFormats();
  const named = (d: number, date: string) =>
    d === 0 ? 'today' : d === 1 ? 'tomorrow' : d < 7 ? f.weekday(date, 'en') : f.day(date, 'en', { weekday: true, short: true });
  const say = (d: number, time: string) => { const { date } = day(d), [h, m] = time.split(':').map(Number);
    return { label: `${named(d, date)} ${time}`, soon: d * 1440 + h * 60 + m }; }, now_ = { label: 'due now', soon: -1 };
  if (!e.at) return null;
  const every = e.at.match(/^every (\d+)h$/);
  for (let d = 0; d < 7 * 53; d++) {
    const { date, x } = day(d);
    try { if (e.week && !turn(e.week, date)) continue; } catch { return null; }
    if (every) {
      const n = Number(every[1]), hour = Number(t.time.slice(0, 2)), slot = hour - hour % n;
      if (!(n > 0)) return null;
      if (d) return say(d, '00:00');
      if (!ran(`${date} ${String(slot).padStart(2, '0')}h`)) return now_;
      if (slot + n < 24) return say(0, `${String(slot + n).padStart(2, '0')}:00`);
      continue;
    }
    const [wd, time] = e.at.includes(' ') ? e.at.split(' ') : [null, e.at];
    if (wd && wd !== DAYS[x.getUTCDay()]) continue;
    if (!d && ran(date)) continue;
    return !d && t.time >= time ? now_ : say(d, time);
  }
  return null;
}

const next = (e: Entry) => { const n = nextRun(e); return { next: n?.label ?? null, soon: n?.soon ?? null }; };

// An entry's time in plain words: "daily 07:00", "Mondays 08:00", "every 4 hours", "on demand"
const when = (at: string) => { if (!at) return 'on demand'; const n = at.match(/^every (\d+)h$/)?.[1]; if (n) return `every ${n} hours`; const [d, t] = at.includes(' ') ? at.split(' ') : [null, at]; return d ? `${FULL[DAYS.indexOf(d)]}s ${t}` : `daily ${t}`; };

// The recurring work as the board sees it (GET /api/schedule: On Air and the HUD's line): who, what, when in plain words,
// when it last ran, when it runs next, and its project.
export function recurring(list = entries()) {
  const last = db.prepare('select max(slot) as slot from schedule_runs where id = ?');
  return list.map(e => ({ id: e.id, agent: e.agent, title: e.title, when: when(e.at) + (e.week ? `, week ${e.week}` : ''),
    downtime: e.downtime === true, last: (last.get(e.id) as { slot: string | null }).slot, ...next(e), project: projectOf(e) }));   // (next, soon)
}

// Each routine's schedule as its project shows it (projects.ts listProjectBoard), by project: its interval in words (its
// entries' times; entries taking turns at one time, every week of their rotation, are that time), when it runs next,
// when it last ran, and whether it waits for spare seats (downtime, all its entries). One no entry names any more, open
// till its runs settle (keepProjects), is off the schedule.
export function routines() {
  const listed = entries(), rows = recurring(listed);
  return new Map(routineProjects().map(({ id: project }) => {
    const projectEntries = listed.filter(e => projectOf(e) === project);
    const schedules = rows.filter(row => row.project === project);
    if (!schedules.length) return [project, { when: 'off the schedule', next: null, soon: null, last: null, downtime: false }];
    const soonest = schedules.toSorted((a, b) => (a.soon ?? Infinity) - (b.soon ?? Infinity))[0];
    const intervals = projectEntries.map(e => {
      const rotation = e.week && !takesTurns(projectEntries, e.at) ? `, week ${e.week}` : '';
      return when(e.at) + rotation;
    });
    const last = schedules.map(row => row.last).filter(Boolean).sort().at(-1) ?? null;
    return [project, { when: [...new Set(intervals)].join(' · '), next: soonest.next, soon: soonest.soon,
      last, downtime: schedules.every(row => row.downtime) }];
  }));
}
function takesTurns(list: Entry[], at: string) {
  const rotationLengths = list.filter(e => e.at === at).map(e => e.week?.match(/^\d+ of (\d+)$/)?.[1]);
  return rotationLengths.every(length => length && Number(length) === rotationLengths.length);
}

// On Air's Run now (POST /api/schedule/run): the entry's job at once, in a slot of its own, so the scheduled run still
// comes. Once a minute per entry, so a double tap starts one. (The projects view has none: the board asks for a run.)
export function runNow(id: string, now = new Date()) {
  const list = entries(), e = list.find(x => x.id === id);
  if (!e) return [404, `No recurring entry ${id}`];
  keepProjects(list); // (one named since the last tick has its project too.)
  const t = local(now), slot = `${t.date} ${t.time}, on demand`;
  if (!db.prepare('insert or ignore into schedule_runs (id, slot) values (?, ?)').run(e.id, slot).changes)
    return [409, 'Already started this minute'];
  run(e, slot);
  const { job } = db.prepare('select job from schedule_runs where id = ? and slot = ?').get(e.id, slot) as { job: number };
  return { job, job_code: codeOf(job) }; // (its code, as HQ names it.)
}

// (a tick that fails is logged, and the next one tries again)
const ticked = () => { try { tick(); } catch (err) { console.error('The schedule:', err); } };
export const startSchedule = () => { ticked(); setInterval(ticked, 60_000); };

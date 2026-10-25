// A service that keeps crashing (the server's containers.json, infra/containers.py, written each minute): the process
// role (org.yaml's roles) gets a job to find why and fix it, one job per service, as stalljobs.ts does for a stall.
// Crashing: its container restarted CRASHES times within WINDOW_MS. While its job is queued, a new reading is added to
// its brief; once it has started, it holds the alarm until its work is deployed (or never will be: wakes.ts deployed).
import { readFileSync } from 'node:fs';
import { DATA_DIR } from './config.ts';
import { db, setting, remember } from './db.ts';
import { createJob } from './jobs.ts';
import { roles } from './company.ts';
import { deployed } from './wakes.ts';

export const CRASHES = 3;
const WINDOW_MS = 15 * 60_000;
type Container = { service: string; state: string; restarts: number };

// Each service's readings in the window: when, and its container's restart count then
const seen = new Map<string, { at: number; restarts: number }[]>();

export function crashCheck(now = Date.now(), file = `${DATA_DIR}/containers.json`) {
  let read: { at: string; containers: Container[] };
  try {
    read = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  // (a reading older than the window is a server that stopped writing it: nothing to judge)
  if (!(now - Date.parse(read.at) < WINDOW_MS)) return;
  for (const c of read.containers) {
    const kept = (seen.get(c.service) ?? []).filter(r => now - r.at < WINDOW_MS && r.restarts <= c.restarts);
    kept.push({ at: now, restarts: c.restarts });
    seen.set(c.service, kept);
    const restarts = c.restarts - kept[0].restarts;
    if (restarts >= CRASHES) crashing(c, restarts, Math.round((now - kept[0].at) / 60_000), now);
  }
}

function crashing(c: Container, restarts: number, minutes: number, now: number) {
  const key = `crashjob:${c.service}`,
    open = Number(setting(key)) || 0,
    line = `\n- At ${new Date(now).toISOString()}: ${restarts} restarts in ${minutes} min, now ${c.state}.`;
  if (open && addTo(open, line)) return;
  if (open && !deployed(String(open))) return;
  const { id } = createJob({
    agent: roles().process,
    title: `${c.service} keeps crashing: ${restarts} restarts in ${minutes} min`,
    prompt: `The server's ${c.service} service keeps crashing: its container restarted ${restarts} times in ${minutes} minutes (the server's containers.json, crashes.ts). Whatever it serves is down or dropping meanwhile.

Find why and fix it: its last lines are in \`hq report\` (the section named after it, for HQ's own services), and the last change to it is the first suspect. If the real fix takes long, get it running first (undo what broke it), then fix it properly. After your work is deployed, check in \`hq report\` that its restarts stopped, and say in your report what it was. The same service crashing again before then queues no second job: until you start, each reading is added below.

The readings:${line}`,
  });
  remember(key, String(id));
}

// A reading added to its service's job, if that job hasn't started yet
const addTo = (job: number, line: string) =>
  db
    .prepare(`update jobs set prompt = prompt || ? where id = ? and status = 'queued' and session is null`)
    .run(line, job).changes > 0;

// One uid and gid per worker slot, so a job can't touch another's worktree, token or verdict.
//
// A job lives in two folders: its clone (/work/jobs/<n>, the agent's cwd, with .hq/) and its home
// (/work/homes/<n>: HOME, TMPDIR, the Claude or Codex config with the job's session). Both belong to the slot
// running the job, 0700; while the job waits (paused, parked, between runs) they belong to root, so the next job
// in that slot can't reach them either. When a job ends, everything its uid still runs is killed and what it left
// in the shared temp folders is removed. uid 1500 (the keeper) signs seats in and keeps their credentials in
// /seats (0700); it runs no job.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, chownSync, lchownSync, lstatSync, mkdirSync, renameSync } from 'node:fs';

export type Ids = { uid?: number; gid?: number };
export const KEEPER = 1500;
export const FIRST_SLOT = 1501;
export const MAX_SLOTS = 16;   // the Dockerfile creates slot1..slot16 (uid and gid 1501..1516)
// The slot isolation test's own two users (slots.test.ts, slottest1 and slottest2 in the Dockerfile), never a slot's: it
// kills what they run, and it runs at every start, a reload's too, while the runs taken over go on in their slots
// (detached.ts).
export const TEST_IDS = [FIRST_SLOT + MAX_SLOTS, FIRST_SLOT + MAX_SLOTS + 1].map(uid => ({ uid, gid: uid }));

// The worker's slots, each with its own slot user for its whole life: slot1 … slot15 run any engine's jobs, and the last
// user is the intercom's (chat), so the board's chat with the CEO never waits behind long jobs.
export type SlotUser = { uid: number; gid: number; name: string };
export const CHAT_SLOT = 'chat';
export const SLOT_IDS = new Map(Array.from({ length: MAX_SLOTS }, (_, i): [string, SlotUser] => {
  const uid = FIRST_SLOT + i, name = `slot${i + 1}`;
  return [i < MAX_SLOTS - 1 ? name : CHAT_SLOT, { uid, gid: uid, name }];
}));
export const WORK_SLOTS = [...SLOT_IDS.keys()].filter(slot => slot !== CHAT_SLOT);

export const jobDirs = (work: string, id: number) => ({ dir: `${work}/jobs/${id}`, home: `${work}/homes/${id}`, confirmationHome: `${work}/asks/${id}` });

// A folder root made itself, in a parent only root can write: never a symlink someone swapped in.
function realDir(p: string) {
  const st = lstatSync(p);
  if (!st.isDirectory()) throw new Error(`${p} is not a plain folder`);
  return st;
}

// Gives a job's folders to a slot (or to root while the job waits). chown -R never follows a symlink, and a hard
// link can only point at a file its maker owned (fs.protected_hardlinks, which the worker checks at start). A setuid
// file only ever carries its own slot's uid, and the shared temp folders are swept of those (sweep).
export function own(paths: string[], ids: Ids) {
  if (ids.uid === undefined || process.getuid!() !== 0) return;   // local test setup: one uid, nothing to hand over
  for (const p of paths) {
    realDir(p);
    execFileSync('chown', ['-R', `${ids.uid}:${ids.gid ?? ids.uid}`, '--', p]);
    chmodSync(p, 0o700);
  }
}

// A folder only root made, in a parent only root can write: whatever else is there (another uid's folder, a
// symlink) is moved aside unused, and root makes a new one.
export function rootDir(p: string, mode: number, gid = 0) {
  const st = lstatSync(p, { throwIfNoEntry: false }), ours = st?.isDirectory() && st.uid === 0;
  if (st && !ours) renameSync(p, `${p}.untrusted-${Date.now()}`);
  if (!ours) mkdirSync(p, { mode });
  lchownSync(p, 0, gid); chmodSync(p, mode);
}

// Creates a job's folder for its slot: 0700, the slot's alone.
export function makeDir(p: string, ids: Ids) {
  mkdirSync(p, { mode: 0o700 });
  if (ids.uid !== undefined && process.getuid!() === 0) chownSync(p, ids.uid, ids.gid ?? ids.uid);
  chmodSync(p, 0o700);
}

// Ends everything a slot's uid still runs (a job's background processes end with the job). kill(-1) as that uid
// reaches exactly its own processes; repeated, so a process forked meanwhile goes too. The kill process is the
// slot's, so the job's processes can read its environment before the signal lands: it gets nothing but PATH.
export function killAll(ids: Ids) {
  if (ids.uid === undefined || ids.uid === process.getuid!() || ids.uid < FIRST_SLOT) return;
  // the shell's own kill: procps' kill takes no "-s KILL -- -1" (a usage error, so nothing died)
  for (let i = 0; i < 3; i++) spawnSync('sh', ['-c', 'kill -9 -1'],
    { uid: ids.uid, gid: ids.gid ?? ids.uid, env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
}

// Before a job's slot launches the CLI again in the same run (a reviewer asked whether its verdict stands, worker.ts):
// whatever the run left running ends. The caller supplies a confirmation home under the root-owned asks/ parent,
// outside the review's home, so the CLI cannot inherit instructions or skills the review left there. The review's
// session stays to resume in. The caller lays the confirmation's config and removes its home once it ends.
export function askHome(as: Ids, confirmationHome: string) {
  killAll(as);
  execFileSync('rm', ['-rf', '--', confirmationHome]);
  makeDir(confirmationHome, as);
  return confirmationHome;
}

// What a slot's uid left in the folders every uid can write. A setuid copy of a shell left there would let a
// job in another slot become this uid while the next job (say, the consolidator's) runs in it.
export const TEMP = ['/tmp', '/var/tmp', '/run/lock', '/dev/shm', '/dev/mqueue'];
export function sweep(ids: Ids, dirs = TEMP) {
  if (ids.uid === undefined || ids.uid < FIRST_SLOT || process.getuid!() !== 0) return;
  for (const d of dirs) spawnSync('find', [d, '-xdev', '-mindepth', '1', '-user', String(ids.uid), '-delete'], { stdio: 'ignore' });
}

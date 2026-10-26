// An alarm for the CEO (alarms.ts) once the server's disk is FULL_AT used (the disk DATA_DIR is on, which holds Docker,
// the volumes and the jobs' folders): one each time it fills up, and the next only after it was back under CLEAR_AT (the
// jobs' folders move it a few GB either way all day). Only a disk past FULL_AT for HIGH_FOR, which the setting disk.high
// times: a deploy's build temporarily uses disk and gives it back. Jobs stop once the disk is full, so the CEO
// hears of it while there's still room to act.
import { statSync, statfsSync } from 'node:fs';
import { DATA_DIR, DEPLOY_BUILD_RESERVE_GB } from './config.ts';
import { setting, remember } from './db.ts';
import * as alarms from './alarms.ts';
import { findAgent } from './jobs.ts';
import { STANDING } from './jobcodes.ts';
import { roles } from './company.ts';

const FULL_AT = 0.85,
  CLEAR_AT = 0.8,
  HIGH_FOR = 20 * 60_000,
  ALARM = 'disk';

type Disk = { blocks: number; bavail: number; bsize: number };

export function diskCheck(dir = DATA_DIR, read: (dir: string) => Disk = statfsSync, now = Date.now()) {
  let disk: Disk;
  try {
    disk = read(dir);
  } catch {
    return;
  }
  const used = 1 - disk.bavail / disk.blocks;
  if (used < CLEAR_AT) alarms.end(ALARM, undefined, now);
  if (used < FULL_AT) remember('disk.high', null);
  else if (!setting('disk.high')) remember('disk.high', String(now));
  const high = Number(setting('disk.high') ?? now);
  if (!alarms.isOn(ALARM) && (used < FULL_AT || now - high < HIGH_FOR)) return;
  const free = ((disk.bavail * disk.bsize) / 2 ** 30).toFixed(1);
  const line = `The server's disk is ${Math.round(used * 100)}% full, ${free} GB free`;
  const lead = findAgent(roles().process)?.name ?? roles().process;
  const prompt =
    `${line}, past ${FULL_AT * 100}% for ${Math.round((now - high) / 60_000)} minutes. When it's full, jobs and ` +
    "deploys stop, and the clean-up after each deploy hasn't brought it down. " +
    `${lead}'s Process team looks at what holds it: queue them a job (hq job) if none is on it. If the jobs simply ` +
    "need more room, a Hetzner Volume (extra storage, a few euros a month) is the board's to approve.";
  // (word)
  alarms.raise(
    ALARM,
    line,
    { title: "The server's disk is filling up", urgent: false, prompt, word: STANDING.disk },
    now,
  );
}

// SQLite can journal its whole database while reporting or backup copies another database.
// Existing server use is already out of free space.
export function jobReserve() {
  const databaseBytes = statSync(`${DATA_DIR}/hq.db`).size;
  const buildBytes = DEPLOY_BUILD_RESERVE_GB * 2 ** 30;
  const disk = statfsSync(DATA_DIR);
  return {
    freeBytes: disk.bavail * disk.bsize,
    databaseBytes,
    buildBytes,
    reserveBytes: buildBytes + 2 * databaseBytes,
  };
}

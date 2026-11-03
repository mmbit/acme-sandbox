// The board's screens a push's check found changed (platform/hq/screens-compare.mjs): their before|after sheets kept in
// the worker's store under the pushed commit, readable by every job, and the check's answer names the kept sheets. The
// round's ruling opens these (the coordinator's screens.ts rulingStep) instead of rendering both sides again behind the
// worker's one browser slot. Each sheet is read as the job's own user (renders.ts read), so a planted symlink can't point
// root at its secrets, and kept only under its own screen's name. A check whose sheets couldn't all be kept is one that
// couldn't tell: its ruling renders them itself. Kept for a week, long enough for any round's ruling of its push.
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { CheckOutcome } from './pushchecks.ts';
import { read, type Who } from './renders.ts';

type Shot = { screen: string; look: string; device: string; sheet?: string | null };

const KEPT_MS = 7 * 86400e3;
const UNFINISHED_MS = 3600e3; // (a copy takes seconds: an hour-old one is a worker's stopped mid-copy)
const SHEET_MAX = 64 * 2 ** 20; // (a sheet is a few MB at most)
const NAME = /^[a-z0-9]+$/i;

export async function keepScreens(store: string, who: Who, sha: string, outcome: CheckOutcome): Promise<CheckOutcome> {
  const lines = outcome.report.trimEnd().split('\n'),
    last = lines.findLastIndex(line => line.trim().startsWith('{'));
  const answer = last < 0 ? undefined : parsed(lines[last]);
  const shots = (answer?.rendered === true && Array.isArray(answer.changed) ? answer.changed : []) as Shot[];
  if (outcome.passed !== true || !shots.some(shot => shot.sheet)) return outcome;
  mkdirSync(store, { recursive: true });
  prune(store);
  const kept = `${store}/${sha}`,
    tmp = `${store}/.${randomBytes(6).toString('hex')}`;
  mkdirSync(tmp, { mode: 0o755 });
  const changed: Shot[] = [];
  try {
    for (const shot of shots) {
      const name = `${shot.screen}-${shot.look}-${shot.device}-sheet.png`;
      if (!shot.sheet) {
        changed.push(shot);
        continue;
      }
      if (![shot.screen, shot.look, shot.device].every(part => NAME.test(part)) || basename(shot.sheet) !== name)
        throw new Error(`${shot.sheet} isn't its screen's sheet`);
      writeFileSync(`${tmp}/${name}`, await read(who, shot.sheet, SHEET_MAX), { mode: 0o444 });
      changed.push({ ...shot, sheet: `${kept}/${name}` });
    }
    chmodSync(tmp, 0o755);
    rmSync(kept, { recursive: true, force: true });
    renameSync(tmp, kept);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    const why = `Its sheets couldn't be kept for the ruling (${(err as Error).message}), so the ruling renders them itself.`;
    return { passed: null, report: `${why}\n\n${outcome.report}` };
  }
  // (the check's answer, naming the kept sheets instead of those in the tests' checkout, which removeTested deletes)
  const keptAnswer = { ...answer, changed };
  return {
    ...outcome,
    report: [...lines.slice(0, last), JSON.stringify(keptAnswer), ...lines.slice(last + 1)].join('\n'),
  };
}

function parsed(line: string) {
  try {
    return JSON.parse(line) as { rendered?: unknown; changed?: unknown };
  } catch {
    return undefined;
  }
}

// The store's pushes older than a week, and any half-kept folder of a worker stopped mid-copy (as root: GNU rm never
// follows a symlink, and the store is root's)
function prune(store: string) {
  for (const name of readdirSync(store)) {
    const path = `${store}/${name}`,
      stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && Date.now() - stat.mtimeMs > (name.startsWith('.') ? UNFINISHED_MS : KEPT_MS))
      rmSync(path, { recursive: true, force: true });
  }
}

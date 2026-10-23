// What a work job's memory copy gives back to the shared memory when the job ends. The worker remembers what the
// shared memory held when the copy was made (`start`), so only what the job itself changed goes back: an unchanged file
// is left alone (it would undo what another job wrote since), a file the job deleted goes (only one it started with,
// only if nobody changed it since, and into the keeper's trash, not for good), and a file both this job and another changed is merged, keeping both sides' lines.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

export type Files = Map<string, string>;
// A memory folder: every plain .md name in it, and the files that were read (the first 500 by name, see worker.ts).
// A name without a file is unknown, never taken for missing.
export type Snap = { files: Files; names: Set<string> };
export type Plan = { write: Files; remove: string[]; notes: string[] };

export const MAX_CHARS = 64_000;
export const plainName = (n: string) => /^[\w.-]+\.md$/.test(n);

// `mine` is the job's copy now, `shared` the shared memory now, `start` the shared memory as the job's copy was made
// from it (empty when the copy began empty: the job made every file in it).
export function copyBack(start: Snap, mine: Snap, shared: Snap, merge = union): Plan {
  const plan: Plan = { write: new Map(), remove: [], notes: [] };
  const put = (n: string, text: string) => {
    if (text.length <= MAX_CHARS) plan.write.set(n, text);
    else plan.notes.push(`${n} not kept (${text.length} characters, over 64,000)`);
  };
  const unread = (s: Snap, n: string) => s.names.has(n) && !s.files.has(n);
  const past = [...mine.names].filter(n => !mine.files.has(n));
  if (past.length) plan.notes.push(`${past.length} files in the copy past the first 500 or unreadable, not kept: ${past.join(', ')}`);
  for (const [n, text] of mine.files) {
    const base = start.files.get(n), theirs = shared.files.get(n);
    if (unread(shared, n)) { plan.notes.push(`${n} couldn't be read in the shared memory: not kept`); continue; }
    if (text === base || text === theirs) continue;                 // the job didn't change it, or nothing to do
    if (unread(start, n)) { plan.notes.push(`${n} unknown at the start (past the first 500 files): not kept`); continue; }
    if (theirs === undefined && base !== undefined) plan.notes.push(`${n} deleted by another job but changed here: back`);
    if (theirs === undefined || theirs === base) put(n, text);       // only this job changed it (or it's new here)
    else {
      let merged: string;
      try { merged = merge(text, base ?? '', theirs); } catch { merged = `${theirs}\n${text}`; }   // lose neither side
      put(n, merged); plan.notes.push(`${n} changed by another job too: merged`);
    }
  }
  if (start.names.size && !mine.names.size) { plan.notes.push('the whole copy is gone: nothing deleted'); return plan; }
  for (const [n, base] of start.files) {
    if (mine.names.has(n) || !shared.names.has(n)) continue;
    if (shared.files.get(n) === base) plan.remove.push(n);
    else if (unread(shared, n)) plan.notes.push(`${n} deleted here but couldn't be read in the shared memory: kept`);
    else plan.notes.push(`${n} deleted here but changed by another job since: kept`);
  }
  return plan;
}

// The three folders a job's memory moves between, each read and written by the worker as its owner: the shared
// memory, the job's copy (in its home) and the start that copy was made from (the keeper's, so it outlives a restart).
export type Folders = {
  shared(): Snap | undefined;
  readShared(name: string): string | undefined;
  copy(): Snap | undefined;              // undefined: the job has no copy (or it can't be listed)
  start(): Snap | undefined;             // undefined: none kept, or one cut short
  keep(plan: Plan): void;                // plan.write into the shared memory, plan.remove to its trash
  setCopy(files: Files | null): void;    // null removes it
  setStart(snap: Snap | null): void;
  log(note: string): void;
  unmaskedCopy?: boolean;                // the copy on disk holds a value copy() shows masked (masked, below)
};

// At a run's end: what the job changed goes back, then its copy and start go (the next run gets new ones), so a paused
// job's copy can't bring back later what other jobs have deleted or merged since.
// Every copy the worker hands out to a job without a customer's details has a start, so a copy without one is of unknown make: one from
// before the worker kept starts, or one a removal couldn't clear (a restart, a folder the job locked). Nothing from it
// goes back, not even a file the shared memory lacks: that may be one another job deleted since, for holding a secret.
// A job handed a customer's own details (jobs.ts holdsCustomerData) gives nothing back: what it writes may hold them, and
// every later job reads the shared memory into its context (charter rule 7). Its copy stays with it for its later runs,
// and its start goes, so nothing from that copy can go back later either.
export function giveBack(f: Folders, customers: boolean) {
  const mine = f.copy();
  if (customers) {
    f.setStart(null);
    if (mine) f.log("holds a customer's details: nothing went back, the copy stays with the job");
    return;
  }
  if (!mine) return;
  const start = f.start(), shared = start && f.shared();
  if (start && !shared) return;                                   // kept for the next hand-out to try again
  if (start && shared) {
    // Every shared file this job could write or delete is read, past the first 500 too, so none is taken for missing.
    for (const n of new Set([...mine.files.keys(), ...start.files.keys()])) {
      if (!shared.names.has(n) || shared.files.has(n)) continue;
      const text = f.readShared(n);
      if (text !== undefined) shared.files.set(n, text);
    }
    const plan = copyBack(start, mine, shared);
    f.keep(plan);
    for (const note of plan.notes) f.log(note);
  } else f.log('a copy with no start kept for it: removed, nothing from it went back');
  // The start goes first: a removal of the copy cut short must never leave a partial copy next to its full start,
  // which would take every file it lost for one the job deleted. A copy left with no start gives nothing back.
  f.setStart(null);
  f.setCopy(null);
}

// At a run's start: a copy whose end was never seen (a restart cut the run off) goes back first, against the start
// kept for it. Then the job's copy and its start are written from the same read of the shared memory, and nothing in
// here waits, so no other job's end can change the shared memory in between. The start is written only once the whole
// copy is: a start next to a copy cut short would take every file the copy missed for one the job deleted. A hand-out
// that fails partway removes the copy and keeps an empty start, so the job starts with no copy and what it writes goes
// back as its own; if the copy can't be removed either, there's no start and nothing from it goes back.
// A job with a customer's details keeps the copy it has from an earlier run (its own memory, since nothing from it goes
// back), masked again if a value in it was saved as a key since, or gets one with no start.
export function handOut(f: Folders, customers: boolean) {
  if (customers) {
    f.setStart(null);
    const mine = f.copy(), now = mine ? undefined : f.shared();
    if (mine && f.unmaskedCopy) f.setCopy(mine.files);
    if (now) f.setCopy(now.files);
    return;
  }
  if (f.copy()) giveBack(f, false);
  const now = f.shared();
  if (!now) return;
  f.setStart(null);
  try { f.setCopy(now.files); f.setStart(now); }
  catch (err) {
    try { f.setStart(null); f.setCopy(null); f.setStart({ files: new Map(), names: new Set() }); } catch {}
    throw err;
  }
  if (now.names.size > now.files.size) f.log(`${now.names.size - now.files.size} shared files not in the copy (past the first 500, or unreadable)`);
}

// The folders as the job sees them, each file through the coordinator's mask (a key's value becomes its name): the job's
// copy, and the shared memory it's handed. A value written there before it was saved as a key stays in the folder (the
// coordinator scrubs only its own database: db.ts scrub()), so it's masked on the way out, every time. The mask waits on
// the coordinator, and handOut and giveBack read the shared memory without waiting (see handOut), so each shared text is
// masked here first and then looked up by its raw text when they read it: one changed in between is left out of that
// read, as an unreadable one is. What keep() writes is made of masked texts, so it reads back as itself. A folder it
// can't mask loses its start, so nothing from its copy goes back, and its copy, so a resumed job keeps none unmasked:
// nothing is handed out. A copy that can't be removed throws, and the job doesn't start.
export async function masked(f: Folders, mask: (text: string) => Promise<string>): Promise<Folders | null> {
  try {
    const mine = f.copy(), shared = f.shared(), seen = new Map<string, string>();   // raw text → masked
    const copy: Files = new Map();
    for (const [n, text] of mine?.files ?? []) copy.set(n, await mask(text));
    for (const n of shared?.names ?? []) {
      const text = shared!.files.get(n) ?? f.readShared(n);
      if (text !== undefined && !seen.has(text)) seen.set(text, await mask(text));
    }
    const known = (snap: Snap | undefined) => {
      if (!snap) return undefined;
      const files: Files = new Map();
      for (const [n, text] of snap.files) if (seen.has(text)) files.set(n, seen.get(text)!);
      return { files, names: snap.names };
    };
    return { ...f, unmaskedCopy: [...mine?.files ?? []].some(([n, text]) => copy.get(n) !== text),
      copy: () => mine && { files: copy, names: mine.names },
      shared: () => known(f.shared()),
      readShared: n => { const text = f.readShared(n); return text === undefined ? undefined : seen.get(text); },
      keep: plan => { f.keep(plan); for (const text of plan.write.values()) seen.set(text, text); } };
  } catch (err) {
    f.log(`could not mask the memory, so nothing goes back or out: ${(err as Error).message}`);
    f.setStart(null);
    f.setCopy(null);
    return null;
  }
}

// A three-way merge by line (git merge-file) where a clash keeps both sides, mine first, instead of conflict markers.
export function union(mine: string, base: string, theirs: string): string {
  const dir = mkdtempSync(`${tmpdir()}/memory-`), nl = (s: string) => s && !s.endsWith('\n') ? `${s}\n` : s;
  try {
    const files = Object.entries({ mine, base, theirs }).map(([k, v]) => { writeFileSync(`${dir}/${k}`, nl(v), { mode: 0o600 }); return `${dir}/${k}`; });
    return execFileSync('git', ['merge-file', '--union', '-p', ...files], { encoding: 'utf8', maxBuffer: 1 << 20 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

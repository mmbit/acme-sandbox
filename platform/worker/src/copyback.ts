// The memory a Claude work job is handed: a copy of the shared memory, its own from then on. Nothing in it goes back:
// a job's working notes may hold what it read at a private source (a care case, a mail, a guest's note), and every
// later job reads the shared memory. The copy stays with its job for its later runs (a pause, a restart, a fix round),
// a copy a cut-off run left behind included. What should last for other jobs goes in the repo, written on purpose
// (knowledge/, a profile: the Knowledge playbook), naming its source rather than copying it.
export type Files = Map<string, string>;
// A memory folder: every plain .md name in it, and the files that were read (the first 500 by name, see worker.ts).
export type Snap = { files: Files; names: Set<string> };

export const plainName = (n: string) => /^[\w.-]+\.md$/.test(n);

// The two folders, read and written by the worker: the shared memory (the keeper's) and the job's copy (in its home).
export type Folders = {
  shared(): Snap | undefined;
  copy(): Snap | undefined;              // undefined: the job has no copy (or it can't be listed)
  setCopy(files: Files | null): void;    // null removes it
  log(note: string): void;
  unmaskedCopy?: boolean;                // the copy on disk holds a value copy() shows masked (masked, below)
};

// At a run's start: the job keeps the copy it has from an earlier run, masked again if a value in it was saved as a key
// since, or gets the shared memory as it is now.
export function handOut(f: Folders) {
  const mine = f.copy();
  if (mine) {
    if (f.unmaskedCopy) f.setCopy(mine.files);
    return;
  }
  const now = f.shared();
  if (!now) return;
  f.setCopy(now.files);
  if (now.names.size > now.files.size) f.log(`${now.names.size - now.files.size} shared files not in the copy (past the first 500, or unreadable)`);
}

// The folders as the job sees them, each file through the coordinator's mask (a key's value becomes its name): the job's
// copy, and the shared memory it's handed. A value written there before it was saved as a key stays in the folder (the
// coordinator scrubs only its own database: db.ts scrub() and scrubSaved()), so it's masked on the way out, every time. The mask waits on
// the coordinator, so each shared text is masked first and then looked up by its raw text when handOut reads it: one
// changed in between is left out, as an unreadable one is. A folder it can't mask loses its copy, so a resumed job keeps
// none unmasked: nothing is handed out. A copy that can't be removed throws, and the job doesn't start.
export async function masked(f: Folders, mask: (text: string) => Promise<string>): Promise<Folders | null> {
  try {
    const mine = f.copy(), seen = new Map<string, string>();   // raw text → masked
    const copy: Files = new Map();
    for (const [n, text] of mine?.files ?? []) copy.set(n, await mask(text));
    if (!mine) for (const text of f.shared()?.files.values() ?? []) if (!seen.has(text)) seen.set(text, await mask(text));
    const shared = () => {
      const snap = f.shared();
      if (!snap) return undefined;
      const files: Files = new Map();
      for (const [n, text] of snap.files) if (seen.has(text)) files.set(n, seen.get(text)!);
      return { files, names: snap.names };
    };
    return { ...f, unmaskedCopy: [...mine?.files ?? []].some(([n, text]) => copy.get(n) !== text),
      copy: () => mine && { files: copy, names: mine.names }, shared };
  } catch (err) {
    f.log(`could not mask the memory, so nothing goes out: ${(err as Error).message}`);
    f.setCopy(null);
    return null;
  }
}

// A Claude work job's memory is its own: empty at its first run, nothing handed out and nothing given back. A job's
// working notes may hold what it read at a private source (a care case, a mail, a guest's note), so none goes to another
// job. The copy stays with its job for its later runs (a pause, a restart, a fix round), a copy a cut-off run left behind
// included. What should last for other jobs goes in the repo, written on purpose (knowledge/, a profile: the Knowledge
// playbook), naming its source rather than copying it.
export type Files = Map<string, string>;

export const plainName = (n: string) => /^[\w.-]+\.md$/.test(n);

// The job's memory folder in its home, read and written by the worker as the job's slot.
export type Folders = {
  copy(): Files | undefined; // undefined: the job has no copy yet, or it can't be listed
  setCopy(files: Files | null): void; // null removes it
  log(note: string): void;
};

// At a run's start: the job keeps the copy it has from an earlier run, each file through the coordinator's mask (a key's
// value becomes its name), so a value written there before it was saved as a key is masked again as the job resumes
// (the coordinator scrubs only its own database: db.ts scrub() and scrubSaved()). An unchanged copy is left alone. One
// it can't mask is removed, so a resumed job keeps none unmasked; one that can't be removed or rewritten throws, and the
// job doesn't start.
export async function remask(f: Folders, mask: (text: string) => Promise<string>) {
  const mine = f.copy();
  if (!mine) {
    f.setCopy(null); // none, or one it can't list, so can't mask
    return;
  }
  const copy: Files = new Map();
  try {
    for (const [n, text] of mine) copy.set(n, await mask(text));
  } catch (err) {
    f.log(`could not mask the memory, so the job's copy goes: ${(err as Error).message}`);
    f.setCopy(null);
    return;
  }
  if ([...mine].some(([n, text]) => copy.get(n) !== text)) f.setCopy(copy);
}

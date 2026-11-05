// Recorded branch, review, explicit fix and held-preview ownership for feature cost attribution, kept between books:
// a change reworks only the jobs whose owners it can move.
import { bookOrder, type CostJob } from './costjobs.ts';
export type Assignment = { thread: string; share: number };

// A job's owners hang on its own fields, on the jobs of its branch (a held one among them shares the branch out), and
// on the owners of the branches it is fixing, reviewing or held for. Each branch's owners are kept with the branches
// their walk read; a job is worked again when a job on its branch changed what owners read (its branch, kind, thread,
// fix, merges, place in the book's order), or when a branch it took owners from read one that did.
export class KeptOwners {
  private jobs = new Map<number, CostJob>();
  private members = new Map<string, Set<number>>();
  private assigned = new Map<number, Assignment[]>();
  // each branch's owners as a job asked them, with the branches their walk read; for each branch, the walks that read
  // it, and the jobs that asked its owners; for each job, the branches it asked
  private owned = new Map<string, { owners: Assignment[]; read: Set<string> }>();
  private readBy = new Map<string, Set<string>>();
  private askedBy = new Map<string, Set<number>>();
  private asked = new Map<number, string[]>();

  of(job: number) {
    return this.assigned.get(job) ?? [];
  }

  // The jobs changed since (`before` and `after`, either missing for one added or gone), taken in; returns the jobs
  // worked again, each with the owners it had.
  update(changes: { before?: CostJob; after?: CostJob }[]) {
    const touched = new Set<string>(),
      again = new Set<number>();
    for (const { before, after } of changes) {
      const id = (before ?? after)!.id;
      if (after) this.jobs.set(id, after);
      else this.jobs.delete(id);
      if (before && after && !movesOwners(before, after)) continue;
      again.add(id);
      if (before) this.members.get(before.branch)?.delete(id);
      if (after) add(this.members, after.branch, id);
      for (const job of [before, after]) if (job) touched.add(job.branch);
    }
    for (const branch of touched) {
      for (const id of this.members.get(branch) ?? []) again.add(id);
      for (const walked of this.readBy.get(branch) ?? []) {
        for (const id of this.askedBy.get(walked) ?? []) again.add(id);
        for (const read of this.owned.get(walked)?.read ?? []) this.readBy.get(read)?.delete(walked);
        this.owned.delete(walked);
      }
    }
    const had = new Map<number, Assignment[] | undefined>();
    for (const id of again) {
      had.set(id, this.assigned.get(id));
      this.assign(id);
    }
    return had;
  }

  private assign(id: number) {
    for (const branch of this.asked.get(id) ?? []) this.askedBy.get(branch)?.delete(id);
    this.assigned.delete(id);
    this.asked.delete(id);
    const job = this.jobs.get(id);
    if (!job) return;
    const [owners, from] = this.ownersOfJob(job);
    this.assigned.set(id, owners);
    this.asked.set(id, from);
    for (const branch of from) add(this.askedBy, branch, id);
  }

  // A job's owners, and the branches whose owners they come from
  private ownersOfJob(job: CostJob): [Assignment[], string[]] {
    const ownersOf = (branch: string) => this.ownersOf(branch);
    if (job.held.length) return [shared(job.held, ownersOf), job.held];
    // A preview's entire branch family retains the held features' shares.
    if (this.holdsOn(job.branch)) return [ownersOf(job.branch), [job.branch]];
    if (job.thread && job.fix_pr === null) return [[{ thread: job.thread, share: 1 }], []];
    const branch = job.pr_branch ?? job.branch;
    return [ownersOf(branch), [branch]];
  }

  private ownersOf(branch: string) {
    let kept = this.owned.get(branch);
    if (!kept) {
      const read = new Set<string>();
      this.owned.set(branch, (kept = { owners: this.walk(branch, new Set(), read), read }));
      for (const r of read) add(this.readBy, r, branch);
    }
    return kept.owners;
  }

  // A branch's owners, from its jobs: held previews share it out, else its direct work, else the branches its fixes fix
  private walk(branch: string, visited: Set<string>, read: Set<string>): Assignment[] {
    if (visited.has(branch)) return [];
    read.add(branch);
    const next = new Set([...visited, branch]);
    const jobs = this.onBranch(branch);
    const previews = [...new Set(jobs.flatMap(job => job.held))];
    if (previews.length) return shared(previews, parent => this.walk(parent, next, read));
    const direct = [
      ...new Set(
        jobs.filter(job => job.kind === 'work' && job.fix_pr === null).flatMap(job => (job.thread ? [job.thread] : [])),
      ),
    ];
    if (direct.length) return direct.map(thread => ({ thread, share: 1 / direct.length }));
    const linked = [...new Set(jobs.flatMap(job => (job.fix_pr === null ? [] : (job.pr_branch ?? []))))];
    return shared(linked, parent => this.walk(parent, next, read));
  }

  private holdsOn(branch: string) {
    for (const id of this.members.get(branch) ?? []) if (this.jobs.get(id)!.held.length) return true;
    return false;
  }

  private onBranch(branch: string) {
    return [...(this.members.get(branch) ?? [])].map(id => this.jobs.get(id)!).sort(bookOrder);
  }
}

// Whether a job's change can move its owners or another job's: what the walk reads, and its place in the book's order,
// which orders the shares a walk sums
const movesOwners = (before: CostJob, after: CostJob) =>
  before.branch !== after.branch ||
  before.kind !== after.kind ||
  before.thread !== after.thread ||
  before.fix_pr !== after.fix_pr ||
  before.pr_branch !== after.pr_branch ||
  before.status !== after.status ||
  before.held.join('\n') !== after.held.join('\n');

function add<K, V>(map: Map<K, Set<V>>, key: K, value: V) {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

function shared(branches: string[], owners: (branch: string) => Assignment[]): Assignment[] {
  const shares = new Map<string, number>();
  for (const branch of branches)
    for (const part of owners(branch))
      shares.set(part.thread, (shares.get(part.thread) ?? 0) + part.share / branches.length);
  return [...shares].map(([thread, share]) => ({ thread, share }));
}

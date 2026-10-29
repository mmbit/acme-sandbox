// Per-job allocated disk shares across the clone, home and tests.
import { AccountingError, type AccountingFailure } from './accounting.ts';
import { join } from 'node:path';
import { DiskScan } from './diskscan.ts';

export type DiskUse = {
  used: number | null;
  share: number;
  warned: boolean;
  grew: boolean;
  accountingError?: AccountingFailure;
};
type Owner = { job: number; uid: number; gid?: number };

export class DiskShares {
  private jobs = new Map<number, { tree: DiskScan; ids: string; warned: boolean; bytes?: number }>();

  private work: string;
  private probeOldSpaceMb?: number;
  // probeOldSpaceMb: each job's scanner's heap. A test's smaller one makes its scanner's bound (disktree.ts
  // treeEntryLimit) a tree the job's own live scanner takes in its stride.
  constructor(work: string, probeOldSpaceMb?: number) {
    this.work = work;
    this.probeOldSpaceMb = probeOldSpaceMb;
  }

  async measure(jobs: Owner[], budget: { freeBytes: number; reserveBytes: number }) {
    const active = new Set(jobs.map(j => j.job));
    for (const [job, state] of this.jobs)
      if (!active.has(job)) {
        state.tree.close();
        this.jobs.delete(job);
      }
    const uses = new Map<number, DiskUse>();
    for (const { job, uid, gid } of jobs) {
      const state = this.jobState(job, uid, gid);
      try {
        const used = await state.tree.measure();
        uses.set(uid, { used, share: 0, warned: state.warned, grew: state.bytes !== undefined && used > state.bytes });
        state.bytes = used;
      } catch (failure) {
        uses.set(uid, {
          used: null,
          share: 0,
          warned: state.warned,
          grew: false,
          accountingError: {
            reason: failure instanceof AccountingError ? failure.reason : 'worker-scanner',
            message: `Disk accounting unavailable for job ${job}: ${failure}`,
          },
        });
      }
    }
    // Only measured allocations are added back to free space, so an unknown tree cannot inflate another job's share.
    const held = [...uses.values()].reduce((sum, use) => sum + (use.used ?? 0), 0);
    const share = Math.max(0, budget.freeBytes + held - budget.reserveBytes) / Math.max(1, jobs.length);
    for (const { job, uid } of jobs) {
      const use = uses.get(uid)!;
      use.share = share;
      if (use.used !== null && use.used <= share) this.jobs.get(job)!.warned = use.warned = false;
    }
    return uses;
  }

  // A job taken up again in another slot has its folders handed to that slot, so its scan starts again as that slot:
  // the last one's can't open them (EACCES). The scan's owner and the cache key
  // come from one value, so the two can't disagree.
  private jobState(job: number, uid: number, gid?: number) {
    const owner = { uid, gid: gid ?? uid };
    const ids = `${owner.uid}:${owner.gid}`;
    let state = this.jobs.get(job);
    if (state?.ids !== ids) {
      state?.tree.close();
      const tree = new DiskScan(
        ['jobs', 'homes', 'tests'].map(folder => join(this.work, folder, String(job))),
        owner,
        this.probeOldSpaceMb,
      );
      state = { tree, ids, warned: false };
      this.jobs.set(job, state);
    }
    return state;
  }

  scanners() {
    return new Set([...this.jobs.values()].flatMap(state => (state.tree.pid ? [state.tree.pid] : [])));
  }

  warned(job: number) {
    this.jobs.get(job)!.warned = true;
  }

  close() {
    for (const state of this.jobs.values()) state.tree.close();
    this.jobs.clear();
  }
}

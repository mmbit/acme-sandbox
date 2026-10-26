// Per-job allocated disk shares across the clone, home and tests.
import { join } from 'node:path';
import { DiskScan } from './diskscan.ts';

export type DiskUse = { used: number | null; share: number; warned: boolean; grew: boolean; accountingError?: string };
type Owner = { job: number; uid: number; gid?: number };

export class DiskShares {
  private jobs = new Map<number, { tree: DiskScan; warned: boolean; bytes?: number }>();

  private work: string;
  constructor(work: string) {
    this.work = work;
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
      let state = this.jobs.get(job);
      if (!state) {
        const tree = new DiskScan(
          ['jobs', 'homes', 'tests'].map(folder => join(this.work, folder, String(job))),
          { uid, gid: gid ?? uid },
        );
        state = { tree, warned: false };
        this.jobs.set(job, state);
      }
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
          accountingError: `Disk accounting unavailable for job ${job}: ${failure}`,
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

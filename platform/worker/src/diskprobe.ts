// The worker's persistent incremental disk scan runs with the owning slot's filesystem permissions.
import { AccountingError } from './accounting.ts';
import { DiskTree } from './disktree.ts';

const ids = JSON.parse(process.argv[2]) as { uid: number; gid: number };
// Keep the worker's real and saved uid so slot commands cannot signal or trace this infrastructure process.
// Effective ids and an empty supplementary group list give filesystem operations only the slot's permissions.
if (process.getuid!() === 0) process.setgroups!([]);
process.setegid!(ids.gid);
process.seteuid!(ids.uid);
const tree = new DiskTree(process.argv.slice(3));
process.on('message', async () => {
  try {
    process.send!({ bytes: await tree.measure() });
  } catch (failure) {
    process.send!({
      error: { reason: failure instanceof AccountingError ? failure.reason : 'job-tree', message: String(failure) },
    });
  }
});
process.on('disconnect', () => {
  tree.close();
  process.exit();
});

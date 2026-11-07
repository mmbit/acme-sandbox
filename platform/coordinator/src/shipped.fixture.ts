// Work merged and deployed, written straight to a coordinator test's database and data folder as GitHub's merge and a
// deploy's record leave them. The harness gives them as h.merged and h.deployed.
import { mkdirSync, writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

export function shippedWork(db: DatabaseSync, dataDir: string) {
  // Job `job`'s work merged as pull request `pr`, after every deploy so far, as main only moves on: an earlier test's
  // deploy, fetched a second ahead, never counts as this merge going live. The time a deploy that has it fetched.
  const merged = (pr: number, job: number, author: string) => {
    const last = (db.prepare('select max(fetched) at from deploys').get() as { at: string | null }).at;
    const at = new Date(Math.max(Date.now(), last ? Date.parse(last) + 1 : 0)).toISOString();
    db.prepare("insert into prs (number, branch, author, status, merged_at) values (?, ?, ?, 'merged', ?)").run(
      pr,
      `job/${job}`,
      author,
      at,
    );
    return new Date(Date.parse(at) + 1000).toISOString();
  };
  // A deploy's record (deploys/<name>.json) that fetched main at `fetched` and went live
  const deployed = (name: string, fetched: string) => {
    mkdirSync(`${dataDir}/deploys`, { recursive: true });
    writeFileSync(
      `${dataDir}/deploys/${name}.json`,
      JSON.stringify({ sha: 'cccc777', fetched, finished: new Date().toISOString(), ok: true, services: [] }),
    );
  };
  return { merged, deployed };
}

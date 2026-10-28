// node --test src/mainline.test.ts   (main's history and HQ played in memory)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAIN_LINE, tellMainLine, type ToldMain } from './mainline.ts';

const sha = (n: number) => n.toString(16).padStart(40, '0');
// Main as commits 1..tip in a line, the mirror having those from `kept` on
const main = (tip: number, kept = 1) => {
  const at = (n: number) => ({ sha: sha(n), parents: n > 1 ? [sha(n - 1)] : [] });
  return {
    mainLine: (count: number) => Array.from({ length: Math.min(count, tip) }, (_, i) => at(tip - i)),
    mainSince: (seen: string) => {
      const n = parseInt(seen, 16);
      return n < kept ? undefined : Array.from({ length: tip - n }, (_, i) => at(n + 1 + i));
    },
  };
};
// HQ having last heard of `seen`: what it was told, and its answer as carries.ts gives it
const hq = (seen: number, fail?: number) => {
  const told: ToldMain[] = [];
  let heard = sha(seen);
  const tell = async (t: ToldMain) => {
    if (told.length === fail) throw new Error('timed out');
    told.push(t);
    const reaches = t.lost === heard || t.after === heard || t.commits.some(c => c.sha === heard);
    if (!reaches) return { seen: heard };
    heard = t.commits[0].sha;
    return {};
  };
  return { told, tell, heard: () => heard };
};

test('a line that reaches what HQ heard of is one request, and a tip told already none', async () => {
  const to = hq(250);
  assert.equal(await tellMainLine(main(300), to.tell), sha(300));
  assert.equal(to.told.length, 1);
  assert.equal(await tellMainLine(main(300), to.tell, sha(300)), sha(300));
  assert.equal(to.told.length, 1);
});

test('past the line, what main took since goes in pages, oldest first, each after the one before', async () => {
  const to = hq(50);
  await tellMainLine(main(300), to.tell);
  const pages = to.told.slice(1);
  assert.deepEqual(
    pages.map(p => [p.after, p.commits.at(-1)!.sha, p.commits[0].sha]),
    [
      [sha(50), sha(51), sha(150)],
      [sha(150), sha(151), sha(250)],
      [sha(250), sha(251), sha(300)],
    ],
  );
  assert.ok(pages.every(p => p.commits.length <= MAIN_LINE));
  assert.equal(to.heard(), sha(300));
});

test('a page HQ never heard leaves the rest to the next telling, from where HQ got to', async () => {
  const to = hq(50, 2);
  await assert.rejects(tellMainLine(main(300), to.tell));
  assert.equal(to.heard(), sha(150));
  const again = hq(150);
  await tellMainLine(main(300), again.tell);
  assert.deepEqual(
    again.told.slice(1).map(p => p.after),
    [sha(150), sha(250)],
  );
});

test('a commit HQ heard of that the mirror has not sends the line as lost history', async () => {
  const to = hq(50);
  await tellMainLine(main(300, 100), to.tell);
  assert.equal(to.told.length, 2);
  assert.equal(to.told[1].lost, sha(50));
  assert.equal(to.heard(), sha(300));
});

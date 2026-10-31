// node --test src/ink/bookpick.test.ts   (the board rings a version to pick it: the ring goes as a reply on that
// version, drawn over its frame in the picture the judge reads; the judge's 'pick' picks it and unpicks the rest of its
// set; the try run hears which; the note the tried group goes as carries the frame and the patch. Each version its own
// branch; a cross rules one out, every one crossed clears them all and the owner asks what's missing; the page gone with
// a pick clears the others.)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness } from '../harness.ts';

const { commitFile } = await import('../fixture.ts');
// (the test company's checkout a git repository, as the server's is: a version's branch is made over its HEAD)
const h = await harness('bookpick', {
  before: repo => commitFile('products/README.md', 'Products\n', 'Products', { repo }),
});
const { agent, db } = h;
const judge = await import('./bookjudge.ts');
const { withPicks, pickedOn } = await import('./bookpick.ts');
const { deliverDue } = await import('./booksheets.ts');
afterEach(() => h.cancelQueued());

const png = async (background: string) =>
  `data:image/png;base64,${(
    await sharp({ create: { width: 160, height: 120, channels: 3, background } })
      .png()
      .toBuffer()
  ).toString('base64')}`;
const stroke = (points: number[][]) => ({
  color: '#2B2230',
  size: 4,
  points: points.map(([x, y], i) => [x, y, 0.5, i * 16]),
});
// A ring round a box, as a pen draws one: a loop a little outside it
const ring = (b: { x: number; y: number; w: number; h: number }) =>
  stroke(
    Array.from({ length: 25 }, (_, i) => {
      const a = (i / 24) * 2 * Math.PI;
      return [b.x + b.w / 2 + Math.cos(a) * (b.w / 2 + 14), b.y + b.h / 2 + Math.sin(a) * (b.h / 2 + 14)];
    }),
  );
const myNotebook = async () => (await h.board('/api/notebooks')).body.shelf[0].id as number;
// (the last open page, or a new one: no page is made after one sent.)
async function currentPage() {
  const notebook = await myNotebook(),
    open = (await h.board(`/api/notebooks/pages?notebook=${notebook}`)).body.pages.filter(
      (p: any) => !p.sent && !p.sending,
    );
  return (open.at(-1)?.id ?? (await h.board('/api/notebooks/pages/create', { notebook })).body.id) as number;
}
const childrenOf = async (page: number, id: number) =>
  ((await h.board(`/api/notebooks/pages/groups?page=${page}`)).body.groups as any[]).find(g => g.id === id).children;

// The judge's next call (null: none came), answered with a verdict
async function judged(tries = 60) {
  for (let i = 0; i < tries; i++) {
    const c = (await h.worker('reads/claim')).body;
    if (c.reading) return c;
    await new Promise(res => setTimeout(res, 20));
  }
  return null;
}
const say = (c: { reading: string }, reply: string, why: string) =>
  h.worker('reads/answer', { reading: c.reading, result: { is_error: false, structured_output: { reply, why } } });
async function until(ok: () => boolean) {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise(res => setTimeout(res, 10));
  assert.ok(ok());
}
const pickedIds = (ids: number[]) =>
  ids.filter(id => (db.prepare('select picked from book_slips where id = ?').get(id) as any).picked);
const slip = (id: number) => db.prepare('select * from book_slips where id = ?').get(id) as any;
// A version's change, as a try run's git diff has it: a new file in the repository
const patchOf = (name: string, colour: string) => {
  const path = `products/try/${name.toLowerCase().replace(/ /g, '-')}.txt`;
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${colour}\n`;
};

// The board's note tried in two versions by a running try run
async function tried() {
  const page = await currentPage();
  const g = (
    await h.board('/api/notebooks/groups/create', {
      page,
      ink: [
        stroke([
          [40, 40],
          [200, 60],
        ]),
      ],
      texts: [{ x: 40, y: 80, w: 200, text: 'warmer?', color: '#2a2352' }],
    })
  ).body;
  await say((await judged())!, 'try', 'wonders about a colour');
  // (the judge's try queued the real run, kept on the group: claimed alone)
  const tried = () => (db.prepare('select tried from notebook_groups where id = ?').get(g.id) as any).tried;
  await until(() => !!tried());
  const run = await h.claimJob(tried());
  const clip = async (name: string, colour: string, patch = patchOf(name, colour)) =>
    agent('answer', run.token, {
      grp: g.id,
      version: name,
      text: `${name}, as it would look`,
      picture: await png(colour),
      patch,
    });
  const v1 = (await clip('Warm sand', '#e8c88a')).body.slip;
  const v2 = (await clip('Brick red', '#b0412f')).body.slip;
  // (each its own branch, made from main and its patch: trybranch.ts)
  await until(() => !!slip(v1.id).branch && !!slip(v2.id).branch);
  return { page, g, run, v1, v2, clip };
}

test('a ring round a version goes as a reply over its frame; the judge’s pick picks it, the run hears which', async () => {
  const { page, g, run, v1, v2 } = await tried();
  const frame = { x: 360, y: 72, w: 300, h: 225 };
  const refused = await h.board('/api/notebooks/groups/reply', {
    answer: v2.id,
    ink: [ring(frame)],
    frame: { ...frame, w: 0 },
  });
  assert.equal(refused.status, 400);
  assert.ok(!(await childrenOf(page, g.id)).some((x: any) => x.kind === 'reply'));
  const sent = await h.board('/api/notebooks/groups/reply', { answer: v2.id, ink: [ring(frame)], frame });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const c = (await judged())!;
  const [image, text] = c.content;
  assert.equal(image.type, 'image', 'the judge sees the frame with the ring over it');
  const seen = await sharp(Buffer.from(image.source.data, 'base64')).metadata();
  assert.ok(seen.width! > seen.height!, 'the frame’s shape, not the ring’s alone');
  assert.match(text.text, /version 2 of 2, “Brick red”/);
  assert.match(text.text, /pick: only for a note on one of an agent's versions/);
  assert.deepEqual(JSON.parse(c.schema), judge.schemaOf(true), 'pick offered on a version');
  await say(c, 'pick', 'rings one version to choose it');
  await until(() => pickedIds([v1.id, v2.id]).length === 1);
  assert.deepEqual(pickedIds([v1.id, v2.id]), [v2.id]);
  const shown = (await childrenOf(page, g.id)).filter((x: any) => x.style === 'version');
  assert.deepEqual(
    shown.map((x: any) => !!x.picked),
    [false, true],
    'the page shows it',
  );
  // (its frame read back, so HQ lays the ring over the version wherever it wraps)
  const reply = (await childrenOf(page, g.id)).find((x: any) => x.kind === 'reply' && x.answers === v2.id);
  assert.deepEqual(reply.frame, frame, 'the reply keeps the frame it was drawn over');
  const heard = db.prepare('select text from messages where job = ?').all(run.id) as { text: string }[];
  assert.match(heard.at(-1)!.text, /The board picked your version “Brick red”/);
  // a tick on the other moves the pick: one per try
  await h.board('/api/notebooks/groups/reply', {
    answer: v1.id,
    ink: [
      stroke([
        [380, 300],
        [390, 312],
        [420, 280],
      ]),
    ],
    frame,
  });
  await say((await judged())!, 'pick', 'ticks the version it likes');
  await until(() => pickedIds([v1.id, v2.id])[0] === v1.id);
  assert.deepEqual(pickedIds([v1.id, v2.id]), [v1.id]);
  // a cross rules the other out, and the pick stays
  await h.board('/api/notebooks/groups/reply', {
    answer: v2.id,
    ink: [
      stroke([
        [360, 72],
        [660, 297],
      ]),
    ],
    frame,
  });
  await say((await judged())!, 'cross', 'rules that one out');
  await until(() => !!slip(v2.id).crossed);
  assert.deepEqual(pickedIds([v1.id, v2.id]), [v1.id]);
  assert.equal(slip(v2.id).cleared, null, 'one crossed out of two: nothing cleared yet');
  await h.finish(run);
});

test('each version is a branch of its own: main with its patch, one commit; a patch that can’t be one is refused', async () => {
  const { run, v1, v2, clip } = await tried();
  assert.deepEqual([slip(v1.id).branch, slip(v2.id).branch], [`try/v${v1.id}`, `try/v${v2.id}`]);
  assert.deepEqual(h.github.branches.get(`try/v${v2.id}`), [{ path: 'products/try/brick-red.txt', text: '#b0412f\n' }]);
  const shown = (await childrenOf(await currentPage(), v2.grp)).find((x: any) => x.id === v2.id);
  assert.equal(shown.branch, `try/v${v2.id}`);
  // a patch that doesn't apply to main, or would make a symlink (to a file outside the checkout), is no version
  const nowhere = 'diff --git a/nowhere.txt b/nowhere.txt\n--- a/nowhere.txt\n+++ b/nowhere.txt\n@@ -1 +1 @@\n-a\n+b\n';
  const odd = await clip('Nowhere', '#000000', nowhere);
  assert.equal(odd.status, 400);
  assert.match(odd.body.error, /doesn't apply to main/);
  const canary = join(mkdtempSync(join(tmpdir(), 'canary-')), 'secret.txt');
  writeFileSync(canary, 'canary-7f3a\n');
  const link = 'products/try/leak.txt';
  const leak = await clip(
    'Leak',
    '#000000',
    `diff --git a/${link} b/${link}\nnew file mode 120000\n--- /dev/null\n+++ b/${link}\n@@ -0,0 +1 @@\n+${canary}\n\\ No newline at end of file\n`,
  );
  assert.equal(leak.status, 400);
  assert.match(leak.body.error, /symlink/);
  const kept = [...h.github.branches.values()].flat();
  assert.ok(!kept.some(f => f.text?.includes('canary-7f3a')), 'the canary reaches no branch');
  await h.finish(run);
});

test('a branch GitHub refuses twice: the version shows why', async () => {
  const { page, g, run, clip } = await tried();
  const played = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) =>
    String(url).includes('/git/')
      ? new Response('{"message":"Server Error"}', { status: 502 })
      : played(url, init)) as typeof fetch;
  try {
    const v = (await clip('Moss', '#5a6b3a')).body.slip;
    await until(() => !!slip(v.id).branch_failed);
    const shown = (await childrenOf(page, g.id)).find((x: any) => x.id === v.id);
    assert.deepEqual([shown.branch, shown.link], [null, null]);
    assert.match(shown.branch_failed, /502/);
  } finally {
    globalThis.fetch = played;
  }
  await h.finish(run);
});

test('every version crossed out: all cleared, their branches gone, and the owner asks what’s missing', async () => {
  const { page, g, run, v1, v2 } = await tried();
  for (const v of [v1, v2]) {
    await h.board('/api/notebooks/groups/reply', {
      answer: v.id,
      ink: [
        stroke([
          [0, 0],
          [200, 150],
        ]),
      ],
    });
    await say((await judged())!, 'cross', 'rules that one out');
    await until(() => !!slip(v.id).crossed);
  }
  await until(() => !!slip(v1.id).cleared && !!slip(v2.id).cleared && !slip(v2.id).branch);
  assert.equal(h.github.branches.has(`try/v${v1.id}`), false);
  assert.equal(h.github.branches.has(`try/v${v2.id}`), false);
  const heard = db.prepare('select text from messages where job = ?').all(run.id) as { text: string }[];
  assert.match(heard.at(-1)!.text, /crossed out every version you made/);
  // (the owner's quick run, asking what's missing with choices to circle)
  await until(() => !!(db.prepare('select asked from notebook_groups where id = ?').get(g.id) as any).asked);
  const asked = (db.prepare('select asked from notebook_groups where id = ?').get(g.id) as any).asked;
  assert.match(
    (db.prepare('select prompt from jobs where id = ?').get(asked) as any).prompt,
    /crossed out every version/,
  );
  const shown = (await childrenOf(page, g.id)).filter((x: any) => x.style === 'version');
  assert.ok(
    shown.every((x: any) => x.crossed && x.cleared),
    'the page shows them crossed and cleared',
  );
  await h.finish(run);
});

test('the pick goes with the page: the note’s picture has the frame beside it, its job the version and its patch', async () => {
  const { page, g, run, v1, v2 } = await tried();
  await h.board('/api/notebooks/groups/reply', { answer: v2.id, ink: [ring({ x: 0, y: 0, w: 200, h: 150 })] });
  await say((await judged())!, 'pick', 'rings one version');
  await until(() => pickedOn(g.id)?.id === v2.id);
  const sent = await h.board('/api/notebooks/pages/send', { id: page });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const n = db
    .prepare('select n.* from book_notes n join notebook_groups g on g.note = n.id where g.id = ?')
    .get(g.id) as any;
  const { readFileSync } = await import('node:fs');
  const { DIR } = await import('../pagescraps.ts');
  const snip = await sharp(readFileSync(`${DIR}/${n.snip}`)).metadata();
  assert.ok(snip.width! > 2 * snip.height!, 'the group, and the frame beside it');
  const [text] = withPicks([n], ['The board’s note: warmer?']);
  assert.match(text, /The board picked the version “Brick red” \(Brick red, as it would look\): build that one/);
  assert.match(text, new RegExp(`Start from its branch: \`git fetch origin try/v${v2.id} && git merge FETCH_HEAD\``));
  assert.match(text, /```diff\ndiff --git a\/products\/try\/brick-red.txt b\/products\/try\/brick-red.txt\n/);
  assert.equal(withPicks([{ ...n, id: -1 }], ['x'])[0], 'x', 'a note with no pick is as it was');
  // (its kept patch gone: the job isn't told to build it without it.)
  const { renameSync } = await import('node:fs');
  const patch = `${DIR}/${pickedOn(g.id)!.patch}`;
  renameSync(patch, `${patch}.away`);
  assert.throws(() => withPicks([n], ['x']), /ENOENT/);
  renameSync(`${patch}.away`, patch);
  // the page gone, the version not picked is cleared: its branch removed; the picked one's stays for its build
  assert.equal(slip(v1.id).cleared, null, 'not before the page goes');
  deliverDue(Date.now() + 60_000);
  await until(() => !!slip(v1.id).cleared && !slip(v1.id).branch);
  assert.equal(h.github.branches.has(`try/v${v1.id}`), false);
  assert.deepEqual([slip(v2.id).cleared, slip(v2.id).branch], [null, `try/v${v2.id}`]);
  await h.finish(run);
});

test('a pick on what isn’t a version picks nothing', async () => {
  const { pickNow } = await import('./bookpick.ts');
  const { g, run, v1 } = await tried();
  assert.equal(pickNow({ grp: g.id }), null, 'the note itself');
  assert.equal(pickNow({ grp: 999_999 }), null, 'nothing');
  assert.deepEqual(pickedIds([v1.id]), []);
  await h.finish(run);
});

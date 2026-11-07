// node --test src/whole.test.ts   (a pause's --until and a job's --when on a whole milestone or deliverable live; the
// real hq, a throwaway DATA_DIR)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { harness } from './harness.ts';

const h = await harness('whole');
const { db } = h;
const projects = await import('./projects.ts');
const threadends = await import('./threadends.ts');
const pauses = await import('./pauses.ts');
const pausewake = await import('./pausewake.ts');
const wakes = await import('./wakes.ts');

const dir = mkdtempSync(`${tmpdir()}/whole-files-`);
const running = async (agent: string, thread?: string) => ({
  ...(await h.start({ agent, ...(thread && { thread }) })),
  dir: mkdtempSync(`${dir}/job-`),
});
const brief = () => {
  const f = `${dir}/${Math.random().toString(36).slice(2)}.md`;
  writeFileSync(f, 'Read it live.');
  return f;
};
const milestone = async (id: string, name: string, code: string) => {
  const juno = await running('juno');
  const made = await h.hq(juno, 'project', 'new', id, name, '--code', code, '--owner', 'juno');
  assert.equal(made.code, 0, made.out);
  return juno;
};
const draw = (project: string, slug: string, name = slug) => {
  assert.notEqual(typeof projects.createThread({ project, slug, name, goal: 'It ships' }), 'string');
  return `${project}/${slug}`;
};
const close = (thread: string) => threadends.close(projects.findThread(thread)!);
// A task in `thread` done, its pull request merged and deployed
async function shipped(thread: string, pr: number) {
  const job = await h.start({ agent: 'kit', thread });
  await h.finish(job, { status: 'done', branch: `job/${job.id}`, sha: 'd'.repeat(40) });
  h.deployed(String(pr), h.merged(pr, job.id, 'kit'));
  return job.id;
}
const wokenOn = (target: string) =>
  (
    db.prepare('select woken from pauses where coalesce(thread, project) = ? and resumed is null').get(target) as {
      woken: number | null;
    }
  ).woken;

test("--until <project> wakes the pause's owner once the whole milestone is live, work filed in it later too", async () => {
  const juno = await milestone('shelf', 'The shelf', 'SHF');
  await milestone('yard', 'The yard', 'YRD');
  const [books, tips] = [draw('shelf', 'books', 'Books'), draw('shelf', 'tips', 'Tips')];
  draw('yard', 'gate');
  const held = h.queue({ agent: 'kit', thread: 'yard/gate' });

  const refused = async (target: string[], until: string, why: RegExp) => {
    const r = await h.hq(juno, ...target, 'Waits for the shelf', '--until', until);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, why);
  };
  await refused(['project', 'pause', 'yard'], 'nowhere', /there's no milestone \(project\) or deliverable nowhere/);
  await refused(['project', 'pause', 'shelf'], 'shelf', /the pause would hold The shelf's whole milestone/);
  await refused(['project', 'pause', 'shelf'], books, /the pause would hold the deliverable "Books"/);
  await refused(['deliverable', 'pause', tips], tips, /the pause would hold the deliverable "Tips"/);

  const yard = await h.hq(juno, 'project', 'pause', 'yard', 'Waits for the shelf', '--until', 'shelf');
  assert.equal(yard.code, 0, yard.out);
  assert.match(yard.out, /Once The shelf's whole milestone \(2 open deliverables and any filed in it later\) is live,/);
  const own = await h.hq(juno, 'deliverable', 'pause', tips, 'Waits for the rest of the shelf', '--until', 'shelf');
  assert.equal(own.code, 0, own.out);
  assert.match(own.out, /not "Tips", kept out by its own pause\) is live/, "a deliverable's pause leaves it out");
  const book = h.queue({ agent: 'kit', thread: books });
  assert.ok(pauses.untilJobs().includes(book), "the plan seeds the milestone's open work");
  assert.ok(
    h.jobs.prerequisites([held], { includeFrom: false }).some(n => n.id === book),
    'and plays the held work after it',
  );
  db.prepare("update jobs set status = 'cancelled' where id = ?").run(book);

  await shipped(books, 801);
  close(books);
  const fitted = draw('shelf', 'fitted'); // filed after the pauses
  pausewake.sweep();
  assert.equal(wokenOn('yard'), null, 'the books are live, but the shelf has work filed since');
  close(fitted);
  pausewake.sweep();
  const woke = db.prepare('select agent, prompt from jobs where id = ?').get(wokenOn('yard')!) as {
    agent: string;
    prompt: string;
  };
  assert.equal(woke.agent, 'juno');
  assert.match(woke.prompt, /What it waited for is met: The shelf's whole milestone is live[.]/);
  assert.ok(wokenOn(tips), "the tips' own pause, which kept it out, wakes its owner too");
  assert.equal(await h.claim(h.job(held).engine), null, 'and the pause still holds its work');
});

test('--until <project> waits on its open deliverables with no tasks yet, and is refused when one needs the paused work', async () => {
  const juno = await milestone('loft', 'The loft', 'LFT');
  await milestone('mill', 'The mill', 'MIL');
  const stairs = draw('loft', 'stairs', 'Stairs');
  const wheel = draw('mill', 'wheel');
  const turning = h.queue({ agent: 'kit', thread: wheel });
  const pause = () => h.hq(juno, 'project', 'pause', 'mill', 'Waits for the loft', '--until', 'loft');

  const paused = await pause();
  assert.equal(paused.code, 0, paused.out);
  assert.ok(
    h.jobs.needsGraph().get(`job/${turning}`)?.includes(`thread/${stairs}`),
    'the held work waits on the deliverable itself, not only on its tasks',
  );
  assert.deepEqual(pauses.resume({ project: 'mill' }, 'juno'), { ok: true, target: 'mill' });

  const needs = await h.hq(juno, 'plan', 'need', stairs, wheel);
  assert.equal(needs.code, 0, needs.out);
  const refused = await pause();
  assert.notEqual(refused.code, 0, refused.out);
  assert.match(
    refused.out,
    new RegExp(`The loft's whole milestone needs #${turning} first, on ${wheel}, which the pause would hold`),
  );
});

test('--until <project> is refused when it needs a deliverable the pause holds with no tasks yet', async () => {
  const juno = await milestone('attic', 'The attic', 'ATC');
  await milestone('barn', 'The barn', 'BRN');
  const [beams, hay] = [draw('attic', 'beams'), draw('barn', 'hay')];
  const needs = await h.hq(juno, 'plan', 'need', beams, hay);
  assert.equal(needs.code, 0, needs.out);
  const refused = await h.hq(juno, 'project', 'pause', 'barn', 'Waits for the attic', '--until', 'attic');
  assert.notEqual(refused.code, 0, refused.out);
  assert.match(refused.out, new RegExp(`The attic's whole milestone needs ${hay} first, which the pause would hold`));
});

test('--when deployed:<project> starts a job once the whole milestone is live, its own deliverable left out', async () => {
  await milestone('dock', 'The dock', 'DCK');
  const [crane, rail] = [draw('dock', 'crane', 'Crane'), draw('dock', 'rail', 'Rail')];
  const juno = await running('juno', crane);
  const nowhere = await h.hq(juno, 'job', '--when', 'deployed:nowhere', 'kit', 'Read it live', brief(), '--new');
  assert.notEqual(nowhere.code, 0, 'a milestone HQ has');
  const queued = await h.hq(
    juno,
    'job',
    '--when',
    'deployed:dock',
    '--when',
    '2h',
    'kit',
    'Read it live',
    brief(),
    '--new',
  );
  assert.equal(queued.code, 0, queued.out);
  const id = Number(/Queued job #(\d+)/.exec(queued.out)?.[1]);
  const own = h.jobs.threadOf(id)!;
  assert.ok(
    own.startsWith('dock/') && own !== crane,
    `a deliverable of its own after the release, not ${crane}: ${own}`,
  );
  assert.match(
    (await h.hq(juno, 'jobs', 'kit')).out,
    /queued once The dock's whole milestone \(2 open deliverables and any filed in it later, not this job's own\) is live/,
  );
  const ready = (at = Date.now()) => {
    wakes.check(at);
    return !!h.job(id)?.ready;
  };
  const later = Date.now() + 3 * 3600_000;
  assert.equal(ready(), false, 'the dock has open deliverables');

  await h.finish(juno, { status: 'done', branch: `job/${juno.id}`, sha: 'e'.repeat(40) });
  await shipped(crane, 802);
  close(crane);
  close(rail);
  assert.equal(ready(), false, 'live, but its time is still to come');
  const tide = draw('dock', 'tide'); // filed while the time ran
  assert.equal(ready(later), false, 'live only for now: work filed since opens it again');
  close(tide);
  assert.equal(ready(later), true);
  const note = (db.prepare('select note from jobs where id = ?').get(id) as { note: string }).note;
  assert.match(note, /The dock's whole milestone is live/);
});

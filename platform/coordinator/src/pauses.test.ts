// node --test src/pauses.test.ts   (a paused project or thread, held by the claim; throwaway DATA_DIR and REPO_DIR)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { followthroughFixture } from './followthrough.fixture.ts';
import { projectsHarness } from './projects.fixture.ts';
import type { Pause } from './pauses.ts';

const { h, thread, engineOf } = await projectsHarness('pauses');
const { db } = h;
const pauses = await import('./pauses.ts');
const pausewake = await import('./pausewake.ts');
const { read } = await import('./followthrough.ts');
const { agreements } = await import('./agreements.ts');
const { snapshot } = await import('./backlog.ts');
const { ceo } = await import('./company.ts');
const { moveJob } = await import('./regroup.ts');
const decisions = await import('./decisions.ts');
const { agreed } = await followthroughFixture(h);

const reset = () =>
  db.exec(`delete from jobs; delete from prs; delete from threads; delete from pauses; delete from pause_until; delete from pause_wakes; delete from decisions;
    delete from calls; delete from call_items; delete from followthrough_checks; delete from settings where key = 'company.paused'`);
// (with no condition named, by hand: nothing wakes its owner)
const pause = (ask: Parameters<typeof pauses.pause>[0], agent = ceo()) => {
  const p = pauses.pause({ byHand: !ask.until?.length && ask.untilTime == null, ...ask }, agent);
  assert.equal(typeof p, 'object', typeof p === 'string' ? p : '');
  return p as Pause;
};
const merge = async (job: { id: number; seat: string }, pr: number) => {
  await h.finish(job as never, { status: 'done', pr, branch: `job/${job.id}` });
  db.prepare("update prs set status = 'merged' where number = ?").run(pr);
};

test('queued work on a paused thread, or any thread of a paused project, starts only once it is resumed', async () => {
  reset();
  const [levels, sound, till] = [thread('levels'), thread('sound'), thread('till', 'shop')];
  const held = h.queue({ agent: 'kit', thread: levels });
  const other = h.queue({ agent: 'kit', thread: till });
  pause({ thread: levels, why: 'No level work until the projects view is back' }, 'wren');
  assert.equal(await h.claim(engineOf(held)), null, 'the paused thread holds it');
  assert.equal(h.job(held).ready, 0);
  assert.deepEqual(h.job(held).wakes, [`paused with ${levels}`], 'the projects view says what holds it');
  const line = h.jobs.openJobs({}).find(j => j.id === held)!.line;
  assert.match(line, new RegExp(`queued paused with ${levels}:`), 'and so does hq jobs');
  assert.equal((await h.claim(engineOf(other)))?.id, other, "another project's work runs");

  const loose = h.queue({ agent: 'kit', thread: sound });
  pause({ project: 'game', why: 'The board: no game work tonight' });
  assert.equal(await h.claim(engineOf(loose)), null, "the project's pause holds every thread of it");
  assert.equal(pauses.resume({ thread: levels }, 'kit'), "only wren (The game's owner) or the CEO resumes game/levels");
  assert.equal(typeof pauses.resume({ thread: levels }, 'wren'), 'object', 'its owner resumes it');
  assert.equal(await h.claim(engineOf(held)), null, 'the project is still paused');
  assert.equal(pauses.resume({ project: 'game' }, 'wren'), 'only the CEO resumes game: the CEO paused it');
  assert.equal(typeof pauses.resume({ project: 'game' }, ceo()), 'object');
  assert.equal((await h.claim(engineOf(held)))?.id, held, 'resumed, it starts');
  assert.equal((await h.claim(engineOf(loose)))?.id, loose);
});

test("a pause holds a pull request's reviews, rulings and fix rounds too", async () => {
  reset();
  const levels = thread('levels');
  const fix = h.queue({ agent: 'kit', thread: levels, stage: 'fix', pr: 9 });
  const review = h.queue({ agent: 'rook', thread: levels, kind: 'review', pr: 9 });
  const ruling = h.queue({ agent: 'quill', thread: levels, kind: 'consolidate', pr: 9 });
  pause({ thread: levels, why: 'Review fixes included' });
  for (const id of [fix, review, ruling]) assert.equal(await h.claim(engineOf(id)), null, `#${id} is held`);
  assert.deepEqual(h.job(review).wakes, [`paused with ${levels}`]);
  pauses.resume({ thread: levels }, ceo());
  assert.equal((await h.claim(engineOf(review)))?.id, review);
});

test('hq stop pauses a running review or ruling on a paused thread, and it goes on in its session once the pause lifts', async () => {
  reset();
  const levels = thread('levels');
  const review = await h.start({ agent: 'rook', thread: levels, kind: 'review', pr: 9 });
  const ruling = await h.start({ agent: 'quill', thread: levels, kind: 'consolidate', pr: 9 });
  const ceoJob = await h.start({ agent: ceo() });
  assert.notEqual((await h.hq(ceoJob, 'stop', String(review.id), 'Held with the thread')).code, 0, 'not unpaused');
  pause({ thread: levels, why: 'Review fixes included' });
  for (const job of [review, ruling]) {
    const stopped = await h.hq(ceoJob, 'stop', String(job.id), 'Held with the thread');
    assert.equal(stopped.code, 0, stopped.out);
    assert.match(stopped.out, new RegExp(`goes on in its session once ${levels} resumes`));
    assert.equal((await h.heartbeat(job)).body.yield, 'paused', 'the worker yields it at its next step');
    await h.finish(job, { status: 'yielded', session: `session-${job.id}` });
    assert.equal(h.job(job.id).status, 'queued', 'what it wrote so far is no verdict');
    assert.equal(await h.claim(engineOf(job.id)), null, 'the pause holds it');
  }
  pauses.resume({ thread: levels }, ceo());
  const again = await h.claim(engineOf(review.id));
  assert.equal(again?.id, review.id);
  assert.equal(again?.session, `session-${review.id}`, 'it goes on in its session');
  assert.equal((await h.heartbeat(again!)).body.yield, undefined, 'to its end');
});

test("--until wakes the pause's owner once its jobs have all merged or ended, and the pause stays on until resumed", async () => {
  reset();
  const [levels, view] = [thread('levels'), thread('view', 'shop')];
  const held = h.queue({ agent: 'kit', thread: levels });
  const first = await h.start({ agent: 'moss', thread: view });
  // (a thread of its own: one thread's tasks run one at a time)
  const second = await h.start({ agent: 'moss', thread: thread('desk', 'shop') });
  const p = pause(
    { thread: levels, why: 'Until the view and the desktop are done', until: [first.id, second.id] },
    'wren',
  );
  assert.deepEqual(
    p.until.map(u => u.state),
    ['running', 'running'],
  );
  await merge(first, 71);
  await h.finish(second, { status: 'done', pr: 72, branch: `job/${second.id}` });
  h.jobs.handedCustomerData(second.id);
  assert.equal(pauses.open()[0].until[1].state, 'in review (PR #72)');
  pausewake.sweep();
  assert.equal(pauses.open()[0].woken, null, 'one still in review: nothing wakes yet');
  db.prepare("update prs set status = 'closed' where number = 72").run();
  db.prepare("insert into settings (key, value) values ('company.paused', ?)").run(JSON.stringify({ by: 'board' }));
  // (the hourly check's own orders stay the CEO's: the woken owner reads only what counts as delivered)
  const orgFile = `${h.repo}/company/org.yaml`,
    orgChart = readFileSync(orgFile, 'utf8');
  writeFileSync(orgFile, `${orgChart}\nfollowThrough:\n  prompt: |\n    Cancel what isn't worth its cost.\n`);
  try {
    pausewake.sweep();
  } finally {
    writeFileSync(orgFile, orgChart);
  }
  const [still] = pauses.open();
  assert.ok(still.woken, 'both ended, one merged and one closed unmerged: its owner is woken');
  assert.deepEqual(
    still.until.map(u => u.state),
    ['merged', 'done without merged work'],
  );
  assert.equal(await h.claim(engineOf(held)), null, 'and the pause still holds its work');
  const woke = db.prepare('select id, agent, prompt from jobs where id = ?').get(still.woken!) as {
    id: number;
    agent: string;
    prompt: string;
  };
  assert.equal(woke.agent, 'wren', 'the owner who paused it');
  assert.match(
    woke.prompt,
    /The pause on game\/levels \(paused by wren, .*\): Until the view and the desktop are done/,
  );
  assert.match(woke.prompt, new RegExp(`#${first.id} moss: .*It ended merged[.]`));
  assert.match(
    woke.prompt,
    new RegExp(`#${second.id} moss: .*It ended done without merged work[.]\\n {2}Its report: \\(it holds a customer's`),
    "a report with a customer's details stays with its job",
  );
  assert.match(woke.prompt, /nothing lifts it but a resume/);
  assert.match(woke.prompt, /Delivered means what the board asked for is in its hands: the thing itself/);
  assert.doesNotMatch(woke.prompt, /Cancel what isn't worth its cost/, "never the hourly check's orders");
  assert.match(woke.prompt, /hq thread resume game\/levels/);
  assert.match(woke.prompt, /hq thread pause game\/levels "why" --until <that job>/);
  assert.match(
    woke.prompt,
    new RegExp(
      `Only the board can judge it: ask the CEO \\(${ceo()}, \`hq say\`\\), .* to make the pause wait for its answer, which lifts it: \`hq decision "<what the board decides>" --blocks game/levels\`.*\`hq ask ... --decides <its id>\``,
    ),
    'the third way waits for the board, through the CEO',
  );
  assert.equal(h.jobs.pausedOn(woke.id), null, 'no pause holds the job that judges it');
  assert.equal((await h.claim(engineOf(woke.id)))?.id, woke.id, "nor the company's pause");
  db.prepare("delete from settings where key = 'company.paused'").run();
  pausewake.sweep();
  assert.equal(
    db.prepare('select count(*) n from jobs where agent = ? and id > ?').get('wren', woke.id)!.n,
    0,
    'woken once',
  );

  const next = h.queue({ agent: 'moss', thread: view });
  const kept = pause({ thread: levels, why: 'The desktop again, with results', until: [next] }, 'wren');
  assert.equal(kept.id, still.id, 'the owner keeps it on for what is missing: the same pause, on new conditions');
  assert.equal(kept.woken, null);
  assert.equal(typeof pauses.resume({ thread: levels }, 'wren'), 'object', 'only a resume lifts it');
  assert.equal((await h.claim(engineOf(held)))?.id, held);
});

test("--until-time wakes the owner once its time has come; a pause carrying the board's item wakes the CEO", async () => {
  reset();
  thread('levels');
  const t = Date.now();
  const followup = await h.start({ agent: ceo() });
  const { item } = agreed({ kind: 'task', status: 'handled' }, t, ceo(), { job: followup.id });
  pause({ project: 'game', why: 'Until the board has seen the trial', untilTime: '2h' }, 'wren');
  const linked = await h.agent('item-link', followup.token, { id: item, to: { pause: 'game' } });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  pausewake.sweep(t + 60 * 60_000);
  assert.equal(pauses.open()[0].woken, null, 'not yet');
  pausewake.sweep(t + 2 * 60 * 60_000 + 60_000);
  const [p] = pauses.open();
  const woke = db.prepare('select agent, prompt from jobs where id = ?').get(p.woken!) as {
    agent: string;
    prompt: string;
  };
  assert.equal(woke.agent, ceo(), "the board's hold: the CEO judges it");
  assert.match(woke.prompt, /its time came \(/);
  assert.match(woke.prompt, new RegExp(`call item #${item}`));
});

test('a pause names what wakes its owner: one with no time, work or --by-hand is refused, from the CEO too, and so is a time past or unread', () => {
  reset();
  const levels = thread('levels');
  const why = 'Hold it';
  for (const agent of [ceo(), 'wren'])
    assert.match(String(pauses.pause({ thread: levels, why }, agent)), /say what wakes you to judge game\/levels/);
  assert.match(String(pauses.pause({ project: 'game', why, until: [] }, 'wren')), /say what wakes you to judge game/);
  assert.match(String(pauses.pause({ thread: levels, why, untilTime: 'tomorrow' }, 'wren')), /can't read --until-time/);
  assert.match(
    String(pauses.pause({ thread: levels, why, untilTime: '2020-01-01T08:00Z' }, 'wren')),
    /--until-time .* has passed already/,
  );
  assert.deepEqual(pauses.open(), [], 'nothing paused');
});

test('--until-time never lifts the pause by itself, its work merged or not: its owner judges it, and the play starts its work then', async () => {
  reset();
  const [levels, view] = [thread('levels'), thread('view', 'shop')];
  const held = h.queue({ agent: 'kit', thread: levels });
  const now = Date.now();
  const p = pause({ thread: levels, why: 'Not before the morning', untilTime: '2h' });
  assert.ok(Math.abs(Date.parse(p.untilTime!) - (now + 2 * 3600e3)) < 5e3, 'two hours on');
  assert.equal(await h.claim(engineOf(held)), null, 'held before its time');
  const played = snapshot(now).jobs.find(j => j.id === held)!;
  assert.deepEqual(played.wakes, [{ at: Date.parse(p.untilTime!) }], 'the play starts it at the time');
  assert.equal(pauses.pauseOf(levels)?.untilTime, p.untilTime, 'hq thread shows what it waits for');
  pausewake.sweep(Date.parse(p.untilTime!) + 3600e3);
  assert.equal(pauses.open().length, 1, 'past its time: still paused');
  assert.ok(pauses.open()[0].woken, 'and its owner woken');
  assert.equal(await h.claim(engineOf(held)), null, 'and holding');
  assert.equal(typeof pauses.resume({ thread: levels }, ceo()), 'object', 'its owner lifts it');
  assert.equal((await h.claim(engineOf(held)))?.id, held);

  reset();
  thread('levels');
  thread('view', 'shop');
  const gate = await h.start({ agent: 'moss', thread: view });
  const both = pause({
    thread: levels,
    why: 'After the view, and not before the morning',
    untilTime: '2h',
    until: [gate.id],
  });
  await merge(gate, 81);
  pausewake.landed(`job/${gate.id}`);
  pausewake.sweep(Date.parse(both.untilTime!) + 3600e3);
  assert.equal(pauses.open().length, 1, 'its work merged and its time past: still paused');
});

test('a pause is refused where it could never resume, or by anyone but the CEO and the owner', async () => {
  reset();
  const [levels, view] = [thread('levels'), thread('view', 'shop')];
  const own = h.queue({ agent: 'kit', thread: levels });
  const done = await h.start({ agent: 'moss', thread: view });
  await merge(done, 73);
  const why = 'Hold it';
  assert.match(String(pauses.pause({ thread: levels, why }, 'kit')), /^only wren .* or the CEO pauses/);
  assert.match(String(pauses.pause({ thread: levels, why, until: [own] }, 'wren')), /which the pause would hold/);
  assert.match(String(pauses.pause({ project: 'game', why, until: [own] }, 'wren')), /which the pause would hold/);
  assert.match(String(pauses.pause({ thread: levels, why, until: [done.id] }, 'wren')), /merged already/);
  // (a thread of its own, so it ends with nothing to merge rather than on the merged branch of view)
  const ended = await h.start({ agent: 'moss', thread: thread('desk', 'shop') });
  await h.finish(ended);
  assert.match(
    String(pauses.pause({ thread: levels, why, until: [ended.id] }, 'wren')),
    /nothing is left for it to wake you/,
  );
  db.prepare("insert into prs (number, branch, author, status) values (75, ?, 'moss', 'open')").run(`job/${ended.id}`);
  db.prepare("insert into prs (number, branch, author, status) values (76, ?, 'moss', 'closed')").run(
    `job/${ended.id}`,
  );
  assert.match(
    String(pauses.pause({ thread: levels, why, until: [ended.id] }, 'wren')),
    /nothing is left for it to wake you/,
  );
  assert.match(String(pauses.pause({ thread: 'game/none', why }, 'wren')), /no thread game\/none/);
  assert.match(String(pauses.pause({ thread: levels, why: ' ' }, 'wren')), /say why/);
  assert.match(
    String(pauses.pause({ thread: levels, why }, 'wren')),
    /say what wakes you to judge game\/levels: --until/,
  );
  assert.match(String(pauses.pause({ thread: levels, why, untilTime: 'soon' }, 'wren')), /--until-time/);
  pause({ thread: levels, why }, ceo());
  assert.match(
    String(pauses.pause({ thread: levels, why, byHand: true }, 'wren')),
    /paused already .*only the CEO changes it/,
  );
});

test('a pause or a wait that would hold its own way out is refused, across projects too', async () => {
  reset();
  const [levels, till] = [thread('levels'), thread('till', 'shop')];
  const held = h.queue({ agent: 'kit', thread: levels });
  const shop = h.queue({ agent: 'moss', thread: till, after: held });
  assert.match(
    String(pauses.pause({ project: 'game', why: 'Hold it', until: [shop] }, 'wren')),
    new RegExp(`#${shop} needs #${held} first, on ${levels}, which the pause would hold`),
  );
  // (a thread of its own: in till it would follow the task that needs held)
  const free = h.queue({ agent: 'moss', thread: thread('desk', 'shop'), queuedBy: 'moss' });
  pause({ project: 'game', why: 'Hold it', until: [free] }, 'wren');
  assert.match(String(h.jobs.addWait(free, held, 'moss')), /neither would ever start/);
});

test("only the CEO resumes a pause carrying the board's item; resumed early, its task stays on the check until its work merges", async () => {
  reset();
  const view = thread('view', 'shop');
  thread('levels');
  const gate = await h.start({ agent: 'moss', thread: view });
  const followup = await h.start({ agent: ceo() });
  const { item } = agreed({ kind: 'task', status: 'handled' }, Date.now(), ceo(), { job: followup.id });
  pause({ project: 'game', why: 'Wait for the shop', until: [gate.id] }, 'wren');
  const linked = await h.agent('item-link', followup.token, { id: item, to: { pause: 'game' } });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  await h.finish(followup);
  assert.equal(
    pauses.resume({ project: 'game' }, 'wren'),
    `only the CEO resumes game: it carries the board's item #${item}`,
  );
  const standing = () => agreements().find(a => a.id === item)?.pause;
  assert.equal(standing(), 'game', 'the pause carries the task');
  assert.equal(typeof pauses.resume({ project: 'game' }, ceo()), 'object');
  assert.equal(standing(), 'game, resumed', 'resumed before its work merged, the task stays');
  await merge(gate, 74);
  assert.equal(standing(), undefined, 'its work merged');
});

test('an early-resumed pause carries its task through a redraw until that work merges', async () => {
  reset();
  const view = thread('view', 'shop');
  thread('levels');
  const gate = await h.start({ agent: 'moss', thread: view });
  const followup = await h.start({ agent: ceo() });
  const { item } = agreed({ kind: 'task', status: 'handled' }, Date.now(), ceo(), { job: followup.id });
  pause({ project: 'game', why: 'Wait for the shop', until: [gate.id] });
  const linked = await h.agent('item-link', followup.token, { id: item, to: { pause: 'game' } });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  await h.finish(followup);
  assert.equal(typeof pauses.resume({ project: 'game' }, ceo()), 'object');
  await h.finish(gate, { status: 'done', pr: 77, branch: `job/${gate.id}` });
  db.prepare("update prs set status = 'closed' where number = 77").run();
  const redrawn = await h.start({ agent: 'moss', thread: view });
  pauses.redrawing(`job/${gate.id}`, redrawn.id);
  assert.ok(
    agreements().some(a => a.id === item),
    'the redraw still has to merge',
  );
  await merge(redrawn, 78);
  assert.equal(
    agreements().some(a => a.id === item),
    false,
    'the redraw met the release condition',
  );
});

test('hq job onto a paused thread is queued and told it is held; the play holds it until the pause lifts', async () => {
  reset();
  const [levels, view] = [thread('levels'), thread('view', 'shop')];
  const gate = await h.start({ agent: 'moss', thread: view });
  const lead = await h.start({ agent: 'wren', thread: levels });
  pause({ thread: levels, why: 'Wait for the view', until: [gate.id] });
  const brief = `${h.dataDir}/brief.md`;
  writeFileSync(brief, 'The next level.');
  const out = await h.hq(lead, 'job', 'kit', 'Next level', brief, '--new');
  assert.equal(out.code, 0, out.out);
  assert.match(out.out, /Queued job #(\d+)/);
  assert.match(
    out.out,
    new RegExp(
      `Held: ${levels} is paused \\(Wait for the view\\) until it's resumed: its owner judges it once #${gate.id} has merged or ended`,
    ),
  );
  const id = Number(/Queued job #(\d+)/.exec(out.out)![1]);
  const played = snapshot(Date.now()).jobs.find(j => j.id === id)!;
  assert.deepEqual(played.waitsFor, [gate.id], 'the play starts it after the job the pause waits for');
});

test('a pause of the work in no thread holds it, a fix round and review there too, and lets it go as it lifts', async () => {
  reset();
  const [view, gates] = [thread('view', 'shop'), thread('gates', 'shop')];
  const work = h.queue({ agent: 'kit' });
  const fix = h.queue({ agent: 'kit', stage: 'fix', pr: 9, branch: 'job/77' });
  const review = h.queue({ agent: 'rook', kind: 'review', pr: 9 });
  const meeting = h.queue({ agent: 'wren', kind: 'meeting' });
  const expedited = h.queue({ agent: 'moss', expedite: true });
  const followUp = h.queue({ agent: 'bolt', title: 'Follow up on your call with the board' });
  h.storedCall(1, 'bolt', followUp);
  const onThread = h.queue({ agent: 'moss', thread: view });
  const gate = await h.start({ agent: 'moss', thread: gates });
  assert.equal(
    pauses.pause({ project: 'unsorted', why: 'No new start' }, 'wren'),
    `only ${ceo()} (work in no thread's owner) or the CEO pauses unsorted`,
  );
  assert.match(
    pauses.pause({ project: 'unsorted', why: 'No new start', until: [work] }, ceo()) as string,
    new RegExp(`#${work} is on work in no thread, which the pause would hold`),
  );
  const p = pause({ project: 'unsorted', why: 'No new start without a deadline', until: [gate.id] });
  assert.equal(p.held, 3, 'the work, the fix round and the review');
  for (const id of [work, fix, review]) assert.equal(await h.claim(engineOf(id)), null, `#${id} is held`);
  assert.deepEqual(h.job(work).wakes, ['paused with work in no thread'], 'the projects view says what holds it');
  assert.match(h.jobs.openJobs({}).find(j => j.id === fix)!.line, /queued paused with work in no thread:/);
  assert.deepEqual(snapshot(Date.now()).jobs.find(j => j.id === work)!.waitsFor, [gate.id], 'the play holds it too');
  const proposed = snapshot(Date.now(), [{ id: -1, agent: 'kit', title: 'Proposed work', engine: engineOf(work) }]);
  assert.deepEqual(proposed.jobs.find(j => j.id === -1)!.waitsFor, [gate.id], 'proposed work waits for the gate too');
  assert.equal(h.jobs.pausedOn(meeting), null, "a meeting's seat isn't held");
  for (const id of [expedited, followUp, onThread])
    assert.equal((await h.claim(engineOf(id)))?.id, id, `#${id} runs: expedited, the call's follow-up, on a thread`);

  await merge(gate, 81);
  pausewake.sweep();
  assert.ok(pauses.open()[0].woken, 'its gate merged: the CEO is woken, the pause still on');
  for (const id of [work, fix, review]) assert.equal(await h.claim(engineOf(id)), null, `#${id} is still held`);
  pauses.resume({ project: 'unsorted' }, ceo());
  for (const id of [work, fix, review]) assert.equal((await h.claim(engineOf(id)))?.id, id, `#${id} starts`);
});

test('a wake job stays free of its pause once the pause is on new conditions, back in the queue too', async () => {
  reset();
  const work = h.queue({ agent: 'kit' });
  const gate = await h.start({ agent: 'moss', thread: thread('gates', 'shop') });
  pause({ project: 'unsorted', why: 'No new start without a deadline', until: [gate.id] });
  await merge(gate, 91);
  pausewake.sweep();
  const woke = pauses.open()[0].woken!;
  const judging = await h.claim(engineOf(woke));
  assert.equal(judging?.id, woke, 'its owner judges it, in no thread under the pause of that work');
  pause({ project: 'unsorted', why: 'Held by hand until the deadline is set' });
  assert.equal(pauses.open()[0].woken, null, 'kept on by hand: nothing wakes its owner again');
  await h.finish(judging!, { status: 'limited', resetAt: 0 });
  assert.equal(h.job(woke).status, 'queued', 'a limit sends the judging job back to the queue');
  assert.equal(h.jobs.pausedOn(woke), null, 'still free of the pause it judged');
  assert.equal((await h.claim(engineOf(woke)))?.id, woke, 'and it starts again');
  assert.equal(await h.claim(engineOf(work)), null, 'while the pause holds the rest');
});

test("a paused target the CEO blocks on the board's decision waits for its answer", async () => {
  reset();
  const levels = thread('levels');
  const held = h.queue({ agent: 'kit', thread: levels });
  pause({ thread: levels, why: 'Until the trial has reported' });
  const named = decisions.create('Which art direction', [levels], ceo());
  assert.equal(typeof named, 'object', typeof named === 'string' ? named : '');
  const [p] = pauses.open();
  assert.equal(p.decision?.name, 'Which art direction', 'the pause now waits for the decision');
  assert.match(String(pauses.resume({ thread: levels }, ceo())), /only the board's answer on its card lets it go/);
  assert.equal(await h.claim(engineOf(held)), null, 'and still holds its work');
});

test('a pause of the work in no thread waits only for work that can run and merge under it', async () => {
  reset();
  const gates = thread('gates', 'shop');
  const followUp = h.queue({ agent: 'bolt', title: 'Follow up on your call with the board' });
  h.storedCall(1, 'bolt', followUp);
  const expedited = h.queue({ agent: 'moss', expedite: true });
  const afterFollowUp = h.queue({ agent: 'moss', thread: gates, after: followUp });
  // (a thread of its own: in gates it would follow the task after the follow-up)
  const afterExpedited = h.queue({ agent: 'moss', thread: thread('desk', 'shop'), after: expedited });
  const why = 'No new start without a deadline';
  assert.match(
    String(pauses.pause({ project: 'unsorted', why, until: [followUp] }, ceo())),
    new RegExp(`#${followUp} is on work in no thread, which the pause would hold`),
    "the call's follow-up runs, but its review would wait",
  );
  assert.match(
    String(pauses.pause({ project: 'unsorted', why, until: [afterFollowUp] }, ceo())),
    new RegExp(`#${afterFollowUp} needs #${followUp} first, on work in no thread, which the pause would hold`),
  );
  const p = pause({ project: 'unsorted', why, until: [afterExpedited] });
  assert.deepEqual(
    p.until.map(u => u.id),
    [afterExpedited],
    'expedited work merges on its checks, ahead of its review',
  );
});

test('work the pause of the work in no thread holds moves to a thread only once it lifts', async () => {
  reset();
  const view = thread('view', 'shop');
  const work = h.queue({ agent: 'kit' });
  const followUp = h.queue({ agent: 'bolt', title: 'Follow up on your call with the board' });
  h.storedCall(1, 'bolt', followUp);
  pause({ project: 'unsorted', why: 'No new start' });
  assert.match(
    String(moveJob(work, view, 'kit')),
    /holds this work where it is/,
    'its lead may move it, not out of the hold',
  );
  assert.equal(h.job(work).thread, null);
  assert.equal(typeof moveJob(followUp, view, 'bolt'), 'object', 'what the pause lets go moves');
  assert.equal(typeof pauses.resume({ project: 'unsorted' }, 'kit'), 'string', 'only the CEO resumes it');
  assert.deepEqual(pauses.resume({ project: 'unsorted' }, ceo()), { ok: true, target: 'unsorted' });
  assert.deepEqual(moveJob(work, view, 'kit'), { thread: view, jobs: [work] });
});

test('work the pause of the work in no thread holds goes onto a thread by an item link only once it lifts', async () => {
  reset();
  const view = thread('view', 'shop');
  const work = h.queue({ agent: 'kit' });
  const followup = await h.start({ agent: ceo() });
  const { item } = agreed({ kind: 'task', status: 'open' }, Date.now(), ceo(), { job: followup.id });
  pause({ project: 'unsorted', why: 'No new start' });
  const link = () => h.agent('item-link', followup.token, { id: item, to: { job: work }, thread: view });
  const refused = await link();
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /holds this work where it is/);
  assert.equal(h.job(work).thread, null);
  assert.deepEqual(pauses.resume({ project: 'unsorted' }, ceo()), { ok: true, target: 'unsorted' });
  const linked = await link();
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.equal(h.job(work).thread, view);
});

test("the follow-through read lists the pauses first, with the board's item and the work still running on them", async () => {
  reset();
  const levels = thread('levels');
  const running = await h.start({ agent: 'kit', thread: levels, title: 'Level four' });
  const review = await h.start({ agent: 'rook', thread: levels, kind: 'review', title: 'Review level four' });
  const ruling = await h.start({ agent: 'quill', thread: levels, kind: 'consolidate', title: 'Rule on level four' });
  h.queue({ agent: 'kit', thread: levels });
  const check = await h.start({ agent: ceo(), title: 'Follow up the call' });
  const { item } = agreed({ status: 'open' }, Date.now(), ceo(), { job: check.id });
  pause({ project: 'game', why: 'Game work slows the two things meant to speed it up' });
  const linked = await h.agent('item-link', check.token, { id: item, to: { pause: 'game' } });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.equal(linked.body.status, 'handled');
  const refused = await h.agent('item-link', check.token, { id: item, to: { pause: levels } });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /game\/levels isn't paused/);

  const text = read({ id: check.id, agent: ceo() });
  assert.ok(
    text.startsWith('Paused (the claim holds everything queued on them, reviews and fixes too):\n- game (project'),
    text,
  );
  assert.match(
    text,
    /1 queued held\): Game work slows the two things meant to speed it up · by hand: nothing wakes its owner/,
  );
  assert.match(
    text,
    new RegExp(`item #${item} \\(call \\d+, decision\\): No game work until the projects build lands`),
  );
  assert.match(text, /The board's words: "Hold the game work tonight/);
  assert.match(
    text,
    new RegExp(
      `Still on it: #${running.id} ${h.job(running.id).code} kit, running: Level four · started \\d\\d:\\d\\d UTC`,
    ),
  );
  assert.match(text, new RegExp(`Still on it: #${review.id} rook, running \\(review\\): Review level four`));
  assert.match(text, new RegExp(`Still on it: #${ruling.id} quill, running \\(consolidate\\): Rule on level four`));
  assert.ok(
    agreements().some(a => a.id === item && a.pause === 'game'),
    'the decision shows the pause as its work',
  );
  assert.match(text, new RegExp(`item #${item} .*· the pause on game`));
});

test('the follow-through read flags a pause whose waited-on work ended, and one its woken owner left with nothing to wake them', async () => {
  reset();
  const [levels, view] = [thread('levels'), thread('view', 'shop')];
  const trial = await h.start({ agent: 'moss', thread: view, title: 'Run the trial' });
  const check = await h.start({ agent: ceo(), title: 'Follow-through check' });
  pause({ thread: levels, why: 'Until the trial has reported', until: [trial.id] });
  assert.match(
    read({ id: check.id, agent: ceo() }),
    /· wakes its owner at #\d+ \(moss, running\) merged or ended\n {2}no call item/,
  );
  await h.finish(trial);
  assert.match(
    read({ id: check.id, agent: ceo() }),
    new RegExp(`Off track, act this hour: #${trial.id} ended done without merged work, with the pause still on`),
    'before the sweep wakes its owner',
  );
  pausewake.sweep();
  const woken = pauses.open()[0].woken!;
  assert.match(
    read({ id: check.id, agent: ceo() }),
    new RegExp(`Met: what it waited for is met and its owner judges it in #${woken} `),
  );
  assert.match(
    read({ id: woken, agent: ceo() }),
    /Met: what it waited for is met, and this job judges it/,
    'the wake reading it is told it judges it, not that it ended',
  );
  db.prepare("update jobs set status = 'done' where id = ?").run(woken);
  assert.match(
    read({ id: check.id, agent: ceo() }),
    new RegExp(`Off track, act this hour: its owner was woken \\(#${woken}\\), which ended with it still on`),
  );
});

test('a handled item linked to a pause acknowledges its call follow-up', async () => {
  reset();
  thread('levels');
  const followup = await h.start({ agent: ceo() });
  const { call, item } = agreed({ kind: 'task', status: 'handled' }, Date.now(), ceo(), { job: followup.id });
  pause({ project: 'game', why: 'Wait for the shop' });
  const linked = await h.agent('item-link', followup.token, { id: item, to: { pause: 'game' } });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.equal(linked.body.status, 'handled');
  assert.equal(linked.body.acknowledged, true);
  assert.equal((await h.agent('reply', followup.token, { text: 'The game waits for the shop.' })).status, 200); // (its reply)
  await h.finish(followup);
  const followed = db.prepare('select processed_at from calls where id = ?').get(call) as {
    processed_at: string | null;
  };
  assert.ok(followed.processed_at, 'the follow-up processed its call');
});

test('a pause keeps customer item summaries and quotes with jobs allowed to read their call', async () => {
  reset();
  thread('levels');
  const followup = await h.start({ agent: ceo() });
  db.prepare('update jobs set customers = 1 where id = ?').run(followup.id);
  const { item } = agreed(
    { kind: 'task', status: 'handled', what: 'Private customer hold', quote: 'Private customer instruction' },
    Date.now(),
    ceo(),
    { job: followup.id },
  );
  pause({ project: 'game', why: 'Wait for the shop' });
  const linked = await h.agent('item-link', followup.token, { id: item, to: { pause: 'game' } });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  const check = await h.start({ agent: ceo() });
  const shown = await h.hq(check, 'followthrough');
  assert.equal(shown.code, 0, shown.out);
  assert.doesNotMatch(shown.out, /Private customer/);
  const customers = (id: number) =>
    (db.prepare('select customers from jobs where id = ?').get(id) as { customers: number }).customers;
  assert.equal(customers(check.id), 0);
  const helper = h.queue({ agent: ceo(), item });
  const permitted = read({ id: helper, agent: ceo() });
  assert.match(permitted, /Private customer hold/);
  assert.match(permitted, /Private customer instruction/);
  assert.equal(customers(helper), 1);
});

test('work the pause waits for, closed with its commits on main already, wakes its owner; a redraw carries the wait', async () => {
  reset();
  const [levels, view] = [thread('levels'), thread('view', 'shop')];
  const gate = await h.start({ agent: 'moss', thread: view });
  pause({ thread: levels, why: 'Wait for the view', until: [gate.id] });
  db.prepare('update jobs set branch = ? where id = ?').run(`job/${gate.id}`, gate.id);
  const redrawn = h.queue({ agent: 'moss', thread: view });
  pauses.redrawing(`job/${gate.id}`, redrawn);
  assert.deepEqual(
    pauses.open()[0].until.map(u => u.id),
    [redrawn],
  );
  db.prepare('update jobs set branch = ? where id = ?').run(`job/${redrawn}`, redrawn);
  pausewake.landed(`job/${redrawn}`);
  assert.equal(pauses.open()[0].until[0].state, 'done, its commits on main');
  pausewake.sweep();
  assert.ok(pauses.open()[0].woken, 'still on, its owner woken');
});

test('hq thread pause and hq project resume, as the CEO runs them', async () => {
  reset();
  const [levels, view] = [thread('levels'), thread('view', 'shop')];
  const gate = await h.start({ agent: 'moss', thread: view });
  const running = await h.start({ agent: 'kit', thread: levels });
  h.queue({ agent: 'kit', thread: levels });
  const ceoJob = await h.start({ agent: ceo() });
  const paused = await h.hq(ceoJob, 'thread', 'pause', levels, 'Wait for the view', '--until', String(gate.id));
  assert.equal(paused.code, 0, paused.out);
  assert.match(
    paused.out,
    new RegExp(
      `^Paused ${levels}: Wait for the view\\n1 queued job on it held\\. Once #${gate.id} \\(moss, running\\) has merged or ended, HQ queues you a job to judge it; only hq thread resume ${levels} lifts it\\.`,
    ),
  );
  assert.match(paused.out, new RegExp(`Started before the pause: #${running.id}\\. Stop each`));
  const open = await h.hq(ceoJob, 'project', 'pause', 'game', 'All of it');
  assert.notEqual(open.code, 0, 'nothing named to wake its owner: refused');
  assert.match(open.out, /say what wakes you to judge game: --until/);
  const again = await h.hq(ceoJob, 'project', 'pause', 'game', 'All of it', '--by-hand');
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /It holds until hq project resume game: nothing wakes you about it\./);
  const shown = await h.hq(ceoJob, 'thread', levels);
  assert.match(
    shown.out,
    /Paused \(Wait for the view\) until it's resumed: its owner judges it once #\d+ \(moss, running\) has merged or ended\./,
  );
  assert.notEqual((await h.hq(ceoJob, 'project', 'pause', 'game', 'Twice')).code, 0);
  const resumed = await h.hq(ceoJob, 'project', 'resume', 'game');
  assert.equal(resumed.code, 0, resumed.out);
  assert.deepEqual(
    pauses.open().map(p => p.target),
    [levels],
  );
});

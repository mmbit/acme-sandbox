// node --test src/pad.test.ts   (throwaway DATA_DIR and the test company): the CEO's page (hq pad) and the goal mark on a
// project (hq project goal), through the agents' routes and HQ's projects view, and the page through the real hq script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('pad');

test("the CEO's jobs rewrite the page whole, every version kept; anyone reads it, nobody else writes it", async () => {
  const juno = await h.start({ agent: 'juno', title: 'The morning round' });
  const bolt = await h.start({ agent: 'bolt', title: 'Some work' });
  assert.deepEqual((await h.agent('pad', bolt.token)).body, { page: null });

  const first = 'Goal: first paying customers.\nWatching: payments tried, read Thursday.';
  assert.equal((await h.agent('pad', juno.token, { text: first })).status, 200);
  assert.equal((await h.agent('pad', juno.token, { text: first })).status, 400, 'the same page again changes nothing');
  assert.equal((await h.agent('pad', juno.token, { text: '  ' })).status, 400, 'an empty page is refused');
  const refused = await h.agent('pad', bolt.token, { text: 'My plan instead' });
  assert.equal(refused.status, 400);
  const second = `${first}\nNext: the walk's fixes live.`;
  assert.equal((await h.agent('pad', juno.token, { text: second })).status, 200);

  const { page } = (await h.agent('pad', bolt.token)).body;
  assert.equal(page.text, second);
  assert.equal(page.job, juno.id);
  const { versions } = (await h.agent('pad?history=1', bolt.token)).body;
  assert.deepEqual(
    versions.map((v: { text: string }) => v.text),
    [second, first],
  );
  assert.equal((await h.board('/api/projects')).body.page.text, second, 'the board reads it atop the projects');
  await h.finish(juno);
  await h.finish(bolt);
});

test('the CEO marks a project a goal and takes the mark off; the projects view shows it', async () => {
  const juno = await h.start({ agent: 'juno', title: 'Goals' });
  const kit = await h.start({ agent: 'kit', title: 'Some work' });
  h.dueThread();
  const goalOf = async () =>
    (await h.board('/api/projects')).body.projects.find((p: { id: string }) => p.id === 'due').goal ?? false;
  assert.equal((await h.agent('projects/goal', kit.token, { id: 'due', goal: true })).status, 400, "only the CEO's");
  assert.equal((await h.agent('projects/goal', juno.token, { id: 'nothing', goal: true })).status, 400);
  assert.equal((await h.agent('projects/goal', juno.token, { id: 'due', goal: true })).status, 200);
  assert.equal(await goalOf(), true);
  assert.equal((await h.agent('projects/goal', juno.token, { id: 'due', goal: false })).status, 200);
  assert.equal(await goalOf(), false);
  await h.finish(juno);
  await h.finish(kit);
});

test('hq pad prints the page, its CEO rewrites it from stdin, and --history lists every version (bin/hq)', async () => {
  const juno = await h.start({ agent: 'juno', title: 'The plan' });
  const kit = await h.start({ agent: 'kit', title: 'Some work' });
  const page = 'Goal: first paying customers.\nNext: read the walk on Thursday.';
  const wrote = await h.hq({ ...juno, stdin: `${page}\n` }, 'pad', 'write', '-');
  assert.equal(wrote.code, 0, wrote.out);
  const shown = await h.hq(kit, 'pad');
  assert.equal(shown.code, 0);
  assert.match(
    shown.out,
    new RegExp(`^${page}\n\n\\(written \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC, juno's #${juno.id}\\)`),
  );
  const next = 'Goal: first paying customers.\nNext: the walk is read; the letter goes out.';
  assert.equal((await h.hq({ ...juno, stdin: `${next}\n` }, 'pad', 'write', '-')).code, 0);
  const history = (await h.hq(kit, 'pad', '--history')).out;
  const version = (text: string) => `== \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC, juno's #${juno.id}\\n${text}`;
  assert.match(history, new RegExp(`^${version(next)}\n\n${version(page)}(\n|$)`), 'both versions, newest first');

  const refused = await h.hq({ ...kit, stdin: 'My plan instead' }, 'pad', 'write', '-');
  assert.notEqual(refused.code, 0, "only the CEO's jobs write it");
  assert.match((await h.hq(kit, 'pad')).out, /^Goal: first paying customers\./, 'the page is as it was');
  for (const bad of [
    ['pad', 'write'],
    ['pad', 'write', 'page.md'],
    ['pad', '--history', 'x'],
    ['pad', 'read'],
  ])
    assert.notEqual((await h.hq(kit, ...bad)).code, 0, bad.join(' '));
  await h.finish(juno);
  await h.finish(kit);
});

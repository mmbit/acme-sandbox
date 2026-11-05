// node --test src/pad.test.ts   (throwaway DATA_DIR and the test company): the CEO's page (hq pad) and the goal mark on a
// project (hq project goal), through the agents' routes and HQ's projects view, and the page through the real hq script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('pad');
// The page's newest version, the one a rewrite names (none before the first)
const newest = async (token: string) => (await h.agent('pad', token)).body.page?.id;

test("the CEO's jobs rewrite the page whole on the version they read, every version kept; anyone reads it, nobody else writes it", async () => {
  const juno = await h.start({ agent: 'juno', title: 'The morning round' });
  const bolt = await h.start({ agent: 'bolt', title: 'Some work' });
  assert.deepEqual((await h.agent('pad', bolt.token)).body, { page: null });

  const first = 'Goal: first paying customers.\nWatching: payments tried, read Thursday.';
  assert.equal((await h.agent('pad', juno.token, { text: first })).status, 200);
  const read = (await h.agent('pad', juno.token)).body.page.id;
  const again = { text: first, version: read };
  assert.equal((await h.agent('pad', juno.token, again)).status, 400, 'the same page again changes nothing');
  assert.equal(
    (await h.agent('pad', juno.token, { text: '  ', version: read })).status,
    400,
    'an empty page is refused',
  );
  const refused = await h.agent('pad', bolt.token, { text: 'My plan instead', version: read });
  assert.equal(refused.status, 400);
  const second = `${first}\nNext: the walk's fixes live.`;
  assert.equal((await h.agent('pad', juno.token, { text: second })).status, 400, 'a rewrite names the version it read');
  assert.equal((await h.agent('pad', juno.token, { text: second, version: read })).status, 200);

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
  const before = String(await newest(juno.token));
  const wrote = await h.hq({ ...juno, stdin: `${page}\n` }, 'pad', 'write', '-', '--version', before);
  assert.equal(wrote.code, 0, wrote.out);
  const shown = await h.hq(kit, 'pad');
  assert.equal(shown.code, 0);
  const id = await newest(kit.token);
  assert.match(
    shown.out,
    new RegExp(`^${page}\n\n\\(version ${id}, written \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC, juno's #${juno.id}\\)`),
  );
  const next = 'Goal: first paying customers.\nNext: the walk is read; the letter goes out.';
  const unnamed = await h.hq({ ...juno, stdin: `${next}\n` }, 'pad', 'write', '-');
  assert.notEqual(unnamed.code, 0, 'a rewrite of a page names the version it read');
  assert.match(unnamed.out, /name the version you rewrite \(hq pad prints it\)/);
  assert.equal((await h.hq({ ...juno, stdin: `${next}\n` }, 'pad', 'write', '-', '--version', String(id))).code, 0);
  const history = (await h.hq(kit, 'pad', '--history')).out;
  const version = (text: string) => `== \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC, juno's #${juno.id}\\n${text}`;
  assert.match(history, new RegExp(`^${version(next)}\n\n${version(page)}(\n|$)`), 'both versions, newest first');

  const refused = await h.hq({ ...kit, stdin: 'My plan instead' }, 'pad', 'write', '-', '--version', String(id + 1));
  assert.notEqual(refused.code, 0, "only the CEO's jobs write it");
  assert.match((await h.hq(kit, 'pad')).out, /^Goal: first paying customers\./, 'the page is as it was');
  for (const bad of [
    ['pad', 'write'],
    ['pad', 'write', 'page.md'],
    ['pad', 'write', '-', '--version'],
    ['pad', 'write', '-', '--version', 'last'],
    ['pad', '--history', 'x'],
    ['pad', 'read'],
  ])
    assert.notEqual((await h.hq(kit, ...bad)).code, 0, bad.join(' '));
  await h.finish(juno);
  await h.finish(kit);
});

// Whatever a later call, check or follow-up must know, the CEO just knows: every run of the CEO's starts with the page,
// its version and the one general instruction to keep it, as the page is at that run's claim; a colleague's doesn't.
test("every job of the CEO starts with its page and how to keep it, as it is when the job starts; a colleague's doesn't", async () => {
  const writer = await h.start({ agent: 'juno', title: 'The plan' });
  const page = 'Remember: the broken images are our own screenshots.';
  assert.equal((await h.agent('pad', writer.token, { text: page, version: await newest(writer.token) })).status, 200);
  await h.finish(writer);

  const juno = await h.start({ agent: 'juno', title: 'A follow-up of a call' });
  assert.match(
    juno.page,
    /^Your page \(hq pad\) is your memory across all your work: every job, check and call of yours/,
  );
  assert.match(
    juno.page,
    /anything a later call, check or follow-up must still know, for\nwhatever reason: rewrite the page whole/,
  );
  assert.match(juno.page, /read `hq pad` right before[^]*`hq pad write - --version <id>`/);
  const version = await newest(juno.token);
  assert.match(juno.page, new RegExp(`\nVersion ${version}, as you wrote it at [^\n]* UTC:\n${page}$`));
  const next = `${page}\nRemember: the estimates for Ink still count the old book check.`;
  assert.equal((await h.agent('pad', juno.token, { text: next, version })).status, 200);
  const check = await h.start({ agent: 'juno', title: 'Follow-through check', check: true });
  assert.ok(check.page.endsWith(`UTC:\n${next}`), 'the next job reads the page as it is now');
  assert.equal((await h.start({ agent: 'bolt', title: 'Some work' })).page, undefined);
  await h.finish(juno);
  await h.finish(check);
});

// A call with the CEO adds what the board settles to the page at once (the voice line's page tool, hq pad add -), on
// the page as it is now, so a job's rewrite during the call stays; the versions say it came from the call. A job's
// rewrite from the copy it read before the add is refused, so the add stays too. The call only adds: its token can't
// rewrite the page. A colleague's call or job adds nothing.
test("the CEO's call adds to the page as it is now, each version kept with the call; nobody else's adds", async () => {
  const juno = await h.start({ agent: 'juno', title: 'The plan' });
  const first = { text: 'Goal: first paying customers.', version: await newest(juno.token) };
  assert.equal((await h.agent('pad', juno.token, first)).status, 200);
  const claimed = await h.start({ agent: 'juno', title: 'The hourly check', check: true });
  const read = await newest(claimed.token);
  assert.match(claimed.page, new RegExp(`\nVersion ${read}, as you wrote it`));
  const { token } = (await h.voice('call-context', { agent: 'juno', lang: 'en' })).body;
  const settled = 'The board: the shop opens Friday, not Monday.';
  assert.equal((await h.agent('pad/add', token, { add: settled })).status, 200);
  assert.equal((await h.agent('pad/add', token, { add: settled })).status, 400, 'the same words twice go on once');
  assert.equal((await h.agent('pad/add', token, { add: ' ' })).status, 400, 'nothing to add');
  assert.equal(
    (await h.agent('pad', token, { text: 'The whole page from the call.' })).status,
    403,
    'a call only adds',
  );

  const stale = await h.agent('pad', claimed.token, {
    text: 'Goal: first paying customers.\nNext: the letter.',
    version: read,
  });
  assert.equal(stale.status, 400, "a rewrite from the job's claim-time copy would drop the call's words");
  assert.match(
    JSON.stringify(stale.body),
    /the page changed since you read it \(a call or another job added to it\): read hq pad and write it again/,
  );
  const now = (await h.agent('pad', claimed.token)).body.page;
  assert.ok(now.text.endsWith(settled), 'the words the call added stay');
  const rewritten = 'Goal: first paying customers, by the shop.\nThe board: the shop opens Friday, not Monday.';
  assert.equal(
    (await h.agent('pad', juno.token, { text: rewritten, version: now.id })).status,
    200,
    'a job rewrites it during the call, on the page as it is now',
  );
  assert.equal((await h.agent('pad/add', token, { add: 'Watch the first orders Friday evening.' })).status, 200);
  const page = (await h.agent('pad', juno.token)).body.page;
  assert.equal(page.text, `${rewritten}\nWatch the first orders Friday evening.`, "added to the job's rewrite");
  assert.equal(page.job, null);
  assert.ok(page.call > 0, 'the version names its call');
  const shown = await h.hq(juno, 'pad');
  assert.match(shown.out, new RegExp(`UTC, juno's call #${page.call}\\)\n$`));

  const kit = await h.start({ agent: 'kit', title: 'Some work' });
  const theirs = (await h.voice('call-context', { agent: 'kit', lang: 'en' })).body.token;
  assert.equal((await h.agent('pad/add', theirs, { add: 'My plan instead.' })).status, 400);
  const added = await h.hq({ ...kit, stdin: 'My plan instead.' }, 'pad', 'add', '-');
  assert.notEqual(added.code, 0, "only the CEO's");
  const more = await h.hq({ ...juno, stdin: 'Next: the letter.\n' }, 'pad', 'add', '-');
  assert.equal(more.code, 0, more.out);
  assert.ok((await h.agent('pad', kit.token)).body.page.text.endsWith('evening.\nNext: the letter.'));
  await h.voice('call-end', { agent: 'juno', lines: [], token });
  await h.voice('call-end', { agent: 'kit', lines: [], token: theirs });
  await h.finish(juno);
  await h.finish(kit);
  await h.finish(claimed);
});

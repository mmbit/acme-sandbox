// node --test src/hiring.test.ts   (the test company): work for a colleague being hired waits for the hiring to merge,
// and a new company's CEO is told to found the team before the work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('hiring');
const hiring = await import('./hiring.ts');   // (sweep: what the server runs every minute, here at a time of the test's)
const orgFile = `${h.repo}/company/org.yaml`, org = readFileSync(orgFile, 'utf8');
const hire = (line: string) => writeFileSync(orgFile, org.replace(/^roles:/m, `  - id: studio2\n    name: Studio two\n    room: { kind: studio, size: s }\n    agents:\n      ${line}\n\nroles:`));
const brief = 'Build the shop.';
const queue = (lead: { token: string }, job: Record<string, unknown>) => h.agent('job', lead.token, { prompt: brief, ...job });

test("a job for someone org.yaml on main doesn't have is refused, unless it waits for the job hiring them", async () => {
  const lead = await h.start({ agent: 'juno', title: 'Found the team' }), hiringJob = lead.id;
  const refused = await queue(lead, { agent: 'ada', title: 'The shop' });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, new RegExp(`--after ${hiringJob}`), 'the refusal says how to queue it');
  assert.equal((await queue(lead, { agent: 'board', title: 'The shop', after: hiringJob })).status, 403, 'never the board, hiring or not');

  const queued = await queue(lead, { agent: 'ada', title: 'The shop', after: hiringJob });
  assert.equal(queued.status, 200);
  const shop = queued.body.id as number;
  await h.finish(lead, { result: 'Hired Ada' });
  for (const engine of ['claude', 'codex']) assert.notEqual((await h.claim(engine))?.id, shop, 'nobody runs it before the hire lands');

  hire('- { id: ada, name: Ada, role: Shop builder, engine: codex, look: "apron" }');
  hiring.sweep();
  assert.equal(h.job(shop).engine, 'codex', "it takes the new colleague's engine");
  assert.equal((await h.claim('codex'))?.id, shop);
  writeFileSync(orgFile, org);
});

test('work for a hire that never lands is cancelled after a while, and whoever queued it hears why', async () => {
  const lead = await h.start({ agent: 'juno', title: 'Found the team again' });
  const queued = await queue(lead, { agent: 'bea', title: 'The ads', after: lead.id });
  assert.equal(queued.status, 200);
  const ads = queued.body.id as number;
  hiring.sweep();
  assert.equal(h.job(ads).status, 'queued', 'still waiting while the hiring job runs');
  await h.finish(lead, { result: 'Hired nobody after all' });
  const now = Date.now();
  hiring.sweep(now);
  assert.equal(h.job(ads).status, 'queued', 'the deploy gets time to bring org.yaml');
  hiring.sweep(now + 31 * 60_000);
  assert.equal(h.job(ads).status, 'cancelled');
  assert.ok((h.jobs.listJobs() as any[]).some(j => j.id > ads && j.agent === 'juno'), 'the CEO, who queued it, gets a job about it');
});

test("a new company's CEO is told to hire first, and only while the company has no team", async () => {
  const followUp = async () => {
    const ctx = await h.voice('call-context?agent=juno&request=0');
    assert.equal(ctx.status, 200);
    await h.voice('call-end', { agent: 'juno', lines: ['Board: We sell mugs.', 'Juno: Lovely.'], request: 0, token: ctx.body.token });
    // the call's follow-up, as its run gets it (anything queued ahead of it runs first), and done: the next call doesn't
    // carry on from this one
    const id = (await h.board('/api/calls')).body.find((c: any) => c.id === ctx.body.call).job;
    let job;
    while ((job = (await h.claim('claude'))!).id !== id) await h.finish(job, { result: 'Done.' });
    assert.match(job.title, /call/i);
    const noted = { kind: 'briefing', owner: 'juno', what: 'We sell mugs', quote: 'Board: We sell mugs.', call: ctx.body.call };
    assert.equal((await h.agent('item', job.token, noted)).status, 200);
    assert.equal((await h.agent('reply', job.token, { text: 'Noted: we sell mugs.' })).status, 200); // (its reply)
    await h.finish(job, { result: 'Noted.' });
    return job.prompt as string;
  };
  assert.doesNotMatch(await followUp(), /founding\.md/, 'a company with a team gets the usual follow-up');
  writeFileSync(orgFile, org.replace(/^departments:[\s\S]*?^roles:/m, 'departments:\n  - id: executive\n    name: Executive\n    room: { kind: office, size: s }\n    agents:\n'
    + '      - { id: juno, name: Juno, role: CEO, engine: claude, look: "round glasses" }\n\nroles:'));
  assert.match(await followUp(), /founding\.md/);
  writeFileSync(orgFile, org);
});

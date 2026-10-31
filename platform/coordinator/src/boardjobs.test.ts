// node --test src/boardjobs.test.ts (uses a throwaway DATA_DIR).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('boardjobs');
test.afterEach(() => h.cancelQueued());

for (const { agent, allowed } of [
  { agent: 'kit', allowed: true },
  { agent: 'juno', allowed: true },
  { agent: 'bolt', allowed: true },
  { agent: 'quill', allowed: false },
]) {
  test(`board assignments give ${agent} normal planned-work permissions`, async () => {
    const caller = await h.start({ agent, kind: 'chat' });
    const queued = await h.board('/api/jobs', { agent: 'kit', title: 'Check the map' });
    assert.equal(queued.status, 200);
    const id = queued.body.id;
    assert.equal(h.jobs.openJobs({}).find(j => j.id === id)!.queued_by, 'board');
    const automatic = h.queue({ agent: 'kit', title: 'An automatic check' });
    const prior = h.queue({ agent: 'moss', title: 'Draw the map', queuedBy: 'juno' });

    const addition = await h.agent('extend', caller.token, { id, text: 'Check the harbour too' });
    assert.equal(addition.status, 200);
    const saved = h.db.prepare('select prompt from jobs where id = ?').get(id) as { prompt: string };
    assert.match(saved.prompt, /Check the harbour too/);
    assert.equal((await h.agent('extend', caller.token, { id: automatic, text: 'More work' })).status, 404);

    const wait = await h.agent('waits', caller.token, { id, to: prior });
    assert.equal(wait.status, allowed ? 200 : 409);
    const open = h.jobs.openJobs({}).find(j => j.id === id)!;
    assert.deepEqual(open.waits, allowed ? [prior] : []);
    assert.equal((await h.agent('waits', caller.token, { id: automatic, to: prior })).status, 409);

    const cancelled = await h.agent('cancel', caller.token, { id, why: 'No longer needed' });
    assert.equal(cancelled.status, allowed ? 200 : 404);
    assert.equal(h.job(id).status, allowed ? 'cancelled' : 'queued');
    assert.equal((await h.agent('cancel', caller.token, { id: automatic, why: 'No longer needed' })).status, 404);
    assert.equal(h.job(automatic).status, 'queued');
    await h.finish(caller);
  });
}

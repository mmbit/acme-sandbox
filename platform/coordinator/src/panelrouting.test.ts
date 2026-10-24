// node --test src/panelrouting.test.ts (uses a throwaway DATA_DIR)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';
import { leftoverJobs } from './reviewfixture.ts';

const h = await harness('panel', {
  before: repo => {
    const file = `${repo}/company/org.yaml`;
    writeFileSync(file, readFileSync(file, 'utf8').replace('consolidator: quill', 'consolidator: [quill, nib]'));
  },
});
const panel = await import('./panel.ts');
const minute = 60_000;
afterEach(leftoverJobs(h.db));

function round(pr: number, dueIn: number) {
  const thread = h.dueThread({ deadline: Date.now() + dueIn * minute });
  const work = h.ended({ agent: 'bolt', thread });
  h.storedPr(pr, work, 'open', ['platform/hq/room.js'], { round: 1 });
  return { pr, round: 1, branch: `job/${work}`, thread };
}

const queued = (pr: ReturnType<typeof round>, engine: string, kind = 'review', stage = 'review') =>
  h.queue({ ...pr, agent: engine === 'claude' ? 'quill' : 'nib', engine, kind, stage });

async function seats(paced = false) {
  for (const engine of ['claude', 'codex'])
    await h.worker('seat', {
      seat: `${engine}-1`,
      engine,
      state: 'ready',
      pace: paced && engine === 'claude',
      weekResets: paced && engine === 'claude' ? Date.now() + 5 * minute : null,
    });
}

test('round routing counts latest starts when finish deadlines cross their order', async () => {
  await seats();
  const now = Date.now();
  for (const [kind, minutes] of [
    ['review', 36],
    ['consolidate', 15],
  ] as const)
    h.pastJob({ kind, engine: 'claude', run: { started: now - (minutes + 1) * minute, ended: now - minute } });
  const running = [];
  try {
    for (const [pr, engine] of [
      [180, 'claude'],
      [181, 'codex'],
    ] as const) {
      queued(round(pr, 200), engine);
      const run = await h.claim(engine, { seat: `${engine}-1` });
      assert.ok(run);
      running.push(run.id);
    }
    queued(round(182, 120), 'codex');
    queued(round(183, 110), 'claude', 'consolidate', 'ruling');
    round(184, 115);
    // The Codex read and ruling need 63 minutes, the incoming triage and ruling 42, the Claude ruling 21.
    assert.equal(panel.consolidator(184), 'quill');
  } finally {
    h.failedJobs(...running);
  }
});

test('a paced seat takes a round whose latest start precedes its reset but whose finish follows it', async () => {
  await seats(true);
  queued(round(185, 200), 'codex', 'consolidate', 'ruling');
  round(186, 10);
  assert.equal(panel.consolidator(186, 'merge'), 'quill');
  await seats();
});

// node --test src/panelrouting.test.ts (uses a throwaway DATA_DIR)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';
import { scenarioCleanup } from './reviewfixture.ts';

const h = await harness('panel', {
  before: repo => {
    const file = `${repo}/company/org.yaml`;
    writeFileSync(file, readFileSync(file, 'utf8').replace('consolidator: quill', 'consolidator: [quill, nib]'));
  },
});
const panel = await import('./panel.ts');
const minute = 60_000;
afterEach(scenarioCleanup(h.db));

function round(pr: number, dueIn: number) {
  const thread = h.dueThread({ deadline: Date.now() + dueIn * minute });
  const work = h.ended({ agent: 'bolt', thread });
  h.storedPr(pr, work, 'open', ['platform/hq/room.js'], { round: 1 });
  return { pr, round: 1, branch: `job/${work}`, thread };
}

const queued = (pr: ReturnType<typeof round>, engine: string, kind = 'review', stage = 'review') =>
  h.queue({ ...pr, agent: engine === 'claude' ? 'quill' : 'nib', engine, kind, stage });

async function seats(paced = false) {
  await h.worker('room', { capacity: { slots: { claude: 1, codex: 1 }, seatRuns: { claude: 1, codex: 1 }, room: 2 } });
  for (const engine of ['claude', 'codex'])
    await h.worker('seat', {
      seat: `${engine}-1`,
      engine,
      state: 'ready',
      week: paced && engine === 'claude' ? 0.5 : 0,
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

test('equal starts follow weekly room against resets and reverse when the engines change places', async () => {
  await seats();
  const now = Date.now();
  const day = 24 * 60 * minute;
  round(187, 200);
  try {
    for (const [index, week] of [0.52, 0.84, 0.93].entries())
      await h.worker('seat', {
        seat: `claude-${index + 1}`,
        engine: 'claude',
        state: 'ready',
        week,
        weekResets: now + 2 * day,
        pace: false,
      });
    await h.worker('seat', {
      seat: 'codex-1',
      engine: 'codex',
      state: 'ready',
      week: 0.29,
      weekResets: now + 5 * day,
      pace: false,
    });
    for (const stage of ['triage', 'ruling', 'merge']) assert.equal(panel.consolidator(187, stage), 'nib');
    const triage = await import('./reviewtriage.ts');
    const brief = triage.brief(187, '', [], [], null);
    assert.ok(brief.includes(`"week_resets":${now + 5 * day}`), 'the judgment receives the actual reset');
    // The same allowance with an earlier reset is room to spend, not a reason to preserve it longer.
    await h.worker('seat', {
      seat: 'codex-1',
      engine: 'codex',
      state: 'ready',
      week: 0.89,
      weekResets: now + 5 * day,
      pace: false,
    });
    assert.equal(panel.consolidator(187), 'quill');
    await h.worker('seat', {
      seat: 'codex-1',
      engine: 'codex',
      state: 'ready',
      week: 0.89,
      weekResets: now + day / 4,
      pace: false,
    });
    assert.equal(panel.consolidator(187), 'nib');
  } finally {
    for (const seat of ['claude-2', 'claude-3']) await h.worker('seat', { seat, engine: 'claude', state: 'closed' });
    await h.worker('seat', { seat: 'claude-1', engine: 'claude', state: 'ready', week: null, weekResets: null });
    await h.worker('seat', { seat: 'codex-1', engine: 'codex', state: 'ready', week: null, weekResets: null });
  }
});

test('paused seats do not change which engine has weekly room at an equal start', async () => {
  await seats();
  const reset = Date.now() + 7 * 24 * 60 * minute;
  round(189, 200);
  try {
    for (const [engine, week] of [
      ['claude', 0.8],
      ['codex', 0.5],
    ] as const)
      await h.worker('seat', { seat: `${engine}-1`, engine, state: 'ready', week, weekResets: reset });
    await h.worker('seat', { seat: 'claude-2', engine: 'claude', state: 'paused', week: 0, weekResets: reset });
    for (const stage of ['triage', 'ruling', 'merge']) assert.equal(panel.consolidator(189, stage), 'nib');
    await h.worker('seat', { seat: 'claude-2', engine: 'claude', state: 'closed' });
    assert.equal(panel.consolidator(189), 'nib');
  } finally {
    await h.worker('seat', { seat: 'claude-2', engine: 'claude', state: 'closed' });
    for (const engine of ['claude', 'codex'])
      await h.worker('seat', { seat: `${engine}-1`, engine, state: 'ready', week: null, weekResets: null });
  }
});

test('a concurrent seat starts a ruling beside work while a single-run seat waits', async () => {
  await seats();
  await h.worker('room', { capacity: { slots: { claude: 1, codex: 2 }, seatRuns: { claude: 1, codex: 2 }, room: 3 } });
  const running = [];
  try {
    for (const engine of ['claude', 'codex']) {
      h.queue({ agent: engine === 'claude' ? 'quill' : 'nib', engine, kind: 'work' });
      const run = await h.claim(engine, { seat: `${engine}-1` });
      assert.ok(run);
      running.push(run.id);
    }
    round(188, 200);
    assert.equal(panel.consolidator(188, 'ruling'), 'nib');
  } finally {
    h.failedJobs(...running);
  }
});

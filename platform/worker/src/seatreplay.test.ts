// node --test src/seatreplay.test.ts (runs hq against a local coordinator)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

const HOUR = 3_600_000;
const cutoff = Date.parse('2026-10-24T08:00:00Z');
const account = {
  usual: [
    {
      seat: 'claude-a',
      engine: 'claude',
      events: [
        {
          type: 'exhaustion',
          at: cutoff + HOUR,
          started_at: cutoff + HOUR,
          quota: 'fiveHour',
          until: cutoff + 3 * HOUR,
          idle_ms: 2 * HOUR,
          running: [{ job: 17, stage: 'first-review', remaining_ms: HOUR }],
        },
        { type: 'exhaustion', at: cutoff, started_at: null, quota: 'reported', until: null, running: [] },
        {
          type: 'exhaustion',
          at: cutoff,
          started_at: cutoff,
          quota: 'reported',
          until: cutoff + 2 * HOUR,
          running_continues: true,
          idle_ms: HOUR,
          running: [{ job: 18, stage: null, remaining_ms: HOUR }],
        },
      ],
    },
  ],
  slow: [{ seat: 'slow-only', events: [{ type: 'exhaustion', at: cutoff, quota: 'week' }] }],
};

test('the extra-seat command prints usual-pace exhaustions, interrupted work, idle time and thread changes', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, '/api/agent/when?extra_seat=5x');
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        available: true,
        at: cutoff,
        scenario: 'added_claude_seat',
        capacity: {
          plan: 5,
          source_plan: 20,
          confidence: 'low',
          five_agent_hours: 10,
          week_agent_hours: 50,
          stop: 0.9,
          pacing: false,
          measured: null,
          assumptions: [],
        },
        projects: [],
        unpriced: [],
        account: { before: account, after: account },
        changes: { earlier: 4, later: 1, unchanged: 3, unresolved: 2 },
        horizon_days: 8,
        played_ms: 30,
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const address = server.address() as { port: number };
    const { stdout } = await promisify(execFile)(
      new URL('../bin/hq', import.meta.url).pathname,
      ['when', '--extra-seat', '5x'],
      {
        env: { ...process.env, HQ_URL: `http://127.0.0.1:${address.port}`, HQ_TOKEN: 'test-token' },
      },
    );
    assert.match(stdout, /Before, usual pace seat predictions:/);
    assert.match(stdout, /With added seat, usual pace seat predictions:/);
    assert.match(stdout, /claude-a:.*09:00 UTC, fiveHour, runs dry, return .*11:00 UTC, idle 2 h/);
    assert.match(stdout, /Job 17 \(first-review\): 1 h remaining/);
    assert.match(stdout, /hold active at cutoff, original start unknown, return unknown, idle unknown/);
    assert.match(stdout, /work continues, then idle 1 h/);
    assert.match(stdout, /Job 18: 1 h remaining/);
    assert.match(stdout, /Deliverable finishes: 4 earlier, 1 later, 3 unchanged, 2 unresolved/);
    assert.doesNotMatch(stdout, /slow-only/);
  } finally {
    server.close();
  }
});

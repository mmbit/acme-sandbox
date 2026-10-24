// node --test src/hq.test.ts   (a throwaway DATA_DIR with the real SQLite, and a local server playing HQ's line)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HQ's side: a status for every request, or 0 for no answer at all (the connection dropped, as while it restarts);
// cardStatus, when set, for the cards alone; onCard sees each card body before HQ answers it
let status = 200,
  cardStatus: number | null = null,
  onCard: ((card: any) => void) | null = null;
const hqServer = createServer((req, res) => {
  const isCard = req.url?.startsWith('/api/care/cards');
  const answer = isCard && cardStatus != null ? cardStatus : status;
  let body = '';
  req.on('data', chunk => (body += chunk));
  req.on('end', () => {
    if (isCard && body) onCard?.(JSON.parse(body));
    if (!answer) return void req.socket.destroy();
    if (answer !== 200) return void res.writeHead(answer).end();
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ busy: 'auto', queue: { waiting: 0, oldest: null } }));
  });
});

let hq: typeof import('./hq.ts');
before(async () => {
  await new Promise<void>(r => hqServer.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    DATA_DIR: mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'care-hq-')),
    CARE_HQ_URL: `http://127.0.0.1:${(hqServer.address() as any).port}`,
    CARE_HQ_TOKEN: 'hq-test-token',
  });
  hq = await import('./hq.ts');
});
after(() => {
  hqServer.closeAllConnections();
  hqServer.close();
});

const MIN = 60_000;
// what one sync writes to the log as an error
async function logged(t: number) {
  const lines: string[] = [],
    error = console.error;
  console.error = (...a: any[]) => {
    lines.push(a.join(' '));
  };
  try {
    await hq.sync(t);
  } finally {
    console.error = error;
  }
  return lines;
}

test('HQ away for a deploy is no error; away for longer, or failing itself, is', async () => {
  const t = Date.now();
  status = 502;
  assert.equal((await logged(t)).length, 0, 'its gateway while it restarts');
  status = 0;
  assert.equal((await logged(t + MIN)).length, 0, 'no answer at all');
  status = 503;
  assert.equal((await logged(t + 11 * MIN)).length, 1, 'away longer than a deploy takes');
  status = 200;
  assert.equal((await logged(t + 12 * MIN)).length, 0);
  status = 0;
  assert.equal((await logged(t + 13 * MIN)).length, 0, 'a new outage counts afresh');
  status = 401;
  assert.equal((await logged(t + 14 * MIN)).length, 1, 'HQ refusing is said at once');
  status = 200;
});

test("HQ's own 500 for a moment (its database locked) is no error; for longer than a deploy, it is", async () => {
  const t = Date.now() + 30 * MIN;
  status = 200;
  assert.equal((await logged(t)).length, 0);
  status = 500;
  assert.equal((await logged(t + MIN)).length, 0, 'a moment of it');
  status = 200;
  assert.equal((await logged(t + 2 * MIN)).length, 0);
  status = 500;
  for (let m = 3; m < 13; m++) assert.equal((await logged(t + m * MIN)).length, 0, `minute ${m}`);
  assert.equal((await logged(t + 13 * MIN)).length, 1, 'ten minutes of it');
  status = 200;
});

test("a card that keeps failing at HQ's gateway is said after a deploy's time, though HQ's state answers", async () => {
  const { db } = await import('./db.ts');
  const t = Date.now() + 60 * MIN;
  const id = Number(
    db
      .prepare(
        "insert into cases (app, kind, checked, words, summary, created) values ('shop', 'question', 'none', 'hi', 'hi', ?)",
      )
      .run(t).lastInsertRowid,
  );
  cardStatus = 504;
  for (let m = 0; m < 10; m++) assert.equal((await logged(t + m * MIN)).length, 0, `minute ${m}`);
  assert.equal((await logged(t + 10 * MIN)).length, 1, 'ten minutes of it');
  cardStatus = null;
  assert.equal((await logged(t + 11 * MIN)).length, 0);
  assert.ok((db.prepare('select sent_hq from cases where id = ?').get(id) as any).sent_hq, 'it went once HQ took it');
});

test('a second ask made while the first one is being sent stays for the next run', async () => {
  const { db } = await import('./db.ts');
  const t = Date.now() + 120 * MIN;
  const id = Number(
    db
      .prepare(
        "insert into cases (app, kind, checked, words, summary, created, sent_hq, hq_id, asked) values ('shop', 'person', 'none', 'hi', 'hi', ?, ?, 'x', ?)",
      )
      .run(t, t, t).lastInsertRowid,
  );
  const asked = () => (db.prepare('select asked from cases where id = ?').get(id) as any).asked;
  const mores: any[] = [];
  onCard = card => {
    if (card.kind !== 'more') return;
    mores.push(card);
    if (mores.length === 1) db.prepare('update cases set asked = ? where id = ?').run(t + 1, id);
  };
  try {
    await hq.sync(t + MIN);
    assert.equal(mores.length, 1, 'HQ heard the first ask');
    assert.equal(mores[0].person, true);
    assert.equal(asked(), t + 1, 'the second ask came during the send, so it is still unheard');
    await hq.sync(t + 2 * MIN);
    assert.equal(mores.length, 2, 'HQ hears the second ask on the next run');
    assert.equal(asked(), null, 'and then nothing is left to send');
  } finally {
    onCard = null;
  }
});

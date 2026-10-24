// node --test src/ownership.test.ts (local HQ, bare git remote and disposable CLI/check processes)
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import {
  alive,
  exitOf,
  follow,
  keepRecord,
  procStat,
  launch,
  records,
  type Checks,
  type Launched,
  type RunRecord,
} from './detached.ts';
import { gitFlow } from './git.ts';
import { ResponseError } from './reports.ts';
import { ownRun, ownershipSignal, requestSignal, waitOwned } from './ownership.ts';
import { seatPlaces } from './places.ts';
import { inChecks, runChecks } from './pushchecks.ts';

function checkout(t: TestContext) {
  const root = mkdtempSync(`${tmpdir()}/ownership-`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HOME: root,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.test',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.test',
  };
  const git = (...args: string[]) =>
    execFileSync('git', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const remote = `${root}/remote.git`,
    dir = `${root}/clone`,
    runs = `${root}/runs`;
  mkdirSync(runs);
  git('init', '-q', '--bare', '-b', 'main', remote);
  git('clone', '-q', remote, `${root}/seed`);
  writeFileSync(`${root}/seed/readme.md`, 'Seed\n');
  git('-C', `${root}/seed`, 'add', '.');
  git('-C', `${root}/seed`, 'commit', '-qm', 'Seed');
  git('-C', `${root}/seed`, 'push', '-q', 'origin', 'HEAD:main');
  const flow = gitFlow({ mirror: `${root}/mirror.git`, remote, base: 'main', clones: () => [dir] });
  flow.ensureMirror();
  flow.fetchMirror();
  const agent = flow.forAgent({ env });
  mkdirSync(dir);
  agent.clone(dir, 'job/7');
  writeFileSync(`${dir}/work.md`, 'Unpublished work\n');
  agent.ag(dir, 'add', '.');
  agent.ag(dir, 'commit', '-qm', 'Work');
  return { dir, runs, agent, git, remote, root };
}

async function coordinator(t: TestContext) {
  let status = 409;
  const finishes: string[] = [];
  const server = createServer((req, res) => {
    if (req.url === '/heartbeat') {
      res.writeHead(status);
      res.end('{}');
    } else {
      finishes.push(req.url!);
      res.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  return {
    finishes,
    status: (next: number) => {
      status = next;
    },
    async ask(path: string) {
      const response = await fetch(`${url}/${path}`, { method: 'POST', signal: requestSignal() });
      if (!response.ok) throw new ResponseError(path, response.status);
      return response.json();
    },
  };
}

function cli(t: TestContext, runs: string, name: string) {
  const { child, launched } = launch(
    runs,
    name,
    process.execPath,
    ['-e', 'process.stdout.write("Ready\\n"); setInterval(() => {}, 60000)'],
    { env: { PATH: process.env.PATH }, detached: true },
  );
  child.stdin!.end();
  t.after(() => {
    if (alive(launched.pid, launched.start)) process.kill(-launched.pid, 'SIGKILL');
  });
  return { child, launched, exited: exitOf(child) };
}

for (const phase of ['CLI', 'adopted checks', 'waiting checks']) {
  test(`a heartbeat refusal during ${phase} frees a capped seat for its next claim`, async t => {
    const { dir, runs, agent, git, remote } = checkout(t),
      hq = await coordinator(t);
    t.mock.timers.enable({ apis: ['setInterval'] });
    const seat = { id: 'codex-1', engine: 'codex' },
      places = seatPlaces({ codex: 2 });
    places.take(seat); // another run on the seat keeps its place
    const messages: string[] = [],
      launches: Launched[] = [],
      exits: Promise<number>[] = [];
    const ready = Promise.withResolvers<void>(),
      heartbeat = Promise.withResolvers<void>();
    const turn = Promise.withResolvers<void>();
    t.after(() => turn.resolve());
    let record: RunRecord | undefined;
    if (phase === 'adopted checks') {
      const check = cli(t, runs, '7.tests');
      launches.push(check.launched);
      exits.push(check.exited);
      record = {
        job: { id: 7 },
        seat: seat.id,
        slot: 'slot1',
        resumed: false,
        launched: check.launched,
        read: { out: 0, err: 0 },
        checks: {
          body: { status: 'done' },
          spent: {},
          runs: { tests: { launched: check.launched, began: Date.now(), stopped: [] } },
        },
      };
      keepRecord(runs, record);
      record = records(runs, () => {})[0];
    }
    const run = places.hold(
      seat,
      false,
      () => false,
      () =>
        ownRun(
          {
            job: 7,
            runs,
            heartbeat: async () => {
              try {
                return await hq.ask('heartbeat');
              } finally {
                heartbeat.resolve();
              }
            },
            answered: () => {},
            stop: () => {
              for (const launched of launches)
                if (alive(launched.pid, launched.start)) process.kill(-launched.pid, 'SIGKILL');
              inChecks.delete(7);
            },
            log: line => messages.push(line),
          },
          async () => {
            if (phase === 'CLI') {
              const running = cli(t, runs, '7');
              launches.push(running.launched);
              exits.push(running.exited);
              record = {
                job: { id: 7 },
                seat: seat.id,
                slot: 'slot1',
                resumed: false,
                launched: running.launched,
                read: { out: 0, err: 0 },
              };
              keepRecord(runs, record);
              ready.resolve();
              await follow(
                running.launched,
                { out: 0, err: 0 },
                () => !alive(running.launched.pid, running.launched.start),
                () => {},
                () => {},
              );
            } else {
              const checks: Checks = record?.checks ?? { body: { status: 'done' }, spent: {}, runs: {} };
              const pending = runChecks(
                7,
                checks,
                [
                  {
                    name: 'tests',
                    launch: () => {
                      const running = cli(t, runs, '7.tests');
                      launches.push(running.launched);
                      exits.push(running.exited);
                      return running.launched;
                    },
                    turn:
                      phase === 'waiting checks'
                        ? async run => {
                            ready.resolve();
                            await turn.promise;
                            return run();
                          }
                        : undefined,
                  },
                ],
                {
                  runs,
                  signal: ownershipSignal(),
                  keep: checks => {
                    if (record) keepRecord(runs, { ...record, checks });
                  },
                  watch: () => ready.resolve(),
                  unwatch: () => {},
                  said: () => {},
                },
              );
              await waitOwned(pending);
            }
            await agent.push(dir, 'job/7');
            await hq.ask('finish');
          },
        ),
    );
    await ready.promise;
    assert.equal(places.roomOn(seat), false);
    t.mock.timers.tick(60_000);
    await heartbeat.promise;
    await setImmediate();
    assert.equal(messages.length, 1);
    await Promise.all(exits);
    for (const launched of launches)
      assert.equal(alive(launched.pid, launched.start), false, 'the refused run was killed');
    await run;
    assert.equal(places.roomOn(seat), true);
    await places.hold(
      seat,
      false,
      () => false,
      () => hq.ask('claim'),
    );
    assert.deepEqual(hq.finishes, ['/claim'], 'the seat claims again without reporting the lost run');
    assert.deepEqual(
      records(runs, () => {}),
      [],
      'a reload has no refused run to adopt',
    );
    assert.equal(inChecks.has(7), false);
    assert.equal(messages.length, 1);
    assert.equal(git('--git-dir', remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/job/7'), '');
    turn.resolve();
    await setImmediate();
    assert.equal(places.roomOn(seat), true);
    assert.equal(launches.length, phase === 'waiting checks' ? 0 : 1, 'a refused waiter cannot launch later');
  });
}

test('transient heartbeat errors keep ownership', async t => {
  const { runs } = checkout(t),
    hq = await coordinator(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  hq.status(503);
  const beat = Promise.withResolvers<void>(),
    done = Promise.withResolvers<void>();
  const messages: string[] = [],
    replies: unknown[] = [];
  const run = ownRun(
    {
      job: 7,
      runs,
      heartbeat: async () => {
        try {
          return await hq.ask('heartbeat');
        } finally {
          beat.resolve();
        }
      },
      answered: reply => replies.push(reply),
      stop: () => assert.fail('a transient error must not stop the run'),
      log: line => messages.push(line),
    },
    async () => {
      await done.promise;
      return 'done';
    },
  );
  t.mock.timers.tick(60_000);
  await beat.promise;
  await setImmediate();
  assert.deepEqual(messages, []);
  done.resolve();
  assert.equal(await run, 'done');
  assert.deepEqual(replies, []);
});

test('heartbeat refusal ends an in-flight privileged push and its waiting HTTP transports before freeing the seat', async t => {
  const { dir, runs, agent, git, root } = checkout(t);
  const waiting = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const server = createServer(req => {
    req.socket.once('close', () => disconnected.resolve());
    waiting.resolve();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/remote.git`;
  git('--git-dir', `${root}/mirror.git`, 'config', 'remote.origin.url', url);
  const hq = await coordinator(t),
    seat = { id: 'codex-1', engine: 'codex' },
    places = seatPlaces({ codex: 1 });
  t.mock.timers.enable({ apis: ['setInterval'] });
  const run = places.hold(
    seat,
    false,
    () => false,
    () =>
      ownRun(
        {
          job: 7,
          runs,
          heartbeat: () => hq.ask('heartbeat'),
          answered: () => {},
          stop: () => {},
          log: () => {},
        },
        async () => {
          await agent.push(dir, 'job/7');
          await hq.ask('finish');
        },
      ),
  );
  await waiting.promise;
  const transports = readdirSync('/proc')
    .filter(n => /^\d+$/.test(n))
    .map(Number)
    .flatMap(pid => {
      const stat = procStat(pid);
      if (stat?.comm !== 'git-remote-http') return [];
      const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return command.includes(url) ? [{ pid, ...stat }] : [];
    });
  assert.equal(transports.length, 1, 'the real HTTP transport has entered its request');
  const transport = transports[0],
    helper = procStat(transport.ppid)!;
  const processes = [transport, { pid: transport.ppid, ...helper }, { pid: helper.ppid, ...procStat(helper.ppid)! }];
  t.after(() => {
    for (const p of processes) if (alive(p.pid, p.start)) process.kill(p.pid, 'SIGKILL');
  });
  assert.equal(
    processes.every(p => alive(p.pid, p.start)),
    true,
  );
  assert.equal(places.roomOn(seat), false);
  t.mock.timers.tick(60_000);
  await run;
  for (const p of processes) assert.equal(alive(p.pid, p.start), false, `${p.comm} ended before the seat was released`);
  await disconnected.promise;
  assert.equal(places.roomOn(seat), true);
  assert.deepEqual(hq.finishes, []);
});

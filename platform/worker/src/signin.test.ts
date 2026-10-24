// node --test src/signin.test.ts (disposable credentials and a real stopped CLI)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { CLIS } from './clis.ts';
import { ResponseError } from './reports.ts';
import { ownRun, ownershipSignal, requestSignal, waitOwned } from './ownership.ts';
import { runAs } from './git.ts';
import { returnSignIn } from './signin.ts';

for (const cli of ['codex', 'agy']) {
  for (const change of ['refresh', 'new seat sign-in', 'new account', 'seat removed']) {
    test(`a refused ${cli} run returns its ${change} credentials only when its baseline still matches`, async t => {
      const root = mkdtempSync(`${tmpdir()}/signin-`);
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const home = `${root}/home`,
        directory = `${root}/seat`,
        runs = `${root}/runs`;
      const relative = cli === 'codex' ? '.codex/auth.json' : CLIS[cli].credentials[0];
      const source = `${home}/${relative}`,
        target = cli === 'codex' ? `${directory}/auth.json` : `${directory}/${relative}`;
      for (const folder of [dirname(source), dirname(target), runs]) mkdirSync(folder, { recursive: true });
      const auth = (token: string, account = 'same') =>
        JSON.stringify(
          cli === 'codex'
            ? { tokens: { access_token: token, refresh_token: token, account_id: account }, last_refresh: token }
            : { access_token: token, refresh_token: account, expiry: token },
        );
      const before = auth('before'),
        mine = auth('rotated', change === 'new account' ? 'other' : 'same');
      const current = change === 'new seat sign-in' ? auth('new sign-in') : before;
      writeFileSync(target, current);
      const me = { env: { PATH: process.env.PATH! } },
        seat = { gone: change === 'seat removed', signIn: 'login' };
      const child = spawn(
        process.execPath,
        [
          '-e',
          'require("fs").writeFileSync(process.argv[1], process.argv[2]); process.stdout.write("Ready\\n"); setInterval(() => {}, 60000)',
          source,
          mine,
        ],
        { env: me.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const exited = once(child, 'exit');
      t.after(() => child.kill('SIGKILL'));
      await once(child.stdout!, 'data');
      t.mock.timers.enable({ apis: ['setInterval'] });
      let returned = false;
      const run = ownRun(
        {
          job: 7,
          runs,
          heartbeat: async () => {
            throw new ResponseError('heartbeat', 409);
          },
          answered: () => {},
          stop: () => {
            child.kill('SIGKILL');
          },
          log: () => {},
        },
        async () => {
          try {
            await waitOwned(exited);
          } finally {
            await exited;
            assert.equal(ownershipSignal()?.aborted, true);
            returnSignIn({ me, keeper: me, seat, home, directory, cli, from: before, files: { [relative]: before } });
            assert.throws(() => runAs(me, 'touch', [`${root}/cancelled-command`]));
            assert.throws(() => requestSignal());
            returned = true;
          }
        },
      );
      t.mock.timers.tick(60_000);
      await setImmediate();
      await run;
      assert.equal(returned, true);
      assert.equal(readFileSync(target, 'utf8'), change === 'refresh' ? mine : current);
      assert.equal(existsSync(`${root}/cancelled-command`), false);
    });
  }
}

// node --test src/nozone.test.ts: a company without a domain (HQ at <ip-with-dashes>.sslip.io) has no zone, since that
// zone is everyone's: HQ's cookies stay on its own host, with no Domain, the board's device mark isn't set at all, and an
// approval card says the site goes up once there is a domain (infra/products.py serves no product there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { harness } from './harness.ts';

const h = await harness('nozone', { env: { PUBLIC_HOST: '203-0-113-7.sslip.io' } });

test("a host named for the server's IP has no zone; a domain's host has its domain", () => {
  const zoneAt = (host: string) =>
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { ZONE } = await import(${JSON.stringify(new URL('./config.ts', import.meta.url).href)}); process.stdout.write(ZONE)`,
      ],
      { env: { ...process.env, PUBLIC_HOST: host, DATA_DIR: h.dataDir }, encoding: 'utf8' },
    );
  for (const host of [
    '203-0-113-7.sslip.io',
    '203.0.113.7.nip.io',
    'hq.203-0-113-7.sslip.io',
    'localhost',
    '203.0.113.7',
  ])
    assert.equal(zoneAt(host), '', host);
  assert.equal(zoneAt('hq.company.test'), 'company.test');
  assert.equal(zoneAt('hq.example2.test'), 'example2.test');
});

test("a signed-in device that lacks the mark gets none: no cookie for the shared zone (owndevice.test's sets it)", async () => {
  const res = await fetch(`${h.base}/`, { redirect: 'manual', headers: { cookie: h.boardCookie } });
  await res.body?.cancel();
  const set = res.headers.getSetCookie();
  assert.deepEqual(
    set.filter(c => /;\s*Domain=/i.test(c) || c.startsWith('hq-own-device=')),
    [],
  );
});

test('an approval card promises no address: the site goes up once the company has a domain', async () => {
  const job = await h.start({ agent: 'bolt' });
  const shown = async (id: number) => (await h.board('/api/requests')).body.find((c: any) => c.id === id).grants;
  for (const grant of ['site:plum', 'live:plum', 'live:front']) {
    const card = await shown(await h.ask(job, { kind: 'approval', approves: grant }));
    assert.match(card, /public once the company has a domain \(it has none yet\)/, grant);
    assert.doesNotMatch(card, /localhost|sslip|www\./, grant);
  }
  await h.finish(job);
});

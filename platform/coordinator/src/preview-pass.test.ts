// node --test src/preview-pass.test.ts   (an agent job's pass to one product's preview: hq preview; the harness's
// server).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { harness, type Running } from './harness.ts';

const h = await harness('preview-pass', {
  env: { PUBLIC_HOST: 'hq.company.test' },
  before: repo => {
    mkdirSync(`${repo}/products/other`, { recursive: true });
    writeFileSync(`${repo}/products/other/product.yaml`, 'name: Other\n');
  },
});
const { jobLog } = await import('./log.ts');

const HQ = 'hq.company.test',
  HELLO = 'hello.preview.company.test',
  OTHER = 'other.preview.company.test';

// A page on a host, as a browser asks for it (its cookie; a JSON body from the page's own origin)
const on = (host: string, path: string, cookie = '', body?: unknown) =>
  h.send(
    path,
    {
      host,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { origin: `https://${host}`, 'content-type': 'application/json' }),
    },
    body,
  );
// Caddy's forward_auth for a page of a preview host (query: ?board=1 on the chat's route)
const check = (cookie: string, host: string, uri = '/', query = '') =>
  h
    .send(`/api/preview/check${query}`, { host: HQ, cookie, 'x-forwarded-host': host, 'x-forwarded-uri': uri })
    .then(r => r.status);
// hq preview's ask, from a run of a job
const ask = (run: Running, slug: string) => h.agent('preview-passes', run.token, { slug });
const passOf = async (run: Running) => ((await ask(run, 'hello')).body as { cookie: string }).cookie;

test("a pass opens its own preview host, view-only: never the chat's route, review mode, a hand-off, another host or HQ", async () => {
  const run = await h.start({ agent: 'wren', title: 'Check the preview' });
  assert.equal((await ask(run, 'nothing-here')).status, 404);
  assert.equal((await ask(run, 'cycles')).status, 404, 'a product, not the cycles host');
  assert.equal((await ask(run, '../hello')).status, 404);
  const given = await ask(run, 'hello');
  assert.equal(given.status, 200, JSON.stringify(given.body));
  const pass = given.body;
  assert.equal(pass.url, `https://${HELLO}/`);
  assert.match(pass.cookie, /^pp=[\w-]{43}$/);
  assert.ok(Date.parse(pass.expires) - Date.now() <= 3600e3 && Date.parse(pass.expires) > Date.now() + 3500e3);

  assert.equal(await check(pass.cookie, HELLO), 200);
  assert.equal(await check(`t=1; ${pass.cookie}`, HELLO, '/play/?seed=4'), 200);
  assert.equal(await check(pass.cookie, HELLO, '/__care/chat', '?board=1'), 403, "never the chat's route");
  assert.equal(await check(pass.cookie, OTHER), 302, 'another product');
  assert.equal(await check(pass.cookie, 'cycles.preview.company.test'), 302);
  assert.equal(await check('pp=not-a-pass', HELLO), 302);
  assert.equal(await check('', HELLO), 302);
  // no review mode: only the watch-along's answer to HQ's frame, and no notes
  const framed = readFileSync(new URL('../../../shared/watchalong/framed.js', import.meta.url), 'utf8');
  assert.equal(
    (await on(HELLO, '/__review/review.js', pass.cookie)).text,
    `/* review mode: off */\n${framed.replace('{{HQ_ORIGIN}}', `https://${HQ}`)}`,
  );
  const note = await on(HELLO, '/__review/notes', pass.cookie, {
    note: 'x',
    page: `https://${HELLO}/`,
    element: { el: { tag: 'p' }, kind: 'pin' },
  });
  assert.equal(note.status, 403);
  // no link for another device
  assert.equal((await on(HELLO, '/__preview/handoff', pass.cookie, { to: '/' })).status, 403);
  // never HQ
  assert.equal((await on(HQ, '/api/jobs', pass.cookie)).status, 401);
  // HQ keeps it, never the secret itself, and the job's log says who had one, for which host and until when
  const kept = h.db.prepare('select * from preview_passes where job = ?').all(run.id) as any[];
  assert.deepEqual(
    kept.map(p => [p.agent, p.host]),
    [['wren', HELLO]],
  );
  assert.ok(!JSON.stringify(kept).includes(pass.cookie.slice(3)));
  assert.ok(
    jobLog(run.id).some(l => l.agent === 'wren' && l.text.includes(`Preview pass: view-only on ${HELLO} until`)),
  );
  assert.ok(!JSON.stringify(jobLog(run.id)).includes(pass.cookie.slice(3)));
  await h.finish(run);
});

test("a pass stops at its run's end, stays stopped when the job runs again, and at its hour", async () => {
  const first = await h.start({ agent: 'wren', title: 'Check the preview', engine: 'pass-runs' });
  const pass = await passOf(first);
  const later = await passOf(first);
  assert.equal(await check(pass, HELLO), 200);
  assert.equal((await h.finish(first, { status: 'interrupted' })).status, 200);
  assert.equal(await check(pass, HELLO), 302, 'the run ended');
  const again = (await h.claim('pass-runs'))!;
  assert.equal(again.id, first.id, 'the same job runs again');
  assert.equal(await check(pass, HELLO), 302, "a new run of the same job doesn't bring it back");
  assert.equal((await ask(first, 'hello')).status, 401, "the ended run's token gives none");
  const fresh = await passOf(again);
  assert.equal(await check(fresh, HELLO), 200);
  h.db
    .prepare(
      'update preview_passes set expires = ? where hash = (select hash from preview_passes order by rowid desc limit 1)',
    )
    .run(Date.now() - 1);
  assert.equal(await check(fresh, HELLO), 302, 'its hour is up');
  assert.equal(await check(later, HELLO), 302);
  await h.finish(again);
  assert.equal((await ask(again, 'hello')).status, 401, 'a job that ended gives none');
});

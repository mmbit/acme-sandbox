// node --test src/earlier.test.ts   (an earlier version of a cycles page beside staging in HQ's viewer: its cycle
// folder's commits from git, at earlier-<n>.preview.<zone>, behind the board's preview login.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { harness } from './harness.ts';

const { commitFile } = await import('./fixture.ts');
const PITCHES = 'products/_cycles/2026-01-01';
const FILM = Buffer.from('an earlier film');
const DRAFTS = 11;
const work = mkdtempSync(`${tmpdir()}/work-`);
mkdirSync(`${work}/renders`);
writeFileSync(`${work}/renders/${'a'.repeat(64)}`, FILM);
// (a cycle whose deck changed three times, with a film rendered once and a logo drawn beside it; a cycle changed once;
// and a cycle whose page sits at its root, drafted more times than the viewer lists)
const h = await harness('earlier', {
  env: { PUBLIC_HOST: 'hq.company.test', WORK_MIRROR_DIR: `${work}/mirror.git` },
  before: repo => {
    const at = Math.floor(Date.UTC(2026, 0, 1) / 1000);
    const deck = `${PITCHES}/presentation`;
    commitFile(`${deck}/index.html`, '<p>First</p>\n', 'A deck', { repo, at });
    commitFile(`${deck}/film.mp4.render.json`, `{"sha256":"${'a'.repeat(64)}"}\n`, 'Its film', { repo, at: at + 60 });
    commitFile(`${deck}/index.html`, '<p>Second</p><script src="/__review/review.js"></script>\n', 'Shorter', {
      repo,
      at: at + 120,
    });
    commitFile('products/_cycles/2026-01-02/plan/index.html', '<p>A plan</p>\n', 'A plan', { repo, at: at + 180 });
    commitFile(`${PITCHES}/concepts/logo.svg`, '<svg></svg>\n', 'A logo', { repo, at: at + 240 });
    commitFile(`${deck}/index.html`, '<p>Third</p>\n', 'Warmer', { repo, at: at + 300 });
    for (let n = 1; n <= DRAFTS; n++)
      commitFile('products/_cycles/2026-01-03/index.html', `<p>Draft ${n}</p>\n`, `Draft ${n}`, {
        repo,
        at: at + 360 + n * 60,
      });
  },
});
const { listEarlierVersions } = await import('./earlier.ts');

// The board's preview key, as HQ's viewer gets it: a link from HQ, opened on an earlier host
const signIn = await h.board('/api/preview/link', { url: 'https://earlier-1.preview.company.test/2026-01-01/' });
const accepted = await h.send(new URL(signIn.body.url).pathname + new URL(signIn.body.url).search, {
  host: 'earlier-1.preview.company.test',
});
const BOARD = /pv=[^;]+/.exec(String(accepted.headers['set-cookie']))![0];
const on = (back: number, path: string, more: Record<string, string> = { cookie: BOARD }) =>
  h.send(path, { host: `earlier-${back}.preview.company.test`, ...more });

test("a cycles page's earlier versions are its cycle folder's changes before staging's, newest first", async () => {
  const deck = 'https://cycles.preview.company.test/2026-01-01/presentation/';
  const back = (n: number, minutes: number) => ({
    back: n,
    at: new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString(),
    open: `https://earlier-${n}.preview.company.test/2026-01-01/presentation/#5`,
  });
  assert.deepEqual(await listEarlierVersions(`${deck}#5`), {
    versions: [back(1, 4), back(2, 2), back(3, 1), back(4, 0)],
    unlisted: 0,
  });
  // one change: staging alone; and no other host's page has any
  assert.deepEqual(await listEarlierVersions('https://cycles.preview.company.test/2026-01-02/plan/'), {
    versions: [],
    unlisted: 0,
  });
  assert.deepEqual(await listEarlierVersions('https://shop.preview.company.test/2026-01-01/presentation/'), {
    versions: [],
    unlisted: 0,
  });
});

test("a page at its cycle's root has earlier versions too, and says how many more it has than are listed", async () => {
  const { versions, unlisted } = await listEarlierVersions('https://cycles.preview.company.test/2026-01-03/');
  assert.equal(versions.length + unlisted, DRAFTS - 1);
  assert.ok(unlisted > 0);
  assert.equal(versions[0].open, 'https://earlier-1.preview.company.test/2026-01-03/');
  assert.equal(
    (await on(1, '/2026-01-03/')).text,
    `<p>Draft ${DRAFTS - 1}</p>\n\n<script src="/__review/review.js" defer></script>\n`,
  );
  assert.equal(
    (await on(versions.length, '/2026-01-03/')).text.split('\n')[0],
    `<p>Draft ${DRAFTS - versions.length}</p>`,
  );
});

test('an earlier host serves the page as it was, with the scroll link, the board only', async () => {
  const two = await on(2, '/2026-01-01/presentation/');
  assert.equal(two.status, 200);
  assert.equal(two.text, '<p>Second</p><script src="/__review/review.js"></script>\n');
  assert.match(two.headers['content-security-policy'], /frame-ancestors 'self' https:\/\/hq\.company\.test/);
  const four = await on(4, '/2026-01-01/presentation/');
  assert.equal(four.text, '<p>First</p>\n\n<script src="/__review/review.js" defer></script>\n');
  // its review mode is the scroll link alone
  const link = await on(1, '/__review/review.js');
  assert.equal(link.status, 200);
  assert.match(link.text, /scrollTo/);
  assert.equal((await on(1, '/2026-01-01/presentation/', {})).status, 403);
  assert.equal((await on(1, '/2026-01-02/plan/')).status, 404);
  // Caddy's ask before a certificate: the earlier hosts, and no more
  const ask = (domain: string) => h.send(`/api/preview/try-host?domain=${domain}`).then(r => r.status);
  assert.equal(await ask('earlier-1.preview.company.test'), 200);
  assert.equal(await ask('earlier-99.preview.company.test'), 404);
});

test("what a page takes from beside it comes from the page's own point in time", async () => {
  // the page one change back is Second, with the logo drawn; two back, the logo wasn't there yet
  assert.equal(
    (await on(1, '/2026-01-01/presentation/')).text.split('\n')[0],
    '<p>Second</p><script src="/__review/review.js"></script>',
  );
  assert.equal((await on(1, '/2026-01-01/concepts/logo.svg')).status, 200);
  assert.equal((await on(2, '/2026-01-01/concepts/logo.svg')).status, 404);
});

test("a render comes from the worker's store by the sha256 it had then, in ranges", async () => {
  const film = await on(1, '/2026-01-01/presentation/film.mp4', { cookie: BOARD, range: 'bytes=3-' });
  assert.equal(film.status, 206);
  assert.equal(film.headers['content-range'], `bytes 3-${FILM.length - 1}/${FILM.length}`);
  assert.equal(film.text, FILM.subarray(3).toString());
  assert.equal(
    (await on(1, '/2026-01-01/presentation/film.mp4', { cookie: BOARD, range: 'bytes=-' })).text,
    FILM.toString(),
  );
  assert.equal((await on(4, '/2026-01-01/presentation/film.mp4')).status, 404);
});

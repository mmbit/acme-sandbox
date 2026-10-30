// node --test src/ink/trypreview.test.ts   (a try's version on staging: its branch's files at try-<slip>.preview.<zone>,
// HQ's screens in dev mode and the decks, behind the board's preview login, gone once it's cleared.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { harness } from '../harness.ts';
import type { Version } from './trybranch.ts';

const { commitFile } = await import('../fixture.ts');
// (the test company's checkout: HQ's page, a deck, and a product with a server of its own)
const h = await harness('trypreview', {
  env: { PUBLIC_HOST: 'hq.company.test' },
  before: repo => {
    commitFile('theme/hq/index.html', '<p>HQ as it is</p>\n', 'HQ', { repo });
    commitFile('products/_cycles/2026-01-01/presentation/index.html', '<p>The deck</p>\n', 'A deck', { repo });
    commitFile('products/shop/product.yaml', 'name: Shop\n', 'A product', { repo });
  },
});
const { db } = h;
const { DIR } = await import('../pagescraps.ts');
const { branchVersion, dropBranch, overMain } = await import('./trybranch.ts');
const KEY = 'board-preview-key';
db.prepare('insert into preview_keys (key, expires) values (?, ?)').run(KEY, Date.now() + 864e5);

const change = (path: string, was: string, now: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${was}\n+${now}\n`;
// A version clipped with its patch, its branch made
async function version(patch: string) {
  mkdirSync(DIR, { recursive: true });
  const file = `patch-test-${Math.random().toString(36).slice(2)}.diff`;
  writeFileSync(`${DIR}/${file}`, patch);
  const id = Number(
    db
      .prepare(
        "insert into book_slips (by, text, created, style, version, patch) values ('lyra', 'warmer', ?, 'version', 'Warm sand', ?)",
      )
      .run(new Date().toISOString(), file).lastInsertRowid,
  );
  await branchVersion(id, overMain(patch) as Version);
  return db.prepare('select * from book_slips where id = ?').get(id) as any;
}
const on = (id: number, path: string, cookie = `pv=${KEY}`) =>
  h.send(path, { host: `try-${id}.preview.company.test`, ...(cookie ? { cookie } : {}) });

test("an HQ version: its own host serves HQ with the version's change, the board's only", async () => {
  const v = await version(change('theme/hq/index.html', '<p>HQ as it is</p>', '<p>HQ, warmer</p>'));
  assert.equal(v.branch, `try/v${v.id}`);
  assert.equal(v.link, `https://try-${v.id}.preview.company.test/`);
  const page = await on(v.id, '/');
  assert.equal(page.status, 200);
  assert.equal(page.text, '<p>HQ, warmer</p>\n');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'self' https:\/\/hq\.company\.test/);
  // no API of HQ's there: dev mode, on its mock data
  assert.equal((await on(v.id, '/api/me')).status, 404);
  assert.equal((await on(v.id, '/', '')).status, 403);
  // Caddy's ask before a certificate: this version's host, and no other
  const ask = (domain: string) => h.send(`/api/preview/try-host?domain=${domain}`).then(r => r.status);
  assert.equal(await ask(`try-${v.id}.preview.company.test`), 200);
  assert.equal(await ask(`try-${v.id + 100}.preview.company.test`), 404);
  assert.equal(await ask('shop.preview.company.test'), 404);
  // cleared: its preview goes with its branch
  db.prepare('update book_slips set cleared = ? where id = ?').run(new Date().toISOString(), v.id);
  await dropBranch(v);
  const gone = db.prepare('select link, branch from book_slips where id = ?').get(v.id) as any;
  assert.deepEqual([gone.link, gone.branch], [null, null]);
  assert.equal((await on(v.id, '/')).status, 404);
  assert.equal(await ask(`try-${v.id}.preview.company.test`), 404);
});

test("a deck's version opens on its deck; a product with a server of its own gets none", async () => {
  const deck = 'products/_cycles/2026-01-01/presentation/index.html';
  const d = await version(change(deck, '<p>The deck</p>', '<p>The deck, shorter</p>'));
  assert.equal(d.link, `https://try-${d.id}.preview.company.test/products/_cycles/2026-01-01/presentation/`);
  assert.equal((await on(d.id, '/products/_cycles/2026-01-01/presentation/')).text, '<p>The deck, shorter</p>\n');
  const p = await version(change('products/shop/product.yaml', 'name: Shop', 'name: The shop'));
  assert.deepEqual([p.branch, p.link], [`try/v${p.id}`, null]);
});

test("a version's service worker never registers on its host, and its other scripts are served", async () => {
  const sw = 'theme/hq/sw.js';
  const v = await version(
    `diff --git a/${sw} b/${sw}\nnew file mode 100644\n--- /dev/null\n+++ b/${sw}\n@@ -0,0 +1 @@\n+self.onfetch = () => {};\n`,
  );
  const script = await on(v.id, '/sw.js');
  assert.deepEqual([script.status, script.text], [200, 'self.onfetch = () => {};\n']);
  const worker = await h.send('/sw.js', {
    host: `try-${v.id}.preview.company.test`,
    cookie: `pv=${KEY}`,
    'service-worker': 'script',
  });
  assert.equal(worker.status, 403);
});

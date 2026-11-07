// node --test platform/hq/serve.test.mjs   (HQ's dev server, on its own files)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mocks, serve, servedFiles } from './serve.mjs';

// the status of a GET for this address, sent as it is. A handler that throws never answers, so its error ends the wait.
const status = (port, path) => {
  let thrown;
  return new Promise((resolve, reject) => {
    process.once('unhandledRejection', (thrown = reject));
    request({ host: '127.0.0.1', port, path }, res => resolve(res.resume().statusCode))
      .on('error', reject)
      .end();
  }).finally(() => process.off('unhandledRejection', thrown));
};

test("an address that doesn't parse gets a 400, and the server goes on serving", async () => {
  const server = await serve(async p => Buffer.from(p), 0, { 'index.html': 'home' });
  const { port } = server.address();
  try {
    for (const path of ['/a%', '/%zz', '//']) assert.equal(await status(port, path), 400, path);
    assert.equal(await status(port, '/'), 200);
  } finally {
    server.close();
    server.closeAllConnections(); // (a request a broken handler left open)
  }
});

test('an address answers from the files a built mock answer is made of, else the one it reads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'serve-'));
  const write = (path, text) => {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write('theme/hq/mock/brand.json', '{"theme":{}}');
  write('theme/hq.yaml', 'font: Bricolage\n');
  write('theme/hq/mock/jobs.json', '[]');
  write('platform/hq/mock/jobs.json', '[{"id":1}]');
  write('platform/hq/style.css', 'p {}');
  try {
    const { sources } = await mocks(root),
      served = path => servedFiles(`http://127.0.0.1/${path}`, sources, root);
    assert.deepEqual(served('mock/brand.json'), ['theme/hq/mock/brand.json', 'theme/hq.yaml']);
    assert.deepEqual(served('mock/jobs.json'), ['theme/hq/mock/jobs.json', 'platform/hq/mock/jobs.json']);
    assert.deepEqual(served('style.css'), ['platform/hq/style.css']);
    assert.deepEqual(served('no/such.css'), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

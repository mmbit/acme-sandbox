// node --test platform/hq/serve.test.mjs   (HQ's dev server, on its own files)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { serve } from './serve.mjs';

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

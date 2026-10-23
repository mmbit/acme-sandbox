// node --test src/pulls.test.ts   (GitHub played by a stand-in for fetch): a pushed branch's pull request, opened, found
// open, refused or out of reach.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { openPullRequest } from './pulls.ts';

const gh = { repo: 'company/hq', token: 'test-token', base: 'main' };
const pull = { title: 'Thread levels', body: 'Done when: it works' };
const quiet = () => {};
const real = globalThis.fetch;
afterEach(() => (globalThis.fetch = real));
// GitHub answering the creation and the lookup of open pull requests (undefined: not reached)
const github = (create?: [number, unknown], open?: [number, unknown]) => {
  globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
    const answer = init.method === 'POST' ? create : open;
    if (!answer) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(answer[1]), { status: answer[0] });
  }) as typeof fetch;
};

test('a refused creation with no open pull request comes back as the refusal, with its status and message', async () => {
  github([403, { message: 'You have exceeded a secondary rate limit' }], [200, []]);
  const opened = await openPullRequest(gh, 'job/1', pull, quiet);
  assert.equal(typeof opened, 'object', 'never a pull request it has not got');
  assert.match((opened as { refused: string }).refused, /^HTTP 403: .*secondary rate limit/);
  github([422, { message: 'Validation Failed' }], [404, { message: 'Not Found' }]);
  assert.match(((await openPullRequest(gh, 'job/1', pull, quiet)) as { refused: string }).refused, /^HTTP 422: /);
});

test('an open one is found after a refusal, and GitHub out of reach or failing on its side is unreached', async () => {
  github([201, { number: 41 }]);
  assert.equal(await openPullRequest(gh, 'job/1', pull, quiet), 41);
  github([422, { message: 'A pull request already exists' }], [200, [{ number: 42 }]]);
  assert.equal(await openPullRequest(gh, 'job/1', pull, quiet), 42);
  github([502, {}], [200, []]);
  assert.equal(await openPullRequest(gh, 'job/1', pull, quiet), 'unreached');
  github(undefined, [200, []]);
  assert.equal(await openPullRequest(gh, 'job/1', pull, quiet), 'unreached');
  github([403, {}]);
  assert.equal(await openPullRequest(gh, 'job/1', pull, quiet), 'unreached');
});

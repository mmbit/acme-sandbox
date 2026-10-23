// node --test shared/namecheck/tmview.test.mjs   (a local server plays TMview's API; no browser, no network)
// (formatted)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { search, detail, MAX_PAGES } from './tmview.mjs';

// What the server answers next: by page number for searches, or one answer for a detail.
let answers = {};
let calls = 0;
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  calls++;
  const answer = request.url.startsWith('/api/search/') ? answers[JSON.parse(body).page] : answers.detail;
  response.writeHead(answer.status ?? 200, { 'Content-Type': answer.html ? 'text/html' : 'application/json' });
  response.end(answer.html ?? JSON.stringify(answer.json));
});
server.listen(0);
await once(server, 'listening');
after(() => server.close());

const base = `http://localhost:${server.address().port}`;
async function askServer(path, body) {
  const response = await fetch(`${base}${path}`, body ? { method: 'POST', body: JSON.stringify(body) } : {});
  return { status: response.status, text: await response.text() };
}

function serve(pages) {
  answers = pages;
  calls = 0;
}
const options = { name: 'florin', offices: 'EM,BX,GB,WO', classes: '9,41,42', allClasses: false };
const mark = (n, niceClass = [9]) => ({ ST13: `EM5000000${String(n).padStart(8, '0')}`, tmName: 'FLORYN', niceClass });
const page = (marks, totalPages) => ({ json: { tradeMarks: marks, totalPages } });
const fullPage = first => Array.from({ length: 100 }, (_, i) => mark(first + i));

// A refusal says why and carries nothing that could be counted.
function assertRefused(lookupOutcome) {
  assert.equal(typeof lookupOutcome.error, 'string');
  assert.equal(lookupOutcome.marks, undefined);
  assert.equal(lookupOutcome.detail, undefined);
}

test('an empty search is a real result with no marks', async () => {
  serve({ 1: page([], 0) });
  assert.deepEqual(await search(askServer, options), { marks: [] });
});

test('marks from every page are kept, filtered to the classes asked for', async () => {
  serve({ 1: page(fullPage(0), 2), 2: page([mark(100), mark(101, [11])], 2) });
  const searchOutcome = await search(askServer, options);
  assert.equal(searchOutcome.marks.length, 101);
  assert.equal(calls, 2);
});

test('classes sent as text are read as numbers', async () => {
  serve({ 1: page([mark(1, ['9']), mark(2, ['09', '42']), mark(3, ['11'])], 1) });
  const searchOutcome = await search(askServer, options);
  assert.deepEqual(
    searchOutcome.marks.map(found => found.niceClass),
    [[9], [9, 42]],
  );
});

test('a mark without readable classes refuses a search by class, and shows up with --all-classes', async () => {
  const unclassified = { ST13: mark(2).ST13, tmName: 'FLORYN' };
  serve({ 1: page([mark(1), unclassified], 1) });
  assertRefused(await search(askServer, options));
  for (const unreadable of [null, [], ['nine'], [9.5], '9']) {
    serve({ 1: page([mark(1), mark(2, unreadable)], 1) });
    assertRefused(await search(askServer, options));
  }
  serve({ 1: page([mark(1), unclassified], 1) });
  const searchOutcome = await search(askServer, { ...options, allClasses: true });
  assert.deepEqual(
    searchOutcome.marks.map(found => found.niceClass),
    [[9], null],
  );
});

test('an HTTP error with a JSON body is a failed search, not zero marks', async () => {
  serve({ 1: { status: 503, json: { message: 'Service unavailable' } } });
  assertRefused(await search(askServer, options));
});

test('a 200 without marks or a page count is a failed search', async () => {
  serve({ 1: { json: {} } });
  assertRefused(await search(askServer, options));
  serve({ 1: { json: { tradeMarks: [] } } });
  assertRefused(await search(askServer, options));
});

test('a later page that fails throws away the pages before it', async () => {
  serve({ 1: page(fullPage(0), 2), 2: { status: 503, json: {} } });
  assertRefused(await search(askServer, options));
  assert.equal(calls, 2);
});

test('a later page that comes back empty or with a different page count is an incomplete search', async () => {
  serve({ 1: page(fullPage(0), 2), 2: page([], 2) });
  assertRefused(await search(askServer, options));
  serve({ 1: page(fullPage(0), 2), 2: page([mark(100)], 3) });
  assertRefused(await search(askServer, options));
});

test('a page that comes back twice is an incomplete search, not twice the marks', async () => {
  serve({ 1: page(fullPage(0), 2), 2: page(fullPage(0), 2) });
  assertRefused(await search(askServer, options));
  assert.equal(calls, 2);
});

test('a short page before the last is an incomplete search', async () => {
  serve({ 1: page([mark(1)], 2), 2: page([mark(2)], 2) });
  assertRefused(await search(askServer, options));
});

test('a search over the page budget stops after the first page', async () => {
  serve({ 1: page(fullPage(0), MAX_PAGES + 1) });
  assertRefused(await search(askServer, options));
  assert.equal(calls, 1);
});

test("the firewall's HTML page is a refusal", async () => {
  serve({ 1: { html: '<!DOCTYPE html><html><head><APM_DO_NOT_TOUCH></head></html>' } });
  assertRefused(await search(askServer, options));
});

test('a detail with its mark, goods and owners comes back whole', async () => {
  const goods = [{ niceClass: 9, goodsAndServices: 'Software' }];
  const json = {
    tradeMark: { applicationNumber: '012345678', goodAndServices: goods },
    applicants: [{ organizationName: 'Example Industries Ltd' }],
  };
  serve({ detail: { json } });
  assert.deepEqual(await detail(askServer, 'EM500000012345678'), { detail: json });
});

test('a failed or malformed detail is a refusal', async () => {
  serve({ detail: { status: 404, json: { message: 'not found' } } });
  assertRefused(await detail(askServer, 'EM500000012345678'));
  serve({ detail: { json: {} } });
  assertRefused(await detail(askServer, 'EM500000012345678'));
  serve({ detail: { json: { tradeMark: { applicationNumber: '012345678' }, applicants: [] } } });
  assertRefused(await detail(askServer, 'EM500000012345678'));
});

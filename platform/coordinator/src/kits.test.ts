// node --test src/kits.test.ts   (a made-up company's kit in the test company, HQ's real server)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { harness } from './harness.ts';

const KITS = mkdtempSync(`${tmpdir()}/kits-test-`);
// Pinwheel's own part: a route for its spinner (its own token), one for the board, an agent's route and its numbers
const kit = (name: string, code: string) => { mkdirSync(`${KITS}/${name}`, { recursive: true }); writeFileSync(`${KITS}/${name}/coordinator.ts`, code); };
kit('pinwheel', `
const reply = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
export const service = {
  'POST /api/pinwheel/spin': (req, res) => reply(res, req.headers.authorization === 'Bearer spinner' ? 200 : 401, { spun: true }),
  '/api/pinwheel/blade/*': (req, res, path) => reply(res, 200, { blade: path }),
};
export const board = { '/api/pinwheel/*': (req, res, path) => reply(res, 200, { board: path }) };
export const agent = {
  'GET /api/agent/pinwheel': b => b.n === 'none' ? [409, 'no wind today: try again tomorrow'] : { spins: Number(b.n) },
};
export const numbers = app => app.slug === 'pinwheel' ? { wind: 3, lines: ['', 'Wind: 3'] } : null;
export const dashboard = r => [
  { id: 'wind', name: 'Wind across the shop', tile: \`\${r.days} days: 3 gusts\`, figures: [{ label: 'Gusts', value: 3, sub: 'calm since' }],
    daily: { columns: [{ key: 'gusts', label: 'Gusts' }], rows: [{ day: '2026-10-01', gusts: 3 }, { day: '2026-10-02', gusts: 0 }] },
    targets: [{ label: 'Gusts a month', goal: 5, lower: true, value: 3, mark: 'green' }] },
  { id: 'Not An Id', name: 'refused' }, { id: 'wind', name: 'a second wind, refused' },
];
export let started = 0;
export const start = () => { started++; };
`);
kit('_draft', 'throw new Error("a folder starting with _ is no kit");');   // (were it loaded, the server wouldn't start)

const h = await harness('kits', { env: { KITS_DIR: KITS }, before: repo => {
  for (const slug of ['pinwheel', 'hello']) {
    mkdirSync(`${repo}/products/${slug}/app`, { recursive: true });
    writeFileSync(`${repo}/products/${slug}/product.yaml`, `name: ${slug}\nstatus: preview\nowner: wren\n`);
    writeFileSync(`${repo}/products/${slug}/app/metrics.json`, '{ "steps": [{ "id": "page" }] }');
  }
} });
const kits = await import('./kits.ts');
const HQ = h.base, board = { headers: { cookie: h.boardCookie } };
const wren = await h.start({ agent: 'wren' });
const agent = (path: string) => fetch(`${HQ}/api/agent/${path}`, { headers: { authorization: `Bearer ${wren.token}` } });

test("a kit's service routes come without the board's session, by path, prefix and method; its board routes only with it", async () => {
  assert.equal((await fetch(`${HQ}/api/pinwheel/spin`, { method: 'POST', headers: { authorization: 'Bearer spinner' } })).status, 200);
  assert.equal((await fetch(`${HQ}/api/pinwheel/spin`, { method: 'POST' })).status, 401, 'the route checks its own token');
  assert.deepEqual(await (await fetch(`${HQ}/api/pinwheel/blade/3`)).json(), { blade: '/api/pinwheel/blade/3' });
  assert.equal((await fetch(`${HQ}/api/pinwheel/spin`)).status, 401, 'a GET is not the POST route: it is the board\'s, and needs its login');
  const theirs = await fetch(`${HQ}/api/pinwheel/spin`, board);
  assert.deepEqual([theirs.status, await theirs.json()], [200, { board: '/api/pinwheel/spin' }]);
});

test("a kit's agent route answers a job like the platform's, a refusal in its words", async () => {
  const ask = (n: string) => agent(`pinwheel?n=${n}`);
  assert.deepEqual(await (await ask('4')).json(), { spins: 4 });
  const no = await ask('none');
  assert.deepEqual([no.status, await no.json()], [409, { error: 'no wind today: try again tomorrow' }]);
});

test("one app's numbers carry what a kit adds; its lines are for hq numbers", async () => {
  const numbers = async (slug: string) => (await agent(`numbers?app=${slug}&days=7`)).json();
  assert.deepEqual((await numbers('pinwheel')).lines, ['', 'Wind: 3']);
  assert.equal((await numbers('pinwheel')).wind, 3);
  assert.equal((await numbers('hello')).wind, undefined);
});

test("the Numbers home carries a kit's own dashboards, each a tile, for HQ's Numbers and hq numbers", async () => {
  const home = await (await fetch(`${HQ}/api/numbers?days=7`, board)).json();
  assert.deepEqual(home.dashboards.map((d: any) => [d.id, d.tile]), [['wind', '7 days: 3 gusts']], "one per id, and only a plain id, for the days the board's switch asks");
  assert.equal((await fetch(`${HQ}/api/numbers?days=0`, board)).status, 400);
  assert.equal((await (await agent('numbers')).json()).dashboards[0].name, 'Wind across the shop', "the agents' route");
  const printed = (await h.hq(wren, 'numbers')).out;
  assert.match(printed, /\n\nWind across the shop \(wind\)\n {2}Gusts: 3 \(calm since\)\n {2}Per day \(newest first, days with something\):\n {4}2026-10-01: 3 Gusts\n {2}Target, Gusts a month: 5 or less, now 3 \(green\)\n$/, 'hq numbers prints it under its list');
});

test("start() starts each kit's part, as the server's start runs it", async () => {
  kits.start();
  assert.equal((await import(`${KITS}/pinwheel/coordinator.ts`)).started, 1);
});

test("a kit that wants an agent route the platform already answers stops the coordinator at start", () => {
  const clash = `${KITS}-clash`;
  mkdirSync(`${clash}/thief`, { recursive: true });
  writeFileSync(`${clash}/thief/coordinator.ts`, "export const agent = { 'GET /api/agent/orders': () => [] };");
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./server.ts', import.meta.url).href)})`],
    { env: { ...process.env, KITS_DIR: clash }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /kits\/thief wants GET \/api\/agent\/orders, which is already answered/);
});

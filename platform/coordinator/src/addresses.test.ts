// node --test src/addresses.test.ts   (a throwaway DATA_DIR; the test company's org for createRequest/answerRequest)
// The board's saved delivery addresses (addresses.ts) on the desk phone's address cards (hq ask/request --address).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fixtureRepo } from './fixture.ts';

fixtureRepo();
process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/addresses-test-`);
const secrets = await import('./secrets.ts');
const addresses = await import('./addresses.ts');
const jobs = await import('./jobs.ts');

// a made-up company's tool with two parcels, each its own four address keys
const LINE = /^[^\p{Cc}]{1,200}$/u;
const keys = (p: string) => ['NAME', 'STREET', 'POSTCODE', 'CITY'].map(k => `${p}_${k}`);
const ONE = keys('DROP_ONE'),
  TWO = keys('DROP_TWO'),
  THREE = keys('DROP_THREE');
secrets.registerKeys(Object.fromEntries([...ONE, ...TWO, ...THREE].map(k => [k, LINE])));
const ask = (names: string[], more: Record<string, unknown> = { address: true }) =>
  jobs.createRequest({
    kind: 'credential',
    title: 'Where should it go?',
    body: 'x',
    agent: 'wren',
    secrets: names.join(','),
    ...more,
  });
const card = (id: number, status = 'open') => (jobs.listRequests(status) as any[]).find(r => r.id === id);
const HOME = ['Testco Board', 'Nowhere Lane 1', '1234 AB', 'Utrecht'];
const typed = (names: string[], parts = HOME) => Object.fromEntries(names.map((n, i) => [n, parts[i]]));

test("an address card asks for four of a company tool's own keys, and says so", () => {
  assert.equal(ask(['PRINTAPI_TEST_A', 'PRINTAPI_TEST_B', 'PRINTAPI_TEST_C', 'PRINTAPI_TEST_D']), 400); // a partner key reaches every job
  assert.equal(ask(ONE.slice(0, 3)), 400);
  assert.equal(ask([...ONE.slice(0, 3), 'CALL_PIN']), 400); // a server key
  assert.equal(ask([ONE[0], ONE[0], ONE[1], ONE[2]]), 400);
  assert.equal(ask(ONE, { address: 'yes' }), 400);
  assert.equal(jobs.createRequest({ kind: 'decision', title: 'x', body: 'x', agent: 'wren', address: true }), 400);
  const { id } = ask(ONE) as { id: number };
  assert.equal(card(id).address, 1);
  assert.deepEqual(card(id).addresses, []);
  const { id: plain } = ask(ONE, {}) as { id: number }; // without --address: as before
  assert.equal(card(plain).address, null);
  assert.equal(card(plain).addresses, undefined);
});

test("a typed address is saved under the board's label once all four keys are in; the label is checked first", () => {
  const { id } = ask(ONE) as { id: number };
  assert.deepEqual(jobs.answerRequest(id, '', typed(ONE), false, { save: '  ' }), [
    400,
    'Give the address a short name to save it under (up to 40 characters), like Home.',
    { refused: {} },
  ]);
  assert.deepEqual(secrets.stored(ONE), []); // nothing kept on a refused label
  // one key now, the rest later: nothing saved as an address yet
  assert.deepEqual(jobs.answerRequest(id, '', { [ONE[0]]: HOME[0] }, false, { save: 'Home' }), {
    ok: true,
    missing: ONE.slice(1),
  });
  assert.deepEqual(addresses.list(), []);
  assert.deepEqual(jobs.answerRequest(id, '', typed(ONE.slice(1), HOME.slice(1)), false, { save: 'Home' }), {
    ok: true,
  });
  const [home] = addresses.list();
  assert.equal(home.label, 'Home');
  assert.deepEqual(addresses.parts(home.id), HOME);
  // the label and the address are in no answer an agent reads; once the card's own copy is gone (its parcel shipped),
  // the saved one stays, masked in text like a key, never a job's
  const answer = card(id, 'answered').answer;
  assert.doesNotMatch(answer, /Home|Nowhere/);
  secrets.forget(ONE);
  assert.equal(secrets.redact('Ship it to Nowhere Lane 1 please'), `Ship it to [SAVED_ADDRESS_${home.id}] please`);
  assert.ok(!Object.values(secrets.testSecrets()).some(v => String(v).includes('Nowhere')));
  assert.ok(!secrets.validNames(`SAVED_ADDRESS_${home.id}`)); // no card can ask for it
});

test('a saved address picked on a later card fills its keys; a second label of the same name is refused', () => {
  const [home] = addresses.list();
  const { id } = ask(TWO) as { id: number };
  assert.deepEqual(card(id).addresses, [{ id: home.id, label: 'Home' }]);
  assert.deepEqual(
    jobs.answerRequest(id, '', typed(TWO, ['x', 'y', 'z', 'w']), false, { save: 'HOME', use: home.id }),
    { ok: true },
  ); // the pick wins
  assert.deepEqual(TWO.map(secrets.secret), HOME);
  assert.equal(addresses.list().length, 1);
  const { id: next } = ask(THREE) as { id: number };
  assert.match(
    (jobs.answerRequest(next, '', typed(THREE), false, { save: 'home' }) as any[])[1],
    /already have an address called “home”/,
  );
  // on a plain key card, the address field means nothing
  const { id: plain } = ask(THREE, {}) as { id: number };
  assert.deepEqual(jobs.answerRequest(plain, '', { [THREE[0]]: 'Someone' }, false, { use: home.id }), {
    ok: true,
    missing: THREE.slice(1),
  });
  assert.equal(secrets.secret(THREE[0]), 'Someone');
});

test('the board removes a saved address: gone from the key store, and a card that picked it says so', () => {
  const [home] = addresses.list(),
    file = `${secrets.DIR}/SAVED_ADDRESS_${home.id}`;
  assert.equal(readFileSync(file, 'utf8'), HOME.join('\n'));
  secrets.forget(THREE);
  const { id } = ask(THREE) as { id: number };
  assert.deepEqual(addresses.remove(home.id), { ok: true, addresses: [] });
  assert.ok(!existsSync(file));
  assert.equal(secrets.redact('Ship it to Nowhere Lane 1 please'), 'Ship it to [DROP_TWO_STREET] please'); // the card's own copy stays its tool's
  assert.equal(addresses.remove(home.id), 404);
  assert.deepEqual(jobs.answerRequest(id, '', {}, false, { use: home.id }), [
    400,
    'That saved address is gone: pick another, or type it.',
    { refused: {} },
  ]);
  assert.deepEqual(secrets.stored(THREE), []);
});

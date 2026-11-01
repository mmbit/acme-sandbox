// node --test src/spend.test.ts   (hq spend on the test company's Hello)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('spend');
const { spendByDay } = await import('./spend.ts'); // (what Money and the watch read)
const penny = await h.start({ agent: 'penny' }),
  day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date());
const record = async (euros: unknown) => await h.agent('spend', penny.token, { app: 'hello', day, euros });

test('a day is recorded from a number or a numeric string, and anything else is refused, never taken as 0 or 1', async () => {
  for (const euros of ['', '  ', [], [0], true, false, {}, null, '1e3', '0x10', 'Infinity', -1, '12,50'])
    assert.equal((await record(euros)).status, 400, JSON.stringify(euros));
  assert.deepEqual(spendByDay('hello', day, day), new Map(), 'nothing recorded');
  assert.deepEqual((await record(' 12.50 ')).body, { app: 'hello', day, cents: 1250 });
  assert.deepEqual((await record(0)).body, { app: 'hello', day, cents: 0 });
});

test("only the app's owner and Finance record its spend: anyone else is refused and changes nothing", async () => {
  const dex = await h.start({ agent: 'dex' }),
    bolt = await h.start({ agent: 'bolt' }); // Hello's owner in the test company
  assert.equal((await record(3)).status, 200, "Finance (the test company's roles.finance)");
  const refused = await h.agent('spend', dex.token, { app: 'hello', day, euros: 900 });
  assert.equal(refused.status, 403);
  assert.deepEqual(spendByDay('hello', day, day), new Map([[day, 300]]), 'still what Finance recorded');
  assert.deepEqual((await h.agent('spend', bolt.token, { app: 'hello', day, euros: 4 })).body, {
    app: 'hello',
    day,
    cents: 400,
  });
});

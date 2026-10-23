// node --test src/care-credit.test.ts   (the board's card when the support chat's prepaid credit runs low, care-credit.ts:
// care's token only, the dollars as care counted them, the pace in days, and the card for care's owner)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('care-credit', { env: { PUBLIC_HOST: 'hq.testco.example' }, before: repo => {
  mkdirSync(`${repo}/products/care`, { recursive: true });
  writeFileSync(`${repo}/products/care/product.yaml`, 'name: Care\nowner: wren\n');
} });
const { signed } = await import('./payments.ts');

const post = (body: unknown, token = signed('care:hq')) => h.call('/api/care/credit', token, body);
// the card on the desk phone, as the board reads it
const card = async (b: Record<string, unknown>) => {
  const r = await post({ helper: 'Pip', stopAt: 1, ...b });
  assert.equal(r.status, 200);
  return (await h.board('/api/requests')).body.find((c: any) => c.id === r.body.id);
};

test("only care's token files a card, and only with the dollars it counted", async () => {
  assert.equal((await post({ helper: 'Pip', left: 4.5, perDay: 1, stopAt: 1 }, 'nope')).status, 401);
  assert.equal((await post({ helper: 'Pip', left: 'lots', perDay: 1, stopAt: 1 })).status, 400);
  assert.equal((await post({ left: 4.5, perDay: 1, stopAt: 1 })).status, 400);
});

test("the card goes to care's owner as a decision, with the days left at the week's pace", async () => {
  const c = await card({ left: 4.5, perDay: 0.8 });
  assert.equal(c.agent, 'wren', "care's owner hears the answer");
  assert.equal(c.kind, 'decision');
  assert.match(c.body, /about 4 days/, '$3.50 above the stop at $0.80 a day');
  assert.match((await card({ left: 1.5, perDay: 2 })).body, /within a day/);
  // nothing spent this week: no pace to go by; past the stop: it has stopped. Each tells the board something else
  assert.match((await card({ left: 4.5, perDay: 0 })).body, /no pace/);
  assert.match((await card({ left: 0.9, perDay: 2 })).body, /has stopped answering/);
});

test("with a plan's monthly credit on the account, the card says when the next one comes", async () => {
  assert.match((await card({ left: 4.5, perDay: 0.8, renews: Date.UTC(2026, 10, 2, 14) })).body, /2 November/);
  assert.doesNotMatch((await card({ left: 4.5, perDay: 0.8, renews: null })).body, /monthly API credit/);
});

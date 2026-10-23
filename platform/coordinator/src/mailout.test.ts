// node --test src/mailout.test.ts   (the test company, the email service a local stand-in)
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { harness } from './harness.ts';
import { fakeLettermint } from './fixture.ts';

const lettermint = await fakeLettermint();
const h = await harness('mailout', { serve: false, env: { PUBLIC_HOST: 'hq.example.test' } });
lettermint.on();
const lastId = () => `m-${lettermint.taken.length}`;
const mailout = await import('./mailout.ts'); // (what Care, the outbox and the shop's mail send through)
const { companyDay } = await import('./company.ts');

test("accepted and uncertain sends count each recipient in the company's month, while refused sends count none", async () => {
  const month = companyDay(Date.now()).slice(0, 7);
  const mail = { to: 'ann@example.com', cc: ['bob@example.com'], subject: 'Hello', text: 'Hello there' };
  await mailout.send('live', mail);
  assert.equal(mailout.emailsIn(month), 2);
  lettermint.script = ['refuse'];
  await assert.rejects(mailout.send('live', mail), { status: 502 });
  assert.equal(mailout.emailsIn(month), 2);
  lettermint.script = ['fail'];
  await assert.rejects(mailout.send('live', mail), { status: 504 });
  assert.equal(mailout.emailsIn(month), 4);
});

test('an address is what the email service takes: a pasted invisible character goes, a broken one is refused and kept', async () => {
  assert.equal(mailout.address('\u200eann.de-wit+shop@example.com\u200b '), 'ann.de-wit+shop@example.com');
  for (const bad of [
    'ann..wit@example.com',
    '.ann@example.com',
    'ann.@example.com',
    'anné@example.com',
    'ann\u0007@example.com',
  ])
    assert.equal(mailout.address(bad), null, bad);
  const kept = () => h.db.prepare('select status, answer from mail_failures order by id desc limit 1').get();
  // refused before it reaches the service, as the address's own refusal, and kept like the service's
  await assert.rejects(mailout.send('live', { to: 'ann..wit@example.com', subject: 'Hi', text: 'Hi' }), {
    status: 400,
    scope: 'recipient',
  });
  assert.deepEqual({ ...(kept() as object) }, { status: 400, answer: 'recipient: email: an email address' });
  // one with a pasted mark goes out without it
  await mailout.send('live', { to: '\u200eann@example.com', cc: ['bob@example.com\u200b'], subject: 'Hi', text: 'Hi' });
  const sent = lettermint.received.at(-1);
  assert.deepEqual([sent.to, sent.cc], [['ann@example.com'], ['bob@example.com']]);
});

test("an email the service took and couldn't deliver: its signed webhook names it in HQ's log once, kept with the failures", async () => {
  const { db } = h;
  const listmail = await import('./listmail.ts');
  // HQ's door for the webhook, as server.ts routes it
  const door = createServer((q, r) => listmail.handleNotice(q, r));
  await new Promise<void>(resolve => door.listen(0, resolve));
  after(() => door.close());
  const SECRET = 'whsec_dGVzdC1zZWNyZXQtZm9yLWhxLXRlc3Rz';
  const hook = (
    body: object,
    {
      secret = SECRET,
      at = Math.floor(Date.now() / 1000),
      delivery = at,
    }: { secret?: string; at?: number; delivery?: number } = {},
  ) => {
    const raw = JSON.stringify(body),
      v1 = createHmac('sha256', secret).update(`${at}.${raw}`).digest('hex');
    return fetch(`http://localhost:${(door.address() as AddressInfo).port}/api/list/notices`, {
      method: 'POST',
      body: raw,
      headers: {
        'content-type': 'application/json',
        'x-lettermint-signature': `t=${at},v1=${v1}`,
        'x-lettermint-delivery': String(delivery),
      },
    }).then(r => r.status);
  };
  const failures = () =>
    db
      .prepare("select status, answer from mail_failures where answer like 'delivery:%' order by id")
      .all()
      .map(r => ({ ...r }));
  const told = () =>
    (
      db.prepare("select text from events where type = 'log' and text like 'Email: %' order by id").all() as {
        text: string;
      }[]
    ).map(r => r.text);

  await mailout.send('test', {
    to: 'tess@example.com',
    subject: 'Je bestelling',
    text: 'Dank je',
    about: 'the basket email for cs_test_tester_aa (test)',
  });
  const id = lastId();
  const bounce = {
    id: 'ev-1',
    event: 'message.hard_bounced',
    timestamp: new Date().toISOString(),
    data: {
      message_id: id,
      recipient: 'tess@example.com',
      response: { status_code: 550, content: '5.1.1 <tess@example.com>: no such user' },
    },
  };
  // without the secret saved, nothing is heard (the service tries again later)
  assert.equal(await hook(bounce), 503);
  writeFileSync(`${h.dataDir}/secrets/EMAIL_WEBHOOK_SECRET`, SECRET);
  // not signed with it, stale, or its delivery header not the signed time: refused, nothing kept
  assert.equal(await hook(bounce, { secret: 'whsec_c29tZW9uZS1lbHNlcy1zZWNyZXQ' }), 401);
  assert.equal(await hook(bounce, { at: Math.floor(Date.now() / 1000) - 600 }), 401);
  assert.equal(await hook(bounce, { delivery: Math.floor(Date.now() / 1000) - 1 }), 401);
  assert.deepEqual([failures(), told()], [[], []]);

  // signed: once, however often the service says it, and the address in its words never kept
  assert.equal(await hook(bounce), 200);
  assert.equal(await hook({ ...bounce, id: 'ev-1-again' }), 200);
  assert.deepEqual(failures(), [
    {
      status: 550,
      answer:
        'delivery: message.hard_bounced (the basket email for cs_test_tester_aa (test)): 5.1.1 <[address]>: no such user',
    },
  ]);
  assert.deepEqual(told(), [
    "Email: NEEDS A PERSON: the basket email for cs_test_tester_aa (test) didn't reach its reader: the email service bounced it: the address takes no mail (5.1.1 <[address]>: no such user).",
  ]);

  // delivered, or a soft bounce the service tries again: nothing to tell
  for (const event of ['message.delivered', 'message.soft_bounced', 'webhook.test'])
    assert.equal(
      await hook({ ...bounce, id: `ev-${event}`, event, data: { ...bounce.data, message_id: 'm-other' } }),
      200,
    );
  assert.equal(told().length, 1);

  // its own spam filter, for an email sent without an about; and one HQ never kept an id for
  await mailout.send('live', { to: 'ann@example.com', subject: 'Hi', text: 'Hi' });
  assert.equal(
    await hook({
      id: 'ev-2',
      event: 'message.policy_rejected',
      data: { message_id: lastId(), reason: 'Spam score threshold exceeded', score: 7.5 },
    }),
    200,
  );
  assert.equal(
    await hook({ id: 'ev-3', event: 'message.suppressed', data: { message_id: 'm-before', reason: 'hard_bounce' } }),
    200,
  );
  assert.match(
    told()[1],
    /^Email: NEEDS A PERSON: an email HQ sent at \d{4}-\d\d-\d\dT\d\d:\d\d UTC didn't reach its reader: the email service held it back as spam \(its own filter, before sending\) \(Spam score threshold exceeded\)\.$/,
  );
  assert.equal(
    told()[2],
    "Email: NEEDS A PERSON: an email HQ can't name (the support chat's, or an older one) didn't reach its reader: the email service skipped it: the address is on its suppression list (hard_bounce).",
  );
});

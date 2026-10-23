// node --test src/notices.test.ts   (the test company, with a test token for the mail Worker)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';
import { commitFile } from './fixture.ts';

const TOKEN = 'mail-worker-test-token-0123456789';
// Two services at board@: one to org.yaml's roles.inbox (Dex in the test company), one to Kit by name; one at vendor@ with
// no owner (business mail only)
const NOTICES = `boardOnly: [board, vendor], notices: [
  { to: board, from: shop.example, subject: ['Listing issues for', 'New issue on'], name: Shopfinder, owner: inbox, brief: 'Fix the listing.' },
  { to: board, from: ads.example, subject: 'Ad disapproved', name: Adhouse, owner: kit },
  { to: vendor, from: vendor.example, subject: 'Fault report' }]`;
const h = await harness('notices', {
  before: repo => {
    commitFile(
      'infra/mail/token.sha256',
      createHash('sha256').update(TOKEN).digest('hex'),
      "Email: rotate the inbox Worker's token",
    );
    const brand = `${repo}/company/brand.yaml`;
    writeFileSync(
      brand,
      readFileSync(brand, 'utf8').replace(
        /^mail: \{ domain: testco\.example \}/m,
        `mail: { domain: testco.example, ${NOTICES} }`,
      ),
    );
  },
});
const { db, base, repo } = h;
const notices = await import('./notices.ts');

const send = async (subject: string, from: string, to = 'board@testco.example') =>
  (
    await (
      await fetch(`${base}/api/mail/inbound`, {
        method: 'POST',
        body: Buffer.from(
          [`From: <${from}>`, `To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain', '', 'Body', ''].join(
            '\r\n',
          ),
        ),
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'message/rfc822',
          'x-mail-from': from,
          'x-mail-to': to,
        },
      })
    ).json()
  ).id as number;
const serviceJobs = (name: string) =>
  db
    .prepare('select id, agent, title, prompt from jobs where title = ? order by id')
    .all(`${name}'s notices: what they say, and whose it is to act`) as {
    id: number;
    agent: string;
    prompt: string;
  }[];
// The next job claimed, as the worker claims it: the one expected
const claimed = async (id: number) => {
  const job = await h.claim('claude');
  assert.equal(job?.id, id);
  return job!;
};
// a service's job run to its end
const ran = async (id: number) => {
  await h.finish(await claimed(id));
};
const reads = async (job: { token: string }, mail: number) => (await h.agent(`mail?id=${mail}`, job.token)).status;
const HOUR = 60 * 60_000;

test("a notice is a job for its entry's owner, which reads it; codes and other mail stay the board's", async () => {
  const listing = await send('Listing issues for www.testco.example', 'notify@shop.example');
  const code = await send('Your sign-in code', 'notify@shop.example');
  const [job] = serviceJobs('Shopfinder');
  assert.equal(job.agent, 'dex', 'roles.inbox');
  assert.match(job.prompt, new RegExp(`Mail #${listing}:`));
  assert.match(job.prompt, /Shopfinder's own: Fix the listing\./);
  await ran(job.id);
  const ad = await send('Ad disapproved: Spring', 'policy@ads.example');
  const [adJob] = serviceJobs('Adhouse');
  assert.equal(adJob.agent, 'kit', 'an agent by name');
  assert.doesNotMatch(adJob.prompt, /'s own:/, 'no brief of its own: the platform steps alone');
  // Kit reads no business mail by role: only the notice its job was handed
  const kit = await claimed(adJob.id);
  assert.equal(await reads(kit, ad), 200);
  assert.equal(await reads(kit, listing), 403, "another service's notice is business mail Kit's role doesn't read");
  assert.equal(await reads(kit, code), 404, "the board's own");
  const other = await h.start({ agent: 'kit', title: 'Something else' });
  assert.equal(await reads(other, ad), 403, "Kit's other jobs don't");
  await h.finish(kit);
  // no owner: business mail, no job
  await send('Fault report: GET /x', 'info@vendor.example', 'vendor@testco.example');
  assert.equal(serviceJobs('Shopfinder').length + serviceJobs('Adhouse').length, 2);
});

test('a run of notices is one job: the next waits for the last to end and an hour from its start, four a day at most', async () => {
  const more = [await send('New issue on www', 'a@shop.example'), await send('New issue on www', 'b@shop.example')];
  notices.check(Date.now() + 59 * 60_000);
  assert.equal(serviceJobs('Shopfinder').length, 1, 'the last began less than an hour ago');
  notices.check(Date.now() + 61 * 60_000);
  const second = serviceJobs('Shopfinder')[1];
  assert.match(second.prompt, new RegExp(`2 notices .*\\n.*Mail #${more[0]}, #${more[1]}:`));
  await send('New issue on www', 'c@shop.example');
  notices.check(Date.now() + 61 * 60_000);
  assert.equal(serviceJobs('Shopfinder').length, 2, 'waits while the last is queued');
  await ran(second.id);
  for (const n of [3, 4]) {
    notices.check(Date.now() + 61 * 60_000);
    assert.equal(serviceJobs('Shopfinder').length, n);
    await ran(serviceJobs('Shopfinder')[n - 1].id);
    await send('New issue on www', 'd@shop.example');
  }
  notices.check(Date.now() + 61 * 60_000);
  assert.equal(serviceJobs('Shopfinder').length, 4, 'four began in the last day');
  notices.check(Date.now() + 25 * HOUR);
  assert.equal(serviceJobs('Shopfinder').length, 5);
});

test("one service's waiting notices never hold up another's", async () => {
  // Shopfinder's fifth job is queued: its notices wait, more than a job takes at once
  for (let i = 0; i < 201; i++) await send('New issue on www', 'e@shop.example');
  const ad = await send('Ad disapproved: Autumn', 'policy@ads.example');
  notices.check(Date.now() + 61 * 60_000);
  assert.match(serviceJobs('Adhouse').at(-1)!.prompt, new RegExp(`Mail #${ad}:`));
});

test('start: a notice of the last day that never got a job gets one', async () => {
  // vendor@'s notice came while its entry had no owner (the first test)
  const brand = `${repo}/company/brand.yaml`;
  writeFileSync(
    brand,
    readFileSync(brand, 'utf8').replace(
      "subject: 'Fault report' }",
      "subject: 'Fault report', name: Vendorly, owner: process }",
    ),
  );
  notices.start();
  const [job] = serviceJobs('Vendorly');
  assert.equal(job.agent, 'bolt', 'roles.process');
  assert.match(job.prompt, /Mail #\d+:/);
});

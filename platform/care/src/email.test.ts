// node --test src/email.test.ts   (a local node:http server plays Lettermint; nothing leaves the machine; the template's
// plug-in, whose sender is Pebble <help@example.com>; a throwaway DATA_DIR for the day's counts)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Seen = { method?: string, url?: string, token?: string | string[], body: any };
const seen: Seen[] = [];
let answer = { status: 202, body: { message_id: 'lm-1', status: 'pending' } as any };
const read = (req: IncomingMessage) => new Promise<string>(ok => { let s = ''; req.on('data', c => s += c).on('end', () => ok(s)); });
const server = createServer(async (req, res) => {
  seen.push({ method: req.method, url: req.url, token: req.headers['x-lettermint-token'], body: JSON.parse(await read(req)) });
  res.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
});
await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
after(() => server.close());
const port = (server.address() as any).port;

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'care-email-'));
process.env.CARE_EMAIL_API = `http://127.0.0.1:${port}/v1`;
process.env.CARE_EMAIL_API_KEY = 'test-token';
process.env.CARE_COMPANY_DIR = new URL('../../../template/products/care', import.meta.url).pathname;
const COMPANY = new URL('./company.ts', import.meta.url).href;
await (await import(COMPANY)).load();
const email = await import('./email.ts');
const numbers = await import('./numbers.ts');
// a fresh node for each environment the module reads at import (async, so the stand-in server keeps answering)
const EMAIL = new URL('./email.ts', import.meta.url).href;
const child = (code: string) => promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });

test('a code goes out as plain text from the company\'s sender, tracking off, and the provider\'s id comes back', async () => {
  seen.length = 0;
  const sent = await email.send({ to: 'anna@example.com', subject: 'Your code: 482913', text: 'Your code is 482913.', kind: 'code', app: 'shop' });
  assert.deepEqual(sent, { ok: true, id: 'lm-1' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, '/v1/send');
  assert.equal(seen[0].token, 'test-token');
  assert.deepEqual(seen[0].body, { from: 'Pebble <help@example.com>', to: ['anna@example.com'], subject: 'Your code: 482913',
    text: 'Your code is 482913.', tag: 'code', settings: { track_opens: false, track_clicks: false } });
});

test('the board\'s reply goes from the company address with the case\'s reply-to', async () => {
  seen.length = 0;
  const sent = await email.send({ to: 'anna@example.com', subject: 'Your poster', text: 'A new one is on its way.', kind: 'reply', app: 'shop',
    from: 'Example & Co <hello@example.com>', replyTo: 'case-1042@example.com' });
  assert.equal(sent.ok, true);
  assert.equal(seen[0].body.from, 'Example & Co <hello@example.com>');
  assert.deepEqual(seen[0].body.reply_to, ['case-1042@example.com']);
  assert.equal(seen[0].body.html, undefined);
});

test('an email the model wrote carries the AI-Disclosure header, at the email service and in the local outbox; a code doesn\'t', async () => {
  seen.length = 0;
  await email.send({ to: 'anna@example.com', subject: 'Your answer', text: 'Yes, we ship to Belgium.', kind: 'answer', app: 'shop', aiGenerated: true });
  await email.send({ to: 'anna@example.com', subject: 'Your code: 482913', text: 'Your code is 482913.', kind: 'code', app: 'shop' });
  assert.deepEqual(seen[0].body.headers, { 'AI-Disclosure': 'mode=machine-generated' });
  assert.equal(seen[1].body.headers, undefined);
  const { stderr } = await child(`delete process.env.CARE_EMAIL_API_KEY; process.env.CARE_LOCAL = '1';
    await (await import(${JSON.stringify(COMPANY)})).load();
    const email = await import(${JSON.stringify(EMAIL)});
    await email.send({ to: 'anna@example.com', subject: 'Your answer', text: 'Yes, we ship to Belgium.', kind: 'answer', app: 'shop', aiGenerated: true });
    await email.send({ to: 'anna@example.com', subject: 'Your code: 482913', text: 'Your code is 482913.', kind: 'code', app: 'shop' });
    console.error(JSON.stringify(email.outbox.map(m => m.headers ?? null)));`);
  assert.deepEqual(JSON.parse(stderr), [{ 'AI-Disclosure': 'mode=machine-generated' }, null]);
});

test('each email the email service takes counts once in its app\'s day; a refusal, a failure or the local outbox doesn\'t', async () => {
  const today = () => numbers.counts('counted', numbers.dayOf(Date.now())).emails;
  const send = () => email.send({ to: 'anna@example.com', subject: 'Your code: 482913', text: 'Your code is 482913.', kind: 'code', app: 'counted' });
  await send(); await send();
  assert.equal(today(), 2);
  answer = { status: 422, body: { message: 'invalid', errors: { to: ['invalid'] } } };
  await send();
  answer = { status: 503, body: { error: { code: 'UNAVAILABLE', message: 'x' } } };
  await send();
  answer = { status: 202, body: { message_id: 'lm-1', status: 'pending' } };
  await email.send({ to: 'anna@example.com, bob@example.com', subject: 'x', text: 'hello', kind: 'code', app: 'counted' }); // refused before it goes
  await child(`delete process.env.CARE_EMAIL_API_KEY; process.env.CARE_LOCAL = '1';
    await (await import(${JSON.stringify(COMPANY)})).load();
    const { send } = await import(${JSON.stringify(EMAIL)});
    await send({ to: 'anna@example.com', subject: 'x', text: 'hello', kind: 'code', app: 'counted' });`);
  assert.equal(today(), 2);
});

test('the provider\'s refusal comes back as a value with its status and code, never its message (it can echo the address)', async () => {
  answer = { status: 422, body: { message: 'The to field must be a valid address: anna@example.com.', errors: { to: ['anna@example.com is invalid'] } } };
  assert.deepEqual(await email.send({ to: 'anna@example.com', subject: 'x', text: 'hello', kind: 'answer', app: 'shop' }),
    { ok: false, error: 'the email service said 422 (to)', refused: true });
  answer = { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'Invalid token for anna@example.com' } } };
  assert.deepEqual(await email.send({ to: 'anna@example.com', subject: 'x', text: 'hello', kind: 'answer', app: 'shop' }),
    { ok: false, error: 'the email service said 401 (UNAUTHENTICATED)' });
  answer = { status: 500, body: { error: { code: 'anna@example.com', message: 'x' } } };
  assert.deepEqual(await email.send({ to: 'anna@example.com', subject: 'x', text: 'hello', kind: 'answer', app: 'shop' }),
    { ok: false, error: 'the email service said 500' }, 'a code that isn\'t a plain word is left out');
  answer = { status: 202, body: { message_id: 'lm-1', status: 'pending' } };
});

test('a provider that can\'t be reached is a failure value too', async () => {
  const { stdout } = await child(`process.env.CARE_EMAIL_API_KEY = 'k'; process.env.CARE_EMAIL_API = 'http://127.0.0.1:1/v1';
    const { send } = await import(${JSON.stringify(EMAIL)});
    console.log(JSON.stringify(await send({ to: 'anna@example.com', subject: 'x', text: 'hello', kind: 'code', app: 'shop' })));`);
  const out = JSON.parse(stdout);
  assert.equal(out.ok, false);
  assert.match(out.error, /^could not reach the email service/);
});

test('nothing that could add a recipient or a header, or send as someone else, reaches the provider', async () => {
  seen.length = 0;
  const base = { subject: 'x', text: 'hello', kind: 'answer' as const, app: 'shop' };
  for (const bad of [
    { ...base, to: 'anna@example.com, bob@example.com' },
    { ...base, to: 'anna@example.com\r\nBcc: bob@example.com' },
    { ...base, to: 'Anna <anna@example.com>' },
    { ...base, to: 'anna@example.com', replyTo: 'x@example.com\nBcc: y@example.com' },
    { ...base, to: 'anna@example.com', subject: 'hi\r\nBcc: bob@example.com' },
    { ...base, to: 'anna@example.com', from: 'Pebble <help@evil.example>' },
    { ...base, to: 'anna@example.com', from: 'Pebble <help@example.com.evil.example>' },
    { ...base, to: 'anna@example.com', text: '  ' },
  ]) assert.equal((await email.send(bad)).ok, false, JSON.stringify(bad));
  assert.equal(seen.length, 0);
});

test('with no key nothing is sent: on a local run the message waits in the outbox, elsewhere the send fails', async () => {
  seen.length = 0;
  const run = (local: boolean) => child(`delete process.env.CARE_EMAIL_API_KEY; process.env.CARE_EMAIL_API = 'http://127.0.0.1:${port}/v1';
    ${local ? "process.env.CARE_LOCAL = '1';" : 'delete process.env.CARE_LOCAL;'}
    await (await import(${JSON.stringify(COMPANY)})).load();
    const email = await import(${JSON.stringify(EMAIL)});
    const sent = await email.send({ to: 'anna@example.com', subject: 'Your code: 482913', text: 'Your code is 482913.', kind: 'code', app: 'shop' });
    console.error(JSON.stringify({ sent, sending: email.sending, outbox: email.outbox }));`);
  const local = await run(true), out = JSON.parse(local.stderr);
  assert.equal(out.sent.ok, true);
  assert.equal(out.sending, true);
  assert.equal(out.outbox.length, 1);
  assert.equal(out.outbox[0].text, 'Your code is 482913.');
  assert.equal(out.outbox[0].from, 'Pebble <help@example.com>');
  assert.equal(local.stdout, 'email: kept a code for a•••@example.com (no CARE_EMAIL_API_KEY, not sent): Your code: 482913\n');
  // on the server before the board has entered the key: no pretend "sent", and the log has only the kind and a masked address
  const server = await run(false), [log, json] = server.stderr.trim().split('\n'), off = JSON.parse(json);
  assert.deepEqual(off.sent, { ok: false, error: 'no CARE_EMAIL_API_KEY: nothing sent' });
  assert.equal(off.sending, false);
  assert.equal(off.outbox.length, 0);
  assert.equal(log, 'email: a code for a•••@example.com not sent: no CARE_EMAIL_API_KEY');
  assert.equal(seen.length, 0);
});

test('a plug-in without health terms doesn’t start, unless it says so on purpose (health = false)', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const plugin = (body: string) => { const d = mkdtempSync(`${tmpdir()}/care-plugin-`); mkdirSync(`${d}/public`); writeFileSync(`${d}/public/plugin.js`, body); return d; };
  const load = (dir: string) => child(`await (await import(${JSON.stringify(COMPANY)})).load(${JSON.stringify(dir)}); console.error('started');`).then(r => r.stderr, e => e.stderr);
  assert.match(await load(plugin("export const helper = 'Nell';\n")), /no health terms/);
  assert.match(await load(plugin("export const health = { en: '' };\n")), /no health terms/, 'an empty list is none');
  assert.match(await load(plugin('export const health = false;\n')), /^started/);
});

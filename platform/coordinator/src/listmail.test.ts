// node --test src/listmail.test.ts   (the harness; the email service a local stand-in for Lettermint)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { harness } from './harness.ts';
import { fakeLettermint, productHeaders } from './fixture.ts';

const h = await harness('listmail', { env: { PUBLIC_HOST: 'hq.example.test' } });
const { repo: REPO, dataDir: DATA } = h;
writeFileSync(`${REPO}/company/brand.yaml`, 'name: Testco\nmail: { domain: testco.example }\n');
for (const slug of ['pinwheel', 'kite', 'drum']) {
  mkdirSync(`${REPO}/products/${slug}/care`, { recursive: true });
  writeFileSync(
    `${REPO}/products/${slug}/product.yaml`,
    `name: ${slug}\nstatus: ${slug === 'drum' ? 'preview' : 'live'}\n`,
  );
}
const LEAVE = 'https://pinwheel.example.test/leave/?t=abc123';
writeFileSync(
  `${REPO}/products/pinwheel/care/list-emails.yaml`,
  `footer:
  en: "From Pinwheel. Rather not get our emails? Leave here: {leave}"
  nl: "Van Pinwheel. Afmelden: {leave}"
confirm:
  en:
    subject: "Please confirm: {idea} & you"
    body: |
      You asked us for one email when <{idea}> opens.

      To confirm, open this link:
      {link}
  nl: { subject: "Bevestig", body: "Open: {link}" }
news:
  en: { subject: "{idea} is open", body: "It's here: {link}." }
typo:
  en: { subject: "Hello", body: "Hello {name}" }
draft:
  en: { subject: "Soon", body: "Run by <<the company's address>>. {link}" }
`,
);
writeFileSync(`${REPO}/products/kite/care/list-emails.yaml`, 'confirm:\n  en: { subject: "Hi", body: "{link}" }\n');
const infraEnv = (route: string) =>
  writeFileSync(`${REPO}/company/infra.env`, route ? `EMAIL_LIST_ROUTE=${route}\n` : '\n');
infraEnv('newsletter');

const as = await productHeaders();
const listmail = await import('./listmail.ts');
// The board's Approve of their launch, on an agent's card
for (const slug of ['pinwheel', 'kite']) {
  const job = await h.start({ agent: 'bolt' }),
    card = await h.ask(job, { kind: 'approval', approves: `live:${slug}` });
  assert.equal((await h.answer(card, '', { approve: true })).status, 200);
  await h.finish(job);
}
listmail.slots.idea = listmail.textSlot(60);
// A company's own kind: words of its own, and a gate that says no unless open
let gateOpen = false;
listmail.kinds.set('gated', {
  words: () => ({ subject: 'Gated', body: 'Only when open.' }),
  refusal: () => (gateOpen ? null : [403, 'the gate is shut']),
});

// The email service: every email it was sent, whatever its answer
const lettermint = await fakeLettermint(),
  { received } = lettermint;
const withService = () => {
  lettermint.on();
  writeFileSync(`${DATA}/secrets/EMAIL_WEBHOOK_SECRET`, WEBHOOK_SECRET);
};
const withoutService = () => {
  lettermint.off();
  rmSync(`${DATA}/secrets/EMAIL_WEBHOOK_SECRET`, { force: true });
};
const WEBHOOK_SECRET = 'whsec_0123456789abcdefghijklmnop';
beforeEach(() => {
  received.length = lettermint.taken.length = 0;
  lettermint.script = [];
  withoutService();
  infraEnv('newsletter');
});

// A product's server sending an email to its list, with the token it gets in life
const ask = (body: object, slug = 'pinwheel', mode = 'test') => h.send('/api/list/email', as(slug, mode), body);
const confirm = (more: object = {}) => ({
  kind: 'confirm',
  lang: 'en',
  to: 'reader@example.org',
  slots: { idea: 'Kite', link: 'https://pinwheel.example.test/confirm/?t=abc' },
  leave: LEAVE,
  ...more,
});

test('test mode without the email service renders the email: the words with their slots, then the footer with the leave link', async () => {
  const r = await ask(confirm());
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'test');
  const email = r.json.test_email;
  assert.equal(email.subject, 'Please confirm: Kite & you');
  assert.equal(
    email.text,
    'You asked us for one email when <Kite> opens.\n\nTo confirm, open this link:\nhttps://pinwheel.example.test/confirm/?t=abc\n\n' +
      `From Pinwheel. Rather not get our emails? Leave here: ${LEAVE}\n`,
  );
  // the HTML part: the same text escaped, its links plain (no redirect), no picture of any kind
  assert.match(email.html, /when &lt;Kite&gt; opens/);
  assert.match(email.html, /<a href="https:\/\/pinwheel\.example\.test\/confirm\/\?t=abc"/);
  assert.match(email.html, /<a href="https:\/\/pinwheel\.example\.test\/leave\/\?t=abc123"/);
  assert.doesNotMatch(email.html, /<img/);
  assert.equal(received.length, 0);
});

test("with the product's own look the HTML part is set in it, the footer as its small print, every link linked", async () => {
  const look = `${REPO}/products/pinwheel/care/email-look.yaml`;
  writeFileSync(
    look,
    'page: "<main lang=\\"{lang}\\"><h1>{subject}</h1>{content}</main>"\nstyles: { small: "font-size:13px" }\n',
  );
  try {
    const { html } = (await ask(confirm())).json.test_email;
    assert.match(html, /^<main lang="en"><h1>Please confirm: Kite &amp; you<\/h1>/);
    assert.match(html, /<a href="https:\/\/pinwheel\.example\.test\/confirm\/\?t=abc">/);
    assert.match(
      html,
      /<p style="font-size:13px">From Pinwheel\. .*<a href="https:\/\/pinwheel\.example\.test\/leave\/\?t=abc123">/,
    );
    writeFileSync(look, 'page: "<main></main>"\n');
    const broken = await ask(confirm());
    assert.deepEqual(
      [broken.status, broken.json.error],
      [400, 'products/pinwheel/care/email-look.yaml: a page with {content}'],
    );
  } finally {
    rmSync(look);
  }
});

test("what the email service takes: the list's route, the one-click leave headers, tracking off, text and HTML", async () => {
  withService();
  const r = await ask(confirm({ to: ' reader@example.org ' }), 'pinwheel', 'live');
  assert.deepEqual([r.status, r.json], [200, { status: 'sent' }]);
  const sent = received[0];
  assert.deepEqual(sent.to, ['reader@example.org']);
  assert.equal(sent.route, 'newsletter');
  assert.deepEqual(sent.headers, {
    'List-Unsubscribe': `<${LEAVE}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  });
  assert.deepEqual(sent.settings, { track_opens: false, track_clicks: false });
  assert.match(sent.text, /Leave here: https:\/\/pinwheel\.example\.test\/leave\//);
  assert.match(sent.html, /<a href=/);
  assert.equal(sent.from, 'Testco <hello@testco.example>');
});

test('without the list route nothing goes, and an email the service may have taken answers 504', async () => {
  withService();
  infraEnv('');
  assert.equal((await ask(confirm(), 'pinwheel', 'live')).status, 503);
  assert.equal((await ask(confirm(), 'pinwheel', 'test')).status, 503);
  assert.equal(received.length, 0);
  infraEnv('newsletter');
  lettermint.script = ['lose'];
  assert.equal((await ask(confirm(), 'pinwheel', 'live')).status, 504);
});

test("a link off the product's own address, a missing or unknown slot, a leave link elsewhere or no footer: refused, nothing sent; an address HQ can't send to: 422", async () => {
  withService();
  const refused = [
    confirm({ slots: { idea: 'Kite', link: 'https://evil.example.org/x' } }),
    confirm({ slots: { idea: 'Kite' } }),
    confirm({ slots: { idea: 'see www.evil.example', link: 'https://pinwheel.example.test/' } }),
    confirm({ kind: 'typo' }),
    confirm({ leave: 'https://evil.example.org/leave' }),
    confirm({ lang: 'de' }),
    confirm({ kind: 'footer' }),
  ];
  for (const body of refused) assert.equal((await ask(body, 'pinwheel', 'live')).status, 400, JSON.stringify(body));
  assert.equal((await ask({ ...confirm(), leave: 'https://kite.example.test/leave/' }, 'kite', 'live')).status, 400); // kite's words have no footer
  for (const to of ['Reader <reader@example.org>', 'jan@münchen.de'])
    assert.equal((await ask(confirm({ to }), 'pinwheel', 'live')).status, 422, to);
  assert.equal(received.length, 0);
});

test('the email service refusing the address alone answers 422; refusing the email, 502', async () => {
  withService();
  lettermint.script = ['refuse:to.0', 'refuse:subject'];
  // (an ASCII local part, which address() takes)
  assert.equal((await ask(confirm({ to: 'jorg@example.org' }), 'pinwheel', 'live')).status, 422);
  assert.equal((await ask(confirm(), 'pinwheel', 'live')).status, 502);
  assert.equal((await ask(confirm(), 'pinwheel', 'live')).status, 200);
  assert.equal(received.length, 3);
});

test("a link to another product's page: a public one's, or in test mode a preview's", async () => {
  const news = (link: string) => confirm({ kind: 'news', slots: { idea: 'Kite', link } });
  withService();
  assert.equal((await ask(news('https://kite.example.test/'), 'pinwheel', 'live')).status, 200);
  assert.equal((await ask(news('https://drum.example.test/'), 'pinwheel', 'live')).status, 400);
  withoutService();
  assert.equal((await ask(news('https://drum.preview.example.test/'), 'pinwheel', 'test')).status, 200);
});

test('words not final yet (<<…>>) are refused live and rendered in test mode', async () => {
  const draft = confirm({ kind: 'draft', slots: { link: 'https://pinwheel.example.test/' } });
  assert.match((await ask(draft)).json.test_email.text, /<<the company's address>>/);
  withService();
  assert.equal((await ask(draft, 'pinwheel', 'live')).status, 409);
  assert.equal(received.length, 0);
});

test("a company's own kind goes only when it says so", async () => {
  withService();
  const gated = confirm({ kind: 'gated:first', slots: {} });
  assert.equal((await ask(gated, 'pinwheel', 'live')).status, 403);
  assert.equal(received.length, 0);
  gateOpen = true;
  assert.equal((await ask(gated, 'pinwheel', 'live')).status, 200);
  assert.equal(received[0].subject, 'Gated');
  assert.equal((await ask(confirm({ kind: 'other:first' }), 'pinwheel', 'live')).status, 400);
});

test("without the email service's word on its own leave link (its webhook's secret), nothing goes; test mode still renders", async () => {
  withService();
  rmSync(`${DATA}/secrets/EMAIL_WEBHOOK_SECRET`);
  const r = await ask(confirm(), 'pinwheel', 'live');
  assert.equal(r.status, 503);
  assert.match(r.json.error, /EMAIL_WEBHOOK_SECRET/);
  assert.equal(received.length, 0);
  withoutService();
  assert.equal((await ask(confirm())).json.status, 'test');
});

// ---- the email service's notices, signed as Lettermint signs them
const notice = (event: object, o: { secret?: string; at?: number; delivery?: string; signature?: string } = {}) => {
  const body = JSON.stringify(event),
    t = String(o.at ?? Math.floor(Date.now() / 1000));
  const v1 = createHmac('sha256', o.secret ?? WEBHOOK_SECRET)
    .update(`${t}.${body}`)
    .digest('hex');
  const headers = {
    'content-type': 'application/json',
    'x-lettermint-event': (event as any).event,
    'x-lettermint-signature': o.signature ?? `t=${t},v1=${v1}`,
    'x-lettermint-delivery': o.delivery ?? t,
  };
  return h.send('/api/list/notices', headers, body).then(r => r.status);
};
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const unsubscribed = (recipient: string, at = hoursAgo(2)) => ({
  id: 'e1',
  event: 'message.unsubscribed',
  timestamp: at,
  data: { message_id: 'm-1', subject: 'Please confirm', recipient, unsubscribed_at: at, metadata: {}, tags: [] },
});
const suppressed = (value: string, reason: string) => ({
  id: 'e2',
  event: 'suppression.added',
  timestamp: hoursAgo(1),
  context: { scope: 'route', team_id: 't', project_id: 'p', route_id: 'r' },
  data: { suppression_id: 's', type: 'email', value, reason, applies_to: 'broadcast' },
});
const hash = (address: string) => createHash('sha256').update(address).digest('hex');
const left = () => listmail.listLeft().map(l => [l.hash, l.at]);

test("an address that left through the service's own link is kept as its hash and when, for the list's sync", async () => {
  withService();
  const at = hoursAgo(2);
  assert.equal(await notice(unsubscribed('Reader@Example.org', at)), 200);
  assert.deepEqual(left(), [[hash('reader@example.org'), at]]);
  assert.equal(listmail.leftHash(' Reader@Example.org'), hash('reader@example.org'));
  // the same leave as a suppression, and a complaint; a hard bounce or the board's own block isn't a reader leaving
  assert.equal(await notice(suppressed('reader@example.org', 'unsubscribe')), 200);
  assert.equal(await notice(suppressed('cross@example.org', 'spam_complaint')), 200);
  assert.equal(await notice(suppressed('bounced@example.org', 'hard_bounce')), 200);
  assert.equal(await notice(suppressed('blocked@example.org', 'manual')), 200);
  assert.equal(await notice({ id: 'e3', event: 'message.delivered', data: { recipient: 'other@example.org' } }), 200);
  assert.deepEqual(
    left().map(([h]) => h),
    [hash('reader@example.org'), hash('cross@example.org')],
    'the later time kept',
  );
  assert.ok(left()[0][1] > at);
  const stored = JSON.stringify(h.db.prepare('select * from list_left').all());
  assert.doesNotMatch(stored, /example\.org/, 'never the address');
});

test('a notice not signed by the service, signed too long ago or for another time is refused; without the secret, 503', async () => {
  withService();
  const before = left().length;
  assert.equal(await notice(unsubscribed('forged@example.org'), { secret: 'whsec_someone-else-0123456789' }), 401);
  assert.equal(await notice(unsubscribed('old@example.org'), { at: Math.floor(Date.now() / 1000) - 301 }), 401);
  assert.equal(await notice(unsubscribed('moved@example.org'), { delivery: '1' }), 401);
  assert.equal(await notice(unsubscribed('bare@example.org'), { signature: 'v1=abc' }), 401);
  assert.equal(left().length, before);
  rmSync(`${DATA}/secrets/EMAIL_WEBHOOK_SECRET`);
  assert.equal(await notice(unsubscribed('early@example.org')), 503, 'the service tries again once the secret is in');
});

test('a leave is kept a week, then forgotten', async () => {
  withService();
  assert.equal(await notice(unsubscribed('long-ago@example.org', hoursAgo(8 * 24))), 200);
  assert.ok(!left().some(([h]) => h === hash('long-ago@example.org')));
});

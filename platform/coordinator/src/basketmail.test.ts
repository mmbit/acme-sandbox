// node --test src/basketmail.test.ts
// The shop's emails: a paid basket's confirmation and its parcel's shipped email. Stripe is the imitation; the email
// service and Print API's test environment are local stand-ins.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { harness } from './harness.ts';
import { fakeLettermint, productHeaders } from './fixture.ts';

// The email service: every email it was sent, refused or not
const lettermint = await fakeLettermint(), { received } = lettermint;
// Print API's test environment, as much of it as a parcel needs to ship: an order placed, its files uploaded, read back
const pa = new Map<string, any>();
const printapi = createServer(async (q, s) => {
  let body = ''; for await (const c of q) body += c;
  const path = q.url!.replace(/^\/test/, ''), order = path.match(/^\/orders\/([^/]+)$/), file = path.match(/^\/files\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (path === '/oauth') return s.end(JSON.stringify({ access_token: 'tok-test', expires_in: 14400 }));
  if (q.method === 'POST' && path === '/orders') {
    const b = JSON.parse(body);
    pa.set(b.id, { id: b.id, status: 'Created', metadata: b.metadata, items: b.items.map((i: any) =>
      ({ ...i, files: { content: { status: 'AwaitingUpload', uploadUrl: `${printApi}/test/files/${b.id}/${i.id}/content` } } })) });
    return s.end(JSON.stringify(pa.get(b.id)));
  }
  if (q.method === 'POST' && file) {
    pa.get(file[1]).items.find((i: any) => i.id === file[2]).files[file[3]] = { status: 'Accepted' };
    return s.end('{}');
  }
  if (q.method === 'GET' && order) {
    const o = pa.get(decodeURIComponent(order[1]));
    s.writeHead(o ? 200 : 404); return s.end(JSON.stringify(o ?? { message: 'Not found' }));
  }
  s.writeHead(404); s.end('{}');
});
await new Promise<void>(r => printapi.listen(0, r));
const printApi = `http://localhost:${(printapi.address() as any).port}`;
const h = await harness('basketmail', {
  env: { PUBLIC_HOST: 'hq.example.test', PRINTAPI_TEST_API: `${printApi}/test` },
  before: dir => {
    const repo = (path: string) => `${dir}/${path}`;
    mkdirSync(process.env.SECRETS_DIR!, { recursive: true });
    for (const k of ['CLIENT_ID', 'CLIENT_SECRET']) writeFileSync(`${process.env.SECRETS_DIR}/PRINTAPI_TEST_${k}`, `TEST-${k}`);
    for (const [slug, name] of [['pinwheel', 'Pinwheel'], ['hello', 'Hello Mug']]) {
      mkdirSync(repo(`products/${slug}`), { recursive: true });
      writeFileSync(repo(`products/${slug}/product.yaml`), `name: ${name}\nstatus: preview\n`);
    }
    // the shop: its manifest as the spec has it, and its words (a made-up shop's) with stand-in PDFs at the paths they name
    mkdirSync(repo('products/front/care'), { recursive: true });
    mkdirSync(repo('products/front/app/legal'), { recursive: true });
    writeFileSync(repo('products/front/product.yaml'), 'name: The Stalls\nstatus: preview\nbasket:\n  countries: [NL, BE, DE]\n  postage_saved: {NL: 400, BE: 400, DE: 400}\n  copies: 10\n');
    const words = (subject: string, saved: string, before: string, delivery: string[], file: string, lang: string) => `${lang}:
  subject: "${subject}"
  body: |
    Order {number}
    {items}
    {saved}
    {total}
    ${before} {ship_by}. {delivery}
    {notes}
    [See it]: {order_page}
    {again}

    {signoff}
  order_page: https://www.stalls.example.test/${lang}/orders/
  test_order_page: https://stalls.example.test/${lang}/orders/
  voucher: "{amount} voucher"
  notes: {hello: "A ${lang} note from the company."}
  again: {pinwheel: "https://stalls.example.test/${lang}/poster/"}
  saved: "${saved}"
  delivery: {NL: ${delivery[0]}, BE: ${delivery[1]}, DE: ${delivery[2]}}
  attachments:
    ${file}: app/legal/terms-${lang}.pdf
`;
    writeFileSync(repo('products/front/care/basket-email.yaml'), [
      words('Your order at The Stalls: thank you', '{amount} less in all', 'It should leave the printer by',
        ['usually 1–2 working days in the Netherlands', 'usually 1–3 working days to Belgium', 'usually 1–3 working days to Germany'], 'Terms of sale.pdf', 'en'),
      words('Je bestelling bij The Stalls: dankjewel', '{amount} minder in totaal', 'Het gaat uiterlijk op',
        ['meestal 1–2 werkdagen binnen Nederland', 'meestal 1–3 werkdagen naar België', 'meestal 1–3 werkdagen naar Duitsland'], 'Verkoopvoorwaarden.pdf', 'nl'),
      words('Deine Bestellung bei The Stalls: danke', 'insgesamt {amount} weniger', 'Es geht spätestens am',
        ['meist 1–2 Arbeitstage in die Niederlande', 'meist 1–3 Arbeitstage nach Belgien', 'meist 1–3 Arbeitstage innerhalb Deutschlands'], 'AGB.pdf', 'de'),
      words('Ta commande chez The Stalls : merci', '{amount} de moins au total', 'Elle quitte l’imprimeur au plus tard le',
        ['1 à 2 jours ouvrés aux Pays-Bas', '1 à 3 jours ouvrés en Belgique', '1 à 3 jours ouvrés en Allemagne'], 'CGV.pdf', 'fr'),
    ].join(''));
    for (const lang of ['en', 'nl', 'de', 'fr']) writeFileSync(repo(`products/front/app/legal/terms-${lang}.pdf`), `%PDF-1.4 the terms (${lang})`);
    // its look: the same words as HTML beside the text (mailpage.ts)
    writeFileSync(repo('products/front/care/email-look.yaml'), 'page: "<html lang=\\"{lang}\\"><title>{subject}</title>{content}</html>"\n');
    const shippedWords = (lang: string, subject: string, follow: string) => `  ${lang}:
    subject: "${subject}"
    body: |
      {items}
      {notes}
      ${follow}
      {delivery}
      [See it]: {order_page}
      Order {number}

      {signoff}
    notes:
      hello: "${lang === 'nl' ? 'Er zit iets extra bij.' : 'Something extra is in it.'}"
`;
    writeFileSync(repo('products/front/care/shipped-email.yaml'), [
      'shipped:\n', shippedWords('en', 'Your parcel from The Stalls is on its way', '[Follow it]: {tracking}'),
      shippedWords('nl', 'Je pakket van The Stalls is onderweg', '[Volg het]: {tracking}'),
      'shipped_untracked:\n', shippedWords('en', 'Your parcel from The Stalls is on its way', ''),
      shippedWords('nl', 'Je pakket van The Stalls is onderweg', ''),
    ].join(''));
  },
});
lettermint.on();
after(() => printapi.close());
const payments = await import('./payments.ts');
const basketmail = await import('./basketmail.ts');
const parcels = await import('./parcels.ts');
const { db } = h;

const as = await productHeaders();
// (a body that isn't JSON goes as text: the PDF and the imitation's form here are plain ASCII)
const call = (path: string, headers: Record<string, string>, body?: unknown, type = 'application/json') =>
  h.send(path, body === undefined ? headers : { ...headers, 'content-type': type }, body);

// A basket of two apps' lines, checked out to one address, paid on the imitation's page. Returns its session id; the
// front's next look at the order turns it paid (and calls the hooks).
let orders = 0;
// own: the shop's own lines going with the first thing (a gift magnet bought with it, say), at these prices; copies: of
// the first thing
async function paidBasket(locale: string, email: string, country = 'NL', own: number[] = [], copies = 1) {
  const lines: { line: string; claim: string }[] = [];
  // detail:
  for (const [slug, amount, description, detail] of [['pinwheel', 3995, 'Textile poster', 'For Mila'], ['hello', 2495, 'Mug for Noor', null]] as const) {
    const ref = `${slug}-${++orders}`;
    const l = await call('/api/pay/line', as(slug), { reference: ref, amount, description, detail, ships_in: 2, order_url: `https://${slug}.preview.example.test/order/${ref}`,
      picture: `https://${slug}.preview.example.test/api/orders/${ref}/picture/k1` });
    assert.equal(l.status, 200, l.text);
    lines.push(l.json);
  }
  let basket: string | undefined;
  for (const l of lines) {
    const added = await call('/api/pay/basket/add', as('front'), { ...(basket ? { basket } : {}), line: l.line, claim: l.claim });
    assert.equal(added.status, 200, added.text);
    basket = added.json.basket;
  }
  if (copies > 1) assert.equal((await call('/api/pay/basket/quantity', as('front'), { basket, line: lines[0].line, quantity: copies })).status, 200);
  for (const amount of own) {
    const added = await payments.changeBasket({ slug: 'front', mode: 'test' }, basket, id =>
      payments.addOwnLine(id, { goes_with: lines[0].line, description: 'Fridge magnet', amount, ships_in: 1, cutoff: 12 }) ?? undefined);
    assert.ok(!Array.isArray(added), JSON.stringify(added));
  }
  const c = await call('/api/pay/basket/checkout', as('front'), { basket, email, locale,
    deliver_to: { name: 'Ada Lovelace', line1: 'Keizersgracht 1', postCode: '1015 AA', city: 'Amsterdam', country },
    success_url: 'https://front.preview.example.test/order-done/?session={CHECKOUT_SESSION_ID}', cancel_url: 'https://front.preview.example.test/checkout/' });
  assert.equal(c.status, 200, c.text);
  const p = await call(`${new URL(c.json.url).pathname}/pay`, { origin: 'https://hq.example.test' }, '', 'application/x-www-form-urlencoded');
  assert.equal(p.status, 303, p.text);
  return c.json.id as string;
}
const look = (session: string) => call(`/api/pay/basket/order?id=${session}`, as('front'));
// The emails to an address, as the email service took them; went(to, n) waits for the nth (the confirmation goes on its
// own once the payment is seen), as long as the test may take
const mails = (to: string) => received.filter(m => m.to[0] === to);
async function went(to: string, n = 1) {
  while (mails(to).length < n) await new Promise(r => setTimeout(r, 20));
  assert.equal(mails(to).length, n, `email ${n} to ${to}`);
  return mails(to).at(-1);
}

// The basket's one order page, as its email links it: the words' address for a test order, its number and key after a #
const pageOf = async (session: string, lang: string) => {
  const { orderKey } = await import('./history.ts');
  const number = payments.orderNumber(session)!;
  assert.match(number, /^\d{7}$/);
  return { number, spaced: `${number.slice(0, 3)} ${number.slice(3)}`, url: `https://stalls.example.test/${lang}/orders/#${number}.${orderKey(session)}` };
};

test('a paid basket gets one email in its language: its number, every item with its picture, the total, the ship day, its one order page, the way back and the terms', async () => {
  const before = received.length, session = await paidBasket('nl', 'ada@example.nl');
  assert.equal(received.length, before, 'nothing before the payment is seen');
  const order = await look(session);
  assert.equal(order.json.paid, true);
  const mail = await went('ada@example.nl');
  assert.equal(received.length, before + 1);
  assert.equal(mail.subject, 'Je bestelling bij The Stalls: dankjewel');
  assert.ok(mail.text.includes('- Pinwheel: Textile poster (For Mila), € 39,95'), mail.text);
  assert.ok(mail.text.includes('- Hello Mug: Mug for Noor, € 20,95'), 'the second item after the postage saved');
  assert.ok(mail.text.includes('€ 4,00 minder in totaal'), 'the postage saved, said once');
  assert.match(mail.text, /^€ 60,90$/m, 'the total the card paid');
  assert.equal(order.json.total, 6090);
  const day = new Intl.DateTimeFormat('nl', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${order.json.ship_by}T12:00:00Z`));
  assert.ok(mail.text.includes(`uiterlijk op ${day}.`), day);
  assert.ok(mail.text.includes('meestal 1–2 werkdagen binnen Nederland'));
  const page = await pageOf(session, 'nl');
  assert.equal(order.json.number, page.number, 'the thank-you page has the number too');
  assert.ok(mail.text.startsWith(`Order ${page.spaced}\n`), 'the order number, as it is read out');
  assert.ok(mail.text.includes(`See it:\n${page.url}\n`), 'its one order page');
  assert.doesNotMatch(mail.text, /order\/pinwheel-1|order\/hello-2/, "no item's own page");
  assert.ok(mail.text.includes('- Pinwheel: https://stalls.example.test/nl/poster/'), 'the way back to the shop it names');
  assert.doesNotMatch(mail.text, /- Hello Mug: https:\/\/stalls/, 'none for a shop it leaves out');
  assert.doesNotMatch(mail.text, /\{[a-z_]+\}/, 'every slot filled');
  assert.ok(mail.html.startsWith(`<html lang="nl"><title>Je bestelling bij The Stalls: dankjewel</title><p>Order ${page.spaced}</p>\n<table role="presentation"`), mail.html);
  assert.ok(mail.html.includes('<tr><td width="86"><img src="https://pinwheel.preview.example.test/api/orders/pinwheel-1/picture/k1" width="72" alt=""></td><td><strong>Textile poster</strong><br><span>For Mila</span></td><td align="right">€ 39,95</td></tr>'),
    'a receipt row: its picture, its name and what is on it, its price');
  assert.ok(mail.html.includes('<td><strong>Mug for Noor</strong></td><td align="right">€ 20,95</td>'), mail.html);
  assert.ok(mail.html.includes(`<a href="${page.url}">See it</a>`), 'its order page behind a button');
  assert.deepEqual(mail.attachments.map((a: any) => [a.filename, Buffer.from(a.content, 'base64').toString()]), [['Verkoopvoorwaarden.pdf', '%PDF-1.4 the terms (nl)']]);
});

test('a line of copies: one receipt row of them all, its copies before its name, and the shipped email names them too', async () => {
  const session = await shipped('nl', 'twee@example.nl', 'https://track.example.test/2', [], 2);
  await basketmail.sweepShipped();
  const [confirmation, sent] = mails('twee@example.nl');
  assert.ok(confirmation.text.includes('- Pinwheel: 2 × Textile poster (For Mila), € 75,90'), confirmation.text);
  assert.ok(confirmation.text.includes('- Hello Mug: Mug for Noor, € 20,95'), 'three things: two of them €4 off');
  assert.ok(confirmation.html.includes('<strong>2 × Textile poster</strong>'), confirmation.html);
  assert.match(confirmation.text, /^€ 96,85$/m);
  assert.ok(sent.text.includes('- Pinwheel: 2 × Textile poster (For Mila)'), sent.text);
  const placed = [...pa.values()].at(-1);
  assert.deepEqual(placed.items.filter((i: any) => !i.id.startsWith('x-')).map((i: any) => [i.productId, i.quantity]),
    [['pinwheel_poster', 2], ['hello_poster', 1]], 'the copies as the quantity of its one item');
  assert.equal((await look(session)).json.lines[0].quantity, 2);
});

test('never twice: the front looking again and the timer after it went send nothing more', async () => {
  const session = await paidBasket('de', 'noor@example.de', 'DE');
  await look(session);
  await look(session);
  await went('noor@example.de');
  const after = received.length;
  await basketmail.sweep();
  await basketmail.sweep();
  await look(session);
  assert.equal(received.length, after);
  assert.equal(received.at(-1).subject, 'Deine Bestellung bei The Stalls: danke');
  assert.ok(received.at(-1).text.includes('meist 1–3 Arbeitstage innerhalb Deutschlands'));
  assert.equal(received.at(-1).attachments[0].filename, 'AGB.pdf');
});

test('an email the service refused goes again on the timer, and only until it went', async () => {
  lettermint.script = ['refuse'];
  const before = received.length, session = await paidBasket('en', 'sam@example.com', 'BE');
  await look(session);
  await went('sam@example.com');
  assert.equal(received.length, before + 1);
  await basketmail.sweep();
  assert.equal(received.length, before + 2);
  await basketmail.sweep();
  assert.equal(received.length, before + 2, 'sent once it went, never again');
  assert.equal(received.at(-1).attachments[0].filename, 'Terms of sale.pdf');
  assert.ok(received.at(-1).text.includes('usually 1–3 working days to Belgium'));
});

test('a basket seen paid without its mark (HQ stopped between the two) gets its email from the timer, in English for a language its words lack', async () => {
  const hooks = payments.basketPaid.splice(0);   // HQ stops right after the payment flipped to paid
  const session = await paidBasket('it', 'lou@example.it');
  await look(session);
  payments.basketPaid.push(...hooks);
  assert.equal(mails('lou@example.it').length, 0);
  const before = received.length;
  await basketmail.sweep();
  assert.equal(received.length, before + 1);
  assert.equal(received.at(-1).subject, 'Your order at The Stalls: thank you');
  assert.match(received.at(-1).text, /leave the printer by [A-Z][a-z]+day \d{1,2} [A-Z][a-z]+\./, 'the day as written in Europe');
  await basketmail.sweep();
  assert.equal(received.length, before + 1);
});

test('a language the words add is used too, not only en, nl and de', async () => {
  const session = await paidBasket('fr', 'lou@example.fr');
  await look(session);
  await went('lou@example.fr');
  assert.equal(received.at(-1).subject, 'Ta commande chez The Stalls : merci');
  assert.equal(received.at(-1).attachments[0].filename, 'CGV.pdf');
});

test('a basket its voucher paid: the item at its price with the voucher said, and €0.00 as what was paid', async () => {
  // (a stall's voucher spent on this order, first: the vouchers kit's own hook knows no V5)
  payments.lineVoucher.unshift((_, reference) => (reference === 'pinwheel-voucher-1' ? 3995 : undefined));
  try {
    const l = await call('/api/pay/line', as('pinwheel'), { reference: 'pinwheel-voucher-1', amount: 3995, description: 'Textile poster of Mila',
      voucher: 5, order_url: 'https://pinwheel.preview.example.test/order/pinwheel-voucher-1' });
    assert.equal(l.status, 200, l.text);
    const added = await call('/api/pay/basket/add', as('front'), { line: l.json.line, claim: l.json.claim });
    const c = await call('/api/pay/basket/checkout', as('front'), { basket: added.json.basket, email: 'mila@example.com', locale: 'en',
      deliver_to: { name: 'Ada Lovelace', line1: 'Keizersgracht 1', postCode: '1015 AA', city: 'Amsterdam', country: 'NL' },
      success_url: 'https://front.preview.example.test/order-done/?session={CHECKOUT_SESSION_ID}', cancel_url: 'https://front.preview.example.test/checkout/' });
    assert.equal(c.status, 200, c.text);
    const { text } = await went('mila@example.com');
    assert.ok(text.includes('- Pinwheel: Textile poster of Mila, €39.95 (€39.95 voucher)'), text);
    assert.match(text, /^€0\.00$/m);
    assert.doesNotMatch(text, /order\/pinwheel-voucher-1/, "its own page is the order page's to link");
  } finally {
    payments.lineVoucher.shift();
  }
});

test("a company's own sentences for one order: the phrases its hooks name, in the email's language, and nothing for the rest", async () => {
  let wanted = '';
  basketmail.notes.push(pay => (pay.id === wanted ? ['hello'] : []));
  basketmail.notes.push(() => { throw new Error('a broken hook'); });
  try {
    wanted = await paidBasket('de', 'ida@example.de');
    await look(wanted);
    assert.match((await went('ida@example.de')).text, /^A de note from the company\.$/m);
    const other = await paidBasket('de', 'jan@example.de');
    await look(other);
    const { text } = await went('jan@example.de');
    assert.doesNotMatch(text, /note from the company/);
    assert.doesNotMatch(text, /\n\n\n/, 'its line goes');
  } finally {
    basketmail.notes.length = 0;
  }
});

test("a hook that can't tell yet holds the email, at most half an hour after the payment", async () => {
  let known = false;
  basketmail.notes.push(() => (known ? ['hello'] : null));
  try {
    const held = await paidBasket('en', 'eve@example.de');
    await look(held);
    await basketmail.sweep();
    assert.equal(mails('eve@example.de').length, 0, 'held');
    known = true;
    await basketmail.sweep();
    assert.match((await went('eve@example.de')).text, /^A en note from the company\.$/m);
    known = false;
    const late = await paidBasket('en', 'kai@example.de');
    await look(late);
    // half an hour on: no route moves the payment's time
    db.prepare('update pay_lines set paid_at = ? where session = ?').run(new Date(Date.now() - 31 * 60_000).toISOString(), late);
    await basketmail.sweep();
    assert.doesNotMatch((await went('kai@example.de')).text, /note from the company/, 'it goes without the phrase');
  } finally {
    basketmail.notes.length = 0;
  }
});

// ---- the shipped email.
const PDF = `%PDF-1.7\n${' '.repeat(200)}`;
// A paid basket's two lines handed over and placed as one parcel, then shipped at Print API (with a tracking link, or not yet)
async function shipped(locale: string, email: string, tracking?: string, own: number[] = [], copies = 1) {
  const session = await paidBasket(locale, email, 'NL', own, copies);
  await look(session);
  await went(email);
  for (const l of payments.paidLines(session).filter(l => !l.goes_with)) {
    assert.equal((await call('/api/pay/parcel/items', as(l.product), { line: l.id, items: [{ productId: `${l.product}_poster`, quantity: 1 }] })).status, 200);
    assert.equal((await call(`/api/pay/parcel/file?line=${l.id}&item=0&file=content`, as(l.product), PDF, 'application/pdf')).status, 200);
  }
  await parcels.tick();
  const order = [...pa.values()].at(-1);   // (its parcel, the one just placed)
  Object.assign(order, { status: 'Shipped', ...(tracking ? { trackingUrl: tracking } : {}) });
  await parcels.tick(Date.now() + 11 * 60_000);
  return session;
}

test('a shipped basket of two stalls: one email with both things and the tracking link, in its language, never twice, restarts included', async () => {
  const session = await shipped('nl', 'bo@example.nl', 'https://jouw.postnl.nl/track-and-trace/3SSTALLS1');
  const before = received.length;
  await basketmail.sweepShipped();
  assert.equal(received.length, before + 1);
  const mail = received.at(-1);
  assert.deepEqual(mail.to, ['bo@example.nl']);
  assert.equal(mail.subject, 'Je pakket van The Stalls is onderweg');
  assert.ok(mail.text.includes('- Pinwheel: Textile poster (For Mila)\n- Hello Mug: Mug for Noor\n'), mail.text);
  assert.ok(mail.text.includes('Volg het:\nhttps://jouw.postnl.nl/track-and-trace/3SSTALLS1\n'), 'the address on its own line');
  assert.ok(mail.text.includes('meestal 1–2 werkdagen binnen Nederland'), "the confirmation's delivery words");
  const page = await pageOf(session, 'nl');
  assert.ok(mail.text.includes(`See it:\n${page.url}\nOrder ${page.spaced}\n`), 'its one order page and number');
  assert.doesNotMatch(mail.text, /€/, 'no prices');
  assert.ok(!mail.attachments?.length, 'no files');
  // the HTML part in the confirmation's look, the tracking link behind its button
  assert.ok(mail.html.startsWith('<html lang="nl"><title>Je pakket van The Stalls is onderweg</title><ul><li><strong>Pinwheel</strong>: Textile poster (For Mila)</li>'), mail.html);
  assert.ok(mail.html.includes('<a href="https://jouw.postnl.nl/track-and-trace/3SSTALLS1">Volg het</a>'), 'the tracking link, behind the button');
  assert.ok(!mail.html.includes('>jouw.postnl.nl'), 'its address out of sight');
  assert.ok(mail.html.includes(`<a href="${page.url}">See it</a>`), 'its order page behind a button');
  await basketmail.sweepShipped();
  // HQ started again: the same database, the module fresh in memory
  // @ts-expect-error the query makes a fresh copy of the module, a path TypeScript can't resolve
  const restarted: typeof basketmail = await import('./basketmail.ts?restart');
  await restarted.sweepShipped();
  assert.equal(received.length, before + 1, 'sent once, across restarts');
});

test('no tracking link a day after Shipped: the untracked email, and not the tracked one when the link comes later', async () => {
  await shipped('en', 'cy@example.com');
  const before = received.length;
  await basketmail.sweepShipped();
  assert.equal(received.length, before, 'the link may still come within the day');
  await basketmail.sweepShipped(Date.now() + 86_400_000 + 60_000);
  assert.equal(received.length, before + 1);
  assert.equal(received.at(-1).subject, 'Your parcel from The Stalls is on its way');
  assert.doesNotMatch(received.at(-1).text, /Follow it/);
  [...pa.values()].at(-1).trackingUrl = 'https://jouw.postnl.nl/track-and-trace/3SLATE';
  await parcels.tick(Date.now() + 86_400_000 + 30 * 60_000);
  await basketmail.sweepShipped(Date.now() + 86_400_000 + 31 * 60_000);
  assert.equal(received.length, before + 1, 'one of the two, never both');
});

test("a company's own sentences for a shipped parcel: the phrases its hooks name, under its things, and nothing for the rest", async () => {
  let wanted = '';
  basketmail.shippedNotes.push(session => (session === wanted ? ['hello'] : []));
  basketmail.shippedNotes.push(() => { throw new Error('a broken hook'); });
  try {
    wanted = await shipped('nl', 'di@example.nl', 'https://jouw.postnl.nl/track-and-trace/3SNOTE');
    await basketmail.sweepShipped();
    const mail = received.at(-1);
    assert.ok(mail.text.includes('- Hello Mug: Mug for Noor\nEr zit iets extra bij.\nVolg het:'), mail.text);
    assert.ok(mail.html.includes('</ul>\n<p>Er zit iets extra bij.</p>'), mail.html);
    await shipped('en', 'el@example.com', 'https://jouw.postnl.nl/track-and-trace/3SNONE');
    await basketmail.sweepShipped();
    assert.ok(received.at(-1).text.includes('- Hello Mug: Mug for Noor\nFollow it:'), 'no line where no hook names one');
  } finally {
    basketmail.shippedNotes.length = 0;
  }
});

test("a company's own closing line ends both emails as they go, its picture beside it in the HTML part; with none, its line goes", async () => {
  let at = 0;
  basketmail.signoffs.push((lang, now) => {
    at = now;
    if (lang === 'nl') return { text: 'Fijne dagen & tot ziens!', picture: { src: 'https://www.stalls.example.test/img/mark.png', width: 21, height: 21 } };
    return lang === 'de' ? { text: 'Schöne Tage!', picture: null } : null;
  });
  try {
    const session = await paidBasket('nl', 'fe@example.nl');
    await look(session);
    const mail = await went('fe@example.nl');
    assert.ok(mail.text.endsWith('- Pinwheel: https://stalls.example.test/nl/poster/\n\nFijne dagen & tot ziens!\n'), mail.text);
    assert.ok(Math.abs(at - Date.now()) < 60_000, 'the moment it is sent');
    assert.ok(mail.html.endsWith('</ul>\n<table role="presentation" cellspacing="0" cellpadding="0" width="100%"><tr><td width="21" valign="top">' +
      '<img src="https://www.stalls.example.test/img/mark.png" width="21" height="21" alt=""></td><td valign="top">Fijne dagen &amp; tot ziens!</td></tr></table></html>'), mail.html);
    await shipped('nl', 'gi@example.nl', 'https://jouw.postnl.nl/track-and-trace/3SWISH');
    await basketmail.sweepShipped();
    assert.match(received.at(-1).text, /\nOrder \d{3} \d{4}\n\nFijne dagen & tot ziens!\n$/, 'the shipped email ends on it too');
    assert.ok(received.at(-1).html.includes('<td valign="top">Fijne dagen &amp; tot ziens!</td></tr></table></html>'), 'the shipped email too');
    const plain = await paidBasket('de', 'ha@example.de');
    await look(plain);
    const de = await went('ha@example.de');
    assert.ok(de.text.endsWith('/de/poster/\n\nSchöne Tage!\n'), de.text);
    assert.ok(de.html.endsWith('</ul>\n<p>Schöne Tage!</p></html>'), 'without a picture, a paragraph');
    const none = await paidBasket('en', 'io@example.com');
    await look(none);
    const en = await went('io@example.com');
    assert.ok(en.text.endsWith('/en/poster/\n'), en.text);
    assert.ok(en.html.endsWith('</ul></html>'), en.html);
  } finally {
    basketmail.signoffs.length = 0;
  }
});

test("a bought magnet is listed after its thing; one refunded isn't, one whose refund failed is", async () => {
  payments.ownLines.price = (_basket, _things, own) => own.map(() => 999);
  try {
    const session = await shipped('en', 'mo@example.com', 'https://jouw.postnl.nl/track-and-trace/3SMAGNET', [999, 999, 999]);
    const own = payments.paidLines(session).filter(l => l.goes_with);
    assert.equal(own.length, 3);
    const refunded = await call('/api/pay/line/refund', as('front'), { id: own[1].id });
    assert.equal(refunded.json?.refund_status, 'succeeded', refunded.text);
    // (a refund Stripe failed: the imitation fails none)
    db.prepare("update pay_lines set refund_status = 'failed' where id = ?").run(own[2].id);
    await basketmail.sweepShipped();
    const { text } = await went('mo@example.com', 2);
    assert.ok(text.includes('- Pinwheel: Textile poster (For Mila)\n- The Stalls: Fridge magnet (For Mila)\n- The Stalls: Fridge magnet (For Mila)\n- Hello Mug: Mug for Noor\n'), text);
    assert.equal(text.match(/Fridge magnet/g)?.length, 2, 'the refunded one left out');
  } finally {
    delete payments.ownLines.price;
  }
});

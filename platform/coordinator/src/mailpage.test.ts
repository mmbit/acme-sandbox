// node --test src/mailpage.test.ts   (the mailers' page: words and a look file in the test company make an email's parts)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const REPO = (await harness('mailpage', { serve: false })).repo;
mkdirSync(`${REPO}/care`);
const mailpage = await import('./mailpage.ts'); // (what Care, the outbox and the shop's mails fill their emails with)

const WORDS = `Thank you. Help: https://shop.example.test/help/.

## What you ordered
{items}
{saved}
You paid {total}

## Your pages
- The whole shop: https://shop.example.test/
{links}

---
Run by Example B.V., https://shop.example.test/imprint`;
const values = {
  items: '- Pinwheel: Poster (For <b>Mila</b> https://evil.example.test/), €39.95\n- Hello Mug: Mug, €20.95',
  saved: '',
  total: '€60.90',
  links: '- Pinwheel: https://pinwheel.example.test/order/1?a=1&b=2',
};
const look: import('./mailpage.ts').Look = {
  page: '<html lang="{lang}"><title>{subject}</title><body>{content}</body></html>',
  styles: { h2: 'color:#123', a: 'color:#8a5a14', small: 'font-size:14px' },
};
const head = { lang: 'en', subject: 'Your <order>' };

test('the text part is the words filled in, without the marks', () => {
  const { text, html } = mailpage.fill(WORDS, values, null, head);
  assert.equal(html, undefined, 'no look, no HTML part');
  assert.equal(
    text,
    `Thank you. Help: https://shop.example.test/help/.

What you ordered
- Pinwheel: Poster (For <b>Mila</b> https://evil.example.test/), €39.95
- Hello Mug: Mug, €20.95
You paid €60.90

Your pages
- The whole shop: https://shop.example.test/
- Pinwheel: https://pinwheel.example.test/order/1?a=1&b=2

Run by Example B.V., https://shop.example.test/imprint
`,
  );
});

test('the HTML part sets headings, lists, links and small print in the look', () => {
  const { html } = mailpage.fill(WORDS, values, look, head);
  assert.ok(html!.startsWith('<html lang="en"><title>Your &lt;order&gt;</title><body>'), html);
  assert.ok(html!.includes('<h2 style="color:#123">What you ordered</h2>'));
  assert.ok(
    html!.includes(
      'Help: <a href="https://shop.example.test/help/" style="color:#8a5a14">shop.example.test/help/</a>.</p>',
    ),
    'a link in the words, its full stop left outside',
  );
  assert.ok(html!.includes('<li><a href="https://shop.example.test/" style="color:#8a5a14">The whole shop</a></li>'));
  assert.ok(
    html!.includes(
      '<li><a href="https://pinwheel.example.test/order/1?a=1&amp;b=2" style="color:#8a5a14">Pinwheel</a></li>',
    ),
    "a slot's labelled link",
  );
  assert.ok(
    html!.includes('<li><strong>Hello Mug</strong>: Mug, €20.95</li></ul>\n<p>You paid €60.90</p>'),
    'its label in bold, then the words',
  );
  assert.ok(
    html!.includes('<p style="font-size:14px">Run by Example B.V., <a href="https://shop.example.test/imprint"'),
    'small print',
  );
  assert.doesNotMatch(html!, /\{saved\}|\n\n/, 'an empty slot leaves nothing');
});

test("a slot's words are escaped and never linked: they may be a customer's", () => {
  const { html } = mailpage.fill(WORDS, values, look, head);
  assert.ok(
    html!.includes(
      '<li><strong>Pinwheel</strong>: Poster (For &lt;b&gt;Mila&lt;/b&gt; https://evil.example.test/), €39.95</li>',
    ),
    html,
  );
  assert.doesNotMatch(html!, /href="https:\/\/evil/);
  const inline = mailpage.fill(
    'Dear {name}, https://shop.example.test/',
    { name: '<i>Noor</i> https://evil.example.test/' },
    look,
    head,
  );
  assert.ok(
    inline.html!.includes(
      'Dear &lt;i&gt;Noor&lt;/i&gt; https://evil.example.test/, <a href="https://shop.example.test/"',
    ),
    inline.html,
  );
});

test('a slot the sender names as its own link is linked, alone on its line or in one', () => {
  const words = 'Follow it:\n{tracking}\nOr here: {tracking}. Not {name}.';
  const linkValues = { tracking: 'https://track.example.test/3S?a=1&b=2', name: 'https://evil.example.test/' };
  const { text, html } = mailpage.fill(words, linkValues, look, head, ['tracking']);
  assert.equal(
    text,
    'Follow it:\nhttps://track.example.test/3S?a=1&b=2\nOr here: https://track.example.test/3S?a=1&b=2. Not https://evil.example.test/.\n',
  );
  const tracking =
    '<a href="https://track.example.test/3S?a=1&amp;b=2" style="color:#8a5a14">track.example.test/3S?a=1&amp;b=2</a>';
  assert.ok(
    html!.includes(`<p>Follow it:<br>${tracking}<br>Or here: ${tracking}. Not https://evil.example.test/.</p>`),
    html,
  );
  const notLink = mailpage.fill('{tracking}', { tracking: '<b>soon</b>' }, look, head, ['tracking']);
  assert.ok(
    notLink.html!.includes('<p>&lt;b&gt;soon&lt;/b&gt;</p>'),
    'a link slot without an https address stays words',
  );
  const ending = mailpage.fill('{tracking}', { tracking: 'https://track.example.test/parcel/(123)' }, look, head, [
    'tracking',
  ]);
  assert.ok(
    ending.html!.includes(
      '<a href="https://track.example.test/parcel/(123)" style="color:#8a5a14">track.example.test/parcel/(123)</a>',
    ),
    'the address is linked whole, closing bracket and all',
  );
});

test("a button: the label linking a link slot's address out of sight, the text part's address on its own line", () => {
  const words =
    'Your parcel:\n[Follow your parcel]: {tracking}\n[Help]: https://shop.example.test/help/\n[Not]: {name}';
  const linkValues = { tracking: 'https://track.example.test/3S?a=1&b=2', name: 'https://evil.example.test/' };
  const styled: typeof look = {
    ...look,
    styles: { ...look.styles, button: 'margin:4px 0', button_cell: 'background:#2a2352', button_link: 'color:#fffaf0' },
  };
  const { text, html } = mailpage.fill(words, linkValues, styled, head, ['tracking']);
  assert.equal(
    text,
    'Your parcel:\nFollow your parcel:\nhttps://track.example.test/3S?a=1&b=2\nHelp:\nhttps://shop.example.test/help/\nNot:\nhttps://evil.example.test/\n',
  );
  const button = (url: string, label: string) =>
    `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:4px 0"><tr><td style="background:#2a2352">` +
    `<a href="${url}" style="color:#fffaf0">${label}</a></td></tr></table>`;
  assert.ok(
    html!.includes(
      `<p>Your parcel:</p>\n${button('https://track.example.test/3S?a=1&amp;b=2', 'Follow your parcel')}\n` +
        `${button('https://shop.example.test/help/', 'Help')}\n<p>Not: https://evil.example.test/</p>`,
    ),
    html,
  );
  assert.ok(!html!.includes('>track.example.test'), 'the address itself out of sight');
  const notLink = mailpage.fill('[Follow]: {tracking}', { tracking: 'soon' }, look, head, ['tracking']);
  assert.ok(notLink.html!.includes('<p>Follow: soon</p>'), 'a link slot without an https address stays words');
});

test('a look file: none is plain text, a broken one says what to fix', () => {
  assert.equal(mailpage.readLook('care/none.yaml'), null);
  writeFileSync(`${REPO}/care/no-content.yaml`, 'page: "<html></html>"\n');
  assert.match(String(mailpage.readLook('care/no-content.yaml')), /a page with \{content\}/);
  writeFileSync(`${REPO}/care/bad-style.yaml`, 'page: "{content}"\nstyles: {p: [1]}\n');
  assert.match(String(mailpage.readLook('care/bad-style.yaml')), /styles, each a string/);
  writeFileSync(`${REPO}/care/broken.yaml`, 'page: [\n');
  assert.match(String(mailpage.readLook('care/broken.yaml')), /a page with \{content\}/);
  writeFileSync(`${REPO}/care/list.yaml`, '- page\n');
  assert.match(String(mailpage.readLook('care/list.yaml')), /a page with \{content\}/);
  writeFileSync(`${REPO}/care/look.yaml`, 'page: "<main>{content}</main>"\nstyles: {p: "margin:0"}\n');
  assert.deepEqual(mailpage.readLook('care/look.yaml'), { page: '<main>{content}</main>', styles: { p: 'margin:0' } });
});

test("a letter's signature: under the words when the page has no {signature}, its first line in bold, and never in the text", () => {
  const look = { page: '<main>{content}</main>', styles: { sign: 'color:#555' } };
  const { text, html } = mailpage.fill('Kind regards,', {}, look, {
    lang: 'en',
    subject: 'Hello',
    signature: 'Ada <Board>\nTestco\nhttps://www.testco.example',
  });
  assert.equal(text, 'Kind regards,\n');
  assert.equal(
    html,
    '<main><p>Kind regards,</p>\n<p style="color:#555"><strong>Ada &lt;Board&gt;</strong><br>Testco<br>' +
      '<a href="https://www.testco.example">testco.example</a></p></main>',
  );
  const slotted = mailpage.fill('Hi', {}, { page: '{content}|{signature}', styles: {} }, { lang: 'en', subject: 'x' });
  assert.equal(slotted.html, '<p>Hi</p>|');
});

test("receipt rows: a table in the HTML part (picture, name and details, price), each row's line in the text part, the words escaped", () => {
  const rows = [
    {
      text: '- Pinwheel: Poster (For <b>Mila</b>), €39.95',
      picture: 'https://pinwheel.example.test/api/orders/1/picture/k?a=1&b=2',
      name: 'Poster',
      details: ['For <b>Mila</b> https://evil.example.test/'],
      amount: '€39.95',
    },
    {
      text: '- Hello Mug: Mug, €20.95',
      picture: 'http://plain.example.test/mug.png',
      name: 'Mug',
      details: [],
      amount: '€20.95',
    },
  ];
  const words = 'Order 482 9173\n{items}\nYou paid {total}';
  const styled = {
    ...look,
    styles: { ...look.styles, rows: 'width:100%', row_img: 'width:72px', row_detail: 'color:#555' },
  };
  const { text, html } = mailpage.fill(words, { total: '€60.90' }, styled, head, [], { items: rows });
  assert.equal(
    text,
    'Order 482 9173\n- Pinwheel: Poster (For <b>Mila</b>), €39.95\n- Hello Mug: Mug, €20.95\nYou paid €60.90\n',
  );
  assert.ok(
    html!.includes(
      '<p>Order 482 9173</p>\n<table role="presentation" cellspacing="0" cellpadding="0" width="100%" style="width:100%"><tr><td width="86"><img src="https://pinwheel.example.test/api/orders/1/picture/k?a=1&amp;b=2" width="72" alt="" style="width:72px"></td><td><strong>Poster</strong><br><span style="color:#555">For &lt;b&gt;Mila&lt;/b&gt; https://evil.example.test/</span></td><td align="right">€39.95</td></tr><tr><td width="86"></td><td><strong>Mug</strong></td><td align="right">€20.95</td></tr></table>\n<p>You paid €60.90</p>',
    ),
    html,
  );
  // no rows: the line goes
  assert.equal(
    mailpage.fill(words, { total: '€0.00' }, null, head, [], { items: [] }).text,
    'Order 482 9173\nYou paid €0.00\n',
  );
});

// node --test shared/feed/feed.test.ts   (pure: items in, both feeds' text out)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { googleXml, openaiJsonl, type FeedItem, type Seller } from './feed.ts';

const seller: Seller = {
  name: 'Corner & Co',
  url: 'https://shop.example/',
  returnPolicy: 'https://shop.example/returns',
  acceptsReturns: false,
};
const eur = (amount: number) => ({ amount, currency: 'EUR' });
const mug = (changes: Partial<FeedItem> = {}): FeedItem => ({
  id: 'mug-2',
  title: 'Mug with your house, 2 mugs',
  description: 'A mug for tea & coffee <330 ml>.',
  link: 'https://shop.example/mug/',
  image: 'https://shop.example/mug.jpg',
  price: eur(3995),
  availability: 'in_stock',
  brand: 'Corner',
  shipping: [
    { country: 'NL', price: eur(0), handlingDays: [1, 1], transitDays: [1, 2] },
    { country: 'DE', price: eur(0), handlingDays: [1, 1], transitDays: [1, 3] },
  ],
  ...changes,
});
const sale = { price: eur(2995), from: '2026-11-16T00:00+01:00', until: '2026-11-30T23:59+01:00' };

test("Google's feed says a made-to-order item has no identifier, with its sale, shipping and days, its text escaped", () => {
  const xml = googleXml(seller, [mug({ sale })]);
  assert.match(xml, /<g:identifier_exists>no<\/g:identifier_exists>/);
  assert.match(xml, /<g:price>39\.95 EUR<\/g:price>/);
  assert.match(xml, /<g:sale_price>29\.95 EUR<\/g:sale_price>/);
  assert.match(
    xml,
    /<g:sale_price_effective_date>2026-11-16T00:00\+01:00\/2026-11-30T23:59\+01:00<\/g:sale_price_effective_date>/,
  );
  assert.match(xml, /<g:description>A mug for tea &amp; coffee &lt;330 ml&gt;\.<\/g:description>/);
  assert.match(xml, /<title>Corner &amp; Co<\/title>/);
  const toGermany =
    '<g:shipping><g:country>DE</g:country><g:price>0.00 EUR</g:price><g:min_handling_time>1</g:min_handling_time>' +
    '<g:max_handling_time>1</g:max_handling_time><g:min_transit_time>1</g:min_transit_time><g:max_transit_time>3</g:max_transit_time></g:shipping>';
  assert.ok(xml.includes(toGermany));
  assert.doesNotMatch(googleXml(seller, [mug({ gtin: '09506000134352' })]), /identifier_exists/);
});

test("Google's feed labels an AI-written title and description as such, in its structured form", () => {
  const xml = googleXml(seller, [mug({ aiWritten: true })]);
  const label = '<g:digital_source_type>trained_algorithmic_media</g:digital_source_type>';
  assert.ok(
    xml.includes(`<g:structured_title>${label}<g:content>Mug with your house, 2 mugs</g:content></g:structured_title>`),
  );
  assert.ok(
    xml.includes(
      `<g:structured_description>${label}<g:content>A mug for tea &amp; coffee &lt;330 ml&gt;.</g:content></g:structured_description>`,
    ),
  );
  assert.doesNotMatch(xml, /<g:title>|<g:description>/);
});

test("OpenAI's feed is one record per line, in its own names, with one shipping price only when every country pays it", () => {
  const lines = openaiJsonl(seller, [mug({ sale }), mug({ id: 'mug-1', availability: 'preorder' })])
    .trimEnd()
    .split('\n');
  const [first, second] = lines.map(line => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(first.item_id, 'mug-2');
  assert.equal(first.seller_name, 'Corner & Co');
  assert.equal(first.price, '39.95 EUR');
  assert.equal(first.sale_price, '29.95 EUR');
  assert.equal(first.shipping_price, '0.00 EUR');
  assert.equal(first.accepts_returns, false);
  assert.equal(first.gtin, undefined);
  assert.equal(second.availability, 'pre_order');
  const paidToGermany = mug({ shipping: [...mug().shipping.slice(0, 1), { ...mug().shipping[1], price: eur(495) }] });
  assert.equal(JSON.parse(openaiJsonl(seller, [paidToGermany])).shipping_price, undefined);
});

test('a pack is a variant for OpenAI, but grouped for Google only by its own variant attributes', () => {
  const byPack = mug({ group: { id: 'mug', options: { pack: '2 mugs' } } });
  const byColour = mug({ group: { id: 'mug', options: { color: 'Blue' } } });
  assert.doesNotMatch(googleXml(seller, [byPack]), /item_group_id/);
  assert.match(googleXml(seller, [byColour]), /<g:item_group_id>mug<\/g:item_group_id>\n<g:color>Blue<\/g:color>/);
  const record = JSON.parse(openaiJsonl(seller, [byPack]));
  assert.deepEqual(
    [record.group_id, record.listing_has_variations, record.variant_dict],
    ['mug', true, { pack: '2 mugs' }],
  );
});

test('an item either spec would refuse stops the feed', () => {
  assert.throws(() => googleXml(seller, [mug({ title: 'x'.repeat(151) })]), /title of 1 to 150/);
  assert.throws(
    () => openaiJsonl(seller, [mug({ sale: { ...sale, price: eur(3995) } })]),
    /sale price below its price/,
  );
  assert.throws(() => googleXml(seller, [mug({ image: '/mug.jpg' })]), /absolute URL/);
});

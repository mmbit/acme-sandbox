// node --test platform/hq/shell/previews.test.js   (which pages HQ's viewer takes for the company's previews; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewsOn, prototypeLink } from './previews.js';

const { page, deck } = previewsOn('hq.company.example', false);

test("a preview is a page on HQ's own zone, its origin exactly", () => {
  for (const url of [
    'https://teacups.preview.company.example/',
    'https://teacups.preview.company.example',
    'https://teacups.preview.company.example/p/2?x=1',
  ])
    assert.ok(page.test(url), url);
  for (const url of [
    'https://teacups.preview.elsewhere.example/',
    'https://teacups.preview.company.example.elsewhere.example/',
    'https://teacups.preview.companyXexample/',
    'https://teacups.preview.company.example:8443/',
    'https://teacups.preview.company.example@elsewhere.example/',
    'https://a.teacups.preview.company.example/',
    'http://teacups.preview.company.example/',
  ])
    assert.ok(!page.test(url), url);
});

test("a deck is the cycles' preview origin on HQ's own zone, and nothing that starts like it", () => {
  assert.ok(deck.test('https://cycles.preview.company.example'));
  for (const origin of [
    'https://cycles.preview.elsewhere.example',
    'https://cycles.preview.company.example.elsewhere.example',
    'https://teacups.preview.company.example',
  ])
    assert.ok(!deck.test(origin), origin);
});

test('HQ in dev mode, with no zone of its own, takes a preview on any', () => {
  const dev = previewsOn('127.0.0.1', true);
  assert.ok(dev.page.test('https://scrap.preview.test/basket'));
  assert.ok(dev.deck.test('https://cycles.preview.example.org'));
  assert.ok(!dev.page.test('https://scrap.example.test/'));
});

test("a call's prototype is a link on a call's host on HQ's own zone (any in dev mode)", () => {
  assert.ok(prototypeLink('https://call-12.preview.company.example/3/', 'hq.company.example', false));
  for (const link of [
    'https://call-12.preview.elsewhere.example/3/',
    'https://call-12.preview.company.example.elsewhere.example/3/',
    'https://teacups.preview.company.example/',
    'not a link',
    null,
  ])
    assert.ok(!prototypeLink(link, 'hq.company.example', false), link);
  assert.ok(prototypeLink('https://call-12.preview.test/3/', '127.0.0.1', true));
});

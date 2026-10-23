// node --test platform/hq/shell/emailtext.test.js   (an email's text as HQ shows it, as plain functions; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emailHtml } from './emailtext.js';

const links = html => [...html.matchAll(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map(([, href, shown]) => ({ href, shown }));

test('runs of empty and spacer-only lines show as one empty line', () => {
  assert.equal(emailHtml('Hi\n\n \n ​\n\n\nBye\n \n'), 'Hi\n\nBye');
});

test('a long link shows its own host and the start of its path, and goes to the whole address', () => {
  const tracker = `https://click.mailer.example/ls/click?upn=${encodeURIComponent('https://shop.example/a'.repeat(20))}`;
  const disguised = `https://paypal.example@evil.example/${'x'.repeat(60)}`;
  assert.deepEqual(links(emailHtml(`Track it: ${tracker}\nOr ${disguised}`)), [
    { href: tracker, shown: 'click.mailer.example/ls/…' },
    { href: disguised, shown: 'evil.example/…' },
  ]);
  assert.deepEqual(links(emailHtml('See https://shop.example/a?b=1&c=2.')), [{ href: 'https://shop.example/a?b=1&amp;c=2.', shown: 'https://shop.example/a?b=1&amp;c=2.' }]);
});

test('markup in and around an address stays text', () => {
  const html = emailHtml(`<b>hi</b> <https://x.example/'onmouseover=alert(1)'"onfocus=alert(2)> javascript:alert(3)`);
  assert.equal(html.replace(/<a href="[^"]*" target="_blank" rel="noopener noreferrer">[^<]*<\/a>/g, ''), '&lt;b&gt;hi&lt;/b&gt; &lt;&quot;onfocus=alert(2)&gt; javascript:alert(3)');
  assert.deepEqual(links(html), [{ href: 'https://x.example/&#39;onmouseover=alert(1)&#39;', shown: 'https://x.example/&#39;onmouseover=alert(1)&#39;' }]);
});

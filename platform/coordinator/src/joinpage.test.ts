// node --test src/joinpage.test.ts   (the join link's page as callouts.ts serves it: a throwaway repo and DATA_DIR; the
// page in a real browser is platform/hq/join-check.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repo = mkdtempSync(`${process.env.TMPDIR ?? tmpdir()}/joinpage-`);
mkdirSync(`${repo}/company`);
mkdirSync(`${repo}/theme/join`, { recursive: true });
writeFileSync(`${repo}/company/brand.yaml`, "name: Testco\ncolours: { blue: '#3366cc', gold: '#ffcc00' }\n");
const drawn = (part: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g data-part="${part}"/></svg>`;
writeFileSync(`${repo}/theme/join/ada.svg`, drawn('ours'));
writeFileSync(`${repo}/theme/join/eve.svg`, drawn('ours').replace('<g ', '<g onload="steal()" '));
process.env.REPO_DIR = repo;
process.env.DATA_DIR = `${repo}/.data`;
const { joinPage, joinAsset } = await import('./joinpage.ts');
test.after(() => rmSync(repo, { recursive: true, force: true }));

const view = (over: object = {}) => ({
  token: 'T'.repeat(43),
  lang: 'en' as const,
  agent: { id: 'ada', name: 'Ada' },
  company: 'Testco',
  words: undefined,
  privacy: 'https://shop.example/privacy#calls',
  until: '2026-10-17T15:00:00Z',
  ...over,
});

test('the page names the agent as an AI and gives the notice before joining, with the privacy link', () => {
  const { html, csp } = joinPage(view());
  assert.match(html, /Ada \(AI\) · Testco/);
  assert.match(html, /Ada is an AI assistant\. We keep a written transcript of this call, never a recording\./);
  assert.match(html, /href="https:\/\/shop\.example\/privacy#calls"/);
  assert.match(html, /data-ai-generated="true"/);
  assert.match(csp, /default-src 'none'; script-src 'self'; style-src 'sha256-[^']+'/);
  assert.doesNotMatch(html, /T{43}/, 'the token stays in the address, not in the page');
});

test("a company's own words replace the platform's, in the link's language; unknown keys and markup go nowhere", () => {
  const words = { notice: '{agent} is an AI. <b>{company}</b> keeps notes.', bogus: 'never shown' };
  const { html } = joinPage(view({ lang: 'de', words }));
  assert.match(html, /<html lang="de">/);
  assert.match(html, /Ada \(KI\) · Testco/);
  assert.match(html, /Ada is an AI\. &lt;b&gt;Testco&lt;\/b&gt; keeps notes\./);
  assert.doesNotMatch(html, /never shown/);
});

test("the agent's own drawing, or the platform's figure when it has none or one that could run script", () => {
  assert.match(joinPage(view()).html, /data-part="ours"/);
  for (const id of ['eve', 'nobody', '../company/brand']) {
    const { html } = joinPage(view({ agent: { id, name: 'Eve' } }));
    assert.doesNotMatch(html, /data-part="ours"|steal/);
    assert.match(html, /data-part="mouth-open"/);
  }
});

test("a walk-through link says what the agent sees and keeps, and asks with two buttons of equal weight; an ordinary link keeps today's words", () => {
  const walk = { url: 'https://shop.preview.example/start', hosts: ['https://shop.preview.example'], what: 'the shop' };
  const { html, csp } = joinPage(view({ walk }));
  assert.match(html, /A walk-through of the shop with Ada from Testco/);
  assert.match(html, /Ada is an AI assistant\. We keep a written transcript of this call, never its sound\./);
  assert.match(
    html,
    /Ada also sees our pages as you use them, never another tab or app\..*Pause stops it at any time\./,
  );
  const buttons = [...html.matchAll(/<button type="submit" class="([^"]+)"[^>]*>([^<]+)</g)].map(m => [m[1], m[2]]);
  assert.deepEqual(buttons, [
    ['join', 'Join and show our pages'],
    ['join', 'Join without showing them'],
  ]);
  // Enter in the name field must not choose: the form's first (default) button is disabled
  assert.match(html, /<form class="joinform"[^>]*>(?:(?!<button)[\s\S])*<button type="submit" hidden disabled/);
  assert.match(html, /<iframe class="walk" data-src="https:\/\/shop\.preview\.example\/start"/);
  // the page's own parts never reach a recording: only the frame is outside the hidden part
  assert.match(html, /<body[^>]*><div class="own" data-watchalong-hide>/);
  assert.match(html, /<\/div>\n<iframe class="walk"/);
  assert.match(csp, /frame-src 'self' https:\/\/shop\.preview\.example; style-src-attr/);
  assert.doesNotMatch(csp, /worker-src/); // (the join page draws no canvas: nothing to sample)

  const ordinary = joinPage(view());
  assert.match(ordinary.html, /never a recording\./);
  assert.doesNotMatch(ordinary.html, /<iframe class|class="notice watch"/);
  assert.equal([...ordinary.html.matchAll(/type="submit"/g)].length, 1);
  assert.doesNotMatch(ordinary.csp, /frame-src/);
  const dutch = joinPage(view({ walk, lang: 'nl' })).html;
  assert.match(dutch, /Een rondleiding door the shop/);
  assert.match(dutch, />Deelnemen en onze pagina’s laten zien<.*>Deelnemen zonder ze te laten zien</s);
  const german = joinPage(view({ walk, lang: 'de', words: { walkNotice: '{agent} ist eine KI.' } })).html;
  assert.match(german, /Ada ist eine KI\./);
  assert.match(german, />Beitreten und unsere Seiten zeigen<.*>Beitreten, ohne sie zu zeigen</s);
});

test("the assets are the page's scripts, the call's audio and microphone worklet, and a walk-through's bubble and recorder, nothing else", () => {
  for (const name of [
    'join.js',
    'figure.js',
    'people.js',
    'callaudio.js',
    'mic-worklet.js',
    'walk.js',
    'callbubble.js',
    'watchalong.js',
    'vendor/rrweb-record.js',
  ])
    assert.match(joinAsset(name)!.type, /^text\/javascript/);
  assert.match(joinAsset('mic-worklet.js')!.body, /registerProcessor\('mic'/);
  for (const name of ['../joinpage.ts', 'joinpage.ts', 'vendor/record.js', 'toString', '__proto__'])
    assert.equal(joinAsset(name), null);
});

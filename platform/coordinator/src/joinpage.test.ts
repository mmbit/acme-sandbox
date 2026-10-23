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

test("the assets are the page script, the drawing script, the call's audio and the microphone worklet, nothing else", () => {
  for (const name of ['join.js', 'figure.js', 'callaudio.js', 'mic-worklet.js'])
    assert.match(joinAsset(name)!.type, /^text\/javascript/);
  assert.match(joinAsset('mic-worklet.js')!.body, /registerProcessor\('mic'/);
  for (const name of ['../joinpage.ts', 'joinpage.ts', 'toString', '__proto__']) assert.equal(joinAsset(name), null);
});

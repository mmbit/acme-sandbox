#!/usr/bin/env node
// node platform/hq/talk-check.mjs: a live meeting's bubbles in Brownstone. The latest turn's lines show in turn over
// its speaker, a burst of newer turns skips to the newest, and a speaker's panel shows what they said whole.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serve } from './serve.mjs';
import { playwright, openPage } from '../../shared/browser/browser.mjs';

// the foundation's mock company and its meeting (a company's own mock org, served over it, has other people)
const mock = name => JSON.parse(readFileSync(new URL(`./mock/${name}.json`, import.meta.url), 'utf8'));
const org = mock('org'),
  meetings = mock('meetings'),
  meeting = meetings.live[0],
  latest = meeting.said.at(-1);
const turn = (id, agent, bubbles, text) => ({ id, at: meeting.started, agent, text, bubbles });
const burst = [
  turn(latest.id + 1, 'moss', ['An older point nobody should see'], 'Moss: an older point.'),
  turn(latest.id + 2, 'penny', ['The newest point shows straight away'], 'Penny: the newest point, whole.'),
];

const server = await serve(undefined, 0);
const base = `http://localhost:${server.address().port}`;
const browser = await playwright().chromium.launch();
try {
  const { context, page, errors } = await openPage(browser, { viewport: { width: 1280, height: 800 } });
  try {
    let live = meetings.live;
    await page.route('**/mock/org.json', route => route.fulfill({ json: org }));
    await page.route('**/mock/meetings.json', route => route.fulfill({ json: { ...meetings, live } }));
    await page.goto(`${base}/?intro=0&renderer=brownstone`);
    await page.waitForSelector('#loading.gone');
    await bubbleSays(page, latest.bubbles[0]);
    await bubbleSays(page, latest.bubbles[1]);
    assert.ok(!(await page.textContent('#bubbles')).includes(latest.bubbles[0]), 'one bubble at a time');
    await page.waitForTimeout(500); // (its pop-in)
    assert.ok(await page.locator('.bubble', { hasText: latest.bubbles[1] }).isVisible(), 'over its speaker');

    live = [{ ...meeting, said: [...meeting.said, ...burst] }];
    await bubbleSays(page, burst[1].bubbles[0]);
    assert.ok(!(await page.textContent('#bubbles')).includes(burst[0].bubbles[0]), 'the skipped turn never showed');

    await page.evaluate(async id => {
      const world = await import('/world/world.js');
      (await import('/shell/panel.js')).openAgent(world.agents.get(id));
    }, latest.agent);
    assert.match(await page.textContent('#panel .said'), /Said in the meeting/);
    assert.ok((await page.textContent('#panel .said .prose')).includes('until then the stems stay on the old mix'));
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
  console.log(
    "talk-check: a turn's lines in turn, a burst skipped to its newest, the speaker's whole text in the panel",
  );
} finally {
  await browser.close();
  server.close();
}

// Wait for the meeting bubble's own words, apart from the dev mode chatter.
async function bubbleSays(page, words) {
  await page.waitForFunction(w => [...document.querySelectorAll('.bubble span')].some(b => b.textContent === w), words);
}

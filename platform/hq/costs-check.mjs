// hq run --kind render -- node platform/hq/costs-check.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { serve } from './serve.mjs';
import { lookNames } from './looks.mjs';
import { playwright, openPage, tap, until } from '../../shared/browser/browser.mjs';
const board = JSON.parse(readFileSync(new URL('./mock/projects.json', import.meta.url)));
const project = board.projects.find(project => project.id === 'shop');
const thread = project.threads.find(thread => thread.id === 'shop/launch');
const spend = tokens => ({ tokens, seat_weeks: null });
thread.cost = {
  expected: { tokens: { work: 1000, reviews: 200, fixes: 100, feedback: 700 }, seat_weeks: 0.02 },
  used: {
    total: spend(1500),
    split: { work: spend(800), reviews: spend(200), fixes: spend(100), feedback: spend(400) },
    missing_usage: 0,
  },
  feedback_rounds: 1,
  approved: null,
};
project.cost = { expected_tokens: 2000, features: 1, missing_estimates: 0, used: thread.cost.used };
const details = JSON.parse(readFileSync(new URL('./mock/threads.json', import.meta.url)));
details[thread.id] = thread;
const files = {
  'mock/projects.json': JSON.stringify(board),
  'mock/threads.json': JSON.stringify(details),
};
const server = await serve(undefined, 0, files);
const browser = await playwright().chromium.launch();
const folder = '.data/cost-shots';
mkdirSync(folder, { recursive: true });
try {
  for (const look of lookNames())
    for (const [name, width, height] of [
      ['phone', 360, 800],
      ['tablet', 1024, 768],
    ]) {
      const { page, context, errors } = await openPage(browser, { viewport: { width, height } });
      await page.goto(`http://127.0.0.1:${server.address().port}/?intro=0&renderer=${look}`);
      await until(page, '#loading.gone');
      await tap(page, '#btn-projects');
      await until(page, '[data-business]');
      await tap(page, `[data-business="${project.business}"]`);
      await until(page, '[data-project="shop"]');
      await tap(page, '[data-project="shop"]');
      await until(page, '[data-thread="shop/launch"]');
      const tile = page.locator('.covered:has(> [data-thread="shop/launch"])');
      await tile.getByText(/Expected through approval: 2,000 tokens/).waitFor();
      assert.match(await tile.innerText(), /Recorded so far: 1,500 tokens/);
      await tile.getByText(/Recorded so far: 1,500 tokens/).scrollIntoViewIfNeeded();
      await page.waitForFunction(
        () =>
          !document
            .querySelector('#projects')
            .getAnimations({ subtree: true })
            .some(
              animation => animation.playState === 'running' && animation.effect.getTiming().iterations !== Infinity,
            ),
      );
      await page.screenshot({ path: `${folder}/${look}-${name}.png` });
      await tap(page, '[data-thread="shop/launch"]');
      await until(page, '.pj-brief', /Expected through approval: 2,000 tokens/);
      assert.match(await page.locator('.pj-brief').innerText(), /Board approval not recorded/);
      assert.deepEqual(errors, [], `${look}, ${name}`);
      await context.close();
      console.log(`Feature cost visible beside ETA: ${look}, ${name}`);
    }
} finally {
  await browser.close();
  server.close();
}

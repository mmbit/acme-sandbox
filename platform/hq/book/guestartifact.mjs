// Guest artifact marks through review mode and the real coordinator, with a synthetic artifact page.
import assert from 'node:assert/strict';
import { readyNotebook, snapshot } from './guestscreen.mjs';
import { serveWork } from './guestpath.mjs';

const artifactPage = `<!doctype html><meta name="viewport" content="width=device-width"><title>Basket</title>
<body style="margin:0;background:#fffaf0;color:#2a2352;font:18px system-ui,sans-serif">
<main style="padding:32px"><h1>Your basket</h1><p>Two jars of plum jam, gift-wrapped, ready by Friday.</p>
<button style="font:inherit;padding:16px">Collect the order</button></main>
<a class="pay" href="#pay" style="position:fixed;left:50%;bottom:16px;width:240px;margin-left:-120px;padding:14px 0;text-align:center;background:#2a2352;color:#fff">Pay now</a>
<script src="/__review/review.js"></script>`;

export async function artifactScrap(state, visitor, invitation, pageId, screen) {
  console.log(`Guest browser: artifact ${screen} opening`);
  const { page, context } = visitor;
  const notebookUrl = page.url();
  const host = `hello${state.preview}`;
  const artifactOrigin = `https://${host}`;
  await serveWork(state, context, host, artifactPage);
  await page.goto(state.origin + new URL(invitation).pathname);
  await page.locator('a[href$="/go"]').click();
  await page.waitForURL(`${artifactOrigin}/**`);
  await page.locator('review-mode .fab').waitFor({ state: 'attached' });
  await payClear(page);
  await page.locator('review-mode .fab').dispatchEvent('click');
  await page.locator('review-mode .veil:not([hidden])').waitFor();
  await drawMark(page);
  const sheet = page.locator('review-mode .sheet');
  await sheet.waitFor({ state: 'visible' });
  await page.locator('review-mode .polaroid:not(.busy) .img :is(img,canvas)').waitFor();
  await sheet.locator('textarea').fill(`Say when it ships, ${screen}`);
  await snapshot(state, `artifact-${screen}`, page);
  console.log(`Guest browser: artifact ${screen} saving`);
  const sent = page.waitForResponse(
    response => response.url().endsWith('/__review/notes') && response.request().method() === 'POST',
  );
  await sheet.locator('.send').dispatchEvent('click');
  const response = await sent;
  console.log(`Guest browser: artifact ${screen} browser response received`);
  assert.equal(response.status(), 200, 'the artifact scrap is accepted');
  console.log(`Guest browser: artifact ${screen} saved`);
  const posted = response.request().postDataJSON();
  assert.match(posted.shot, /^data:image\/(png|jpeg);base64,/);
  assert.ok(posted.element.ink.length > 0, 'the artifact scrap keeps the drawn mark');
  const groups = (await state.h.board(`/api/notebooks/guests/groups?page=${pageId}`)).body.groups;
  assert.ok(
    groups.some(group => group.kind === 'scrap' && group.words === `Say when it ships, ${screen}`),
    'the artifact scrap lands on this reviewer’s page',
  );
  // (the preview's caption is the way back to the reviewer's round page)
  const roundBook = new URL(notebookUrl).searchParams.get('notebook');
  await page.locator('review-mode a.back').click();
  await page.waitForURL(url => url.pathname === '/guest/notebooks/' && url.searchParams.get('notebook') === roundBook);
  await readyNotebook(page);
  await page
    .locator('#book .bk-words')
    .filter({ hasText: `Say when it ships, ${screen}` })
    .waitFor();
  await snapshot(state, `reviewer-notebook-${screen}`, page);
  console.log(`Guest browser: artifact ${screen} visible in notebook`);
}

// The page's own bottom button stays tappable: the pin and its caption step up clear of it
function payClear(page) {
  return page.waitForFunction(() => {
    const pay = document.querySelector('.pay'),
      b = pay.getBoundingClientRect();
    return [0.05, 0.25, 0.5, 0.75, 0.95].every(f =>
      pay.contains(document.elementFromPoint(b.left + b.width * f, b.top + b.height / 2)),
    );
  });
}

async function drawMark(page) {
  const { x, y, width, height } = await page.locator('main button').boundingBox();
  const loop = Array.from({ length: 33 }, (_, index) => {
    const angle = (index * Math.PI) / 16;
    return [x + width / 2 + (width / 2 + 8) * Math.cos(angle), y + height / 2 + (height / 2 + 8) * Math.sin(angle)];
  });
  await page.mouse.move(...loop[0]);
  await page.mouse.down();
  for (const point of loop.slice(1)) await page.mouse.move(...point);
  await page.mouse.up();
}

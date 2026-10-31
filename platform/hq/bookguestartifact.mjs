// Guest artifact marks through review mode and the real coordinator, with a synthetic artifact page.
import assert from 'node:assert/strict';
import { fulfilResponse } from './bookguestserver.mjs';
import { readyNotebook, snapshot } from './bookguestscreen.mjs';

const artifactPage = `<!doctype html><meta name="viewport" content="width=device-width"><title>Basket</title>
<body style="margin:0;background:#fffaf0;color:#2a2352;font:18px system-ui,sans-serif">
<main style="padding:32px"><h1>Your basket</h1><p>Two jars of plum jam, gift-wrapped, ready by Friday.</p>
<button style="font:inherit;padding:16px">Collect the order</button></main><script src="/__review/review.js"></script>`;

export async function artifactScrap(state, visitor, invitation, pageId, screen) {
  console.log(`Guest browser: artifact ${screen} opening`);
  const { page, context } = visitor;
  const notebookUrl = page.url();
  const host = `hello${state.preview}`;
  const artifactOrigin = `https://${host}`;
  await serveArtifact(state, context, host);
  await page.goto(state.origin + new URL(invitation).pathname);
  await page.locator('a[href$="/go"]').click();
  await page.waitForURL(`${artifactOrigin}/**`);
  await page.locator('review-mode .fab').waitFor({ state: 'attached' });
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
  await page.goto(notebookUrl);
  await readyNotebook(page);
  await page
    .locator('#book .bk-words')
    .filter({ hasText: `Say when it ships, ${screen}` })
    .waitFor();
  await snapshot(state, `reviewer-notebook-${screen}`, page);
  console.log(`Guest browser: artifact ${screen} visible in notebook`);
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

async function serveArtifact(state, context, host) {
  const artifactOrigin = `https://${host}`;
  await context.route(`${artifactOrigin}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/__review/') && url.pathname !== '/__preview') {
      return route.fulfill({ contentType: 'text/html', body: artifactPage });
    }
    const response = await route.fetch({
      url: state.h.base + url.pathname + url.search,
      headers: { ...request.headers(), host },
      maxRedirects: 0,
      timeout: 30_000,
    });
    return fulfilResponse(route, response);
  });
}

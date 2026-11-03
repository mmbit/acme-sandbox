// node platform/hq/book-check.mjs --stories 'page downloads keep the call' [--webkit] [--shots dir]
import assert from 'node:assert/strict';
import { playLine } from './call.mjs';
import { MINI, UPRIGHT, until } from './kit.mjs';
import { dragTo, tearOffMenu } from './tearing.mjs';

// how long a finger rests on the target before it lifts
const REST_MS = 400;
import { watchedPage } from './start.mjs';

export function downloadStories(c) {
  return Object.fromEntries(
    [MINI, UPRIGHT].map(viewport => [
      `page downloads keep the call connected at ${viewport.width} × ${viewport.height}`,
      browser => duringCall(browser, c, viewport),
    ]),
  );
}

async function duringCall(browser, c, viewport) {
  const context = await c.hqIn(browser, viewport, { hasTouch: true, acceptDownloads: true, notebooks: {} });
  const line = await playLine(context);
  await downloadEnvironment(context, c);
  const { page, errors } = await watchedPage(context);
  try {
    await page.goto(`${c.base}/?intro=0&open=intercom&renderer=brownstone`);
    await page.waitForSelector('#loading.gone');
    await page.locator('#call').tap();
    await page.waitForFunction(() => !document.querySelector('#call-screenshare')?.disabled);
    await until(() => line.audioBytes > 0, 'microphone samples arriving on the call');
    await page.locator('#call-min').tap();
    await page.waitForSelector('#call-layer', { state: 'hidden' });
    if (await page.evaluate(() => document.documentElement.dataset.book === 'folded'))
      await page.locator('#book .bk-lip').tap();
    await c.settled(page, viewport === MINI ? 'open' : 'spread');
    const changes = { tabs: 0, navigations: 0, closed: 0 };
    context.on('page', () => changes.tabs++);
    page.on('framenavigated', frame => frame === page.mainFrame() && changes.navigations++);
    page.on('close', () => changes.closed++);
    const socket = line.ws;
    for (const gesture of ['drag', 'menu']) {
      for (const kind of ['png', 'pdf']) {
        await savePage(page, kind, gesture, c.SNIP);
        await stillTalking(page, line, `${gesture} ${kind}`);
        assert.equal(line.ws, socket, 'the original call connection stays open');
        assert.deepEqual(changes, { tabs: 0, navigations: 0, closed: 0 }, 'HQ stays in its own tab');
        assert.equal(await page.evaluate(() => window.shareSheets), 0, 'no share sheet opens');
      }
    }
    await finishCall(page, c, viewport);
    c.noErrorsIn(errors);
  } finally {
    await context.close();
  }
}

async function finishCall(page, c, viewport) {
  if (viewport === UPRIGHT) {
    await page.locator('#book .bk-lip').tap();
    await c.settled(page, 'folded');
  }
  await page.locator('.cb-face').tap();
  await page.waitForSelector('#call-layer', { state: 'visible' });
  await page.waitForSelector('.callbubble', { state: 'detached' });
  await page.waitForFunction(() =>
    document
      .querySelector('#call-layer .device')
      .getAnimations()
      .every(a => a.playState === 'finished'),
  );
  await c.shot(`downloads-call-${viewport.width}`, page);
  await page.locator('#call-end').tap();
  await page.waitForSelector('#call-layer', { state: 'detached' });
}

async function downloadEnvironment(context, c) {
  await context.route(`${c.base}/api/book/picture**`, r =>
    r.fulfill({ contentType: 'image/png', body: Buffer.from(c.SNIP.split(',')[1], 'base64') }),
  );
  await context.addInitScript(() => {
    window.shareSheets = 0;
    navigator.canShare = () => true;
    navigator.share = async () => {
      window.shareSheets++;
    };
    const microphone = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia = async () => {
      const stream = await microphone();
      window.callTrack = stream.getAudioTracks()[0];
      return stream;
    };
  });
}

async function savePage(page, kind, gesture, picture) {
  const pressed = async () => {
    // (the finger rests on its target before it lifts: one lifted still moving starts Chromium's fling, which swallows
    // the next tap's click; Safari has no fling where nothing scrolls)
    if (gesture === 'drag') await dragTo(page, 'touch', kind, () => page.waitForTimeout(REST_MS));
    else await (await tearOffMenu(page, 'tap')).locator(`[data-share=${kind}]`).tap();
  };
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15_000 }), pressed()]);
  assert.equal(await download.failure(), null, 'the browser completes its download');
  assert.ok(download.suggestedFilename().endsWith(`.${kind}`), 'the file keeps its format and name');
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  if (kind === 'png') assert.deepEqual(bytes, Buffer.from(picture.split(',')[1], 'base64'), 'the saved page picture');
  else {
    const pdf = bytes.toString('latin1');
    assert.ok(pdf.startsWith('%PDF-1.4'), 'a PDF file');
    assert.match(pdf, /\/Count 1/, 'the whole picture on one PDF page');
    assert.ok(pdf.trimEnd().endsWith('%%EOF'), 'the PDF is complete');
  }
}

async function stillTalking(page, line, words) {
  const before = line.audioBytes;
  await until(() => line.audioBytes > before, 'more microphone samples after the download');
  assert.equal(await page.evaluate(() => window.callTrack.readyState), 'live', 'the call keeps its microphone');
  line.send({ type: 'heard', text: `Still here after ${words}` });
  await page.locator('#call-lines', { hasText: `Still here after ${words}` }).waitFor({ state: 'attached' });
}

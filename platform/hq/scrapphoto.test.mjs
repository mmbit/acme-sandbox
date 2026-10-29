// node --test platform/hq/scrapphoto.test.mjs
// A scrap's photo of Holo: review mode's screenshot reads the stage's canvas outside the frame that drew it, where a
// WebGL canvas kept nothing (shared/review/copy.js asks the canvas's owner first, `snapshot:draw` on the canvas). Holo
// draws its last frame again for it: the photo isn't black, and the camera, mid-move, hasn't moved for it
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from './serve.mjs';
import { launched, openPage } from '../../shared/browser/browser.mjs';

const server = await serve(undefined, 0),
  base = `http://localhost:${server.address().port}`;
// (WebGL on SwiftShader, as screens-check.mjs has it; where Playwright or its Chromium isn't installed the test is
// skipped, saying so)
const browser = await launched({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const noChromium = browser ? false : 'no Playwright or no Chromium for it here';
test.after(async () => {
  await browser?.close();
  server.closeAllConnections();
  server.close();
});

test("a scrap's photo of Holo shows the deck, and the camera stays where it was", { skip: noChromium }, async () => {
  const { context, page, errors } = await openPage(browser, { viewport: { width: 800, height: 600 } });
  await page.goto(`${base}/?intro=0&renderer=holo`);
  // (Holo booted in about 3 s on SwiftShader at a worker's load of 14, 29 Oct: the rest is room for a busier one)
  await page.waitForFunction(() => window.hq?.cam, null, { timeout: 60_000 });
  const shot = await page.evaluate(async () => {
    const { cam, tick } = window.hq,
      canvas = document.querySelector('#world');
    window.hq.world.paused = true;
    // the camera on its way somewhere, as the screenshot's task finds it between a step of the loop and its frame: a
    // frame drawn (the one to paint again), then a step, which leaves the camera's move to the next frame (scene.js
    // draw): a photo painted as a whole frame would make it
    cam.goal = { yaw: cam.yaw + 1, pitch: cam.pitch, dist: cam.dist, at: [...cam.at] };
    window.hq.frame(1);
    tick(1 / 60, 1);
    await new Promise(r => setTimeout(r, 100));
    const where = () => JSON.stringify([cam.yaw, cam.pitch, cam.dist, cam.at, cam.shift]),
      before = where();
    canvas.dispatchEvent(new Event('snapshot:draw'));
    const photo = new Image();
    photo.src = canvas.toDataURL();
    await photo.decode();
    const copy = new OffscreenCanvas(photo.width, photo.height).getContext('2d');
    copy.drawImage(photo, 0, 0);
    const px = copy.getImageData(0, 0, photo.width, photo.height).data;
    let lit = 0;
    for (let i = 0; i < px.length; i += 4) if (Math.max(px[i], px[i + 1], px[i + 2]) > 40) lit++;
    return { lit: lit / (px.length / 4), moved: where() !== before };
  });
  assert.ok(shot.lit > 0.01, `the photo shows the deck (${(shot.lit * 100).toFixed(2)}% of it lit)`);
  assert.equal(shot.moved, false, 'the camera stays where the last frame left it');
  assert.deepEqual(errors, []);
  await context.close();
});

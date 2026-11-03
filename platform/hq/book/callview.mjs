// Call window transitions shared by Notebook browser stories.
export async function minimiseCall(page, mouse = false) {
  const button = page.locator('#call-min');
  if (mouse) await button.click();
  else await button.tap();
  await page.waitForSelector('#call-layer', { state: 'hidden' });
  await page.waitForSelector('.callbubble');
  await callAtRest(page, '.callbubble');
}

export async function openSmallCall(page) {
  await page.waitForSelector('#call-layer', { state: 'hidden' });
  await page.locator('.cb-face').tap();
  await page.waitForSelector('#call-layer', { state: 'visible' });
  await page.waitForSelector('.callbubble', { state: 'detached' });
  await callAtRest(page, '#call-layer .device');
}

async function callAtRest(page, selector) {
  await page.waitForFunction(
    selector =>
      document
        .querySelector(selector)
        .getAnimations()
        .every(a => a.playState === 'finished'),
    selector,
  );
}

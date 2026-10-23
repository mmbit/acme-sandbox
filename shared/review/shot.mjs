// One picture of a page held like a phone, for a card's before-and-after pair.
//   node shared/review/shot.mjs <url | /path> <out.jpg | .png> [--selector "css"] [--hide "css"] [--width 390]
// --selector crops to that element, a margin around it; --hide hides what floats over it (a sticky header). A product's
// preview: run it under `hq preview <slug> --`, which gives the pass (HQ_PREVIEW_URL, HQ_PREVIEW_COOKIE), and a /path is
// that preview's page. Shoot the before and the after with the same arguments, so the two match.
import { args, playwright } from '../demo/core.mjs';
import { authenticatePreview } from '../demo/preview.mjs';

const {
  _: [url, out],
  ...flags
} = args();
if (!url || !/\.(?:jpe?g|png)$/i.test(out ?? ''))
  throw new Error(
    'usage: node shared/review/shot.mjs <url | /path> <out.jpg | .png> [--selector css] [--hide css] [--width 390]',
  );
const target = url.startsWith('/') ? new URL(url, process.env.HQ_PREVIEW_URL ?? '').href : url;
const width = Number(flags.width ?? 390),
  { selector, hide } = flags;
const MARGIN = 12; // CSS pixels of the page around the element, so its edge isn't cut

const browser = await playwright().chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width, height: Math.round(width * 2.16) },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
  });
  await authenticatePreview(context, target);
  const page = await context.newPage();
  const answer = await page.goto(target, { waitUntil: 'networkidle' });
  if (!answer?.ok()) throw new Error(`${target} answered ${answer?.status()}`);
  if (hide) await page.addStyleTag({ content: `${hide} { visibility: hidden !important; }` });
  await page.evaluate(() => document.fonts.ready);
  const type = /\.png$/i.test(out) ? 'png' : 'jpeg';
  const shot = { path: out, type, ...(type === 'jpeg' && { quality: 82 }), animations: 'disabled' };
  if (!selector) await page.screenshot(shot);
  else {
    const box = await page.locator(selector).first().boundingBox();
    if (!box) throw new Error(`${selector} isn't on ${target}, or it isn't shown`);
    const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
    const x = Math.max(0, box.x + scroll.x - MARGIN),
      y = Math.max(0, box.y + scroll.y - MARGIN);
    await page.screenshot({
      ...shot,
      fullPage: true,
      clip: { x, y, width: Math.min(width - x, box.width + 2 * MARGIN), height: box.height + 2 * MARGIN },
    });
  }
  console.log(`${out}: ${target}${selector ? `, ${selector}` : ''}, ${width} px wide`);
} finally {
  await browser.close();
}

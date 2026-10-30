// HQ in dev mode on an iPad mini in a real browser, with the profiler (shared/profile) on from its first script: the
// page profile-session.mjs and profile-pull.mjs measure.
import { readFile } from 'node:fs/promises';
import { serve, ROOT } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';

export const SAMPLE_MS = 5000; // (the profiler's own is 20 s: a session here is minutes, not hours)
export const IPAD_MINI = { viewport: { width: 1133, height: 744 }, deviceScaleFactor: 2, hasTouch: true };

// HQ open in this look and loaded. samples fills with the profiler's samples as the page sends them. initScripts run
// after the profiler's, before HQ's own. cdp is Chromium's DevTools session on the page (null in WebKit).
export async function openProfiled({ engine, look, initScripts = [] }) {
  // (the profiler reads its sample and send times from window.__profileTimes)
  const profiler =
    `window.__profileTimes = { sampleMs: ${SAMPLE_MS}, sendMs: ${SAMPLE_MS} };\n` +
    (await readFile(`${ROOT}/shared/profile/profile.js`, 'utf8'));
  const server = await serve();
  const browser = await playwright()[engine].launch();
  const { context, page, errors } = await openPage(browser, IPAD_MINI);
  const samples = [];
  await context.route('**/__review/profile', route => {
    samples.push(...JSON.parse(route.request().postData()).samples);
    return route.fulfill({ json: { kept: 1 } });
  });
  for (const script of [profiler, ...initScripts]) await context.addInitScript(script);
  const cdp = engine === 'chromium' ? await context.newCDPSession(page) : null;
  await page.goto(`http://localhost:${server.address().port}/?intro=0&renderer=${look}`);
  await until(page, '#loading.gone');
  const close = async () => {
    await browser.close();
    server.close();
  };
  return { page, errors, samples, cdp, close };
}

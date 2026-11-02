// The real coordinator behind private HTTPS browser origins, with no requests outside the test server.
import { fakeLettermint } from '../coordinator/src/fixture.ts';
import { harness } from '../coordinator/src/harness.ts';
import { openPage } from '../../shared/browser/browser.mjs';
import { routeOrigin } from './originroute.mjs';

export async function coordinator() {
  const h = await harness('guest-notebook-browser', { env: { PUBLIC_HOST: 'hq.company.test' } });
  const mail = await fakeLettermint();
  mail.on();
  // This throwaway DATA_DIR holds only synthetic PNGs. Keep real allocation checks without the production 5 GB reserve.
  (await import('../coordinator/src/storage.ts')).FLOOR.bytes = 0;
  const { ORIGIN, PREVIEW } = await import('../coordinator/src/config.ts');
  return { h, mail, origin: ORIGIN, preview: PREVIEW };
}

export async function openVisitor(state, viewport, cookie = '', browser = state.browser, video = false) {
  const opened = await openPage(browser, {
    viewport,
    ignoreHTTPSErrors: true,
    hasTouch: true,
    ...(video && state.shots ? { recordVideo: { dir: state.shots, size: viewport } } : {}),
  });
  // Review mode keeps its UI in a closed shadow root. The browser check opens that root to press its real controls.
  await opened.context.addInitScript(() => {
    const attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) {
      return attachShadow.call(this, { ...options, mode: 'open' });
    };
  });
  await routeOrigin(opened.context, state.origin, state.h.base);
  if (cookie) {
    const [name, value] = cookie.split('=');
    await opened.context.addCookies([{ name, value, url: state.origin }]);
  }
  opened.diagnostics = [];
  opened.page.on('console', message => {
    if (message.type() === 'error') opened.diagnostics.push(message.text());
  });
  opened.page.on('requestfailed', request =>
    opened.diagnostics.push(`${request.url()}: ${request.failure()?.errorText}`),
  );
  state.opened.push(opened);
  return opened;
}

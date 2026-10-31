// The real coordinator behind private HTTPS browser origins, with no requests outside the test server.
import { request as forwardRequest } from 'node:http';
import { fakeLettermint } from '../coordinator/src/fixture.ts';
import { harness } from '../coordinator/src/harness.ts';
import { openPage } from '../../shared/browser/browser.mjs';

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
  await opened.context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== state.origin) {
      if (/^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) return route.fallback();
      return route.abort('blockedbyclient');
    }
    if (url.pathname === '/api/events') return streamFrame(state, route, url);
    const response = await route.fetch({
      url: state.h.base + url.pathname + url.search,
      headers: { ...request.headers(), host: url.host },
      maxRedirects: 0,
      timeout: 30_000,
    });
    return fulfilResponse(route, response);
  });
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

// Browser interception does not follow a redirected network request. A fresh navigation follows the real Location,
// with the real Set-Cookie, so every hop still reaches the coordinator and retains its browser origin.
export async function fulfilResponse(route, response) {
  const headers = response.headers();
  if (response.status() >= 300 && response.status() < 400 && headers.location) {
    const target = new URL(headers.location, route.request().url()).href
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;');
    return route.fulfill({
      status: 200,
      headers: {
        ...(headers['set-cookie'] ? { 'set-cookie': headers['set-cookie'] } : {}),
        'content-type': 'text/html',
      },
      body: `<meta http-equiv="refresh" content="0;url=${target}">`,
    });
  }
  const body = await response.body();
  // APIRequestContext decoded the body. Let fulfillment calculate its length without compressed transport headers.
  delete headers['content-encoding'];
  delete headers['transfer-encoding'];
  delete headers['content-length'];
  await route.fulfill({ status: response.status(), headers, body });
}

// Only the board's unused SSE transport is shortened: its first actual frame, never a fabricated event. The guest
// notebook and the board's watcher both keep reading changes through their real HTTP polling routes.
async function streamFrame(state, route, url) {
  const response = await new Promise((resolve, reject) => {
    const request = forwardRequest(
      state.h.base + url.pathname,
      { headers: { ...route.request().headers(), host: url.host }, timeout: 30_000 },
      incoming => {
        incoming.once('data', body => {
          resolve({ status: incoming.statusCode, headers: incoming.headers, body });
          incoming.destroy();
        });
        incoming.on('error', reject);
      },
    );
    request.on('timeout', () =>
      request.destroy(new Error('The coordinator sent no initial event frame within 30 seconds')),
    );
    request.on('error', reject);
    request.end();
  });
  return route.fulfill({ status: response.status, headers: response.headers, body: response.body });
}

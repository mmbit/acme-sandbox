// A browser context's requests to a coordinator's own origin (its PUBLIC_HOST), answered by that coordinator on a local
// port: the page sees HQ's real address, cookies and Origin, and nothing leaves the test server but Google Fonts.
// guestserver.mjs and screens-shots.mjs open HQ this way.
import { request as forwardRequest } from 'node:http';

// origin: the coordinator's ORIGIN; base: where it listens (harness.ts h.base)
export async function routeOrigin(context, origin, base) {
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      if (/^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) return route.fallback();
      return route.abort('blockedbyclient');
    }
    if (url.pathname === '/api/events') return streamFrame(base, route, url);
    const response = await route.fetch({
      url: base + url.pathname + url.search,
      headers: { ...request.headers(), host: url.host },
      maxRedirects: 0,
      timeout: 30_000,
    });
    return fulfilResponse(route, response);
  });
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

// Only the board's SSE transport is shortened: its first actual frame, never a fabricated event. The pages keep
// reading changes through their real HTTP polling routes.
async function streamFrame(base, route, url) {
  const response = await new Promise((resolve, reject) => {
    const request = forwardRequest(
      base + url.pathname,
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

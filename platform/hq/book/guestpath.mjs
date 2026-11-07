// The guest path's steps its checks share (guestshelf-check.mjs, guestlooks-check.mjs, guestartifact.mjs): the work
// on a stand-in page with the real coordinator's review mode, the board's Share on it in HQ's viewer, a guest's
// email-code sign-in by their link and a page closed (a typed note: guestscreen.mjs's addNote.). state: guestserver.mjs's (h, mail, origin, opened).
import assert from 'node:assert/strict';
import { fulfilResponse } from './originroute.mjs';
import { readyHQ } from './invitechecks.mjs';
import { until } from '../../../shared/browser/browser.mjs';

export const joinPage = `<!doctype html><meta name="viewport" content="width=device-width"><title>Join the crew</title>
<body style="margin:0;background:#fffaf0;color:#2a2352;font:18px system-ui,sans-serif">
<main style="padding:32px"><h1>Join the crew</h1><p>Sign up for the first launch.</p>
<label>Email<br><input style="font:inherit;width:80%;padding:10px"></label><p><button style="font:inherit;padding:14px 28px">Sign up</button></p>
</main><script src="/__review/review.js"></script>`;

// The work: a stand-in page on the product's preview host, its review mode and hand-off from the real coordinator
export async function serveWork(state, context, host, html = joinPage) {
  await context.route(`https://${host}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/__review/') && url.pathname !== '/__preview')
      return route.fulfill({ contentType: 'text/html', body: html });
    const response = await route.fetch({
      url: state.h.base + url.pathname + url.search,
      headers: { ...request.headers(), host },
      maxRedirects: 0,
      timeout: 30_000,
    });
    return fulfilResponse(route, response);
  });
}

// The board on the work in HQ's viewer, its Share open
export async function openShare(state, page, host) {
  await page.goto(`${state.origin}/?intro=0`);
  await readyHQ(page);
  await page.evaluate(async url => {
    (await import('/shell/ink/book.js')).foldBook();
    (await import('/shell/desk.js')).openLink(url);
  }, `https://${host}/`);
  await page.locator('#viewer .bar .more').click(); // (Share under More options.)
  await page.locator('#viewer .options .share').click();
  await page.locator('#viewer .sharebox form.invite').waitFor();
}
export async function addPerson(page, name, email) {
  await page.locator('#viewer .sharebox form.invite [name=name]').fill(name);
  await page.locator('#viewer .sharebox form.invite [name=email]').fill(email);
  await page.locator('#viewer .sharebox form.invite [type=submit]').click();
  await until(page, '#viewer .sharebox .invites ul', new RegExp(name));
}

// A guest's link opened, the code sent by email typed in
export async function signInByMail(state, page, link) {
  const path = new URL(link).pathname;
  await page.goto(state.origin + path);
  await page.locator(`form[action="${path}/send"] button`).click();
  await page.locator('#code').waitFor();
  const code = /: (\d{6})/.exec(state.mail.taken.at(-1)?.text)?.[1];
  assert.ok(code, 'the sign-in code came by email');
  await page.locator('#code').fill(code);
  await page.locator(`form[action="${path}/verify"] button`).click();
}

// A page done with: its routes let go first, so a request still on its way when it closes answers nothing
export async function close(state, visitor) {
  await visitor.context.unrouteAll({ behavior: 'ignoreErrors' });
  await visitor.context.close();
  state.opened.splice(state.opened.indexOf(visitor), 1);
}

// A link for another device: a page's own link a phone opens from its QR code.
// A preview (<slug>.preview.<zone>) lets in only the board and the people it shared it with, so there the platform makes
// it a one-time link, good for 15 minutes, that gives the phone this page's access on this host for an hour. Anywhere
// else the link stays as it is. Import it by its path in the repo (from a product's app/public/,
// '../../../../shared/handoff/handoff.js').

// → the link for the other device. On a preview it throws when the platform gives none: the plain link would send the
// phone to the sign-in, as if it were a working one.
export async function linkForAnotherDevice(link) {
  const url = new URL(link, location.href);
  if (url.origin !== location.origin || !location.hostname.split('.').includes('preview')) return url.href;
  const response = await fetch('/__preview/handoff', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: url.pathname + url.search }),
    cache: 'no-store',
  });
  const answer = response.ok ? await response.json() : {};
  if (typeof answer.url !== 'string' || !answer.url.startsWith(`${location.origin}/__preview?`))
    throw new Error('no link for another device');
  // the #fragment stays on the device: the hand-off's redirect keeps it
  return answer.url + url.hash;
}

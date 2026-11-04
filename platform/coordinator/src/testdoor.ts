// A guest's way in, for the harness: their link's door signed in, and the cookie a reply sets
import assert from 'node:assert/strict';
import type { Sent } from './harness.ts';

type PostForm = (path: string, fields: Record<string, string>, from: string) => Promise<Sent>;
// postForm: the harness's, a form as a guest's browser posts it
export function testDoor(postForm: PostForm) {
  let guests = 0;
  // A guest signed in at their link's door, from the client Caddy names (a new one unless from): the code the door
  // sends, as codeOf reads it from the door's reply or the email, then checked. g: their session cookie
  const guestIn = async (link: string, codeOf: (sent: Sent) => string, from = `192.0.2.${++guests}`) => {
    const path = new URL(link).pathname;
    const sent = await postForm(`${path}/send`, {}, from);
    assert.equal(sent.status, 200, sent.text);
    const verified = await postForm(`${path}/verify`, { code: codeOf(sent) }, from);
    assert.equal(verified.status, 303, verified.text);
    return { g: cookieOf(verified), path };
  };
  return { guestIn };
}
// A reply's first cookie as a browser sends it back
export const cookieOf = (r: Sent) => r.headers['set-cookie'][0].split(';')[0];

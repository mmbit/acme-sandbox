// A call's prototypes: throwaway pages its agent or a job it queued makes to show an idea, saved here with a picture,
// a clip on the call's page and a card on both iPads, and served on the call's own preview host to the board and its
// guest while the call is on (knowledge/notes/platform/call-prototypes.md)
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import sharp from 'sharp';
import { launch, type Tab } from '../../../shared/chromium/chromium.ts';
import { DATA_DIR, ORIGIN } from './config.ts';
import { db } from './db.ts';
import { publish } from './events.ts';
import * as feedback from './feedback.ts';
import * as guests from './guests.ts';
import { queuedHere } from './call.ts';
import { exclude } from './latency.ts';
import { boardOn, cookie } from './preview.ts';
import * as shares from './shares.ts';
import { typeOf } from './types.ts';
import { keepFile } from './uploads.ts';
import { decoded, numbered, opened } from './versionhost.ts';
import { BOARD } from './ink/book.ts';
import { addSlip } from './ink/bookslips.ts';
import { callPage } from './ink/callpage.ts';
import { liveCall } from './ink/callnotes.ts';
import { row } from './notebookgroups.ts';
import { addWords, createPageScrap } from './notebookscraps.ts';
import { pageRow, type NotebookPage } from './notebook.ts';
import { isRefused, type Refused } from './pagechecks.ts';

export const DIR = `${DATA_DIR}/prototypes`;
mkdirSync(DIR, { recursive: true });
db.exec(`create table if not exists call_prototypes (id integer primary key, call integer not null,
  name text not null collate nocase, version integer not null, about text not null default '', by text not null,
  made text not null, grp integer, slip integer)`);
type Prototype = {
  id: number;
  call: number;
  name: string;
  version: number;
  about: string;
  by: string;
  made: string;
  grp: number | null;
  slip: number | null;
};

const NAME_MOST = 60,
  ABOUT_MOST = 200;
// A page and its files, at most: an agent's throwaway, not a site
export const FILES_MOST = 8 << 20,
  HTML_MOST = 1_000_000;
// (a job's files come in its JSON, as base64: server.ts)
export const JSON_MAX = Math.ceil((FILES_MOST * 4) / 3) + 1_000_000;
// (the line's page comes as JSON text, each character at most 12 bytes: one outside Unicode's basic plane as two \u
// escapes, as the voice line's ASK_BYTES.)
export const PAGE_JSON_MAX = 12 * HTML_MOST + (1 << 16);
const PATH = /^(?!.*(?:^|\/)\.)[\w.-]+(?:\/[\w.-]+)*$/;
// Its picture: the page at an iPad's size in landscape, a second to settle (one that never does is taken as it is
// then), and how long the browser may take in all: the line waits 15 s for the tool's answer
const SEEN = { width: 1180, height: 820 },
  SETTLE_MS = 1000,
  PICTURE_MS = 8000;
// (the frame's own address in the picture's browser: every request is answered from the prototype's files, none
// reaches a network. Each answer turns script off, in the frames below it too, as the coordinator's Chromium has no
// sandbox of its own: chromium.ts.)
const FRAME = 'https://prototype.invalid',
  SCRIPT_OFF = { 'content-security-policy': 'sandbox' };
// What a page on its host may load: its own files, inline code and its host's review mode, nothing from anywhere else,
// so neither its guest's address nor what they type reaches anyone else (a link they tap still leaves).
const OWN_ONLY = (host: string) =>
  `default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' wss://${host}; form-action 'self'`;

// ---------------------------------------------------------------- the host
// A call's prototypes' host, and the call a host is the prototypes' host of
export const { hostOf, numberAt: callAt } = numbered('call');
const linkOf = (p: Prototype) => (hostOf(p.call) ? `https://${hostOf(p.call)}/${p.id}/` : null);
// Caddy's certificate ask (GET /api/preview/try-host, server.ts): a call with a prototype
export const hasHost = (domain: string) => {
  const call = callAt(domain);
  return call !== null && !!db.prepare('select 1 from call_prototypes where call = ?').get(call);
};
const byId = (id: number) => db.prepare('select * from call_prototypes where id = ?').get(id) as Prototype | undefined;

// ---------------------------------------------------------------- saving
// POST /api/voice/prototype {call, name, html, about?}: the call's agent's, one page with everything inline. → its line,
// id, version, link and its picture as the board sees it (a JPEG), or why not
export async function fromVoice(b: any) {
  if (typeof b?.html !== 'string' || !b.html.trim() || b.html.length > HTML_MOST)
    return [400, `html: one whole page, at most ${HTML_MOST} characters`] as Refused;
  const at = callPage(b);
  if (isRefused(at)) return at;
  return save(Number(b.call), at.agent, b, new Map([['index.html', Buffer.from(b.html)]]), true);
}
// POST /api/agent/prototype {call, name, about?, files: {path: base64}}: a colleague's job's (hq prototype), a folder
// whose index.html is the page. Only a job the call queued: no other puts an unreviewed page on both iPads
export async function fromJob(b: any, me: { id: number; agent: string }) {
  if (!liveCall(Number(b?.call)))
    return [404, `no live call #${b?.call}: a call's prototype is made while it's on`] as Refused;
  if (!queuedHere(Number(b.call), me.id))
    return [
      403,
      `job #${me.id} wasn't queued on call #${b.call}: only the call's own jobs save its prototypes`,
    ] as Refused;
  const files = filesOf(b.files);
  return isRefused(files) ? files : save(Number(b.call), me.agent, b, files, false);
}
function filesOf(given: unknown) {
  if (!given || typeof given !== 'object') return [400, 'files: {path: base64}, index.html among them'] as Refused;
  const files = new Map<string, Buffer>();
  let size = 0;
  for (const [path, data] of Object.entries(given)) {
    if (!PATH.test(path) || typeof data !== 'string')
      return [400, `files: ${path} isn't a path in the folder (letters, digits, . - _ and /, no dot-files)`] as Refused;
    const bytes = Buffer.from(data, 'base64');
    size += bytes.length;
    if (size > FILES_MOST) return [413, `files: at most ${FILES_MOST >> 20} MB in all`] as Refused;
    files.set(path, bytes);
  }
  return files.has('index.html') ? files : ([400, 'files: index.html is the page'] as Refused);
}

async function save(call: number, by: string, b: any, files: Map<string, Buffer>, seen: boolean) {
  const name = oneLine(b.name),
    about = oneLine(b.about ?? '');
  if (!name || [...name].length > NAME_MOST)
    return [400, `name: the prototype's, at most ${NAME_MOST} characters`] as Refused;
  if ([...about].length > ABOUT_MOST) return [400, `about: one line, at most ${ABOUT_MOST} characters`] as Refused;
  // (taken outside HQ's thread, before anything is kept: one that fails saves nothing and says why)
  let picture: Buffer;
  try {
    picture = await exclude(pictureOf(files));
  } catch (err) {
    return [409, `its picture couldn't be taken, so it isn't saved: ${(err as Error).message}`] as Refused;
  }
  // (the call may have ended while it was taken)
  const at = callPage({ call });
  if (isRefused(at)) return at;
  const before = db
    .prepare('select * from call_prototypes where call = ? and name = ? order by version desc limit 1')
    .get(call, name) as Prototype | undefined;
  const id = Number(
    db
      .prepare('insert into call_prototypes (call, name, version, about, by, made) values (?, ?, ?, ?, ?, ?)')
      .run(call, before?.name ?? name, (before?.version ?? 0) + 1, about, by, new Date().toISOString()).lastInsertRowid,
  );
  for (const [path, bytes] of files) keepFile(`${DIR}/${id}/${path}`, bytes);
  const p = byId(id)!;
  const clip = clipOn(at, p, picture);
  if (isRefused(clip)) return clip;
  const ok = `${p.name} v${p.version} is up on both iPads: a card slides in, and it's a clip in the call's notes (#${clip.grp}) \
beside its other versions. Its address: ${linkOf(p) ?? '(none: no domain)'}`;
  if (!seen) return { ok, id, version: p.version, link: linkOf(p) };
  const small = await sharp(picture)
    .resize({ width: SEEN.width >> 1 })
    .jpeg({ quality: 80 })
    .toBuffer();
  return {
    ok,
    id,
    version: p.version,
    link: linkOf(p),
    picture: { type: 'image/jpeg', data: small.toString('base64') },
  };
}
// Its clip on the call's page: the note its versions are under, while it's still there, else a new one, with this
// version's frame under it; and its card on every screen. The note has no room to write of its own, so its versions
// hang right under its name, one thing, and the next note stands apart (masonry.js GAP.)
function clipOn(at: { agent: string; page: NotebookPage }, p: Prototype, picture: Buffer) {
  // (the newest version with a clip: one whose clip couldn't be made has none.)
  const had = db
    .prepare(
      'select grp from call_prototypes where call = ? and name = ? and grp is not null order by version desc limit 1',
    )
    .get(p.call, p.name) as { grp: number } | undefined;
  const kept = had && row(had.grp);
  const g =
    kept && kept.page === at.page.id && kept.deleted === null ? kept : addWords(at.page, at.agent, p.name, { room: 0 });
  if (isRefused(g)) return g;
  const slip = addSlip(null, p.by, null, p.about, {
    grp: g.id,
    style: 'version',
    version: `v${p.version}`,
    picture: { type: 'image/png', clean: picture },
    link: linkOf(p),
  });
  db.prepare('update call_prototypes set grp = ?, slip = ? where id = ?').run(g.id, slip.id, p.id);
  publish({
    type: 'book',
    agent: p.by,
    text: 'prototype',
    page: at.page.id,
    prototype: { call: p.call, id: p.id, name: p.name, version: p.version, picture: slip.picture, link: linkOf(p) },
  });
  return { grp: g.id };
}
const oneLine = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

// The prototype's picture as its markup and CSS draw it at the board's iPad's size, from its files: a PNG
async function pictureOf(files: Map<string, Buffer>) {
  const browser = await launch(AbortSignal.timeout(PICTURE_MS));
  const stop = setTimeout(() => void browser.close(), PICTURE_MS);
  try {
    const tab = await browser.tab(async ({ url }) => fileAnswer(files, url));
    return await taken(tab);
  } finally {
    clearTimeout(stop);
    await browser.close();
  }
}
function fileAnswer(files: Map<string, Buffer>, url: string) {
  if (!url.startsWith(`${FRAME}/`)) return null;
  const path = decoded(new URL(url).pathname.slice(1)) ?? '';
  const file = !path || path.endsWith('/') ? `${path}index.html` : path;
  const body = files.get(file);
  return body ? { type: typeOf(file) ?? 'application/octet-stream', body, headers: SCRIPT_OFF } : null;
}
async function taken(tab: Tab) {
  await tab.send('Emulation.setDeviceMetricsOverride', { ...SEEN, deviceScaleFactor: 1, mobile: false });
  const navigated = await tab.send('Page.navigate', { url: `${FRAME}/` });
  if (navigated.errorText) throw new Error(`its page didn't open: ${navigated.errorText}`);
  await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
  const shot = await tab.send('Page.captureScreenshot', { format: 'png' });
  return Buffer.from(shot.data, 'base64');
}

// A file of a prototype's, or null: a path inside its folder that's there
function pathOf(id: number, path: string) {
  if (!PATH.test(path)) return null;
  const file = `${DIR}/${id}/${path}`;
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- who may look
// The call's guest, by their view-only share of its host: while the call is live and they're its guest. Their share is
// made each time their room hands them on to it (onward).
function guestOn(req: IncomingMessage, host: string, call: number) {
  const share = shares.fromSession(cookie(req, 'ps'), host);
  return share && liveCall(call) && guestOfCall(call, share.guest) ? share.guest : null;
}
// Whether a name is a guest of a live call now: callguests.ts says (guestsBy), as the guests' own module: a scan of the
// call's QR code.
let guestOfCall: (call: number, guest: string) => boolean = () => false;
export const guestsBy = (onCall: (call: number, guest: string) => boolean) => {
  guestOfCall = onCall;
};
// (a hand-off's link lives as the guest desk's; its session a day at most, and it opens nothing once the call ends:
// guestOn)
const HAND_OFF = { linkMs: 120_000, accessMs: 864e5 };

// The guest desk's onward (guests.ts): a guest of a live call (a scan's room name), to its prototypes' host, by a
// view-only share of that host alone, nobody's address behind it (shares.ts forVisitor). (the scan's own share, in place of an invited guest's)
guests.addOnward((guest, url) => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const call = callAt(u.host);
  if (u.protocol !== 'https:' || call === null || !liveCall(call) || !guestOfCall(call, guest)) return null;
  const scope = { about: `call-${call}`, host: u.host.toLowerCase(), prefix: '/', start: '/' };
  return shares.forVisitor(scope, guest, u, HAND_OFF);
});

// ---------------------------------------------------------------- serving
// A request on a call's prototypes' host (server.ts, past the preview login's own two paths): the board's, with review
// mode on its pages, or the call's guest's while the call is live. Only a prototype of this call's files.
export async function serve(req: IncomingMessage, res: ServerResponse, call: number) {
  const host = String(req.headers.host ?? '')
    .toLowerCase()
    .split(':')[0];
  const url = new URL(req.url ?? '/', 'http://x');
  // (HQ's viewer and the guest's room frame it.)
  if (!opened(req, res, 'a prototype', { also: () => !!guestOn(req, host, call), sources: OWN_ONLY(host) })) return;
  if (url.pathname === '/__hq-origin') return answer(res, 'text/plain; charset=utf-8', Buffer.from(ORIGIN));
  if (url.pathname.startsWith('/__review/')) return feedback.product(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(res, 405, 'GET');
  const [, first, ...rest] = (decoded(url.pathname) ?? '').split('/');
  const p = byId(Number(first));
  if (!p || p.call !== call) return refuse(res, 404, 'No such prototype on this call.');
  if (!rest.length) return void res.writeHead(301, { location: `/${p.id}/` }).end();
  const path = rest.join('/') || 'index.html';
  const file = pathOf(p.id, path.endsWith('/') ? `${path}index.html` : path);
  if (!file) return refuse(res, 404, 'not found');
  const type = typeOf(file) ?? 'application/octet-stream',
    body = readFileSync(file);
  answer(res, type, type.startsWith('text/html') ? Buffer.from(feedback.withReviewMode(body.toString('utf8'))) : body);
}
const answer = (res: ServerResponse, type: string, body: Buffer) =>
  void res.writeHead(200, { 'content-type': type }).end(res.req.method === 'HEAD' ? undefined : body);
const refuse = (res: ServerResponse, status: number, words: string) =>
  void res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(words);

// Review mode on a prototype's page (feedback.ts): the board's preview key on a call's host, or its guest while the call
// is live (their pen goes to the call's page through the guest room: markOnCall.)
feedback.addReviewHost(req => {
  const host = String(req.headers.host ?? '')
    .toLowerCase()
    .split(':')[0];
  const call = callAt(host);
  return call !== null && (boardOn(req, host) || guestOn(req, host, call)) ? host : null;
});

// ---------------------------------------------------------------- a pen on it
// POST /api/calls/prototype-mark {url, anchor, snip}: the board's mark on a prototype in HQ's viewer, on a screen that
// isn't the call's (its iPad): a scrap on the call's page, the board's, with its snip, which the call's own screen
// hands the agent as any mark there (calldraw.js relayMarks). The call's own screen files its marks itself (callnotes.js).
// by: who it's by on the call's page (its id), or undefined where they aren't on it: the guest room's for its guest
// (notebookguestroom.ts, as the guest's own marks there.)
export function markOnCall(b: any, by: (page: number) => string | undefined = () => BOARD) {
  let host = '';
  try {
    host = new URL(String(b?.url)).host;
  } catch {
    /* (no call) */
  }
  const call = callAt(host);
  const at = call === null ? undefined : callPage({ call });
  if (!at || isRefused(at)) return [404, 'The call had ended.'] as Refused;
  const who = by(at.page.id);
  if (!who) return [404, 'The call had ended.'] as Refused;
  return createPageScrap({ anchor: b.anchor, snip: b.snip, words: '', said: null }, pageRow(at.page.id, BOARD)!, who);
}

// ---------------------------------------------------------------- for the guest's room
// The call's prototypes, newest version first, as its guest's room shows their card (callguests.ts notebookFor)
export const listFor = (call: number) =>
  (
    db
      .prepare('select * from call_prototypes where call = ? and slip is not null order by id desc')
      .all(call) as Prototype[]
  ).map(p => ({
    id: p.id,
    name: p.name,
    version: p.version,
    picture: `/api/book/slip/picture?id=${p.slip}`,
    link: linkOf(p),
  }));

// The authenticated guest notebook room as one route table: its page, its reads, pictures and page writes.
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as guests from './guests.ts';
import { voice } from './feedback.ts';
import * as handwriting from './handwriting.ts';
import { fetchGuestPicture } from './ink/bookfetch.ts';
import * as files from './notebookguestfiles.ts';
import * as notebooks from './notebookguests.ts';
import * as members from './notebookmembers.ts';
import { shelfOf } from './notebookguestshelf.ts';
import * as pictures from './notebookpictures.ts';
import * as bookpicture from './ink/bookpicture.ts';
import * as slips from './ink/bookslips.ts';
import * as notebook from './notebook.ts';
import * as groups from './notebookgroups.ts';
import * as sending from './notebooksend.ts';
import * as rounds from './notebookrounds.ts';
import * as answers from './ink/bookanswer.ts';
import { db } from './db.ts';
import { reply } from './uploads.ts';
import { isRefused, SAVE_MAX, type Refused } from './pagechecks.ts';
import { parseJson, readBody, routes, type RouteRequest } from '../../../shared/routes/routes.ts';
import { scopedPath } from '../../hq/shell/ink/bookroutes.js';

const ROOM = '/guest/notebooks',
  API = `${ROOM}/api`;

guests.addRoom({
  path: 'notebooks',
  opens: name => members.forGuest(name).length > 0,
  label: files.roomTitle,
  link: notebooks.roomLink,
  serve: (req, res) => room(req, res),
});

// The guest a request is for: guests.ts serves the room only to a signed-in guest it opens for
const nameOf = (req: IncomingMessage) => guests.signedIn(req)!.name;

// What a write on one of the guest's pages gets: the guest, their membership and round, the page and who they write as
// there, and whether they're still in (signed in and a member of the page) after any wait
type OnPage = {
  name: string;
  member: members.Membership;
  round: rounds.Round | undefined;
  page: number;
  who: string;
  stillOpen: () => boolean;
};
// Where a write's page is: its body's page, its own id (a page's), a group's or an answer slip's
const byPage = (b: any) => Number(b?.page),
  byId = (b: any) => Number(b?.id),
  byGroup = (b: any) => groups.row(Number(b?.id))?.page ?? 0,
  bySlip = (field: string) => (b: any) => slipPage(Number(b?.[field]));

// Each route under the guest scope keeps its board path's name (bookroutes.js). pages/send and pages/undo go through
// notebookrounds.ts: in a round's notebook they hand the page in and take it back while the round is open, and in a
// plain invited notebook they send the page and undo the send (notebooksend.ts). Both answer with the page. A page
// write names how its page is found, what it does, and whether it answers an agent (ANSWERS: a closed round still
// takes it).
const ANSWERS = true;
const room = routes({
  [`GET ${ROOM}`]: ({ res, url }) => {
    res.writeHead(302, { location: `${ROOM}/${url.search}`, 'cache-control': 'no-store' });
    res.end();
  },
  [`GET ${ROOM}/`]: ({ req, res }) => {
    const guest = guests.signedIn(req)!;
    return files.servePage(res, guest.name, guests.langOf(guest));
  },
  [`GET ${API}/shelf`]: ({ req, res }) => answer(res, shelfOf(nameOf(req))),
  [`GET ${API}/list`]: read((name, q) => notebooks.listNotebooks(name, Number(q.get('notebook')) || undefined)),
  [`GET ${API}/pages`]: read((name, q) => notebooks.guestPages({ notebook: q.get('notebook') }, name)),
  [`GET ${API}/pages/groups`]: read((name, q) => notebooks.listGroups({ page: q.get('page') }, name)),
  [`GET ${API}/pictures`]: ({ req, res, url }) => PICTURES.pictures(req, res, url, nameOf(req)),
  [`GET ${API}/book/picture`]: ({ req, res, url }) => PICTURES.bookPicture(req, res, url, nameOf(req)),
  [`GET ${API}/book/slip/picture`]: ({ req, res, url }) => PICTURES.slipPicture(req, res, url, nameOf(req)),
  [`GET ${API}/book/slip/now`]: ({ req, res, url }) => PICTURES.slipNow(req, res, url, nameOf(req)),
  [`GET ${API}/book/fetch`]: ({ req, res, url }) =>
    fetchGuestPicture(nameOf(req).toLowerCase(), res, url.searchParams.get('url') ?? ''),
  [`POST ${API}/voice`]: voiceNote,
  [`POST ${API}/pictures`]: uploadPicture,
  [`POST ${API}/book/read`]: write(readHandwriting),
  [`POST ${API}/pages/create`]: write(createPage),
  [`POST ${API}/pages/send`]: onPage(byId, (b, on) => rounds.handIn(on.page, on.who, on.stillOpen)),
  [`POST ${API}/pages/undo`]: onPage(byId, (b, on) => rounds.takeBack(on.page, on.who)),
  [`POST ${API}/pages/title`]: onPage(byId, (b, on) => notebook.titlePage(b, on.who)),
  [`POST ${API}/groups/create`]: onPage(byPage, (b, on) => groups.createGroup(b, on.who)),
  [`POST ${API}/groups/edit`]: onPage(byGroup, (b, on) => groups.editGroup(b, on.who)),
  [`POST ${API}/groups/delete`]: onPage(byGroup, (b, on) => groups.deleteGroup(b, on.who)),
  [`POST ${API}/groups/restore`]: onPage(byGroup, restoreGroup),
  [`POST ${API}/groups/move`]: onPage(byGroup, moveGroup),
  [`POST ${API}/groups/resize`]: onPage(byGroup, (b, on) => groups.resizeGroup(b, on.who)),
  [`POST ${API}/groups/split`]: onPage(byGroup, (b, on) => groups.splitGroup(b, on.who)),
  [`POST ${API}/groups/reply`]: onPage(bySlip('answer'), (b, on) => sending.replyTo(b, on.who, on.stillOpen), ANSWERS),
  [`POST ${API}/replies/delete`]: onPage(byGroup, (b, on) => sending.deleteReply(b, on.who), ANSWERS),
  [`POST ${API}/answers/form`]: onPage(bySlip('id'), (b, on) => answers.answerForm(b, on.who), ANSWERS),
  [`POST ${API}/answers/tick`]: onPage(bySlip('id'), (b, on) => answers.tickAnswer(b, on.who), ANSWERS),
  // the shell's own files, as the board's HQ serves them
  [`GET ${ROOM}/*`]: ({ res, url }) =>
    files.serveFile(res, url.pathname.slice(ROOM.length)) || reply(res, 404, { error: 'not found' }),
});

// A guest's read of their notebooks, its addresses under the scope
function read(answering: (name: string, query: URLSearchParams) => unknown) {
  return ({ req, res, url }: RouteRequest) => answer(res, guestUrls(answering(nameOf(req), url.searchParams)));
}

// A voice note, while the guest is still signed in and a member somewhere, asked again past the body before any model
// work
async function voiceNote({ req, res }: RouteRequest) {
  const name = nameOf(req);
  const stillIn = () => stillSignedIn(req, name) && members.forGuest(name).length > 0;
  return answer(res, await voice(`notebook:${name}`, req, true, stillIn));
}

function uploadPicture({ req, res, url }: RouteRequest) {
  const name = nameOf(req),
    member = notebooks.pageMember(Number(url.searchParams.get('page')), name);
  if (!member) return answer(res, 404);
  const stillIn = () => stillSignedIn(req, name) && !!notebooks.pageMember(member.page, name);
  return pictures.uploadPicture(req, res, members.whoOf(member), stillIn, `${API}/pictures`);
}

// A write by the signed-in guest: its JSON body read first, then the guest asked again (their session may have ended
// meanwhile), its answer's addresses under the scope
function write(writing: (b: any, name: string, stillIn: () => boolean) => unknown) {
  return async ({ req, res }: RouteRequest) => {
    const name = nameOf(req);
    const raw = await readBody(req, SAVE_MAX);
    if (!raw) return reply(res, 413, { error: 'too large' }, true);
    const body = parseJson(raw);
    if (body === null) return reply(res, 400, { error: 'not JSON' });
    if (!stillSignedIn(req, name)) return reply(res, 401, { error: 'sign in again', reason: 'signIn' });
    return answer(res, guestUrls(await writing(body, name, () => stillSignedIn(req, name))));
  };
}
const stillSignedIn = (req: IncomingMessage, name: string) =>
  guests.signedIn(req)?.name.toLowerCase() === name.toLowerCase();

// A write on one of the guest's pages: refused unless they're a member of the page it names, and in a closed round
// unless it answers an agent
function onPage(page: (b: any) => number, writing: (b: any, on: OnPage) => unknown, answering = false) {
  return write(async (b, name, stillIn) => {
    const at = page(b),
      member = notebooks.pageMember(at, name);
    if (!member) return 404;
    const round = rounds.roundOf(member.notebook);
    if (round?.closed && !answering) return [409, 'the round has closed', 'roundClosed'] as Refused;
    const stillOpen = () => stillIn() && !!notebooks.pageMember(at, name);
    const on = { name, member, round, page: at, who: members.whoOf(member), stillOpen };
    return (await writing(b, on)) ?? { ok: true };
  });
}

function readHandwriting(b: any, name: string) {
  const [member] = members.forGuest(name);
  if (!member) return 403;
  return handwriting.read(b, members.whoOf(member));
}

function createPage(b: any, name: string) {
  const member = members.forGuest(name).find(m => m.notebook === Number(b?.notebook));
  if (!member) return 404;
  if (rounds.roundOf(member.notebook)) return [409, 'a round has one page per guest', 'roundPage'] as Refused;
  const id = notebook.newPage(member.notebook);
  db.prepare('update book_pages set who = ? where id = ?').run(members.whoOf(member), id);
  return notebook.pageOf(notebook.pageRow(id, members.whoOf(member))!);
}

function restoreGroup(b: any, on: OnPage) {
  if (on.round && notebook.pageRow(on.page, on.who)!.send_at !== null)
    return [409, 'un-send this round page before restoring a group', 'roundRestore'] as Refused;
  return groups.restoreGroup(b, on.who);
}

// (onto another page of the same notebook only)
function moveGroup(b: any, on: OnPage) {
  if (notebooks.pageMember(Number(b.page), on.name)?.notebook !== on.member.notebook) return 404;
  return groups.moveGroup(b, on.who);
}

// The page an answer slip is on, through its group (or its note's)
function slipPage(slip: number) {
  const group = db
    .prepare(
      'select g.page from notebook_groups g join book_slips s on s.grp = g.id or s.note = g.note where s.id = ? order by g.id limit 1',
    )
    .get(slip) as { page: number } | undefined;
  return group?.page ?? 0;
}

// A page's pictures, to that page's member: the guest's own (name), or any guest's for the board's watch (no name)
type PictureServer = (req: IncomingMessage, res: ServerResponse, who: string) => unknown;
function picture(page: (query: URLSearchParams) => number, serve: PictureServer) {
  return (req: IncomingMessage, res: ServerResponse, url: URL, name?: string) => {
    const member = notebooks.pageMember(page(url.searchParams), name);
    if (!member) return reply(res, 404, { error: 'not found' });
    return serve(req, res, members.whoOf(member));
  };
}
export const PICTURES = {
  pictures: picture(q => Number(q.get('file')?.split('-')[0]), pictures.servePicture),
  bookPicture: picture(q => Number(q.get('id')), bookpicture.servePicture),
  slipPicture: picture(
    q => slipPage(Number(q.get('id'))),
    (req, res, who) => slips.serveSlipPicture(req, res, who, 'picture'),
  ),
  slipNow: picture(
    q => slipPage(Number(q.get('id'))),
    (req, res, who) => slips.serveSlipPicture(req, res, who, 'now'),
  ),
};

// Only these known URL fields are rebased. Guest note text is left exactly as written.
function guestUrls(value: any, api = API): any {
  if (Array.isArray(value)) return value.map(child => guestUrls(child, api));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) =>
      ['picture', 'url', 'now'].includes(key) && typeof child === 'string'
        ? [key, scopedPath(child, api)]
        : [key, guestUrls(child, api)],
    ),
  );
}

const answer = (res: ServerResponse, value: unknown) =>
  typeof value === 'number'
    ? reply(res, value, { error: 'that notebook or page is not available', reason: 'unavailable' })
    : isRefused(value)
      ? reply(res, value[0], { error: value[1], ...(value[2] ? { reason: value[2] } : {}) })
      : reply(res, 200, value);

// The board's watch of a guest's book: their page's groups and its pictures, below /api/notebooks/guests
const BOARD_API = '/api/notebooks/guests';
export const listBoardGroups = (body: any) => guestUrls(notebooks.listGroups(body), BOARD_API);

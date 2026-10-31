// The authenticated guest notebook room and its page-scoped JSON and picture routes.
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as guests from './guests.ts';
import { voice } from './feedback.ts';
import * as handwriting from './handwriting.ts';
import { fetchPicture } from './ink/bookfetch.ts';
import * as files from './notebookguestfiles.ts';
import * as notebooks from './notebookguests.ts';
import { shelfOf } from './notebookguestshelf.ts';
import * as pictures from './notebookpictures.ts';
import * as bookpicture from './ink/bookpicture.ts';
import * as slips from './ink/bookslips.ts';
import { db } from './db.ts';
import { reply } from './uploads.ts';
import { isRefused, SAVE_MAX } from './pagechecks.ts';
import { readBody } from '../../../shared/routes/routes.ts';

const base = '/guest/notebooks/api';
guests.addRoom({
  path: 'notebooks',
  opens: name => notebooks.forGuest(name).length > 0,
  label: files.roomTitle,
  link: notebooks.roomLink,
  serve: serveRoom,
});

async function serveRoom(req: IncomingMessage, res: ServerResponse, name: string, rest: string) {
  const url = new URL(req.url ?? '/', 'http://x'),
    path = rest.split('?')[0];
  if (req.method === 'GET') return serveRead(req, res, name, path, url);
  if (req.method !== 'POST' || !path.startsWith('/api/')) return reply(res, 404, { error: 'not found' });
  // (still signed in as this guest and a member somewhere, asked again past the body before any model work)
  const stillIn = () =>
    guests.signedIn(req)?.name.toLowerCase() === name.toLowerCase() && notebooks.forGuest(name).length > 0;
  if (path === '/api/voice') return answer(res, await voice(`notebook:${name}`, req, true, stillIn));
  if (path === '/api/pictures') {
    const member = notebooks.pageMember(Number(url.searchParams.get('page')), name);
    if (!member) return answer(res, 404);
    return pictures.uploadPicture(
      req,
      res,
      notebooks.whoOf(member),
      () =>
        guests.signedIn(req)?.name.toLowerCase() === name.toLowerCase() &&
        !!notebooks.pageMember(Number(url.searchParams.get('page')), name),
      `${base}/pictures`,
    );
  }
  const raw = await readBody(req, SAVE_MAX);
  if (!raw) return reply(res, 413, { error: 'too large' }, true);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString() || '{}');
  } catch {
    return reply(res, 400, { error: 'not JSON' });
  }
  if (guests.signedIn(req)?.name.toLowerCase() !== name.toLowerCase())
    return reply(res, 401, { error: 'sign in again', reason: 'signIn' });
  if (path === '/api/book/read') {
    const [member] = notebooks.forGuest(name);
    if (!member) return answer(res, 403);
    return answer(res, await handwriting.read(body, notebooks.whoOf(member)));
  }
  const acted = await notebooks.act(
    guestAction(path),
    body,
    name,
    () => guests.signedIn(req)?.name.toLowerCase() === name.toLowerCase(),
  );
  return answer(res, guestUrls(acted));
}

function serveRead(req: IncomingMessage, res: ServerResponse, name: string, path: string, url: URL) {
  if (path === '') {
    res.writeHead(302, { location: '/guest/notebooks/' + url.search, 'cache-control': 'no-store' });
    return res.end();
  }
  if (path === '/') return files.servePage(res, name, guests.langOf(guests.signedIn(req)!));
  if (files.serveFile(res, path)) return;
  if (path === '/api/shelf') return answer(res, shelfOf(name));
  if (path === '/api/pages')
    return answer(res, guestUrls(notebooks.guestPages({ notebook: url.searchParams.get('notebook') }, name)));
  if (path === '/api/list')
    return answer(res, guestUrls(notebooks.listNotebooks(name, Number(url.searchParams.get('notebook')) || undefined)));
  if (['/api/groups', '/api/pages/groups'].includes(path))
    return answer(res, guestUrls(notebooks.listGroups({ page: url.searchParams.get('page') }, name)));
  if (
    req.method === 'GET' &&
    [
      '/api/pictures',
      '/api/picture',
      '/api/book/picture',
      '/api/slip/picture',
      '/api/slip/now',
      '/api/book/slip/picture',
      '/api/book/slip/now',
    ].includes(path)
  )
    return servePicture(req, res, name, path.replace('/api/book/', '/api/'), url);
  if (path === '/api/book/fetch') return fetchPicture(res, url.searchParams.get('url') ?? '');
  return reply(res, 404, { error: 'not found' });
}

function servePicture(req: IncomingMessage, res: ServerResponse, name: string | undefined, path: string, url: URL) {
  const id = Number(url.searchParams.get('id'));
  let page = path === '/api/picture' ? id : Number(url.searchParams.get('file')?.split('-')[0]);
  if (path.startsWith('/api/slip/')) {
    const g = db
      .prepare(
        'select g.page from notebook_groups g join book_slips s on s.note = g.note or s.grp = g.id where s.id = ?',
      )
      .get(id) as { page: number } | undefined;
    page = g?.page ?? 0;
  }
  const member = notebooks.pageMember(page, name);
  if (!member) return reply(res, 404, { error: 'not found' });
  const who = notebooks.whoOf(member);
  if (path === '/api/picture') return bookpicture.servePicture(req, res, who);
  if (path === '/api/pictures') return pictures.servePicture(req, res, who);
  return slips.serveSlipPicture(req, res, who, path.endsWith('/now') ? 'now' : 'picture');
}

// Only these known URL fields are rebased. Guest note text is left exactly as written.
function guestUrls(value: any, api = base): any {
  if (Array.isArray(value)) return value.map(child => guestUrls(child, api));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (['picture', 'url', 'now'].includes(key) && typeof child === 'string') {
        const routes = [
          ['/api/notebooks/pictures?', '/pictures?'],
          ['/api/book/picture?', '/picture?'],
          ['/api/book/slip/picture?', '/slip/picture?'],
          ['/api/book/slip/now?', '/slip/now?'],
        ];
        const route = routes.find(([from]) => child.startsWith(from));
        if (route) return [key, api + route[1] + child.slice(route[0].length)];
      }
      return [key, guestUrls(child, api)];
    }),
  );
}

const answer = (res: ServerResponse, value: unknown) =>
  typeof value === 'number'
    ? reply(res, value, { error: 'that notebook or page is not available', reason: 'unavailable' })
    : isRefused(value)
      ? reply(res, value[0], { error: value[1], ...(value[2] ? { reason: value[2] } : {}) })
      : reply(res, 200, value);

export const listBoardGroups = (body: any) => guestUrls(notebooks.listGroups(body), '/api/notebooks/guests');
export function serveBoardPicture(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname.replace('/api/notebooks/guests', '/api');
  return servePicture(req, res, undefined, path, url);
}

function guestAction(path: string) {
  const action = path.slice('/api/'.length);
  if (action.startsWith('groups/')) return action.slice('groups/'.length);
  if (action === 'pages/send' || action === 'pages/undo') return action.slice('pages/'.length);
  if (action === 'book/slip/tick') return 'answers/tick';
  return action;
}

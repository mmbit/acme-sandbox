// The authenticated guest notebook room and its page-scoped JSON and picture routes.
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as guests from './guests.ts';
import * as notebooks from './notebookguests.ts';
import * as pictures from './notebookpictures.ts';
import * as bookpicture from './ink/bookpicture.ts';
import * as slips from './ink/bookslips.ts';
import { db } from './db.ts';
import { hqDir } from './files.ts';
import { reply } from './uploads.ts';
import { isRefused, SAVE_MAX } from './pagechecks.ts';
import { readBody } from '../../../shared/routes/routes.ts';

const base = '/guest/notebooks/api';
const roomWords = {
  en: { title: 'Your notebooks', footer: 'Notes are answered by our AI team.' },
  nl: { title: 'Je notitieboeken', footer: 'Ons AI-team beantwoordt je notities.' },
  de: { title: 'Deine Notizbücher', footer: 'Unser KI-Team beantwortet deine Notizen.' },
};
guests.addRoom({
  path: 'notebooks',
  opens: name => notebooks.forGuest(name).length > 0,
  label: lang => roomWords[lang].title,
  serve: serveRoom,
});

async function serveRoom(req: IncomingMessage, res: ServerResponse, name: string, rest: string) {
  const url = new URL(req.url ?? '/', 'http://x'),
    path = rest.split('?')[0];
  if (req.method === 'GET' && (path === '' || path === '/'))
    return servePage(res, name, guests.langOf(guests.signedIn(req)!));
  if (
    req.method === 'GET' &&
    ['/notebookguest.js', '/notebookpen.js', '/notebookcards.js', '/notebookwords.js', '/notebookguest.css'].includes(
      path,
    )
  ) {
    const file = `/shell/ink${path}`,
      body = readFileSync(`${hqDir(file)}${file}`);
    res.writeHead(200, {
      'content-type': path.endsWith('.css') ? 'text/css' : 'text/javascript',
      'cache-control': 'no-cache',
    });
    return res.end(body);
  }
  if (req.method === 'GET' && path === '/api/list')
    return answer(res, guestUrls(notebooks.listNotebooks(name, Number(url.searchParams.get('notebook')) || undefined)));
  if (req.method === 'GET' && path === '/api/groups')
    return answer(res, guestUrls(notebooks.listGroups({ page: url.searchParams.get('page') }, name)));
  if (req.method === 'GET' && ['/api/pictures', '/api/picture', '/api/slip/picture', '/api/slip/now'].includes(path))
    return servePicture(req, res, name, path, url);
  if (req.method !== 'POST' || !path.startsWith('/api/')) return reply(res, 404, { error: 'not found' });
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
  const acted = await notebooks.act(
    path.slice('/api/'.length),
    body,
    name,
    () => guests.signedIn(req)?.name.toLowerCase() === name.toLowerCase(),
  );
  return answer(res, guestUrls(acted));
}

function servePicture(req: IncomingMessage, res: ServerResponse, name: string | undefined, path: string, url: URL) {
  const id = Number(url.searchParams.get('id'));
  let page = path === '/api/picture' ? id : Number(url.searchParams.get('file')?.split('-')[0]);
  if (path.startsWith('/api/slip/')) {
    const g = db
      .prepare('select g.page from notebook_groups g join book_slips s on s.note = g.note where s.id = ?')
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

function servePage(res: ServerResponse, name: string, lang: guests.Lang) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'referrer-policy': 'same-origin',
  });
  res.end(notebookGuestPage(name, lang));
}
const notebookGuestPage = (
  name: string,
  lang: guests.Lang,
) => `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="robots" content="noindex">
<title>${roomWords[lang].title}</title><link rel="stylesheet" href="/guest/notebooks/notebookguest.css"></head>
<body class="notebook-guest-room"><main id="notebook-guest" data-api="/guest/notebooks/api"></main>
<footer>${roomWords[lang].footer} ${guests.passkeyButton(name, lang)}<span data-guest-passkey-status role="status"></span></footer>
<script type="module" src="/guest/notebooks/notebookguest.js"></script>
<script src="/guest/webauthn.js" defer></script><script src="/guest/guestkeys.js" defer></script></body></html>`;

export const listBoardGroups = (body: any) => guestUrls(notebooks.listGroups(body), '/api/notebooks/guests');
export function serveBoardPicture(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname.replace('/api/notebooks/guests', '/api');
  return servePicture(req, res, undefined, path, url);
}

// The guest's shared Ink shell and its static dependencies, with company branding from guest settings.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import * as guests from './guests.ts';
import { brand } from './company.ts';
import { PREVIEW, REPO_DIR, ZONE } from './config.ts';
import { hqDir } from './files.ts';
import { looks } from '../../hq/looks.mjs';
import { BOARD_EXTRAS, OPEN_EXTRAS } from '../../hq/extras.mjs';
import { reply } from './uploads.ts';
import type { RouteHandler, RouteTable } from '../../../shared/routes/routes.ts';

const words = {
  en: { title: 'Your notebooks', footer: 'Notes are answered by our AI team.' },
  nl: { title: 'Je notitieboeken', footer: 'Ons AI-team beantwoordt je notities.' },
  de: { title: 'Deine Notizbücher', footer: 'Unser KI-Team beantwortet deine Notizen.' },
};
export const roomTitle = (lang: guests.Lang) => words[lang].title;
// The shell's own files under the room's address, as the board's HQ serves them: the looks, HQ's extra modules
// (extras.mjs), review mode's parts, and the shell's scripts, styles and fonts
export const fileRoutes = (room: string): RouteTable => ({
  [`GET ${room}/renderers/looks.json`]: ({ res }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(looks(hqDir('/'))));
  },
  ...extraRoutes(room, { ...BOARD_EXTRAS, ...OPEN_EXTRAS }),
  [`GET ${room}/review/:part([a-z]+).js`]: ({ res, params }) =>
    sendFile(res, `${REPO_DIR}/shared/review/${params.part}.js`),
  [`GET ${room}/:path(util\\.js|(?:shell|world|renderers)/[\\w\\/\\-]+\\.(?:js|css|woff2))`]: ({ res, params }) =>
    sendFile(res, `${hqDir(`/${params.path}`)}/${params.path}`),
  [`GET ${room}/*`]: ({ res }) => reply(res, 404, { error: 'not found' }),
});
// The extras' scripts as routes, a folder's by its scripts' names
const extraRoutes = (room: string, table: Record<string, string>): RouteTable =>
  Object.fromEntries(
    Object.entries(table)
      .filter(([address, file]) => address.endsWith('/') || file.endsWith('.js'))
      .map(([address, file]): [string, RouteHandler] =>
        address.endsWith('/')
          ? [
              `GET ${room}${address}:name([a-z]+\\.js)`,
              ({ res, params }) => sendFile(res, `${REPO_DIR}/${file}${params.name}`),
            ]
          : [`GET ${room}${address}`, ({ res }) => sendFile(res, `${REPO_DIR}/${file}`)],
      ),
  );
function sendFile(res: ServerResponse, file: string) {
  if (!existsSync(file)) return reply(res, 404, { error: 'not found' });
  const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'text/javascript';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
  res.end(readFileSync(file));
}
const imports = JSON.stringify({
  imports: Object.fromEntries([
    ['/__review/', '/guest/notebooks/review/'],
    ...Object.keys({ ...BOARD_EXTRAS, ...OPEN_EXTRAS }).map(path => [path, `/guest/notebooks${path}`]),
  ]),
});

// The guest's room around their book: the company's colours, fonts and logo inline, the rest in bookguestroom.css.
// The book's own colours from brand.yaml: its accent (colours.notebook) and what's picked or done (colours.chosen).
export function servePage(res: ServerResponse, name: string, lang: guests.Lang) {
  const colours = brand().colours ?? {};
  const bookColours = ['notebook', 'chosen']
    .filter(key => colours[key])
    .map(key => `--${key}:${colours[key]};`)
    .join('');
  const look = guests.look();
  const css =
    guests.palette() +
    look.fonts +
    guests.logoCss('.guest-logo') +
    guests.passkeyCss +
    `:root{${bookColours}--guest-font:${look.family}system-ui}`;
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'same-origin',
    'content-security-policy': `default-src 'none'; script-src 'self' 'sha256-${createHash('sha256').update(imports).digest('base64')}'; style-src 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; frame-src 'self'${ZONE ? ` https://*${PREVIEW}` : ''}`,
  });
  res.end(
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="robots" content="noindex"><title>${words[lang].title}</title><style>${css}</style><link rel="stylesheet" href="shell/ink/bookguestroom.css"></head><body class="notebook-guest-room"><header class="guest-logo">${guests.logoHtml()}</header><main><h1>${words[lang].title}</h1><p data-notebook-status role="status"></p>${guests.passkeyButton(name, lang)}</main><footer>${words[lang].footer}</footer><div id="toasts" aria-live="polite"></div><script type="importmap">${imports}</script><script type="module" src="shell/ink/bookguest.js"></script><script src="/vendor/webauthn.js" defer></script><script src="/guest/guestkeys.js" defer></script></body></html>`,
  );
}

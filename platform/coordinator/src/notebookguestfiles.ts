// The guest's shared Ink shell and its static dependencies, with company branding from guest settings.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import * as guests from './guests.ts';
import { brand } from './company.ts';
import { PREVIEW, REPO_DIR, ZONE } from './config.ts';
import { hqDir } from './files.ts';
import { looks } from '../../hq/looks.mjs';
import { BOARD_EXTRAS, OPEN_EXTRAS, extraFile } from '../../hq/extras.mjs';

const words = {
  en: { title: 'Your notebooks', footer: 'Notes are answered by our AI team.' },
  nl: { title: 'Je notitieboeken', footer: 'Ons AI-team beantwoordt je notities.' },
  de: { title: 'Deine Notizbücher', footer: 'Unser KI-Team beantwortet deine Notizen.' },
};
export const roomTitle = (lang: guests.Lang) => words[lang].title;
export function serveFile(res: ServerResponse, path: string) {
  if (path === '/renderers/looks.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(looks(hqDir('/'))));
    return true;
  }
  const shared = extraFile({ ...BOARD_EXTRAS, ...OPEN_EXTRAS }, path);
  const review = /^\/review\/([a-z]+)\.js$/.exec(path);
  if (shared?.endsWith('.js') || review) {
    const file = `${REPO_DIR}/${shared ?? `shared/review/${review![1]}.js`}`;
    if (!existsSync(file)) return false;
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' });
    res.end(readFileSync(file));
    return true;
  }
  if (!/^\/(?:util\.js|foley\.js|(?:shell|world|renderers)\/[a-zA-Z0-9_/-]+\.(?:js|css|woff2))$/.test(path))
    return false;
  const file = path === '/foley.js' ? `${REPO_DIR}/shared/demo/foley.js` : `${hqDir(path)}${path}`;
  if (!existsSync(file)) return false;
  const type = path.endsWith('.css') ? 'text/css' : path.endsWith('.woff2') ? 'font/woff2' : 'text/javascript';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
  res.end(readFileSync(file));
  return true;
}
const imports = JSON.stringify({
  imports: Object.fromEntries([
    ['/__review/', '/guest/notebooks/review/'],
    ...Object.keys({ ...BOARD_EXTRAS, ...OPEN_EXTRAS }).map(path => [path, `/guest/notebooks${path}`]),
  ]),
});

// The guest's room around their book: the company's colours, fonts and logo inline, the rest in bookguestroom.css
export function servePage(res: ServerResponse, name: string, lang: guests.Lang) {
  const notebook = guests.hex(brand().colours?.notebook);
  const look = guests.look();
  const css =
    guests.palette() +
    look.fonts +
    guests.logoCss('.guest-logo') +
    guests.passkeyCss +
    `:root{${notebook ? `--notebook:${notebook};` : ''}--guest-font:${look.family}system-ui}`;
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

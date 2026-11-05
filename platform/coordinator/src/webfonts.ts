// The web fonts HQ's looks load from Google Fonts, for the watch-along's mirror (watchalong.ts): the brownstone's
// Pixelify Sans, the wire's Bricolage Grotesque. The replay can't reach outside, so the coordinator fetches them for it
// from the two hosts HQ's CSP takes fonts from (FONT_HOSTS, which pages.ts and server.ts build theirs from), and
// nothing else there: a stylesheet of fonts (fonts.googleapis.com/css2), a font file (fonts.gstatic.com). GETs with
// nothing held, as any visitor's, within the time asked, each typed by its address as a preview's files are
// (previewfiles.ts). Kept in memory by address: a font file's never changes, and a stylesheet's fonts stay at their
// addresses when Google moves on to newer ones.
import { extname } from 'node:path';
import { FONT_FILES, STYLESHEETS } from '../../../shared/watchalong/fonthosts.js';

// (as a policy names them.)
export const FONT_HOSTS = { stylesheets: `https://${STYLESHEETS}`, files: `https://${FONT_FILES}` };
const STYLESHEET_PATHS = ['/css', '/css2'];
const FONT_TYPES = new Map([
  ['.woff2', 'font/woff2'],
  ['.woff', 'font/woff'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
]);
// What's kept: HQ's looks ask for 11 files, 1.7 MB in all, the largest 0.4 MB (measured 5 November 2026). Room for
// ten times that; past it the oldest go, and come again when next asked for. A file bigger than all of it fails.
export const KEPT_BYTES = 16 * 1024 * 1024;

export type WebFont = { type: string; body: Buffer };

// get: how a file is fetched (fetch; a test's stand-in)
export function webFonts(get: typeof fetch = fetch) {
  const kept = new Map<string, WebFont>();
  let keptBytes = 0;
  // A font or a stylesheet of fonts for an address, within ms: null for any other address, or one Google doesn't have
  // (404). Any other answer, too big or too slow fails.
  return async (url: URL, ms: number): Promise<WebFont | null> => {
    const type = typeOf(url);
    if (!type) return null;
    const held = kept.get(url.href);
    if (held) return held;
    const response = await get(url, { redirect: 'error', signal: AbortSignal.timeout(ms) });
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error(`${response.status} from ${url.host}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > KEPT_BYTES) throw new Error(`larger than ${KEPT_BYTES / 1024 / 1024} MB`);
    const font = { type, body };
    kept.set(url.href, font);
    // (each by its address too)
    keptBytes += url.href.length + body.length;
    for (const [address, { body }] of kept) {
      if (keptBytes <= KEPT_BYTES) break;
      kept.delete(address);
      keptBytes -= address.length + body.length;
    }
    return font;
  };
}

// (field by field: https on its own port, nothing signed in)
function typeOf(url: URL) {
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  if (url.hostname === STYLESHEETS) return STYLESHEET_PATHS.includes(url.pathname) ? 'text/css' : null;
  if (url.hostname === FONT_FILES) return FONT_TYPES.get(extname(url.pathname).toLowerCase()) ?? null;
  return null;
}

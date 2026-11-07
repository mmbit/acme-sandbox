// HQ's fonts in a browser check as the board gets them: the families the company keeps in its kits from their files,
// any other from Google once, kept in a folder so every later page (and the other side of a comparison) lays out in
// the same type.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FONT_MS = 10_000; // Google's answer for a font, or the screen that asked fails on that side

// The font files the company keeps in its kits (kits/<kit>/fonts/<family>.woff2, the family's name in lower case with
// dashes), by family
export function keptFonts(kits) {
  const files = new Map();
  for (const kit of existsSync(kits) ? readdirSync(kits) : []) {
    const folder = join(kits, kit, 'fonts');
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder).filter(n => n.endsWith('.woff2')))
      files.set(name.slice(0, -'.woff2'.length), join(folder, name));
  }
  return files;
}

// A Google Fonts stylesheet answered with the kept files of the families it asks for, each at a Google address of its
// own (/kept/<name>.woff2, answered here: HQ's CSP takes fonts only from 'self' and fonts.gstatic.com, never data:),
// any other font request with what Google answered the first side that asked (side.fonts keeps it, both sides'). One
// Google doesn't give goes on `unfetched`, so its screen fails on that side rather than shot in another typeface.
export async function fulfilFonts(route, side, kept, unfetched) {
  const url = new URL(route.request().url());
  if (url.hostname === 'fonts.gstatic.com' && url.pathname.startsWith('/kept/'))
    return route.fulfill({ contentType: 'font/woff2', body: readFileSync(kept.get(url.pathname.slice(6, -6))) });
  const families = url.searchParams.getAll('family').map(f => f.split(':')[0]),
    names = families.map(family => family.toLowerCase().replaceAll(' ', '-'));
  if (names.length && names.every(name => kept.has(name))) {
    const faces = families.map(
      (family, i) =>
        `@font-face { font-family: '${family}'; src: url(https://fonts.gstatic.com/kept/${names[i]}.woff2) format('woff2'); font-weight: 100 900; }`,
    );
    return route.fulfill({ contentType: 'text/css', body: faces.join('\n') });
  }
  const file = join(side.fonts, createHash('sha256').update(url.href).digest('hex'));
  if (!existsSync(file)) {
    const answer = await route.fetch({ timeout: FONT_MS }).catch(error => error);
    const cause = answer instanceof Error ? answer.message.split('\n')[0] : !answer.ok() && `HTTP ${answer.status()}`;
    if (cause) {
      unfetched.push(`font ${url.href}: ${cause}`);
      return route.abort();
    }
    writeFileSync(file, await answer.body());
    writeFileSync(`${file}.type`, answer.headers()['content-type'] ?? 'text/css');
  }
  return route.fulfill({ contentType: readFileSync(`${file}.type`, 'utf8'), body: readFileSync(file) });
}

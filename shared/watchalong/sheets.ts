// A recorded page's linked stylesheets as their files say them, for the mirror's replay. rrweb's recorder inlines a
// linked stylesheet as the recording browser's reading of its rules (`_cssText`), and Chromium leaves out a declaration
// it can't write back: a shorthand with a var() in it (HQ's `font: 16px/1.4 var(--font)` on html and body), so a replay
// of the recorder's reading draws that type in the default serif. The recorder keeps such a stylesheet's address
// (watchalong.js withAddress), and the replay gets the file's own text where the mirror can answer it (the owner's
// answer: HQ's from disk, a preview's), its addresses made absolute as rrweb makes them; one it can't keeps the
// recorder's reading. The rules stay inline, same-origin to the replay, so media.js still reads them.
import type { Answer } from '../chromium/chromium.ts';
import type { RecordedEvent } from './store.ts';

// A mirror's stylesheets: each one's text by its address, null when the mirror has none (asked once per address), and
// the bytes they hold, their addresses' too
export type Sheets = { texts: Map<string, string | null>; bytes: number };
export const noSheets = (): Sheets => ({ texts: new Map(), bytes: 0 });
// What a mirror's stylesheets may come to, held and in the JSON of one step's events (the addresses are a recording's,
// a guest's own): a quarter of the 60 MB a further mirror takes (README.md), 25 times HQ's and the kits' stylesheets
// all together (0.64 MB, measured 5 November 2026); and how many files are read at once. Past it the step fails, and
// the mirror closes. A character counts as a byte, as CSS's are.
export const SHEETS_BYTES = 16 << 20,
  READS = 8;

// The events as JSON for the replay, each inlined stylesheet with a known address its file's text (text: the file's at
// an address, null for none). The stylesheet's attributes are the same wherever they come: a full snapshot's node, a
// mutation's added node, or a mutation of its attributes (rrweb's once a stylesheet loads after its link went in).
export async function sheeted(
  events: RecordedEvent[],
  sheets: Sheets,
  text: (address: string) => Promise<string | null>,
) {
  for (;;) {
    const missing = new Set<string>();
    let bytes = sheets.bytes;
    const json = JSON.stringify(events, (_, value: unknown) => {
      const address = sheetOf(value);
      if (!address) return value;
      if (!sheets.texts.has(address)) missing.add(address);
      const css = sheets.texts.get(address);
      if (!css) return value;
      within((bytes += css.length));
      return { ...(value as object), _cssText: css };
    });
    if (!missing.size) return json;
    const reads = [...missing];
    while (reads.length)
      await Promise.all(
        reads.splice(0, READS).map(async address => {
          const css = await fileOf(address, text);
          sheets.texts.set(address, css);
          within((sheets.bytes += address.length + (css?.length ?? 0)));
        }),
      );
  }
}
const within = (bytes: number) => {
  if (bytes > SHEETS_BYTES) throw new Error(`the recording's stylesheets come to over ${SHEETS_BYTES >> 20} MB`);
};

// A stylesheet's text in an answer of the mirror's owner (mirror.ts), null for none or another kind of file
export const cssIn = (answer: Answer) => (answer?.type.startsWith('text/css') ? answer.body.toString('utf8') : null);

// An inlined stylesheet's address, from its attributes
function sheetOf(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { _cssText, href } = value as { _cssText?: unknown; href?: unknown };
  return typeof _cssText === 'string' && typeof href === 'string' && URL.canParse(href) ? href : null;
}

// A stylesheet's file with its addresses made absolute, and what it imports (a plain @import, no media or layer) in it
// as rrweb inlines it, so its rules are read with the rest (media.js); null when the mirror has none
async function fileOf(
  address: string,
  text: (address: string) => Promise<string | null>,
  depth = 0,
): Promise<string | null> {
  const css = await text(address).catch(() => null);
  if (css === null) return null;
  const made = absolute(css, address);
  const imports = [...made.matchAll(IMPORTS)];
  const inlined = await Promise.all(
    imports.map(([, , url, , imported]) => (depth < IMPORT_DEPTH ? fileOf(url ?? imported, text, depth + 1) : null)),
  );
  let at = 0;
  return made.replace(IMPORTS, whole => inlined[at++] ?? whole);
}
// (an import of an import, as far as any of ours goes and well past: a stylesheet that imports itself ends there)
const IMPORT_DEPTH = 4;
const IMPORTS = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*;/g;

// A stylesheet's text with its addresses (url() and @import's) made absolute against its own, as the replay reads it
// on another page: one already absolute, a data: one or a fragment stays as it is
const URLS = /url\(\s*(['"]?)([^'")]+)\1\s*\)|@import\s+(['"])([^'"]+)\3/g;
export function absolute(css: string, address: string) {
  const made = (url: string) => (/^([a-z][a-z0-9+.-]*:|#)/i.test(url) ? url : new URL(url, address).href);
  return css.replace(URLS, (_, quote: string, url?: string, importQuote?: string, imported?: string) =>
    url !== undefined
      ? `url(${quote}${made(url.trim())}${quote})`
      : `@import ${importQuote}${made(imported!)}${importQuote}`,
  );
}

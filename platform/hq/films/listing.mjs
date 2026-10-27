// The tips' films a company has: the file names in its theme/hq/films/ (tip-films.mjs records them there), which both
// servers answer films/films.json with. HQ shows a tip without its film in a look as text only (shell/tipcard.js).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// theme: the company's HQ folder, theme/hq. Each film's .mp4 and its still's .jpg, by name.
export function filmFiles(theme) {
  const films = join(theme, 'films');
  return existsSync(films)
    ? readdirSync(films)
        .filter(name => /\.(mp4|jpg)$/.test(name))
        .sort()
    : [];
}

// What build.mjs inlines into a deck's page (the sound kit, deck.js, deck.css), and which built decks no longer carry
// today's copy: a deck plays the kit it was built with, so a kit change reaches it only by a rebuild.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const BUILT = /<!-- Built by shared\/deck\/build\.mjs from (.+?)\. Edit the spec/;
const NO_SOUNDS = 'const deckFoley = null;';

// The inlined parts, each exactly as the page carries it ("sfx": false in a spec leaves the kit out).
export const parts = (sfx = true) => ({
  kit: sfx ? `const deckFoley = (() => {\n${readFileSync(join(here, '../demo/foley.js'), 'utf8').replace(/^export /gm, '')}\nreturn foley;\n})();` : NO_SOUNDS,
  'deck.js': readFileSync(join(here, 'deck.js'), 'utf8'),
  'deck.css': readFileSync(join(here, 'deck.css'), 'utf8'),
});

// Every built deck in the repository (tracked or new), with its spec and the parts it carries an old copy of.
// `only` narrows the parts looked at, e.g. ['kit'].
export function builtDecks(root, only) {
  const listed = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '*.html'], { encoding: 'utf8' });
  const decks = [];
  for (const path of new Set(listed.split('\0').filter(Boolean))) {
    let page;
    try { page = readFileSync(join(root, path), 'utf8'); } catch { continue; /* listed but deleted in the worktree */ }
    const built = BUILT.exec(page);
    if (built) decks.push({ path, spec: join(dirname(path), built[1]), stale: stale(page, only) });
  }
  return decks;
}

// The parts a built page carries an old copy of.
export function stale(page, only = ['kit', 'deck.js', 'deck.css']) {
  const today = parts(!page.includes(NO_SOUNDS));
  return only.filter((name) => !page.includes(today[name]));
}

// The command that rebuilds a deck, from the repository's root.
export const rebuild = (deck) => `node shared/deck/build.mjs ${deck.spec}`;

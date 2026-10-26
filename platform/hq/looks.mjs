// The looks HQ ships, read from their folders: each renderers/<name>/ with a scene.js, dressed when it brings a skin.css
// and a sounds.js (its UI over the shell's, its sounds over the platform's clicks). Both servers answer
// renderers/looks.json with it, and the checks loop over it. A look says its style in its scene.js (`style`).
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HQ_DIR = dirname(fileURLToPath(import.meta.url));

// hq: the folder HQ is served from (the coordinator's checkout of platform/hq). [{ name, dressed }] by name.
export function looks(hq = HQ_DIR) {
  const renderers = join(hq, 'renderers');
  return readdirSync(renderers, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(renderers, entry.name, 'scene.js')))
    .map(entry => ({ name: entry.name, dressed: existsSync(join(renderers, entry.name, 'skin.css')) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const lookNames = (hq = HQ_DIR) => looks(hq).map(look => look.name);

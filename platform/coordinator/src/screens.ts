// The screens the board reads on, as the company's settings give them (brand.yaml screens: 'desktop Chrome at 1440 ×
// 900, or the iPad mini at 1133 × 744'), each width × height in CSS px, in the order given; left out, a desktop
// browser's. Read here rather than with company.ts's brand(), so what places answers (ink/answerspot.ts) and the page
// checks that import it don't load the coordinator's database.
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { REPO_DIR } from './config.ts';

export type Screen = { width: number; height: number };
const DESKTOP: Screen = { width: 1440, height: 900 };

export function boardScreens(file = `${REPO_DIR}/company/brand.yaml`): Screen[] {
  const said: unknown = existsSync(file) ? parse(readFileSync(file, 'utf8'))?.screens : undefined;
  if (said === undefined) return [DESKTOP];
  const sizes =
    typeof said === 'string'
      ? [...said.matchAll(/(\d+)\s*[×x]\s*(\d+)/g)].map(([, w, h]) => ({ width: Number(w), height: Number(h) }))
      : [];
  if (!sizes.length) throw new Error(`${file}'s screens ${JSON.stringify(said)} names no <width> × <height>`);
  return sizes;
}

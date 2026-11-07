// The screens a browser check measures on: the board's own, which a company lists in company/screens.json, or a generic
// set when it lists none.
import { existsSync, readFileSync } from 'node:fs';

export const SCREENS_FILE = 'company/screens.json'; // (from the repo's root)

// A generic phone (in Safari, with its notch and home bar) and tablet both ways, a laptop and a QHD monitor, each as
// company/screens.json has them: { name, width, height, ratio: device pixels per CSS pixel (1 if none), touch,
// inset: [top, right, bottom, left] safe areas, colorScheme (light if none) }
export const GENERIC_SCREENS = [
  { name: 'phone portrait', width: 390, height: 844, ratio: 3, touch: true, inset: [47, 0, 34, 0] },
  { name: 'phone landscape', width: 844, height: 390, ratio: 3, touch: true, inset: [0, 47, 21, 47] },
  { name: 'tablet portrait', width: 820, height: 1180, ratio: 2, touch: true },
  { name: 'tablet landscape', width: 1180, height: 820, ratio: 2, touch: true },
  { name: 'laptop', width: 1440, height: 800, ratio: 2 },
  { name: 'QHD monitor', width: 2560, height: 1300 },
];

// The screens in file, or the generic ones when there's no such file
export function screensIn(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).screens : GENERIC_SCREENS;
}

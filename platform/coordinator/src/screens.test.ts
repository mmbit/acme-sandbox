// node --test src/screens.test.ts   (the board's screens from the company's settings, brand.yaml screens)
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { boardScreens } from './screens.ts';

const dir = mkdtempSync(`${tmpdir()}/screens-test-`);
after(() => rmSync(dir, { recursive: true, force: true }));
const brand = (text: string) => {
  writeFileSync(`${dir}/brand.yaml`, text);
  return boardScreens(`${dir}/brand.yaml`);
};

test("each size the setting names, in its order; left out, a desktop browser's; naming none, an error", () => {
  assert.deepEqual(brand('screens: desktop Chrome at 1440 × 900, or the iPad mini at 1133 × 744\n'), [
    { width: 1440, height: 900 },
    { width: 1133, height: 744 },
  ]);
  assert.deepEqual(brand('screens: an iPad at 1180x820\n'), [{ width: 1180, height: 820 }]);
  const desktop = [{ width: 1440, height: 900 }];
  assert.deepEqual(brand('name: Example\n'), desktop, 'no screens');
  assert.throws(() => brand('screens: a phone\n'), Error, 'none sized');
  assert.throws(() => brand('screens: [1440, 900]\n'), Error, 'not words');
  assert.deepEqual(boardScreens(`${dir}/missing.yaml`), desktop, 'no brand');
});

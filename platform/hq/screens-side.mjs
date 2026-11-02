#!/usr/bin/env node
// One side of screens-compare.mjs: a tree's own coordinator on the test company, filled by screens-seed.mjs, its HQ
// shot by screens-shots.mjs. A process of its own, as the coordinator reads its settings once at its first import.
//   node platform/hq/screens-side.mjs <tree> <shots folder> <fonts folder> <{"looks":[...],"devices":{...}}>
// (screens-compare.mjs starts it, the fonts folder and the looks and devices the same for both sides; it writes
// side.json in the shots folder)
import { cpSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { seed, writeCompany } from './screens-seed.mjs';
import { shoot } from './screens-shots.mjs';

const [tree, shots, fonts, shooting] = process.argv.slice(2);
const { looks, devices } = JSON.parse(shooting);
// The side's clock: Date runs from a fixed start that each step sets (real time passing within it), so both sides
// write and read the same times. The coordinator reads Date when it's called, so the swap below reaches all of it.
// SEEDED: the first step's minute; a step a minute later each. RENDERED: when the screens are shot, half a step past
// a minute, so a time a step or a render takes (seconds) never moves a shown minute.
const RealDate = Date,
  SEEDED = RealDate.UTC(2026, 9, 14, 7, 0),
  RENDERED = SEEDED + 2 * 3_600_000 + 30_000;
let offset = 0;
function ShiftedDate(...args) {
  if (!new.target) return new RealDate(RealDate.now() + offset).toString();
  return Reflect.construct(RealDate, args.length ? args : [RealDate.now() + offset], new.target);
}
Object.assign(ShiftedDate, { prototype: RealDate.prototype, parse: RealDate.parse, UTC: RealDate.UTC });
ShiftedDate.now = () => RealDate.now() + offset;
globalThis.Date = ShiftedDate;
const setClock = at => (offset = at - RealDate.now());

const outcome = { shots: [], errors: [] };
try {
  setClock(SEEDED);
  const { harness } = await import(join(tree, 'platform/coordinator/src/harness.ts'));
  const h = await harness('screens', {
    env: { PUBLIC_HOST: 'hq.screens.test', KITS_DIR: join(tree, 'kits') },
    before: repo => {
      rmSync(join(repo, 'theme'), { recursive: true, force: true });
      cpSync(join(tree, 'theme'), join(repo, 'theme'), { recursive: true });
      writeCompany(repo);
    },
  });
  const { ORIGIN } = await import(join(tree, 'platform/coordinator/src/config.ts'));
  try {
    await seed(h, step => setClock(SEEDED + step * 60_000));
  } catch (error) {
    throw new Error(`the seed failed: ${error.message}`, { cause: error });
  }
  await shoot({
    h,
    origin: ORIGIN,
    kits: join(tree, 'kits'),
    fonts,
    shots,
    outcome,
    at: RENDERED,
    setClock,
    looks,
    devices,
  });
  h.server.closeAllConnections();
  h.server.close();
} catch (error) {
  console.error(error);
  outcome.failed = error.message.split('\n')[0];
}
writeFileSync(join(shots, 'side.json'), JSON.stringify(outcome, null, 2));
process.exit(0);

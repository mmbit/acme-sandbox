// The company's clock as HQ reads it, without HQ's database. Run as a script, it publishes it in DATA_DIR for the deploy
// to give the products (infra/sync.sh, infra/products.py).
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import { DATA_DIR, REPO_DIR } from './config.ts';

// org.yaml's company.timeZone, an IANA name, or UTC without one. A name that isn't a time zone throws: it's our own config,
// fixed there, never read as UTC. Each name is checked once: the clock is read for every event, and making a formatter
// takes ~0.2 ms.
const zones = new Map<string, string>();
export function zoneOf(org: any) {
  const tz = org?.company?.timeZone;
  if (tz == null) return 'UTC';
  if (!zones.has(tz)) {
    try {
      zones.set(tz, new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone);
    } catch {
      throw new Error(`company/org.yaml: company.timeZone ${JSON.stringify(tz)} isn't a time zone`);
    }
  }
  return zones.get(tz)!;
}

// A broken or missing org.yaml throws, so the deploy stops before any product gets a clock.
if (import.meta.main) {
  const file = `${DATA_DIR}/time-zone`;
  writeFileSync(`${file}.new`, zoneOf(parse(readFileSync(`${REPO_DIR}/company/org.yaml`, 'utf8'))));
  renameSync(`${file}.new`, file); // (whole or not at all, for a deploy reading it meanwhile)
}

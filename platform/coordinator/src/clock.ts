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

// A time on a zone's clock, in ms, at the zone's offset on that date (company.ts companyMoment)
export function momentIn(zone: string, y: number, m: number, d: number, hour: number, minute: number) {
  const local = Date.UTC(y, m - 1, d, hour, minute);
  let at = local;
  for (let i = 0; i < 2; i++) at = local - offset(zone, at); // twice: the offset may differ on either side of a clock change
  return at;
}
function offset(zone: string, at: number) {
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const numericParts = clock.formatToParts(at).map(p => [p.type, Number(p.value)]);
  const parts = Object.fromEntries(numericParts);
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
    Math.floor(at / 1000) * 1000
  );
}

// A broken or missing org.yaml throws, so the deploy stops before any product gets a clock.
if (import.meta.main) {
  const file = `${DATA_DIR}/time-zone`;
  writeFileSync(`${file}.new`, zoneOf(parse(readFileSync(`${REPO_DIR}/company/org.yaml`, 'utf8'))));
  renameSync(`${file}.new`, file); // (whole or not at all, for a deploy reading it meanwhile)
}

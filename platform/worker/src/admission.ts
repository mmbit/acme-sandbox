// Worker admission from host availability, capped working-set room and startup/meeting reservations.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reservations } from './reserve.ts';

export function admission<Seat>(now = Date.now, kernel = '/sys/fs/cgroup', meminfo = '/proc/meminfo') {
  const reserve = reservations<Seat>(now);
  const availableMb = () => {
    const host = hostAvailableBytes(meminfo) / 2 ** 20;
    const cache = Number(cgroup('memory.stat', kernel).match(/^inactive_file (\d+)/m)?.[1] ?? 0);
    const cap = Number(cgroup('memory.max', kernel)),
      used = Number(cgroup('memory.current', kernel)) - cache;
    const mine = cap && used ? (cap - used) / 2 ** 20 : host;
    return Math.min(mine, host);
  };
  return {
    ...reserve,
    availableMb,
    freeMb: (young = true) => reserve.freeMb(availableMb(), young),
    claimMb: (young = true) => reserve.claimMb(availableMb(), young),
    gathering: () => reserve.gathering(availableMb()),
    starts: (young = true) => reserve.starts(availableMb(), young),
    room: (young = true) => reserve.room(availableMb(), young),
  };
}

export const hostAvailableBytes = (meminfo = '/proc/meminfo') =>
  Number(readFileSync(meminfo, 'utf8').match(/^MemAvailable:\s+(\d+)/m)![1]) * 1024;

export function cgroup(name: string, kernel = '/sys/fs/cgroup') {
  try {
    return readFileSync(join(kernel, name), 'utf8').trim();
  } catch {
    return '';
  }
}

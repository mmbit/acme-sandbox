// A company's own parts of the coordinator: each kits/<name>/coordinator.ts of the
// company's repo, loaded once at start in name order (template/kits/README.md). A part exports what it adds, all optional:
//   service  { '<path>': route, '<prefix>/*': route, 'POST <path>': route }   reached without the board's session, before the
//            platform's own: the caller brings its own token (a product server, a service of the company's), which the route
//            checks itself. A route is (req, res, path) => …, and answers the request itself; a method in front narrows it.
//   board    the same, behind the board's session (HQ's own pages call them)
//   agent    { 'GET /api/agent/<name>': (body, me) => … }   agents' routes, answered like the platform's: a value is the JSON,
//            a number an error status, [status, 'why'] (or a string, a 400) a refusal in words. Never on a call. A route the
//            platform has is refused at start.
//   numbers(app)  more fields for one app's numbers ({ slug, mode, days, … }, metrics.ts), for HQ's Numbers; `lines` among
//            them are plain text for hq numbers, printed under the app's own
//   dashboard(r)  its own tiles on the Numbers home, each a dashboard HQ prints like an app's (r: { days, from, to, apps,
//            baskets }, metrics.ts home()): one or a list of { id, name, about?, icon?, tile?, figures, daily?, bars?,
//            targets? } (template/kits/README.md has the shape); hq numbers prints them under its list. Numbers are
//            always figures, charts and tables, never a sentence with a few of them in bold
//   heartbeat()  its own parts of the CEO's summary, which the hourly check carries (summary.ts): one or a list of
//            { head, lines }, plain text the company wants its CEO to steer by (its stats, a funnel), read live each time
//   start()  its timers, once the coordinator is up
// The coordinator's image copies kits/ next to the platform (Dockerfile), as in the repo, so a part imports the platform by its
// path there (../../platform/coordinator/src/db.ts) and gets the modules the coordinator runs, never a second copy. It imports
// no package (the platform's node_modules aren't on its path): company.ts reads YAML for it.
import { existsSync, readdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { KITS_DIR } from './config.ts';
import * as tokens from './tokens.ts';
import type { RouteTable } from '../../../shared/routes/routes.ts';

type Route = (req: IncomingMessage, res: ServerResponse, path: string) => unknown;
export type Part = {
  service?: Record<string, Route>; board?: Record<string, Route>; agent?: Record<string, (body: any, me: any) => unknown>;
  numbers?: (app: any) => Record<string, unknown> | null | undefined; start?: () => void;
  dashboard?: (r: any) => Dashboard | Dashboard[] | null | undefined;
  heartbeat?: () => HeartbeatPart | HeartbeatPart[] | null | undefined;
};
export type HeartbeatPart = { head: string; lines: string[] };
// A dashboard of a company's own, as HQ's Numbers draws it (template/kits/README.md, "Numbers")
type Dashboard = { id: string; name: string; [field: string]: unknown };

const names = existsSync(KITS_DIR) ? readdirSync(KITS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(d.name) && existsSync(`${KITS_DIR}/${d.name}/coordinator.ts`)).map(d => d.name).sort() : [];
export const parts: { name: string; part: Part }[] = [];
for (const name of names) parts.push({ name, part: await import(pathToFileURL(`${KITS_DIR}/${name}/coordinator.ts`).href) });

// The parts' routes of a kind as rows of HQ's route table (shared/routes): a path for any method or the one in front, a
// prefix/* for the prefix itself and anything under it.
export function routeTable(kind: 'service' | 'board'): RouteTable {
  const rows: RouteTable = {};
  for (const { part } of parts) for (const [key, r] of Object.entries(part[kind] ?? {})) {
    const [method, path] = key.includes(' ') ? key.split(' ') : ['*', key];
    rows[`${method} ${path.endsWith('/*') ? `${path.slice(0, -2)}{/*}?` : path}`] ??= ({ req, res, url }) => r(req, res, url.pathname);
  }
  return rows;
}

// the agents' routes, each once: a name the platform (or another part) already answers is a mistake to fix, not to shadow
export function agentRoutes(taken: Set<string>) {
  const out: [string, (body: any, me: any) => unknown][] = [];
  for (const { name, part } of parts) for (const [k, r] of Object.entries(part.agent ?? {})) {
    if (taken.has(k)) throw new Error(`kits/${name} wants ${k}, which is already answered`);
    taken.add(k); out.push([k, r]);
  }
  return out;
}

// one app's numbers with what the parts add for it: their fields, and their plain lines for agents (hq numbers) joined
export function numbers(r: any) {
  if (!r?.slug) return Array.isArray(r?.apps) ? home(r) : r;
  const out = { ...r }, lines: string[] = [];
  for (const { name, part } of parts) {
    let more;
    try { more = part.numbers?.(r); } catch (e) { console.error(`kits/${name}: its numbers for ${r.slug} failed:`, e); }
    if (!more) continue;
    const { lines: own, ...fields } = more as { lines?: unknown };
    Object.assign(out, fields);
    if (Array.isArray(own)) lines.push(...own.map(String));
  }
  return lines.length ? { ...out, lines } : out;
}

// the Numbers home with the parts' dashboards, each a tile of its own, and the platform's Tokens last (tokens.ts;
function home(r: any) {
  const platform = tokens.dashboard(r);
  return { ...r, dashboards: [...partsDashboards(r, platform.id), platform] };
}
function partsDashboards(r: any, taken: string) {
  const dashboards: Dashboard[] = [];
  for (const { name, part } of parts) {
    let made;
    try { made = part.dashboard?.(r); } catch (e) { console.error(`kits/${name}: its dashboard on the Numbers home failed:`, e); }
    for (const d of [made ?? []].flat()) {
      if (typeof d?.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(d.id) && typeof d.name === 'string' && d.id !== taken && !dashboards.some(x => x.id === d.id)) dashboards.push(d);
      else console.error(`kits/${name}: a dashboard needs a new id (lowercase, digits and -) and a name`);
    }
  }
  return dashboards;
}
for (const { name, part } of parts) if ('home' in part) console.error(`kits/${name}: home() is gone: the Numbers home takes dashboard() (template/kits/README.md)`);

// The parts' own parts of the CEO's summary. One that fails says so in its place, so the CEO knows what it's missing.
export function heartbeat(): HeartbeatPart[] {
  return parts.flatMap(({ name, part }) => {
    try {
      return [part.heartbeat?.() ?? []].flat();
    } catch (e) {
      console.error(`kits/${name}: its heartbeat part failed:`, e);
      return [{ head: `kits/${name}'s part`, lines: [`couldn't be read: ${(e as Error).message}`] }];
    }
  });
}

export const start = () => { for (const { name, part } of parts) try { part.start?.(); } catch (e) { console.error(`kits/${name}: start failed:`, e); } };

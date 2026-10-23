// Where the coordinator's start goes on the server: server.ts imports this first, so it runs once every module is read,
// and samples the CPU from then until the start line, which names the busiest source lines.
import { Session } from 'node:inspector';
import { pathToFileURL } from 'node:url';

// Only when server.ts runs as the program: tests import it too.
const serving =
  !!process.argv[1] && pathToFileURL(process.argv[1]).href === new URL('./server.ts', import.meta.url).href;

// Every module is read, stripped of its types and linked before the first one runs.
export const READ_MS = performance.now();

let session: Session | undefined;
if (serving) {
  session = new Session();
  session.connect();
  session.post('Profiler.enable');
  session.post('Profiler.start');
}

type Frame = { url: string; functionName: string; lineNumber: number };
type ProfileNode = {
  id: number;
  callFrame: Frame;
  children?: number[];
  positionTicks?: { line: number; ticks: number }[];
};
type Profile = { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] };

// Stops the sampling and returns where the CPU went, the most first ('' when not sampling). A sample in our code names
// its line (`mail.ts:76`); one in a package or a native call names our function it came from and what it was in
// (`db.ts (top level) in exec`); V8's own work has its own name (`(garbage collector)`).
export function busiest(count = 8) {
  const profile = stopProfile();
  if (!profile) return '';
  const millisecondsByPlace = sumMillisecondsByPlace(profile);
  millisecondsByPlace.delete('(idle)');
  return [...millisecondsByPlace]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([place, milliseconds]) => `${place} ${(milliseconds / 1000).toFixed(2)} s`)
    .join(', ');
}

function stopProfile(): Profile | undefined {
  if (!session) return undefined;
  let profile: Profile | undefined;
  session.post('Profiler.stop', (err, result) => {
    if (!err) profile = result.profile as Profile;
  });
  session.disconnect();
  session = undefined;
  return profile;
}

function sumMillisecondsByPlace(profile: Profile) {
  const nodeById = new Map(profile.nodes.map(node => [node.id, node]));
  const parentOf = new Map(profile.nodes.flatMap(node => (node.children ?? []).map(child => [child, node] as const)));
  const millisecondsByNodeId = new Map<number, number>();
  profile.samples.forEach((nodeId, i) => {
    millisecondsByNodeId.set(nodeId, (millisecondsByNodeId.get(nodeId) ?? 0) + profile.timeDeltas[i] / 1000);
  });
  const millisecondsByPlace = new Map<string, number>();
  const add = (place: string, milliseconds: number) =>
    millisecondsByPlace.set(place, (millisecondsByPlace.get(place) ?? 0) + milliseconds);
  for (const [nodeId, milliseconds] of millisecondsByNodeId) {
    const leaf = nodeById.get(nodeId)!;
    const lines = leaf.positionTicks ?? [];
    const ticks = lines.reduce((sum, line) => sum + line.ticks, 0);
    if (ownCode(leaf.callFrame.url) && ticks) {
      for (const line of lines) add(`${fileOf(leaf.callFrame.url)}:${line.line}`, (milliseconds * line.ticks) / ticks);
    } else {
      add(placeOf(leaf, parentOf), milliseconds);
    }
  }
  return millisecondsByPlace;
}

function placeOf(leaf: ProfileNode, parentOf: Map<number, ProfileNode>) {
  let ownFrame = leaf;
  while (!ownCode(ownFrame.callFrame.url) && parentOf.has(ownFrame.id)) ownFrame = parentOf.get(ownFrame.id)!;
  if (!ownCode(ownFrame.callFrame.url)) return calleeOf(leaf.callFrame);
  if (ownFrame === leaf) return functionOf(ownFrame.callFrame);
  return `${functionOf(ownFrame.callFrame)} in ${calleeOf(leaf.callFrame)}`;
}

// Our own code: the coordinator's and the company's kits, not a package's or node's
const ownCode = (url: string) => url.startsWith('file:') && !url.includes('/node_modules/');
const functionOf = ({ url, functionName, lineNumber }: Frame) =>
  functionName ? `${fileOf(url)}:${lineNumber + 1} ${functionName}` : `${fileOf(url)} (top level)`;
const fileOf = (url: string) => {
  const sourceDirectoryUrl = new URL('./', import.meta.url).href;
  return url.startsWith(sourceDirectoryUrl)
    ? url.slice(sourceDirectoryUrl.length)
    : url.replace(/^.*\/(kits|platform)\//, '$1/');
};
// what our code was in: a package, a node built-in, or a native call like node:sqlite's `run`
const calleeOf = ({ url, functionName }: Frame) =>
  /\/node_modules\/((@[^/]+\/)?[^/]+)/.exec(url)?.[1] ??
  (url.startsWith('node:') ? url : functionName || url || 'native');

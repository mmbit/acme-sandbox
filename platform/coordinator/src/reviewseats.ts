// Who among a round's seated readers takes the look and the foundation question, after the engine constraints move files
// between seats (reviewtriage.ts read)
import * as visual from './visual.ts';
import type { Read } from './reviewtriage.ts';

// The looker triage chose, or the seat its visual files moved to; undefined when it reads none of them
export function lookerOf(chosen: string | null, readers: Read[], assigned: Read[], consolidator: string | undefined) {
  if (chosen === null) return null;
  const original = readers.find(reader => reader.agent === chosen);
  const retained = assigned.find(reader => reader.agent === chosen);
  if (!original && !retained && chosen !== consolidator) return undefined;
  if (!assigned.length) return consolidator;
  if (!readers.length && chosen === consolidator) return chosen;
  const scope = original?.files ?? assigned.flatMap(reader => reader.files);
  const shown = visual.visualFor(scope).flatMap(check => check.files);
  if (!shown.length && retained) return retained.agent;
  const files = shown.length ? shown : (original?.files ?? []);
  if (retained?.files.some(file => files.includes(file))) return retained.agent;
  return assigned.find(reader => reader.files.some(file => files.includes(file)))?.agent;
}

// The readers asked the foundation question: the one triage gave it, and any seat engine constraints moved that reader's
// files to; undefined when triage named no reader of its own
export function foundationOf(chosen: string | null, readers: Read[], assigned: Read[]) {
  if (chosen === null) return [];
  const original = readers.find(reader => reader.agent === chosen);
  if (!original) return undefined;
  const kept = assigned.filter(reader => reader.agent === chosen).flatMap(reader => reader.files);
  const moved = original.files.filter(file => !kept.includes(file));
  return assigned
    .filter(reader => reader.agent === chosen || reader.files.some(file => moved.includes(file)))
    .map(reader => reader.agent);
}

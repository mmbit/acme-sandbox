// A deliverable's queued task in its turn, in words, only what the turn adds to its waits: the task before it whose work
// it needs, and the held tasks drawn before it that it goes ahead of (threadorder.ts inTurn). What holds it stays the
// waits' to say. hq job's answer, hq deliverable and hq plan say it.
import { prepared } from './db.ts';
import { isTask, reader, type Job } from './threadorder.ts';

type Turn = { needs: number | null; passed: number[] };
const OPEN = ['queued', 'running', 'blocked'];

// One reader for a whole list: each thread read once
export function turnWords() {
  const turnOf = turns();
  return (id: number) => {
    const turn = turnOf(id);
    return turn && words(turn);
  };
}

// hq plan's project (plan.ts planOf) with each task's turn in words (turnWords)
export function inPlan<P extends { threads: { tasks: { id: number }[] }[] }>(plan: P | undefined) {
  if (!plan) return undefined;
  const told = turnWords();
  return { ...plan, threads: plan.threads.map(t => ({ ...t, tasks: t.tasks.map(j => ({ ...j, turn: told(j.id) })) })) };
}

function turns() {
  const read = reader();
  return (id: number): Turn | null => {
    const row = prepared('select id, kind, pr, thread, branch, status, after from jobs where id = ?').get(id) as
      (Job & { status: string; after: number | null }) | undefined;
    if (!row || !isTask(row) || row.status !== 'queued') return null;
    const { tasks, turn } = read.of(row.thread);
    const drawn = tasks.findIndex(t => t.id === id),
      at = turn.findIndex(t => t.id === id);
    if (drawn < 0 || at < 0) return null;
    const needed = turn.slice(0, at).some(t => t.id === row.after && OPEN.includes(t.status));
    return {
      needs: needed ? row.after : null,
      passed: tasks.slice(0, drawn).flatMap(t => (turn.indexOf(t) > at ? [t.id] : [])),
    };
  };
}

function words({ needs, passed }: Turn) {
  const told = [
    ...(needs === null ? [] : [`It waits for #${needs} before it, whose work it needs (--after).`]),
    ...(passed.length
      ? [
          `It goes ahead of ${passed.map(id => `#${id}`).join(', ')}, drawn before it but held by a wait of their own ` +
            `(a card, a time, other work) or behind one, as it doesn't need their work (a step that does is queued ` +
            `--after the task it needs).`,
        ]
      : []),
  ];
  return told.length ? told.join(' ') : null;
}

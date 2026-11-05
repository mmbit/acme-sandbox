// A colleague's message (hq say) to an agent who is on a call with the board reaches that call too (offer: the call in
// messages.live_call): the board may be waiting on it there, and the call's agent has no job to read it in (call #258). The voice line takes them with each round of the transcript it keeps in HQ (call.ts kept), and the agent hears
// them with its next turn.
import { columnsOf, db } from './db.ts';
import './messages.ts'; // (its table first)

// (live_call: the call that hears it; call_told: when the voice line took it)
if (!columnsOf('messages').includes('live_call')) db.exec('alter table messages add column live_call integer');
if (!columnsOf('messages').includes('call_told')) db.exec('alter table messages add column call_told text');
db.exec(
  'create index if not exists messages_live_call on messages (live_call) where live_call is not null and call_told is null',
);

// Message `id` to `agent` goes to the agent's call with the board that's on now, if any: that call, for hq say to say.
export function offer(id: number, agent: string) {
  const live = db
    .prepare("select id from calls where agent = ? and status = 'live' order by id desc limit 1")
    .get(agent) as { id: number } | undefined;
  if (!live) return {};
  db.prepare('update messages set live_call = ? where id = ?').run(live.id, id);
  return { call: live.id };
}

// The messages for a live call the voice line hasn't passed on yet, taken now: who sent each, from which job, and its
// words.
export function forCall(call: number) {
  const due = db
    .prepare(
      `select id, sender, sender_job, text from messages where live_call = ? and call_told is null
    order by id`,
    )
    .all(call) as { id: number; sender: string; sender_job: number | null; text: string }[];
  const told = new Date().toISOString();
  for (const m of due) db.prepare('update messages set call_told = ? where id = ?').run(told, m.id);
  return due.map(m => ({ from: m.sender, job: m.sender_job, text: m.text }));
}

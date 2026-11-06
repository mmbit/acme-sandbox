// The name a scan of the board's call's code joins under (callguests.ts): as they typed it, told apart from everyone
// else's on the call, the board's and the agent's.
import { db } from './db.ts';

export const MAX_NAME = 40;
// A name as typed, its spaces tidied: some letters, no control characters, up to MAX_NAME long; null otherwise
export function nameOf(typed: string) {
  const n = typed.normalize('NFC').replace(/\s+/g, ' ').trim();
  return n.length <= MAX_NAME && /\p{L}/u.test(n) && !/[\p{C}<>]/u.test(n) ? n : null;
}
// The name the page and the agent know them by: as typed, or with a number when someone on the call already has it,
// or it's the board's or the agent's own (the agent hears 'Board' for the board's marks, 'the board' for its screen and
// 'screen 2' for its second, and the screen tool takes "the board's screen" and "the board's screen 2": watchturns.ts)
export function apart(call: number, name: string, agent: string) {
  const taken = new Set(
    (db.prepare('select name from call_scans where call = ?').all(call) as { name: string }[]).map(r =>
      r.name.toLowerCase(),
    ),
  );
  taken.add(agent.toLowerCase());
  const reserved = (shown: string) => taken.has(shown.toLowerCase()) || boardScreen(shown) !== null;
  // (every number on "the board's screen" is the board's too: theirs goes as 'Guest')
  const base = reserved(name) && boardScreen(`${name} 2`) !== null ? 'Guest' : name;
  let shown = base;
  for (let n = 2; reserved(shown); n++) shown = `${base} ${n}`;
  return shown;
}
// Which of the board's screens the agent and its screen tool take a name for, by the who the tool knows it by: 'the
// board' for its marks and the screen the call is on, 'screen 2' for its second ("the board's screen 2"); null for none
export function boardScreen(name: string) {
  const m = /^(?:(?:the )?board(?:'s screen)?|(?:(?:the )?board's )?(?<n>screen \d+))$/i.exec(name.trim());
  return m ? (m.groups?.n?.toLowerCase() ?? 'the board') : null;
}

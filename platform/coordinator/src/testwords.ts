// A word for each task a test makes or queues without a code (harness.ts: its jobs, hq job, hq inbox accept, hq meeting
// set and their routes), T and letters, and a prefix for each project it makes without one, Q and letters, so a test about something
// else needn't name them; jobcodes.test.ts tests the codes themselves.
let words = 0,
  prefixes = 0;
const letters = (n: number) => n.toString(26).replace(/./g, d => String.fromCharCode(65 + parseInt(d, 26)));
export const word = () => `T${letters(++words)}`;

export const testBudget = { tokens: { work: 1000, reviews: 200, fixes: 100, feedback: 0 }, feedback_rounds: 0 };
export const testConfidence = { level: 'medium' as const, why: 'Two close examples with limited feedback history' };
export const sizedTime = (time: string) =>
  time.trim().startsWith('{') ? time : JSON.stringify({ time, ...testBudget, confidence: testConfidence });

export function codedArgs(args: string[]) {
  const task =
    (args[0] === 'job' && args[1] !== 'move') ||
    (args[0] === 'inbox' && args[1] === 'accept' && /^\d+$/.test(args[2])) ||
    (args[0] === 'meeting' && args[1] === 'set');
  const coded = task && !args.includes('--code') ? [...args, '--code', word()] : args;
  const queues = (args[0] === 'job' && args[1] !== 'move') || (args[0] === 'inbox' && args[1] === 'accept');
  const sized =
    queues && !args.includes('--size')
      ? [...coded, '--size', '30m', '--why', 'Test scope judgment without a comparable completed job']
      : coded;
  const at = sized.indexOf('--size');
  if (at >= 0 && sized[at + 1]) sized[at + 1] = sizedTime(sized[at + 1]);
  if (sized[0] === 'estimate' && sized[1] === 'set' && sized[3]) sized[3] = sizedTime(sized[3]);
  return sized;
}
export function codedBody(route: string, body: unknown) {
  if (!body || typeof body !== 'object') return body;
  if (route === 'sizes' && 'time' in body) return { ...body, time: sizedTime(String(body.time)) };
  const queued =
    route === 'job' || route === 'proposals/accept'
      ? {
          ...testBudget,
          confidence: testConfidence,
          size: '30m',
          refs: [],
          why: 'Test scope judgment without a comparable completed job',
          ...body,
        }
      : body;
  if (route === 'proposals/accept' && 'size' in queued && typeof queued.size === 'string')
    queued.size = sizedTime(queued.size);
  if ('code' in queued) return queued;
  if (route === 'projects/new') return { ...queued, code: `Q${letters(++prefixes)}` };
  const task =
    route === 'job' ||
    route === 'meetings/set' ||
    (route === 'proposals/accept' && typeof (queued as { id?: unknown }).id === 'number');
  return task ? { ...queued, code: word() } : queued;
}

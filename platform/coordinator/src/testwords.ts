// A word for each task a test makes or queues without a code (harness.ts: its jobs, hq job, hq inbox accept, hq meeting
// set and their routes), T and letters, and a prefix for each project it makes without one, Q and letters, so a test about something
// else needn't name them; jobcodes.test.ts tests the codes themselves.
let words = 0,
  prefixes = 0;
const letters = (n: number) => n.toString(26).replace(/./g, d => String.fromCharCode(65 + parseInt(d, 26)));
export const word = () => `T${letters(++words)}`;

export const codedArgs = (a: string[]) =>
  a.includes('--code') ||
  !(
    (a[0] === 'job' && a[1] !== 'move') ||
    (a[0] === 'inbox' && a[1] === 'accept' && /^\d+$/.test(a[2])) ||
    (a[0] === 'meeting' && a[1] === 'set')
  )
    ? a
    : [...a, '--code', word()];
export function codedBody(route: string, body: unknown) {
  if (!body || typeof body !== 'object' || 'code' in body) return body;
  if (route === 'projects/new') return { ...body, code: `Q${letters(++prefixes)}` };
  const task =
    route === 'job' ||
    route === 'meetings/set' ||
    (route === 'proposals/accept' && typeof (body as { id?: unknown }).id === 'number');
  return task ? { ...body, code: word() } : body;
}

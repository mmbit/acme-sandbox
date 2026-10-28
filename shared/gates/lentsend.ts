// A lent run's upload (lent.ts sendRun), in a process of its own that ends once HQ has answered: fetch leaves what it
// read of the bundle in its process's memory after the send (the bundle holds the whole repo), and the check then waits
// on its helper for up to half an hour. Held by the check, that would be the worker's memory, kept from the jobs
// waiting to start for all that time.
// Arguments: the bundle's file and the run's x-run header. Prints {"id"}, {"refused"} (HQ's words) or {"unreached"}.
import { openAsBlob } from 'node:fs';
import { HqUnreachable, reaching } from './lent.ts';

const [file, run] = process.argv.slice(2);
const { HQ_URL: hq, HQ_TOKEN: token } = process.env;
const body = await openAsBlob(file);
let said: { id: number } | { refused: string } | { unreached: string };
try {
  // (the answer read inside: a connection lost after its headers is HQ unreached too)
  said = await reaching(async () => {
    const sent = await fetch(`${hq}/api/agent/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-run': run },
      body,
    });
    return sent.ok ? { id: ((await sent.json()) as { id: number }).id } : { refused: await sent.text() };
  }, true);
} catch (err) {
  if (!(err instanceof HqUnreachable)) throw err;
  said = { unreached: err.message };
}
process.stdout.write(JSON.stringify(said));

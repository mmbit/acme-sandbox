// The worker's HQ requests and reports, with retry and cancellation across reloads.
import { setTimeout as sleep } from 'node:timers/promises';

// Each blocked-report attempt has its own network deadline while the run is frozen.
const BLOCK_ASK_MS = 5_000;
// How long fetch waits for an answer when the request has no deadline of its own (undici's headersTimeout)
const FETCH_WAITS_MS = 300_000;

export function hqReports(url: string, token?: string) {
  // waitsMs: how long this request waits for HQ's answer, which HQ holds a job's request to (its reins)
  async function api(path: string, body: unknown = {}, signal?: AbortSignal, waitsMs = FETCH_WAITS_MS) {
    const response = await fetch(`${url}/api/worker/${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-hq-wait-ms': String(waitsMs),
      },
      signal,
    });
    if (!response.ok) throw new ResponseError(path, response.status);
    return response.json();
  }

  // Retry network failures for about two minutes. The signal interrupts the retry delay too.
  async function report(path: string, body: Record<string, unknown>, ms?: number, signal?: AbortSignal) {
    for (let wait = 1000; ; wait *= 2) {
      signal?.throwIfAborted();
      try {
        const timeout = ms ? AbortSignal.timeout(ms) : undefined;
        const deadline = signal && timeout ? AbortSignal.any([signal, timeout]) : (signal ?? timeout);
        return await api(path, body, deadline, ms);
      } catch (err) {
        if (!(err instanceof TypeError) || wait > 64_000) throw err;
        await sleep(wait, undefined, { signal });
      }
    }
  }

  const blocked = (body: Record<string, unknown>, signal?: AbortSignal) =>
    report('blocked', body, BLOCK_ASK_MS, signal);
  return { api, report, blocked };
}

// An HTTP error settles a report. A fetch network failure throws TypeError instead.
export class ResponseError extends Error {
  readonly status: number;
  constructor(path: string, status: number) {
    super(`${path}: ${status}`);
    this.status = status;
  }
}

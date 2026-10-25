// HQ's agent API (/api/agent/<route>) as hq calls it, with the job's token in a header. The token never goes on a
// command line, where any uid could read it (/proc/<pid>/cmdline).
// Agents and scripts read a failed call's exit code: 22 for an answer of 400 or more where only success will do, 6 or 7
// when HQ can't be reached, 28 for a time-out (only a command that asks for one has one).
import http from 'node:http';
import https from 'node:https';
import { shown, stop } from './output.ts';

export type Answer = { status: number; body: string };

// bytes: a body sent as it is (hq run's bundle), with headers of its own
type CallOptions = { body?: unknown; bytes?: Buffer; headers?: Record<string, string>; timeoutMs?: number };

export class ApiError extends Error {
  exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
  }

  // HQ couldn't be reached at all, so nothing was sent
  get sentNothing() {
    return this.exitCode === 6 || this.exitCode === 7;
  }
}

let teamMember = '';

// hq --as <id>: a team member of this job speaks as itself. The job's own agent needs no `as`.
export function speakAs(id: string) {
  teamMember = id === (process.env.HQ_AGENT ?? '') ? '' : id;
}

export const speaker = () => teamMember;

export const withSpeaker = <T extends object>(body: T) => (teamMember ? { ...body, as: teamMember } : body);

// A POST when there's a body, else a GET. Any answer comes back; only no answer at all throws.
export async function call(route: string, options: CallOptions = {}): Promise<Answer> {
  const { status, bytes } = await request(route, options);
  return { status, body: bytes.toString() };
}

// A GET whose answer is bytes (a mail as received). Any answer comes back. Only no answer at all throws.
export async function getBytes(route: string): Promise<{ status: number; bytes: Buffer }> {
  return request(route, {});
}

// HQ's answer, however long it takes (board, call 127: a slow coordinator is still there, so a hand-off waits for it):
// only a command's own timeoutMs, or the connection failing (refused, reset, a host gone: TCP keep-alive), ends the
// wait. Not fetch: it gives up on its own after 300 s without an answer (undici's headersTimeout).
async function request(route: string, options: CallOptions): Promise<{ status: number; bytes: Buffer }> {
  const { body, bytes, timeoutMs } = options;
  const url = new URL(`${required('HQ_URL')}/api/agent/${route}`);
  const headers: Record<string, string> = { ...options.headers, authorization: `Bearer ${required('HQ_TOKEN')}` };
  let payload = bytes;
  if (payload === undefined && body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = Buffer.from(JSON.stringify(body));
  }
  if (payload !== undefined) headers['content-length'] = String(payload.length);
  // (HQ holds a job past its share of its time no longer than this leaves room for its answer)
  if (timeoutMs) headers['x-hq-wait-ms'] = String(timeoutMs);
  const started = Date.now();
  try {
    return await new Promise((resolve, reject) => {
      const method = payload === undefined ? 'GET' : 'POST';
      const sent = (url.protocol === 'https:' ? https : http).request(
        url,
        { method, headers, agent: false },
        answer => {
          tellRein(answer.headers['x-hq-rein']);
          const chunks: Buffer[] = [];
          answer.on('data', (chunk: Buffer) => chunks.push(chunk));
          answer.on('end', () => resolve({ status: answer.statusCode ?? 0, bytes: Buffer.concat(chunks) }));
          answer.on('error', reject);
        },
      );
      sent.on('socket', socket => socket.setKeepAlive(true, 10_000));
      sent.on('error', reject);
      const timer =
        timeoutMs &&
        setTimeout(() => sent.destroy(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), timeoutMs);
      if (timer) sent.on('close', () => clearTimeout(timer));
      sent.end(payload);
    });
  } catch (error) {
    throw unreachable(error, url, Date.now() - started, timeoutMs);
  }
}

// A job past its share of HQ's time hears it on every answer, with what to do (the coordinator's reins.ts)
function tellRein(words: string | string[] | undefined) {
  if (words) console.error(`hq: ${words}`);
}

export async function get(route: string): Promise<string> {
  return succeeded(await call(route));
}

export async function post(route: string, body: unknown): Promise<string> {
  return succeeded(await call(route, { body }));
}

export const getJson = async (route: string) => JSON.parse(await get(route));

export const postJson = async (route: string, body: unknown) => JSON.parse(await post(route, body));

// What a call that makes something (a job, an item) did. Only a refusal (4xx: HQ says why) or no connection at all (6,
// 7: nothing was sent) proves nothing was made. Anything else (no answer, a dropped connection, a time-out, a server
// error, no number in the answer) may come after HQ saved it, so a retry could make it twice. acknowledged: what in the
// answer says it was made.
export type Creation =
  | { made: true; answer: Record<string, unknown> }
  | { made: false; refused: boolean; status: number; error: string; failure?: string };

export async function createOnce(
  route: string,
  body: unknown,
  acknowledged = (answer: Record<string, unknown>) => shown(answer.id) !== '',
): Promise<Creation> {
  let answer: Answer = { status: 0, body: '' };
  let failure: ApiError | undefined;
  try {
    answer = await call(route, { body });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    failure = error;
  }
  const parsed = parseOrNull(answer.body);
  if (!failure && isSuccess(answer.status) && parsed !== null && acknowledged(parsed)) {
    return { made: true, answer: parsed };
  }
  const refused = failure ? failure.sentNothing : isRefusal(answer.status);
  return { made: false, refused, status: answer.status, error: errorIn(answer.body), failure: failure?.message };
}

// A call that changes something (cancel, a pause, a window, a plan's thread): the answer of a change HQ made (2xx with
// JSON) or refused (4xx: HQ says why, and nothing changed), for the command to word. Anything else may have come after
// HQ made it (no answer, a dropped connection, a time-out, a server error, an answer that isn't JSON): hq stops with
// exit 3, "Not confirmed", so a retry checks first and never does it twice. No connection at all (6, 7) sent nothing and
// keeps its own exit code.
export async function change(route: string, options: CallOptions = {}): Promise<Answer> {
  let answer: Answer;
  try {
    answer = await call(route, options);
  } catch (error) {
    if (error instanceof ApiError && !error.sentNothing)
      stop(
        `Not confirmed: HQ may or may not have made the change (${route}: ${error.message}). Check before doing it again.`,
        3,
      );
    throw error;
  }
  if (isRefusal(answer.status) || (isSuccess(answer.status) && parseOrNull(answer.body) !== null)) return answer;
  return stop(
    `Not confirmed: HQ may or may not have made the change (${route}: HTTP ${httpCode(answer.status)}). Check before doing it again.`,
    3,
  );
}

// A read HQ may refuse this job (hq mail, hq orders: org.yaml's roles decide). A refusal stops hq with HQ's reason.
export async function getUnlessRefused(route: string): Promise<string> {
  const answer = await call(route);
  if (answer.status === 403) stop(`HQ refused it: ${errorIn(answer.body, 'not allowed')}.`);
  if (answer.status < 200 || answer.status > 299) throw new ApiError(`HTTP ${answer.status}`, 22);
  return answer.body;
}

// No answer at all reads as status 0, for a command that words that case itself.
export async function orNoAnswer(pending: Promise<Answer>): Promise<Answer> {
  try {
    return await pending;
  } catch (error) {
    if (error instanceof ApiError) return { status: 0, body: '' };
    throw error;
  }
}

// The status in three digits: no answer at all is 000.
export const httpCode = (status: number) => String(status).padStart(3, '0');

// A failed call gets the command's own line and exit 1.
export async function orStop<T>(pending: Promise<T>, message: string): Promise<T> {
  try {
    return await pending;
  } catch (error) {
    if (error instanceof ApiError) stop(message);
    throw error;
  }
}

// The `error` HQ gave in a JSON answer, or the fallback. An answer that isn't a JSON object gives ''.
export function errorIn(body: string, fallback = ''): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return '';
  }
  if (parsed === null) return fallback;
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return '';
  const error = (parsed as { error?: unknown }).error;
  if (error === undefined || error === null || error === false) return fallback;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

export const parseOrNull = (body: string) => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

export const isSuccess = (status: number) => status >= 200 && status <= 299;

export const isRefusal = (status: number) => status >= 400 && status <= 499;

// Encodes everything but letters, digits and -_.~ (encodeURIComponent alone leaves !'()* as they are).
export const uri = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function succeeded(answer: Answer) {
  if (answer.status >= 400) throw new ApiError(`HTTP ${answer.status}`, 22);
  return answer.body;
}

function required(name: string) {
  const value = process.env[name];
  if (value === undefined) stop(`hq: ${name}: unbound variable`);
  return value;
}

// The exit code and words for a call that got no answer. Only 6 and 7 prove nothing reached HQ.
function unreachable(error: unknown, url: URL, elapsedMs: number, timeoutMs?: number) {
  const { hostname, port } = url;
  const { name, code, syscall } = error as { name?: string; code?: string; syscall?: string };
  if (name === 'TimeoutError') {
    return new ApiError(`Operation timed out after ${timeoutMs} milliseconds with 0 bytes received`, 28);
  }
  switch (code) {
    case 'ECONNREFUSED':
      return new ApiError(
        `Failed to connect to ${hostname} port ${port} after ${elapsedMs} ms: Couldn't connect to server`,
        7,
      );
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new ApiError(`Could not resolve host: ${hostname}`, 6);
    // (a closed connection with no answer is Node's "socket hang up", ECONNRESET too, with no syscall)
    case 'ECONNRESET':
      if (syscall) return new ApiError('Recv failure: Connection reset by peer', 56);
  }
  return new ApiError('Empty reply from server', 52);
}

// HQ's agent API (/api/agent/<route>) as hq calls it, with the job's token in a header. The token never goes on a
// command line, where any uid could read it (/proc/<pid>/cmdline).
// Agents and scripts read a failed call's exit code: 22 for an answer of 400 or more where only success will do, 6 or 7
// when HQ can't be reached, 28 for a time-out.
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
  return request(route, options, async response => ({ status: response.status, body: await response.text() }));
}

// A GET whose answer is bytes (a mail as received). Any answer comes back. Only no answer at all throws.
export async function getBytes(route: string): Promise<{ status: number; bytes: Buffer }> {
  return request(route, {}, async response => ({
    status: response.status,
    bytes: Buffer.from(await response.arrayBuffer()),
  }));
}

async function request<T>(route: string, options: CallOptions, read: (response: Response) => Promise<T>) {
  const { body, bytes, timeoutMs } = options;
  const url = `${required('HQ_URL')}/api/agent/${route}`;
  const headers: Record<string, string> = { ...options.headers, authorization: `Bearer ${required('HQ_TOKEN')}` };
  const init: RequestInit = { headers, signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined };
  if (bytes !== undefined) {
    Object.assign(init, { method: 'POST', body: bytes });
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    Object.assign(init, { method: 'POST', body: JSON.stringify(body) });
  }
  const started = Date.now();
  try {
    return await read(await fetch(url, init));
  } catch (error) {
    throw unreachable(error, url, Date.now() - started, timeoutMs);
  }
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
    answer = await call(route, { body, timeoutMs: 20_000 });
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
function unreachable(error: unknown, url: string, elapsedMs: number, timeoutMs?: number) {
  const { hostname, port } = new URL(url);
  const noConnection = `Failed to connect to ${hostname} port ${port} after ${elapsedMs} ms: Couldn't connect to server`;
  const cause = (error as { cause?: { code?: string } }).cause;
  if ((error as Error).name === 'TimeoutError') {
    return new ApiError(`Operation timed out after ${timeoutMs} milliseconds with 0 bytes received`, 28);
  }
  // fetch refuses a few ports outright (the Fetch standard's bad ports, 9 among them): nothing was sent.
  if ((cause as Error | undefined)?.message === 'bad port') {
    return new ApiError(noConnection, 7);
  }
  switch (cause?.code) {
    case 'ECONNREFUSED':
      return new ApiError(noConnection, 7);
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new ApiError(`Could not resolve host: ${hostname}`, 6);
    case 'ECONNRESET':
      return new ApiError('Recv failure: Connection reset by peer', 56);
    default:
      return new ApiError('Empty reply from server', 52);
  }
}

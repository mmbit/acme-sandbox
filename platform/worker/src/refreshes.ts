// The one owner of each Codex seat's sign-in refreshes, so runs side by side on a seat never spend each other's copy.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// Codex sends its refreshes to this URL instead of OpenAI's when it's set: the worker's own, one secret path per run.
export const REFRESH_URL_VAR = 'CODEX_REFRESH_TOKEN_URL_OVERRIDE';
const OPENAI_TOKENS = 'https://auth.openai.com/oauth/token';
// Codex's refresh body is a client id, a grant type and one refresh token, well under a kilobyte.
const MAX_BODY_CHARS = 16_000;
// OpenAI's token endpoint answers within seconds. Every run that shares an exchange waits on it, so a hung one ends here.
const PROVIDER_TIMEOUT_MS = 60_000;

export type TokenAnswer = { status: number; body: string };
// A sign-in as the worker handed it to runs, and refreshed it for them since: its auth.json now, the refresh tokens it
// has spent (hashed), and whether the provider refused it.
type Lineage = { seat: string; signIn: string; spent: string[]; refused: boolean };
// What outlives a reload of the worker: each lineage, and each holder (a run, a limits read) with its capability, the
// secret path its refreshes come in on.
export type RefreshState = {
  lineages: Record<string, Lineage>;
  holders: Record<string, { capability: string; lineage: string }>;
};
type SeatSignIns = {
  read: (seat: string) => string | undefined; // the seat's auth.json, undefined for a seat not on the list
  save: (seat: string, text: string) => void;
  exchange: (body: string) => Promise<TokenAnswer>;
  state: RefreshState;
  keep: (state: RefreshState) => void;
};

// Each holder refreshes only within the sign-in it was handed. Its refresh token goes to the provider once: a holder
// that asks with it while that exchange is out gets the same answer, and one that asks with it later gets its sign-in
// as that exchange (and any after it) left it, never a sign-in that replaced it. A refresh of the seat's own sign-in is
// saved to the seat as it comes.
export function codexRefreshes(signIns: SeatSignIns) {
  const { exchange, state } = signIns;
  const exchanging = new Map<string, { token: string; answer: Promise<TokenAnswer> }>();

  async function refresh(capability: string, body: string): Promise<TokenAnswer> {
    const holder = Object.values(state.holders).find(h => h.capability === capability);
    if (!holder) return refusal(404, "not a live run's refreshes");
    const token = requestToken(body);
    if (!token) return refusal(400, 'no refresh token');
    const id = holder.lineage,
      lineage = state.lineages[id],
      pending = exchanging.get(id);
    if (pending?.token === token) return pending.answer;
    if (token === seatToken(lineage.signIn)) return exchangeOwn(id, lineage, token, body);
    if (!lineage.spent.includes(hashOf(token))) return refusal(401, "not a refresh token of this run's sign-in");
    await pending?.answer;
    return tokensOf(lineage.signIn);
  }

  function exchangeOwn(id: string, lineage: Lineage, token: string, body: string) {
    const answer = exchange(body)
      .then(answer => {
        settle(signIns, lineage, token, answer);
        return answer;
      })
      .finally(() => {
        if (exchanging.get(id)?.answer !== answer) return;
        exchanging.delete(id);
        end(signIns, [], exchanging); // (a lineage its last holder left while this exchange was out goes now)
      });
    exchanging.set(id, { token, answer });
    return answer;
  }

  return {
    refresh,
    handOut: (holderName: string, seat: string, signIn: string) => handOut(signIns, holderName, seat, signIn),
    capabilityOf: (holderName: string): string | undefined => state.holders[holderName]?.capability,
    end: (...holderNames: string[]) => end(signIns, holderNames, exchanging),
    endAllBut: (live: string[]) => end(signIns, holdersBut(state, live), exchanging),
    signedOut: (seat: string) => signedOut(signIns, seat),
  };
}

// The holder's capability, on the lineage of the sign-in it was handed now (a run asked again keeps its capability).
function handOut({ state, keep }: SeatSignIns, holderName: string, seat: string, signIn: string) {
  const token = seatToken(signIn);
  let id = Object.keys(state.lineages).find(
    key => state.lineages[key].seat === seat && seatToken(state.lineages[key].signIn) === token,
  );
  if (!id) {
    id = randomBytes(16).toString('hex');
    state.lineages[id] = { seat, signIn, spent: [], refused: false };
  }
  const capability = state.holders[holderName]?.capability ?? randomBytes(32).toString('hex');
  state.holders[holderName] = { capability, lineage: id };
  keep(state);
  return capability;
}

// Holders that are gone (a run that ended, or one the last worker process didn't hand over) lose their capability.
function end(signIns: SeatSignIns, holderNames: string[], exchanging: Map<string, unknown>) {
  for (const name of holderNames) delete signIns.state.holders[name];
  prune(signIns, exchanging);
  signIns.keep(signIns.state);
}

const holdersBut = (state: RefreshState, live: string[]) =>
  Object.keys(state.holders).filter(name => !live.includes(name));

// Whether a run's failed sign-in is the seat's: it has none left, or one that never refreshes (a key), or the provider
// refused it as it is now. Anything else failed only the run's copy.
function signedOut({ read, state }: SeatSignIns, seat: string) {
  const signIn = read(seat);
  const token = signIn === undefined ? undefined : seatToken(signIn);
  if (!token) return true;
  return Object.values(state.lineages).some(l => l.seat === seat && l.refused && seatToken(l.signIn) === token);
}

// An exchange of a lineage's own refresh token, settled: a refusal noted, new tokens kept, and saved to the seat while
// the seat is still on this lineage.
function settle({ read, save, keep, state }: SeatSignIns, lineage: Lineage, token: string, answer: TokenAnswer) {
  if (answer.status === 400 || answer.status === 401) lineage.refused = true;
  if (answer.status !== 200) return keep(state);
  const fresh = freshTokens(answer.body);
  if (!fresh) throw new Error(`${lineage.seat}: the provider's refresh came back without usable tokens`);
  const seatSignIn = read(lineage.seat);
  const auth = JSON.parse(lineage.signIn);
  lineage.signIn = JSON.stringify(
    { ...auth, tokens: { ...auth.tokens, ...fresh }, last_refresh: new Date().toISOString() },
    null,
    2,
  );
  lineage.spent.push(hashOf(token));
  keep(state);
  if (seatSignIn !== undefined && seatToken(seatSignIn) === token) save(lineage.seat, lineage.signIn);
}

// A lineage no holder is on, and with no exchange out (a run handed its sign-in meanwhile joins that exchange), is
// dropped, unless it's the seat's own refused sign-in (signedOut still reads that).
function prune({ read, state }: SeatSignIns, exchanging: Map<string, unknown>) {
  const held = new Set([...Object.values(state.holders).map(h => h.lineage), ...exchanging.keys()]);
  for (const [id, lineage] of Object.entries(state.lineages)) {
    if (held.has(id)) continue;
    const seatSignIn = read(lineage.seat);
    const seatsOwn = seatSignIn !== undefined && seatToken(seatSignIn) === seatToken(lineage.signIn);
    if (!(lineage.refused && seatsOwn)) delete state.lineages[id];
  }
}

// The refresh token in a run's request body, which comes from the job.
function requestToken(body: string) {
  try {
    const token = JSON.parse(body)?.refresh_token;
    return typeof token === 'string' && token ? token : undefined;
  } catch {
    return undefined;
  }
}
const seatToken = (signIn: string): string | undefined => JSON.parse(signIn).tokens?.refresh_token || undefined;
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');
const refusal = (status: number, error: string): TokenAnswer => ({ status, body: JSON.stringify({ error }) });

// The provider's new tokens from its 200: undefined without an access token, or with any token that isn't a non-empty
// string. (The exchange may have spent the lineage's token all the same, so settle fails loudly on it.)
function freshTokens(body: string) {
  let issued: Record<string, unknown>;
  try {
    issued = JSON.parse(body);
  } catch {
    return undefined;
  }
  const names = ['id_token', 'access_token', 'refresh_token'].filter(name => issued?.[name] !== undefined);
  const usable = (name: string) => typeof issued[name] === 'string' && issued[name] !== '';
  if (!issued?.access_token || !names.every(usable)) return undefined;
  return Object.fromEntries(names.map(name => [name, issued[name] as string]));
}

// The lineage's tokens, answered as the provider would have answered the exchange that made them.
function tokensOf(signIn: string): TokenAnswer {
  const { id_token, access_token, refresh_token } = JSON.parse(signIn).tokens;
  return { status: 200, body: JSON.stringify({ id_token, access_token, refresh_token }) };
}

// The provider's token endpoint. A failure to reach it is the run's to retry, never the seat's sign-out.
export async function exchangeWithOpenAI(body: string): Promise<TokenAnswer> {
  try {
    const response = await fetch(OPENAI_TOKENS, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    return { status: response.status, body: await response.text() };
  } catch (err) {
    return { status: 502, body: JSON.stringify({ error: `couldn't reach the provider: ${(err as Error).message}` }) };
  }
}

// The runs' way in, POST /codex/<capability>, on a socket already bound to the loopback (supervise.py's, which outlives
// the worker's reloads: listen { fd }) or, in a test, on a free port of its own (listen { port: 0 }).
export function serveRefreshes(
  refresh: (capability: string, body: string) => Promise<TokenAnswer>,
  listen: { fd: number } | { port: 0 },
  log: (...args: unknown[]) => void,
) {
  const server = createServer((request, response) => {
    const capability = /^\/codex\/([0-9a-f]{64})$/.exec(request.url ?? '')?.[1];
    if (request.method !== 'POST' || !capability) return void response.writeHead(404).end();
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (body.length <= MAX_BODY_CHARS) return;
      request.removeAllListeners('data').removeAllListeners('end');
      log(`Codex refreshes: a request over ${MAX_BODY_CHARS} characters, refused`);
      response.writeHead(413, { connection: 'close' }).end();
    });
    request.on('end', () =>
      refresh(capability, body).then(
        answer => response.writeHead(answer.status, { 'content-type': 'application/json' }).end(answer.body),
        err => {
          log('Codex refreshes: a refresh failed:', err);
          response.writeHead(500).end();
        },
      ),
    );
  });
  return new Promise<{ port: number; close: () => void }>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen, () => resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() }));
  });
}

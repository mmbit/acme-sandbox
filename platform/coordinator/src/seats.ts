// The board's seats: the subscription logins and keys the worker runs jobs on, and the provider behind each. The board
// changes them in HQ's Settings › Seats, and the worker carries each change out and says how it went, so the board sees
// the result on the seat's row. No agent and no card is in that loop.
import { db, remember, setting } from './db.ts';
import { yamlFile } from './company.ts';
import { createRequest, endRequest, releaseSeat, setSeat } from './jobs.ts';

// The work the worker runs comes in two engines: `claude`, the company's own work, and `codex`, the share a model of
// another family takes (the second opinion in reviews). A seat runs one CLI at one provider, and takes its provider's
// engine's work: an agent's own, or one whose fallback runs there (models.ts). A provider of the company's or the
// board's speaks a CLI's API at its own address (Anthropic's Messages API for Claude Code, OpenAI's Responses API for
// Codex) and signs in with a key.
export type Engine = 'claude' | 'codex';
const ENGINES: Engine[] = ['claude', 'codex'];
type Cli = 'claude' | 'codex' | 'vibe' | 'agy';
// The CLIs a service of the company's or the board's can speak to: the two whose API is a standard one
const OWN_CLIS: Cli[] = ['claude', 'codex'];
type SignIn = 'login' | 'key';
type Provider = {
  id: string;
  name: string;
  engine: Engine;
  cli: Cli;
  sign_in: SignIn;
  url?: string;
  model?: string;
  models?: Record<string, string>;
  from: 'platform' | 'company' | 'board';
  metered?: boolean;
};
const PLATFORM_PROVIDERS: Provider[] = [
  {
    id: 'anthropic',
    name: 'Anthropic: Claude subscription',
    engine: 'claude',
    cli: 'claude',
    sign_in: 'login',
    from: 'platform',
  },
  // metered: billed per use, which the board doesn't run its work on, so HQ offers it only once a seat has it
  {
    id: 'anthropic-key',
    name: 'Anthropic: API key, pay per use',
    engine: 'claude',
    cli: 'claude',
    sign_in: 'key',
    metered: true,
    from: 'platform',
  },
  {
    id: 'openai',
    name: 'OpenAI: ChatGPT subscription',
    engine: 'codex',
    cli: 'codex',
    sign_in: 'login',
    from: 'platform',
  },
  {
    id: 'openai-key',
    name: 'OpenAI: API key, pay per use',
    engine: 'codex',
    cli: 'codex',
    sign_in: 'key',
    metered: true,
    from: 'platform',
  },
  // (Le Chat's plan covers a key made in Mistral's AI Studio for its workspace: Vibe's own sign-in ends in such a key)
  {
    id: 'mistral',
    name: 'Mistral: Le Chat subscription',
    engine: 'codex',
    cli: 'vibe',
    sign_in: 'key',
    from: 'platform',
  },
  { id: 'google', name: 'Google: AI subscription', engine: 'codex', cli: 'agy', sign_in: 'login', from: 'platform' },
];
// A seat from the worker's SEATS setting signs in as its engine's subscription.
const SUBSCRIPTION: Record<Engine, string> = { claude: 'anthropic', codex: 'openai' };

// A seat's id names its folder on the worker: a lowercase name, a dash, then digits or a lowercase word (the worker's SEAT_ID).
const SEAT_ID = /^[a-z]+-([0-9]+|[a-z]+)$/;
const PROVIDER_ID = /^[a-z][a-z0-9-]{1,30}$/;
const MODEL = /^[\w.:/@-]{1,100}$/;
const KEY_MAX = 1000,
  CODE_MAX = 2000;
// The board's changes kept, for each seat's last one and the status report
const ACTIONS_KEPT = 500;

// (stop: a seat's stop level; pacing: on or off, for all seats; credits: whether a seat may spend its account's credits)
type ActionWhat = 'add' | 'remove' | 'pause' | 'resume' | 'sign-in' | 'key' | 'stop' | 'pacing' | 'credits';
type ActionStatus = 'waiting' | 'working' | 'done' | 'failed';
type Action = {
  id: number;
  seat: string | null;
  engine: string | null;
  what: ActionWhat;
  status: ActionStatus;
  words: string | null;
  at: number;
};
type SigninStatus = 'starting' | 'open' | 'checking' | 'done' | 'failed';
type Signin = {
  status: SigninStatus;
  url?: string;
  code?: string;
  asks: 'code' | 'nothing';
  words?: string;
  at: number;
};
type ListedSeat = {
  id: string;
  provider: string;
  paused: number;
  removing: number;
  added: string;
  stop: number | null;
  use_credits: number;
};

// A seat's stop level: the share of its windows it runs to before it takes no new work, in percent. A seat the board
// hasn't set runs to the worker's own level, DRAIN_AT (downtime.ts), which this mirrors for HQ's rows. Pacing (the
// worker's pacedUntil: a week running ahead of its pace takes only the board's word and work that must start before its
// reset) is on for all seats unless the board turned it off. A seat whose account has credits keeps to its plan all the
// same, paced and stopping at its level, unless the board lets it spend them (use_credits): spending past the plan is
// the board's choice, never a default.
export const STOP_DEFAULT = 90;
const STOP_MIN = 50,
  STOP_MAX = 99;
const PACING_KEY = 'seats.pacing';
export const pacingOn = () => setting(PACING_KEY) !== 'off';
const stopLevel = (value: unknown) =>
  Number.isInteger(value) && (value as number) >= STOP_MIN && (value as number) <= STOP_MAX ? (value as number) : null;

// Held only until the worker takes them, never written down: a key the board pasted, the code a sign-in page showed it.
const keys = new Map<string, string>();
const codes = new Map<string, string>();
// Each seat's sign-in in progress or just ended, as the worker reports it.
const signins = new Map<string, Signin>();

// ---- the providers

export function listProviders(): Provider[] {
  const board = (db.prepare('select * from seat_providers order by added').all() as Record<string, string>[]).flatMap(
    p => providerFrom(p, 'board') ?? [],
  );
  const seen = new Set<string>();
  return [...PLATFORM_PROVIDERS, ...companyProviders(), ...board]
    .filter(p => !seen.has(p.id) && seen.add(p.id))
    .map(p => ({ ...p, ...(p.model ? {} : companyModel(p.id)) }));
}
// A provider with no model of its own asks for the company's (company/models.yaml, an entry under its id), else the job's
const companyModel = (id: string) => {
  const model = (yamlFile('company/models.yaml')[id] as { model?: unknown } | undefined)?.model;
  return MODEL.test(String(model ?? '')) ? { model: String(model) } : {};
};
const findProvider = (id: string) => listProviders().find(p => p.id === id);

// The company's file, read again only when it changes (yamlFile keeps its value till then), so a bad entry is told once
let companyRead: { file: unknown; providers: Provider[] } = { file: null, providers: [] };
function companyProviders() {
  const file = yamlFile('company/providers.yaml');
  if (companyRead.file !== file) {
    const own = file.providers;
    companyRead = { file, providers: (Array.isArray(own) ? own : []).flatMap(p => providerFrom(p, 'company') ?? []) };
  }
  return companyRead.providers;
}

// A provider entry of the company's file or the board's: one that doesn't hold up is left out, loudly.
function providerFrom(entry: unknown, from: 'company' | 'board'): Provider | null {
  const p = (entry ?? {}) as Record<string, unknown>;
  const models = p.models && typeof p.models === 'object' ? (p.models as Record<string, unknown>) : {};
  // (an entry that names only its engine runs that engine's CLI, in that engine)
  const cli = String(p.cli ?? p.engine),
    engine = String(p.cli ? (p.engine ?? 'codex') : p.engine);
  const problem = !PROVIDER_ID.test(String(p.id))
    ? 'its id'
    : !ENGINES.includes(engine as Engine)
      ? 'its engine'
      : !OWN_CLIS.includes(cli as Cli)
        ? 'its cli'
        : typeof p.name !== 'string' || !p.name.trim()
          ? 'its name'
          : !httpsUrl(p.url)
            ? 'its url'
            : !MODEL.test(String(p.model))
              ? 'its model'
              : Object.values(models).some(m => !MODEL.test(String(m)))
                ? 'its models'
                : '';
  if (problem) {
    console.error(`A seat provider (${from}) is left out for ${problem}: ${JSON.stringify(p.id)}`);
    return null;
  }
  return {
    id: String(p.id),
    name: String(p.name).trim(),
    engine: engine as Engine,
    cli: cli as Cli,
    sign_in: 'key',
    url: String(p.url),
    model: String(p.model),
    ...(Object.keys(models).length ? { models: models as Record<string, string> } : {}),
    from,
  };
}
const httpsUrl = (url: unknown) => {
  try {
    return new URL(String(url)).protocol === 'https:';
  } catch {
    return false;
  }
};

// HQ's Settings › Seats: the providers to pick from for a new seat, and pacing.
export function listSeatProviders() {
  return { providers: listProviders(), pacing: { on: pacingOn(), action: lastPacing() } };
}

// ---- the seats, as the board sees them

const listed = () => db.prepare('select * from seat_list order by added, id').all() as ListedSeat[];
const seeded = () => !!db.prepare("select 1 from settings where key = 'seats.seeded'").get();

// Every seat with what the worker last reported of it, the board's last change to it and its sign-in. Before the worker
// first sent its list, the seats it reported.
export function listSeats() {
  const reported = new Map(
    (db.prepare('select * from seats').all() as Record<string, unknown>[]).map(s => [s.id as string, s]),
  );
  if (!seeded()) return [...reported.values()];
  return listed().map(seat => {
    const provider = findProvider(seat.provider),
      engine = provider ? provider.engine : (reported.get(seat.id)?.engine as string);
    return {
      engine,
      state: null,
      until: null,
      note: null,
      util: null,
      resets: null,
      week: null,
      week_resets: null,
      pace: null,
      ...reported.get(seat.id),
      id: seat.id,
      provider: seat.provider,
      provider_name: provider?.name ?? seat.provider,
      cli: provider?.cli ?? engine,
      sign_in: provider?.sign_in ?? 'login',
      paused: !!seat.paused,
      removing: !!seat.removing,
      stop: seat.stop ?? STOP_DEFAULT,
      use_credits: !!seat.use_credits,
      action: lastAction('seat', seat.id),
      signin: signins.get(seat.id) ?? null,
    };
  });
}

// ---- the board's changes

export function addSeat(b: Record<string, unknown>) {
  const id = String(b.id ?? '').trim();
  if (!SEAT_ID.test(id))
    return "A seat's name is a lowercase word, a dash, then a number or another word, like claude-4 or mistral-1.";
  if (db.prepare('select 1 from seat_list where id = ?').get(id)) return `There's already a seat called ${id}.`;
  const made = b.provider === 'new' ? boardProvider(b) : findProvider(String(b.provider ?? ''));
  if (typeof made === 'string') return made;
  if (!made) return "That provider isn't on the list.";
  const refused = made.sign_in === 'key' ? keyProblem(b.key) : null;
  if (refused) return refused;
  if (b.provider === 'new')
    db.prepare(
      'insert into seat_providers (id, name, engine, cli, url, model, added) values (?, ?, ?, ?, ?, ?, ?)',
    ).run(made.id, made.name, made.engine, made.cli, made.url!, made.model!, new Date().toISOString());
  db.prepare('insert into seat_list (id, provider, added) values (?, ?, ?)').run(id, made.id, new Date().toISOString());
  if (made.sign_in === 'key') keys.set(id, String(b.key).trim());
  if (made.sign_in === 'login') signins.set(id, { status: 'starting', asks: asksFor(made), at: Date.now() });
  return { ok: true, id, action: recordAction({ seat: id, what: 'add' }) };
}

// A service of the board's own, added with its first seat: a model of another family, so it takes a share of the second
// opinion, and the work of agents the board gives a model there (models.ts).
function boardProvider(b: Record<string, unknown>): Provider | string {
  const name = String(b.name ?? '')
      .trim()
      .slice(0, 40),
    cli = String(b.cli ?? b.engine ?? '');
  if (!name) return 'Give the service a name.';
  if (!OWN_CLIS.includes(cli as Cli)) return "Pick whether it speaks Anthropic's API or OpenAI's.";
  if (!httpsUrl(b.url)) return 'Its API address starts with https://.';
  if (!MODEL.test(String(b.model ?? ''))) return "Give the model's name as the service writes it.";
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'service';
  const base = /^[a-z]/.test(slug) ? slug : `p-${slug}`.slice(0, 24);
  let id = base;
  for (let n = 2; findProvider(id); n++) id = `${base}-${n}`;
  return {
    id,
    name,
    engine: 'codex',
    cli: cli as Cli,
    sign_in: 'key',
    url: String(b.url).trim(),
    model: String(b.model),
    from: 'board',
  };
}

// A key as pasted: one run with no spaces
function keyProblem(value: unknown) {
  const key = String(value ?? '').trim();
  if (!key) return "Paste the service's API key: a key seat can't start without one.";
  if (key.length > KEY_MAX || /\s/.test(key))
    return "That doesn't look like a key: a key is one run of letters and digits, with no spaces.";
  return null;
}

export function removeSeat(id: string) {
  const seat = seatOf(id);
  if (!seat) return "There's no such seat.";
  db.prepare('update seat_list set removing = 1 where id = ?').run(id);
  keys.delete(id);
  codes.delete(id);
  signins.delete(id);
  db.prepare(
    "update seat_actions set status = 'failed', words = 'The seat was removed.', done = ? where seat = ? and status = 'waiting'",
  ).run(Date.now(), id);
  return { ok: true, action: recordAction({ seat: id, what: 'remove' }) };
}

export function pauseSeat(id: string, paused: boolean) {
  const seat = seatOf(id);
  if (!seat) return "There's no such seat.";
  db.prepare('update seat_list set paused = ? where id = ?').run(paused ? 1 : 0, id);
  return { ok: true, action: recordAction({ seat: id, what: paused ? 'pause' : 'resume' }) };
}

// A new sign-in (a plan changed, a token stopped working, a closed account to try again): the worker drops the old one and
// starts the sign-in tool, and the row shows its page.
export function signInSeat(id: string) {
  const seat = seatOf(id);
  if (!seat) return "There's no such seat.";
  const provider = findProvider(seat.provider);
  if (provider?.sign_in !== 'login') return 'This seat signs in with a key: change its key instead.';
  codes.delete(id);
  signins.set(id, { status: 'starting', asks: asksFor(provider), at: Date.now() });
  return { ok: true, action: recordAction({ seat: id, what: 'sign-in' }) };
}

// The code the sign-in page showed the board (or the page's whole address), for the sign-in tool
export function sendSeatCode(id: string, value: unknown) {
  const flow = signins.get(id),
    code = String(value ?? '').trim();
  if (!seatOf(id) || flow?.status !== 'open' || flow.asks !== 'code')
    return "This seat isn't waiting for a code now. Tap Sign in to start again.";
  if (!code || code.length > CODE_MAX) return 'Paste the code the sign-in page showed you.';
  codes.set(id, code);
  signins.set(id, { ...flow, status: 'checking', at: Date.now() });
  return { ok: true };
}

export function sendSeatKey(id: string, value: unknown) {
  const seat = seatOf(id);
  if (!seat) return "There's no such seat.";
  if (findProvider(seat.provider)?.sign_in !== 'key')
    return 'This seat signs in with its account: tap Sign in again instead.';
  const refused = keyProblem(value);
  if (refused) return refused;
  keys.set(id, String(value).trim());
  return { ok: true, action: recordAction({ seat: id, what: 'key' }) };
}

// What a sign-in asks of the board before the worker's tool says: Claude's and Antigravity's page gives a code to paste back
const asksFor = (provider: Provider) => (['claude', 'agy'].includes(provider.cli) ? 'code' : 'nothing');

// A seat's stop level, from 50% to 99%, and pacing on or off for all seats.
export function stopSeat(id: string, stop: unknown) {
  if (!seatOf(id)) return "There's no such seat.";
  const level = stopLevel(stop);
  if (level === null) return 'Pick a level from 50% to 99%.';
  db.prepare('update seat_list set stop = ? where id = ?').run(level, id);
  return { ok: true, action: recordAction({ seat: id, what: 'stop' }) };
}

// Whether a seat may spend its account's credits past its plan's limits (off: it's paced and stops like any seat).
export function creditsSeat(id: string, on: unknown) {
  if (!seatOf(id)) return "There's no such seat.";
  if (typeof on !== 'boolean') return 'Say whether it may spend credits.';
  db.prepare('update seat_list set use_credits = ? where id = ?').run(on ? 1 : 0, id);
  return { ok: true, action: recordAction({ seat: id, what: 'credits' }) };
}

export function setPacing(on: unknown) {
  if (typeof on !== 'boolean') return 'Say whether pacing is on or off.';
  remember(PACING_KEY, on ? null : 'off');
  return { ok: true, action: recordAction({ what: 'pacing' }) };
}

const seatOf = (id: string) =>
  db.prepare('select * from seat_list where id = ? and removing = 0').get(id) as ListedSeat | undefined;

function recordAction(a: { seat?: string; what: ActionWhat }) {
  // a change the worker hasn't taken up yet gives way to the board's newer one on the same seat (or for all seats).
  db.prepare(
    "update seat_actions set status = 'failed', words = 'Replaced by your next change.', done = ? where status = 'waiting' and seat is ? and what = ?",
  ).run(Date.now(), a.seat ?? null, a.what);
  const id = Number(
    db.prepare('insert into seat_actions (seat, what, at) values (?, ?, ?)').run(a.seat ?? null, a.what, Date.now())
      .lastInsertRowid,
  );
  db.prepare('delete from seat_actions where id <= ?').run(id - ACTIONS_KEPT);
  return id;
}
const lastAction = (by: 'seat', id: string) =>
  (db
    .prepare(`select id, what, status, words, at from seat_actions where ${by} = ? order by id desc limit 1`)
    .get(id) as Action | undefined) ?? null;
const lastPacing = () =>
  (db
    .prepare("select id, what, status, words, at from seat_actions where what = 'pacing' order by id desc limit 1")
    .get() as Action | undefined) ?? null;

// ---- the worker

// The worker's list at its start (its SEATS setting) is the board's first list, taken once. A seat's own stop level there
// (SEATS' claude-1:claude:95) fills in a level the board hasn't set, at every start, so it carries over once and the
// board's choice always wins. A change it had taken up and not finished ended with the worker's last process: the board
// is told, and tries again.
export function seedSeats(seats: unknown) {
  const given = (Array.isArray(seats) ? seats : []).flatMap(s =>
    typeof s === 'string'
      ? [{ id: s.split(':')[0], engine: s.split(':')[1], stop: s.split(':')[2] && Number(s.split(':')[2]) }]
      : s && typeof s === 'object'
        ? [s as { id: string; engine: string; stop?: unknown }]
        : [],
  );
  if (!seeded()) {
    db.exec('begin');
    try {
      for (const s of given)
        if (SEAT_ID.test(String(s.id)) && ENGINES.includes(s.engine as Engine))
          db.prepare('insert or ignore into seat_list (id, provider, added) values (?, ?, ?)').run(
            s.id,
            SUBSCRIPTION[s.engine as Engine],
            new Date().toISOString(),
          );
      db.prepare("insert into settings (key, value) values ('seats.seeded', ?)").run(new Date().toISOString());
      db.exec('commit');
    } catch (err) {
      db.exec('rollback');
      throw err;
    }
  }
  for (const s of given) {
    const level = stopLevel(s.stop);
    if (level !== null)
      db.prepare('update seat_list set stop = ? where id = ? and stop is null').run(level, String(s.id));
  }
  const cut = 'The worker restarted before this was done. Try again.';
  db.prepare("update seat_actions set status = 'failed', words = ?, done = ? where status = 'working'").run(
    cut,
    Date.now(),
  );
  for (const [id, flow] of signins)
    if (flow.status !== 'done' && flow.status !== 'failed' && flow.status !== 'starting')
      signins.set(id, { ...flow, status: 'failed', words: cut, url: undefined, code: undefined, at: Date.now() });
  return workerSeats();
}

// What the worker runs: each seat with its provider's address and models, whether it's paused, its stop level (null: the
// worker's own), whether it may spend credits past its plan, whether pacing is on, and the board's changes it hasn't taken up yet. Seats it no longer has leave HQ's
// report.
// The week a seat last reported, so a worker that starts again paces it from its first claim instead of waiting for its
// next run's reading.
const lastWeek = (id: string) => {
  const row = db.prepare('select week, week_resets from seats where id = ?').get(id) as
    { week: number | null; week_resets: number | null } | undefined;
  return row?.week != null && row.week_resets ? { week: row.week, weekResets: row.week_resets } : {};
};
export function workerSeats() {
  const seats = listed();
  const kept = JSON.stringify(seats.filter(s => !s.removing).map(s => s.id));
  db.prepare('delete from seats where id not in (select value from json_each(?))').run(kept);
  return {
    seats: seats
      .filter(s => !s.removing)
      .flatMap(seat => {
        const p = findProvider(seat.provider);
        if (!p) return [];
        return [
          {
            id: seat.id,
            engine: p.engine,
            cli: p.cli,
            provider: p.id,
            sign_in: p.sign_in,
            url: p.url,
            model: p.model,
            models: p.models,
            paused: !!seat.paused,
            stop: seat.stop ?? null,
            use_credits: !!seat.use_credits,
            ...lastWeek(seat.id),
          },
        ];
      }),
    pacing: pacingOn(),
    actions: db.prepare("select id, seat, what from seat_actions where status = 'waiting' order by id").all(),
  };
}

// The worker took a change up (working) or says how it went (done, failed, with words for the board).
export function settleAction(id: number, status: unknown, words: unknown) {
  if (!['working', 'done', 'failed'].includes(String(status))) return 400;
  const a = db.prepare('select * from seat_actions where id = ?').get(id) as Action | undefined;
  if (!a) return 404;
  const text = typeof words === 'string' ? words : null;
  db.prepare(
    `update seat_actions set status = ?, words = coalesce(?, words), done = ? where id = ? and status in ('waiting', 'working')`,
  ).run(String(status), text, status === 'working' ? null : Date.now(), id);
  if (a.what === 'remove' && status === 'done' && a.seat) forget(a.seat);
  return { ok: true };
}

// A removed seat: its row, its report, its card, and the jobs that were for it go to any seat of their engine.
function forget(id: string) {
  db.prepare('delete from seat_list where id = ? and removing = 1').run(id);
  db.prepare('delete from seats where id = ?').run(id);
  releaseSeat(id, true);
  closeCard(id, 'The seat was removed.');
}

// A key the board gave, taken by the worker once
export function takeKey(id: string) {
  const key = keys.get(id);
  keys.delete(id);
  return { key: key ?? null };
}

// The worker's sign-in as it goes: starting, the page open (its address, Codex's code to type there), the code being
// checked, then done or failed with what the tool said. It gets the board's code back, once.
export function reportSignin(id: string, b: Record<string, unknown>) {
  if (!seatOf(id)) return { code: null, stop: true };
  const status = String(b.status) as SigninStatus,
    before = signins.get(id);
  if (!['starting', 'open', 'checking', 'done', 'failed'].includes(status)) return 400;
  const asks = b.asks === 'nothing' ? 'nothing' : 'code';
  // (a code the board sent is being checked until the worker says otherwise)
  const shown = status === 'open' && before?.status === 'checking' && codes.has(id) ? 'checking' : status;
  signins.set(id, {
    status: shown,
    asks,
    at: Date.now(),
    ...(typeof b.url === 'string' && /^https:\/\//.test(b.url) ? { url: b.url } : {}),
    ...(typeof b.code === 'string' ? { code: b.code.slice(0, 20) } : {}),
    ...(typeof b.words === 'string' ? { words: b.words } : {}),
  });
  if (status === 'done') closeCard(id, 'The seat is signed in.');
  const code = codes.get(id) ?? null;
  codes.delete(id);
  return { code };
}

// The worker's report of a seat. A seat that loses its sign-in (it ran, and now it's signed out) puts a card on the desk
// phone pointing to Seats, as a seat the board just added or never signed in doesn't; the card leaves once the seat
// is back. A paused one hands its waiting jobs to the engine's other seats, and so does one that now takes the other
// engine's work: a job pinned to it between the board's switch and this report would otherwise wait for it for good.
export function reportSeat(b: Record<string, any>) {
  const before = db.prepare('select state, engine from seats where id = ?').get(b.seat) as
    { state: string; engine: string } | undefined;
  const r = setSeat(b.seat, b.engine, b.state, b.until, b.note, b);
  // (the CLI it runs, for a job that must run on one: jobs.ts claim)
  const provider = findProvider(
    (db.prepare('select provider from seat_list where id = ?').get(b.seat) as { provider: string } | undefined)
      ?.provider ?? '',
  );
  db.prepare('update seats set cli = ? where id = ?').run(provider?.cli ?? b.engine, b.seat);
  if (before && before.engine !== b.engine) releaseSeat(b.seat, true);
  else if (b.state === 'paused') releaseSeat(b.seat);
  const lost = b.state === 'login' && ['ready', 'draining', 'sleeping'].includes(before?.state ?? '');
  const signing = ['starting', 'open', 'checking'].includes(signins.get(b.seat)?.status ?? '');
  if (lost && !signing)
    createRequest({
      kind: 'login',
      seat: b.seat,
      urgency: 'today',
      title: `The seat "${b.seat}" needs signing in again`,
      body:
        `The seat "${b.seat}" lost its sign-in, so it runs no work until it's signed in again. ` +
        'Sign it in under Settings › Seats: you see there at once whether it worked. This card goes by itself once it has.',
    });
  if (b.state !== 'login' && b.state !== 'paused') closeCard(b.seat, 'The seat is signed in again.');
  return r;
}

const closeCard = (seat: string, words: string) => {
  const open = db
    .prepare("select id from requests where kind = 'login' and seat = ? and status != 'done'")
    .all(seat) as { id: number }[];
  for (const { id } of open) endRequest(id, words);
};

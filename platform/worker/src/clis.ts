// The CLIs a seat can run besides Claude Code and Codex (whose own code is in worker.ts, safety.ts and providers.ts). Each
// is described here once: how it's started for a job and for a reviewer asked again, where its sign-in lives, how its
// stream reads as Claude Code's (so the worker's steps, usage, verdicts and outcomes read it as they read Claude's), what
// a branch could plant for it, and its errors for a limit, a sign-out and a closed account.
import { vibe } from './clis/vibe.ts';
import { agy } from './clis/agy.ts';
import type { CliErrors } from './outcome.ts';

export type Cli = {
  name: string; // what the board sees, "Mistral Vibe"
  bin: string; // the executable on the worker's PATH
  // The variables that put the CLI's config and sign-in in a home folder (the seat's folder for a sign-in, the job's
  // home for a run). These names and env()'s, from here, pass to a job's environment (safety.ts agentEnv).
  home: (home: string) => Record<string, string>;
  // Its sign-in's files, relative to that home: copied from the seat's folder into a job's home before a run, and back
  // after it if the CLI refreshed them.
  credentials: string[];
  // A job's arguments (the prompt comes on stdin, never on the command line), and the reviewer's once more: read-only, no
  // tools, its answer only. A reviewer runs commands too (git diff, the tests), so agy and Vibe run every tool unasked,
  // for work and reviews alike: no sandbox or classifier, only the job's own uid, home and clone.
  run: (o: { home: string; model?: string; effort?: string; session?: string | null; reviewing: boolean }) => string[];
  input?: (prompt: string) => string; // what goes on stdin for a prompt, when it isn't the prompt as it is
  env?: (o: { model?: string; effort?: string }) => Record<string, string>; // a run's settings the CLI takes only from its env
  ask: (o: { home: string; model?: string; effort?: string }) => string[];
  // One line of its JSON stream, parsed, as the Claude Code stream-json events it stands for (none for a line that
  // means nothing to the worker). state is the run's own, for a CLI that spreads one message over several lines.
  events: (e: any, state: Record<string, unknown>) => object[];
  // A file the CLI leaves in the home with how the run ended (its usage, its error), relative to the home: read once the
  // CLI has exited and passed to events() as its last line, with state.exitCode set first. A job's own processes can
  // write it, so nothing a verdict depends on is taken from it.
  export?: string;
  // Project config of its own a branch could carry and the CLI would act on: removed from a work job's clone it runs in
  // (as BRANCH_CONFIG), and from every reviewer's (REVIEW_STRIP), whichever CLI reviews.
  strip: string[];
  // Its sign-in tool for a seat that signs in with its account, run as the keeper in a terminal with home(the seat's
  // folder): its arguments, and whether the board pastes back a code from the page it prints. Or the files a key makes
  // in a home, for a seat that signs in with a key. (Its provider says which, seats.ts.)
  // env: what its terminal needs set, typed: the keys typed once it has started.
  signIn?: { args: string[]; asks: 'code' | 'nothing'; code?: RegExp; env?: Record<string, string>; typed?: string };
  key?: (key: string) => Record<string, string>;
  // The fields a refresh changes in a login seat's sign-in file, wherever they sit in its JSON: a run's refreshed copy goes
  // back to the seat only as such a refresh (refreshOnly). Not set: nothing a run leaves goes back.
  refreshed?: string[];
  // The CLI's own error texts (from events(), or stderr when it died first): closed, if it says so of a closed account
  errors: CliErrors;
};

export const CLIS: Record<string, Cli> = { vibe, agy };
// Every CLI a provider may name
export const CLI_IDS = ['claude', 'codex', ...Object.keys(CLIS)];
// What every reviewer's clone loses, whichever CLI it runs on
export const CLI_CONFIG = Object.values(CLIS).flatMap(c => c.strip);

// Whether a sign-in file a run left is the one it was handed with a refresh's fields alone changed: the same JSON shape,
// every other field as it was (the refresh token and the account's identity among them). Anything else (another
// account's sign-in, a broken file) would reach every later run on the seat, so it never goes back.
export function refreshOnly(handed: string, left: string, fields: string[]) {
  try {
    return left !== handed && left.length <= 64_000 && sameBut(JSON.parse(handed), JSON.parse(left), fields);
  } catch {
    return false;
  }
}
const plain = (o: unknown): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o);
function sameBut(a: unknown, b: unknown, fields: string[]): boolean {
  if (!plain(a) || !plain(b)) return JSON.stringify(a) === JSON.stringify(b);
  const keys = Object.keys(a).sort();
  if (keys.join() !== Object.keys(b).sort().join()) return false;
  return keys.every(k =>
    fields.includes(k)
      ? typeof a[k] === typeof b[k] && !plain(a[k]) && !Array.isArray(a[k])
      : sameBut(a[k], b[k], fields),
  );
}

// A job's saved session is the CLI's that started it: its id as it is on the job's engine's own CLI, `<cli>:<id>` on any
// other (a seat of another provider's). A run resumes only a session of its own CLI. Another's can't go on there, so the
// job starts a new session in its kept clone (switched).
export const sessionTag = (cli: string, engine: string, id: string) => (cli === engine ? id : `${cli}:${id}`);
export function resumeOn(cli: string, engine: string, saved: string | null | undefined) {
  if (!saved) return { session: null, switched: false };
  const at = saved.indexOf(':'),
    of = at < 0 ? engine : saved.slice(0, at);
  return of === cli ? { session: saved.slice(at + 1), switched: false } : { session: null, switched: true };
}

// Returns only a validated credential refresh, even after the run has lost ownership.
import { execFileSync } from 'node:child_process';
import { CLIS, refreshOnly } from './clis.ts';
import type { Agent } from './git.ts';

type SignIn = {
  me: Agent;
  keeper: Agent;
  seat: { gone?: boolean; signIn?: string };
  home: string;
  directory: string;
  cli: string;
  from?: string;
  files?: Record<string, string>;
};

export function returnSignIn(signIn: SignIn) {
  const { me, keeper, seat, home, directory, cli, files } = signIn;
  if (cli === 'codex') return keepCodexAuth(signIn);
  const refreshed = CLIS[cli]?.refreshed;
  if (seat.signIn === 'key' || !refreshed) return; // (a key never refreshes: what a job leaves in its home is never the seat's key)
  const from = files ?? {};
  for (const [f, before] of Object.entries(from)) {
    const file = `${directory}/${f}`,
      mine = readAs(me, `${home}/${f}`),
      cur = readAs(keeper, file);
    if (seat.gone || !mine || cur !== before || !refreshOnly(before, mine, refreshed)) continue;
    saveAs(keeper, file, mine);
    from[f] = mine;
  }
}

function keepCodexAuth({ me, keeper, seat, home, directory, from }: SignIn) {
  if (seat.gone) return; // (the board removed it: its sign-in stays deleted)
  const file = `${directory}/auth.json`,
    mine = readAs(me, `${home}/.codex/auth.json`),
    cur = readAs(keeper, file);
  if (!mine || !cur || mine === cur || cur !== from || mine.length > 64_000) return;
  try {
    const a = JSON.parse(mine),
      b = JSON.parse(cur),
      keys = (o: object) => Object.keys(o).sort().join();
    const plain = (o: any) => o && typeof o === 'object' && !Array.isArray(o);
    if (!plain(a) || !plain(b) || keys(a) !== keys(b)) return;
    for (const k of Object.keys(b))
      if (k !== 'tokens' && k !== 'last_refresh' && JSON.stringify(a[k]) !== JSON.stringify(b[k])) return;
    if (
      plain(b.tokens) &&
      (!plain(a.tokens) || keys(a.tokens) !== keys(b.tokens) || a.tokens.account_id !== b.tokens.account_id)
    )
      return;
  } catch {
    return;
  }
  saveAs(keeper, file, mine);
}

// Credential writes are fixed keeper operations, independent of a cancelled job's command permission.
function saveAs(keeper: Agent, file: string, text: string) {
  execFileSync('sh', ['-c', 'umask 077 && cat > "$1.new" && mv -f "$1.new" "$1"', 'sh', file], {
    env: keeper.env,
    uid: keeper.uid,
    gid: keeper.gid,
    input: text,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// Read as the file's owner so a planted symlink cannot expose root's secrets.
// Job files may be FIFOs. Bound reads to ten seconds and execFileSync's 1 MB buffer.
export const readAs = (who: Agent, path: string) => {
  try {
    return execFileSync('cat', ['--', path], {
      encoding: 'utf8',
      env: who.env,
      uid: who.uid,
      gid: who.gid,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
  } catch {
    return undefined;
  }
};

// The readers some files always get, whatever a round's triage judges: the review's own hard floor (reviewtriage.ts read).
import { org } from './company.ts';
import { findAgent } from './jobs.ts';

export type Readers = { claude: number; codex: number };
// Each floor file with the readers it needs. A reader counts for the files they're given, never for the round's others.
export type Floor = { file: string; readers: Readers }[];
type StaffEntry = { id: string };

// What decides a merge (the review loop, who reads and rules, which findings reach the author, the holds and approvals
// a merge waits on, the board's merge answers, GitHub's merges and the diff that lets records merge unreviewed), CI, the
// server and the worker's checks. A change here can weaken the review that judges it, or reach every job after it, so it
// takes the authority matrix's 2 Claude + 2 Codex, as the gates' and the agents' own config do.
const GATED =
  /^(\.github|infra)\/|^platform\/coordinator\/src\/(review[^/]*|panel(capacity)?|rulingjobs|findings|trust|decisions|visualapproval|boardmerges|github)\.ts$|^platform\/worker\/src\/(safety|verdict|git)\.ts$/;
// The agents' own config, which every job runs under (what a ruling never touches up either: review.ts)
export const AGENT_CONFIG =
  /(^|\/)(\.(claude|codex|agents?|gemini|vibe)|_agents?)\/|(^|\/)\.mcp\.json$|(^|\/)\.?codeium\.ya?ml$|^company\/infra\.env$/i;
// The gates' scripts and root config, whose change can weaken every check after it (what a ruling never touches up:
// review.ts)
export const GATES_CONFIG =
  /^shared\/gates\/|(^|\/)(eslint\.config|prettier\.config|\.prettierrc)(\.[^/]*)?$|^(\.prettierignore|tsconfig\.json|package(-lock)?\.json)$/;
// Sign-in, payments, secrets and approvals by name, outside the writing and pictures about them. (?!or) leaves out
// "author" and "authority".
const KEYS = /auth(?!or)|payment|stripe|secret|approv/i;
const WRITING = /\.(md|png|jpe?g|gif|webp)$/i;
// What every job reads and obeys: never a light read, and one reader of each engine
const INSTRUCTIONS = /(^|\/)(AGENTS|CLAUDE)(\.override|\.local)?\.md$|^company\/(CHARTER|AUTHORITY)\.md$/;

const keyed = (file: string) => KEYS.test(file) && !WRITING.test(file);
const gated = (file: string) => GATED.test(file) || GATES_CONFIG.test(file) || AGENT_CONFIG.test(file) || keyed(file);

// What each of a round's files needs, never more readers of an engine than the staff eligible to read. On a fix round a
// gated file keeps the playbook's 2 Claude + 1 Codex, unless it's about sign-in, payments, secrets or approvals.
export function needed(files: string[], fixRound: boolean, eligible: (agent: string) => boolean): Floor {
  const staff = org()
    .departments.flatMap((department: { agents?: StaffEntry[] }) => department.agents ?? [])
    .filter((agent: StaffEntry) => eligible(agent.id));
  const staffOn = (engine: string) =>
    staff.filter((agent: StaffEntry) => findAgent(agent.id)?.engine === engine).length;
  const atMost = ({ claude, codex }: Readers) => ({
    claude: Math.min(claude, staffOn('claude')),
    codex: Math.min(codex, staffOn('codex')),
  });
  return files.flatMap(file =>
    gated(file)
      ? [{ file, readers: atMost({ claude: 2, codex: fixRound && !keyed(file) ? 1 : 2 }) }]
      : INSTRUCTIONS.test(file)
        ? [{ file, readers: atMost({ claude: 1, codex: 1 }) }]
        : [],
  );
}

export function brief(floor: Floor) {
  if (!floor.length) return '';
  const wanted = [...Map.groupBy(floor, ({ readers }) => readersText(readers))].map(
    ([readers, entries]) => `${readers} for ${entries.map(({ file }) => file).join(', ')}`,
  );
  return `\nThe review's floor: name at least ${wanted.join('; ')}, each among the readers given that file (after the
engine constraints move files). Readers of other files don't count, and none of it is ever throwaway. HQ refuses a
selection below the floor. Judge who reads, and add more where the change needs them.`;
}

// Why a selection falls below the floor, if it does: each floor file counts only the readers assigned it.
export function problem(floor: Floor, readers: { agent: string; files: string[] }[], throwaway: boolean) {
  if (!floor.length) return;
  const what = `the review's floor (${named(floor.map(({ file }) => file))})`;
  if (throwaway) return `${what} is never throwaway work`;
  if (!readers.length) return `${what} needs its own readers, not the consolidator alone`;
  const readersOn = (file: string, engine: string) =>
    readers.filter(reader => reader.files.includes(file) && findAgent(reader.agent)?.engine === engine).length;
  const short = floor.find(
    ({ file, readers: least }) => readersOn(file, 'claude') < least.claude || readersOn(file, 'codex') < least.codex,
  );
  if (short)
    return `the review's floor needs at least ${readersText(short.readers)} given ${short.file} among their files`;
}

const readersText = ({ claude, codex }: Readers) =>
  `${claude} Claude and ${codex} Codex reader${codex === 1 ? '' : 's'}`;
const named = (files: string[]) =>
  files.length === 1
    ? files[0]
    : `${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''}`;

// Command roots and CLI-owned processes within a job's process tree.
import { CLI_PROGRAMS } from './detached.ts';
import type { ProcessSnapshot } from './shares.ts';

// A job's CLI as /proc has it now: the launch running (pid and start) and, under it, the CLI's own programs (a Node
// launcher's native agent and that agent's helpers), never the commands they run. Empty once the launch has ended.
export function cliProcesses(processes: ProcessSnapshot[], launch: { pid: number; start: string }) {
  const own = new Set<number>();
  if (!processes.some(p => p.pid === launch.pid && p.start === launch.start)) return own;
  own.add(launch.pid);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of processes)
      if (!own.has(p.pid) && own.has(p.ppid) && CLI_PROGRAMS.has(p.comm)) {
        own.add(p.pid);
        grew = true;
      }
  }
  return own;
}

// A job's runs, each by its first process: a command its CLI started (its parent is the CLI's, or none of the job's
// processes: a push's checks, run after the CLI has ended, or one left behind) with every process under it, the first
// one first. The CLI's own processes are in none.
export function runsOf(processes: ProcessSnapshot[], cli: Set<number>) {
  const byPid = new Map(processes.map(p => [p.pid, p]));
  const rootOf = (p: ProcessSnapshot) => {
    const seen = new Set([p.pid]);
    let root = p;
    for (let up = byPid.get(root.ppid); up && !cli.has(up.pid) && !seen.has(up.pid); up = byPid.get(up.ppid)) {
      seen.add(up.pid);
      root = up;
    }
    return root;
  };
  const runs = new Map<ProcessSnapshot, ProcessSnapshot[]>();
  for (const p of processes) {
    if (cli.has(p.pid)) continue;
    const root = rootOf(p);
    if (!runs.has(root)) runs.set(root, [root]);
    if (p !== root) runs.get(root)!.push(p);
  }
  return runs;
}

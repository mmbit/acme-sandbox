// Scores the working play beside a git ref on saved snapshots and landings, on retained planner inputs.
// node platform/coordinator/scripts/backtest.ts <saved.json> [--ref <ref>]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Play, Saved } from '../src/backtest.ts';
import type { scoreRounds } from '../src/roundscore.ts';

const [file, flag, given] = process.argv.slice(2);
if (!file || (flag !== undefined && (flag !== '--ref' || !given))) {
  console.error('usage: node platform/coordinator/scripts/backtest.ts <saved.json> [--ref <ref>]');
  process.exit(2);
}
const ref = given ?? 'origin/main';
const coordinator = new URL('..', import.meta.url).pathname;
const scratch = mkdtempSync(`${tmpdir()}/backtest-`);
try {
  process.env.DATA_DIR = `${scratch}/data`;
  mkdirSync(process.env.DATA_DIR);
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: coordinator }).toString().trim();
  const archive = execFileSync('git', ['archive', ref, 'platform', 'shared'], { cwd: repo, maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-C', scratch], { input: archive });
  symlinkSync(`${coordinator}node_modules`, `${scratch}/platform/coordinator/node_modules`);
  await report(JSON.parse(readFileSync(file, 'utf8')) as Saved);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

async function report(saved: Saved) {
  const backtest = await import('../src/backtest.ts');
  const rounds = await import('../src/roundscore.ts');
  const here = await import('../src/eta.ts');
  const there = await import(`${scratch}/platform/coordinator/src/eta.ts`);
  const landed = new Map(saved.landed);
  const complete = saved.snapshots.filter(k => k.snapshot.planner === 3);
  console.log(`Planner inputs: ${complete.length}/${saved.snapshots.length} snapshots, ${landed.size} landings.`);
  console.log('Legacy inputs are excluded. Replay those with a tree from before calibration.');
  const score = async (name: string, play: Play) => ({
    name,
    leads: await backtest.score(complete, landed, play),
  });
  printLeads([
    await score(`this tree (version ${here.PLAY_VERSION})`, here.play),
    await score(`${ref} (version ${there.PLAY_VERSION})`, there.play),
  ]);
  printRounds('this tree', await rounds.scoreRounds(complete, here.play));
  printRounds(ref, await rounds.scoreRounds(complete, there.play));
}

function printLeads(plays: { name: string; leads: Awaited<ReturnType<typeof import('../src/backtest.ts').score>> }[]) {
  console.log('| ahead | play | jobs | median miss | later than said | by the slow time | no merge |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const { name, leads } of plays)
    for (const l of leads) {
      const cells = [
        l.lead,
        name,
        l.count,
        minutes(l.median_miss_minutes),
        percent(l.late_share),
        percent(l.held_share),
        l.no_merge,
      ];
      console.log(`| ${cells.join(' | ')} |`);
    }
}

function printRounds(name: string, report: Awaited<ReturnType<typeof scoreRounds>>) {
  console.log(
    `\nWindowed push-to-merge (${name}), latest snapshot per job. Small means own size at most ${report.small_up_to_minutes} min.`,
  );
  console.log('| size | jobs | median | worst | no merge |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const group of report.groups)
    console.log(
      `| ${[group.size, group.count, minutes(group.median_minutes), minutes(group.worst_minutes), group.no_merge].join(' | ')} |`,
    );
}
function minutes(value: number | null) {
  return value === null ? '–' : `${value} min`;
}
function percent(value: number | null) {
  return value === null ? '–' : `${Math.round(value * 100)}%`;
}

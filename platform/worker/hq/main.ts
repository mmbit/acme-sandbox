// hq: the agents' line to the company. One function per command, with its help beside it, dispatched by name here; a
// company's own commands come from its kits (kits.ts). bin/hq, the worker image's /usr/local/bin/hq, runs this.
import { ApiError, speakAs } from './api.ts';
import * as cards from './cards.ts';
import { care } from './care.ts';
import { estimate } from './estimate.ts';
import * as feedback from './feedback.ts';
import { followthrough, summary } from './followthrough.ts';
import { guest } from './guests.ts';
import { intake } from './intake.ts';
import * as jobs from './jobs.ts';
import * as kits from './kits.ts';
import * as ledger from './ledger.ts';
import { mail } from './mail.ts';
import { meeting } from './meetings.ts';
import * as memory from './memory.ts';
import * as messages from './messages.ts';
import { numbers, spend } from './numbers.ts';
import { orders } from './orders.ts';
import { overseer } from './overseer.ts';
import { owed } from './owed.ts';
import { pad } from './pad.ts';
import { StopError, print, stop } from './output.ts';
import { phone } from './phone.ts';
import { plan } from './plan.ts';
import { picture } from './pictures.ts';
import { answer, sketch, sketches } from './book.ts';
import { preview } from './preview.ts';
import * as proposals from './proposals.ts';
import { decision } from './pauses.ts';
import * as projects from './projects.ts';
import { report } from './report.ts';
import { profile } from './profile.ts';
import * as runs from './runs.ts';
import { tooling } from './tooling.ts';
import { when } from './when.ts';
import { studio } from './studio.ts';
import { seatWarning } from './seatwarning.ts';
import { complete } from './completion.ts';

// run: what it ends hq with (a command it runs for the agent: that command's exit code), or nothing for 0.
type Command = { help: string; run: (args: string[]) => Promise<void | number> };

// In the order of the help
const COMMANDS: Record<string, Command> = {
  complete,
  status: messages.status,
  say: messages.say,
  sent: messages.sent,
  job: jobs.job,
  code: jobs.code,
  propose: proposals.propose,
  inbox: proposals.inbox,
  meeting,
  cancel: jobs.cancel,
  stop: jobs.stopJob,
  up: jobs.up,
  expedite: jobs.expedite,
  waits: jobs.waits,
  review: jobs.review,
  window: jobs.window,
  when,
  plan,
  deliverable: projects.deliverable,
  project: projects.project,
  decision,
  followthrough,
  summary,
  pad,
  projects: projects.projectLines,
  now: projects.now,
  items: ledger.items,
  item: ledger.item,
  reply: ledger.reply,
  ask: cards.ask,
  owed,
  photos: cards.photos,
  picture,
  intake,
  sketches,
  sketch,
  answer,
  studio,
  'seat-warning': seatWarning,
  wait: cards.wait,
  topic: cards.topic,
  close: cards.close,
  requests: cards.requests,
  jobs: jobs.jobs,
  extend: jobs.extend,
  rewrite: cards.rewrite,
  request: cards.request,
  mail,
  guest,
  phone,
  note: feedback.note,
  notes: feedback.notes,
  route: feedback.route,
  guestnotes: feedback.guestnotes,
  preview,
  run: runs.run,
  tooling,
  orders,
  care,
  numbers,
  spend,
  search: memory.search,
  history: memory.history,
  call: memory.call,
  intercom: memory.intercom,
  report,
  profile,
  estimate,
  overseer,
};

// Old names that still work
const ALIASES: Record<string, string> = { thread: 'deliverable' };

const HELP_HEAD =
  "The agents' line to the company. Team members (sub-agents) add --as <their id> to speak as themselves.";
const HELP_FOOT = 'kind: decision | approval | credential | action | notice; urgency: now | today | whenever';

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  process.exitCode = exitFor(error);
}

async function run(args: string[]) {
  if (args[0] === '--as') {
    if (args.length < 2) stop('usage: hq --as <team member id> <command> ...');
    speakAs(args[1]);
    args = args.slice(2);
  }
  const [given = '', ...rest] = args;
  const name = Object.hasOwn(ALIASES, given) ? ALIASES[given] : given;
  if (Object.hasOwn(COMMANDS, name)) {
    return (await COMMANDS[name].run(rest)) ?? 0;
  }
  const own = kits.findKitCommand(name);
  if (own) return kits.runKitCommand(own, args);
  printHelp();
  return 1;
}

// The platform's commands, then the company's
function printHelp() {
  const platform = Object.values(COMMANDS).flatMap(command => command.help.replace(/^\n/, '').split('\n'));
  print(`# ${HELP_HEAD}`, ...platform.map(line => `#${line}`), `# ${HELP_FOOT}`, ...kits.kitHelp());
}

// A stop says why on stderr (when it has words). A call that failed without an answer exits silently with its code.
// Anything else is a fault in hq, which may come after HQ made a change: 70 (sysexits' EX_SOFTWARE), never 1, which
// says nothing changed (a refusal, a wrong command).
function exitFor(error: unknown) {
  if (error instanceof StopError) {
    if (error.message) process.stderr.write(`${error.message}\n`);
    return error.exitCode;
  }
  if (error instanceof ApiError) return error.exitCode;
  console.error(error);
  return 70;
}

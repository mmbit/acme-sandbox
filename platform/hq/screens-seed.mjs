// The test company's state that screens-compare.mjs shoots: two projects with deliverables whose tasks are done, under
// review, running and queued, sized; an open card on the desk phone; a line on the intercom and the CEO's answer; the
// CEO's page; a second newsletter post. Made through the coordinator's own routes (harness.ts callers), so either
// side's coordinator fills it its own way. Each step runs at its own minute of the side's clock (at), so every row
// written carries the same time on both sides.
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';

// What harness(`before`) writes into the test company: its projects, owned by its people, and the post
const PROJECTS = `projects:
  - { id: office, name: The office, owner: juno }
  - { id: game, name: The game, owner: wren }
  - { id: shop, name: The shop, owner: moss }
made:
  checks: { hq: office }
  alarms: { hq: office }
`;
export function writeCompany(repo) {
  writeFileSync(`${repo}/company/projects.yaml`, PROJECTS);
  const post = `${repo}/knowledge/posts/2026-10-13-ten-levels`;
  mkdirSync(post, { recursive: true });
  cpSync(`${repo}/knowledge/posts/2026-09-25-were-open/cover.png`, `${post}/cover.png`);
  writeFileSync(
    `${post}/index.md`,
    `---\ntitle: Ten levels, one evening\npublished: 2026-10-13T18:00\nauthor: wren\ncover: cover.png\n---\n\n` +
      'The game has its first ten levels. Each one teaches a single move, and the last one asks for all of them.\n',
  );
}

// The board's screens filled: at(step) sets the clock for each step in turn
export async function seed(h, at) {
  at(0);
  const wren = await h.start({ agent: 'wren', title: 'Plan the game' }),
    moss = await h.start({ agent: 'moss', title: 'Plan the shop' }),
    juno = await h.start({ agent: 'juno', title: 'Morning round' });
  at(1);
  await drawn(h, wren, { project: 'game', name: 'Levels', slug: 'levels', goal: 'Ten levels a new player finishes' });
  await drawn(h, wren, { project: 'game', name: 'Sound', slug: 'sound', goal: 'Every press answers with a sound' });
  await drawn(h, moss, { project: 'shop', name: 'Checkout', slug: 'checkout', goal: 'A buyer pays in one step' });
  at(2);
  const tiles = await queued(h, wren, 'lark', 'game/levels', 'Draw the tiles for level one', '40m'),
    levels = await queued(h, wren, 'chime', 'game/levels', 'Build levels two to five', '1h30m');
  await queued(h, wren, 'lark', 'game/levels', 'Write the tutorial hints', '25m');
  await queued(h, wren, 'pylon', 'game/sound', 'Compose the button clicks', '35m');
  const basket = await queued(h, moss, 'kit', 'shop/checkout', 'Build the basket page', '50m');
  await queued(h, moss, 'kit', 'shop/checkout', 'Write the refund terms', '20m');
  at(3);
  const drawing = await h.claimJob(tiles);
  await said(h, drawing, 'Drawing the grass tiles');
  at(4);
  ok('a finished task', await h.finish(drawing, { status: 'done', pr: 101, branch: `job/${tiles}`, sha: 'a1b2c3d' }));
  at(5);
  const building = await h.claimJob(levels);
  await said(h, building, 'Laying out level three');
  const shop = await h.claimJob(basket);
  await said(h, shop, 'Wiring the basket total');
  await h.capacity({ claude: 3 }); // (the worker's seats, for the deliverables' times)
  at(6);
  await h.ask(shop, {
    kind: 'decision',
    urgency: 'today',
    title: 'Which price for the sticker pack?',
    body: 'Two prices fit what we spend. €4 sells more packs, €6 keeps the margin we planned.\n\nI recommend €4.',
  });
  at(7);
  ok("the CEO's page", await h.agent('pad', juno.token, { text: padText }));
  await said(h, juno, 'Reading the morning round');
  at(8);
  ok('a line on the intercom', await h.board('/api/chat', { text: 'How far along are the levels?' }));
  const turn = await h.claimJob(chatTurn(h));
  ok(
    "the CEO's answer",
    await h.finish(turn, { result: 'Level one is in review, levels two to five are being built.' }),
  );
}

const padText = `# This week

- The game's first ten levels, then its sound.
- The shop's checkout, in one step.`;

const drawn = async (h, planner, thread) =>
  ok(`deliverable ${thread.slug}`, await h.agent('plan/thread', planner.token, thread));
async function queued(h, lead, agent, thread, title, size) {
  const job = await h.agent('job', lead.token, { agent, thread, title, prompt: `${title}.`, size });
  return ok(`task "${title}"`, job).id;
}
const said = async (h, job, text) =>
  ok(`${job.agent}'s status`, await h.agent('event', job.token, { type: 'status', state: 'working', text }));
// The intercom's turn the board's line queued for the CEO (chat.ts): the newest job HQ lists of that kind
const chatTurn = h =>
  h.jobs
    .listJobs()
    .filter(j => j.kind === 'chat' && j.status === 'queued')
    .at(-1).id;

// A route's answer, or a stop naming the step whose route refused
function ok(step, reply) {
  if (reply.status !== 200) throw new Error(`Seed: ${step} refused (${reply.status}): ${JSON.stringify(reply.body)}`);
  return reply.body;
}

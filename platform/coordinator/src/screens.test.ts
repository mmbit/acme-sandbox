// node --test src/screens.test.ts   (the board's screens, org.yaml review.screens: a push whose check renders them changed
// is the screens rule's work whatever files it touches, so its ruling runs on that model, opens every before and after
// and names them, or is refused; an expedited one merges only after that look. A push that changes the check's own code
// is one its check couldn't tell, as is one whose check couldn't run: its ruling renders them and names what its render
// found. A push that changes none, or a worker that reports no check, costs nothing more.)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { harness } from './harness.ts';
import { completeTriage } from './reviewfixture.ts';

const MODEL = 'claude-opus-test';
const h = await harness('screens', {
  before: repo =>
    appendFileSync(
      `${repo}/company/org.yaml`,
      `\nengineOnly:\n  - { id: visual, what: visual work, engine: claude, model: ${MODEL}, paths: ["platform/hq/**"] }\n` +
        'review:\n  screens: { rule: visual, run: "node compare.mjs", look: "against the brand guide" }\n',
    ),
});
const { db, github } = h;
const finish = h.finish;
h.finish = async (job, report = { status: 'done' }) => {
  const reply = await finish(job, report);
  if (typeof report.pr === 'number') await completeTriage(h, report.pr, ['nib']);
  return reply;
};
afterEach(() => db.prepare("update jobs set status = 'cancelled' where status = 'queued'").run());

const CODE = 'platform/coordinator/src/projectboard.ts';
const PASSED = { passed: true, report: 'fine' };
const said = (answer: object) => ({ passed: true, report: `Rendered 24 screens\n${JSON.stringify(answer)}` });
const SHEET = '/tmp/screens/projects-brownstone-tablet-sheet.png';
const CHANGED_SHOT = { screen: 'projects', look: 'brownstone', device: 'tablet', sheet: SHEET };
const CHANGED = said({ rendered: true, changed: [CHANGED_SHOT], same: 23 });
type Row = { id: number; agent: string; kind: string; stage: string | null; prompt: string; model: string | null };
const onPr = (pr: number) =>
  db
    .prepare("select id, agent, kind, stage, prompt, model from jobs where pr = ? and status = 'queued' order by id")
    .all(pr) as Row[];

// A Codex run's push of coordinator code, with the screens check's answer, to its round's ruling
async function toRuling(pr: number, screens?: object, files = [CODE]) {
  const run = await h.start({ agent: 'bolt', engine: 'codex', branch: `job/s${pr}` });
  await h.finish(run, { pr, branch: `job/s${pr}`, files, sha: String(pr % 10).repeat(40), screens });
  const [review] = onPr(pr).filter(j => j.kind === 'review');
  const seat = await h.claim('codex');
  assert.equal(seat?.id, review.id);
  await h.finish(seat!, { output: '{"findings": [], "summary": "fine"}' });
  await sleep(50);
  return onPr(pr).find(j => j.kind === 'consolidate' && j.stage === 'ruling')!;
}

const RULING = { decision: 'merge', blocking: [], nonblocking: [], summary: 'fine', major_visual: false };

test("a push whose screens changed is ruled on the screens' model, which opens every before and after or is refused", async () => {
  const ruling = await toRuling(701, CHANGED);
  assert.equal(ruling.model, MODEL, 'the ruling runs on the rule’s model, though no file is a visual path');
  assert.match(ruling.prompt, /## The board's screens, before and after/);
  // (the sheets the check made, which the worker kept: no render of its own unless one is gone)
  assert.match(
    ruling.prompt,
    /projects \(brownstone, tablet\)\. Open the sheets the push's check made: \/tmp\/screens\//,
  );
  assert.match(
    ruling.prompt,
    /Only if one is gone: Render them yourself: `node compare\.mjs`.*against the brand guide/s,
  );

  const run = await h.claim('claude');
  assert.equal(run?.id, ruling.id);
  const review = await import('./review.ts');
  assert.match(review.outputProblem(ruling.id, JSON.stringify(RULING)) ?? '', /"screens" must list every/);
  for (const screens of [
    [{ sheet: '/tmp/screens/home-brownstone-tablet-sheet.png', saw: 'the cost line is set in the tile type' }],
    [{ sheet: SHEET, saw: ' ' }],
  ])
    assert.match(review.outputProblem(ruling.id, JSON.stringify({ ...RULING, screens })) ?? '', /missing: projects-/);
  // (the ruling's own render's folder, not the check's)
  const looked = { ...RULING, screens: [{ sheet: `/work${SHEET}`, saw: 'the cost line is set in the tile type' }] };
  assert.equal(review.outputProblem(ruling.id, JSON.stringify(looked)), undefined);
});

test("a changed screen with no picture on either side is owed until the ruling's own render shows it, or finds it the same", async () => {
  const fonts = "its fonts didn't load (Pixelify Sans)";
  const blank = { screen: 'home', look: 'brownstone', device: 'phone', sheet: null, why: fonts };
  const ruling = await toRuling(707, said({ rendered: true, changed: [CHANGED_SHOT, blank], same: 22 }));
  assert.equal(ruling.model, MODEL);
  assert.match(ruling.prompt, /no picture on either side of home \(brownstone, phone\): its fonts didn't load/);
  assert.match(ruling.prompt, /Your own render \(`node compare\.mjs`\) must show each one/);
  assert.match(ruling.prompt, /refused: projects-brownstone-tablet-sheet\.png, home-brownstone-phone-sheet\.png/);
  const run = await h.claim('claude');
  assert.equal(run?.id, ruling.id);
  const review = await import('./review.ts');
  const problem = (answer: object) => review.outputProblem(ruling.id, JSON.stringify({ ...RULING, ...answer }));
  const projects = { sheet: SHEET, saw: 'the cost line is set in the tile type' };
  // (the push check's sheets alone, or a render of the ruling's own that pictured it on neither side either)
  for (const answer of [
    { screens: [projects] },
    { screens: [projects], screens_render: { rendered: true, changed: [CHANGED_SHOT, blank], same: 22 } },
  ])
    assert.match(
      problem(answer) ?? '',
      /no picture on either side: home \(brownstone, phone\): its fonts.*broken on main/,
    );
  const home = { ...blank, sheet: '/o/home-brownstone-phone-sheet.png', why: undefined };
  const again = { rendered: true, changed: [CHANGED_SHOT, home], same: 22 };
  assert.match(problem({ screens: [projects], screens_render: again }) ?? '', /missing: home-brownstone-phone-sheet/);
  const both = [projects, { sheet: home.sheet, saw: 'the greeting sits a line lower' }];
  assert.equal(problem({ screens: both, screens_render: again }), undefined);
  // (its own render found it the same: only the pictured screens are owed)
  const same = { rendered: true, changed: [CHANGED_SHOT], same: 23 };
  assert.equal(problem({ screens: [projects], screens_render: same }), undefined);
  await h.finish(run!, { output: JSON.stringify({ ...RULING, screens: [projects], screens_render: same }) });
});

test("a push whose check couldn't run, or that changes the check, is ruled on what the ruling's own render finds", async () => {
  for (const [pr, screens, files] of [
    [702, { passed: null, report: 'Chromium would not start' }, [CODE]],
    [706, said({ rendered: true, changed: [], same: 24 }), [CODE, 'shared/browser/browser.mjs']],
  ] as const) {
    const ruling = await toRuling(pr, screens, [...files]);
    assert.equal(ruling.model, MODEL, `#${pr}`);
    assert.match(ruling.prompt, /screens check couldn't tell.*Render them yourself: `node compare\.mjs`/s, `#${pr}`);
    const run = await h.claim('claude');
    assert.equal(run?.id, ruling.id, `#${pr}`);
    const review = await import('./review.ts');
    const problem = (answer: object) => review.outputProblem(ruling.id, JSON.stringify({ ...RULING, ...answer }));
    assert.match(problem({ screens: [] }) ?? '', /"screens_render" must be/, `#${pr}`);
    assert.equal(problem({ screens: [], screens_render: { rendered: true, changed: [], same: 24 } }), undefined);
    assert.equal(
      problem({ screens: [], screens_render: { rendered: false, why: 'no code HQ runs changed' } }),
      undefined,
    );
    const rendered = {
      rendered: true,
      changed: [{ screen: 'news', look: 'wire', device: 'phone', sheet: '/o/news-wire-phone-sheet.png' }],
    };
    assert.match(problem({ screens: [], screens_render: rendered }) ?? '', /missing: news-wire-phone-sheet\.png/);
    const unshot = { rendered: true, changed: [{ ...rendered.changed[0], sheet: null, why: 'Chromium crashed' }] };
    assert.match(problem({ screens: [], screens_render: unshot }) ?? '', /no picture on either side: news.*crashed/);
    const saw = [{ sheet: '/o/news-wire-phone-sheet.png', saw: 'the headline wraps a line earlier' }];
    assert.equal(problem({ screens: saw, screens_render: rendered }), undefined, `#${pr}`);
    await h.finish(run!, { output: JSON.stringify({ ...RULING, screens: saw, screens_render: rendered }) });
    const ended = db.prepare('select status, output from jobs where id = ?').get(ruling.id) as {
      status: string;
      output: string;
    };
    assert.deepEqual([ended.status, JSON.parse(ended.output).screens], ['done', saw], `#${pr}: the ruling is taken`);
    await sleep(50);
    assert.equal(github.pr(pr).merged, true, `#${pr}: its merge stands`);
  }
});

test("a push that changes how the check opens HQ (book/originroute.mjs) is one its check couldn't tell", async () => {
  const screens = await import('./screens.ts');
  const sha = '8'.repeat(40);
  screens.record(708, sha, said({ rendered: true, changed: [], same: 24 }), [CODE, 'platform/hq/book/originroute.mjs']);
  assert.equal(screens.owed(708, sha), null);
});

test('a push that changes no screen, renders none, or comes with no check gets no look and keeps its engines', async () => {
  for (const [pr, screens] of [
    [703, said({ rendered: true, changed: [], same: 24 })],
    [704, said({ rendered: false, why: 'no code HQ runs changed' })],
    [705, undefined],
  ] as const) {
    const ruling = await toRuling(pr, screens);
    assert.notEqual(ruling.model, MODEL, `#${pr}`);
    assert.ok(!ruling.prompt.includes("The board's screens"), `#${pr}`);
  }
});

test('an expedited push that changes what HQ shows merges only after its look; one that changes none merges on its checks', async () => {
  for (const [pr, screens, merges, files] of [
    [711, CHANGED, false, [CODE]],
    [712, said({ rendered: true, changed: [], same: 24 }), true, [CODE]],
    [713, said({ rendered: true, changed: [], same: 24 }), false, [CODE, 'shared/browser/render.ts']],
  ] as const) {
    const job = await h.start({ agent: 'bolt', branch: `review/${pr}`, expedite: true });
    await finish(job, {
      pr,
      branch: `review/${pr}`,
      files: [...files],
      sha: String(pr % 10).repeat(40),
      gates: PASSED,
      tests: PASSED,
      screens,
    });
    await sleep(50);
    assert.equal(github.pr(pr).merged, merges, `#${pr}`);
    if (merges) continue;
    // (expedited again while it waits for its look: still refused)
    const review = await import('./review.ts');
    assert.match(String(await review.expedite(job.id, 'juno')), /merges after its look/);
    assert.equal(github.pr(pr).merged, false, `#${pr}`);
  }
});

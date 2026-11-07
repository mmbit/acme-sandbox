// node --test src/callprototypes.test.ts (the harness: the real server, the board's session and preview key, a guest's
// door, the voice line and a job). The call's prototypes: saved by its agent or a colleague's job, a clip on the call's
// page with each version, served on the call's own preview host to the board and its guest alone, and the board's pen
// on one a note of the call's that points, never a scrap on its page, and its guest's by their name (callprototypes.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { fakeLettermint } from './fixture.ts';
import { harness, VOICE_TOKEN } from './harness.ts';
import { cookieOf } from './testdoor.ts';
import { playwright } from '../../../shared/browser/browser.mjs';

// (the pictures are taken in the coordinator's Chromium: the push checks' is Playwright's, as pagecheck.test.ts finds it)
process.env.CHROMIUM_PATH ??= process.env.BROWSER_HEADLESS_SHELL ?? playwright().chromium.executablePath();
const lettermint = await fakeLettermint();
const h = await harness('callprototypes', { env: { CADDY_HOST: '127.0.0.1', PUBLIC_HOST: 'hq.company.test' } });
lettermint.on();
const { ORIGIN } = await import('./config.ts');
const { onPublish } = await import('./events.ts');
const said = (r: { status: number; body?: any; json?: any; text?: string }) => {
  assert.equal(r.status, 200, JSON.stringify(r.body ?? r.text));
  return r.body ?? r.json;
};
const PAGE = '<!doctype html><title>Flip</title><button onclick="this.textContent=\'Flipped\'">Flip me</button>';
const SNIP = `data:image/png;base64,${(
  await sharp({ create: { width: 40, height: 30, channels: 3, background: '#fff' } })
    .png()
    .toBuffer()
).toString('base64')}`;

// The board's preview key, as HQ's viewer gets it: a link from HQ, opened on the host
async function boardOn(host: string) {
  const link = new URL(said(await h.board('/api/preview/link', { url: `https://${host}/` })).url);
  const accepted = await h.send(link.pathname + link.search, { host });
  return /pv=[^;]+/.exec(String(accepted.headers['set-cookie']))![0];
}

test("the call's agent saves a prototype: a clip on the call's page, v2 beside v1, served to the board, never on another call's host", async () => {
  const { call } = await h.liveCall('juno');
  const page = said(await h.board('/api/notebooks/call', { call })).page.id as number;
  const host = `call-${call}.preview.company.test`;
  // (no prototype yet: no certificate for its host)
  assert.equal((await h.send(`/api/preview/try-host?domain=${host}`)).status, 404);

  const v1 = said(await h.voice('prototype', { call, name: 'Flip card', html: PAGE }));
  assert.deepEqual([v1.version, v1.link], [1, `https://${host}/${v1.id}/`]);
  assert.equal((await sharp(Buffer.from(v1.picture.data, 'base64')).metadata()).format, 'jpeg');
  const v2 = said(await h.voice('prototype', { call, name: 'flip card', html: PAGE, about: 'Bigger button' }));
  assert.equal(v2.version, 2);
  // One clip, the agent's, its versions under it as frames with their pictures and links
  const groups = said(await h.board(`/api/notebooks/pages/groups?page=${page}`)).groups as any[];
  const clip = groups.find(g => g.children?.some((c: any) => c.link === v1.link));
  assert.ok(clip, JSON.stringify(groups));
  // (nothing on it, no post-it with its name: the clip is its versions alone, its name call_prototypes'.)
  assert.deepEqual([clip.ink, clip.texts, clip.pictures, clip.words, clip.h], [[], [], [], '', 0]);
  const versions = clip.children.filter((c: any) => c.style === 'version');
  assert.deepEqual(
    versions.map((v: any) => [v.version, v.link, !!v.picture, v.text]),
    [
      ['v1', v1.link, true, ''],
      ['v2', v2.link, true, 'Bigger button'],
    ],
  );
  assert.equal((await h.send(`/api/preview/try-host?domain=${host}`)).status, 200);
  // (a page as big as the tool takes is taken as the line sends it, each character past ASCII a \u escape:
  // platform/voice's json.dumps, its frame under the same clip.)
  const big = { call, name: 'Flip card', html: `<!doctype html><p>${'€'.repeat(990_000)}</p>` };
  const escaped = JSON.stringify(big).replace(/[^ -~]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const v3 = said(
    await h.send(
      '/api/voice/prototype',
      { authorization: `Bearer ${VOICE_TOKEN}`, 'content-type': 'application/json' },
      escaped,
    ),
  );
  assert.equal(v3.version, 3);
  assert.match(v3.ok, new RegExp(`\\(#${clip.id}\\)`));

  // Served on its host with review mode, to the board's key alone; never another call's
  const board = await boardOn(host);
  const served = await h.send(`/${v1.id}/`, { host, cookie: board });
  assert.equal(served.status, 200, served.text);
  assert.match(served.text, /Flip me[\s\S]*\/__review\/review\.js/);
  assert.match(String(served.headers['content-security-policy']), /frame-ancestors 'self' https:\/\/hq\.company\.test/);
  // (and nothing from anywhere else loads in it.)
  assert.match(
    String(served.headers['content-security-policy']),
    /^default-src 'self' data: blob: [^;]*; form-action 'self'; /,
  );
  assert.equal((await h.send(`/${v1.id}/`, { host })).status, 403);
  assert.equal(
    (await h.send(`/${v1.id}/`, { host: `call-${call + 1}.preview.company.test`, cookie: board })).status,
    404,
  );
  assert.equal((await h.send(`/${v1.id}/../../etc/passwd`, { host, cookie: board })).status, 404);
  // (the board's review tool there, but no note of its own: its marks go to the call's page)
  assert.doesNotMatch((await h.send('/__review/review.js', { host, cookie: board })).text, /review mode: off/);
  const note = await h.send('/__review/notes', { host, cookie: board, origin: `https://${host}` }, { note: 'x' });
  assert.equal(note.status, 403);

  // The board's mark on it from its iPad: a note of the call's that points, the board's, which the call's own screen
  // hands the line (its event) and the agent hears with its snip; nothing of it on the call's page
  const anchor = { v: 1, url: v1.link, el: null, view: { w: 1180, h: 820, x: 0, y: 0, dpr: 2 }, ink: [], kind: 'pin' };
  const told: any[] = [];
  const deaf = onPublish(e => void (e.type === 'book' && e.text === 'callnote' && told.push(e.note)));
  const unitsBefore = said(await h.board(`/api/notebooks/pages/groups?page=${page}`)).groups.length;
  const mark = said(await h.board('/api/calls/prototype-mark', { url: v1.link, anchor, snip: SNIP }));
  deaf();
  assert.deepEqual(told, [{ id: mark.id, n: 1, page, call }]);
  const heard = said(await h.voice(`note?id=${mark.id}&call=${call}`));
  assert.equal(heard.n, 1);
  assert.equal(heard.by, undefined);
  assert.equal(heard.url, `https://${host}/${v1.id}/`);
  assert.equal(heard.picture.type, 'image/png');
  assert.equal(said(await h.board(`/api/notebooks/pages/groups?page=${page}`)).groups.length, unitsBefore);

  // A colleague's quick job saves one too, from a folder: only one the call queued
  const job = await h.start({ agent: 'lark' });
  const files = { 'index.html': Buffer.from('<img src="pic.svg">').toString('base64'), 'pic.svg': '' };
  const stray = await h.agent('prototype', job.token, { call, name: 'Order flow', files });
  assert.equal(stray.status, 403, JSON.stringify(stray.body));
  assert.match(JSON.stringify(stray.body), /wasn't queued on call #\d+: only the call's own jobs save its prototypes/);
  h.db.prepare('insert into call_jobs (call, job) values (?, ?)').run(call, job.id);
  const made = said(await h.agent('prototype', job.token, { call, name: 'Order flow', files }));
  assert.equal(made.version, 1);
  assert.equal((await h.send(`/${made.id}/pic.svg`, { host, cookie: board })).status, 200);
  // (the call's page as a job reads it, hq sketch: its prototypes by name, as their clips carry none.)
  const sketch = said(await h.agent(`sketch?id=${page}`, job.token));
  assert.deepEqual(
    sketch.prototypes.map((p: any) => [p.name, p.version]),
    [
      ['Order flow', 1],
      ['Flip card', 3],
      ['Flip card', 2],
      ['Flip card', 1],
    ],
  );
  assert.equal(
    (await h.agent('prototype', job.token, { call, name: 'Dotted', files: { '.env': 'eA==', 'index.html': '' } }))
      .status,
    400,
  );

  // The call over: no more, and its mark goes nowhere
  h.db.prepare("update calls set status = 'ended' where id = ?").run(call);
  assert.equal((await h.voice('prototype', { call, name: 'Late', html: PAGE })).status, 404);
  assert.equal((await h.board('/api/calls/prototype-mark', { url: v1.link, anchor, snip: SNIP })).status, 404);
});

test("the call's guest is handed on to its prototypes while the call is live, sees each new one listed, and draws on it as themselves", async () => {
  const { call } = await h.liveCall('juno');
  const pageId = said(await h.board('/api/notebooks/call', { call })).page.id as number;
  const host = `call-${call}.preview.company.test`;
  // (their iPad scans the call's QR code and gives a name)
  const { link } = said(await h.board('/api/calls/guest', { call, lang: 'nl' }));
  const v1 = said(await h.voice('prototype', { call, name: 'Flip card', html: PAGE }));
  const joined = await h.send(new URL(link).pathname, { origin: ORIGIN }, new URLSearchParams({ name: 'Ilse' }));
  assert.equal(joined.status, 303, joined.text);
  const g = cookieOf(joined);
  const notebook = Number(new URL(joined.headers.location, ORIGIN).searchParams.get('notebook'));
  const listed = said(await h.send(`/guest/notebooks/api/list?notebook=${notebook}`, { cookie: g }));
  assert.deepEqual(
    listed.notebooks[0].prototypes.map((p: any) => [p.name, p.version, p.link]),
    [['Flip card', 1, v1.link]],
  );

  // Without a session the host sends them to HQ's sign-in, which hands a guest on through the guest desk
  const onward = await h.send(`/guest/onward?to=${encodeURIComponent(v1.link)}`, { cookie: g });
  assert.equal(onward.status, 302);
  const handOff = new URL(onward.headers.location);
  assert.equal(handOff.host, host);
  const landed = await h.send(handOff.pathname + handOff.search, { host });
  assert.equal(landed.status, 302);
  const ps = cookieOf(landed);
  const check = await h.send('/api/preview/check', { cookie: ps, 'x-forwarded-host': host, 'x-forwarded-uri': '/' });
  assert.equal(check.status, 200);
  const seen = await h.send(`/${v1.id}/`, { host, cookie: ps });
  assert.equal(seen.status, 200, seen.text);
  // Every hand-off is on the call's one visitor share, so a run of them stops at a person's allowance of open links
  const again: number[] = [];
  for (let i = 0; i < 22; i++)
    again.push((await h.send(`/guest/onward?to=${encodeURIComponent(v1.link)}`, { cookie: g })).status);
  assert.deepEqual(again, [...Array(20).fill(302), 404, 404]);
  const shared = h.db.prepare('select count(*) n from review_shares where about = ?').get(`call-${call}`) as {
    n: number;
  };
  assert.equal(shared.n, 1);
  // Review mode there for them too, no note of its own: their pen's mark goes through their room to the call's agent,
  // a note of the call's that points, by their name, and never onto the call's page
  assert.doesNotMatch((await h.send('/__review/review.js', { host, cookie: ps })).text, /review mode: off/);
  assert.equal((await h.send('/__review/tool.js', { host, cookie: ps })).status, 200);
  const note = await h.send('/__review/notes', { host, cookie: ps, origin: `https://${host}` }, { note: 'x' });
  assert.equal(note.status, 403);
  const anchor = { v: 1, url: v1.link, el: null, view: { w: 820, h: 1180, x: 0, y: 0, dpr: 2 }, ink: [], kind: 'pin' };
  const mark = said(
    await h.send(
      '/guest/notebooks/api/prototype-mark',
      { cookie: g, origin: ORIGIN },
      { url: v1.link, anchor, snip: SNIP },
    ),
  );
  const heard = said(await h.voice(`note?id=${mark.id}&call=${call}`));
  assert.equal(heard.by, 'Ilse');
  assert.equal(heard.picture.type, 'image/png');
  const units = said(await h.board(`/api/notebooks/pages/groups?page=${pageId}`)).groups as any[];
  assert.ok(!units.some(u => u.by !== 'juno'), 'nothing of hers on the call’s page');
  // (only on a call of theirs: another call's prototype is no page of theirs)
  const other = (await h.liveCall('juno')).call;
  said(await h.board('/api/notebooks/call', { call: other }));
  const elsewhere = said(await h.voice('prototype', { call: other, name: 'Elsewhere', html: PAGE }));
  assert.equal(
    (
      await h.send(
        '/guest/notebooks/api/prototype-mark',
        { cookie: g, origin: ORIGIN },
        { url: elsewhere.link, anchor, snip: SNIP },
      )
    ).status,
    404,
  );

  // Someone who isn't the call's guest gets nothing; and once the call ends, neither does the guest
  const stranger = await h.send(`/guest/onward?to=${encodeURIComponent(v1.link)}`);
  assert.equal(stranger.headers.location, '/login');
  h.db.prepare("update calls set status = 'ended' where id = ?").run(call);
  assert.equal((await h.send(`/${v1.id}/`, { host, cookie: ps })).status, 403);
  assert.equal((await h.send('/__review/review.js', { host, cookie: ps })).status, 403);
  const late = await h.send(
    '/guest/notebooks/api/prototype-mark',
    { cookie: g, origin: ORIGIN },
    { url: v1.link, anchor, snip: SNIP },
  );
  assert.notEqual(late.status, 200);
});

test("a prototype's picture is its markup and CSS, script off in every frame; one that can't be taken saves nothing and says why", async () => {
  const { call } = await h.liveCall('juno');
  said(await h.board('/api/notebooks/call', { call }));
  const turnsRed = "<body style='background:#fff'><script>document.body.style.background='#f00'</script>";
  // (a sandboxed frame that may run script is Chromium's to put in a renderer of its own, out of the tab's reach)
  const frame = `<iframe sandbox="allow-scripts" srcdoc="${turnsRed}" style="position:fixed;left:400px;top:0;width:400px;height:400px;border:0"></iframe>`;
  const red = `<!doctype html>${turnsRed}${frame}`;
  const shown = said(await h.voice('prototype', { call, name: 'Red', html: red }));
  const picture = sharp(Buffer.from(shown.picture.data, 'base64'));
  // (a point in the page's pixels, the frame's 400 to 800 across, in the answer's smaller picture of it: the page is
  // 1180 wide, callprototypes.ts SEEN.)
  const scale = (await picture.metadata()).width! / 1180;
  for (const [x, what] of [
    [200, 'the page'],
    [600, 'its sandboxed frame'],
  ] as const) {
    const at = { left: Math.round(x * scale), top: Math.round(200 * scale), width: 1, height: 1 };
    const [r, g, b] = await picture.clone().extract(at).raw().toBuffer();
    assert.ok(r > 240 && g > 240 && b > 240, `${what} white, not the script's red: ${[r, g, b]}`);
  }

  const kept = () => h.db.prepare('select count(*) n from call_prototypes where call = ?').get(call);
  const before = kept();
  const chromium = process.env.CHROMIUM_PATH;
  process.env.CHROMIUM_PATH = '/nonexistent/chromium';
  try {
    const failed = await h.voice('prototype', { call, name: 'Red', html: red });
    assert.equal(failed.status, 409, JSON.stringify(failed.body));
    assert.match(JSON.stringify(failed.body), /its picture couldn't be taken, so it isn't saved: \w/);
  } finally {
    process.env.CHROMIUM_PATH = chromium;
  }
  assert.deepEqual(kept(), before);
  // (saved again, it's the next version as if the failed one never was)
  assert.equal(said(await h.voice('prototype', { call, name: 'Red', html: red })).version, 2);
});

test("a prototype built from a brief is a colleague's try run: a placeholder at once, steered as it builds, landing only with the picture it was looked at in", async () => {
  const { call, token } = await h.liveCall('juno');
  const page = said(await h.board('/api/notebooks/call', { call })).page.id as number;
  const groups = async () => said(await h.board(`/api/notebooks/pages/groups?page=${page}`)).groups as any[];
  const lines = async () => said(await h.voice('call-lines', { agent: 'juno', token })).built as any[];

  // The brief: a job for the builder named, at once, and its placeholder on the page with their face
  const built = said(
    await h.voice('prototype-build', {
      call,
      name: 'Poster',
      brief: 'One still poster of two layers',
      by: 'moss',
      lang: 'nl',
      effort: 'low',
    }),
  );
  assert.match(built.ok, new RegExp(`Moss builds Poster v1 as job #${built.job}`));
  const row = h.db
    .prepare('select agent, kind, expedite, effort, thread, prompt from jobs where id = ?')
    .get(built.job) as any;
  assert.deepEqual([row.agent, row.kind, row.expedite, row.effort, row.thread], ['moss', 'try', 1, 'low', null]);
  assert.match(row.prompt, /Its words in Dutch\./);
  assert.match(row.prompt, /--picture <png>/);
  assert.ok(h.db.prepare('select 1 from call_jobs where call = ? and job = ?').get(call, built.job));
  const placeholder = (await groups()).find(g => g.try?.build);
  assert.ok(placeholder, 'its placeholder is on the page');
  assert.deepEqual([placeholder.try.state, placeholder.try.by, placeholder.try.build.version], ['coming', 'moss', 1]);
  assert.equal(placeholder.try.expect, 1, 'one frame coming');
  assert.deepEqual(await lines(), []);
  // (only a Claude colleague builds one: what they say while it's built reaches a Claude session alone)
  const codex = await h.voice('prototype-build', { call, name: 'Other', brief: 'Anything', by: 'nib' });
  assert.equal(codex.status, 409, JSON.stringify(codex.body));

  // Another brief under its name goes to it: in its brief while it waits, as a message once it runs
  const early = said(await h.voice('prototype-build', { call, name: 'poster', brief: 'People in the circle' }));
  assert.equal(early.job, built.job);
  assert.match(
    (h.db.prepare('select prompt from jobs where id = ?').get(built.job) as any).prompt,
    /People in the circle/,
  );
  const job = await h.claimJob(built.job);
  // (a Claude run, as the builder's is: the harness claims on an engine of its own)
  h.db.prepare("update jobs set engine = 'claude' where id = ?").run(built.job);
  said(await h.voice('prototype-build', { call, name: 'Poster', brief: 'And the ads round them' }));
  assert.ok(
    h.db.prepare("select 1 from messages where job = ? and instr(text, 'And the ads round them') > 0").get(built.job),
  );

  // It lands only with the picture it was looked at in, under its own name, in its placeholder
  const files = { 'index.html': Buffer.from('<svg></svg>').toString('base64') };
  const looked = (
    await sharp({ create: { width: 1180, height: 820, channels: 3, background: '#e33' } })
      .png()
      .toBuffer()
  ).toString('base64');
  assert.equal((await h.agent('prototype', job.token, { call, name: 'Poster', files })).status, 400);
  assert.equal((await h.agent('prototype', job.token, { call, name: 'Other', files, picture: looked })).status, 409);
  const v1 = said(await h.agent('prototype', job.token, { call, name: 'poster', files, picture: looked }));
  assert.equal(v1.version, 1);
  assert.equal((await h.agent('prototype', job.token, { call, name: 'Poster', files, picture: looked })).status, 409);
  const clip = (await groups()).find(g => g.id === placeholder.id);
  assert.deepEqual(
    clip.children.filter((c: any) => c.style === 'version').map((v: any) => v.version),
    ['v1'],
  );
  // (its picture is the one it was looked at in: red, script and all, never HQ's own with script off)
  const slip = h.db.prepare('select picture from book_slips where id = ?').get(clip.children[0].id) as {
    picture: string;
  };
  const { DIR: BOOK } = await import('./pagescraps.ts');
  const { dominant } = await sharp(`${BOOK}/${slip.picture}`).stats();
  assert.deepEqual([dominant.r > 200, dominant.g < 80], [true, true], JSON.stringify(dominant));

  // The line hears it once it ended: its version, and the builder's line on what to try first
  await h.finish(job, { status: 'done', result: 'Done.\nTik eerst op de kring.' });
  assert.deepEqual(
    (await lines()).map(b => [b.name, b.version, b.by, b.line, b.failed]),
    [['Poster', 1, 'Moss', 'Tik eerst op de kring.', undefined]],
  );
  assert.deepEqual(await lines(), []);

  // The next version builds on it, its page in the brief; one that ends with none is heard with why
  const next = said(await h.voice('prototype-build', { call, name: 'Poster', brief: 'Calmer', about: 'Less text' }));
  assert.match(next.ok, /Poster v2/);
  assert.match(
    (h.db.prepare('select prompt from jobs where id = ?').get(next.job) as any).prompt,
    /The version before \(v1\)[^]*<svg><\/svg>/,
  );
  // (its save command quotes what it's given, as one shell word each)
  assert.match(
    (h.db.prepare('select prompt from jobs where id = ?').get(next.job) as any).prompt,
    /hq prototype --call \d+ 'Poster' <folder> --picture <png> --about 'Less text'/,
  );
  // (one frame coming beside v1 in its group: one build is one version)
  assert.equal((await groups()).find(g => g.id === placeholder.id).try.expect, 2);
  const second = await h.claimJob(next.job);
  await h.finish(second, { status: 'done', result: 'De kring bleef leeg in de schermfoto, dus niet opgeslagen.' });
  assert.deepEqual(
    (await lines()).map(b => [b.name, b.version, b.failed]),
    [['Poster', 2, 'De kring bleef leeg in de schermfoto, dus niet opgeslagen.']],
  );
  // (its clip gone from the page, the next one starts a group of its own, with one frame coming in it)
  h.db.prepare('update notebook_groups set deleted = 1 where id = ?').run(placeholder.id);
  const third = said(
    await h.voice('prototype-build', { call, name: 'Poster', brief: 'Again', about: `Kid's "poster" $HOME` }),
  );
  assert.match(
    (h.db.prepare('select prompt from jobs where id = ?').get(third.job) as any).prompt,
    /--about 'Kid'\\''s "poster" \$HOME'/,
  );
  const fresh = (await groups()).find(g => g.try?.build?.version === 2);
  assert.deepEqual([fresh.id !== placeholder.id, fresh.try.expect], [true, 1]);
  await h.finish(await h.claimJob(third.job), { status: 'done', result: 'Niet opgeslagen.' });
  await lines();

  // None while the board has left the call to its guest, new or steering one going: a build is a colleague's job
  const late = said(await h.voice('prototype-build', { call, name: 'Late', brief: 'Anything' }));
  const prompt = () => (h.db.prepare('select prompt from jobs where id = ?').get(late.job) as any).prompt;
  const briefed = prompt();
  said(await h.voice('call-away', { agent: 'juno', token, away: true }));
  assert.equal((await h.voice('prototype-build', { call, name: 'Guest', brief: 'Anything' })).status, 409);
  assert.equal((await h.voice('prototype-build', { call, name: 'Late', brief: 'Louder' })).status, 409);
  assert.equal(prompt(), briefed);
  said(await h.voice('call-away', { agent: 'juno', token, away: false }));
  // (back with the board, the same words do reach it)
  said(await h.voice('prototype-build', { call, name: 'Late', brief: 'Louder' }));
  assert.match(prompt(), /Louder/);

  // The call's end stops a build still going
  said(await h.voice('call-end', { agent: 'juno', token, lines: ['Board: bye'] }));
  assert.equal((h.db.prepare('select status from jobs where id = ?').get(late.job) as any).status, 'cancelled');
});

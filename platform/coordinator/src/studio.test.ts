// node --test src/studio.test.ts   (the photo studio: the test company, HQ's real server, the real hq, a local Google)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { pictureSize } from '../../../shared/pictures/size.ts';
import { isAiEdited } from '../../../shared/provenance/provenance.ts';
import { harness, until } from './harness.ts';

// A local server playing Google's Interactions endpoint: what each request asked, and the answer it gets ('drop': the
// connection cut once it has the request), once held is over
const google = {
  asked: [] as any[],
  key: '',
  held: null as Promise<void> | null,
  answer: (): [number, unknown] | 'drop' => [
    200,
    {
      steps: [
        {
          type: 'model_output',
          content: [{ type: 'image', mime_type: 'image/jpeg', data: EDITED.toString('base64') }],
        },
      ],
    },
  ],
};
const pictureBack = google.answer;
const playGoogle = createServer((req, res) => {
  let raw = '';
  req.on('data', c => (raw += c));
  req.on('end', async () => {
    google.asked.push(JSON.parse(raw));
    google.key = String(req.headers['x-goog-api-key']);
    await google.held;
    const answer = google.answer();
    if (answer === 'drop') return req.socket.destroy();
    const [status, body] = answer;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
}).listen(0);
await new Promise(r => playGoogle.once('listening', r));
test.after(() => playGoogle.close());

const h = await harness('studio', {
  env: {
    STUDIO_WATCH_MS: '100',
    STUDIO_MODEL_URL: `http://localhost:${(playGoogle.address() as AddressInfo).port}/v1beta/interactions`,
  },
});
const { ORIGIN } = await import('./config.ts');
(await import('./studio.ts')).watch(); // (as the coordinator starts it)

// 8 × 8 JPEGs made with ImageMagick: the board's photo (with a pretend GPS Exif segment put in), and the model's edit
const PHOTO = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAIAAgDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAABv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AB4iU6//2Q==',
  'base64',
);
const EDITED = Buffer.concat([PHOTO.subarray(0, 2), PHOTO.subarray(2)]);
const GPS = Buffer.concat([
  Buffer.from([0xff, 0xe1, 0x00, 0x1e]),
  Buffer.from('Exif\0\0GPSLatitude 52.3676 N\0', 'latin1'),
]);
const FROM_PHONE = Buffer.concat([PHOTO.subarray(0, 2), GPS, PHOTO.subarray(2)]);

const brandFile = `${h.repo}/company/brand.yaml`,
  brandBefore = readFileSync(brandFile, 'utf8');
const turnOn = (cap = 1) =>
  writeFileSync(
    brandFile,
    `${brandBefore}
studio:
  keeper: moss
  monthly_usd: ${cap}
  notes: [knowledge/notes/photos.md]
  products:
    - { id: mug, name: The mug, about: "A white ceramic mug with the buyer's name printed on it." }
  styles:
    - { id: white, name: Clean white, prompt: "On a seamless white backdrop with soft light from the left.", ratio: '1:1' }
    - { id: table, name: On a table, prompt: "On a wooden kitchen table in soft daylight.", ratio: '4:3' }
  fixes:
    - { id: hand, name: The hand out, prompt: "Take out the hand holding the tape measure, and fill what it hid with what is plainly there." }
`,
  );
const saveKey = () =>
  writeFileSync(`${h.dataDir}/secrets/STUDIO_GEMINI_API_KEY`, 'AQ.test-key-for-the-studio-0123456789');

// A photo into the studio as the crew brings one in: a page's owner asks for it (hq studio request, once per product
// while its request is open), and the board's product shot on a desk-phone card is added for it by the card's asker
// (hq studio add). The board never adds one itself.
let asker: Awaited<ReturnType<typeof h.start>> | undefined, pageOwner: typeof asker;
const PAGE = 'https://shop.example/mug',
  CHECKS = ['The name reads Ada, every letter', 'The handle on the right'];
const askedFor = new Map<string, number>();
async function requestFor(product: string) {
  const open = askedFor.get(product);
  if (open && (h.db.prepare('select status from studio_requests where id = ?').get(open) as any).status === 'open')
    return { status: 200, id: open };
  pageOwner ??= await h.start({ agent: 'kit' });
  const asked = await h.agent('studio/request', pageOwner.token, {
    product,
    show: 'The mug from the side its name is printed on',
    pages: [PAGE],
  });
  if (asked.status === 200) askedFor.set(product, asked.body.id);
  return { status: asked.status, id: asked.body?.id };
}
async function bringIn(picture: Buffer, query: string) {
  const q = new URLSearchParams(query);
  const request = await requestFor(String(q.get('product')));
  if (request.status !== 200) return { status: request.status, json: { id: undefined } };
  asker ??= await h.start({ agent: 'dex' });
  const card = await h.ask(asker, {
    kind: 'action',
    title: 'Photos of the test print',
    photos: [{ label: 'The shot', shot: 'product' }],
  });
  const put = await h.send(
    `/api/requests/photo?id=${card}&field=0`,
    { cookie: h.boardCookie, origin: ORIGIN, 'content-type': 'image/jpeg' },
    picture,
  );
  assert.equal(put.status, 200);
  const added = await h.agent('studio/add', asker.token, {
    card,
    request: request.id,
    style: q.get('style'),
    note: q.get('note') ?? undefined,
  });
  return { status: added.status, json: { id: added.body?.ids?.[0] } };
}
const listed = async () => (await h.board('/api/studio')).body;
// the photos as the board's page shows them: each with its edit now
const asShown = (...ids: number[]) =>
  ids.map(id => ({ id, edit: (h.db.prepare('select edit from studio_photos where id = ?').get(id) as any)?.edit }));
const studioJobs = () =>
  h.db
    .prepare(
      `select id, title, prompt from jobs where agent = 'moss' and status = 'queued' and title like 'Studio:%'
      and title not like '%asked for'`,
    )
    .all() as { id: number; title: string; prompt: string }[];
const joined = (job: number) =>
  (h.db.prepare('select count(*) as n from studio_photos where develop_job = ?').get(job) as { n: number }).n;

test('off without studio settings: no app, no darkroom, no routes', async () => {
  assert.equal((await h.board('/api/brand')).body.studio, false);
  assert.equal((await h.board('/api/org')).body.studio, null);
  assert.equal((await h.board('/api/studio')).status, 404);
});

test("a photo goes from the crew's card through the keeper's edit to the board's approval, and only then out", async () => {
  turnOn();
  const keeper = await h.start({ agent: 'moss' }),
    other = await h.start({ agent: 'dex' });
  assert.equal((await h.board('/api/brand')).body.studio, true);

  // the crew adds two photos, stripped of their Exif: they wait for the model's key, then make one job for the keeper
  const first = await bringIn(FROM_PHONE, 'product=mug&style=white&note=the%20side%20with%20the%20name');
  assert.equal(first.status, 200);
  await bringIn(PHOTO, 'product=mug&style=white');
  assert.equal((await bringIn(PHOTO, 'product=teapot&style=white')).status, 400);
  const id = first.json.id;
  const original = await h.agent(`studio/picture?id=${id}&which=original`, keeper.token);
  assert.deepEqual(Buffer.from(original.body.data, 'base64'), PHOTO);
  assert.equal((await h.agent(`studio/picture?id=${id}&which=original`, other.token)).status, 403);
  assert.equal((await h.agent('studio/edit', keeper.token, { id })).status, 409);
  assert.equal((await listed()).key, false);
  assert.deepEqual(studioJobs(), []);
  await h.ask(other, { kind: 'credential', title: "The studio's key", secrets: 'STUDIO_GEMINI_API_KEY' }); // (a card may ask for it)
  saveKey();
  await until(() => studioJobs().length, "the keeper's job, once the key is in");
  assert.equal(joined(studioJobs()[0].id), 2);
  await bringIn(PHOTO, 'product=mug&style=white');
  assert.equal(studioJobs().length, 1);
  assert.equal(joined(studioJobs()[0].id), 3);
  assert.equal((await h.agent('studio/edit', other.token, { id })).status, 403);
  // (a fix or style the settings don't have is refused before the model; company: job #14307)
  assert.equal((await h.agent('studio/edit', keeper.token, { id, fixes: ['glow'] })).status, 400);
  assert.equal((await h.agent('studio/edit', keeper.token, { id, style: 'beach' })).status, 400);
  const edited = await h.agent('studio/edit', keeper.token, {
    id,
    note: 'keep the handle on the right',
    fixes: ['hand'],
    text: 'Ada / since 2026',
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const asked = google.asked.at(-1),
    [words, picture] = asked.input;
  assert.equal(google.key, 'AQ.test-key-for-the-studio-0123456789');
  assert.equal(asked.model, 'gemini-nano-banana-2.1');
  assert.equal(asked.store, false);
  assert.deepEqual(asked.response_format, {
    type: 'image',
    mime_type: 'image/jpeg',
    image_size: '2K',
    aspect_ratio: '1:1',
  });
  assert.deepEqual(Buffer.from(picture.data, 'base64'), PHOTO);
  for (const said of [
    'exactly as it is',
    "the buyer's name",
    'seamless white',
    'the side with the name',
    'keep the handle on the right',
    'Take out the hand holding the tape measure',
    'reads exactly as follows, character for character (" / " marks a new line): Ada / since 2026.',
  ])
    assert.ok(words.text.includes(said), said);
  const file = Buffer.from(edited.body.data, 'base64');
  assert.ok(isAiEdited(file), 'the edit carries the AI-edit mark');

  // not usable until the board approves it
  assert.equal((await h.agent(`studio/picture?id=${id}&which=approved`, other.token)).status, 403);
  assert.equal((await h.agent('studio/ready', keeper.token, { ids: [id], checks: CHECKS })).body.waiting, 1);
  const waiting = (await listed()).photos.find((p: any) => p.id === id);
  assert.equal(waiting.status, 'waiting');
  // (the board sees the page it goes on, what it must show and what to check; never the crew's style or notes)
  assert.deepEqual(waiting.request, {
    id: askedFor.get('mug'),
    pages: [PAGE],
    where: null,
    show: 'The mug from the side its name is printed on',
  });
  assert.deepEqual(waiting.checks, CHECKS);
  for (const crews of ['style', 'note', 'error']) assert.equal(waiting[crews], undefined, crews);
  assert.equal((await h.board('/api/org')).body.studio.waiting, 1);
  const shown = await h.send(`/api/studio/edited?id=${id}&edit=${waiting.edit}`, { cookie: h.boardCookie });
  assert.equal(shown.status, 200);

  // a photo it doesn't have refuses the whole decision: all or nothing
  assert.equal((await h.board('/api/studio/decide', { photos: asShown(id, 999), decision: 'approved' })).status, 409);
  assert.equal((await listed()).photos.find((p: any) => p.id === id).status, 'waiting');
  assert.deepEqual((await h.board('/api/studio/decide', { photos: asShown(id), decision: 'approved' })).body, {
    decided: 1,
  });
  const out = await h.agent(`studio/picture?id=${id}&which=approved`, other.token);
  assert.equal(out.status, 200);
  assert.deepEqual(Buffer.from(out.body.data, 'base64'), file);
  assert.equal(out.body.approved.by, 'board');
  const [decision] = (await h.agent('studio/record', other.token)).body.decisions;
  assert.equal(decision.decision, 'approved');
  assert.equal(decision.sha256, createHash('sha256').update(file).digest('hex'));
  const place = studioJobs().find(j => /approved photo to place/.test(j.title));
  assert.ok(place, 'the keeper gets a job to place it');

  // withdrawn: no longer out, still in the record, and the keeper takes the copies its placing job put out down
  assert.deepEqual((await h.board('/api/studio/decide', { photos: asShown(id), decision: 'withdrawn' })).body, {
    decided: 1,
  });
  assert.equal((await h.agent(`studio/picture?id=${id}&which=approved`, other.token)).status, 403);
  assert.equal((await h.agent('studio/record', other.token)).body.decisions.length, 2);
  const placedBy = (h.db.prepare('select place_job from studio_photos where id = ?').get(id) as { place_job: number })
    .place_job;
  const down = studioJobs().find(j => /withdrawn photo to take down/.test(j.title));
  assert.ok(down, 'the keeper gets a job to take it down');
  assert.match(down.prompt, new RegExp(`#${id}: .*its placing job was #${placedBy}`));
});

test("the board's Reject is recorded and goes back to the keeper with what to put right; a model's refusal fails the photo, unbilled", async () => {
  const keeper = await h.start({ agent: 'moss' });
  const { id } = (await bringIn(PHOTO, 'product=mug&style=white')).json;
  await h.agent('studio/edit', keeper.token, { id });
  await h.agent('studio/ready', keeper.token, { ids: [id], checks: CHECKS });
  // only through Reject, on the edit the board saw: there is no plain send-back, and no Reject of an older edit
  assert.equal((await h.board('/api/studio/retry', { id, note: 'x' })).status, 404);
  const seen = asShown(id)[0];
  assert.equal((await h.board('/api/studio/reject', { photo: { id, edit: seen.edit - 1 }, note: 'x' })).status, 409);
  assert.deepEqual((await h.board('/api/studio/reject', { photo: seen, note: 'the mug is too blue' })).body, {
    ok: true,
  });
  assert.ok(studioJobs().some(j => j.prompt.includes('the mug is too blue')));
  const rejected = (await h.agent('studio/record', keeper.token)).body.decisions.filter((d: any) => d.photo === id);
  assert.deepEqual(
    rejected.map((d: any) => [d.decision, d.by]),
    [['declined', 'board']],
  );
  google.answer = () => [400, { error: { message: 'Image could not be edited' } }];
  const before = (await listed()).month.usd,
    refused = await h.agent('studio/edit', keeper.token, { id });
  assert.equal(refused.status, 502);
  assert.match(google.asked.at(-1).input[0].text, /Put this right from the last try: the mug is too blue/);
  // (failed, the keeper's to edit again: the board never sees it)
  assert.equal(
    (await listed()).photos.find((p: any) => p.id === id),
    undefined,
  );
  const failed = (await h.agent('studio', keeper.token)).body.photos.find((p: any) => p.id === id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Image could not be edited/);
  assert.equal((await listed()).month.usd, before);
});

test("the board's comment goes back whole, however long, its paragraphs kept", async () => {
  const keeper = await h.start({ agent: 'moss' });
  google.answer = pictureBack;
  const { id } = (await bringIn(PHOTO, 'product=mug&style=white')).json;
  await h.agent('studio/edit', keeper.token, { id });
  await h.agent('studio/ready', keeper.token, { ids: [id], checks: CHECKS });
  const seen = asShown(id)[0],
    paragraph = 'The rim looks creased where the light falls, and there is a smudge by the handle. '.repeat(70).trim();
  const note = `${paragraph}\r\n\r\n\r\n${paragraph}\n  (and a pin, not a nail)  `;
  assert.equal((await h.board('/api/studio/reject', { photo: seen, note })).status, 200);
  const kept = `${paragraph}\n\n${paragraph}\n(and a pin, not a nail)`;
  assert.ok(kept.length > 10_000, 'a multi-paragraph comment of over 10,000 characters');
  assert.ok(
    studioJobs().some(j => j.prompt.includes(kept)),
    "the keeper's brief has it whole",
  );
  await h.agent('studio/edit', keeper.token, { id });
  assert.ok(google.asked.at(-1).input[0].text.includes(`Put this right from the last try: ${kept}`), 'and the model');
});

test("the month's cap stops edits before they reach the model", async () => {
  const keeper = await h.start({ agent: 'moss' });
  turnOn(0.01);
  const { id } = (await bringIn(PHOTO, 'product=mug&style=white')).json,
    calls = google.asked.length;
  const capped = await h.agent('studio/edit', keeper.token, { id });
  assert.equal(capped.status, 429);
  assert.equal(google.asked.length, calls);
});

test('an edit cut off in the model is asked for once and counted as billed; edits still in the model count against the cap', async t => {
  const keeper = await h.start({ agent: 'moss' });
  turnOn(5);
  const dropped = (await bringIn(PHOTO, 'product=mug&style=white')).json.id,
    calls = google.asked.length;
  google.answer = () => 'drop';
  assert.equal((await h.agent('studio/edit', keeper.token, { id: dropped })).status, 502);
  google.answer = pictureBack;
  assert.equal(google.asked.length, calls + 1);
  const [cut] = h.db.prepare('select usd from studio_edits where photo = ?').all(dropped) as { usd: number }[];
  assert.ok(cut.usd > 0, 'billed: the model may have made it');

  // room under the cap for one edit more: a second one while the first is in the model is refused before it
  const month = (await h.agent('studio', keeper.token)).body.month;
  turnOn(month.usd + 1.5 * cut.usd);
  const a = (await bringIn(PHOTO, 'product=mug&style=white')).json.id,
    b = (await bringIn(PHOTO, 'product=mug&style=white')).json.id;
  let release = () => {};
  google.held = new Promise(r => (release = r));
  t.after(() => {
    release();
    google.held = null;
  });
  const first = h.agent('studio/edit', keeper.token, { id: a });
  await until(() => google.asked.length === calls + 2, 'the first edit in the model');
  assert.equal((await h.agent('studio/edit', keeper.token, { id: b })).status, 429);
  release();
  assert.equal((await first).status, 200);
  assert.equal(google.asked.length, calls + 2);
});

test('hq studio lists the photos and saves an approved one for any agent', async () => {
  turnOn();
  google.answer = () => [
    200,
    {
      steps: [
        {
          type: 'model_output',
          content: [{ type: 'image', mime_type: 'image/jpeg', data: EDITED.toString('base64') }],
        },
      ],
    },
  ];
  const keeper = await h.start({ agent: 'moss' }),
    other = await h.start({ agent: 'dex' });
  const { id } = (await bringIn(PHOTO, 'product=mug&style=white')).json;
  const tmp = h.dataDir;
  const edit = await h.hq({ ...keeper, tmp }, 'studio', 'edit', String(id));
  assert.equal(edit.code, 0, edit.out);
  assert.match((await h.hq(keeper, 'studio')).out, new RegExp(`#${id}\\s+edited`));
  assert.notEqual((await h.hq({ ...keeper, tmp }, 'studio', 'ready', String(id))).code, 0); // (what to check, it must say)
  assert.equal((await h.hq({ ...keeper, tmp }, 'studio', 'ready', String(id), '--check', CHECKS[0])).code, 0);
  const refused = await h.hq({ ...other, tmp }, 'studio', 'get', String(id));
  assert.notEqual(refused.code, 0);
  await h.board('/api/studio/decide', { photos: asShown(id), decision: 'approved' });
  const got = await h.hq({ ...other, tmp }, 'studio', 'get', String(id));
  assert.equal(got.code, 0, got.out);
  const path = got.out.match(/→ (\S+)/)![1];
  assert.ok(isAiEdited(readFileSync(path)));
});

test('a photo nobody finishes stays with the crew: dropped by the keeper with why, or back to the keeper once when its job ended', async () => {
  turnOn(5);
  google.answer = pictureBack;
  const keeper = await h.start({ agent: 'moss' }),
    other = await h.start({ agent: 'dex' });
  const photoOf = (id: number) =>
    h.db.prepare('select status, error, develop_job from studio_photos where id = ?').get(id) as {
      status: string;
      error: string | null;
      develop_job: number;
    };
  const end = (job: number, status: string) => h.db.prepare('update jobs set status = ? where id = ?').run(status, job);
  const ticks = () => new Promise(r => setTimeout(r, 400)); // (watch runs every 100 ms here)
  const onBoard = async (id: number) => (await listed()).photos.some((p: any) => p.id === id);

  // the keeper drops one, with why: kept in the record, the board never sees it, and its request stays open
  const stopped = (await bringIn(PHOTO, 'product=mug&style=white')).json.id;
  await h.agent('studio/edit', keeper.token, { id: stopped });
  assert.equal((await h.agent('studio/stop', keeper.token, { id: stopped, why: ' ' })).status, 400);
  assert.equal((await h.agent('studio/stop', other.token, { id: stopped, why: 'no' })).status, 403);
  const why = 'The model redraws the letters on the mug every time';
  assert.deepEqual((await h.agent('studio/stop', keeper.token, { id: stopped, why })).body, { ok: true });
  assert.deepEqual(photoOf(stopped).status, 'stopped');
  assert.equal(photoOf(stopped).error, why);
  assert.equal(await onBoard(stopped), false);
  assert.ok(!(await h.agent('studio', keeper.token)).body.photos.some((p: any) => p.id === stopped));
  assert.equal((await h.agent('studio/edit', keeper.token, { id: stopped })).status, 409);
  assert.equal(
    (h.db.prepare('select status from studio_requests where id = ?').get(askedFor.get('mug')!) as any).status,
    'open',
  );

  // one its job never got to: back to the keeper in a new job once that job ends, and dropped the next time
  const untouched = (await bringIn(PHOTO, 'product=mug&style=white')).json.id;
  const queued = photoOf(untouched).develop_job;
  assert.ok(queued, 'a job has it');
  await ticks();
  assert.equal(photoOf(untouched).status, 'new');
  end(queued, 'cancelled');
  await until(() => photoOf(untouched).develop_job && photoOf(untouched).develop_job !== queued, 'a new job for it');
  assert.equal(photoOf(untouched).status, 'new');
  assert.equal(photoOf(untouched).error, 'Its last developing job ended before it was done');
  end(photoOf(untouched).develop_job, 'cancelled');
  await until(() => photoOf(untouched).status === 'stopped', 'dropped the second time');
  assert.equal(await onBoard(untouched), false);

  // an edit belongs to the job that made it: the keeper's running job keeps it, its end hands it back to the keeper
  const edited = (await bringIn(PHOTO, 'product=mug&style=white')).json.id,
    first = photoOf(edited).develop_job;
  await h.agent('studio/edit', keeper.token, { id: edited });
  assert.equal(photoOf(edited).develop_job, keeper.id);
  end(first, 'cancelled');
  await ticks();
  assert.equal(photoOf(edited).status, 'edited');
  end(keeper.id, 'done');
  await until(() => photoOf(edited).status === 'new', 'back to the keeper once its job is done');
  assert.equal(await onBoard(edited), true); // (in the darkroom, which the board's Queue shows, read-only)
});

test("a withdrawal stays in its take-down job whatever becomes of the photo after; the edit cap counts from the board's last Reject", async () => {
  turnOn(5);
  google.answer = pictureBack;
  const keeper = await h.start({ agent: 'moss' });
  const approved = async () => {
    const { id } = (await bringIn(PHOTO, 'product=mug&style=white')).json;
    await h.agent('studio/edit', keeper.token, { id });
    await h.agent('studio/ready', keeper.token, { ids: [id], checks: CHECKS });
    await h.board('/api/studio/decide', { photos: asShown(id), decision: 'approved' });
    return {
      id,
      placedBy: (h.db.prepare('select place_job from studio_photos where id = ?').get(id) as any).place_job,
    };
  };
  const a = await approved(),
    b = await approved();
  assert.deepEqual((await h.board('/api/studio/change', { photo: asShown(a.id)[0], note: 'brighter' })).body, {
    ok: true,
  });
  await h.board('/api/studio/decide', { photos: asShown(b.id), decision: 'withdrawn' });
  const down = studioJobs().filter(j => /withdrawn photos? to take down/.test(j.title));
  assert.equal(down.length, 1);
  for (const { id, placedBy } of [a, b])
    assert.match(down[0].prompt, new RegExp(`#${id}: .*its placing job was #${placedBy}`), `#${id} stays in it`);

  // a: back with the keeper after the board's "this should change"; the cap is 8 edits each time the board sends it
  for (let i = 0; i < 8; i++) assert.equal((await h.agent('studio/edit', keeper.token, { id: a.id })).status, 200);
  assert.equal((await h.agent('studio/edit', keeper.token, { id: a.id })).status, 429);
  await h.agent('studio/ready', keeper.token, { ids: [a.id], checks: CHECKS });
  await h.board('/api/studio/reject', { photo: asShown(a.id)[0], note: 'leave the handle as it is' });
  assert.equal((await h.agent('studio/edit', keeper.token, { id: a.id })).status, 200);
  assert.equal((await listed()).photos.find((p: any) => p.id === a.id).tries, 10); // (the board still sees every try)
});

test('the board decides on the edit it was shown: a newer one since refuses it, and each edit has its own address', async () => {
  turnOn(5);
  google.answer = pictureBack;
  const keeper = await h.start({ agent: 'moss' });
  const { id } = (await bringIn(PHOTO, 'product=mug&style=white')).json;
  await h.agent('studio/edit', keeper.token, { id });
  await h.agent('studio/ready', keeper.token, { ids: [id], checks: CHECKS });
  const seen = asShown(id),
    first = seen[0].edit;
  const picture = (edit: number) => h.send(`/api/studio/edited?id=${id}&edit=${edit}`, { cookie: h.boardCookie });
  assert.equal((await picture(first)).status, 200);

  // the keeper edits it again and readies the new edit while the board's page still shows the first
  await h.agent('studio/edit', keeper.token, { id });
  await h.agent('studio/ready', keeper.token, { ids: [id], checks: CHECKS });
  const second = asShown(id)[0].edit;
  assert.notEqual(second, first);
  const decisions = () => (h.db.prepare('select count(*) as n from studio_decisions where photo = ?').get(id) as any).n;
  const stale = await h.board('/api/studio/decide', { photos: seen, decision: 'approved' });
  assert.equal(stale.status, 409);
  assert.equal(decisions(), 0);
  assert.equal((await listed()).photos.find((p: any) => p.id === id).status, 'waiting');
  assert.equal((await picture(first)).status, 404); // (not the photo's edit any more, and never decided on)
  assert.equal((await picture(second)).status, 200);

  // taken back to the darkroom (edited again, not ready yet): refused too, not passed over
  await h.agent('studio/edit', keeper.token, { id });
  const latest = asShown(id);
  assert.equal((await h.board('/api/studio/decide', { photos: latest, decision: 'approved' })).status, 409);
  assert.equal(decisions(), 0);
  await h.agent('studio/ready', keeper.token, { ids: [id], checks: CHECKS });

  // the edit it shows now is the one decided on, and its address stays
  assert.deepEqual((await h.board('/api/studio/decide', { photos: latest, decision: 'approved' })).body, {
    decided: 1,
  });
  assert.equal((h.db.prepare('select edit from studio_decisions where photo = ?').get(id) as any).edit, latest[0].edit);
  assert.equal((await picture(latest[0].edit!)).status, 200);
  // decided already (on another device): refused, and nothing more recorded
  assert.equal((await h.board('/api/studio/decide', { photos: latest, decision: 'approved' })).status, 409);
  assert.equal(decisions(), 1);

  // behind any number of newer photos the board has declined, it stays on the board's list (they never show)
  const add = h.db.prepare(
    `insert into studio_photos (created, added_by, product, style, status, type) values ('2026-10-18', 'board', 'mug', 'white', 'declined', 'image/jpeg')`,
  );
  for (let i = 0; i < 301; i++) add.run();
  const photos = (await listed()).photos;
  assert.equal(photos.find((p: any) => p.id === id)?.status, 'approved');
  assert.ok(!photos.some((p: any) => p.status === 'declined'));
});

test("a desk-phone card's product shots join the studio for an open request: for whoever asked the card, and for the keeper; never a check photo", async () => {
  turnOn(5);
  const dex = await h.start({ agent: 'dex' }),
    keeper = await h.start({ agent: 'moss' }),
    kit = await h.start({ agent: 'kit' });
  const card = await h.ask(dex, {
    kind: 'action',
    title: 'Photos of the test print',
    photos: [{ label: 'The mug, front', shot: 'product' }, { label: 'The mug beside a ruler' }],
  });
  for (const field of [0, 1]) {
    const put = await h.send(
      `/api/requests/photo?id=${card}&field=${field}`,
      { cookie: h.boardCookie, origin: ORIGIN, 'content-type': 'image/jpeg' },
      FROM_PHONE,
    );
    assert.equal(put.status, 200);
  }
  const { id: request } = await requestFor('mug'),
    add = { card, request, style: 'white' };
  // (company: job #14307: no request, a closed one, or a check photo, and it doesn't come in)
  assert.equal((await h.agent('studio/add', dex.token, { ...add, request: undefined })).status, 400);
  assert.equal((await h.agent('studio/add', dex.token, { ...add, request: 9999 })).status, 400);
  assert.equal((await h.agent('studio/add', dex.token, { ...add, field: 1 })).status, 409);
  assert.equal((await h.agent('studio/add', kit.token, add)).status, 404);
  const byDex = await h.agent('studio/add', dex.token, add),
    byKeeper = await h.agent('studio/add', keeper.token, add);
  assert.equal(byDex.status, 200);
  assert.equal(byKeeper.status, 200);
  assert.equal(byKeeper.body.ids.length, 1); // (every saved field: the product shot alone)
  const added = (await h.agent('studio', keeper.token)).body.photos.find((p: any) => p.id === byKeeper.body.ids[0]);
  assert.equal(added.note, 'The mug, front');
  assert.equal(added.request, request);
  const original = await h.agent(`studio/picture?id=${added.id}&which=original`, keeper.token);
  assert.deepEqual(Buffer.from(original.body.data, 'base64'), PHOTO);
});

test('the board\'s comment on an approval reaches the keeper; the pages a photo is on; and the board\'s "this should change"', async () => {
  turnOn(5);
  saveKey();
  const keeper = await h.start({ agent: 'moss' }),
    kit = await h.start({ agent: 'kit' });
  // the board adds no photos itself: the crew decides which get made
  const before = (await listed()).photos.length;
  const sent = await h.send(
    '/api/studio/photos?product=mug&style=white',
    { cookie: h.boardCookie, origin: ORIGIN, 'content-type': 'image/jpeg' },
    PHOTO,
  );
  assert.notEqual(sent.status, 200);
  assert.equal((await listed()).photos.length, before);
  const { id } = (await bringIn(PHOTO, 'product=mug&style=white')).json;
  assert.equal((await h.agent('studio/edit', keeper.token, { id })).status, 200);
  await h.agent('studio/ready', keeper.token, { ids: [id], checks: CHECKS });
  const approved = await h.board('/api/studio/decide', {
    photos: asShown(id),
    decision: 'approved',
    note: 'lovely, crop it a touch for the shop',
  });
  assert.deepEqual(approved.body, { decided: 1 });
  const place = studioJobs().find(j => /to place/.test(j.title) && j.prompt.includes(`#${id}:`));
  assert.match(place!.prompt, /the board asks: "lovely, crop it a touch for the shop"/);
  assert.match(place!.prompt, /hq studio placed <id> <url>/);

  // where it went: the keeper's alone, an approved photo's alone, a page's address alone; the board sees them
  const page = 'https://shop.example/story-mug';
  assert.equal((await h.agent('studio/placed', kit.token, { id, urls: [page] })).status, 403);
  assert.equal(
    (await h.agent('studio/placed', keeper.token, { id, urls: ['ftp://shop.example/story-mug'] })).status,
    400,
  );
  assert.equal((await h.agent('studio/placed', keeper.token, { id, urls: [] })).status, 400);
  assert.deepEqual((await h.agent('studio/placed', keeper.token, { id, urls: [page, page] })).body, { places: [page] });
  assert.deepEqual((await listed()).photos.find((p: any) => p.id === id).places, [page]);
  const requestOf = () =>
    (
      h.db
        .prepare('select r.status from studio_requests r join studio_photos p on p.request = r.id where p.id = ?')
        .get(id) as any
    ).status;
  assert.equal(requestOf(), 'done'); // (answered: company: job #14307)

  // "this should change": a note it must have; then off the sites and back to the keeper with it, in one step
  assert.equal((await h.board('/api/studio/change', { photo: asShown(id)[0], note: ' ' })).status, 400);
  assert.equal((await h.board('/api/studio/change', { photo: { id, edit: 1 }, note: 'brighter' })).status, 409);
  assert.deepEqual(
    (await h.board('/api/studio/change', { photo: asShown(id)[0], note: 'the handle looks too thin' })).body,
    {
      ok: true,
    },
  );
  const now = (await listed()).photos.find((p: any) => p.id === id);
  assert.equal(now.status, 'new');
  assert.equal(requestOf(), 'open'); // (the page asks again)
  assert.equal(now.decided.decision, 'withdrawn');
  assert.equal((await h.agent(`studio/picture?id=${id}&which=approved`, kit.token)).status, 403);
  const down = studioJobs().find(j => /to take down/.test(j.title) && j.prompt.includes(`#${id}:`));
  assert.match(down!.prompt, new RegExp(`placed on ${page}`));
  assert.match(down!.prompt, /the board asks: "the handle looks too thin"/);
  const develop = studioJobs().find(j => /to develop/.test(j.title) && j.prompt.includes(`#${id}:`));
  assert.match(develop!.prompt, /the board asks: "the handle looks too thin"/);
  // (an approved photo alone can change)
  assert.equal((await h.board('/api/studio/change', { photo: asShown(id)[0], note: 'again' })).status, 409);
});

// ---- the shots asked for
test("the keeper works only on shots a page asked for: the ask, its job, the board's checks, and one handed back", async () => {
  turnOn(5);
  saveKey();
  google.answer = pictureBack;
  const keeper = await h.start({ agent: 'moss' }),
    pennant = await h.start({ agent: 'pennant' });
  const ask = (by: { token: string }, body: object) =>
    h.agent('studio/request', by.token, {
      product: 'mug',
      show: 'The mug on a table, its name to the camera',
      ...body,
    });
  const pages = ['https://shop.example/mug', 'https://shop.example/de/mug'];

  // what it must show, and where it goes: its pages (3 at most, real addresses) or words for many; never the keeper's own
  assert.equal((await ask(keeper, { pages })).status, 403);
  assert.equal((await ask(pennant, { pages, product: 'teapot' })).status, 400);
  assert.equal((await ask(pennant, { pages, show: ' ' })).status, 400);
  assert.equal((await ask(pennant, {})).status, 400);
  assert.equal((await ask(pennant, { pages: [...pages, 'https://a.example/', 'https://b.example/'] })).status, 400);
  assert.equal((await ask(pennant, { pages: ['mailto:shop@example.com'] })).status, 400);
  const asked = await ask(pennant, { pages });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const many = (await ask(pennant, { where: 'every gift guide page', pages: [] })).body.id;
  const job = h.db
    .prepare(`select title, prompt from jobs where agent = 'moss' and status = 'queued' and title like '%asked for'`)
    .get() as { title: string; prompt: string };
  assert.match(job.title, /^Studio: \d+ photos asked for$/); // (one job while it waits: earlier asks joined it too)
  assert.match(
    job.prompt,
    new RegExp(
      `Request #${asked.body.id} from pennant: The mug, for ${pages.join(', ')}\\. It must show: The mug on a table`,
    ),
  );
  assert.match(job.prompt, /for every gift guide page/);
  const listing = await h.hq(keeper, 'studio');
  assert.match(listing.out, new RegExp(`request #${asked.body.id}  mug, for ${pages[0]}`));

  // a photo for it reaches the board only with 1 to 3 short checks, and the board sees the request's pages
  const dex = await h.start({ agent: 'dex' });
  const card = await h.ask(dex, { kind: 'action', title: 'The mug', photos: [{ label: 'Mug', shot: 'product' }] });
  await h.send(
    `/api/requests/photo?id=${card}&field=0`,
    { cookie: h.boardCookie, origin: ORIGIN, 'content-type': 'image/jpeg' },
    PHOTO,
  );
  const [id] = (await h.agent('studio/add', keeper.token, { card, request: asked.body.id, style: 'table' })).body.ids;
  await h.agent('studio/edit', keeper.token, { id });
  assert.equal((await h.agent('studio/ready', keeper.token, { ids: [id] })).status, 400);
  assert.equal((await h.agent('studio/ready', keeper.token, { ids: [id], checks: ['a', 'b', 'c', 'd'] })).status, 400);
  // (a check too long to read at a glance is refused, never cut)
  assert.equal((await h.agent('studio/ready', keeper.token, { ids: [id], checks: ['x'.repeat(91)] })).status, 400);
  assert.equal((await h.agent('studio/ready', keeper.token, { ids: [id], checks: ['The name: Ada'] })).status, 200);
  const shown = (await listed()).photos.find((p: any) => p.id === id);
  assert.deepEqual([shown.request.pages, shown.request.where, shown.checks], [pages, null, ['The name: Ada']]);

  // one with no request (from before requests) never goes to the board
  h.db.prepare(`update studio_photos set request = null, status = 'edited' where id = ?`).run(id);
  assert.equal((await h.agent('studio/ready', keeper.token, { ids: [id], checks: ['x'] })).status, 409);
  h.db.prepare('update studio_photos set request = ? where id = ?').run(many, id);

  // handed back: the asker gets a job with what the keeper needs, its photos leave, and it takes no more
  assert.equal((await h.agent('studio/return', pennant.token, { id: many, need: 'x' })).status, 403);
  assert.equal((await h.agent('studio/return', keeper.token, { id: many, need: ' ' })).status, 400);
  const need = 'A test print with a short name: this one says Bartholomeus';
  const back = await h.agent('studio/return', keeper.token, { id: many, need });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const theirs = h.db.prepare('select agent, title, prompt from jobs where id = ?').get(back.body.job) as any;
  assert.equal(theirs.agent, 'pennant');
  assert.ok(theirs.prompt.includes(need));
  assert.match(theirs.prompt, /for every gift guide page/);
  assert.equal((h.db.prepare('select status from studio_photos where id = ?').get(id) as any).status, 'stopped');
  assert.equal(
    (await listed()).photos.find((p: any) => p.id === id),
    undefined,
  );
  assert.equal((await h.agent('studio/add', keeper.token, { card, request: many, style: 'table' })).status, 409);
  assert.equal((await h.agent('studio/return', keeper.token, { id: many, need })).status, 409);
});

test('a request handed back mid-edit drops the photo the edit returns with; a dropped last photo sends its request back to the keeper', async t => {
  turnOn(5);
  saveKey();
  google.answer = pictureBack;
  const keeper = await h.start({ agent: 'moss' }),
    statusOf = (id: number) => (h.db.prepare('select status from studio_photos where id = ?').get(id) as any).status;

  // the keeper hands the request back while an edit of its photo is in the model: the edit comes back dropped
  const inModel = (await bringIn(PHOTO, 'product=mug&style=white')).json.id;
  let release = () => {};
  google.held = new Promise(r => (release = r));
  t.after(() => {
    release();
    google.held = null;
  });
  const calls = google.asked.length,
    editing = h.agent('studio/edit', keeper.token, { id: inModel });
  await until(() => google.asked.length > calls, 'the edit in the model');
  const back = await h.agent('studio/return', keeper.token, {
    id: askedFor.get('mug'),
    need: 'A print without a ruler',
  });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  release();
  assert.equal((await editing).status, 200);
  assert.equal(statusOf(inModel), 'stopped');
  assert.equal(
    (await listed()).photos.find((p: any) => p.id === inModel),
    undefined,
  );

  // a request's only photo dropped by the watch (its jobs ended twice): the request goes to the keeper again, as a job
  const dropped = (await bringIn(PHOTO, 'product=mug&style=white')).json.id,
    request = askedFor.get('mug')!;
  h.db.prepare('update studio_requests set keeper_job = 999999 where id = ?').run(request);
  const ended = (h.db.prepare('select develop_job from studio_photos where id = ?').get(dropped) as any).develop_job;
  h.db.prepare('update studio_photos set lapses = 1 where id = ?').run(dropped);
  h.db.prepare("update jobs set status = 'cancelled' where id = ?").run(ended);
  await until(() => statusOf(dropped) === 'stopped', 'dropped the second time');
  await until(
    () =>
      (h.db.prepare('select keeper_job from studio_requests where id = ?').get(request) as any).keeper_job !== 999999,
    'a keeper job for the request again',
  );
  const job = (h.db.prepare('select keeper_job from studio_requests where id = ?').get(request) as any).keeper_job;
  assert.match((h.db.prepare('select title from jobs where id = ?').get(job) as any).title, /asked for$/);
});

// ---- the keeper's crop and kept boxes
// A poster on a striped table, with a label of print 10 pixels tall (letters of a 3 × 5 font in 2-pixel cells, picked
// by a seed) and a red sticker on a green leaf's edge (the same grey). Drawn as the board's photo, or as the model's edit
// of a part of it: scaled, shifted, on a plain backdrop, its label's letters retyped (another seed) and its sticker gone.
const LABEL = { x: 760, y: 610, w: 300, h: 110 },
  STICKER = { x: 250, y: 200, w: 120, h: 120 };
// prettier-ignore
const FONT = ['010101111101101', '110101110101110', '011100100100011', '111100110100111', '101101111101101',
  '111010010010111', '100100100100111', '110101101101101', '010101101101010', '110101110100100', '011100010001110',
  '111010010010010', '111101101101111', '010110010010111', '110001010100111', '101101111001001'];
function poster({ seed = 1, edit = false } = {}) {
  let n = seed;
  const random = () => (n = (n * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const letters: string[] = [];
  // (five lines of words, a space at the same places in both: a retyped label keeps its layout)
  const spaces = [
    [7, 16, 22],
    [5, 11, 24],
    [9, 14, 19],
    [4, 18],
    [8, 13, 25],
  ];
  for (let line = 0; line < 5; line++)
    for (let letter = 0; letter < 30 - 4 * (line % 2); letter++) {
      const glyph = FONT[Math.floor(random() * FONT.length)];
      if (spaces[line].includes(letter)) continue;
      for (let cell = 0; cell < 15; cell++)
        if (glyph[cell] === '1')
          letters.push(
            `<rect x="${774 + letter * 9 + (cell % 3) * 2}" y="${624 + line * 18 + Math.floor(cell / 3) * 2}" width="2" height="2"/>`,
          );
    }
  const stripes = edit
    ? ''
    : Array.from({ length: 30 }, (_, i) => `<rect y="${i * 34}" width="1200" height="14" fill="#6b4c2e"/>`);
  return `<rect width="1200" height="900" fill="${edit ? '#f2f2ef' : '#8a6a4a'}"/>${stripes}
    <rect x="120" y="90" width="1000" height="700" fill="#f3ead6"/><ellipse cx="560" cy="380" rx="300" ry="200" fill="#4f8a55"/>
    <path d="M300 520 Q560 140 820 520" stroke="#2e5d34" stroke-width="6" fill="none"/>
    <rect x="764" y="614" width="292" height="102" fill="#fbf6ea" stroke="#333" stroke-width="2"/><g fill="#222">${letters.join('')}</g>
    ${edit ? '' : '<polygon points="310,210 330,280 360,260 340,300 370,330 310,310 260,330 280,290 250,260 290,280" fill="#d23"/>'}`;
}
const drawn = (svg: string, w: number, h: number) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${svg}</svg>`));

test("the keeper's crop goes to the model and the board's flip; a kept box comes back as the board's own pixels, one the edit lost is said", async () => {
  turnOn(5);
  saveKey();
  const keeper = await h.start({ agent: 'moss' });
  const photo = await drawn(poster(), 1200, 900).blur(0.5).jpeg({ quality: 92 }).toBuffer(),
    { id } = (await bringIn(photo, 'product=mug&style=white')).json;
  const crop = { x: 100, y: 60, w: 1040, h: 780 },
    scale = 1.5,
    shift = { x: 36, y: -20 },
    gain = [1.1, 1, 0.85];
  // the model's answer: the crop at 1.5 times, in a 1600 × 1200 frame, 36 pixels right and 20 up of centred, relit
  const left = (1600 - crop.w * scale) / 2 + shift.x,
    top = (1200 - crop.h * scale) / 2 + shift.y;
  const edit = await drawn(
    `<g transform="translate(${left} ${top}) scale(${scale}) translate(${-crop.x} ${-crop.y})">${poster({ seed: 2, edit: true })}</g>`,
    1600,
    1200,
  )
    .blur(0.7)
    .linear(gain, [0, 0, 0])
    .jpeg({ quality: 90 })
    .toBuffer();
  google.answer = () => [
    200,
    {
      steps: [
        { type: 'model_output', content: [{ type: 'image', mime_type: 'image/jpeg', data: edit.toString('base64') }] },
      ],
    },
  ];
  const box = (b: typeof crop) => `${b.x},${b.y},${b.w},${b.h}`,
    asked = google.asked.length;

  // boxes past the photo or the crop, or not boxes, are refused before the model
  for (const wrong of [{ crop: '0,0,1201,900' }, { crop: box(crop), keep: ['0,0,50,50'] }, { keep: ['760,610,300'] }])
    assert.equal((await h.agent('studio/edit', keeper.token, { id, ...wrong })).status, 400, JSON.stringify(wrong));
  assert.equal(google.asked.length, asked);

  const tmp = h.dataDir,
    out = await h.hq(
      { ...keeper, tmp },
      'studio',
      'edit',
      String(id),
      '--crop',
      box(crop),
      '--keep',
      box(LABEL),
      '--keep',
      box(STICKER),
    );
  assert.equal(out.code, 0, out.out);
  const sent = Buffer.from(google.asked.at(-1).input[1].data, 'base64');
  assert.deepEqual(pictureSize(sent), { width: crop.w, height: crop.h });
  assert.match(out.out, new RegExp(`Kept ${box(LABEL)} from the original: at \\d+`));
  assert.match(out.out, new RegExp(`Not kept: ${box(STICKER)}: the edit doesn't hold it surely`));
  const row = h.db.prepare('select crop, keep from studio_edits where photo = ? order by id desc').get(id) as any,
    [label, sticker] = JSON.parse(row.keep);
  assert.equal(row.crop, box(crop));
  assert.ok(sticker.missing && !sticker.at);

  // the label's corners sit where the edit put them, within a pixel, and it is the board's own print relit, within
  // JPEG's noise (here in whole pixels: 1046,820,450,165)
  const expected = {
    x: left + (LABEL.x - crop.x) * scale,
    y: top + (LABEL.y - crop.y) * scale,
    w: LABEL.w * scale,
    h: LABEL.h * scale,
  };
  const corners = [
    [expected.x, expected.y],
    [expected.x + expected.w, expected.y],
    [expected.x + expected.w, expected.y + expected.h],
    [expected.x, expected.y + expected.h],
  ];
  label.corners.forEach(([x, y]: number[], i: number) =>
    assert.ok(Math.hypot(x - corners[i][0], y - corners[i][1]) <= 1, `corner ${i}: ${x},${y}`),
  );
  const file = readFileSync(out.out.match(/→ (\S+)/)![1]);
  assert.ok(isAiEdited(file));
  // (each brought back to the original's size: sharp's enlargements move a picture half a pixel, its reductions don't)
  const at = expected,
    trim = (b: typeof crop) => ({ left: b.x + 4, top: b.y + 4, width: b.w - 8, height: b.h - 8 }),
    whole = { x: 0, y: 0, w: LABEL.w, h: LABEL.h },
    asLabel = (picture: Buffer) =>
      sharp(picture)
        .extract({ left: at.x, top: at.y, width: at.w, height: at.h })
        .resize(LABEL.w, LABEL.h)
        .png()
        .toBuffer(),
    within = async (picture: Buffer, b = whole) => sharp(picture).extract(trim(b)).removeAlpha().raw().toBuffer();
  const mine = await within(
      await sharp(photo)
        .extract({ left: LABEL.x, top: LABEL.y, width: LABEL.w, height: LABEL.h })
        .linear(label.gain, [0, 0, 0])
        .png()
        .toBuffer(),
    ),
    kept = await within(await asLabel(file)),
    retyped = await within(await asLabel(edit));
  const apart = (a: Buffer, b: Buffer) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
  // (a 1.5 times enlargement and back alone puts these 2-pixel letters about 6 of 255 apart, and the JPEG some more)
  assert.ok(apart(kept, mine) < 10, `the kept label is ${apart(kept, mine)} from the board's own`);
  assert.ok(apart(retyped, mine) > 3 * apart(kept, mine), "(and the model's retyped label wasn't)");
  for (const [c, g] of gain.entries()) assert.ok(Math.abs(label.gain[c] - g) < 0.06, `gain ${c}`);
  // the sticker's place is the model's, untouched
  const lost = {
    x: Math.round(left + (STICKER.x - crop.x) * scale),
    y: Math.round(top + (STICKER.y - crop.y) * scale),
    w: 180,
    h: 180,
  };
  assert.ok(apart(await within(file, lost), await within(edit, lost)) < 2);

  // the board's flip shows the crop beside this edit: the original as it went to the model
  const edited = asShown(id)[0].edit,
    flip = await h.send(`/api/studio/original?id=${id}&edit=${edited}`, { cookie: h.boardCookie });
  const cropped = readFileSync(`${h.dataDir}/studio/${id}/${edited}-in.jpg`);
  assert.equal(flip.status, 200);
  assert.equal(Number(flip.headers['content-length']), cropped.length);
  assert.deepEqual(pictureSize(cropped), { width: crop.w, height: crop.h });
});

test("a shot the board took sideways is turned before anything else: the model, the keeper's boxes, its later edits and the board's flip", async () => {
  turnOn(5);
  saveKey();
  google.answer = pictureBack;
  const keeper = await h.start({ agent: 'moss' });
  // 1200 × 900 with a red mark at its top-left: a quarter turn clockwise puts it at the top-right of 900 × 1200
  const photo = await drawn(
      '<rect width="1200" height="900" fill="#ddd"/><rect width="100" height="100" fill="#d00"/>',
      1200,
      900,
    )
      .jpeg({ quality: 92 })
      .toBuffer(),
    { id } = (await bringIn(photo, 'product=mug&style=white')).json,
    sent = () => Buffer.from(google.asked.at(-1).input[1].data, 'base64'),
    red = async (picture: Buffer, x: number, y: number) => {
      const pixel = await sharp(picture)
        .extract({ left: x, top: y, width: 1, height: 1 })
        .removeAlpha()
        .raw()
        .toBuffer();
      return pixel[0] > 150 && pixel[1] < 80;
    };
  // a turn that isn't a quarter, and a crop past the turned photo (900 wide), are refused before the model
  const asked = google.asked.length;
  assert.equal((await h.agent('studio/edit', keeper.token, { id, turn: 45 })).status, 400);
  assert.equal((await h.agent('studio/edit', keeper.token, { id, turn: 90, crop: '0,0,1000,900' })).status, 400);
  assert.equal(google.asked.length, asked);

  // the keeper looks at it turned before the first edit, to measure its boxes: the photo itself isn't turned by a look
  const tmp = h.dataDir,
    look = await h.hq({ ...keeper, tmp }, 'studio', 'original', String(id), '--turn', '90');
  assert.match(look.out, /turned 90° clockwise/);
  assert.ok(await red(readFileSync(look.out.match(/→ (\S+)/)![1]), 850, 50));
  assert.equal((h.db.prepare('select turn from studio_photos where id = ?').get(id) as any).turn, 0);

  const out = await h.hq({ ...keeper, tmp }, 'studio', 'edit', String(id), '--turn', '90', '--crop', '0,0,900,1100');
  assert.equal(out.code, 0, out.out);
  assert.match(out.out, /turned 90° clockwise/);
  assert.deepEqual(pictureSize(sent()), { width: 900, height: 1100 });
  assert.ok(await red(sent(), 850, 50));
  // and once it has its turn, every look at the original is turned the same
  const original = await h.hq({ ...keeper, tmp }, 'studio', 'original', String(id));
  assert.match(original.out, /turned 90° clockwise/);
  assert.deepEqual(pictureSize(readFileSync(original.out.match(/→ (\S+)/)![1])), { width: 900, height: 1200 });
  // the photo keeps its turn for its next edit, and the board's flip shows it as the model got it
  assert.equal((await h.agent('studio/edit', keeper.token, { id })).status, 200);
  assert.deepEqual(pictureSize(sent()), { width: 900, height: 1200 });
  assert.ok(await red(sent(), 850, 50));
  const edited = asShown(id)[0].edit,
    flip = await h.send(`/api/studio/original?id=${id}&edit=${edited}`, { cookie: h.boardCookie }),
    turned = readFileSync(`${h.dataDir}/studio/${id}/${edited}-in.jpg`);
  assert.equal(flip.status, 200);
  assert.equal(Number(flip.headers['content-length']), turned.length);
  assert.deepEqual(pictureSize(turned), { width: 900, height: 1200 });
  // 0 sets it back as the board took it
  assert.equal((await h.agent('studio/edit', keeper.token, { id, turn: 0 })).status, 200);
  assert.deepEqual(pictureSize(sent()), { width: 1200, height: 900 });
});

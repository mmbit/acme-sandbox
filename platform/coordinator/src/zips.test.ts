// node --test src/zips.test.ts   (the harness, its imports/ in its DATA_DIR)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { crc32, deflateRawSync } from 'node:zlib';
import { parkedRequest } from '../../worker/src/outcome.ts';
import { harness } from './harness.ts';

// (the test's files are on this disk too, whatever it has free)
const h = await harness('zips', { env: { IMPORTS_MIN_FREE_GB: '0' } });
const zips = await import('./zips.ts');
const { IMPORTS_DIR, ORIGIN } = await import('./config.ts');

// ---------------------------------------------------------------- zips as the common tools write them
// zip64: every size and offset in the zip64 extra field, and a zip64 end record (as a zip over 4 GB has them).
// descriptor: sizes after the data instead of in the local header (macOS's Archive Utility, Windows' Compress).
type ZipFile = { name: string; data?: Buffer; method?: number; unix?: number; flags?: number };
function makeZip(files: ZipFile[], { zip64 = false, descriptor = false } = {}) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const data = f.data ?? Buffer.alloc(0);
    const method = f.method ?? (data.length ? 8 : 0);
    const stored = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(f.name);
    const flags = 0x800 | (descriptor ? 8 : 0) | (f.flags ?? 0);
    const crc = crc32(data);
    const masked = zip64 ? 0xffffffff : 0;
    const extra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (zip64) {
      extra.writeUInt16LE(1, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(data.length), 4);
      extra.writeBigUInt64LE(BigInt(stored.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(descriptor ? 0 : crc, 14);
    local.writeUInt32LE(descriptor ? 0 : masked || stored.length, 18);
    local.writeUInt32LE(descriptor ? 0 : masked || data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const trailer = descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (descriptor) {
      trailer.writeUInt32LE(0x08074b50, 0);
      trailer.writeUInt32LE(crc, 4);
      trailer.writeUInt32LE(stored.length, 8);
      trailer.writeUInt32LE(data.length, 12);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(f.unix ? (3 << 8) | 20 : 20, 4);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(masked || stored.length, 20);
    central.writeUInt32LE(masked || data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE((f.unix ?? 0) * 0x10000, 38);
    central.writeUInt32LE(masked || offset, 42);
    locals.push(local, name, stored, trailer);
    centrals.push(central, name, extra);
    offset += local.length + name.length + stored.length + trailer.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : files.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : files.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  if (!zip64) return Buffer.concat([...locals, directory, end]);
  const end64 = Buffer.alloc(56);
  end64.writeUInt32LE(0x06064b50, 0);
  end64.writeBigUInt64LE(44n, 4);
  end64.writeBigUInt64LE(BigInt(files.length), 24);
  end64.writeBigUInt64LE(BigInt(files.length), 32);
  end64.writeBigUInt64LE(BigInt(directory.length), 40);
  end64.writeBigUInt64LE(BigInt(offset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
  locator.writeUInt32LE(1, 16);
  return Buffer.concat([...locals, directory, end64, locator, end]);
}

// A damaged end record that declares a directory of nearly 4 GB (or 1 TB in zip64): read as it says, it would take
// the server down
function hugeDirectory({ zip64 = false } = {}) {
  if (!zip64) {
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt32LE(0xfffffff0, 12);
    return end;
  }
  const zip = makeZip([{ name: 'a/b.txt', data: Buffer.from('x') }], { zip64: true });
  zip.writeBigUInt64LE(1n << 40n, zip.length - 22 - 20 - 56 + 40);
  return zip;
}

// Bytes that don't compress, like a video's
const noise = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 2654435761) >>> 24));
const TRAILER = noise(300_000);
const BEEP = noise(20_000);
const APP = Buffer.from('export const hello = "puzzle";\n'.repeat(200));
const CONCEPTS: ZipFile[] = [
  { name: 'forty/' },
  { name: 'forty/puzzle/' },
  { name: 'forty/puzzle/package.json', data: Buffer.from('{"name":"puzzle"}') },
  { name: 'forty/puzzle/src/app.ts', data: APP },
  { name: 'forty/puzzle/public/beep.wav', data: BEEP, method: 0 },
  { name: 'forty/puzzle/node_modules/react/index.js', data: Buffer.from('module.exports = {};'.repeat(500)) },
  { name: 'forty/puzzle/out/trailer.mp4', data: TRAILER, method: 0 },
  { name: 'forty/puzzle/dist/assets/app.js', data: APP },
  { name: 'forty/puzzle/.git/HEAD', data: Buffer.from('ref: refs/heads/main\n') },
  { name: 'forty/puzzle/.env', data: Buffer.from('ANTHROPIC_API_KEY=not-a-real-one\n') },
  { name: 'forty/puzzle/.env.example', data: Buffer.from('ANTHROPIC_API_KEY=\n') },
  { name: 'forty/puzzle/.DS_Store', data: noise(600) },
  { name: 'forty/kites/index.html', data: Buffer.from('<!doctype html><title>Kites</title>') },
  { name: 'forty/kites/trailer final ✓.mov', data: TRAILER, method: 0 },
  { name: 'forty/kites/link', data: Buffer.from('/etc/passwd'), unix: 0o120777 },
  { name: 'forty/kites/.aws/credentials', data: Buffer.from('[default]\n') },
  { name: 'forty/../escape.txt', data: Buffer.from('no') },
  { name: '__MACOSX/forty/puzzle/._app.ts', data: noise(100) },
];

// ---------------------------------------------------------------- the board's upload, from HQ's page
type Sent = { status: number; json: any };
const zipQuery = (id: number, file: Buffer, offset: number, key = 'forty.zip:1:1', field = 0) =>
  `/api/requests/zip?${new URLSearchParams({ id: String(id), field: String(field), name: 'forty.zip', size: String(file.length), file: key, offset: String(offset) })}`;
const board = { cookie: h.boardCookie, origin: ORIGIN };
const post = async (id: number, file: Buffer, offset: number, chunk: Buffer, key?: string, field = 0): Promise<Sent> =>
  h.send(zipQuery(id, file, offset, key, field), { ...board, 'content-length': String(chunk.length) }, chunk);
// The whole file in chunks, as HQ sends it, going on from wherever the server says
async function send(id: number, file: Buffer, chunkBytes = 100_000, key?: string) {
  let offset = 0;
  for (;;) {
    const r = await post(id, file, offset, file.subarray(offset, offset + chunkBytes), key);
    if (r.status === 416) offset = r.json.received;
    else if (r.status !== 200) return r;
    else if (r.json.state !== 'uploading') return r;
    else offset = r.json.received;
  }
}
// The card's zip field as HQ shows it
const field = async (id: number) => (await h.board('/api/requests')).body.find((r: any) => r.id === id).zips[0];
async function imported(id: number) {
  for (let i = 0; i < 200 && (await field(id)).state === 'importing'; i++) await new Promise(r => setTimeout(r, 25));
  return field(id);
}
// A card asking for zips (hq ask), from a running job of bolt's
async function ask(over: Record<string, unknown> = {}) {
  const job = await h.start({ agent: 'bolt' });
  const id = await h.ask(job, {
    kind: 'action',
    title: 'The forty concepts',
    body: 'Upload the zip.',
    zips: [{ label: 'The forty concepts (zip)' }],
    ...over,
  });
  return { id, job };
}
const filesIn = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? filesIn(`${dir}/${e.name}`).map(f => `${e.name}/${f}`) : [e.name],
  );
// What an upload leaves beside the imported folders (its zip, a half-unpacked folder)
const leftovers = () => filesIn(IMPORTS_DIR).filter(f => f.startsWith('.'));

test('the import leaves out what a computer can rebuild and keys, drops the folder around it all, and keeps videos from build output', async () => {
  const { id, job } = await ask();
  const zip = makeZip(CONCEPTS);
  assert.equal((await h.answer(id, 'Here it is.')).status, 400); // nothing uploaded yet
  assert.equal((await send(id, zip)).json.state, 'importing');
  const done = await imported(id);
  assert.equal(done.state, 'imported', done.error);
  const folder = `${IMPORTS_DIR}/${id}-the-forty-concepts-zip`;
  assert.equal(done.imported.folder, folder);
  assert.deepEqual(filesIn(folder).sort(), [
    '_import.md',
    'kites/index.html',
    'kites/trailer final ✓.mov',
    'puzzle/.env.example',
    'puzzle/out/trailer.mp4',
    'puzzle/package.json',
    'puzzle/public/beep.wav',
    'puzzle/src/app.ts',
  ]);
  assert.deepEqual(readFileSync(`${folder}/puzzle/out/trailer.mp4`), TRAILER);
  assert.deepEqual(readFileSync(`${folder}/puzzle/src/app.ts`), APP);
  assert.equal(statSync(`${folder}/puzzle/src/app.ts`).mode & 0o777, 0o644); // the worker's jobs read it
  assert.equal(statSync(`${folder}/puzzle/src`).mode & 0o777, 0o755);
  assert.deepEqual(leftovers(), []); // the zip is gone, and nothing was unpacked to throw away
  assert.deepEqual([done.imported.folders, done.imported.files, done.imported.leftOut.files], [2, 7, 9]);
  const note = readFileSync(`${folder}/_import.md`, 'utf8');
  for (const line of [
    '- dependencies: 1 files',
    '- keys: 2 files',
    '- build output: 1 files',
    '- version history: 1 files',
    '- system files: 2 files',
    '- unusable names: 2 files',
    '| puzzle/ | 5 |',
    '- kites/trailer final ✓.mov',
  ])
    assert.ok(note.includes(line), `${line} in:\n${note}`);
  assert.equal((await h.answer(id, 'Here it is.')).status, 200);
  const answer = (await h.agent('request-answer', job.token, { id })).body.answer as string;
  assert.ok(
    answer.startsWith('Here it is.\n\nZips: 1 of 1 imported.') &&
      answer.includes(`${folder} (from forty.zip): 2 folders, 7 files`),
    answer,
  );
});

test('a zipped folder of one concept keeps its folder, and only the folders listed are left out', async () => {
  const kept = async (names: string[]) => {
    const { id } = await ask();
    await send(id, makeZip(names.map(name => ({ name, data: Buffer.from('x') }))));
    const done = await imported(id);
    return filesIn(done.imported.folder)
      .filter(f => f !== '_import.md')
      .sort();
  };
  assert.deepEqual(await kept(['puzzle/src/a.ts', 'puzzle/src/b.ts']), ['puzzle/src/a.ts', 'puzzle/src/b.ts']);
  assert.deepEqual(await kept(['puzzle/src/app.js', 'puzzle/public/sound.wav']), [
    'puzzle/public/sound.wav',
    'puzzle/src/app.js',
  ]);
  assert.deepEqual(await kept(['puzzle/package.json', 'puzzle/game/a.ts', 'puzzle/sounds/b.wav']), [
    'puzzle/game/a.ts',
    'puzzle/package.json',
    'puzzle/sounds/b.wav',
  ]);
  assert.deepEqual(await kept(['all/puzzle/a.ts', 'all/kites/b.ts', 'all/README.md']), [
    'README.md',
    'kites/b.ts',
    'puzzle/a.ts',
  ]);
  assert.deepEqual(await kept(['constructor/x.ts', 'toString/y.ts', 'Build.md', 'README.md', 'readme.md']), [
    'Build.md',
    'README.md',
    'constructor/x.ts',
    'readme.md',
    'toString/y.ts',
  ]);
});

test('a dropped line costs one chunk: the upload goes on from the bytes the server has, and only the same file does', async () => {
  const { id } = await ask();
  const zip = makeZip(CONCEPTS, { descriptor: true });
  assert.equal((await post(id, zip, 0, zip.subarray(0, 50_000))).json.received, 50_000);
  // the same chunk again (its answer was lost), or one from too far on: the server says where it is
  assert.deepEqual((await post(id, zip, 0, zip.subarray(0, 50_000))).json.received, 50_000);
  assert.deepEqual((await post(id, zip, 90_000, zip.subarray(90_000, 100_000))).json.received, 50_000);
  // a chunk cut off on the way appends nothing
  await new Promise<void>(resolve => {
    const q = request(h.base + zipQuery(id, zip, 50_000), {
      method: 'POST',
      headers: { ...board, 'content-length': 50_000 },
    });
    q.on('error', () => resolve());
    q.write(zip.subarray(50_000, 60_000), () => setTimeout(() => (q.destroy(), resolve()), 50));
  });
  await new Promise(r => setTimeout(r, 50));
  assert.equal((await field(id)).received, 50_000);
  const last = zip.length - 10_000;
  assert.equal((await send(id, zip, 10_000)).json.state, 'importing');
  assert.equal((await imported(id)).imported.files, 7);
  // the last chunk again, its answer lost: it's in, while the zip is unpacked and once it is, and the folder stays
  const first = (await field(id)).imported.folder;
  assert.deepEqual((await post(id, zip, last, zip.subarray(last))).json, { received: zip.length, state: 'imported' });
  // (while it's unpacked: too quick for a test to catch on its own)
  h.db.prepare("update requests set zips = json_set(zips, '$[0].state', 'importing') where id = ?").run(id);
  assert.deepEqual((await post(id, zip, last, zip.subarray(last))).json, { received: zip.length, state: 'importing' });
  assert.equal((await post(id, zip, 0, zip.subarray(0, 10_000))).status, 409);
  h.db.prepare("update requests set zips = json_set(zips, '$[0].state', 'imported') where id = ?").run(id);
  assert.ok(existsSync(`${first}/puzzle/src/app.ts`));
  // another file starts over and replaces the folder the first became
  const other = makeZip(
    [
      { name: 'one/a.txt', data: Buffer.from('a') },
      { name: 'two/b.txt', data: Buffer.from('b') },
    ],
    { zip64: true },
  );
  assert.equal((await send(id, other, 100_000, 'other.zip:2:2')).json.state, 'importing');
  const second = await imported(id);
  assert.equal(second.imported.folder, first);
  assert.deepEqual(filesIn(first).sort(), ['_import.md', 'one/a.txt', 'two/b.txt']);
});

test("a zip that can't be imported says why on the card, and its upload goes", async () => {
  const cases: [Buffer, RegExp][] = [
    [Buffer.from('not a zip at all'), /isn't a zip/],
    [makeZip(CONCEPTS).subarray(0, 4000), /isn't a zip|ends too early/],
    [makeZip([{ name: 'a/secret.txt', data: Buffer.from('x'), flags: 1 }]), /password/],
    [makeZip([{ name: 'a/b.txt', data: Buffer.from('x'), method: 9 }]), /compression/],
    [makeZip([{ name: 'a/node_modules/x.js', data: Buffer.from('x') }]), /rebuild/],
    [hugeDirectory(), /damaged/],
    [hugeDirectory({ zip64: true }), /damaged/],
  ];
  for (const [zip, why] of cases) {
    const { id } = await ask();
    assert.equal((await send(id, zip)).status, 200);
    const done = await imported(id);
    assert.equal(done.state, 'failed');
    assert.match(done.error, why);
    assert.equal((await h.answer(id, '.')).status, 400);
  }
  assert.deepEqual(leftovers(), []);
});

test('a zip starts only with room for it, and a card that leaves the desk phone loses its half-sent zip', async () => {
  const { id, job } = await ask();
  const zip = makeZip(CONCEPTS);
  const cap = zips.ROOM.maxStored;
  zips.ROOM.maxStored = 1000;
  try {
    assert.equal((await post(id, zip, 0, zip.subarray(0, 1000))).status, 507);
  } finally {
    zips.ROOM.maxStored = cap;
  }
  assert.equal((await post(id, zip, 0, zip.subarray(0, 1000))).status, 200);
  zips.sweep(); // (the hourly sweep)
  assert.equal(leftovers().length, 1);
  assert.equal((await h.agent('request-close', job.token, { id })).status, 200);
  zips.sweep();
  assert.deepEqual(leftovers(), []);
  assert.equal((await post(id, zip, 1000, zip.subarray(1000, 2000))).status, 409);
});

test('zips sent together share the room: each upload holds what it has still to receive', async () => {
  const { id } = await ask({ zips: [{ label: 'One' }, { label: 'Two' }] });
  const zip = makeZip(CONCEPTS);
  const second = makeZip(CONCEPTS, { descriptor: true });
  const post2 = (file: Buffer, offset: number, chunk: Buffer, field: number) =>
    post(id, file, offset, chunk, `forty.zip:${field}:1`, field);
  const cap = zips.ROOM.maxStored;
  const stored = storedNow();
  try {
    zips.ROOM.maxStored = stored + zip.length + second.length / 2;
    assert.equal((await post2(zip, 0, zip.subarray(0, 1000), 0)).status, 200);
    assert.equal((await post2(second, 0, second.subarray(0, 1000), 1)).status, 507);
    // room for both zips, not for the first one unpacked as well: its import counts what the second has still to send
    zips.ROOM.maxStored = stored + zip.length + second.length + 10_000;
    assert.equal((await post2(second, 0, second.subarray(0, 1000), 1)).status, 200);
    assert.equal((await post2(zip, 1000, zip.subarray(1000), 0)).json.state, 'importing');
    const done = await imported(id);
    assert.equal(done.state, 'failed');
    assert.match(done.error, /no room/);
  } finally {
    zips.ROOM.maxStored = cap;
  }
});
const storedNow = () =>
  filesIn(IMPORTS_DIR).reduce((bytes, file) => bytes + statSync(`${IMPORTS_DIR}/${file}`).blocks * 512, 0);

test('hq request --zip parks its fields, and the worker files them on the card, never with keys', async () => {
  const dir = mkdtempSync(`${tmpdir()}/zips-hq-`);
  writeFileSync(`${dir}/body.md`, 'Upload the zip.');
  const job = await h.start({ agent: 'bolt' });
  const hq = ['request', 'action', 'today', 'Concepts', `${dir}/body.md`, '--topic', 'concepts', '--park'];
  const r = await h.hq({ ...job, dir: `${dir}/.hq` }, ...hq, '--zip', 'The zip', '--optional-zip', 'Extras');
  assert.equal(r.code, 0, r.out);
  const request = parkedRequest(readFileSync(`${dir}/.hq/request.json`, 'utf8'));
  assert.equal((await h.finish(job, { status: 'parked', request })).status, 200);
  const card = (await h.board('/api/requests')).body.find((c: any) => c.job === job.id);
  assert.deepEqual(
    card.zips.map((f: any) => [f.label, f.optional, f.state]),
    [
      ['The zip', false, null],
      ['Extras', true, null],
    ],
  );
  const keys = { kind: 'credential', title: 'A key', body: '.', secrets: 'SOME_TEST_KEY', zips: [{ label: 'x' }] };
  assert.equal((await h.agent('request', (await h.start({ agent: 'bolt' })).token, keys)).status, 400);
});

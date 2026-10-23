// node --test src/apps.test.ts   (HQ-OS › Apps: the test company with made-up products, HQ's real server)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('apps', { env: { PUBLIC_HOST: 'hq.example.test' }, before: repo => rmSync(`${repo}/products/hello`, { recursive: true }) });
const { repo, board, base } = h;

const TEMPLATE = '# Copy products/_template to products/<slug> to start a product.\nname: Example Product\nstatus: preview\nowner: wren\n';
const product = (slug: string, yaml: string, files: Record<string, string> = {}) => {
  mkdirSync(`${repo}/products/${slug}/app`, { recursive: true });
  writeFileSync(`${repo}/products/${slug}/product.yaml`, yaml);
  for (const [name, text] of Object.entries(files)) writeFileSync(`${repo}/products/${slug}/${name}`, text);
};
product('_template', TEMPLATE);
product('pebblepost', '# Pebble Post: a pebble with your words on it, posted (venture cycle 2, 2026-10-01). Round or flat.\n# The notes: how it is built, which partner prints it, where its design notes are and how the team tests it, which is all far too long for a line in HQ.\nname: Pebble Post\nstatus: live\nowner: wren\n'
  + 'partner_env: live\ndomain: pebblepost.example\nneeds:\n  secrets: [stripe]\n', { 'app/metrics.json': '{}' });
product('mossgram', '# Mossgram (job #12): moss that spells your name.\nname: Mossgram\nstatus: test\nowner: juno\n');
product('ferngram', '# Ferngram: ferns.\nname: Ferngram\nstatus: live\nowner: juno\n');   // live in the file, but never approved
product('copycat', TEMPLATE.replace('Example Product', 'Copycat'), { 'README.md': '# Copycat\n\n**A cat drawn from your voice.** It purrs.\n' });
product('engine', '# Engine: the service behind the apps.\nname: Engine\nstatus: preview\nowner: wren\nplatform: true\n');
mkdirSync(`${repo}/products/_cycles`, { recursive: true });

const list = async () => { const r = await board('/api/apps'); assert.equal(r.status, 200); return r.body as any[]; };
const app = async (slug: string) => (await list()).find(a => a.slug === slug);
// An approval as it's given: a job asks for the grant on the desk phone, the board reads the card's words (what
// approving does) and presses Approve.
const lead = await h.start({ agent: 'juno' });
const card = async (grant: string) => {
  const id = await h.ask(lead, { kind: 'approval', approves: grant });
  return { id, says: (await board('/api/requests')).body.find((c: any) => c.id === id).grants as string };
};
const approve = async (grant: string) => assert.equal((await h.answer((await card(grant)).id, '', { approve: true })).status, 200);

test('the list is behind the board\'s login', async () => {
  assert.equal((await fetch(`${base}/api/apps`)).status, 401);
});

test('every product, live first, then test, then preview, the platform last; never the template or the cycles', async () => {
  await approve('live:pebblepost');
  assert.deepEqual((await list()).map(a => a.slug), ['pebblepost', 'mossgram', 'copycat', 'ferngram', 'engine']);
});

test('a row says what the board needs: its words, status, owner, preview, public site and Numbers', async () => {
  assert.deepEqual(await app('pebblepost'), { slug: 'pebblepost', name: 'Pebble Post', about: 'A pebble with your words on it, posted. Round or flat.', status: 'live', waiting: false,
    owner: 'wren', platform: false, front: false, preview: 'https://pebblepost.preview.example.test',
    // its own domain alone: its shelf on www sends page loads there
    public: ['https://pebblepost.example'], numbers: true, icon: null });   // (icon)
  const moss = await app('mossgram');
  assert.equal(moss.about, 'Moss that spells your name.', 'no job numbers for the board');
  assert.equal(moss.numbers, false);
  assert.equal((await app('copycat')).about, 'A cat drawn from your voice. It purrs.', 'a copied template comment says nothing: the README speaks');
  assert.equal((await app('engine')).platform, true);
});

test('live in product.yaml is public only once the board approved it', async () => {
  let fern = await app('ferngram');
  assert.deepEqual([fern.status, fern.waiting, fern.public], ['preview', true, []]);
  await approve('site:ferngram');
  fern = await app('ferngram');
  assert.deepEqual([fern.status, fern.waiting, fern.public], ['live', false, ['https://www.example.test/ferngram/']]);   // (a shelf on www)
});

test('a new product shows up without a restart', async () => {
  product('newt', '# Newt: a newt.\nname: Newt\nstatus: preview\nowner: wren\n');
  assert.ok((await list()).some(a => a.slug === 'newt'));
});

test("a front with a domain of its own: its cards put it there and move www's visitors and apps to it once approved", async () => {
  product('front', '# Front: our front door.\nname: Front\nstatus: live\nowner: kit\ndomain: frontdoor.example\n');
  const site = await card('site:front');
  assert.match(site.says, /public at frontdoor\.example\b/);
  for (const says of [site.says, (await card('live:front')).says]) {
    assert.match(says, /www\.example\.test\b/, 'it names the host its visitors leave');
    assert.doesNotMatch(says, /[<>]/, 'no placeholders reach the board');
  }
  assert.deepEqual((await app('ferngram')).public, ['https://www.example.test/ferngram/'], 'nothing moves before the board approves');
  await h.answer(site.id, '', { approve: true });
  const apps = await list(), by = (s: string) => apps.find(a => a.slug === s);
  assert.deepEqual(by('front').public, ['https://frontdoor.example']);
  assert.deepEqual(by('ferngram').public, ['https://frontdoor.example/ferngram/']);
  assert.deepEqual(by('pebblepost').public, ['https://pebblepost.example']);
  assert.match((await card('site:ferngram')).says, /public at frontdoor\.example\/ferngram\/, without/);
});

test('our front door without a domain lists www.<zone> only, as infra/products.py serves it', async () => {
  product('front', '# Front: our front door.\nname: Front\nstatus: live\nowner: kit\n');
  assert.equal((await card('live:front')).says.match(/www\.example\.test/g)?.length, 1, 'its card names www once, as its address: nothing moves');
  const front = await app('front');
  assert.deepEqual([front.status, front.preview, front.public, front.front], ['live', 'https://front.preview.example.test', ['https://www.example.test'], true]);
  assert.deepEqual((await app('ferngram')).public, ['https://www.example.test/ferngram/']);
});

test('a cycles demo that carries a demo.yaml is listed after the apps, at its cycles address, its folder\'s maker its owner', async () => {
  const cycle = `${repo}/products/_cycles/2026-10-03-shop`;
  mkdirSync(`${cycle}/shop`, { recursive: true }); mkdirSync(`${cycle}/presentation`, { recursive: true });
  writeFileSync(`${cycle}/shop/demo.yaml`, 'name: The shop (demo)\nabout: "Our shop as one site (job #5441): the front page, the stalls and the basket."\n');
  writeFileSync(`${cycle}/shop/icon.png`, 'png');
  const apps = await list(), shop = apps.at(-1);   // (no git here, so no maker: the CEO's, juno)
  assert.deepEqual(shop, { slug: 'cycles/2026-10-03-shop/shop', name: 'The shop (demo)', about: 'Our shop as one site: the front page, the stalls and the basket.',
    status: 'demo', waiting: false, owner: 'juno', platform: false, front: false, preview: 'https://cycles.preview.example.test/2026-10-03-shop/shop/', public: [],
    numbers: false, icon: '/cycles/2026-10-03-shop/shop/icon.png' });
  assert.equal(apps.filter(a => a.status === 'demo').length, 1, 'a folder without a demo.yaml (the deck) is no demo');
  rmSync(`${cycle}/shop/demo.yaml`);
  assert.ok(!(await list()).some(a => a.status === 'demo'), 'taking the file out takes the demo out');
});

test('an app\'s icon is the icon.png beside its product.yaml, behind the board\'s login', async () => {
  writeFileSync(`${repo}/products/mossgram/icon.png`, 'moss');
  const icon = (await app('mossgram')).icon;
  assert.equal(icon, '/api/apps/icon?app=mossgram');
  assert.equal((await app('ferngram')).icon, null, 'none without the file');
  const get = (path: string, cookie = h.boardCookie) => fetch(`${base}${path}`, { headers: { cookie } });
  const r = await get(icon);
  assert.deepEqual([r.status, r.headers.get('content-type'), await r.text()], [200, 'image/png', 'moss']);
  assert.equal((await get(icon, '')).status, 401);
  for (const slug of ['ferngram', '_template', '../mossgram', 'nothing']) assert.equal((await get(`/api/apps/icon?app=${slug}`)).status, 404, slug);
});

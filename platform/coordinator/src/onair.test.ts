// node --test src/onair.test.ts   (On Air: the shows and episodes HQ lists, and the podcast feeds outside the login)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('onair');
writeFileSync(
  `${h.repo}/company/shows.yaml`,
  [
    '- { id: digest, name: The Digest, at: "06:45", hosts: [bolt], languages: [en, nl], audience: colleagues, about: What got done }',
    '- { id: open, name: Open House, hosts: [bolt], audience: public }',
  ].join('\n'),
);
const episode = (show: string, id: string, langs: string[], audio = langs, video: string[] = []) => {
  const dir = `${h.repo}/knowledge/onair/${show}/${id}`;
  mkdirSync(dir, { recursive: true });
  for (const l of langs)
    writeFileSync(`${dir}/script.${l}.md`, `---\ntitle: ${l} title ${id}\nsummary: ${l} & more\n---\nBolt: Hi.\n`);
  for (const l of audio) writeFileSync(`${dir}/episode.${l}.mp3`, `ID3 ${l}`);
  for (const l of video) writeFileSync(`${dir}/episode.${l}.mp4`, `ftyp ${l} video`);
};
episode('digest', '2026-10-15', ['en', 'nl']);
episode('digest', '2026-10-16', ['en', 'nl'], ['en'], ['en']);
episode('digest', '2026-10-17', ['en', 'nl'], []); // not spoken yet
episode('open', '2026-10-16', ['en']);

const listed = async () => Object.fromEntries(((await h.board('/api/onair')).body as any[]).map(s => [s.id, s]));
const path = (url: string) => url.slice(url.indexOf('/onair/'));

test('HQ lists each show with its episodes that have sound, newest first, per language', async () => {
  const digest = (await listed()).digest;
  assert.equal(digest.run, 'show-digest');
  assert.deepEqual(
    digest.episodes.map((e: any) => [e.id, Object.keys(e.langs)]),
    [
      ['2026-10-16', ['en']],
      ['2026-10-15', ['en', 'nl']],
    ],
  );
  assert.deepEqual(digest.episodes[1].langs.nl, {
    title: 'nl title 2026-10-15',
    summary: 'nl & more',
    bytes: 6,
    audio: '/knowledge/onair/digest/2026-10-15/episode.nl.mp3',
  });
  assert.deepEqual(
    digest.feeds.map((f: any) => f.lang),
    ['en', 'nl'],
  );
});

test("a private show's feed and sound need its key, without the board's session; a new link ends the old one", async () => {
  const feed = path((await listed()).digest.feeds[1].url),
    key = new URL(feed, 'http://x').searchParams.get('key')!;
  assert.match(feed, /^\/onair\/digest\.nl\.xml\?key=/);
  const rss = await h.send(feed);
  assert.equal(rss.status, 200);
  assert.match(rss.headers['content-type'], /rss\+xml/);
  assert.match(rss.text, /<title>The Digest \(Nederlands\)<\/title>/);
  assert.match(rss.text, /<itunes:block>yes<\/itunes:block>/, 'kept out of podcast directories');
  assert.match(rss.text, /<description>nl &#38; more<\/description>/);
  const sound = rss.text.match(/enclosure url="([^"]+)"/)![1].replace(/&#38;/g, '&');
  assert.equal((await h.send(path(sound))).text, 'ID3 nl');
  assert.equal((await h.send(feed.replace(key, 'wrong'))).status, 404);
  assert.equal((await h.send('/onair/digest.nl.xml')).status, 404);
  assert.equal((await h.send('/onair/digest.de.xml?key=' + key)).status, 404, 'a language the show has not');
  const renewed = (await h.board('/api/onair/link', { show: 'digest' })).body;
  assert.notEqual(path(renewed.feeds[1].url), feed);
  assert.equal((await h.send(feed)).status, 404, 'the old link stops working');
  assert.equal((await h.send(path(renewed.feeds[1].url))).status, 200);
});

test("a public show's feed is open, and has no link to renew", async () => {
  const open = (await listed()).open;
  assert.equal(path(open.feeds[0].url), '/onair/open.en.xml');
  const rss = await h.send('/onair/open.en.xml');
  assert.equal(rss.status, 200);
  assert.doesNotMatch(rss.text, /itunes:block/);
  assert.equal((await h.send('/onair/open/2026-10-16/episode.en.mp3')).text, 'ID3 en');
  assert.equal((await h.board('/api/onair/link', { show: 'open' })).status, 400);
});

test("an episode's video is listed, in a language's own feed of videos, behind the show's key", async () => {
  const digest = (await listed()).digest;
  assert.equal(digest.episodes[0].langs.en.video, '/knowledge/onair/digest/2026-10-16/episode.en.mp4');
  assert.equal(digest.episodes[1].langs.en.video, undefined);
  assert.equal(digest.feeds[1].video, undefined, 'no Dutch video yet: no feed of them');
  const feed = path(digest.feeds[0].video),
    key = new URL(feed, 'http://x').searchParams.get('key')!;
  assert.match(feed, /^\/onair\/digest\.en\.video\.xml\?key=/);
  const rss = await h.send(feed);
  assert.match(rss.text, /<title>The Digest \(English, video\)<\/title>/);
  assert.equal(rss.text.match(/<item>/g)?.length, 1, 'only the episodes with a video');
  assert.match(rss.text, /length="13" type="video\/mp4"/);
  const film = rss.text.match(/enclosure url="([^"]+)"/)![1].replace(/&#38;/g, '&');
  assert.equal((await h.send(path(film))).text, 'ftyp en video');
  assert.equal((await h.send(path(film).replace(key, 'wrong'))).status, 404);
  assert.equal((await h.send(feed.replace(key, 'wrong'))).status, 404);
});

test("nothing but a feed or an episode's sound comes out of the folder", async () => {
  const key = new URL(path((await listed()).digest.feeds[0].url), 'http://x').searchParams.get('key');
  for (const p of [
    '/onair/digest/2026-10-15/script.en.md',
    '/onair/nothing.en.xml',
    '/onair/digest/2026-10-15/../../../../company/org.yaml',
  ]) {
    const r = await h.send(`${p}?key=${key}`);
    assert.ok([302, 404].includes(r.status), `${p}: ${r.status}`); // (a path out of the folder reaches the login, as any page)
  }
});

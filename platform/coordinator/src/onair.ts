// On Air (shared/onair/README.md): the company's shows (company/shows.yaml) and their episodes, a folder each in
// knowledge/onair/<show>/ with a script and a render per language, its sound and maybe its video. An episode counts once
// its sound is in the checkout. For HQ's On Air, and a podcast feed per show and language for any podcast app (a second
// one with the videos, once there are any): the feeds and their files need no login, so a show for the board or for
// colleagues has a private link (its key, renewed from HQ, which ends the old one), and a public show's feed is open.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { parse } from 'yaml';
import { ORIGIN, REPO_DIR } from './config.ts';
import { db } from './db.ts';
import { frontmatter, names } from './company.ts';
import { sendToBoard } from './push.ts';

type Show = {
  id: string;
  name: string;
  at?: string;
  hosts?: string[];
  languages?: string[];
  audience?: string;
  about?: string;
  minutes?: number;
};
const LANGUAGE: Record<string, string> = { en: 'English', nl: 'Nederlands' };
const ID = /^[a-z0-9-]+$/,
  EPISODE = /^\d{4}-\d{2}-\d{2}(-\d+)?$/;
db.exec('create table if not exists onair_keys (show text primary key, key text not null)');

export function shows(): Show[] {
  const file = `${REPO_DIR}/company/shows.yaml`;
  try {
    const all = existsSync(file) ? (parse(readFileSync(file, 'utf8')) ?? []) : [];
    return (all as Show[]).filter(s => ID.test(String(s?.id)) && s.name);
  } catch (err) {
    console.error('Could not read shows.yaml:', err);
    return [];
  }
}
const languages = (s: Show) => (s.languages?.length ? s.languages : ['en']).filter(l => /^[a-z]{2}$/.test(l));

// Newest first: per language its title and summary (the script's front matter), its sound and its video if it has one
function episodes(s: Show) {
  const dir = `${REPO_DIR}/knowledge/onair/${s.id}`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(e => EPISODE.test(e))
    .sort()
    .reverse()
    .map(e => {
      const langs = Object.fromEntries(
        languages(s)
          .filter(l => existsSync(`${dir}/${e}/episode.${l}.mp3`))
          .map(l => {
            const script = `${dir}/${e}/script.${l}.md`,
              meta = existsSync(script) ? frontmatter(readFileSync(script, 'utf8')).meta : {},
              video = `${dir}/${e}/episode.${l}.mp4`;
            return [
              l,
              {
                title: String(meta.title ?? e),
                summary: meta.summary ? String(meta.summary) : '',
                audio: `/knowledge/onair/${s.id}/${e}/episode.${l}.mp3`,
                bytes: statSync(`${dir}/${e}/episode.${l}.mp3`).size,
                ...(existsSync(video)
                  ? { video: `/knowledge/onair/${s.id}/${e}/episode.${l}.mp4`, videoBytes: statSync(video).size }
                  : {}),
              },
            ];
          }),
      );
      return { id: e, date: e.slice(0, 10), langs };
    })
    .filter(e => Object.keys(e.langs).length);
}

function key(show: string) {
  const row = db.prepare('select key from onair_keys where show = ?').get(show) as { key: string } | undefined;
  return row?.key ?? renewKey(show);
}
function renewKey(show: string) {
  const k = randomBytes(18).toString('base64url');
  db.prepare('insert into onair_keys (show, key) values (?, ?) on conflict(show) do update set key = excluded.key').run(
    show,
    k,
  );
  return k;
}
const open = (s: Show) => s.audience === 'public';
const feed = (s: Show, name: string) => `${ORIGIN}/onair/${s.id}.${name}.xml${open(s) ? '' : `?key=${key(s.id)}`}`;

// HQ's On Air: the shows, their feeds and episodes (`run`: the show's recurring entry, for Run now); a language's feed
// of videos once one of its episodes has a video
export const board = () =>
  shows().map(s => {
    const all = episodes(s);
    return {
      id: s.id,
      name: s.name,
      about: s.about ?? '',
      hosts: s.hosts ?? [],
      audience: s.audience ?? 'board',
      minutes: s.minutes ?? null,
      run: `show-${s.id}`,
      feeds: languages(s).map(l => ({
        lang: l,
        language: LANGUAGE[l] ?? l,
        url: feed(s, l),
        ...(all.some(e => e.langs[l]?.video) ? { video: feed(s, `${l}.video`) } : {}),
      })),
      episodes: all,
    };
  });

// A new private link: the old one stops working in every podcast app that has it
export function renew(show: string) {
  const s = shows().find(x => x.id === show);
  if (!s) return [404, `No show ${show}`];
  if (open(s)) return [400, `${s.name} is public: its feed needs no link`];
  renewKey(s.id);
  return board().find(x => x.id === show);
}

const xml = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
function allowed(s: Show, given: string | null) {
  if (open(s)) return true;
  const k = Buffer.from(key(s.id)),
    g = Buffer.from(given ?? '');
  return g.length === k.length && timingSafeEqual(g, k);
}

// The feeds without a login (server.ts, before its sign-in check): /onair/<show>.<lang>.xml and each episode's sound,
// /onair/<show>/<episode>/episode.<lang>.mp3, both with the show's key; the same for the videos, <show>.<lang>.video.xml
// and episode.<lang>.mp4. A feed is { xml }, a file { file } (inside
// knowledge/), anything else null.
export function outside(path: string, given: string | null) {
  const m = path.match(
    /^\/onair\/([a-z0-9-]+)(?:\.([a-z]{2})(\.video)?\.xml|\/(\d{4}-\d{2}-\d{2}(?:-\d+)?)\/episode\.([a-z]{2})\.(mp3|mp4))$/,
  );
  const s = m && shows().find(x => x.id === m[1]),
    lang = m?.[2] ?? m?.[5];
  if (!m || !s || !lang || !languages(s).includes(lang) || !allowed(s, given)) return null;
  if (m[4]) return { file: `/onair/${s.id}/${m[4]}/episode.${lang}.${m[6]}` };
  const video = !!m[3],
    q = open(s) ? '' : `?key=${key(s.id)}`,
    company = names().name;
  const items = episodes(s)
    .filter(e => (video ? e.langs[lang]?.video : e.langs[lang]))
    .map(e => {
      const x = e.langs[lang],
        [file, bytes, type] = video ? ['mp4', x.videoBytes, 'video/mp4'] : ['mp3', x.bytes, 'audio/mpeg'];
      return (
        `<item><title>${xml(x.title)}</title><description>${xml(x.summary)}</description>` +
        `<enclosure url="${xml(`${ORIGIN}/onair/${s.id}/${e.id}/episode.${lang}.${file}${q}`)}" length="${bytes}" type="${type}"/>` +
        `<guid isPermaLink="false">${xml(`${s.id}/${e.id}/${lang}${video ? '/video' : ''}`)}</guid><pubDate>${new Date(`${e.date}T06:00:00Z`).toUTCString()}</pubDate></item>`
      );
    });
  const also = [...(languages(s).length > 1 ? [LANGUAGE[lang] ?? lang] : []), ...(video ? ['video'] : [])],
    title = also.length ? `${s.name} (${also.join(', ')})` : s.name;
  return {
    xml:
      `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">` +
      `<channel><title>${xml(title)}</title><link>${xml(ORIGIN)}</link><language>${lang}</language>` +
      `<description>${xml(s.about ?? s.name)}</description><itunes:author>${xml(company)}</itunes:author>` +
      `<itunes:image href="${xml(`${ORIGIN}/icon-512.png`)}"/>${open(s) ? '' : '<itunes:block>yes</itunes:block>'}${items.join('')}</channel></rss>`,
  };
}

// A new episode arrives with a deploy, once its sound is in the checkout: announced once, as a push, as the Gazette's
// posts are (company.ts watchGazette). On the first run, what's there already counts as announced.
export function watchOnAir() {
  const check = () => {
    const all = shows().flatMap(s => episodes(s).map(e => ({ s, e, id: `${s.id}/${e.id}` })));
    const row = db.prepare("select value from settings where key = 'onair.announced'").get() as
      { value: string } | undefined;
    const known = new Set<string>(row ? JSON.parse(row.value) : all.map(x => x.id));
    const fresh = all.filter(x => !known.has(x.id)).reverse();
    for (const { s, e } of fresh) {
      const title = Object.values(e.langs)[0].title;
      sendToBoard({
        title: `On Air: ${s.name} 🎙️`,
        body: title.slice(0, 200),
        tag: `onair-${s.id}`,
        url: '/?open=onair',
      }).catch(err => console.error('Could not announce the episode:', err));
    }
    if (fresh.length || !row)
      db.prepare(
        "insert into settings (key, value) values ('onair.announced', ?) on conflict(key) do update set value = excluded.value",
      ).run(JSON.stringify([...new Set([...known, ...all.map(x => x.id)])]));
  };
  const safe = () => {
    try {
      check();
    } catch (err) {
      console.error('On Air watch:', err);
    }
  };
  safe();
  setInterval(safe, 60_000);
}

// hq revert <commit>... "why": the CEO reverts commits on main through the server, which makes the revert at its next
// sync (infra/revert.py, within a minute) and deploys it. A request is a file in the data folder's reverts/, its answer
// left beside it, read here before every claim with the deploy records (wakes.ts). The work reverted stays on its
// branches, to come back once fixed.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { DATA_DIR } from './config.ts';
import { remember, setting } from './db.ts';
import { publish } from './events.ts';
import { ceo } from './company.ts';

const KEPT = 10; // the answers hq revert lists
const folder = () => `${DATA_DIR}/reverts`;
type Asked = { id: string; commits: string[]; why: string; at: string; said?: string; ok?: boolean };

export function request(commits: string[], why: string, by: string): { id: string } | string {
  if (by !== ceo()) return `only the CEO reverts commits on main: ask ${ceo()}`;
  if (!commits.length || !commits.every(c => /^[0-9a-f]{7,40}$/.test(c)))
    return 'name the commits by their ids: hq revert <commit>... "why"';
  if (!why.trim()) return 'say why: hq revert <commit>... "why"';
  mkdirSync(folder(), { recursive: true });
  const id = String(Date.now());
  writeFileSync(`${folder()}/.${id}`, JSON.stringify({ commits, why: why.slice(0, 200) }));
  renameSync(`${folder()}/.${id}`, `${folder()}/${id}.json`);
  keep({ id, commits, why, at: new Date().toISOString() });
  publish({ type: 'log', agent: by, text: `Asked the server to revert ${short(commits)} on main: ${why}` });
  return { id };
}

// The requests, newest first, each with the server's answer once it came
export const list = (): Asked[] => JSON.parse(setting('reverts') || '[]');

// The server's answers, each said in HQ's feed and kept with its request; the files go
export function readAnswers() {
  let names: string[];
  try {
    names = readdirSync(folder()).filter(n => n.endsWith('.done'));
  } catch {
    return;
  }
  for (const name of names) {
    const id = name.slice(0, -'.done'.length);
    try {
      const { ok, said } = JSON.parse(readFileSync(`${folder()}/${name}`, 'utf8'));
      const asked = list().find(r => r.id === id);
      if (asked) keep({ ...asked, ok: ok === true, said: String(said).slice(0, 300) });
      const what = asked ? short(asked.commits) : `request ${id}`;
      publish({
        type: 'log',
        agent: ceo(),
        text:
          ok === true ? `The server reverted ${what} on main: ${said}` : `The server didn't revert ${what}: ${said}`,
      });
      rmSync(`${folder()}/${id}.json`, { force: true });
      rmSync(`${folder()}/${name}`);
    } catch (err) {
      console.error(`reverts: the answer ${name} wasn't read:`, (err as Error).message);
    }
  }
}

function keep(r: Asked) {
  remember('reverts', JSON.stringify([r, ...list().filter(o => o.id !== r.id)].slice(0, KEPT)));
}
const short = (commits: string[]) => commits.map(c => c.slice(0, 9)).join(', ');

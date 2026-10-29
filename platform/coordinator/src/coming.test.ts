// node --test src/coming.test.ts   (a throwaway git repo and database): the status report's "coming to the foundation"
// list, the marked changes on main and the open pull requests touching the foundation's paths.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { coming, section } from './coming.ts';

// (built, so the foundation's own grep doesn't find this file's examples)
const mark = (job: number, more = ', not upstream yet') => `company${': job'} #${job}${more}`;

const repo = mkdtempSync(`${tmpdir()}/coming-test-`);
after(() => rmSync(repo, { recursive: true, force: true }));
const files: Record<string, string> = {
  'platform/coordinator/src/a.ts': `// one (${mark(12)})\n// and another (${mark(14)})\n`,
  'platform/hq/b.js': `// ${mark(12)}\n// a long line that ends with the start of its marker (company${': job'}\n// #18, not upstream yet)\n`,
  // wrapped over two lines, as long comments are
  'infra/report.sh': `# the report (company${': job'} #14, not\n# upstream yet)\n`,
  'shared/craft/c.md': `${mark(15, ', kept here')}\n`,
  // several jobs' marks: 'and', commas, both, wrapped
  'platform/hq/d.js': `// company${': jobs'} #19 and #12, not upstream yet\n// (company${': jobs'} #23, #24 and\n// #25, not upstream yet)\n`,
  'shared/e.ts': `// company${': jobs'} #26, #27, kept here\n`,
  'products/shop/app.ts': `// ${mark(16)}\n`,
  'company/notes.md': `${mark(17)}\n`,
};
for (const [file, text] of Object.entries(files)) {
  mkdirSync(dirname(`${repo}/${file}`), { recursive: true });
  writeFileSync(`${repo}/${file}`, text);
}
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['-C', repo, 'add', '.']); // (git grep reads tracked files, as on the server's checkout)

const db = new DatabaseSync(':memory:');
db.exec('create table jobs (id integer primary key, title text not null)');
db.exec(
  'create table prs (number integer primary key, branch text not null, status text not null, files text not null)',
);
const job = db.prepare('insert into jobs (id, title) values (?, ?)');
job.run(12, 'Overrun pings ring against the latest size\nand a second line');
job.run(14, 'x'.repeat(200));
job.run(20, 'A new route for the Overseer');
job.run(21, 'A product page');
job.run(22, 'Merged long ago');
const pr = db.prepare('insert into prs (number, branch, status, files) values (?, ?, ?, ?)');
pr.run(
  501,
  'job/20',
  'open',
  JSON.stringify(['platform/coordinator/src/server.ts', 'company/DECISIONS.md', 'infra/sync.sh']),
);
pr.run(502, 'job/21', 'open', JSON.stringify(['products/shop/app.ts', 'platforms.md']));
pr.run(503, 'job/22', 'merged', JSON.stringify(['platform/x.ts']));
pr.run(504, 'job/20', 'stuck', JSON.stringify(Array.from({ length: 10 }, (_, i) => `shared/f${i}.ts`)));
pr.run(505, 'deploy', 'open', JSON.stringify(['platform/y.ts']));

test('marked changes on main and open pull requests, foundation files only', async () => {
  const list = await coming(repo, db);
  assert.deepEqual(
    list.marked.map(c => [c.job, c.files]),
    [
      [12, ['platform/coordinator/src/a.ts', 'platform/hq/b.js', 'platform/hq/d.js']],
      [14, ['infra/report.sh', 'platform/coordinator/src/a.ts']],
      [18, ['platform/hq/b.js']],
      [19, ['platform/hq/d.js']],
      [23, ['platform/hq/d.js']],
      [24, ['platform/hq/d.js']],
      [25, ['platform/hq/d.js']],
    ],
    "by job, wrapped markers and several jobs' too; one kept here isn't coming, nor anything outside the foundation",
  );
  assert.equal(list.marked[0].title, 'Overrun pings ring against the latest size', "the title's first line");
  assert.equal(list.marked[1].title.length, 120, 'a long title cut');
  assert.deepEqual(
    list.open.map(c => [c.job, c.pr, c.files.length]),
    [
      [20, 501, 2],
      [20, 504, 10],
    ],
    "open, stuck or with the board, from a job's branch, touching the foundation",
  );
  assert.deepEqual(list.open[0].files, ['infra/sync.sh', 'platform/coordinator/src/server.ts']);

  const text = section(list);
  assert.match(text, /^marked on main, not carried back yet: 7$/m);
  assert.match(
    text,
    /^#12 · platform\/coordinator\/src\/a\.ts, platform\/hq\/b\.js, platform\/hq\/d\.js · Overrun pings ring against the latest size$/m,
  );
  assert.match(text, /^in open pull requests: 2$/m);
  assert.match(
    text,
    /^#20 · PR #501 · infra\/sync\.sh, platform\/coordinator\/src\/server\.ts · A new route for the Overseer$/m,
  );
  // every file, so overlapping work shows however big the change
  const ten = Array.from({ length: 10 }, (_, i) => `shared/f${i}.ts`).join(', ');
  assert.ok(text.includes(`#20 · PR #504 · ${ten} · A new route`));
});

test('nothing coming: both counts say none', async t => {
  const empty = mkdtempSync(`${tmpdir()}/coming-empty-`);
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', empty]);
  const none = new DatabaseSync(':memory:');
  none.exec('create table jobs (id integer primary key, title text not null)');
  none.exec(
    'create table prs (number integer primary key, branch text not null, status text not null, files text not null)',
  );
  assert.equal(
    section(await coming(empty, none)),
    'marked on main, not carried back yet: 0\n\nin open pull requests: 0',
  );
});

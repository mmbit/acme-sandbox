// The test company with two projects, game (wren's) and shop (moss's), for the tests of what holds a project's work
// (pauses.test.ts, decisions.test.ts): the harness, threads made in a project, and a job's engine to claim it with.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

export async function projectsHarness(name: string) {
  const h = await harness(name, {
    before: repo =>
      writeFileSync(
        `${repo}/company/projects.yaml`,
        'projects:\n  - { id: game, name: The game, owner: wren }\n  - { id: shop, name: The shop, owner: moss }\n',
      ),
  });
  const projects = await import('./projects.ts');
  const thread = (slug: string, project = 'game') => {
    const t = projects.createThread({ project, name: `Thread ${slug}`, goal: 'It works', slug });
    assert.equal(typeof t, 'object', typeof t === 'string' ? t : '');
    return (t as { id: string }).id;
  };
  const engineOf = (id: number) =>
    (h.db.prepare('select engine from jobs where id = ?').get(id) as { engine: string }).engine;
  return { h, projects, thread, engineOf };
}

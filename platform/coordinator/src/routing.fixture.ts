// The tests' shared fixture for the board's sent notes: the CEO's routing check run the way the worker and the CEO run
// it, through the claim, a task of the notes (hq job --notes: routing's forTask) and the finish.
import assert from 'node:assert/strict';

const EVER = new Date(0).toISOString();

// After the coordinator's DATA_DIR and repo are set, as it imports the coordinator's modules.
export async function routingFixture() {
  const jobs = await import('./jobs.ts');
  const routing = await import('./routing.ts');
  // The check claimed (first in the claim's order on its agent's engine), every note it routes made a task for `to` (by
  // default the notes' owner: one owner's notes), and the check finished. The task, whose it is, and how.
  const routed = (check: number, to?: string, thread?: string) => {
    const claimed = jobs.claim(`routing-${check}`, jobs.findAgent(jobs.jobAgent(check)!)!.engine);
    assert.equal(claimed?.id, check, `check #${check} is claimed first`);
    const owner =
      to ??
      (routing.log(EVER) as { job: number; routed: string | null; owner: string }[]).find(
        r => r.job === check && !r.routed,
      )!.owner;
    const me = { id: check, agent: claimed.agent };
    const notes = (routing.log(EVER) as { note: number; job: number; routed: string | null }[])
      .filter(r => !r.routed)
      .map(r => r.note);
    const task = routing.forTask(me, owner, notes);
    assert.ok(typeof task === 'object', `routed: ${task}`);
    const { id: job } = jobs.createJob({
      agent: owner,
      title: 'The notes’ work',
      prompt: task.text,
      queuedBy: me.agent,
      thread,
    });
    task.take(job);
    jobs.finish(check, { status: 'done' });
    return { job, agent: owner, how: 'task' as const };
  };
  return { routed };
}

// The board's notes as HQ's Reviews sent them before they went to its book: each a waiting review note, and its send,
// queued for the CEO's routing check (routing.queue, which the book still uses for a sheet nobody's seat can take), a
// product's notes with the return they owe. The check's job, the router, and how many went.
export async function sentNotes() {
  const { db } = await import('./db.ts');
  const feedback = await import('./feedback.ts');
  const routing = await import('./routing.ts');
  const owed = await import('./owed.ts');
  const { ceo } = await import('./company.ts');
  const { findAgent } = await import('./jobs.ts');
  const pin = (slug: string, words: string) =>
    Number(
      db
        .prepare(
          `insert into review_notes (created, slug, page, element, note, viewport, status, about)
           values (?, ?, '/', '{"kind":"general"}', ?, '{}', 'pending', ?)`,
        )
        .run(new Date().toISOString(), slug, words, slug).lastInsertRowid,
    );
  const send = (slug: string, ids: number[]) => {
    const { agent: owner, name } = feedback.ownerOf(slug);
    const place = `${name} (${slug === feedback.HQ ? 'platform/hq' : owed.folder(slug)})`;
    const notes = ids.map(id => db.prepare('select * from review_notes where id = ?').get(id));
    const job = routing.queue(
      notes.map((n: any) => ({
        id: n.id,
        slug,
        owner,
        name,
        place,
        returns: slug !== feedback.HQ,
        text: feedback.noteText(n),
      })),
    );
    for (const id of ids) db.prepare("update review_notes set status = 'sent', job = ? where id = ?").run(job, id);
    return { job, agent: ceo(), name: findAgent(ceo())!.name, count: ids.length };
  };
  return { pin, send };
}

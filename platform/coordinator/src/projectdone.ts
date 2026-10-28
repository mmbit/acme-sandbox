// A project's end, apart from the rest of its plan (plan.ts, which hands it on): the schedule ends a routine's project
// by the same rules (schedule.ts keepProjects), and loads before plan.ts's imports can.
// (its messages say deliverable, the board's word for a thread)
import { db, mergePending, planChange } from './db.ts';
import { projects } from './company.ts';
import { findProject } from './projects.ts';
import { anyProject } from './names.ts';
import { refusal } from './threadorder.ts';
import { manifests } from './manifests.ts'; // (a leaf: apps.ts would load payments.ts's circle before it's whole)

// hq project done: a finished project, by its owner or the CEO, leaves the lists (it stays among the projects view's
// completed). Refused while it has open threads, work still to run or in review, or proposals waiting in its inbox, and
// while HQ makes jobs into it (made.ts: projects.yaml's `made:`, a live product's `project:`), which then couldn't go
// there.
export function projectDone(id: string, agent: string) {
  const project = findProject(id);
  if (!project) return anyProject(id)?.status === 'done' ? `${id} is done already` : `there's no project "${id}"`;
  const refused = refusal(project, agent);
  if (refused) return refused;
  const threads = db
    .prepare("select id from threads where project = ? and status = 'open' order by created")
    .all(id) as {
    id: string;
  }[];
  const work = db
    .prepare(
      `select j.id from jobs j where ${mergePending('j')} and j.thread in (select id from threads where project = ?) order by j.id`,
    )
    .all(id) as { id: number }[];
  const proposed = db.prepare("select id from proposals where project = ? and status = 'open' order by id").all(id) as {
    id: number;
  }[];
  const makers = madeInto(id);
  const left = [
    threads.length && `open deliverables ${threads.map(t => t.id).join(', ')} (hq plan done, or hq deliverable move)`,
    work.length && `work still to run or in review: ${work.map(j => `#${j.id}`).join(', ')}`,
    proposed.length && `proposals in its inbox: ${proposed.map(p => `#${p.id}`).join(', ')} (hq inbox)`,
    makers.length && `HQ's own jobs going to it: move ${makers.join(', ')} to another open project`,
  ].filter(Boolean);
  if (left.length) return `${id} isn't done yet: it has ${left.join('; ')}`;
  db.prepare("update projects set status = 'done', done = ? where id = ?").run(new Date().toISOString(), id);
  planChange({ project: id, what: 'project done', by: agent });
  return { ok: true as const };
}

// What makes HQ's own jobs in a project: the kinds and apps projects.yaml's `made:` sends there, and the products set
// live whose product.yaml names it (the watch's repairs, once the board's approval opens them).
function madeInto(project: string) {
  const kinds = Object.entries(projects().made).flatMap(([kind, apps]) =>
    Object.entries(apps).flatMap(([app, to]) => (to === project ? [`projects.yaml made.${kind}.${app}`] : [])),
  );
  const products = manifests().flatMap(({ slug, manifest: product }) =>
    product.status === 'live' && product.project === project ? [`products/${slug}/product.yaml project`] : [],
  );
  return [...kinds, ...products];
}

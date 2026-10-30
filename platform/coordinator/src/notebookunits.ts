// The notebook's groups from before scrap units carried into units, once (notebookgroups.ts has the units)
import { db, once } from './db.ts';
import { partsJson, partsOf, type Group } from './notebookgroups.ts';
import { inReadingOrder, lastPos } from './notebookorder.ts';
import { boxOf } from '../../hq/shell/ink/notebookstack.js';
import { roomFor, unitOf } from '../../hq/shell/ink/scrapunit.js';

// The groups from before scrap units, in their pages' px, as units: each moved to its own top-left (scaled down where
// wider than a unit), in reading order of where it stood on its page, with room under what an agent put there. Deleted
// ones too, which Undo may bring back. An answer slips under its scrap, so no answer keeps a spot beside one.
export function toUnits() {
  const old = db
    .prepare(
      `select g.*, p.who from notebook_groups g join book_pages p on p.id = g.page where g.parent is null and g.h is null
      order by g.page`,
    )
    .all() as (Group & { who: string })[];
  for (const page of new Set(old.map(g => g.page))) {
    const start = lastPos(page) + 1,
      placed = old.filter(g => g.page === page).map(g => ({ id: g.id, g, box: boxOf(partsOf(g)) }));
    inReadingOrder(placed).forEach(({ g }, i) => {
      const unit = unitOf(partsOf(g), roomFor(g.by, g.who));
      db.prepare(
        'update notebook_groups set ink = ?, texts = ?, pictures = ?, pos = ?, h = ?, asked_spot = null where id = ?',
      ).run(...partsJson(unit.parts), start + i, unit.h, g.id);
    });
  }
  db.exec('update book_slips set spot = null where grp is not null');
}
once('2026-10-30-scrap-units', toUnits);

// Inspect legacy guest drawings, or copy one onto an explicitly chosen managed Notebook page.
import { inventory, migrateSketch } from '../src/ink/sketchmigration.ts';

const [command, source, target, ...extra] = process.argv.slice(2);
if (command === 'inventory' && source === undefined) console.log(JSON.stringify(inventory(), null, 2));
else if (command === 'copy' && /^\d+$/.test(source ?? '') && /^\d+$/.test(target ?? '') && !extra.length)
  console.log(JSON.stringify(migrateSketch(Number(source), Number(target))));
else throw new Error('Use guest-sketches.ts inventory, or guest-sketches.ts copy SOURCE_PAGE TARGET_PAGE.');

// What a check of HQ on the real coordinator (guestserver.mjs coordinator()) shares with the next: its --shots folder,
// the devices it opens on HQ's origin as the coordinator answers it (guestserver.mjs openVisitor), the coordinator's
// answers to its own requests, and the teardown. give-check.mjs and guestcall-check.mjs.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { openVisitor } from './guestserver.mjs';

const arg = name => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
// The body of the coordinator's answer to a check's own request, which must be a 200
export const said = r => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};

// browser: launched()'s; state: coordinator()'s
export function devices(browser, state) {
  const shots = arg('--shots');
  if (shots) mkdirSync(shots, { recursive: true });
  const visits = { ...state, browser, opened: [] };
  return {
    // A step's screenshot, with --shots
    shot: async (name, page) => shots && (await page.screenshot({ path: `${shots}/${name}.png` })),
    // A touch device signed in by its session's cookie (options as openVisitor's): its context and page
    open: (viewport, cookie, options) => openVisitor(visits, viewport, cookie, browser, options),
    // No page threw, crashed or opened a dialog
    clean() {
      for (const { errors } of visits.opened) assert.deepEqual(errors, []);
    },
    async close() {
      for (const { context } of visits.opened) {
        await context.unrouteAll({ behavior: 'ignoreErrors' });
        await context.close();
      }
      await browser.close();
      state.h.server.closeAllConnections();
      state.h.server.close();
    },
  };
}

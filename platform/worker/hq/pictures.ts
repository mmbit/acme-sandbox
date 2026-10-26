// Pictures the board shared on the intercom or a call (#<id> in the line or transcript), saved so a job can look at
// them.
import { ApiError, getJson } from './api.ts';
import { savePicture } from './files.ts';
import { minute, print, stop, text, warn } from './output.ts';

const USAGE = 'usage: hq picture <id> [id...]';

export const picture = {
  help: `
   hq picture <id> [id...]                           save pictures the board shared on the intercom or a call (#<id> in the
                                                     line or transcript) to $TMPDIR/picture-<id>.XXXXXX.jpg|png, so you can
                                                     look at them`,

  async run(ids: string[]) {
    if (!ids[0]) stop(USAGE);
    let missing = false;
    for (const given of ids) {
      const id = given.replace(/^#/, '');
      if (!/^[0-9]+$/.test(id)) stop(USAGE);
      let shared;
      try {
        shared = await getJson(`picture?id=${id}`);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        warn(`Picture #${id}: not found (or not shared with this job).`);
        missing = true;
        continue;
      }
      const path = savePicture(`picture-${id}`, shared.type, text(shared.data));
      const created = minute(text(shared.created));
      print(`Picture #${id} (${text(shared.from)}, ${created}) → ${path}`);
    }
    if (missing) stop('');
  },
};

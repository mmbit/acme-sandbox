// What book-check.mjs's story files share for a preview in HQ's viewer, review mode running in its frame.
import { fulfilPart } from '../../../shared/review/parts.mjs';

export const PREVIEW = 'https://scrap.preview.test';
const PREVIEW_PAGE = `<!doctype html><meta name="viewport" content="width=device-width"><title>Basket</title>
<body style="margin: 0; font: 16px system-ui, sans-serif">
<h1 style="margin: 24px">Your basket</h1>
<p style="margin: 24px; max-width: 30em">Two jars of plum jam, gift-wrapped, at the pick-up point by Friday.</p>
<script src="/__review/review.js"></script>`;
// The preview at PREVIEW served to context, each note posted from it kept in c.posts (c.reviewJs: review mode's script)
export async function previewServed(c, context) {
  await context.route(/\/api\/preview\/link$/, r => r.fulfill({ json: { url: r.request().postDataJSON().url } }));
  await context.route(`${PREVIEW}/**`, r => {
    const path = new URL(r.request().url()).pathname;
    if (fulfilPart(r, path, c.reviewJs)) return;
    // the board's note: the coordinator makes it a scrap on My journal's current page (bookreview.ts)
    if (path === '/__review/notes' && r.request().method() === 'POST') {
      const body = r.request().postDataJSON();
      c.posts.push({ path, body });
      const { v, url, el, view, ink } = body.element ?? {},
        g = context.notebook.route(
          '/api/notebooks/groups/scrap',
          {},
          {
            anchor: { v, url, el, view, ink },
            words: body.note,
            said: body.said === 'spoken' ? 'spoken' : 'typed',
            snip: body.shot,
            owner: 'juno',
          },
        );
      return r.fulfill({ json: { ok: true, id: g.id, page: g.page, owner: 'juno', name: 'Juno' } });
    }
    if (path.startsWith('/__review/')) return r.fulfill({ json: { show: false } });
    return r.fulfill({ contentType: 'text/html', body: PREVIEW_PAGE });
  });
}

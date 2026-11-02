// Temporary marks on viewed work travel only over the board's live feed, never into the notebook or event history.
import { anchorOf, isRefused, type Refused } from './pagechecks.ts';
import { publish } from './events.ts';

export function shareMarks(body: any): { ok: true } | Refused {
  if (typeof body?.device !== 'string' || !/^[0-9a-f-]{36}$/.test(body.device))
    return [400, 'live marks name their drawing device'];
  const anchor = anchorOf(body.anchor);
  if (isRefused(anchor)) return anchor;
  if (!URL.canParse(anchor.url)) return [400, 'live marks name an absolute web page address'];
  const url = new URL(anchor.url);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !(anchor.view.w > 0 && anchor.view.h > 0)
  )
    return [400, 'live marks name a web page and its visible size'];
  publish({ type: 'viewmarks', marks: { device: body.device, anchor: { ...anchor, url: url.href } } });
  return { ok: true };
}

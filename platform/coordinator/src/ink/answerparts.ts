// What an agent's answer holds (hq answer: bookanswer.ts answer), checked: its words, style and the rest
import * as asking from '../../../hq/shell/questions.js';
import { ARTIFACT, LINK_MAX, SLIP_MAX, type More } from './bookslips.ts';
import { dataUrlPicture, GROWN_MAX, inkOf, isRefused, type Refused, type Stroke } from '../pagechecks.ts';
import { boxOf } from '../../../hq/shell/ink/notebookstack.js';

// A patch kept with a version, and a picture's source line (where a chart's numbers came from)
const PATCH_MAX = 1_000_000,
  SOURCE_MAX = 200;

export function partsOfAnswer(b: any): { text: string; more: More; patch: string | null } | Refused {
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (text.length > SLIP_MAX) return [400, `an answer's text is at most ${SLIP_MAX} characters`];
  const link = b.link == null ? null : String(b.link);
  if (link !== null && !(/^https:\/\/[^\s]+$/.test(link) && link.length <= LINK_MAX))
    return [400, 'a link is an https address'];
  const picture = b.picture == null ? null : dataUrlPicture(b.picture);
  if (isRefused(picture)) return picture;
  const artifact = b.artifact ?? null;
  if (
    artifact !== null &&
    !(typeof artifact === 'string' && ARTIFACT.test(artifact) && !artifact.split('/').includes('..'))
  )
    return [400, "an artifact is its id, as HQ's artifacts list it: an app's slug, or a path"];
  const ink = b.ink == null ? null : inkOf(b.ink);
  if (isRefused(ink)) return ink;
  const form = b.form == null ? null : asking.questions(b.form);
  if (typeof form === 'string') return [400, `a form: ${form}`];
  const version = b.version == null ? null : String(b.version).trim();
  if (version !== null && !/^\S+( \S+)?$/.test(version)) return [400, "a version's name is two words"];
  if (version !== null && !picture) return [400, 'a version is a picture of the thing changed: --picture'];
  const patch = b.patch == null ? null : String(b.patch);
  if (patch !== null && (!version || patch.length > PATCH_MAX))
    return [400, `a patch (at most ${PATCH_MAX} bytes) goes with a version`];
  const source = sourceOf(b.source, !!picture);
  if (isRefused(source)) return source;
  const style = version ? 'version' : form ? 'form' : b.asks ? 'question' : ink ? 'drawing' : 'text';
  if (!text && !picture && !ink?.length && !version) return [400, 'an answer is text, a picture, ink or a version'];
  if ((style === 'form' || style === 'question') && !text) return [400, `a ${style} has words: what it asks`];
  const far = ink && inkTooFar(ink);
  if (far) return far;
  return {
    text,
    patch,
    more: {
      picture,
      link,
      artifact,
      style,
      version,
      ink: ink && JSON.stringify(ink),
      form: form && JSON.stringify(form),
      source,
    },
  };
}

// Where a picture's numbers came from, as one line (null: none given)
function sourceOf(given: unknown, pictured: boolean): string | null | Refused {
  if (given == null) return null;
  const source = String(given).replace(/\s+/g, ' ').trim();
  if (!source || source.length > SOURCE_MAX)
    return [400, `a source is one line of at most ${SOURCE_MAX} characters: where the numbers came from`];
  return pictured ? source : [400, 'a source goes under a picture: where its numbers came from'];
}

// An answer's ink no bigger than a page grows and no further from the answer's top-left (its picture a page's size:
// bookrender.ts), refused where it is
function inkTooFar(ink: Stroke[]) {
  const inkBox = boxOf({ ink, texts: [], pictures: [] });
  const reach = inkBox && Math.max(inkBox.w, inkBox.h, inkBox.x + inkBox.w, inkBox.y + inkBox.h, -inkBox.x, -inkBox.y);
  if (reach && reach > GROWN_MAX)
    return [
      400,
      `an answer's ink fits on a page: at most ${GROWN_MAX} px a side, from the answer's top-left`,
    ] as Refused;
  return null;
}

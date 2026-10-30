// The shared Notebook's guest scope and its authenticated routes. The server owns page access.
import { act, refused } from '../data.js';
import { refusals } from './notebookwords.js';
import { shell } from './notebookshellwords.js';

export let scope = null;
export const setScope = value => {
  scope = value;
};
// The shell's own words: the board's English, or under a guest scope the guest's language (notebookshellwords.js),
// {places} filled from places. A word the table lacks is ours to add, so it stops rather than show English.
export function word(en, places = {}) {
  const lang = scope ? document.documentElement.lang : 'en',
    said = lang === 'en' ? en : shell[lang][en];
  if (said === undefined) throw new Error(`notebookshellwords.js has no ${lang} for “${en}”`);
  return said.replace(/\{(\w+)\}/g, (_, k) => places[k]);
}
export const scopedUrl = url =>
  scope ? url.replace('/api/notebooks', scope.api).replace('/api/book', `${scope.api}/book`) : url;
export async function notebookRequest(url, body) {
  if (!scope) return act(url, body);
  const blob = body instanceof Blob;
  const response = await fetch(scopedUrl(url), {
    credentials: 'same-origin',
    method: body === undefined ? 'GET' : 'POST',
    headers:
      body === undefined ? { accept: 'application/json' } : { 'content-type': blob ? body.type : 'application/json' },
    ...(body === undefined ? {} : { body: blob ? body : JSON.stringify(body) }),
  });
  const answer = await response.json();
  if (!response.ok)
    throw refused(
      response.status,
      refusals[answer.reason]?.[document.documentElement.lang] ?? answer.error,
      answer.reason,
    );
  return answer;
}

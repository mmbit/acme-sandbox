// The shared Notebook's guest scope and its authenticated routes. The server owns page access.
import { act, refused } from '../data.js';
import { refusal, words } from './notebookwords.js';
import { shell } from './notebookshellwords.js';

export let scope = null;
export const setScope = value => {
  scope = value;
};
// The book's language: the board's English, or under a guest scope the guest's
export const bookLang = () => (scope ? document.documentElement.lang : 'en');
// The shell's own words in the book's language (notebookshellwords.js), {places} filled from places. A word the table
// lacks is ours to add, so it stops rather than show English.
export function word(en, places = {}) {
  const lang = bookLang(),
    said = lang === 'en' ? en : shell[lang][en];
  if (said === undefined) throw new Error(`notebookshellwords.js has no ${lang} for “${en}”`);
  return said.replace(/\{(\w+)\}/g, (_, k) => places[k]);
}
// What follows an agent's name in a guest's book to say it's an AI's, in the guest's language; nothing in the board's
// own book (charter rule 5.)
export const aiMark = () => (scope ? words[document.documentElement.lang].aiAgent : '');
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
      refusal(document.documentElement.lang, answer.reason, scope.limits) ?? answer.error,
      answer.reason,
    );
  return answer;
}

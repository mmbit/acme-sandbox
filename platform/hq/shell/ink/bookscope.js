// The shared Notebook's guest scope and its authenticated routes. The server owns page access.
import { act, refused } from '../data.js';
import { scopedPath } from './bookroutes.js';
import { refusal, words } from './notebookwords.js';

export let scope = null;
export const setScope = value => {
  scope = value;
};
// The book's language: the board's English, or under a guest scope the guest's
export const bookLang = () => (scope ? document.documentElement.lang : 'en');
// A guest word by its key in the book's language (notebookwords.js), {places} filled from places. A word the table
// lacks is ours to add, so it stops rather than show English.
export function word(key, places = {}) {
  const lang = bookLang(),
    said = words[lang][key];
  if (said === undefined) throw new Error(`notebookwords${lang}.js has no “${key}”`);
  return said.replace(/\{(\w+)\}/g, (_, k) => places[k]);
}
// What follows an agent's name in a guest's book to say it's an AI's, in the guest's language; nothing in the board's
// own book (charter rule 5.)
export const aiMark = () => (scope ? words[document.documentElement.lang].aiAgent : '');
export const scopedUrl = url => (scope ? scopedPath(url, scope.api) : url);
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

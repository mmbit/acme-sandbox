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
  if (!scope)
    return act(url, body).catch(e => {
      throw bookRefused(e.status, e.message, e.reason);
    });
  const blob = body instanceof Blob;
  const response = await fetch(scopedUrl(url), {
    credentials: 'same-origin',
    method: body === undefined ? 'GET' : 'POST',
    headers:
      body === undefined ? { accept: 'application/json' } : { 'content-type': blob ? body.type : 'application/json' },
    ...(body === undefined ? {} : { body: blob ? body : JSON.stringify(body) }),
  });
  const answer = await response.json();
  if (!response.ok) throw bookRefused(response.status, answer.error, answer.reason);
  return answer;
}
// A refusal as the book says it on the page. A reason's are worded for the person reading (notebookwords.js, the
// store's own in the board's book); a 400 without one is a request out of shape, worded by the store's checks for
// whoever wrote it (an agent, or this page's own mistake): our internals, so the page says a plain line and the store's
// words go to the console for us.
export function bookRefused(status, error, reason) {
  if (status === 400 && !reason) {
    console.error(`[hq] book: the store refused a request: ${error}`);
    return refused(status, word('notThrough'));
  }
  return refused(status, (scope && refusal(document.documentElement.lang, reason, scope.limits)) ?? error, reason);
}

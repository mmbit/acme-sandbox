// The guest words: the Notebook's controls, status words and refusals in the reader's language, one key space for all
// three (notebookwordsen.js holds the English the board's book shows).
import { en } from './notebookwordsen.js';
import { nl } from './notebookwordsnl.js';
import { de } from './notebookwordsde.js';

export const words = { en, nl, de };

// A word's {places} filled from places
export const filled = (said, places = {}) => said.replace(/\{(\w+)\}/g, (_, k) => places[k]);

// A refusal's words in the reader's language, a limit's filled in from the server's (the list's limits)
export function refusal(lang, reason, limits) {
  const said = words[lang]?.refusals[reason];
  return typeof said === 'function' ? said(limits) : said;
}

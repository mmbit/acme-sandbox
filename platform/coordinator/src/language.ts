// The board's language: one setting for everything the person running the company reads and hears from its agents
// (calls' speech and hearing, the company phone's voice line, and what agents write for it: cards, reports, decks, the
// newsletter, the intercom's answers, the plan's names). Code and the agents' own documents stay English, and
// customers' languages are their own (Care's), though a guest's page and the share doors have their words in each of
// these (guests.ts COPY, shares.ts). The intake's first question sets it (POST /api/language) and Settings › Language
// changes it. HQ's shell reads it from GET /api/language for the calls and the voice preview, but its own text is
// English for now.
import { setting, remember } from './db.ts';

// The languages that work end to end: the model speaks and writes them, the voice line says them (platform/voice
// pockets) and hears them (its recogniser, and the intercom's transcriber, voice.ts), each by its English name for
// prompts and its own for the board's choice.
export const LANGUAGES = {
  en: { name: 'English', own: 'English' },
  nl: { name: 'Dutch', own: 'Nederlands' },
  de: { name: 'German', own: 'Deutsch' },
} as const;
export type BoardLanguage = keyof typeof LANGUAGES;
// Each language's small words, which only drown the rest in a search: search drops them all, whichever language the
// question is in (memory.ts). A language added above needs its own.
export const SMALL_WORDS: Record<BoardLanguage, string> = {
  en: `a about an and are as at be but by can could did do does for from had has have how i if in into is it its me my no
    not of on or our so than that the their them then there these they this to us was we were what when where which who
    why will with would you your`,
  nl: `aan al als bij dan dat de die dit door een en er had heb heeft hebben het hij hoe hun ik in is je jij kan maar mag me
    met mijn moet na naar niet nog of om onze ons ook op over te tot u uit van voor waar wanneer waarom wat was we wie wij
    worden wordt ze zij zijn`,
  de: `aber als am an auch auf aus bei bis da dann das dass dem der des dich die dies diese dieser dir doch du durch ein
    eine einem einen einer er es für habe haben hatte ich ihr im in ist ja kann mich mir mit muss nach nicht noch nur ob
    oder sein sich sie sind so über um und uns unser unsere von vor warum was weil wenn wer wie wir wird wo wurde zu zum
    zur`,
};
const KEY = 'board.language';

const known = (v: unknown): v is BoardLanguage => typeof v === 'string' && Object.hasOwn(LANGUAGES, v);
// English until the board picks one
export const boardLanguage = (): BoardLanguage => {
  const v = setting(KEY);
  return known(v) ? v : 'en';
};
export const languageName = (lang: BoardLanguage = boardLanguage()) => LANGUAGES[lang].name;

// GET /api/language: the setting and the languages it offers
export const language = () => ({
  lang: boardLanguage(),
  languages: Object.entries(LANGUAGES).map(([code, l]) => ({ code, ...l })),
});
// POST /api/language: the board's (or the intake's) choice, or why it isn't one
export function setLanguage(lang: unknown) {
  if (!known(lang)) return `lang is one of ${Object.keys(LANGUAGES).join(', ')}`;
  remember(KEY, lang);
  return language();
}

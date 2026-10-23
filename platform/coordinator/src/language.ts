// The board's language: one setting for everything the person running the company reads and hears from its agents
// (calls' speech and hearing, the company phone's voice line, and what agents write for it: cards, reports, decks, the
// newsletter, the intercom's answers, the plan's names). Code and the agents' own documents stay English, and
// customers' languages are their own (Care, a guest's page). The intake's first question sets it (POST /api/language),
// Settings › Language changes it, and HQ's own text will read it from GET /api/language when it's translated.
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

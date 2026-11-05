// What every call's briefing says about talking on the line, whoever the agent hears there ('the board', 'the
// guest'): the board's (call.ts prompt) and its guest's (callguestbrief.ts guestPrompt). Each briefing keeps its own
// lines around these. And the agent's profile, which both read.
import { readFileSync } from 'node:fs';
import { REPO_DIR } from './config.ts';
import { LANGUAGES, type BoardLanguage } from './language.ts';

// A file of the company's repo (main), or nothing when it isn't there: on purpose, as a call starts without it rather
// than fail. A new agent has no profile yet (call.ts profile() says so) and a new company no DECISIONS.md.
export const read = (f: string) => {
  try {
    return readFileSync(`${REPO_DIR}/${f}`, 'utf8');
  } catch {
    return '';
  }
};

// A markdown text's part under its '## ' heading, without the heading
export const section = (text: string, heading: string) =>
  text
    .split(/^## /m)
    .find(p => p.startsWith(heading))
    ?.slice(heading.length)
    .trim() ?? '';

export const profileOf = (agent: string) => read(`company/people/${agent.replace(/[^a-z0-9-]/g, '')}.md`);
// Who the agent is, from its profile, never its work (its track record and working memory are the company's)
export const personality = (agent: string) => section(profileOf(agent), 'Personality');

// Only the line's Dutch voice is Piper's (voice server.py DUTCH), which says a word marked ‹live› in English sounds
// (MARKED); its German and English are Pocket TTS's, which reads the word as written, so only a Dutch call is asked to
// mark.
export function spokenAloud(lang: BoardLanguage) {
  const spokenIn = LANGUAGES[lang].name;
  return `${
    lang !== 'nl'
      ? ''
      : `Its ${spokenIn} voice says every word the ${spokenIn} way ("live" as "lieve"): put a word you'd say the
English way between ‹ and ›, as in "Het staat ‹live›." The marks are never shown or heard.
`
  }Your words are spoken aloud: reply in one to three short spoken sentences, in plain words, the answer first. No
lists, markdown, emoji or links. Be warm and direct, and ask one question when you need to.`;
}

// Every word of a reply is spoken, so a note only for the follow-up has the note tool (voice hq_tools.py), never the
// words. "Answer directly without deliberating": a call's model always thinks when it judges it useful and `who`
// waits through it; Anthropic's advice for a fast first token is this line. (The sentence goes on in its briefing.)
export function replies(who: string) {
  return `Every word you write in a reply is spoken, whatever its language: anything meant only for your follow-up (what
happened, why, what it means for the work) goes in note, never in your words.
Answer directly without deliberating: ${who} hears every second before your first word`;
}

// Talk between `who` and someone in the room is let be, never "I didn't catch that", with say_nothing.
export function recognised(who: string) {
  const whose = `${who[0].toUpperCase()}${who.slice(1)}'s`;
  return `${whose} words reach you through speech recognition, which can turn background noise or other people talking
into words: if what you hear seems garbled or unrelated, say you didn't catch that. Words someone in the room says to
${who}, or ${who} to them, aren't for you: let them be (say_nothing), never "I didn't catch that".`;
}

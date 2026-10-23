// An agent's or a seat's engine as its mark: the one way HQ shows an engine (the agent panel, People, Calls, Seats,
// Settings › Seats and Wire's keys). Every mark is our own drawing, never a provider's logo: Claude a spark, Codex a
// prompt in a window, a pay-per-use key a key, a person a head and shoulders, Vibe a gust of wind, Antigravity an
// arrow rising off the ground. The drawings are icons (icons.js), so each look shows its own style's. The engine's name is
// the mark's label for screen readers, and its tooltip where it stands alone.
import { esc } from '../util.js';
import { icon } from './icons.js';

const NAMES = {
  claude: 'Claude',
  codex: 'Codex',
  api: 'Pay-per-use key',
  human: 'Human',
  vibe: 'Mistral Vibe',
  agy: 'Antigravity CLI',
};
// Each engine's icon: a person's is the people's own
const ICONS = {
  claude: 'engine-claude',
  codex: 'engine-codex',
  api: 'engine-api',
  human: 'person',
  vibe: 'engine-vibe',
  agy: 'engine-agy',
};

export const engineName = engine => NAMES[engine] ?? String(engine ?? '');
// titled: a tooltip too, for a mark with no name beside it. An engine without a drawing is its name's first letter.
export function engineMark(engine, { titled = false } = {}) {
  const named = engineName(engine) || '?',
    name = esc(named),
    tip = titled ? ` title="${name}"` : '';
  if (!ICONS[engine]) return `<i class="mark" role="img" aria-label="${name}"${tip}>${esc(named[0].toUpperCase())}</i>`;
  return `<span class="mark mark-${esc(engine)}" role="img" aria-label="${name}"${tip}>${icon(ICONS[engine])}</span>`;
}

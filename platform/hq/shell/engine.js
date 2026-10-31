// An agent's or a seat's engine as its mark: the one way HQ shows an engine
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
// Each engine's icon, our own drawing and never a provider's logo: a person's is the people's own
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

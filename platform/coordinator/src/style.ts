// The company's style (theme/hq.yaml style: pixel, line or a word of its own), which picks the kits it has on and what
// the platform draws for it, never HQ's look.
import { theme } from './company.ts';

// undefined for a style-free company
export function style(): string | undefined {
  const word = theme().style;
  if (word === undefined || (typeof word === 'string' && /^[a-z][a-z0-9-]*$/.test(word))) return word;
  throw new Error(`theme/hq.yaml's style isn't a word in lower case: ${JSON.stringify(word)}`);
}

// The worker appends this line to every job prompt, including resumed sessions.
export function stylePrompt(): string {
  const word = style();
  const craft = word === 'pixel' ? 'pixel-art' : word === 'line' ? 'line-art' : 'pictures';
  const notes = [`shared/craft/${craft}.md`, theme().styleNote].filter(Boolean);
  return `Company style: ${word ?? 'none (style-free)'}. Read ${notes.join(' and ')} before drawing. A product's own design document sets its style.`;
}

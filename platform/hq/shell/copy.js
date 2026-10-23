// Blocks of text to copy, in a post or a note and on a desk phone card: each block gets a Copy button that copies it
// exactly, with its newlines and indents, and says "Copied" for a moment. On a tablet, dragging to select a long block is
// fiddly and easy to cut short. A block its CSS holds to a few lines also gets Show all.
//   under: Copy goes under the block, on one row with Show all, rather than on a row of its own above it (a desk phone
//   card, where every line counts).
import { sfx } from './audio.js';

export function copyBlocks(scope, { trimFinalNewline = false, under = false } = {}) {
  scope.querySelectorAll('pre').forEach(pre => {
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copy-code';
    copy.textContent = 'Copy';
    copy.onclick = async () => {
      try {
        const text = trimFinalNewline ? pre.textContent.replace(/\n$/, '') : pre.textContent;
        await navigator.clipboard.writeText(text);
      } catch {
        return; /* no clipboard */
      }
      copy.textContent = 'Copied';
      copy.classList.add('copied');
      sfx.blip();
      setTimeout(() => {
        copy.textContent = 'Copy';
        copy.classList.remove('copied');
      }, 1200);
    };
    const tools = under ? document.createElement('div') : null;
    if (tools) {
      tools.className = 'code-tools';
      tools.append(copy);
      pre.after(tools);
    } else pre.before(copy);
    if (pre.scrollHeight <= pre.clientHeight + 1) return;
    const whole = document.createElement('button');
    whole.type = 'button';
    whole.className = 'whole-code';
    whole.textContent = 'Show all';
    whole.onclick = () => {
      whole.textContent = pre.classList.toggle('whole') ? 'Show less' : 'Show all';
      sfx.blip();
    };
    if (tools) tools.prepend(whole);
    else pre.after(whole);
  });
}

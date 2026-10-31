// A Copy button on each block of text in a post, a note or a desk phone card, and Show all on a block held short
import { sfx } from './audio.js';

// under: Copy goes under the block, on one row with Show all, rather than on a row of its own above it (a desk phone
// card, where every line counts)
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

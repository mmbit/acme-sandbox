// Everything HQ shares: a link ({ url }: Send link, a card's Share part that is only a link, a guest's link from the
// Notebook's Give card) or a card's Share part written as a message ({ text }; the server's, by its author for an
// outsider; never a card about keys). The phone's own share sheet, or the clipboard where there's none, said on the
// tool's own line (msg). A link goes as its URL alone, no text or title: with text, Windows' sheet offers no Copy and
// Teams receives nothing. share() runs straight from the tap, as iOS wants.
import { sfx } from './audio.js';
import { tell } from './alert.js';

export async function share(shareData, msg) {
  if (navigator.share) {
    try {
      await navigator.share(shareData);
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // closed the sheet; anything else falls back to copying
    }
  }
  try {
    await navigator.clipboard.writeText(shareData.url ?? shareData.text);
    msg.textContent = 'Copied: paste it into a message';
    sfx.blip();
  } catch {
    tell(msg, 'Couldn’t share or copy on this device');
  }
}

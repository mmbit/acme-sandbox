// The reviewer's one-time notice explains what a pin keeps and how the Notebook sends it.
import { kept, keep } from './base.js';

const TOLD = '__hq_review_told';

export function showNotice(r) {
  if (!r.outside || !r.mark || kept(localStorage, TOLD)) return;
  if (r.mark.kind === 'general')
    r.msg.textContent =
      'Your note goes on your Notebook page. Send the page when you’re ready. Please don’t type personal details.';
  else {
    r.msg.textContent =
      'Your note and screenshot go on your Notebook page. Send the page when you’re ready. Please don’t type personal details.';
    keep(localStorage, TOLD, '1');
  }
}

// Notebook groups and their agent answers, rendered in the board's live view of a guest's book (notebookguest.js).
import { esc } from '../../util.js';
import { draw } from '/__review/ink.js';

export function renderGroups(s) {
  const parent = s.host.querySelector('.ng-groups');
  parent.innerHTML = s.groups
    .map(
      group => `<article class="ng-group" data-group="${group.id}">
    <div class="ng-clip" aria-hidden="true"><svg viewBox="0 0 24 36" width="24" height="36" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 12v15a6 6 0 0 1-12 0V10a8 8 0 0 1 16 0v17a4 4 0 0 1-8 0V11"/></svg></div>${group.ink.length ? `<canvas class="ng-ink" data-ink="${group.id}" aria-label="${s.text.handwrittenNote}"></canvas>` : ''}
    ${group.pictures.map(p => `<img class="ng-picture" src="${esc(p.url)}" alt="${s.text.notePicture}">`).join('')}
    ${group.texts.map(t => `<p class="ng-words">${esc(t.text)}</p>`).join('')}${group.words ? `<p class="ng-words">${esc(group.words)}</p>` : ''}
    ${group.owner_name ? `<p class="ng-agent">${esc(s.text.pickedUp(group.owner_name))}</p>` : ''}
    ${(group.children ?? [])
      .map(child =>
        child.kind === 'answer'
          ? answerCard(child, s)
          : `<div class="ng-reply"><p>${esc(child.words || child.texts?.map(t => t.text).join('\n') || '')}</p></div>`,
      )
      .join('')}</article>`,
    )
    .join('');
  for (const group of s.groups) {
    const canvas = parent.querySelector(`[data-ink="${group.id}"]`);
    if (canvas) paint(canvas, group);
  }
}

function answerCard(answer, { text }) {
  return `<section class="ng-answer"><p class="ng-agent">${esc(answer.name ?? answer.by)} · ${text.aiAgent}</p>
    <p class="ng-words">${esc(answer.words ?? answer.text ?? '')}</p>
    ${[answer.picture, answer.now]
      .filter(Boolean)
      .map(url => `<img class="ng-picture" src="${esc(url)}" alt="${text.agentAnswer}">`)
      .join('')}
    ${answer.link ? `<a href="${esc(answer.link)}" target="_blank" rel="noopener">${text.openAgentLink}</a>` : ''}</section>`;
}

function paint(canvas, group) {
  const box = group.box ?? { x: 0, y: 0, w: 600, h: 220 },
    pad = 20;
  canvas.width = Math.max(1, Math.ceil(box.w + pad * 2));
  canvas.height = Math.max(1, Math.ceil(box.h + pad * 2));
  canvas.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
  const context = canvas.getContext('2d');
  context.translate(pad - box.x, pad - box.y);
  draw(context, group.ink);
}

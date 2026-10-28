// Notebook groups and their agent answers, rendered in the guest and board views.
import { draw } from '/__review/ink.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export function renderGroups(s) {
  const parent = s.host.querySelector('.ng-groups');
  // A live answer never replaces a reply the person is still writing.
  const drafts = new Map(
    [...parent.querySelectorAll('[data-answer]')].map(form => [form.dataset.answer, form.elements.words.value]),
  );
  parent.innerHTML = s.groups
    .map(
      group => `<article class="ng-group" data-group="${group.id}">
    <div class="ng-clip" aria-hidden="true">⌁</div>${group.ink.length ? `<canvas class="ng-ink" data-ink="${group.id}" aria-label="${s.text.handwrittenNote}"></canvas>` : ''}
    ${group.pictures.map(p => `<img class="ng-picture" src="${esc(p.url)}" alt="${s.text.notePicture}">`).join('')}
    ${group.texts.map(t => `<p class="ng-words">${esc(t.text)}</p>`).join('')}${group.words ? `<p class="ng-words">${esc(group.words)}</p>` : ''}
    ${!s.watch && !s.books.find(n => n.id === s.notebook)?.pages.find(p => p.id === s.page)?.readonly && group.status === 'open' ? `<div class="ng-actions"><button type="button" data-edit="${group.id}">${s.text.editNote}</button><button type="button" data-delete="${group.id}">${s.text.delete}</button></div>` : ''}
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
  for (const form of parent.querySelectorAll('[data-answer]'))
    form.elements.words.value = drafts.get(form.dataset.answer) ?? '';
}

function answerCard(answer, { watch, text }) {
  return `<section class="ng-answer"><p class="ng-agent">${esc(answer.name ?? answer.by)} · ${text.aiAgent}</p>
    <p class="ng-words">${esc(answer.words ?? answer.text ?? '')}</p>
    ${[answer.picture, answer.now]
      .filter(Boolean)
      .map(url => `<img class="ng-picture" src="${esc(url)}" alt="${text.agentAnswer}">`)
      .join('')}
    ${answer.link ? `<a href="${esc(answer.link)}" target="_blank" rel="noopener">${text.openAgentLink}</a>` : ''}${
      watch
        ? ''
        : `<form data-answer="${answer.id}"><label>${esc(text.replyTo(answer.name ?? answer.by))}<textarea name="words" rows="2" required></textarea></label><button>${text.reply}</button></form>`
    }</section>`;
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

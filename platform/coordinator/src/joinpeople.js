// The people in a join link's call room (joinpage.js): one row each, this person first, with their initials in a colour
// of their own, their name and whether they're muted; whoever goes fades out.
const COLOURS = ['#e8505b', '#5b8def', '#3fa45b', '#9b72cf', '#e97d2c', '#2b9aa0'];

// The list as the line has it now (people: [{id, name, muted}]), into c.people. → whether someone else came, or went.
export function listPeople(list, c, people, you) {
  const now = new Map((people ?? []).map(p => [String(p.id), p]));
  let came = false,
    went = false;
  for (const li of [...list.children])
    if (!now.has(li.dataset.id) && !li.classList.contains('gone')) {
      li.classList.add('gone');
      li.addEventListener('animationend', () => li.remove());
      setTimeout(() => li.remove(), 600);
      went = true;
    }
  for (const [id, p] of now) {
    let li = list.querySelector(`li[data-id="${CSS.escape(id)}"]`);
    if (!li) {
      li = person(c, id, you);
      if (id === c.you) list.prepend(li);
      else {
        list.append(li);
        came ||= c.people.size > 0;
      }
    }
    li.querySelector('b').textContent = String(p.name ?? '');
    li.querySelector('.avatar').textContent = initials(String(p.name ?? ''));
    li.querySelector('.muted-mark').style.visibility = p.muted ? 'visible' : 'hidden';
  }
  c.people = now;
  return { came, went };
}

function person(c, id, you) {
  if (!c.colours.has(id)) c.colours.set(id, COLOURS[c.colours.size % COLOURS.length]);
  const li = document.createElement('li');
  li.dataset.id = id;
  li.style.setProperty('--who', c.colours.get(id));
  li.innerHTML = `<span class="avatar"></span><span class="who"><b></b>${id === c.you ? '<small></small>' : ''}</span><svg class="muted-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M4 4l16 16"/></svg>`;
  const mark = li.querySelector('small');
  if (mark) mark.textContent = you;
  return li;
}

const initials = name =>
  name
    .split(/\s+/)
    .map(part => part.match(/[\p{L}\p{N}]/u)?.[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

// HQ's shared guest, Reviews and Notebook invitation controls.
import { esc, cap } from '../util.js';
import { sfx } from './audio.js';
export const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
export const dot = c => (c ? `<i class="gdot" style="background:${esc(c)}"></i>` : '');
// ---------------------------------------------------------------- inviting people
// One way to invite outside people, the same on a guest card (a checklist) and a share for outside notes (a preview):
// who's on it, each with where they stand, Send link (their own link, through the share sheet) and Remove (two taps),
// and Invite (a name and an address) under them while it's open. Removing one and inviting another is a swap.
// list: [{ name, address, colour, state, link, lang }] (lang: a guest's, the language their page and code email are in,
// picked from o.langs, the card's languages: [{ code, own }])
const langPick = (lang, person, langs = []) =>
  `<select data-lang data-person="${esc(person)}" aria-label="${esc(person)}’s language">${langs.map(l => `<option value="${esc(l.code)}"${lang === l.code ? ' selected' : ''}>${esc(l.own)}</option>`).join('')}</select>`;
// o.titled: each name with the board's title for them, or a plus on its corner to give one; o.again: Recent, the people
// to invite again with a tap ({ name, title }).
const nameHtml = p => {
  const plus = p.title
    ? ''
    : `<button type="button" class="plus" data-title="${esc(p.name)}" aria-label="Give ${esc(p.name)} a title"></button>`;
  const badge = !p.title
    ? ''
    : `<button type="button" class="badge" data-title="${esc(p.name)}" data-was="${esc(p.title)}" aria-label="${esc(p.name)}’s title: ${esc(p.title)}. Change it">${esc(p.title)}</button>`;
  return `<b class="named">${esc(p.name)}${plus}</b>${badge}`;
};
const againHtml = list =>
  list.length
    ? `<p class="again">${list.map(r => `<button type="button" data-again="${esc(r.name)}">${esc(r.name)}${r.title ? `<small>${esc(r.title)}</small>` : ''}</button>`).join('')}</p>`
    : '';
// open: Remove on each, and the Invite form
export function peopleHtml(list, open, o = {}) {
  const row =
    p => `<li><div class="person">${dot(p.colour)}${o.titled ? nameHtml(p) : `<b>${esc(p.name)}</b>`} <span class="meta at" data-private>${esc(p.address ?? '')}</span><span class="meta">${esc(p.state)}</span>${p.lang ? `<div class="glang">Their page in ${langPick(p.lang, p.name, o.langs)}</div>` : ''}</div>
      <div class="acts">${p.link ? `<button type="button" class="go" data-send-link="${esc(p.name)}">Send link</button>` : ''}${open ? `<button type="button" data-remove="${esc(p.name)}">Remove</button>` : ''}</div></li>`;
  // (Recent atop the form)
  // (a notebook's invite lists its invited notebooks below it instead)
  return `<div class="invites">${o.notebook ? '' : `<ul>${list.map(row).join('') || '<li class="none">Nobody yet.</li>'}</ul>`}
    ${open ? `<form class="invite" novalidate>${againHtml(o.again ?? [])}<input name="name" placeholder="Name" aria-label="Their name" autocomplete="off" spellcheck="false" maxlength="60"><input name="email" type="email" data-private placeholder="Email address" aria-label="Their email address" autocomplete="off" spellcheck="false">${o.notebook ? '<label class="notebook-name">Notebook name<input name="notebookName" autocomplete="off" maxlength="60" placeholder="Their name"></label>' : ''}<button type="submit">Invite</button></form>` : ''}
    <p class="msg" role="status"></p></div>`;
}
export const refused = err =>
  err.refusal?.error ? `${cap(err.refusal.error)}.` : 'That didn’t go through. Try again.';
// on: send(name, button, msg), and remove(name) and invite(name, email), which redraw and return what to say (as HTML)
export function wirePeople(el, on) {
  let inviting = false;
  const invite = async (name, email) => {
    if (inviting) return '';
    inviting = true;
    const buttons = el.querySelectorAll('form.invite button');
    buttons.forEach(button => (button.disabled = true));
    try {
      return await on.invite(name, email);
    } finally {
      inviting = false;
      buttons.forEach(button => (button.disabled = false));
    }
  };
  const box = el.querySelector('.invites'),
    msg = () => el.querySelector('.invites .msg');
  if (!box) return;
  const say = (html, kept) => {
    if (msg()) msg().innerHTML = html;
    return kept;
  };
  wirePeopleActions(box, on, say, msg, invite);
  wireInvitation(box.querySelector('form.invite'), on.known ?? [], invite, say);
}

function wirePeopleActions(box, on, say, msg, invite) {
  box.querySelectorAll('[data-send-link]').forEach(b => (b.onclick = () => on.send(b.dataset.sendLink, b, msg())));
  // Recent's names, and a name's plus or title
  box.querySelectorAll('[data-again]').forEach(
    b =>
      (b.onclick = async () => {
        b.disabled = true;
        say('Inviting…');
        try {
          say(await invite(b.dataset.again));
          sfx.blip();
        } catch (err) {
          b.disabled = false;
          say(esc(refused(err)));
        }
      }),
  );
  box
    .querySelectorAll('[data-title]')
    .forEach(b => (b.onclick = () => titleField(b, on.title, () => say('That didn’t go through. Try again.'))));
  box.querySelectorAll('[data-remove]').forEach(
    b =>
      (b.onclick = async () => {
        if (!b.dataset.sure) {
          b.dataset.sure = 1;
          b.textContent = 'Tap again to remove';
          sfx.blip();
          return;
        }
        b.disabled = true;
        try {
          say(await on.remove(b.dataset.remove));
          sfx.blip();
        } catch (err) {
          b.disabled = false;
          say(esc(refused(err)));
        }
      }),
  );
}

function wireInvitation(form, knownPeople, invite, say) {
  form?.addEventListener('submit', async e => {
    e.preventDefault();
    if (form.querySelector('[type=submit]').disabled) return;
    const name = form.elements.name,
      email = form.elements.email,
      button = form.querySelector('[type=submit]');
    if (!name.value.trim()) {
      name.focus();
      return;
    }
    const known = knownPeople.some(person => sameName(person.name, name.value.trim()));
    if ((!email.value.trim() && !known) || !email.checkValidity()) {
      email.focus();
      return;
    }
    button.disabled = true;
    say('Inviting…');
    const who = name.value.trim(),
      address = email.value.trim();
    try {
      name.value = email.value = '';
      name.blur();
      email.blur();
      say(await invite(who, address || undefined));
      sfx.blip();
    } catch (err) {
      name.value = who;
      email.value = address;
      say(esc(refused(err)));
    } finally {
      button.disabled = false;
    }
  });
}
// A name's plus, or its title: a short field in its place on the row (the address steps aside), saved on Enter or on
// leaving it, empty to take the title off; Escape leaves it as it was
function titleField(b, save, failed) {
  const name = b.dataset.title,
    was = b.dataset.was ?? '',
    person = b.closest('.person'),
    spot = b.closest('.named') ?? b;
  const f = titleInput(name, was);
  const back = () => {
    f.remove();
    b.hidden = false;
    person.classList.remove('titling');
  };
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const title = f.value.replace(/\s+/g, ' ').trim();
    if (title === was) return back();
    f.disabled = true;
    try {
      await save(name, title);
      sfx.blip();
    } catch {
      back();
      failed();
    }
  };
  f.onkeydown = e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      done = true;
      back();
    }
  };
  f.onblur = commit;
  b.hidden = true;
  person.classList.add('titling');
  spot.after(f);
  f.focus();
}

function titleInput(name, was) {
  const f = Object.assign(document.createElement('input'), {
    className: 'titlefield',
    value: was,
    maxLength: 40,
    placeholder: 'Title',
    autocomplete: 'off',
    spellcheck: false,
  });
  f.setAttribute('aria-label', `${name}’s title`);
  return f;
}

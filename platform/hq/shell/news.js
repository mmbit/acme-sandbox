// The newsletter and the library, in the panel: posts and their covers, what's unread, the shelves and their search.
import { esc, titleCase, cap } from '../util.js';
import * as world from '../world/world.js';
import { companyFormats } from '../world/clock.js';
import { loadGazette, loadLibrary } from './data.js';
import { show, body, panelOpen } from './panel.js';
import { countBadge } from './hud.js';
import { names } from './brand.js';
import { seen, markSeen } from './seen.js';
import { copyBlocks } from './copy.js';
import { BLOCK, covered, jobLink, linkJobsIn, withJobLinks } from './prose.js';
import { docOn } from './card.js';
import { keepPictures } from './covers.js';
import { coverFor } from './postcover.js';
import { manualHtml, wireManual } from './manual.js';

export let gazette = []; // the posts, newest first
export async function reloadGazette(dev) {
  const posts = await loadGazette(dev);
  await keepPictures(posts.flatMap(p => p.meeting?.pictures ?? [])); // (a meeting's: postcover.js)
  gazette = posts;
}

const author = id => esc(world.agents.get(id)?.data.name || titleCase(id || 'Someone'));
// A post's day, 16 Oct 2026: a YYYY-MM-DD as written, a moment on the company's clock
const fmtDate = d => {
  const f = companyFormats(),
    x = new Date(d);
  return isNaN(x) ? esc(d) : f.day(String(d).length === 10 ? d : f.dayAt(x), 'en', { short: true, year: true });
};
const tags = t => (t || []).map(x => `<span class="tag">#${esc(x)}</span>`).join(' ');

// What the board has read, per feed: the newest post time it has seen, on any of its devices (seen.js). Before
// anything's recorded, the last day's posts count as new; before the marks are read,
// nothing does.
const seenKey = board => `gazette.${board ? 'board' : 'company'}`;
const stamp = p => String(p.t || p.date || '');
const dayAgo = () => {
  const f = companyFormats(),
    at = Date.now() - 864e5;
  return `${f.dayAt(at)}T${f.time(at, 'en')}`;
};
const isNew = (p, board) => !!seen && stamp(p) > (seen[seenKey(board)] ?? dayAgo());
const unread = board => gazette.filter(p => !p.board === !board && isNew(p, board)).length;
export function paintNews() {
  const el = document.getElementById('news-count'),
    n = unread(false) + unread(true);
  if (el) {
    countBadge(el, n);
    el.setAttribute('aria-label', `${n} unread ${n === 1 ? 'post' : 'posts'}`);
  }
}
function markRead(board) {
  const newest = gazette
    .filter(p => !p.board === !board)
    .map(stamp)
    .sort()
    .pop();
  if (newest) markSeen(seenKey(board), newest);
  paintNews();
}

// Two sections: news for the whole company, and briefs and reports for the board (frontmatter `for: board`).
export function openGazette(board = unread(true) > 0) {
  const posts = gazette.filter(p => !p.board === !board),
    fresh = new Set(posts.filter(p => isNew(p, board)));
  const other = unread(!board);
  const tab = b =>
    `<button role="tab" aria-selected="${b === board}" data-b="${b ? 1 : ''}">${b ? 'Board' : 'Company'}` +
    `${b !== board && other ? ` <i class="gz-n">${other}</i>` : ''}</button>`;
  const card = (p, i) =>
    covered(
      'card',
      `data-i="${i}"`,
      p.title,
      `<img alt="" src="${esc(coverFor(p))}"><span class="ct">` +
        `${fresh.has(p) ? '<em class="gz-new">New</em>' : ''}<b>${withJobLinks(p.title)}</b>` +
        `<small>${author(p.author)} · ${fmtDate(p.date)}</small><span>${tags(p.tags)}</span></span>`,
    );
  const none = board ? 'Nothing for the board yet.' : 'The presses are warming up. No posts yet.';
  show(
    'gazette',
    `<div class="masthead"><h2>${esc(cap(names.newsletter))}</h2>` +
      `<p>${board ? 'Briefs and reports for the board' : 'News from inside the building'}</p></div>
    <nav class="gz-tabs" role="tablist" aria-label="${esc(names.newsletterShort)} sections">` +
      `${[false, true].map(tab).join('')}</nav>
    <div class="cards">${posts.map(card).join('') || `<p class="muted">${none}</p>`}</div>`,
    'gazette',
  );
  body.querySelectorAll('.gz-tabs button').forEach(b => (b.onclick = () => openGazette(!!b.dataset.b)));
  markRead(board); // seen now (the New labels stay until the next visit)
  body
    .querySelectorAll('.card > .cover')
    .forEach(b => (b.onclick = () => openPost(posts[+b.dataset.i], () => openGazette(board))));
}

function openPost(p, back = openGazette) {
  const read = l => `<button data-doc="${esc(l)}">📖 ${esc(titleOf(l))}</button>`;
  const readMore = p.links?.length
    ? `<div class="reads"><h3>Read more in ${esc(names.library)}</h3>${p.links.map(read).join('')}</div>`
    : '';
  // (a post is its author's: a mark the Pencil makes on it goes on their sheet.)
  show(
    'post',
    `<button class="back">← Back</button><article class="post" data-owner="${esc(p.author ?? '')}"><img class="cover" alt="" src="${esc(coverFor(p))}">` +
      `${p.sound ? `<audio class="sound" src="${esc(p.sound)}" controls preload="none"></audio>` : ''}
    <h2>${withJobLinks(p.title)}</h2><p class="role">${author(p.author)} · ${fmtDate(p.date)} ${tags(p.tags)}</p>` +
      `<div class="html">${sanitize(p.html || '')}</div>
    ${readMore}</article>`,
    p.slug,
  );
  shown(back, () => openPost(p, back));
  linkJobsIn(body.querySelector('.html'));
  // the notes a post is about, by their Library titles, one tap away
  const reads = [...body.querySelectorAll('.reads [data-doc]')];
  reads.forEach(b => (b.onclick = () => openLibraryDoc(b.dataset.doc, () => openPost(p, back))));
  if (reads.length)
    shelvesLoaded().then(() =>
      reads.forEach(b => {
        const d = shelves.find(x => x.path === b.dataset.doc);
        if (d && b.isConnected) b.textContent = `📖 ${d.title}`;
      }),
    );
}

// The library: everything the company has written down, on shelves (the handbook, playbooks, departments, the
// knowledge base's notes by topic, the shared craft library, the newsletter), and one search across all of it.
let shelves = null,
  shelvesAt = 0,
  shelvesFailed = null; // (why the last read failed, for HQ's search.)
async function shelvesLoaded() {
  if (!shelves || Date.now() - shelvesAt > 300e3) {
    shelvesFailed = null;
    shelves = await loadLibrary(world.dev).catch(e => {
      shelvesFailed = e;
      return shelves ?? [];
    });
    shelvesAt = Date.now();
  }
}
// Its documents and posts for HQ's search (finder.js), each opening as its row here does, with a way back to the Library;
// shelves that didn't load fail the search's Library.
export async function libraryEntries() {
  await shelvesLoaded();
  if (shelvesFailed) throw shelvesFailed;
  const back = () => openLibrary();
  return [
    ...shelves.map(d => ({ key: d.path, title: d.title, shelf: d.shelf, open: () => openDoc(d, back) })),
    ...gazette.map(p => ({
      key: `post:${p.slug}`,
      title: p.title,
      shelf: names.newsletterShort,
      open: () => openPost(p, back),
    })),
  ];
}
export async function openLibrary(q = '') {
  show(
    'library',
    `<div class="masthead lib"><h2>${esc(cap(names.library))}</h2><p>Everything the company has written down</p></div>
    <label class="search"><span class="sr">Search ${esc(names.library)}</span>` +
      `<input type="search" placeholder="Search ${esc(names.library)}…" value="${esc(q)}" autocomplete="off"></label>
    <div class="shelves"><p class="muted">Opening the stacks…</p></div>`,
    'library',
  );
  const input = body.querySelector('input'),
    out = body.querySelector('.shelves');
  await shelvesLoaded();
  if (panelOpen()?.kind !== 'library') return;
  const all = [...shelves, ...gazette.map(p => ({ ...p, shelf: names.newsletterShort, post: true }))];
  const plain = p =>
    (p._t ??= (
      p.title +
      ' ' +
      (p.tags || []).join(' ') +
      ' ' +
      (p.author || '') +
      ' ' +
      new DOMParser().parseFromString(p.html || '', 'text/html').body.textContent
    ).replace(/\s+/g, ' '));
  const open = (p, back) => (p.post ? openPost(p, back) : openDoc(p, back));
  const item = (p, i, snip = '') =>
    `<li>${covered(
      '',
      `data-i="${i}"`,
      p.title,
      `<b>${withJobLinks(p.title)}</b><small>${esc(p.shelf)}` +
        `${p.author ? ` · ${author(p.author)}` : ''}${p.date ? ` · ${fmtDate(p.date)}` : ''}</small>` +
        `${snip ? `<span>${snip}</span>` : ''}`,
    )}</li>`;
  const run = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean),
      back = () => openLibrary(input.value);
    let list;
    if (!words.length) {
      // the shelves
      list = all;
      const names = [...new Set(all.map(p => p.shelf))];
      // (How HQ works first: manual.js.)
      out.innerHTML =
        manualHtml() +
        (names
          .map(
            n =>
              `<section><h3>${esc(n)}</h3><ul class="results">` +
              `${all.map((p, i) => (p.shelf === n ? item(p, i) : '')).join('')}</ul></section>`,
          )
          .join('') || '<p class="muted">The shelves are empty.</p>');
    } else {
      list = all.filter(p => words.every(w => plain(p).toLowerCase().includes(w)));
      const found = new RegExp(
        words
          .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .sort((x, y) => y.length - x.length)
          .join('|'),
        'gi',
      );
      out.innerHTML = `<ul class="results">${
        list
          .map((p, i) => {
            const doc = linkedText(p),
              at = Math.max(0, doc.text.toLowerCase().indexOf(words[0]) - 40);
            return item(p, i, `${at ? '…' : ''}${excerpt(doc, at, at + 140, found)}…`);
          })
          .join('') || `<li class="muted">Nothing on the shelves matches “${esc(input.value)}”.</li>`
      }</ul>`;
    }
    out.querySelectorAll('button[data-i]').forEach(b => (b.onclick = () => open(list[+b.dataset.i], back)));
    if (!words.length) wireManual(out, back);
  };
  input.oninput = run;
  run();
  if (matchMedia('(pointer: fine)').matches) input.focus();
}

// A document by its file name ("venture-cycle.md", "company/AUTHORITY.md"), for links from elsewhere in HQ.
export async function openLibraryDoc(name, back) {
  await shelvesLoaded();
  const to = docNamed(name);
  return to ? openDoc(to, back ?? (() => openLibrary())) : openLibrary(titleOf(name));
}
// its path first, else its file name
const docNamed = name => shelves && docOn(shelves, name); // (card.js docOn)
const titleOf = path => path.split('/').pop().replace(/\.md$/, '').replace(/[-_]/g, ' ');

// A post or a document just shown: its Back button, and what its text offers (back here: again). A picture opens full
// size on a tap (on a phone, a sheet of screens is tiny in the column).
function shown(back, again) {
  body.querySelector('.back').onclick = back;
  body.querySelectorAll('.html img').forEach(i => {
    i.style.cursor = 'zoom-in';
    i.onclick = () => window.open(i.src, '_blank', 'noopener');
  });
  copyBlocks(body.querySelector('.html'), { trimFinalNewline: true });
  linked(again);
}

// A document from the shelves. A link to another document opens it here.
function openDoc(d, back) {
  show(
    'post',
    `<button class="back">← Back</button><article class="post doc">` +
      `<p class="role">${esc(d.shelf)}${d.date ? ` · checked ${fmtDate(d.date)}` : ''}</p>
    <h2>${withJobLinks(d.title)}</h2><div class="html">${sanitize(d.html || '')}</div></article>`,
    d.path,
  );
  // file names in the text ("AUTHORITY.md", `company/playbooks/venture-cycle.md`) open that document too
  const walk = document.createTreeWalker(body.querySelector('.html'), NodeFilter.SHOW_TEXT),
    hits = [];
  while (walk.nextNode())
    if (!walk.currentNode.parentElement.closest('a') && /[\w-]+\.md\b/.test(walk.currentNode.data))
      hits.push(walk.currentNode);
  for (const t of hits) {
    const parts = t.data.split(/([\w./-]+\.md)\b/);
    t.replaceWith(
      ...parts.map((s, i) => {
        const to = i % 2 && docNamed(s);
        if (!to) return s;
        const a = document.createElement('a');
        a.href = '#';
        a.textContent = s;
        a.title = to.title;
        a.onclick = e => {
          e.preventDefault();
          openDoc(to, () => openDoc(d, back));
        };
        return a;
      }),
    );
  }
  shown(back, () => openDoc(d, back));
  linkJobsIn(body.querySelector('.html'));
}

// A post's or document's words as its search result shows them: its text alone (not its title or tags), a space between
// its blocks, and the job links linkJobsIn gives it, each piece with where it sits in the text. A space between blocks
// is a piece of its own, so a job's piece holds only its link's words.
const linkedText = p => (p._words ??= wordsOf(p.html));
function wordsOf(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html').body,
    pieces = [];
  linkJobsIn(doc);
  let text = '',
    block;
  const add = (words, job) => {
    words = words.replace(/\s+/g, ' ');
    if (!text || text.endsWith(' ')) words = words.replace(/^ /, '');
    if (!words) return;
    pieces.push({ from: text.length, to: text.length + words.length, job });
    text += words;
  };
  const walk = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const node = walk.currentNode,
      inBlock = node.parentElement.closest(BLOCK);
    if (inBlock !== block) add(' ');
    block = inBlock;
    add(node.data, node.parentElement.closest('a.job-link')?.dataset.job);
  }
  return { text, pieces };
}
// Its text[from, to) as HTML: a job link whole inside it stays a link (one cut off is text), and in every piece the words
// searched for (`found`) are marked
function excerpt({ text, pieces }, from, to, found) {
  const marked = s => {
    let html = '',
      at = 0;
    for (const m of s.matchAll(found)) {
      html += `${esc(s.slice(at, m.index))}<mark>${esc(m[0])}</mark>`;
      at = m.index + m[0].length;
    }
    return html + esc(s.slice(at));
  };
  return pieces
    .filter(p => p.to > from && p.from < to)
    .map(p => {
      const words = marked(text.slice(Math.max(p.from, from), Math.min(p.to, to)));
      return p.job && p.from >= from && p.to <= to ? jobLink(p.job, words) : words;
    })
    .join('');
}

// Links in a post or a document. The server resolves a post's or note's own links to
// /knowledge/…: a note opens here, by its path (else by its file name); another file in the knowledge base or a web
// address opens in a new tab, so HQ stays put. In a handbook document, a file HQ can't show is plain text.
function linked(back) {
  body.querySelectorAll('.html a[href]:not([href="#"])').forEach(a => {
    const href = a.getAttribute('href'),
      path = href.split('#')[0],
      name = path.split('/').pop();
    if (name.endsWith('.md') && (path.startsWith('/knowledge/') || shelves?.some(x => x.path.endsWith('/' + name))))
      a.onclick = e => {
        e.preventDefault();
        openLibraryDoc(path.replace(/^\//, ''), back);
      };
    else if (!/^(https?:|mailto:|\/knowledge\/)/.test(href)) a.replaceWith(...a.childNodes);
    else {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  });
}

// Posts are written by agents and shown with the board's session, so links and sources keep only web and mail
// addresses, judged the way the browser will parse them (it drops tabs and newlines: "java&#9;script:").
const URL_ATTRS = /^(href|src|xlink:href|action|formaction|poster|background|srcset)$/i;
const webUrl = v => {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(v, location.href).protocol);
  } catch {
    return false;
  }
};
function sanitize(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // The elements whose text the parser reads differently here (DOMParser runs without script, so <noscript> holds
  // markup) and on the page go too, with their content: a browser that serialises < and > in attributes as written
  // would otherwise let "</noscript><iframe srcdoc=…>" out on the page.
  doc
    .querySelectorAll(
      'script,iframe,object,embed,style,link,meta,form,base,animate,set,noscript,noembed,noframes,xmp,plaintext,' +
        'template,textarea,select,title',
    )
    .forEach(n => n.remove());
  doc.querySelectorAll('*').forEach(n =>
    [...n.attributes].forEach(a => {
      if (/^on/i.test(a.name) || (URL_ATTRS.test(a.name) && !webUrl(a.value))) n.removeAttribute(a.name);
    }),
  );
  return doc.body.innerHTML;
}

// node --test platform/hq/shell/prose.test.js   (an agent's words as HQ shows them, as plain functions; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { covered, prose, strong, linked, withJobLinks } from './prose.js';

globalThis.location = new URL('https://hq.example/');

// (wrapped lines join, as in Markdown)
test('paragraphs split at empty lines; a wrapped line goes on with the one before, as in Markdown', () => {
  assert.equal(prose('One.\nStill one.\n\n\nTwo.'), '<p>One. Still one.</p><p>Two.</p>');
  assert.equal(prose('**Bold\nacross** a wrap'), '<p><b>Bold across</b> a wrap</p>');
});

test('a line break stays where the writer meant one: two spaces or a backslash at its end, or every line with breaks', () => {
  assert.equal(prose('Dear team,  \nthe parcel\\\nis here.\nStill.'), '<p>Dear team,<br>the parcel<br>is here. Still.</p>');
  assert.equal(prose('Typed\nby hand\n- a\nb', undefined, { breaks: true }), '<p>Typed<br>by hand</p><ul><li>a<br>b</li></ul>');
});

test('a backslash ends a line only before a line that goes on; at the end of a paragraph, an item or a chat message it stays', () => {
  assert.equal(prose('The drive is C:\\'), '<p>The drive is C:\\</p>');
  assert.equal(prose('- a\\\n\nb\\'), '<ul><li>a\\</li></ul><p>b\\</p>');
  assert.equal(prose('C:\\\nD:\\', undefined, { breaks: true }), '<p>C:\\<br>D:\\</p>');
});

test("a list item's wrapped lines go on with it, indented or not; past an empty line only an indented one does", () => {
  assert.equal(prose('Facts:\n- Print API prints and ships every order. Our email\nthread is ticket #1.\n- Made\n  there\n\n  Its own line\nstill it\n\nAfter.'),
    '<p>Facts:</p><ul><li>Print API prints and ships every order. Our email thread is ticket #1.</li><li>Made there<br>Its own line still it</li></ul><p>After.</p>');
});

test('a list is a list, with or without a line before it, and an indented line goes on with its item', () => {
  assert.equal(prose('What we decided:\n- **Price:** EUR 12\n- Ships\n  in a tube\n* Last'),
    '<p>What we decided:</p><ul><li><b>Price:</b> EUR 12</li><li>Ships in a tube</li><li>Last</li></ul>');
  assert.equal(prose('- a\n\n- b\n\nAfter.'), '<ul><li>a</li><li>b</li></ul><p>After.</p>');
  assert.equal(prose('- a\n- \n- b'), '<ul><li>a</li><li>b</li></ul>');
});

test('numbered lists keep their first number', () => {
  assert.equal(prose('1. one\n2) two'), '<ol><li>one</li><li>two</li></ol>');
  assert.equal(prose('3. three\n4. four'), '<ol start="3"><li>three</li><li>four</li></ol>');
});

test('a heading is a bold line, a rule only a gap', () => {
  assert.equal(prose('## What we set in motion\nJob #1.\n\n---\n\nDone.'), `<p><b>What we set in motion</b></p><p>Job ${job(1)}.</p><p>Done.</p>`);
});

test('a run of indented bullets after a sentence is a list, not one block', () => {
  const note = 'About request #1.\n\n - **"What the marketer adds:"** the page\n - **Next:** queued';
  assert.equal(prose(note), '<p>About request #1.</p><ul><li><b>&quot;What the marketer adds:&quot;</b> the page</li><li><b>Next:</b> queued</li></ul>');
});

test('a Markdown table is a table: its head, its columns aligned by the dashes, each cell through the line renderer', () => {
  const figures = 'Searches a month:\n| Page | Word | NL | DE |\n|---|:--|---:|:-:|\n| Home | **mug** | 1,200 | 90 |\n| Shop | a \\| b | 40 |\n\nThat was all.';
  assert.equal(prose(figures),
    '<p>Searches a month:</p><div class="table"><table><thead><tr><th>Page</th><th class="left">Word</th><th class="right">NL</th><th class="center">DE</th></tr></thead>'
    + '<tbody><tr><td>Home</td><td class="left"><b>mug</b></td><td class="right">1,200</td><td class="center">90</td></tr>'
    + '<tr><td>Shop</td><td class="left">a | b</td><td class="right">40</td></tr></tbody></table></div><p>That was all.</p>');
  // without its line of dashes, or with a column too few, it's text
  assert.equal(prose('a | b\nc | d'), '<p>a | b c | d</p>');
  assert.equal(prose('| a | b |\n|---|\n| c |'), '<p>| a | b | |---| | c |</p>');
  // its outer pipes are optional, and in a fenced block it's the block's text
  assert.equal(prose('a | b\n--|--\nc | d'), '<div class="table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>c</td><td>d</td></tr></tbody></table></div>');
  assert.equal(prose('```\na | b\n--|--\n```'), '<pre><code>a | b\n--|--</code></pre>');
});

test('a table with a wide head over short rows renders as long as its text, not head x rows', () => {
  const card = `${'|'.repeat(1501)}\n${'|-'.repeat(1500)}|\n${'|\n'.repeat(6500)}`;
  const html = prose(card);
  assert.match(html, /^<div class="table"><table><thead><tr>(<th><\/th>){1500}<\/tr><\/thead><tbody>(<tr><td><\/td><\/tr>){6500}<\/tbody>/);
  assert.ok(html.length < 20 * card.length, `${html.length} characters of HTML from ${card.length}`);
});

test('everything else stays text: HTML is escaped, code is code, a lone asterisk is an asterisk', () => {
  assert.equal(strong('<img src=x onerror=alert(1)> & `a **b**` 2 * 3 = *six*'),
    '&lt;img src=x onerror=alert(1)&gt; &amp; <code>a **b**</code> 2 * 3 = <i>six</i>');
  assert.equal(prose(''), '');
  assert.equal(prose(null), '');
});

test('the line renderer is the caller\'s to choose', () => {
  assert.equal(prose('x\n- y', s => `[${s}]`), '<p>[x]</p><ul><li>[y]</li></ul>');
});

test('a fenced block is kept exactly, escaped, its opening indent taken off, and nothing in it is read as Markdown', () => {
  assert.equal(prose('Paste:\n  ```text\n  Dear <team>,\n\n    - **not** a list\n  ---\n  ```\nThen send.'),
    '<p>Paste:</p><pre><code>Dear &lt;team&gt;,\n\n  - **not** a list\n---</code></pre><p>Then send.</p>');
});

test('a picture HQ serves shows as one; an address elsewhere stays text', () => {
  assert.equal(prose('Your office:\n![The office, from the street](/cycles/office.png)'),
    '<p>Your office: <img src="/cycles/office.png" alt="The office, from the street" loading="lazy"></p>');
  assert.equal(strong('**Before** ![a "b"](/x.png?a=1&b=2) `![c](/y.png)`'),
    '<b>Before</b> <img src="/x.png?a=1&amp;b=2" alt="a &quot;b&quot;" loading="lazy"> <code>![c](/y.png)</code>');
  assert.equal(strong('![x](https://elsewhere.example/x.png) ![y](//elsewhere.example/y.png) ![z](/\\elsewhere.example/z.png)'),
    '![x](https://elsewhere.example/x.png) ![y](//elsewhere.example/y.png) ![z](/\\elsewhere.example/z.png)');
  assert.equal(strong('![w](https://[x/w.png)'), '![w](https://[x/w.png)');
});

test('a Markdown link is a link with its text, opening in a new tab; bold and escaping go around and inside it', () => {
  const a = (url, html) => `<a href="${url}" target="_blank" rel="noopener">${html} ↗</a>`;
  assert.equal(strong('See [About us](https://shop.example/en/about-us).'), `See ${a('https://shop.example/en/about-us', 'About us')}.`);
  assert.equal(strong('**[Our <box>](http://x.example/a?b=1&c=2)** and [*it*](https://x.example/wiki/Box_(tin))'),
    `<b>${a('http://x.example/a?b=1&amp;c=2', 'Our &lt;box&gt;')}</b> and ${a('https://x.example/wiki/Box_(tin)', '<i>it</i>')}`);
  assert.equal(prose('- [one](https://a.example/1)\n- two'), `<ul><li>${a('https://a.example/1', 'one')}</li><li>two</li></ul>`);
});

test('a link to anything but http or https stays as written, and no asterisk in an address reaches bold or italics', () => {
  assert.equal(strong('[x](javascript:alert(1)) [y](mailto:a@b.example) [z](/about)'), '[x](javascript:alert(1)) [y](mailto:a@b.example) [z](/about)');
  assert.equal(strong('[w]( https://a.example)'), '[w]( <a href="https://a.example" target="_blank" rel="noopener">a.example ↗</a>)');   // (a bare address)
  assert.equal(strong('**a [b](https://a.example/**c)** d'), `<b>a <a href="https://a.example/%2A%2Ac" target="_blank" rel="noopener">b ↗</a></b> d`);
  assert.equal(strong('[x](https://a.example/"onmouseover=y)'),
    '[x](<a href="https://a.example/" target="_blank" rel="noopener">a.example ↗</a>&quot;onmouseover=y)');   // (the quote stays out of the address)
});

test('the desk phone\'s own renderer gets the link, and its text stays plain: no second link inside it', () => {
  assert.equal(linked('[https://a.example](https://a.example) b', s => `<${s}>`, s => s.toUpperCase()),
    '<><a href="https://a.example" target="_blank" rel="noopener">HTTPS://A.EXAMPLE ↗</a>< b>');
});

test('a bare address is a link, shown without its scheme, www or last slash, the punctuation after it left out', () => {
  const a = (url, html) => `<a href="${url}" target="_blank" rel="noopener">${html} ↗</a>`;
  assert.equal(strong('See https://www.facebook.com/ads/library/?id=1&q=2.'),
    `See ${a('https://www.facebook.com/ads/library/?id=1&amp;q=2', 'facebook.com/ads/library/?id=1&amp;q=2')}.`);
  assert.equal(strong('(at http://a.example/), https://a.example/wiki/Box_(tin)! **https://b.example/x**'),
    `(at ${a('http://a.example/', 'a.example')}), ${a('https://a.example/wiki/Box_(tin)', 'a.example/wiki/Box_(tin)')}! <b>${a('https://b.example/x', 'b.example/x')}</b>`);
  assert.equal(prose('- one: https://a.example/1\n- two'), `<ul><li>one: ${a('https://a.example/1', 'a.example/1')}</li><li>two</li></ul>`);
  assert.equal(strong('https://a.example/*x*y'), a('https://a.example/%2Ax%2Ay', 'a.example/&#42;x&#42;y'));
});

test('a bare address stays text inside code and inside a Markdown link\'s text, and ftp or a lone https:// stays as written', () => {
  const a = (url, html) => `<a href="${url}" target="_blank" rel="noopener">${html} ↗</a>`;
  assert.equal(strong('`curl https://a.example` [https://a.example/x](https://a.example/x)'),
    `<code>curl https://a.example</code> ${a('https://a.example/x', 'https://a.example/x')}`);
  assert.equal(strong('[**see** https://b.example](https://a.example)'), a('https://a.example', '<b>see</b> https://b.example'));
  assert.equal(strong('ftp://a.example and https:// alone'), 'ftp://a.example and https:// alone');
});

const job = id => `<a class="job-link" href="/?open=jobs&amp;job=${id}" data-job="${id}">#${id}</a>`;

test('a job number is a link to that job; one another word claims stays text', () => {
  assert.equal(withJobLinks('Queued as job #3971 (after #12).'), `Queued as job ${job(3971)} (after ${job(12)}).`);
  assert.equal(withJobLinks('jobs #12 and #34, then #56'), `jobs ${job(12)} and ${job(34)}, then ${job(56)}`);
  assert.equal(withJobLinks('card #89, PR #785, call #58, item #113, pin #4 and note #37'), 'card #89, PR #785, call #58, item #113, pin #4 and note #37');
  assert.equal(withJobLinks("cards #95, #96 and #97's answers"), 'cards #95, #96 and #97&#39;s answers');
  assert.equal(withJobLinks("#3966's fix, not https://x.test/#12 or &#39;"), `${job(3966)}&#39;s fix, not https://x.test/#12 or &amp;#39;`);
});

test('a slice of a title is linked by the words before it', () => {
  const title = 'Card #89: steps (after #3399)';
  assert.equal(withJobLinks(title, 0, 9), 'Card #89:');
  assert.equal(withJobLinks(title, title.indexOf('(')), `(after ${job(3399)})`);
});

test('a report links its jobs, but not in code or a link', () => {
  assert.equal(strong('**Done** in #12, see `#13`'), `<b>Done</b> in ${job(12)}, see <code>#13</code>`);
  assert.equal(strong('Merged in [#785](https://x.test/pull/785), and #45'),
    `Merged in <a href="https://x.test/pull/785" target="_blank" rel="noopener">#785 ↗</a>, and ${job(45)}`);
  assert.equal(prose('| Job | What |\n| --- | --- |\n| #12 | the porch |'),
    `<div class="table"><table><thead><tr><th>Job</th><th>What</th></tr></thead><tbody><tr><td>${job(12)}</td><td>the porch</td></tr></tbody></table></div>`);
});

test('leading-zero numbers and long lists of cards stay text', () => {
  assert.equal(withJobLinks('background #000 and #007'), 'background #000 and #007');
  const cards = `Answered cards ${Array.from({ length: 14 }, (_, i) => `#${101 + i}`).join(', ')} today`;
  assert.equal(withJobLinks(cards), cards);
});

test('a number is a job\'s after any word but another kind HQ numbers: a task, a name or a verb before it leaves it a job\'s', () => {
  assert.equal(withJobLinks('picture #5, question #2, share #7 and post #9'), 'picture #5, question #2, share #7 and post #9');
  assert.equal(withJobLinks('Pull requests #785; mails #3, drafts #1, findings #772, proposals #40, messages #432'),
    'Pull requests #785; mails #3, drafts #1, findings #772, proposals #40, messages #432');
  assert.equal(withJobLinks('Added to job #44, see #45 (#46)'), `Added to job ${job(44)}, see ${job(45)} (${job(46)})`);
  assert.equal(withJobLinks('task #12 added; Handed to Ansel (#4733). I queued it (#4910), since #8525'),
    `task ${job(12)} added; Handed to Ansel (${job(4733)}). I queued it (${job(4910)}), since ${job(8525)}`);
  assert.equal(withJobLinks('existing #6715, Petra #1395 and Lyra\'s note #41'), `existing ${job(6715)}, Petra ${job(1395)} and Lyra&#39;s note #41`);
  assert.equal(withJobLinks('The worker stopped process #48213 (2100 MB); Message from Sam (hq say #432)'),
    'The worker stopped process #48213 (2100 MB); Message from Sam (hq say #432)');
  assert.equal(withJobLinks('Your call out #7 to Ada has ended; sorted out #12'), `Your call out #7 to Ada has ended; sorted out ${job(12)}`);
  assert.equal(withJobLinks('Process #1619 merged; its fix round #3420; new threads (#8325); the line #6321; let\'s say #4910'),
    `Process ${job(1619)} merged; its fix round ${job(3420)}; new threads (${job(8325)}); the line ${job(6321)}; let&#39;s say ${job(4910)}`);
  assert.equal(withJobLinks('fix rounds #3990, #3996; across projects (#5623); thread: **#8345 FN-LANGNOW**'),
    `fix rounds ${job(3990)}, ${job(3996)}; across projects (${job(5623)}); thread: **${job(8345)} FN-LANGNOW**`);
});

test('bold, italics and code around a number or its kind don\'t change whose it is', () => {
  assert.equal(strong('PR **#785** and **card** #89'), 'PR <b>#785</b> and <b>card</b> #89');
  assert.equal(strong('*cards* #95, **#96**'), '<i>cards</i> #95, <b>#96</b>');
  assert.equal(strong('**job** #12 and **#13**; cards `#95` and #96'), `<b>job</b> ${job(12)} and <b>${job(13)}</b>; cards <code>#95</code> and #96`);
});

test('a tap target\'s job links sit beside its button, not in it', () => {
  assert.equal(covered('row', 'data-card="2"', 'Card "#89"', withJobLinks('Card #89 (after #3399)')),
    `<div class="covered row"><button type="button" class="cover" data-card="2" aria-label="Card &quot;#89&quot;"></button>Card #89 (after ${job(3399)})</div>`);
});

test('a number cut off at either end of the part shown stays text', () => {
  assert.equal(withJobLinks('Queued as job #3971.', 0, 17), 'Queued as job #39');
  assert.equal(withJobLinks('Queued as job #3971.', 17), '71.');
  assert.equal(withJobLinks('Queued as job #3971.', 4, 19), `ed as job ${job(3971)}`);
});

test('reference punctuation keeps cards, ranges and parenthetical lists out of Jobs', () => {
  for (const text of ['the launch card (#1116)', 'Cards: #95, #96', 'PR: #785',
    'Pull requests (#785, #786)', 'cards #95–#97', 'items #219 – #227',
    'picture #5 — #6', 'card #89 (and #90)', 'PR #785 (#786)']) {
    assert.equal(withJobLinks(text), text);
  }
  assert.equal(withJobLinks('Item #328 (call #58): job #3971'), `Item #328 (call #58): job ${job(3971)}`);
  assert.equal(withJobLinks('see #45 (#46)'), `see ${job(45)} (${job(46)})`);
  assert.equal(withJobLinks('cards #95–#97', 10), '#97');
  assert.equal(strong('cards `#95` (and **#96**)'), 'cards <code>#95</code> (and <b>#96</b>)');
});

test('possessive owners leave their job references linked', () => {
  assert.equal(withJobLinks("Odile's #2578"), `Odile&#39;s ${job(2578)}`);
  assert.equal(withJobLinks('Someone’s #12 and #13'), `Someone’s ${job(12)} and ${job(13)}`);
});

test('long reference lists followed by prose and another job render promptly', () => {
  for (const separator of [', ', ' ']) {
    const ids = Array.from({ length: 30 }, (_, i) => 3966 + i);
    const text = `Jobs ${ids.map(id => `#${id}`).join(separator)} are done, see #4000`;
    const start = performance.now();
    assert.equal(withJobLinks(text), `Jobs ${ids.map(job).join(separator)} are done, see ${job(4000)}`);
    assert.ok(performance.now() - start < 1000, 'a report must not stall rendering');
  }
});

# Name check

Tools and a method for checking a name, for a company or an app, before anyone designs it, builds on it or brings it
to the board. A name that fails after the logo, the site and the pick are made throws all of them away, so the check
comes first and only a cleared name gets a logo, a site, an ad or a card.

Not legal advice. A borderline result is one line of risk on the card that brings the name to the board for approval:
never a question of its own, and never a suggestion to pay a lawyer.

## The tools

All four print a report for a person to read. None of them clears a name on its own.

| Tool | What it does | What it doesn't |
|---|---|---|
| `nearwords.mjs` | Swaps, adds and drops one letter or one sound (the first sound too), and lists every result that is a real word in Dutch, English or German, rude ones first. Then the rude-substring warnings: results in no word list that the platform word check (`shared/wordcheck/`) finds a rude word inside. The name itself goes through the word check too. | Prove a name clean. A sound spelt in a way it doesn't list, two edits at once, and a rude word missing from its lists never show up: everyday rude words are often in no list. It narrows the reading; a person still says the name aloud. |
| `screen.mjs` | The quick look: apps in the App Store (US, NL and DE storefronts) with the name in their title or seller, and whether `<name>.app`, `<name>.studio`, `<name>apps.com` and `<name>.com` are registered, asked of each registry over RDAP. | Search trade marks, Google Play or the web. A failed App Store search or an unclear registry answer is reported as unclear, never as "nothing found". |
| `nearmatch.mjs` | The near-match check: live apps a letter away. A store's search for a name doesn't return its neighbours, so it searches each close neighbour on its own in the App Store and Google Play (US, NL and DE storefronts): a letter dropped, two letters swapped, a consonant doubled, a vowel changed, a rhyme on the first letter, a sound-alike letter, a vowel added at the end. It lists every app whose title or seller has a word that is the name or a letter away, grouped by that word, with the seller, the storefronts and the link. A long group is a crowded word, like "mobi". | See anything outside the two stores: websites, businesses, trade marks, and an app whose name only contains the neighbour (BOFA Maths is "bofamaths", not "bofa"). Other edits are left out (a middle consonant for any other), unless a search happens to return them. A failed search is tried once more after 10 seconds (Google Play now and then answers with its own error page). A search that fails twice is listed as unanswered, and three in a row stop that store. Either makes the store unclear, never "nothing found". |
| `tmview.mjs` | The first pass through the trade mark registers: every mark containing the name on [TMview](https://www.tmdn.org/tmview), filtered to the classes asked for, live ones first and expired ones after. `--detail <ST13>` prints one mark in full: owner, type, dates and goods per class. | Look-alikes (search each one yourself), judge similarity, or confirm a mark (open it on the office's own register). A search that fails, comes back malformed, or would take more than 5 pages (500 marks) prints why and exits 1: that's no result, never "no marks". |

### Running them

```
node shared/namecheck/nearwords.mjs <name> [name ...]          # --refresh fetches the word lists again
node shared/namecheck/screen.mjs <name> [name ...]
node shared/namecheck/nearmatch.mjs <name> [name ...]
node shared/namecheck/tmview.mjs <name> [--offices EM,BX,GB,WO] [--classes 9,41,42] [--all-classes]
node shared/namecheck/tmview.mjs --detail <ST13>
node --test shared/namecheck/*.test.mjs                         # local fakes only, no network
```

- **nearwords** fetches its word lists once into `NEARWORDS_CACHE` (default `~/.cache/nearwords`): the 50,000
  commonest words per language from film subtitles (FrequencyWords), the LDNOOBW bad-word lists and Wiktionary's
  vulgar, offensive and slur categories. None is committed. The first run takes a minute (Wikimedia is asked slowly).
- **screen** pauses 10 seconds between names (Apple allows about 20 searches a minute). It screens a name without
  spaces, hyphens and accents (`Vel-mo` as `velmo`) and refuses a letter with no a–z spelling (Ø, ß, 東) rather than
  quietly checking another name: give it the spelling the domain would have.
- **nearmatch** makes about 45 neighbours of a five-letter name and searches each in three storefronts per store,
  one search every 3 seconds per store (Apple allows about 20 a minute), the two stores side by side: about 7 minutes
  a name, no model calls. Run it on every candidate before anyone reads registers by hand, and drop a name it shows a
  live app for, in your field, with the same name or a letter away.
- **tmview** runs in a real browser (Playwright, through `shared/demo/core.mjs`), because TMview refuses plain HTTP
  clients. Its defaults are offices **EM, BX, GB, WO** (EU, Benelux, UK, international) and classes **9, 41, 42**
  (software); change them with `--offices` and `--classes`, or drop the class filter with `--all-classes`. A mark
  that comes without readable classes stops a search by class, since it might be in yours: run it again with
  `--all-classes` to see it. TMview's firewall turns away a burst of searches for an hour or so, so search the name
  and its look-alikes, not a hundred variants. When it turns you away, search by hand on TMview, or wait an hour.

## The method

### 1. Say it aloud

Before the registers: say the name, then run `nearwords.mjs` and read every line aloud, in each language your buyers
speak. A rude or awkward near-word puts the name out. Can someone who heard it once type it? A name that needs
spelling out fails, however good its meaning. Write the near-words you checked next to the name, so the next reader
sees what was heard.

### 2. Classes

Marks are registered for goods and services in Nice classes
([WIPO's Nice classification](https://www.wipo.int/classifications/nice/nclpub/en/fr/)). Each company names its own.
As an example, software is **9** (downloadable apps), **42** (web apps, software as a service) and, for an app that
plays sound, words or pictures online, **41** (entertainment and online content). A physical product names its own
classes (printed matter, clothing, toys and so on).

### 3. Registers

[TMview](https://www.tmdn.org/tmview) searches them all at once: EU marks (EUIPO), Benelux (BOIP), UK (UKIPO),
international registrations (WIPO) and every EU country's own office. Search the offices where you sell (the tool's
default is EM, BX, GB and WO), then glance at **all offices** for the exact word, because a national mark also counts
where you sell.

- **Confirm** a mark on the office's own register: [EUIPO eSearch](https://euipo.europa.eu/eSearch/),
  [BOIP](https://www.boip.int/en/trademarks-register) or [UKIPO](https://trademarks.ipo.gov.uk/ipo-tmtext).
- **When TMview or UKIPO turn you away**, WIPO's [Global Brand Database](https://branddb.wipo.int/en/similarname)
  covers EU, UK (national and comparable) and international marks, but not Benelux national ones: search "match
  exact expression", narrow it by IP office (EUIPO, UKIPO, Madrid) and Nice class, and open international records in
  full on [Madrid Monitor](https://www3.wipo.int/madrid/monitor/en/).

### 4. Look-alikes

A mark doesn't have to be identical to conflict. `nearmatch.mjs` does the stores' part. In the registers and on the web,
also search the name with one letter added, dropped or swapped, and how it sounds (a c for a k, a doubled letter
dropped).

### 5. The web and the app stores

Search the web for the name with "app" (or "software", "studio", the product type), and check the App Store
(`screen.mjs`), Google Play and the `.com`. An unregistered business name can still cause a dispute (a trade name in
its own country), and a live brand in your field is a risk even where its mark is narrow.

### 6. The domain

Check it's free at the registry (`screen.mjs`, or RDAP by hand, e.g. `https://rdap.org/domain/<name>`: 404 means
unregistered). **A domain gives no rights in the name.** Selling at it is using the name, so the domain is exactly
as safe as the name. Registries for `.com`, `.app` and `.studio` follow ICANN's dispute policy (UDRP): a mark owner
can claim a domain registered in bad faith.

## What counts as a conflict

A **live mark** (registered, filed or under opposition; not expired, withdrawn or refused) **and** both of:

- **A similar sign:** identical, one letter apart, or sounding alike, judged as a whole the way a buyer would see and
  hear it. A shared ordinary word inside a longer name usually isn't enough.
- **Similar goods:** the goods as **written in the register**, not what the owner sells today. "Software" or "mobile
  apps" covers every app.

That pair is the likelihood-of-confusion test: art. 8(1)(b) EUTMR for registering, art. 9(2)(b) for using
([Regulation (EU) 2017/1001](https://eur-lex.europa.eu/eli/reg/2017/1001/oj)); the Benelux and UK rules are the same
test (BCIP art. 2.20; Trade Marks Act 1994, s. 5(2) and s. 10(2)).

**What softens it.** A mark registered more than five years ago must have been used for the goods it claims. If it
wasn't, the owner has to prove use when it opposes or sues, and anyone can ask to have the unused goods revoked
(art. 18, 47(2) and 58(1)(a) EUTMR). A broad old spec is often narrower than it reads, but whether it really is, is a
judgement call: put it in the name's risk line.

## Verdicts

- **Clear:** no live mark that is both similar and for similar goods.
- **Clear with a caveat:** a near mark whose goods, as written, are in a distant field. Say what to avoid (a class,
  a logo, a word next to the name, registering it yourself).
- **Not clear:** a live, close mark for the same kind of goods or the product's purpose. Name the owner, number,
  classes and status, and give the options.

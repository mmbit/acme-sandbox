---
title: "Words: copy that's warm, plain and true"
kind: note
tags: [craft, copy, words, voice, claims, languages]
verified: 2026-10-02
---

# Words

Learned while writing product pages, help pages, status lines, captions, ads and newsletters, in several languages.
A company's own voice guide wins over this note; these are the habits underneath any voice.

## A voice people trust

- **Talk to one person.** Plain words, short sentences, "we" and "you". Answer what they actually wrote, and don't make
  them repeat themselves.
- **Warm, not cute.** Whimsy lives in what you make and in the small details, not in puns on every line or a mascot
  doing the talking.
- **Honest first.** What it costs, how long it takes, what can go wrong and how to cancel, before they ask.
- **When something breaks, say so plainly:** what happened, who it affects, what you're doing, when you'll say more.
  No joke and no character. A mascot's quip about an outage reads as cynical, not charming.
- **No made-up words** customers have to learn.

| Do | Don't |
|---|---|
| "Checkout was down this morning from 9:40 to 10:15. Nothing you tried then was charged. Sorry for the trouble." | "Oops! Our hamsters fell off their wheel!" |
| "€24,95 including shipping. It's made when you order and arrives in about a week." | "Only 2 left, order now!" (when it's made to order, that's never true) |

## Every sentence is a claim

- **Before a status line promises something,** trace the code path that makes it true, error paths included. "Nothing
  has been printed" after a failed cancel call may be false: the partner may have acted and the answer got lost. When
  you can't know, say "we couldn't confirm" and claim nothing either way.
- **Promise only what code or a named person does:** no "we'll retry", no "we'll email you" without an email, no "a
  person replies" without one.
- **Offer only a contact someone answers.**
- **Words that are claims:** "unique", "one of a kind" and "no two alike" only if true of every output. "We make"
  when a partner makes it: say "made to order". "Coming soon" only when there's a launch path. Materials and places of
  manufacture only when verified.
- **What you say about data** ("we store nothing", "deleted after delivery"): grep the code for every place it stores
  something (cookies, `localStorage`, `sessionStorage`, IndexedDB, the database) and check the real rows, not a
  comment.
- **Printed words are claims too:** a colophon, a certificate, a caption on the product.
- **A price on screen follows the server's answer,** never the click that asked for it.

## Names for things

- **One concept, one name, everywhere:** the button, the help page, the ad and the deck. Explain it in one line where
  it first appears.
- **Avoid a word the screen already uses for something else** nearby (a "redraw" moment next to a "Redraw" button).
- **Check product words against trademarks.** A brand name used as an everyday word for a game or a product type
  can be someone's registered mark: use the generic word.
- **Check a new name before anyone designs it:** near-words said aloud, trade mark registers, app stores and domains,
  with the tools and method in `shared/namecheck/README.md`.

## Languages and formats

- **Prices, dates and times in the reader's format:** €29,95 and 14-03-2026 in Dutch, 14/03/2026 and 14:30 in British
  English. Keep one format per language across pages, ads, emails and the deck.
- **False friends:** German "Gift" means poison (say *Geschenk*). German *Werktag* includes Saturday, *Arbeitstag*
  doesn't, while English "working day" and Dutch *werkdag* mean Monday to Friday.
- **Search words are the language people type,** not a translation of your own phrase.
- **Legal text is quoted word for word,** in the languages the legal pages exist in.
- **Names stay as typed** (`generators.md`).

## Fitting the space

- **Captions:** about four words a second at most (`films.md`).
- **Cards that stack on a phone:** one line each.
- **Keep copy in one data file** where a script can check its lengths, numbers and banned phrases.
- **UI text:** sentence case, no semicolons or em dashes (`CODE_STYLE.md`).

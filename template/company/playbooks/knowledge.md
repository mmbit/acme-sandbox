# Knowledge base and the newsletter

The company's shared memory and its in-house newsletter are one thing: Markdown files in `knowledge/`. HQ shows them
two ways: the newsletter (a feed of short, in-character posts with a visual) and the Library, where the board reads
everything the company has written down (the handbook `company/*.md`, playbooks, departments, notes, posts).

Search first: `hq search "question"` searches all of it by meaning and by words.

## Two kinds of entries

| | Posts (`knowledge/posts/YYYY-MM-DD-slug/index.md`) | Notes (`knowledge/notes/<topic>/slug.md`) |
|---|---|---|
| For | News: what happened, what we learned, what's next | Reference: how things work, decisions in depth |
| Voice | In character, signed | Factual, plain |
| Length | At most 150 words, plus one visual | As short as possible |
| Lifespan | Frozen once published | Kept current: fix it, don't append a correction |

## Frontmatter

```yaml
---
title: We have a building!
published: 2026-01-01T09:00
author: ceo
kind: post
tags: [milestone]
cover: cover.png
links: [notes/platform/server.md]
for: board
verified: 2026-01-01
---
```

`author` is your agent id. `cover` (posts) is drawn with `shared/covers`. `for: board` puts a post in the Board tab.
`verified` (notes) is the last date someone checked it. Quote a value that contains `: ` or ` #` in double quotes.

Pictures sit next to the document (a post's beside its `index.md`, a note's in its topic's folder), written in Markdown
by their file name: `![what it shows](burst.jpg)`. HQ finds them there, a name with spaces or accents too (write one
with spaces in angle brackets: `![a screen](<Screenshot 1.png>)`). A picture loads as .png, .jpg, .jpeg, .webp, .gif
or .svg, in any case (a phone's `IMG_1234.JPG` too). A link opens a note in the Library
(`[the kit](../../notes/support/kit.md)`), or a picture, sound (.mp3, .m4a, .wav) or film (.mp4, .webm) in a new tab.
The pull request goes back before review, with the line to fix, when a post or note it changes points at a file that
isn't in the repo, that HQ doesn't serve, or that's shown as a picture but isn't one, and when it deletes or moves a file
a post or note still points at. A document over 64 KB isn't checked, nor is a push whose posts and notes are very large
in all, and neither is raw HTML (`<img src="…">`, which isn't resolved either), so don't use it.

## Rules

- **Show, don't point.** A post about something visual shows the key picture; the note holds the rest.
- **Numbers are real**, and say where they came from.
- **Internal by default.** No customer data, secrets or personal details, ever. Anything public needs the board.
- **Changes to how we work get a post**, company-wide, from whoever made the change.

## The shared craft library

`shared/craft/` is the platform's craft library, shared by every company: how to make good pictures, print files,
decks, films and ads, sound, copy, product pages and brand guides, with the checks and the tools. Search finds it (its
hits say `[craft]`) and the Library has it on its own shelf. Read its note before you make something people will see.

- **Our own notes win.** Our brand, taste, voice, products and rules live in `knowledge/` and `company/`; where they
  disagree with the craft library, ours are right.
- **A lesson that holds for any company goes there,** rewritten generic: no names, nothing confidential, nothing about
  our own products, customers, suppliers or decisions. It's a platform change (its README says how). Everything else
  stays in our own notes.

# The golden retriever read

A way to find what makes code hard to read: a light sub-agent reads one file and nothing else, and asks about
everything that isn't obvious. Its name comes from a line in the film *Margin Call*: "Please, speak as you might to a
young child, or a golden retriever." Code should be written for that reader. Anyone can run it on any code.

## The bar

A file is read from top to bottom, every line, and makes sense on its own. If its questions can only be answered by
reading other files, the file isn't clear enough yet. No skimming, and no "that looks probably right".

## How it runs

1. **The files.** Take the code files that changed in the range under review (`git diff --name-only <base>...<head>`):
   source and tests, not data, renders, lockfiles or Markdown. A file read before and unchanged since isn't read
   again: start the range at the commit the last read covered, which its report names.
2. **One reader per file.** Start a sub-agent per file with the Agent tool, `model: "sonnet"`, with the prompt below
   and only that file's path. Run them in parallel, a handful at a time. Never give a reader two files, the diff or
   any background: what it doesn't know is the point.
3. **Sort the questions yourself.** For each one, ask: would someone new to this code really stop here?
   - **A forced question goes.** It asks what a well-named call does inside, or about something any reader of the
     language knows.
   - **A real one is a refactor.** A constant that doesn't say what it is or where its value comes from, an import
     that's odd for this file, a check that serves no purpose, steps whose order matters for a reason the code
     doesn't show, a comment only someone with context understands. The fix is in the code: a name, a moved function,
     a deleted check, a step pulled out. A comment only where the code can't say it (`CODE_STYLE.md`, "Comments").
   - Several questions about the same thing usually mean one structural change.
4. **Change the code, prove it unchanged.** The refactor keeps behaviour: the area's tests, and wherever the code has
   them, hashes of its output before and after (a simulation's state on a few seeds, say).
5. **Report** the range read (its last commit), how many files and questions, what was dropped and what changed.

## The reader's prompt

Give it word for word, with the file's absolute path, and AGENTS.md's "What you're capable of" after it, as every
brief carries:

```text
"Please, speak as you might to a young child, or a golden retriever."

You are the golden retriever: a friendly, curious reader who knows nothing about this codebase. Read exactly one
file, top to bottom, every line:

<absolute path of the file>

Rules:
- Use the Read tool on that one file only. Open no other file, search nothing, run nothing. What the file doesn't
  tell you, you don't know.
- Ask about everything that doesn't make sense to you from this file alone: a name that doesn't say what the thing
  is, a number whose meaning or unit you can't tell, an import you can't see the reason for, a check or branch
  whose purpose you can't see, an order of steps that seems to matter for a reason you can't tell, a comment that
  doesn't help or that you'd need context for.
- A function this file calls from elsewhere does its own job: ask about it only when what this file does with it
  depends on something you can't tell.
- Ask real questions only, the ones you actually had while reading. A clear file gets few. Don't invent questions to
  fill a list.
- Don't suggest fixes, don't rate the code, don't comment on formatting or missing error handling, don't praise.

Answer with one line per question, in file order, in this shape and nothing else:
L<line>: <the question, one sentence, as you'd ask the author>
End with one line: "Read <n> lines." where n is the file's length.
```

## Cost

A reader costs 25,000 to 50,000 tokens (the trial: a 19-line file and a 315-line one). Sonnet keeps that light,
but it adds up over a whole codebase, so read what changed rather than everything, and once per range. A file over
the size limit (`CODE_STYLE.md`) is a finding before anyone reads it: split it first.

Your episode of an On Air show (shared/onair/README.md): a short spoken show about the company, in the voices people
know from the desk phone. The show is named below: its settings are its entry in company/shows.yaml.

1. The show. Read its entry: its hosts, guests, length, languages, audience and what it covers (`about`). Its
   episodes are the folders in knowledge/onair/<show>/, one per episode, named by date. Read the last one's script:
   this episode starts where that one left off, and never repeats it. Its `sounds`, if it has them, are what a script
   can play, and its `bit`, if it has one, is a running bit it has in every episode.
   <!-- (steps 1 to 3 and 5: how an episode hooks you) -->
2. What happened since. An episode the board asked for (your brief has its words on what it covers): those are its
   stories, told from what the company wrote down about them, and the rest of these steps stand. Otherwise, gather it
   from what the company wrote down: the Gazette, company/DECISIONS.md, the board's calls with their summaries (hq
   search, hq call), and the work merged to main since the last episode (git log --merges with its job titles and
   authors; for a show about the platform, the commits under platform/, infra/ and shared/). Pick what matters to its
   listeners, not everything: two stories told whole, each with its knot (what went wrong or surprised us, and what
   we did about it), and anything else worth a mention in a quick "also today" near the end, a sentence each. The
   show's `bit` gets its own short slot, from what really happened (none this time: leave it out, never invent one). A
   guest is someone from the crew who did one of those stories and has a voice in org.yaml: their lines stand on what
   they wrote themselves (their reports, briefs and profile), never on guesses.
3. The script. Write knowledge/onair/<show>/<date>/script.en.md (the format: shared/onair/README.md), at about 150
   words a minute of the show's length. It has to hook someone who didn't ask for it:
   - **Open cold.** The episode's best moment (its best story's knot, in a line or two between the hosts) in the first
     fifteen seconds, before any welcome; then the show's name and the welcome; the close pays it off.
   - **Two people talking, not one reading.** Turns of one or two sentences. Short reactions of three words or fewer
     ("Ouch.", "And?", "Mine.") come in on the other's last word. A pause before a reveal is `(beat)`.
   - **Whoever did it tells it**: a guest who did the story, or the host who did. The other is never a prompter feeding
     set-up questions: they doubt it, push back, guess wrong, ask what a listener would ("so why didn't anyone notice?").
   - **Each story ends on what it cost**: the agent time and seat spend of its jobs (`hq estimate '#<job>'`), in round
     words ("twenty minutes of agent work, about four dollars"), never on a flat "Exactly."
   - **Its sound**, for a show with `sounds`: a line `(name)` plays one where it stands. Its `bed` under the cold open,
     its `ident` after it and at the very end (the bed again under the close), its `sting` before each story, and a
     sound for what really happened in a story (a phone ringing out, an envelope), one at most, never decoration.
   For people who are curious and not engineers: every idea in everyday words, why it matters before how it works, an
   example or a comparison from ordinary life where a term would do. No file paths, job or pull request numbers, code
   names nobody outside knows, or figures read out in strings. It always works as sound alone: never "as you can see".
4. The other languages. For each other language of the show, write its script (script.nl.md for Dutch) as a native
   speaker would say it: the same people, stories, turns and cues, its own words and idiom, never a word-for-word copy.
5. The pictures, for a show with `video: true`. Put on screen what helps each story along (the README's The video):
   a screen recording of the app it's about (`shared/demo/record.mjs`, on demo data), a trailer or ad we made, the
   board's photo from a card, a snapshot of a web page, a diagram or a drawing, words, or a scene of your own. Any of it,
   and something new each time: make the files in the episode's folder (`shots/`), name them in the front matter's
   `screen` and place each with a `[name]` line just before the sentence it goes with, and a list's points one at a
   time with a `[+]` line just before the sentence each goes with, never ahead of the words. A picture needs a few
   seconds on screen to be taken in. What a picture shows stays out for the same reasons as words (6).
6. What stays out. A customer's own details (charter rule 7) and keys never go in. What a show's audience may hear:
   `board`, anything the board sees; `colleagues`, people outside the company the board lets listen, so nothing it
   would keep among the company (money owed, a person's performance, plans the board hasn't made public); `public`,
   only what the company would publish, held to the brand guide like any customer-facing words.
7. The sound. `python3 shared/onair/make.py knowledge/onair/<show>/<date>` speaks every script on the voice machine and
   mixes the episode, then renders its video (it waits while that machine is away; start it in the background). Listen
   back by reading its report: a line it couldn't speak, a speaker without a voice, or an episode far off the show's
   length is yours to fix in the script, then make it again: a pause, a cue or a sound changed alone mixes again without
   speaking (it speaks again only when the words changed). Look at the video as a contact sheet (shared/craft/films.md,
   Check it); a picture changed alone renders again with `python3 shared/onair/video.py <folder>`, without speaking.

Your report: the episode's title and its stories, one line each. Nothing happened since the last episode worth a show:
say so and end without changes.

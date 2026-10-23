# On Air

A company's shows: short spoken episodes about what it's doing, in the voices the board knows from the desk phone, in
every language the show has. A daily digest of two minutes, a longer show on Fridays with the crew, a weekly one about
the platform: each is a few lines in `company/shows.yaml`. The board listens in HQ's On Air (the computer), or in any
podcast app through the show's link, and so can colleagues it gives the link to.

## A show

```yaml
# company/shows.yaml
- id: digest # its folder, knowledge/onair/digest/, and its recurring job, show-digest
  name: The Morning Digest
  at: '06:45' # as schedule.yaml's `at` ("Fri 15:45", "every 4h"); none: on demand only
  hosts: [juno] # crew with a `voice` in org.yaml; the first makes the episode unless `producer` names another
  guests: crew # optional: the host invites who did the stories, or a list of ids
  minutes: 2
  languages: [en, nl] # the first is written first; each other is written fresh from it, never word for word
  audience: colleagues # board | colleagues | public (what may be said: shared/routines/show.md)
  video: true # optional: each episode comes out as a video too (The video, below); without it, sound only
  deck: { css: theme/look/deck.css, script: theme/look/deck.js } # optional: the video in the company's own look (The video)
  about: Two minutes on what got done yesterday and what needs you today.
  bit: 'Overheard: one thing a customer said this week' # optional: a running bit in every episode, when there's one
  sounds: # optional: what a script can play (Its sound, below), files from the repo's root
    ident: theme/onair/ident.wav
    bed: theme/onair/bed.wav
    sting: theme/onair/sting.wav
    ring: { file: theme/onair/ring.wav, under: 10, words: 0.9 } # an effect, by any name
```

Each show is a recurring entry beside schedule.yaml's: a scheduled project in HQ's projects view (under Recurring), each
episode a thread in it, with Run now in On Air. Its job is the show routine (`shared/routines/show.md`) for its
producer: what happened since the last episode, the script, the other languages, the sound.

An episode on what the board asks ("a podcast on X and Y", on a call or the intercom) is a job for the show's producer
that follows the same routine, its brief naming the show and the board's words on what it covers: those are its
stories. The CEO queues it (`hq job <producer> ...`), on the company's show for that unless the board names another.

## An episode

A folder per episode, `knowledge/onair/<show>/<date>/` (a second one the same day: `<date>-2`), with a script per
language and its sound:

```markdown
---
title: Thursday: the shop opens its doors
summary: The shop went live, and the first three orders came in before lunch.
---

Juno: Good morning! Big day yesterday.
Wren: The biggest. The shop opened its doors at nine,
and the first order came in before ten.
```

A line that starts with a speaker's name (or id) and a colon starts their turn; the lines after it carry it on. Every
speaker is a crew member with a `voice` in org.yaml. So a line of the words themselves never starts "Word: ". A line
`(name)` is a sound cue (Its sound, below), a line `[name]` a picture (The video): neither is ever spoken.

`python3 shared/onair/make.py <episode folder>` makes `episode.<lang>.mp3` for each script: renders
(`shared/demo/renders.mjs`), kept out of git, back in the server's checkout once merged. Beside each goes
`episode.<lang>.timings.json` (committed): who says each sentence of the script, in its own words, and when. A script
that puts anything on screen gets its video too (below). Numbers are written out first, as the desk phone does
(`platform/voice/aloud.py`). The speaking happens on the voice machine (below), each sentence a clip of its own, all at
one level: `episode.<lang>.speech.wav`, a render too, with `episode.<lang>.speech.json` (what was said, where each
clip is). The mix and the mastering happen in the job (podcast loudness, -16 LUFS), so a pause or a sound changed
alone mixes again without speaking: make.py speaks again only when a script's words or voices changed, and then
only the sentences the kept speech doesn't already say in the same voice. The same
script speaks alike every time, but not byte for byte: speech isn't deterministic, so `renders.mjs check` on an
episode says it differs.

A name the voice says wrong is spelt as it sounds in the script's front matter, for the voice alone: `say: { Siobhan:
Shiv-awn }` (each written word, whole, as it's to be said). The captions and timings keep the script's own spelling,
and each language's script has its own.

## Its sound

Two people talking, not one long read: make.py lays the clips out as people speak. A short pause between sentences,
a longer one between turns, and a reaction (a turn of three words or fewer, "Ouch.") coming in on the other's last
word. A room tone under everything, far below the voices, so a pause never drops to digital silence.

A line `(name)` plays the show's sound of that name where it stands (its `sounds` in shows.yaml), and the words after
it come in over its tail. `(beat)` is a held pause, before a reveal. Three names have a role: `ident` (the show's own
short tune, after the cold open and to close), `sting` (between stories) and `bed` (from its cue, under the voices,
ducked while they speak, until the next ident or sting has played, or the end). Any other name is an effect, for
something that happened in the story. Each sits a set loudness `under` the voices (LU: an ident 2, a sting 5, the bed
14, an effect 7) and the next words come in at its `words` share (an ident or sting halfway, an effect two thirds in);
a sound's entry can set its own. A cue the show has no sound for stops the mix with the reason.

```markdown
(bed)
Bolt: Our first phone call to a partner.
Juno: And they remember it differently.
(beat)
Bolt: They do.
(ident)
Juno: This is On Air. I'm Juno.
```

A show's sounds are its company's own: made in code, renders like any other (a WAV is never committed), named in its
entry in shows.yaml. make.py renders one this clone lacks again from its recipe, which makes the same file every time. A kept
speech this clone lacks is fetched from HQ; when HQ has none, `renders.mjs render` on it speaks it again.

## The video

The same episode with something to look at: the sound as it is, and on screen whatever helps it along. The script never
leans on the picture ("as you can see"), so the sound alone still tells it all. On screen goes anything that helps: a
screen recording of an app, a trailer or ad (muted: the only sound is the hosts), a photo the board sent with a card
(`hq photos <request>`) or shared on a call (`hq picture <id>`), a snapshot of a web page, a diagram, a drawing, words,
a table, or a scene of its own in HTML that moves however it likes.

What goes on screen is written in the script itself. Its front matter names each picture under `screen`, as one of the
demo kit's deck sections (`shared/demo/README.md`, present.mjs: `text`, `image`, `recording`, `ad`, `table`, `title`,
or `html` for a scene of its own, which follows the kit's scene contract). A line `[name]` puts it on screen from the
pause before the next sentence until the next `[name]`, so a picture lands as the words it goes with begin. Files are
the episode folder's (`shots/`), or anywhere in the repo from its root (`/products/<slug>/ads/ad.mp4`).

```markdown
---
title: How long does a job take?
summary: Why we size work in minutes.
screen:
  bars: { type: html, html: shots/estimate.html }
  menu: { type: image, image: shots/menu.png, title: Where it shows up }
  trailer: { type: ad, src: /products/<slug>/ads/<slug>-ad.mp4, title: A big build }
---

Juno: A person guesses in days.
[bars]
An agent works in minutes.
[menu]
Wren: And you see it right next to every job.
```

Until the first `[name]` the screen shows the episode's title and summary, and every sentence is captioned in its
speaker's name. Every video of a show wears the company's look: its `deck` in shows.yaml names a stylesheet (`css`,
over the demo kit's deck) and a module (`script`, imported once the slides are built, to draw on them), both from the
company's own files, so its colours, type and drawings come from where its other pages read them. An episode's own
`html` screens import the same files. `theme` and `css` in an episode's front matter restyle it further (as a deck
manifest's). Each language's script has its own `screen`, in its own words.

A screen with `points` shows them as they're said: a line `[+]` after its `[name]` brings on its next point, at the same
pause before the next sentence, the newest bright and the ones before it stepped back. One `[+]` for each point, or
none, and they all come with the screen. An `html` screen takes as many `[+]` as it likes: their times reach its page
in its address, `#steps=1.2,3.4` (seconds from the screen's start), for it to draw its own points.

```markdown
[why]
Bolt: The email left us, to the right address.
[+]
Juno: And they never saw it?
[+]
Bolt: Never. It went out without the thread's number.
```

The speakers are on screen the whole time, as HQ draws them (their org.yaml `look`, seeded by id), from the waist up
at the foot of the picture, the first half on the left and the rest on the right. Whoever is speaking is lit, their
mouth moving with the sound and their words in a bubble on their side; the others are dimmed, listening, blinking. A
reaction over the other's last word takes the bubble, and both are lit. They hop as they come in on a turn and point
as a screen or a point comes on, and the light behind the slides drifts, so a screen held long still breathes. None of
it is per episode: it comes from the script and its timings.

`python3 shared/onair/video.py <episode folder>` renders `episode.<lang>.mp4` (1920x1080, 24 frames a second, the AI
label in its language) for each script that puts anything on screen, from the sound and its timings: a render too, so
the pictures can change and render again without speaking it again. A script whose words changed since it was spoken,
a `[name]` with no `screen` entry, a missing file, a `[+]` before any screen or with no point left to show,
or a point no `[+]` shows stops it with the reason. It's drawn as every film of the demo kit
is: in a job, on the company's `render` kind of run (`shared/demo/README.md`, On a lent machine), here when no machine takes it.
The voice image has what that needs (below), so a company can name it for its `render` kind too.

## The voices

Each speaker's voice is the one they have on the desk phone. English is Pocket TTS itself, the voice line's engine. Any
other language is Chatterbox Multilingual (MIT, 23 languages, Dutch among them), copying the speaker's voice from a few
seconds Pocket TTS speaks in it, so Juno sounds like Juno in Dutch too.

That runs on the `voice` run kind (`platform/helper/README.md`): a machine with a graphics card, never the server. Its
image is `shared/onair/Dockerfile`, built by the foundation's `.github/workflows/onair-voice.yml` into its private
package, which a lent machine pulls with HQ's registry key (`REGISTRY_GHCR_TOKEN`). A company uses that image, declared
in org.yaml by its digest:

```yaml
runs:
  kinds:
    voice:
      about: On Air's speech (shared/onair), on the graphics card
      image: ghcr.io/<owner>/onair-voice@sha256:<digest>
      gpus: true
      lentOnly: true # never this server's helper: an episode waits while the machine is away
      cpus: 8
      memoryGb: 24
      diskGb: 20
```

## Listening

HQ's On Air lists each show's newest episodes with a player, in the language picked (kept per device), at the speed
picked, one playing at a time, and Watch on an episode with a video. Each show has a podcast feed per language,
`/onair/<show>.<lang>.xml` (`platform/coordinator/src/onair.ts`), and once it has videos a feed of them,
`/onair/<show>.<lang>.video.xml`. A show for the board or colleagues has a private link, the feed's key, which
HQ's New link replaces (every app with the old one stops getting episodes); its feed asks directories not to list it. A
public show's feed is open. A new episode is announced with a push once its sound is on the server.

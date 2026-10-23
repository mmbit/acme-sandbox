#!/usr/bin/env python3
"""An On Air episode's video (README.md, The video): its sound, with what the script puts on screen timed to the words
and every sentence as a caption, rendered by the demo kit's present.mjs into episode.<lang>.mp4, a render
(shared/demo/renders.mjs). It needs the episode's sound and episode.<lang>.timings.json, both from make.py.

  python3 shared/onair/video.py <episode folder>          every language whose script has a screen
  python3 shared/onair/video.py <episode folder> <lang>   one language (what its render's recipe runs)
"""
import json, os, subprocess, sys
from pathlib import Path

import yaml

import make

ROOT = make.ROOT
LABEL = {'en': 'Made with AI', 'nl': 'Gemaakt met AI', 'de': 'Mit KI erstellt', 'fr': "Créé avec l'IA"}  # house rule 5
FPS = 24  # a talk, not an ad: fewer frames to draw, and recordings still move smoothly
CAPTION_WORDS = 12  # a caption is at most two lines at the deck's size, about five seconds of speech
SOURCES = ('image', 'src', 'html')
STEP = '+'  # a line `[+]`: the screen's next point comes on


def manifest(folder, lang):
    """present.mjs's manifest (shared/demo/README.md) for one language: a title card until the first cue, then each
    cue's screen from the pause before the sentence it comes before, to the next one or the end of the sound, its
    points each from its own `[+]` if it has any; the speakers on screen as hosts."""
    path = folder / f'script.{lang}.md'
    said, sound = make.script(path), folder / f'episode.{lang}.mp3'
    meta, screen = said['meta'], said['meta'].get('screen') or {}
    if lang not in LABEL:
        raise SystemExit(f'{path}: no AI label in {lang} yet: add it to LABEL in {Path(__file__).relative_to(ROOT)}')
    timings = spoken(folder, lang, said['turns'])
    seconds = make.seconds(sound)
    # each screen cue with its `[+]` steps' times
    opening = {'type': 'title', 'title': meta.get('title', ''), 'sub': meta.get('summary', '')}
    starts = [[0.0, opening, None, []]]
    for cue in said['cues']:
        at = switch(said, timings, cue)
        if cue[0] != STEP:
            starts.append([at, entry(path, folder, screen, cue[0]), cue[0], []])
        elif starts[-1][2] is None:
            raise SystemExit(f'{path}: a [{STEP}] comes before any screen, so it has no point to show')
        else:
            starts[-1][3].append(at)
    if len(starts) == 1:
        raise SystemExit(f'{path}: nothing goes on screen (a line `[name]` shows its `screen` entry)')
    sections = []
    for (start, section, name, steps), (end, _, later, _) in zip(starts, starts[1:] + [[seconds, None, None, []]]):
        if end <= start and name:
            raise SystemExit(f'{path}: [{name}] and [{later}] come before the same sentence, so [{name}] never shows')
        if end > start:
            sections.append({**section, 'dur': round(end - start, 3), **reveals(path, name, section, steps, start, end)})
    show = show_of(folder)
    return {'title': show['name'], 'audio': sound.name, 'fps': FPS, 'label': LABEL[lang], 'sections': sections,
            'captions': captions(timings), 'hosts': hosts(timings), **look(show, meta)}


def look(show, meta):
    """The deck's look: the show's own (its `deck` in shows.yaml, a stylesheet and a script from the repo's root, so
    every episode wears the company's look from its own files), then the episode's `theme` and `css` over it.
"""
    deck = show.get('deck') or {}
    css = [f'/{deck["css"]}'] if deck.get('css') else []
    css += [meta['css']] if meta.get('css') else []
    return {**({'css': css} if css else {}), **({'script': f'/{deck["script"]}'} if deck.get('script') else {}),
            **({'theme': meta['theme']} if 'theme' in meta else {})}


def reveals(path, name, section, steps, start, end):
    """A screen's `steps`: when each of its points comes on, from its start, one for each `[+]` after its cue; none
    without one, so its points all come in with it. An `html` screen draws its own, as many as it has `[+]`s
."""
    if not steps:
        return {}
    points = section.get('points') or []
    if section['type'] != 'html':
        if len(steps) > len(points):
            raise SystemExit(f'{path}: [{name}] has {len(points)} point{"s" * (len(points) != 1)} and {len(steps)} '
                             f'[{STEP}] after it: a [{STEP}] with no point left to show')
        if len(steps) < len(points):
            raise SystemExit(f'{path}: [{name}] has {len(points)} points and {len(steps)} [{STEP}] after it, so its '
                             f'last {"point never shows" if len(points) - len(steps) == 1 else "points never show"}: '
                             f'a [{STEP}] for each')
    if steps[-1] >= end:
        raise SystemExit(f'{path}: [{name}]\'s last [{STEP}] comes before the same sentence as the next screen, so its '
                         'point never shows')
    return {'steps': [round(t - start, 3) for t in steps]}


def hosts(timings):
    """Everyone who speaks, in the order they first do: as HQ draws them (their org.yaml `look`, and `sprite` if they
    have one)."""
    known, out = make.crew(), {}
    for line in timings:
        who = line['speaker']
        if who not in out:
            agent = known.get(who.lower(), {})
            out[who] = {'id': agent.get('id', who.lower()), 'name': who, 'look': agent.get('look', ''),
                        **({'sprite': agent['sprite']} if agent.get('sprite') else {})}
    return list(out.values())


def spoken(folder, lang, turns):
    """The sentences' timings, as long as the script still says what was spoken."""
    file = folder / f'episode.{lang}.timings.json'
    if not file.exists():
        raise SystemExit(f'{file}: none yet: make the sound first (make.py)')
    timings = json.loads(file.read_text())['lines']
    now = [[x for _, x in make.sentences(words)] for _, words in turns]
    if now != [[s['text'] for s in line['sentences']] for line in timings]:
        raise SystemExit(f'{folder / f"script.{lang}.md"}: its words changed since it was spoken: make the sound again')
    return timings


def switch(said, timings, cue):
    """When a cue's screen comes on: in the pause before the first sentence that starts after the cue."""
    name, turn, at = cue
    later = [(k, n) for k, (_, words) in enumerate(said['turns']) for n, (start, _) in enumerate(make.sentences(words))
             if k > turn or k == turn and start >= at]
    if not later:
        raise SystemExit(f'[{name}] comes after the last words, so it never shows')
    k, n = later[0]
    before = timings[k]['sentences'][:n] or (timings[k - 1]['sentences'] if k else [])
    return before[-1]['end'] if before else 0.0


def entry(path, folder, screen, name):
    """A cue's screen: one of present.mjs's sections, its files from the episode's folder (or the repo's root, `/...`)."""
    section = screen.get(name)
    if not isinstance(section, dict) or 'type' not in section:
        raise SystemExit(f'{path}: [{name}] has no `screen` entry with a `type` (present.mjs\'s sections)')
    for key in SOURCES:
        given = section.get(key)
        file = given and (ROOT / given.lstrip('/') if given.startswith('/') else folder / given)
        if file and not file.exists():
            raise SystemExit(f'{path}: [{name}]\'s {key}, {given}, isn\'t there')
    return section


def captions(timings):
    """Every sentence on screen while it's said, in its speaker's name, a long one in turns of CAPTION_WORDS words
    timed by their share of its letters."""
    out = []
    for line in timings:
        for s in line['sentences']:
            words = s['text'].split()
            parts = -(-len(words) // CAPTION_WORDS)
            chunks = [' '.join(words[round(i * len(words) / parts):round((i + 1) * len(words) / parts)])
                      for i in range(parts)]
            at, per = s['start'], (s['end'] - s['start']) / max(1, sum(map(len, chunks)))
            for text in chunks:
                out.append({'who': line['speaker'], 'text': text, 'start': round(at, 3),
                            'end': round(at + len(text) * per, 3)})
                at += len(text) * per
    return sorted(out, key=lambda c: c['start'])  # a reaction can start before the turn it answers ends


def show_of(folder):
    shows = yaml.safe_load((ROOT / 'company/shows.yaml').read_text()) or []
    show = next((s for s in shows if s.get('id') == folder.parent.name), None)
    if not show or not show.get('name'):
        raise SystemExit(f'{folder}: no show {folder.parent.name} with a name in company/shows.yaml')
    return show


def render(folder, lang):
    """present.mjs draws every frame in a browser: in a job, on a machine the board lends, with the files the deck shows
    (shared/demo/README.md, On a lent machine)."""
    out = os.environ.get('DEMO_RENDERS_MAKING') or str(folder / f'episode.{lang}.mp4')
    deck = folder / f'.video.{lang}.json'
    deck.write_text(json.dumps(manifest(folder, lang), ensure_ascii=False))
    try:
        subprocess.run(['node', 'shared/demo/present.mjs', str(deck), '--out', out], cwd=ROOT, check=True)
    finally:
        deck.unlink()


def main(folder, lang=None):
    folder = Path(folder).resolve()
    if lang:
        return render(folder, lang)
    langs = [x for x in sorted(p.name.split('.')[1] for p in folder.glob('script.*.md')) if wanted(folder, x)]
    if not langs:
        raise SystemExit(f'{folder}: no script puts anything on screen')
    for lang in langs:
        make_mp4(folder, lang)


def wanted(folder, lang):
    """Whether a language's script puts anything on screen."""
    return any(cue[0] != STEP for cue in make.script(folder / f'script.{lang}.md')['cues'])


def make_mp4(folder, lang):
    """The video as a render of its own, its recipe this tool for that language (renders.mjs make)."""
    mp4 = folder / f'episode.{lang}.mp4'
    subprocess.run(['node', 'shared/demo/renders.mjs', 'make', str(mp4.relative_to(ROOT)), '--', 'python3',
                    'shared/onair/video.py', str(folder.relative_to(ROOT)), lang], cwd=ROOT, check=True)


if __name__ == '__main__':
    if not 2 <= len(sys.argv) <= 3:
        raise SystemExit(__doc__)
    main(*sys.argv[1:])

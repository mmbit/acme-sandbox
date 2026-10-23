#!/usr/bin/env python3
"""An On Air episode's sound (README.md): each script.<lang>.md in the episode's folder spoken on the voice machine
(`hq run --kind voice`: speak.py), each sentence a clip of its own, kept as episode.<lang>.speech.wav (a render,
shared/demo/renders.mjs) with episode.<lang>.speech.json beside it (what was said, where each clip is). The clips are
laid out here with the script's pauses, reactions and the show's sounds and mastered into episode.<lang>.mp3, a render
too, with episode.<lang>.timings.json beside it: when each sentence is said. So a pause or a sound moves without
speaking again. A script that puts anything on screen gets its video too (video.py).

  python3 shared/onair/make.py <episode folder>                 every language the folder has a script for
  python3 shared/onair/make.py <episode folder> <lang>          one language's sound (its render's recipe), spoken
                                                                first if its words changed
  python3 shared/onair/make.py <episode folder> <lang> speech   one language's speech (the speech's recipe)
"""
import json, os, re, shutil, subprocess, sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'platform/voice'))
from aloud import aloud, respelt  # noqa: E402 (the voice line's own numbers in words, and the company's respellings)
import takes  # noqa: E402 (a sentence still said alike keeps its take)

WPM = 150  # words a minute, as the show routine writes them
TURN = re.compile(r'^([^\s:][^:]{0,39}):\s+(.*)$')
# the screen cues and sentence timings
CUE = re.compile(r'^\[([^\]]+)\]$')
# a sound cue, `(sting)`: one of the show's sounds, or a held pause, `(beat)`
SOUND = re.compile(r'^\(([a-z][a-z0-9-]*)\)$')
SENTENCE = re.compile(r'(?<=[.!?…])\s+')
# The layout (seconds): the gap before a sentence of the same turn, before a new turn, before a reaction (a turn of
# REACT words or fewer, coming in on the other's last word), a `(beat)`'s held pause, and before a sound.
GAP = {'sentence': 0.25, 'turn': 0.32, 'react': -0.12, 'beat': 0.9, 'sound': 0.35}
REACT = 3
# A sound by its role: how far under the voices it sits (LU), and how far into it the next words come in (its share).
# `bed` plays under the voices, ducked, from its cue until the next ident or sting has played, or the end.
ROLES = {'ident': {'under': 2, 'words': 0.5}, 'sting': {'under': 5, 'words': 0.5}, 'bed': {'under': 14, 'words': 0}}
EFFECT = {'under': 7, 'words': 0.66}  # any other sound: an effect, for something that happened in the story
ROOM = -46  # the room tone under everything, dB under the voices, so a pause never drops to digital silence


def script(path):
    """A script: its front matter, its turns ([[speaker, words]], from its lines after the front matter: `Name: words`
    starts a turn, a line without a name carries it on, a blank line is only a break), its screen cues (a line
    `[name]` puts the front matter's `screen` entry of that name on screen) and its sound cues (a line `(name)`: the
    show's sound of that name, or `(beat)`, a held pause), each kept as [name, turn, at], `at` the length of that
    turn's words before it."""
    text, meta = path.read_text(), {}
    if text.startswith('---'):
        _, head, text = text.split('---', 2)
        try:
            meta = yaml.safe_load(head) or {}
        except yaml.YAMLError as e:
            raise SystemExit(f'{path}: its front matter isn\'t YAML: {e}')
    said, cues, played = [], [], []
    for line in filter(None, (x.strip() for x in text.splitlines())):
        m, cue, sound = TURN.match(line), CUE.match(line), SOUND.match(line)
        here = [max(0, len(said) - 1), len(said[-1][1]) if said else 0]
        if cue:
            cues.append([cue[1].strip(), *here])
        elif sound:
            played.append([sound[1], *here])
        elif m:
            said.append([m[1].strip(), m[2].strip()])
        elif said:
            said[-1][1] += ' ' + line
        else:
            raise SystemExit(f'{path}: "{line[:40]}" comes before anyone speaks')
    return {'meta': meta, 'turns': said, 'cues': cues, 'sounds': played}


def turns(path):
    return script(path)['turns']


def sentences(words):
    """A turn's words in sentences, each [at, sentence], `at` where it starts in the words."""
    out, at = [], 0
    for sentence in filter(None, SENTENCE.split(words)):
        at = words.index(sentence, at)
        out.append([at, sentence])
        at += len(sentence)
    return out


def crew():
    """Each crew member by id and by name, lower case (org.yaml's departments)."""
    org = yaml.safe_load((ROOT / 'company/org.yaml').read_text())
    agents = [a for d in org.get('departments') or [] for a in d.get('agents') or []]
    return {k.lower(): a for a in agents for k in (a['id'], a.get('name', a['id']))}


def respellings(lang):
    """The company's words as the speech engines should say them in lang (brand.yaml speech.respell)."""
    brand = yaml.safe_load((ROOT / 'company/brand.yaml').read_text())
    return brand.get('speech', {}).get('respell', {}).get(lang, {})


def lines(path, lang):
    """The lines the voice machine speaks: [{voice, sentences}], every number written out in the script's language and
    each word in the front matter's `say` spelt as it's to be said, then the company's words respelt."""
    known, parsed = crew(), script(path)
    said, respell = parsed['turns'], spelt(path, parsed['meta'].get('say'))
    company = respellings(lang)
    missing = sorted({who for who, _ in said if not known.get(who.lower(), {}).get('voice')})
    if missing:
        raise SystemExit(f'{path}: no voice in org.yaml for {", ".join(missing)} (a speaker is a crew member with a '
                         '`voice`; a line that starts "Word: " is read as someone speaking)')
    return [{'voice': known[who.lower()]['voice'],
             'sentences': [aloud(respelt(respell(x), company), lang) for _, x in sentences(words)]}
            for who, words in said]


# (a name the voice says wrong, spelt for the voice alone)
def spelt(path, say):
    """The front matter's `say` ({written: spoken}, a name the voice gets wrong spelt as it sounds) as a function on a
    sentence: each written word, whole, as it's to be said. The captions and timings keep the script's own spelling."""
    if not say:
        return lambda x: x
    if not isinstance(say, dict) or not all(isinstance(k, str) and isinstance(v, str) and k and v
                                            for k, v in say.items()):
        raise SystemExit(f'{path}: `say` is a word or name as written, each with how the voice should say it')
    words = re.compile('|'.join(rf'(?<!\w){re.escape(k)}(?!\w)' for k in sorted(say, key=len, reverse=True)))
    return lambda x: words.sub(lambda m: say[m[0]], x)


def voice_run(rel, said):
    """The `hq run` that speaks the lines in folder rel (from the repo root) on the voice machine. `hq run` reads
    --paths and --bring as one comma-separated value each."""
    words = sum(len(s.split()) for x in said for s in x['sentences'])
    return ['hq', 'run', '--kind', 'voice', '--paths', f'shared/onair,{rel}', '--bring', f'{rel}/speech.flac,{rel}/speech.json',
            '--minutes', str(max(20, round(words / WPM * 3))), '--', '/opt/voice/bin/python', 'shared/onair/speak.py', str(rel)]


def show(folder):
    """The episode's show: its entry in company/shows.yaml (the episode's folder is in the show's)."""
    shows = yaml.safe_load((ROOT / 'company/shows.yaml').read_text()) or []
    return next((s for s in shows if s.get('id') == folder.parent.name), {})


def rel(path):
    return str(path.relative_to(ROOT))


# (the speech a render of its own, each sentence its own clip; the mix here)
def speak(folder, lang):
    """The speech: each sentence spoken on the voice machine as a clip of its own, one after another in
    episode.<lang>.speech.wav, and episode.<lang>.speech.json beside it: the lines spoken and where each clip is. A
    sentence the kept speech already says in the same voice keeps its take: only the new ones are spoken."""
    path = folder / f'script.{lang}.md'
    said = lines(path, lang)
    have = takes.kept(folder / f'episode.{lang}.speech.wav', folder / f'episode.{lang}.speech.json')
    new = [{'voice': x['voice'], 'sentences': [s for s in x['sentences'] if (x['voice'], s) not in have]} for x in said]
    new = [x for x in new if x['sentences']]
    if new:
        work = folder / '.speech' / lang
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True)
        (work / 'lines.json').write_text(json.dumps({'lang': lang, 'lines': new}, ensure_ascii=False))
        subprocess.run(voice_run(work.relative_to(ROOT), new), cwd=ROOT, check=True)
        have.update(takes.cut(takes.pcm(work / 'speech.flac'), new, json.loads((work / 'speech.json').read_text())))
        shutil.rmtree(work)
        if not any((folder / '.speech').iterdir()):
            (folder / '.speech').rmdir()
    again, total = (sum(len(x['sentences']) for x in turns) for turns in (new, said))
    print(f'{rel(path)}: {again} of {total} sentences spoken, the others kept')
    speech, clips = takes.joined(said, have)
    out = Path(os.environ.get('DEMO_RENDERS_MAKING') or folder / f'episode.{lang}.speech.wav')
    out.unlink(missing_ok=True)  # (the kept speech, read above: a fetched render is read-only)
    takes.write(speech, out)
    keep_speech(folder, lang, said, clips)


def keep_speech(folder, lang, said, clips):
    """episode.<lang>.speech.json: the lines spoken (lines()) and each turn's sentences' [start, end] in the speech."""
    (folder / f'episode.{lang}.speech.json').write_text(json.dumps({'lines': said, 'clips': clips}, ensure_ascii=False)
                                                        + '\n')


def spoken(folder, lang):
    """Each turn's sentences' [start, end] in the speech: the one kept if the script still says the same in the same
    voices (fetched from HQ when this clone lacks it), else spoken again where it changed."""
    wav, kept = folder / f'episode.{lang}.speech.wav', folder / f'episode.{lang}.speech.json'
    if kept.exists() and json.loads(kept.read_text())['lines'] == lines(folder / f'script.{lang}.md', lang):
        if not wav.exists():
            subprocess.run(['node', 'shared/demo/renders.mjs', 'fetch', rel(wav)], cwd=ROOT, check=True)
    else:
        # the kept speech, so the sentences it already says keep their takes (speak(): renders.mjs make sets its
        # note aside while it runs)
        if kept.exists() and not wav.exists():
            subprocess.run(['node', 'shared/demo/renders.mjs', 'fetch', rel(wav)], cwd=ROOT, check=True)
        subprocess.run(['node', 'shared/demo/renders.mjs', 'make', rel(wav), '--', 'python3', 'shared/onair/make.py',
                        rel(folder), lang, 'speech'], cwd=ROOT, check=True)
    return json.loads(kept.read_text())['clips']


def sounds(folder):
    """The show's sounds by name (its `sounds`: a file from the repo's root, or { file, under, words }), each with its
    role's defaults (ROLES, else EFFECT) unless it sets its own."""
    out = {}
    for name, given in (show(folder).get('sounds') or {}).items():
        given = given if isinstance(given, dict) else {'file': given}
        out[name] = {**ROLES.get(name, EFFECT), **given, 'file': ROOT / str(given.get('file', '')).lstrip('/')}
    return out


def layout(said, cues, clips, lengths):
    """Where everything goes, in seconds. said: the turns; cues: the sound cues ([name, turn, at], each before the
    first sentence that starts after it); clips: each turn's sentences' [start, end] in the speech; lengths: each
    sound's [seconds, words], `words` the share of it played before the next words come in. Out: the clips [at,
    start, end], the sounds [at, name], the beds [from, to], each turn's sentences' [start, end] in the episode, and
    the episode's length."""
    order = [(k, n, start) for k, (_, words) in enumerate(said) for n, (start, _) in enumerate(sentences(words))]
    before = [[] for _ in range(len(order) + 1)]
    for name, turn, at in cues:
        before[next((i for i, (k, _, start) in enumerate(order) if k > turn or k == turn and start >= at),
                    len(order))].append(name)
    t, last, pause, bed = 0.0, None, 0.0, None
    voices, played, beds, spans = [], [], [], [[] for _ in said]
    for i, names in enumerate(before):
        for name in names:
            if name == 'beat':
                pause += GAP['beat']
            elif name == 'bed':
                bed = t + pause if bed is None else bed
            else:
                t += pause + (GAP['sound'] if last else 0)
                pause, last = 0.0, 'sound'
                played.append([round(t, 3), name])
                took, words = lengths[name]
                if bed is not None and name in ('ident', 'sting'):
                    beds.append([round(bed, 3), round(t + took, 3)])
                    bed = None
                t += took * words
        if i == len(order):
            break
        k, n, _ = order[i]
        start, end = clips[k][n]
        react = last == 'turn' and len(said[k][1].split()) <= REACT and said[k - 1][0] != said[k][0]
        t = max(0.0, t + pause + (GAP['sentence'] if n else GAP['react'] if react else GAP['turn'] if last else 0))
        pause, last = 0.0, 'turn'
        voices.append([round(t, 3), start, end])
        spans[k].append([round(t, 3), round(t + end - start, 3)])
        t += end - start
    length = round(max([t] + [at + lengths[name][0] for at, name in played]) + 0.5, 3)
    if bed is not None:
        beds.append([round(bed, 3), length])
    return {'voices': voices, 'sounds': played, 'beds': beds, 'spans': spans, 'length': length}


def seconds(file):
    return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0',
                                 str(file)], capture_output=True, text=True, check=True).stdout)


def loudness(*source):
    """Integrated loudness (LUFS) of an input (ffmpeg's arguments for it)."""
    said = subprocess.run(['ffmpeg', '-nostats', '-hide_banner', *source, '-af', 'ebur128', '-f', 'null',
                           '-'], capture_output=True, text=True, check=True).stderr
    return float(re.findall(r'I:\s+(-?[\d.]+) LUFS', said)[-1])


MONO = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono'
NOISE = 'anoisesrc=c=pink:r=48000:a=0.5,lowpass=f=900'


def mixdown(speech, plan, used, out):
    """The episode's sound from the layout: the clips from the speech, the show's sounds each at its level under the
    voices, the beds ducked under them, a room tone, mastered to podcast loudness (-16 LUFS), one channel at 64 kb/s."""
    voice = loudness('-i', str(speech))
    inputs, graph = [], []

    def source(*given):
        inputs.append(given)
        return len(inputs) - 1

    def ms(at):
        return round(at * 1000)

    for at, start, end in plan['voices']:
        i = source('-ss', f'{start:.3f}', '-t', f'{end - start:.3f}', '-i', str(speech))
        graph.append(f'[{i}]{MONO},adelay={ms(at)}:all=1[v{i}]')
    graph.append(f"{''.join(f'[v{i}]' for i in range(len(plan['voices'])))}amix=inputs={len(plan['voices'])}"
                 ':normalize=0,asplit[voice][key]')
    levels = {name: voice - s['under'] - loudness('-i', str(s['file'])) for name, s in used.items()}
    played = []
    for at, name in plan['sounds']:
        i = source('-i', str(used[name]['file']))
        graph.append(f'[{i}]{MONO},volume={levels[name]:.2f}dB,adelay={ms(at)}:all=1[s{i}]')
        played.append(f'[s{i}]')
    beds = []
    for start, end in plan['beds']:
        i, d = source('-stream_loop', '-1', '-i', str(used['bed']['file'])), end - start
        graph.append(f'[{i}]{MONO},atrim=0:{d:.3f},afade=t=out:st={max(0, d - 1.5):.3f}:d=1.5,'
                     f"volume={levels['bed']:.2f}dB,adelay={ms(start)}:all=1[b{i}]")
        beds.append(f'[b{i}]')
    if beds:  # ducked: the voices pull the bed down while they speak
        # the key is padded to the episode's length: the compressor ends with its shorter input, which would cut a bed
        # that runs on past the last voice (under the close's ident)
        graph.append(f"{''.join(beds)}amix=inputs={len(beds)}:normalize=0[beds];"
                     f"[key]apad=whole_dur={plan['length']:.3f}[keyed];"
                     '[beds][keyed]sidechaincompress=threshold=0.02:ratio=6:attack=20:release=500[bed]')
        played.append('[bed]')
    else:
        graph.append('[key]anullsink')
    room = voice + ROOM - loudness('-f', 'lavfi', '-i', f'{NOISE},atrim=0:5')
    graph.append(f"{NOISE},atrim=0:{plan['length']:.3f},volume={room:.2f}dB[room]")
    graph.append(f"[voice]{''.join(played)}[room]amix=inputs={len(played) + 2}:normalize=0,"
                 f"atrim=0:{plan['length']:.3f},loudnorm=I=-16:TP=-1.5:LRA=11")
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *(a for given in inputs for a in given), '-filter_complex',
                    ';'.join(graph), '-ac', '1', '-ar', '44100', '-b:a', '64k', str(out)], check=True)


def master(folder, lang):
    """episode.<lang>.mp3 (its render's recipe) and its timings, from the speech (spoken first if the words changed),
    the script's cues and the show's sounds."""
    path = folder / f'script.{lang}.md'
    parsed, known = script(path), sounds(folder)
    if not parsed['turns']:
        raise SystemExit(f'{path}: nobody speaks in it')
    unknown = sorted({name for name, *_ in parsed['sounds'] if name != 'beat' and name not in known})
    if unknown:
        raise SystemExit(f'{path}: no sound {", ".join(unknown)} in the show\'s `sounds` (company/shows.yaml): '
                         f'it has {", ".join(sorted(known)) or "none"}, and (beat)')
    used = {name: known[name] for name, *_ in parsed['sounds'] if name in known}
    for name, s in used.items():
        # a sound's recipe makes the same file every time: one this clone lacks is rendered again
        if not s['file'].exists() and Path(f"{s['file']}.render.json").exists():
            subprocess.run(['node', 'shared/demo/renders.mjs', 'render', rel(s['file'])], cwd=ROOT, check=True)
        if not s['file'].exists():
            raise SystemExit(f'{path}: the show\'s sound {name}, {rel(s["file"])}, isn\'t there')
    clips = spoken(folder, lang)
    lengths = {name: [seconds(s['file']), s['words']] for name, s in used.items()}
    plan = layout(parsed['turns'], parsed['sounds'], clips, lengths)
    out = Path(os.environ.get('DEMO_RENDERS_MAKING') or folder / f'episode.{lang}.mp3')
    mixdown(folder / f'episode.{lang}.speech.wav', plan, used, out)
    timed(path, plan['spans'], out.with_suffix('.timings.json'))
    planned = show(folder).get('minutes')
    print(f'{rel(out)}: {seconds(out) / 60:.1f} minutes' + (f' (the show: {planned})' if planned else ''))


def timed(path, spans, out):
    """episode.<lang>.timings.json beside the sound: who says each sentence of the script, in its own words, and when
    ([start, end] in seconds, in the episode)."""
    known = crew()
    timings = [{'speaker': known.get(who.lower(), {}).get('name', who),
                'sentences': [{'text': x, 'start': start, 'end': end}
                              for (_, x), (start, end) in zip(sentences(words), said)]}
               for (who, words), said in zip(turns(path), spans)]
    out.write_text(json.dumps({'lines': timings}, ensure_ascii=False, indent=1) + '\n')


def main(folder, lang=None, part=None):
    import video  # (it builds on this module)

    folder = Path(folder).resolve()
    if part == 'speech' and lang:
        return speak(folder, lang)
    if part:
        raise SystemExit(__doc__)
    if lang:
        return master(folder, lang)
    langs = sorted(p.name.split('.')[1] for p in folder.glob('script.*.md'))
    if not langs:
        raise SystemExit(f'{folder}: no script.<lang>.md')
    for lang in langs:
        # each language a render of its own, its recipe this tool for that language (renders.mjs make)
        mp3 = folder / f'episode.{lang}.mp3'
        subprocess.run(['node', 'shared/demo/renders.mjs', 'make', rel(mp3), '--', 'python3', 'shared/onair/make.py',
                        rel(folder), lang], cwd=ROOT, check=True)
        if video.wanted(folder, lang):
            video.make_mp4(folder, lang)


if __name__ == '__main__':
    if not 2 <= len(sys.argv) <= 4:
        raise SystemExit(__doc__)
    main(*sys.argv[1:])

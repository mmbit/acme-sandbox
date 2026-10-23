# python3 test_onair.py   (the parts that need no voice machine: scripts, voices, the video's timeline, and how speech is
# cut and joined, the latter where NumPy is: the voice image, not the worker; the mix and the video's timeline where
# ffmpeg is: the worker, not every test runner)
import importlib.util, json, shutil, subprocess, sys, tempfile, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import make  # noqa: E402
import video  # noqa: E402

SOUND = all(importlib.util.find_spec(m) for m in ('numpy', 'soundfile'))
FFMPEG = shutil.which('ffmpeg') and shutil.which('ffprobe')
if SOUND:
    import numpy as np
    import speak

ORG = '''departments:
  - id: executive
    agents:
      - { id: juno, name: Juno, role: CEO, voice: alba, look: round glasses }
      - { id: bolt, name: Bolt, role: Head of Process, voice: michael }
      - { id: pylon, name: Pylon, role: Engineer }
'''


class Scripts(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        (self.root / 'company').mkdir()
        (self.root / 'company/org.yaml').write_text(ORG)
        (self.root / 'company/brand.yaml').write_text('name: Acme\n')
        self.root, make.ROOT = make.ROOT, self.root
        self.script = make.ROOT / 'script.en.md'

    def tearDown(self):
        make.ROOT = self.root

    def test_turns_carry_on_across_lines_and_skip_the_front_matter(self):
        self.script.write_text('---\ntitle: Week one\n---\nJuno: Good morning.\nIt was a big week.\n\nBolt: It was.\n')
        self.assertEqual(make.turns(self.script), [['Juno', 'Good morning. It was a big week.'], ['Bolt', 'It was.']])

    def test_each_speaker_by_name_or_id_in_their_own_voice_with_numbers_in_words(self):
        self.script.write_text('JUNO: We sold 310 mugs.\nbolt: At €4 each.\n')
        self.assertEqual(make.lines(self.script, 'en'), [
            {'voice': 'alba', 'sentences': ['We sold three hundred and ten mugs.']},
            {'voice': 'michael', 'sentences': ['At four euros each.']}])
        self.assertEqual(make.lines(self.script, 'nl')[0]['sentences'], ['We sold driehonderdtien mugs.'])

    def test_the_companys_words_are_respelt_in_the_language_brand_yaml_gives_and_shown_as_written(self):
        (make.ROOT / 'company/brand.yaml').write_text('speech:\n  respell:\n    en: { Acme: Ak-mee }\n')
        self.script.write_text("Juno: Acme's first week. acme!\n")
        self.assertEqual(make.lines(self.script, 'en')[0]['sentences'], ["Ak-mee's first week.", 'Ak-mee!'])
        self.assertEqual(make.lines(self.script, 'nl')[0]['sentences'], ["Acme's first week.", 'acme!'])
        self.assertEqual(make.turns(self.script), [['Juno', "Acme's first week. acme!"]])
        # (an episode's own `say` goes first: it can spell a company word its own way)
        self.script.write_text('---\nsay: { Siobhan: Shiv-awn, Acme Mugs: Ak-mee Mugz }\n---\n'
                               'Juno: Siobhan likes Acme and Acme Mugs.\n')
        self.assertEqual(make.lines(self.script, 'en')[0]['sentences'], ['Shiv-awn likes Ak-mee and Ak-mee Mugz.'])

    def test_a_turn_is_spoken_in_its_sentences_and_timed_in_the_scripts_own_words(self):
        self.script.write_text('Juno: We sold 310 mugs. A record!\nBolt: Yes.\n')
        self.assertEqual(make.lines(self.script, 'en')[0]['sentences'], ['We sold three hundred and ten mugs.', 'A record!'])
        out = make.ROOT / 'episode.en.timings.json'
        make.timed(self.script, [[[0, 2.1], [2.35, 3]], [[3.45, 4]]], out)
        self.assertEqual(json.loads(out.read_text())['lines'], [
            {'speaker': 'Juno', 'sentences': [{'text': 'We sold 310 mugs.', 'start': 0, 'end': 2.1},
                                              {'text': 'A record!', 'start': 2.35, 'end': 3}]},
            {'speaker': 'Bolt', 'sentences': [{'text': 'Yes.', 'start': 3.45, 'end': 4}]}])

    def test_a_name_in_say_is_spoken_as_spelt_there_and_shown_as_written(self):
        self.script.write_text('---\nsay: { Siobhan: Shiv-awn }\n---\nJuno: Siobhan, and Siobhans, in 2 tiles.\n')
        self.assertEqual(make.lines(self.script, 'en')[0]['sentences'], ['Shiv-awn, and Siobhans, in two tiles.'])
        self.assertEqual(make.turns(self.script), [['Juno', 'Siobhan, and Siobhans, in 2 tiles.']])
        self.script.write_text('---\nsay: [Siobhan]\n---\nJuno: Siobhan.\n')
        with self.assertRaisesRegex(SystemExit, 'how the voice should say it'):
            make.lines(self.script, 'en')

    def test_a_screen_cue_is_never_spoken(self):
        self.script.write_text('---\nscreen:\n  shop: { type: text, title: The shop }\n---\n[shop]\nJuno: Hi.\n[shop]\n')
        self.assertEqual(make.turns(self.script), [['Juno', 'Hi.']])
        self.assertEqual(make.script(self.script)['cues'], [['shop', 0, 0], ['shop', 0, 3]])

    def test_a_sound_cue_is_neither_words_nor_a_turn(self):
        self.script.write_text('(bed)\nJuno: Hi.\n(beat)\nIt was us.\n(sting)\nBolt: (Quietly) yes.\n(ident)\n')
        said = make.script(self.script)
        self.assertEqual(said['turns'], [['Juno', 'Hi. It was us.'], ['Bolt', '(Quietly) yes.']])
        self.assertEqual(said['sounds'], [['bed', 0, 0], ['beat', 0, 3], ['sting', 0, 14], ['ident', 1, 14]])
        self.assertEqual(said['cues'], [])

    def test_a_speaker_without_a_voice_or_outside_the_crew_is_refused_by_name(self):
        self.script.write_text('Juno: Hello.\nPylon: Hi.\nStep one: a line that reads as a speaker.\n')
        with self.assertRaisesRegex(SystemExit, 'no voice in org.yaml for Pylon, Step one'):
            make.lines(self.script, 'en')

    def test_words_before_anyone_speaks_are_refused(self):
        self.script.write_text('Hello there.\nJuno: Hi.\n')
        with self.assertRaisesRegex(SystemExit, 'comes before anyone speaks'):
            make.turns(self.script)

    def test_the_voice_run_gives_hq_run_each_flag_one_value(self):
        args = make.voice_run('ep/.speech/en', [{'voice': 'alba', 'sentences': ['Hello there.']}])
        flags = args[2:args.index('--')]  # as hq run reads them (runs.ts specOf): --name value pairs
        self.assertEqual(dict(zip(flags[::2], flags[1::2])), {
            '--kind': 'voice', '--paths': 'shared/onair,ep/.speech/en', '--minutes': '20',
            '--bring': 'ep/.speech/en/speech.flac,ep/.speech/en/speech.json'})


@unittest.skipUnless(SOUND, 'NumPy and soundfile: the voice image')
class Speech(unittest.TestCase):
    def test_a_long_sentence_is_cut_at_a_comma_or_space(self):
        self.assertEqual(speak.pieces('One, two? '), ['One, two?'])
        long = 'word, ' * 80
        self.assertTrue(all(len(p) <= 300 for p in speak.pieces(long)))
        self.assertEqual(' '.join(speak.pieces(long)), long.strip())
        self.assertEqual(speak.pieces('x' * 650), ['x' * 300, 'x' * 300, 'x' * 50], 'no space: cut anyway')

    def test_each_sentence_a_clip_of_its_own_trimmed_and_levelled_and_where_each_is(self):
        rate = speak.RATE
        quiet, loud = (np.full(rate, v, np.float32) for v in (0.03, 0.12))
        hush = np.zeros(rate // 2, np.float32)
        out, spans = speak.joined([[[hush, quiet, quiet, hush], [loud]], [[loud]]])
        self.assertEqual([[e - s for s, e in line] for line in spans], [[2.27, 1.0], [1.0]], 'silence trimmed, kept: '
                         'the pause between pieces, 10 ms before and 60 ms after')
        self.assertAlmostEqual(spans[0][1][0] - spans[0][0][1], speak.GAP)
        first, second = (out[int(s * rate):int(e * rate)] for s, e in spans[0])
        for x in (first, second):
            self.assertAlmostEqual(float(np.sqrt(np.mean(x ** 2))), speak.LEVEL, 3, 'both at the speech level')

    def test_resampling_keeps_the_length_in_time(self):
        self.assertEqual(len(speak.resample(np.zeros(48000, np.float32), 48000)), speak.RATE)


# (the episode laid out from its clips, with the show's sounds)
class Sound(unittest.TestCase):
    """The layout and the mix: Juno's two sentences (clips of 2 and 1 s in the speech), Bolt's reaction (0.5 s), and
    the show's sounds: a 4 s ident, a 2 s sting and a 1 s bed."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        (self.root / 'company').mkdir()
        (self.root / 'company/org.yaml').write_text(ORG)
        (self.root / 'company/brand.yaml').write_text('name: Acme\n')
        (self.root / 'theme').mkdir()
        (self.root / 'company/shows.yaml').write_text('- id: digest\n  name: The Digest\n  sounds: { ident: theme/ident.wav,'
                                                       ' bed: /theme/bed.wav, sting: { file: theme/sting.wav, words: 1 } }\n')
        self.folder = self.root / 'knowledge/onair/digest/2026-10-20'
        self.folder.mkdir(parents=True)
        self.root, make.ROOT = make.ROOT, self.root
        self.clips = [[[0, 2], [2.3, 3.3]], [[3.6, 4.1]]]
        self.lengths = {'ident': [4, 0.5], 'sting': [2, 1], 'bed': [1, 0]}

    def tearDown(self):
        make.ROOT = self.root

    def plan(self, body):
        (self.folder / 'script.en.md').write_text(body)
        said = make.script(self.folder / 'script.en.md')
        return make.layout(said['turns'], said['sounds'], self.clips, self.lengths)

    def test_sentences_and_turns_get_their_pauses_and_a_short_reaction_comes_in_on_the_last_word(self):
        plan = self.plan('Juno: It broke. We fixed it.\nBolt: Ouch.\n')
        self.assertEqual(plan['voices'], [[0, 0, 2], [2.25, 2.3, 3.3], [3.13, 3.6, 4.1]])
        self.assertEqual(plan['spans'], [[[0, 2], [2.25, 3.25]], [[3.13, 3.63]]])
        self.assertEqual(plan['length'], 4.13)

    def test_a_beat_holds_a_pause_and_words_come_in_over_a_sounds_tail(self):
        plan = self.plan('(bed)\nJuno: It broke.\n(beat)\nWe fixed it.\n(ident)\n(sting)\nBolt: Ouch.\n(ident)\n')
        self.assertEqual(plan['voices'], [[0, 0, 2], [3.15, 2.3, 3.3], [9.17, 3.6, 4.1]])
        self.assertEqual(plan['sounds'], [[4.5, 'ident'], [6.85, 'sting'], [10.02, 'ident']])
        self.assertEqual(plan['beds'], [[0, 8.5]], 'the bed from its cue until the next ident has played')
        self.assertEqual(plan['length'], 14.52, 'the last sound rings out')

    @unittest.skipUnless(FFMPEG, 'ffmpeg: the worker')
    def test_the_mix_plays_the_shows_sounds_and_refuses_one_it_doesnt_have(self):
        for name, seconds, hz in (('ident', 4, 440), ('sting', 2, 660), ('bed', 1, 220)):
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', f'sine=f={hz}:d={seconds}:r=48000', '-ac', '2',
                            str(make.ROOT / f'theme/{name}.wav')], check=True)
        speech = self.folder / 'episode.en.speech.wav'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=300:d=4.4:r=24000', str(speech)], check=True)
        (self.folder / 'script.en.md').write_text('(bed)\nJuno: It broke. We fixed it.\n(sting)\nBolt: Ouch.\n(ident)\n')
        lines = make.lines(self.folder / 'script.en.md', 'en')
        make.keep_speech(self.folder, 'en', lines, self.clips)
        make.master(self.folder, 'en')
        mp3, timings = self.folder / 'episode.en.mp3', self.folder / 'episode.en.timings.json'
        self.assertAlmostEqual(make.seconds(mp3), 11.27, delta=0.1)
        self.assertAlmostEqual(make.loudness('-i', str(mp3)), -16, delta=1.5, msg='podcast loudness')
        said = json.loads(timings.read_text())['lines']
        self.assertEqual([[s['start'] for s in line['sentences']] for line in said], [[0, 2.25], [5.92]])
        (self.folder / 'script.en.md').write_text('Juno: It broke. We fixed it.\n(gong)\nBolt: Ouch.\n')
        with self.assertRaisesRegex(SystemExit, r'no sound gong in the show\'s `sounds` .*: it has bed, ident, sting'):
            make.master(self.folder, 'en')

    @unittest.skipUnless(FFMPEG, 'ffmpeg: the worker')
    def test_speaking_again_keeps_the_takes_of_the_sentences_still_said_alike(self):
        speech = self.folder / 'episode.en.speech.wav'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=300:d=4.4:r=24000', '-c:a', 'pcm_s16le',
                        str(speech)], check=True)
        script = self.folder / 'script.en.md'
        script.write_text('Juno: It broke. We fixed it.\nBolt: Ouch.\n')
        make.keep_speech(self.folder, 'en', make.lines(script, 'en'), self.clips)
        old = make.takes.kept(speech, self.folder / 'episode.en.speech.json')
        asked = []

        def voice_run(rel, said):  # the voice machine: a second of tone for each new sentence
            asked.append(said)
            work = make.ROOT / rel
            return ['sh', '-c', f'ffmpeg -v error -f lavfi -i sine=f=500:d=1:r=24000 {work}/speech.flac && '
                    f'echo \'[[[0, 1]]]\' > {work}/speech.json']

        was, make.voice_run = make.voice_run, voice_run
        try:
            script.write_text('Juno: It broke. We fixed it.\nBolt: Oh no.\n')
            make.speak(self.folder, 'en')
        finally:
            make.voice_run = was
        self.assertEqual(asked, [[{'voice': 'michael', 'sentences': ['Oh no.']}]], 'only the new sentence spoken')
        kept = json.loads((self.folder / 'episode.en.speech.json').read_text())
        self.assertEqual(kept['clips'], [[[0, 2], [2.3, 3.3]], [[3.6, 4.6]]])
        new = make.takes.kept(speech, self.folder / 'episode.en.speech.json')
        self.assertEqual(new[('alba', 'It broke.')], old[('alba', 'It broke.')], 'the same take')
        self.assertEqual(new[('alba', 'We fixed it.')], old[('alba', 'We fixed it.')])
        self.assertAlmostEqual(make.seconds(speech), 4.9, delta=0.01)
        self.assertFalse((self.folder / '.speech').exists())


@unittest.skipUnless(FFMPEG, 'ffmpeg: the worker')
class Video(unittest.TestCase):
    """The timeline video.py hands present.mjs: an episode spoken in five sentences, Juno's at 0-2 and 2.25-3 s, Bolt's
    at 3.45-4, 4.25-5 and 5.25-6 s."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        (self.root / 'company').mkdir()
        (self.root / 'company/org.yaml').write_text(ORG)
        (self.root / 'company/shows.yaml').write_text('- { id: digest, name: The Digest }\n')
        self.folder = self.root / 'knowledge/onair/digest/2026-10-19'
        (self.folder / 'shots').mkdir(parents=True)
        (self.folder / 'shots/shop.png').write_bytes(b'png')
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '6.45', '-b:a',
                        '64k', str(self.folder / 'episode.en.mp3')], check=True)
        timings = [{'speaker': 'Juno', 'sentences': [{'text': 'Good morning.', 'start': 0, 'end': 2},
                                                     {'text': 'The shop opened.', 'start': 2.25, 'end': 3}]},
                   {'speaker': 'Bolt', 'sentences': [{'text': 'It did.', 'start': 3.45, 'end': 4},
                                                     {'text': 'With a few hiccups on the way, ' * 2 + 'and more.',
                                                      'start': 4.25, 'end': 5},
                                                     {'text': 'Bye.', 'start': 5.25, 'end': 6}]}]
        (self.folder / 'episode.en.timings.json').write_text(json.dumps({'lines': timings}))
        self.root, make.ROOT, video.ROOT = make.ROOT, self.root, self.root

    def tearDown(self):
        make.ROOT = video.ROOT = self.root

    def write(self, body, screen='{ shop: { type: image, image: shots/shop.png }, words: { type: text, title: Hi } }'):
        said = body.format('Juno: Good morning.', 'The shop opened.', 'Bolt: It did.',
                           'With a few hiccups on the way, ' * 2, 'and more.', 'Bye.')
        (self.folder / 'script.en.md').write_text(f'---\ntitle: Opening day\nscreen: {screen}\n---\n{said}\n')

    def sections(self):
        return [(s['type'], round(s['dur'], 1)) for s in video.manifest(self.folder, 'en')['sections']]

    def test_each_cue_shows_from_the_pause_before_its_sentence_until_the_next_and_the_title_before_the_first(self):
        self.write('{}\n{}\n[shop]\n{}\n[words]\n{}\n{}\n{}')
        self.assertEqual(self.sections(), [('title', 3.0), ('image', 1.0), ('text', 2.5)])
        deck = video.manifest(self.folder, 'en')
        self.assertEqual((deck['title'], deck['sections'][0]['title']), ('The Digest', 'Opening day'))
        self.assertEqual((deck['audio'], deck['label']), ('episode.en.mp3', 'Made with AI'))

    def test_the_shows_deck_dresses_every_episode_under_its_own_css(self):
        self.write('{}\n[shop]\n{}\n{}\n{}\n{}\n{}')
        self.assertNotIn('css', video.manifest(self.folder, 'en'))
        (video.ROOT / 'theme').mkdir()
        (video.ROOT / 'theme/deck.css').write_text('')
        (video.ROOT / 'theme/deck.js').write_text('')
        (video.ROOT / 'company/shows.yaml').write_text(
            '- { id: digest, name: The Digest, deck: { css: theme/deck.css, script: theme/deck.js } }\n')
        deck = video.manifest(self.folder, 'en')
        self.assertEqual((deck['css'], deck['script']), (['/theme/deck.css'], '/theme/deck.js'))
        script = (self.folder / 'script.en.md').read_text().replace('---\n', '---\ncss: own.css\n', 1)
        (self.folder / 'script.en.md').write_text(script)
        self.assertEqual(video.manifest(self.folder, 'en')['css'], ['/theme/deck.css', 'own.css'])

    def test_a_cue_inside_a_sentence_waits_for_the_next_one_and_one_before_the_words_opens_the_film(self):
        self.write('[shop]\n{}\n{}\n{}\n{}\n[words]\n{}\n{}')
        self.assertEqual(self.sections(), [('image', 5.0), ('text', 1.5)])

    def test_every_sentence_is_a_caption_in_its_speakers_name_a_long_one_in_parts(self):
        self.write('{}\n[shop]\n{}\n{}\n{}\n{}\n{}')
        said = video.manifest(self.folder, 'en')['captions']
        self.assertEqual(said[0], {'who': 'Juno', 'text': 'Good morning.', 'start': 0, 'end': 2})
        bolt = [c for c in said if c['who'] == 'Bolt'][1:-1]
        self.assertEqual(len(bolt), 2)
        self.assertTrue(all(len(c['text'].split()) <= video.CAPTION_WORDS for c in bolt))
        self.assertEqual((bolt[0]['start'], bolt[1]['start'], bolt[1]['end']), (4.25, bolt[0]['end'], 5))

    def test_what_cant_show_is_refused(self):
        refusals = {'{}\n{}\n{}\n{}\n{}\n{}\n[shop]': 'comes after the last words',
                    '{}\n[shop]\n[words]\n{}\n{}\n{}\n{}\n{}': 'never shows',
                    '{}\n[nope]\n{}\n{}\n{}\n{}\n{}': 'no `screen` entry',
                    '{}\n{}\n{}\n{}\n{}\n{}': 'nothing goes on screen'}
        for cues, why in refusals.items():
            self.write(cues)
            with self.assertRaisesRegex(SystemExit, why):
                video.manifest(self.folder, 'en')
        self.write('{}\n[shop]\n{}\n{}\n{}\n{}\n{}', '{ shop: { type: image, image: shots/gone.png } }')
        with self.assertRaisesRegex(SystemExit, "shots/gone.png, isn't there"):
            video.manifest(self.folder, 'en')

    def test_the_speakers_are_its_hosts_as_hq_draws_them_in_the_order_they_first_speak(self):
        self.write('{}\n[shop]\n{}\n{}\n{}\n{}\n{}')
        self.assertEqual(video.manifest(self.folder, 'en')['hosts'],
                         [{'id': 'juno', 'name': 'Juno', 'look': 'round glasses'}, {'id': 'bolt', 'name': 'Bolt', 'look': ''}])

    def test_each_step_shows_its_screens_next_point_from_the_pause_before_its_sentence(self):
        points = '{ words: { type: text, title: Hi, points: [one, two] }, shop: { type: image, image: shots/shop.png } }'
        self.write('{}\n[words]\n[+]\n{}\n{}\n[+]\n{}\n{}\n[shop]\n{}', points)
        deck = video.manifest(self.folder, 'en')['sections']
        self.assertEqual([s.get('steps') for s in deck], [None, [0, 2], None])

    def test_an_html_screen_takes_any_number_of_steps_for_its_page(self):
        self.write('{}\n[page]\n[+]\n{}\n[+]\n{}\n[+]\n{}\n{}\n{}', '{ page: { type: html, html: shots/shop.png } }')
        self.assertEqual([s.get('steps') for s in video.manifest(self.folder, 'en')['sections']], [None, [0, 1, 2]])

    def test_a_step_with_no_point_to_show_and_a_point_that_never_shows_are_refused(self):
        points = '{ words: { type: text, title: Hi, points: [one, two] }, shop: { type: image, image: shots/shop.png } }'
        refusals = {'[+]\n{}\n[words]\n{}\n{}\n{}\n{}\n{}': 'before any screen',
                    '{}\n[shop]\n[+]\n{}\n{}\n{}\n{}\n{}': '0 points and 1 \\[\\+\\]',
                    '{}\n[words]\n[+]\n{}\n[+]\n{}\n[+]\n{}\n{}\n{}': 'no point left',
                    '{}\n[words]\n[+]\n{}\n{}\n{}\n{}\n{}': 'its last point never shows',
                    '{}\n[words]\n[+]\n{}\n{}\n[+]\n[shop]\n{}\n{}\n{}': 'same sentence as the next screen'}
        for cues, why in refusals.items():
            self.write(cues, points)
            with self.assertRaisesRegex(SystemExit, why):
                video.manifest(self.folder, 'en')

    def test_a_reaction_over_the_last_word_is_captioned_in_time_order(self):
        self.write('{}\n[shop]\n{}\n{}\n{}\n{}\n{}')
        lines = json.loads((self.folder / 'episode.en.timings.json').read_text())
        lines['lines'][1]['sentences'][0].update(start=2.8, end=3.3)
        (self.folder / 'episode.en.timings.json').write_text(json.dumps(lines))
        said = video.manifest(self.folder, 'en')['captions']
        self.assertEqual([c['start'] for c in said], sorted(c['start'] for c in said))

    def test_a_script_changed_since_it_was_spoken_is_refused(self):
        self.write('{}\n[shop]\n{}\n{}\n{}\n{}\nBye now.')
        with self.assertRaisesRegex(SystemExit, 'changed since it was spoken'):
            video.manifest(self.folder, 'en')


if __name__ == '__main__':
    unittest.main()

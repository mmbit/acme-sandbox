"""cd platform/voice && python3 -m unittest test_care   (Poppy on the phone: server.py's Care brain and a care call's
opening, the replies' languages and voices, steps and limits)

A care call runs for real (phone_call, Call, the Care brain over HTTP) around test_server.py's stand-ins (VAD, recogniser,
speech synthesis and clock: see its docstring), a stand-in Twilio stream (test_server's LiveSocket), a stand-in
coordinator (the ticket and phone-done) and a stand-in care service (standins.py's CareService). Needs numpy, as
test_server's Call tests.
"""
import asyncio, io, json, unittest, unittest.mock
from pathlib import Path

import test_server
from test_server import CLOCK, SEEDED, SPOKEN, VOICED, Juno, LiveSocket, np
import server
from standins import CareService

WORDS = {
    'nl': {'ai': 'Hoi, met Poppy, de AI-assistent van Testco.', 'transcript': 'Ik maak een geschreven verslag van dit gesprek.',
           'ask': 'Waarmee kan ik je helpen?', 'objected': 'Geen probleem, dan houd ik er geen bij.',
           'reply_ai': 'Ik ben Poppy, een AI-assistent.'},
    'de': {'ai': 'Hallo, hier ist Poppy, der KI-Assistent von Testco.', 'transcript': 'Ich führe ein schriftliches Protokoll.',
           'ask': 'Wobei kann ich dir helfen?', 'objected': 'Kein Problem, dann behalte ich keins.',
           'reply_ai': 'Ich bin Poppy, ein KI-Assistent.'},
    'en': {'ai': "Hi, this is Poppy, Testco's AI assistant.", 'transcript': 'I keep a written transcript of this call.',
           'ask': 'What can I help you with?', 'objected': "No problem, I won't keep one.",
           'fine': 'English is fine too.', 'reply_ai': "I'm Poppy, an AI assistant."},
}
STARTED = (200, {'conversation': 41, 'helper': 'poppy', 'langs': ['nl', 'de', 'en'], 'words': WORDS})
# (reply_ai, and the notice around a reply in the tests below)
# the opening in the number's first language, and English after it in its AI line and "English is fine too." only
OPENING = {lang: [WORDS[lang][k] for k in ('ai', 'transcript', 'ask')] for lang in WORDS}
AFTER = [WORDS['en']['ai'], WORDS['en']['fine']]
# HQ's languages for the opening, by the caller's number (brand.yaml phoneLine.languages)
LANGS = {'nl': ['nl', 'en'], 'de': ['de', 'en'], 'en': ['en']}
POPPY = [('english', 'bill_boerst')]  # (Pocket TTS in Poppy's own voice; Dutch and German go through Piper's native ones)
# (Poppy is she/her in the messages below)
SID = 'CA' + '0' * 32


@unittest.skipIf(np is None, 'numpy is not installed (see test_server.py)')
class CareCall(Juno):
    """A stranger rings the shop's number: HQ's ticket says care, and Poppy answers through the care service."""
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.care = CareService(STARTED)
        self.saved = {k: getattr(server, k) for k in ('CARE_URL', 'CARE_TOKEN', 'CARE_CALL_SECONDS', 'hq', 'Call')}
        server.CARE_URL, server.CARE_TOKEN = self.care.url, 'care-test-token'
        self.hq, self.calls, self.ws = [], [], None
        server.hq = self.coordinator
        made = server.Call
        server.Call = lambda *a, **k: self.calls.append(made(*a, **k)) or self.calls[-1]
        self.ticket = {'agent': 'poppy', 'lang': 'nl', 'kind': 'care', 'langs': LANGS['nl'], 'voice': 'bill_boerst',
                       'voices': {'nl': 'alex', 'de': 'thorsten'}}
        server.SAID.clear()  # (the opening's audio, kept from the call before)
        SPOKEN.clear()
        VOICED.clear()

    async def asyncTearDown(self):
        if self.ws and not self.ws.closed:
            await self.ws.close()
        if getattr(self, 'line', None):
            await asyncio.wait_for(self.line, 5)
        self.care.stop()
        for k, v in self.saved.items():
            setattr(server, k, v)
        server.CARE_LIVE.clear()

    def coordinator(self, method, path, body=None):
        self.hq.append((path, body, self.ws.closed))  # (whether the stream was closed yet)
        if path == 'call-ticket':
            return self.ticket
        return {}

    async def dial(self, opening=True):
        """Twilio's stream starts with the care ticket; the call picks up and (opening) its opening has been said."""
        self.ws = LiveSocket(json.dumps({'event': 'start', 'start': {'streamSid': 'MZ1', 'callSid': SID,
                                                                      'customParameters': {'ticket': 'tk'}}}), queued=True)
        self.line = asyncio.create_task(server.phone_call(self.ws))
        for _ in range(300):
            await asyncio.sleep(0.01)
            if self.calls and self.calls[-1].turn or self.ws.closed:
                break
        if self.ws.closed:
            return
        self.call = self.calls[-1]
        self.call.transcribe = self.transcribe
        if opening:
            await self.settle()

    async def say_first(self, text, settle=True):
        """The caller speaks once the opening has played (12 s of it, in two languages)."""
        await self.quiet(400)
        await self.talk(text, 30)
        await self.quiet(20)
        if settle:
            await self.settle()

    async def hung_up(self):
        await asyncio.wait_for(self.line, 5)
        self.line = None

    async def test_the_opening_is_the_first_languages_ai_line_transcript_line_and_ask_then_the_others_ai_line(self):
        await self.dial()
        # (with the opening's first language: care reads its prompt into the model's cache in it while the opening plays)
        self.assertEqual(self.care.asked, [('/phone/start', {'call': SID, 'lang': 'nl'})])
        self.assertEqual(SPOKEN, OPENING['nl'] + AFTER)
        self.assertEqual(VOICED, POPPY * 2, "Dutch in Piper's native voice, English in her own")
        self.assertEqual(self.care.turned(), [], 'nothing is asked before the caller speaks')
        # the next call's opening plays from the audio kept from this one: nothing to wait for
        await self.ws.close()
        await self.hung_up()
        SPOKEN.clear()
        await self.dial()
        self.assertEqual(SPOKEN, [])
        self.assertEqual(sum(json.loads(m)['event'] == 'media' for m in self.ws.sent), 5 * 4)

    async def test_a_pocket_voice_the_company_names_speaks_its_language_from_a_seeded_opening(self):
        self.ticket['voices'] = {'nl': 'daan', 'de': 'thorsten'}
        self.ticket['seeds'] = {'nl': 5, 'de': -1}
        SEEDED.clear()
        await self.dial()
        self.assertEqual(VOICED, [('dutch', 'daan')] * len(OPENING['nl']) + POPPY * 2, "Dutch in Pocket TTS's daan")
        self.assertEqual(SEEDED, [5] * len(OPENING['nl']) + [server.SEED] * 2,
                         "fixed words: the same take after every restart, from the company's seed for Dutch, the "
                         "line's for English")
        self.care.turns = [[{'lang': 'nl'}, {'text': 'Natuurlijk.'}, {'end': True}]]
        VOICED.clear()
        SEEDED.clear()
        await self.say_first('Hallo, ik heb een vraag over mijn bestelling.')
        self.assertEqual((SPOKEN[-1], VOICED, SEEDED), ('Natuurlijk.', [('dutch', 'daan')], []), 'a reply: not seeded')

    async def test_the_callers_words_go_to_care_at_once_and_the_reply_is_said_in_its_tags_language(self):
        for lang, words in (('nl', 'Hallo, ik heb een vraag over mijn bestelling.'),
                            ('de', 'Guten Tag, ich habe eine Frage zu meiner Bestellung.'),
                            ('en', 'Hi, I have a question about my order.')):
            with self.subTest(lang):
                self.care.asked.clear()
                self.ticket.update(lang=lang, langs=LANGS[lang])
                server.SAID.clear()
                SPOKEN.clear()
                await self.dial()
                self.assertEqual(SPOKEN[:3], OPENING[lang])
                SPOKEN.clear()
                VOICED.clear()
                self.care.turns = [[{'lang': lang}, {'text': 'Of course, '}, {'text': 'what is it about?'}, {'end': True}]]
                await self.say_first(words)
                self.assertEqual(SPOKEN, ['Of course, what is it about?'], 'no notice in between: the opening had it')
                self.assertEqual(VOICED, POPPY if lang == 'en' else [])
                # (care keeps their words once the reply's language has its notice heard whole: English had only its AI
                # line after Dutch and German)
                self.assertEqual(self.care.turned(), [{'conversation': 41, 'text': words, 'lang': lang,
                                                       'informed': [lang]}])
                await self.ws.close()
                await self.hung_up()
                self.assertEqual(self.care.asked[-1], ('/phone/end', {'conversation': 41, 'ended': 'caller',
                                                                      'informed': [lang]}))
                self.assertEqual([p for p, _, _ in self.hq], ['call-ticket'] * len(self.hq), 'no phone-done: Poppy never hung up')

    async def test_the_voice_follows_the_replys_language_mid_call(self):
        await self.dial()
        self.care.turns = [[{'lang': 'en'}, {'text': 'Sure. '}, {'lang': 'nl'}, {'text': 'Of in het Nederlands.'}, {'end': True}],
                           [{'text': 'Nog iets?'}, {'end': True}]]
        VOICED.clear()
        await self.say_first('Can I ask in English or Dutch?')
        self.assertEqual(SPOKEN[-3:], ['Sure.', 'Of in het Nederlands.', WORDS['en']['transcript']],
                         "English: only its transcript line, after the reply (the opening had its AI line); Dutch: "
                         'nothing')
        self.assertEqual(VOICED, POPPY * 2, 'English in her voice, then Dutch in the native one')
        await self.talk('Nee, dank je.', 30)
        await self.quiet(20)
        await self.settle()
        self.assertEqual((SPOKEN[-1], VOICED), ('Nog iets?', POPPY * 2), 'untagged: on in the language it was in')
        self.assertEqual(self.care.turned()[-1]['lang'], 'nl')

    async def test_settled_at_the_second_reply_no_notice_plays_again_whatever_the_replys_language(self):
        await self.dial()
        timed = {'rounds': 1, 'first': 1.2, 'read': 30000, 'written': 0}
        self.care.turns = [[{'lang': 'nl'}, {'text': 'Natuurlijk.'}, {'end': True, 'model': timed}],
                           [{'lang': 'en'}, {'text': 'Sure.'}, {'end': True}],
                           [{'lang': 'en'}, {'text': 'Yes.'}, {'end': True}],
                           [{'lang': 'de'}, {'text': 'Gern.'}, {'end': True}]]
        with unittest.mock.patch('sys.stdout', new_callable=io.StringIO) as log:
            await self.say_first('Hallo, ik heb een vraag.')
        self.assertEqual(SPOKEN[-1], 'Natuurlijk.')
        # where the reply's wait went, counted from the caller's last word, and care's account of its model call
        self.assertRegex(log.getvalue(), r'call: poppy reply timed: asked after \d+\.\d s, first words after \d+\.\d s, '
                                         r'first audio after \d+\.\d s, \d+ hold sounds?\n')
        self.assertIn("; care's model: 1 call, first words after 1.2 s, cache read 30000, written 0\n", log.getvalue())
        # one short first reply doesn't settle it: English, the second language, says its transcript line after it
        await self.talk('Sorry, English?', 30)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(SPOKEN[-2:], ['Sure.', WORDS['en']['transcript']], 'not settled at the first reply')
        await self.quiet(600)  # (played whole)
        await self.talk('Where is my parcel?', 30)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(SPOKEN[-2:], [WORDS['en']['transcript'], 'Yes.'], 'a second reply in English: settled in it')
        await self.talk('Und auf Deutsch?', 30)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(SPOKEN[-2:], ['Yes.', 'Gern.'], "settled: no German notice, though they haven't heard it")

    async def test_a_turn_counts_once_in_each_language_however_its_reply_moves_between_them(self):
        await self.dial()
        de = [WORDS['de']['reply_ai'], 'Gern.', WORDS['de']['transcript']]
        self.care.turns = [[{'lang': 'nl'}, {'text': 'Even kijken.'}, {'lang': 'en'}, {'text': 'Or in English.'},
                            {'lang': 'nl'}, {'text': 'Nog iets?'}, {'end': True}],
                           [{'lang': 'de'}, {'text': 'Gern.'}, {'end': True}]]
        await self.say_first('Hallo?')
        self.assertEqual(SPOKEN[-2:], ['Nog iets?', WORDS['en']['transcript']])
        await self.quiet(600)  # (English's transcript line plays out)
        await self.talk('Auf Deutsch?', 30)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(SPOKEN[-3:], de, 'one turn in Dutch: not settled, so German says its notice around the reply')

    async def test_a_slow_reply_is_held_by_the_phones_own_thinking_sound(self):
        await self.dial()
        sent, send = [], self.call.send_audio
        self.call.send_audio = lambda x: (sent.append(x), send(x))[1]
        self.care.go.clear()
        self.care.turns = [[{'lang': 'nl'}, 'hold', {'text': 'Natuurlijk.'}, {'end': True}]]
        await self.say_first('Hallo, ik heb een vraag.', settle=False)
        await self.quiet(round((server.HUSH - server.PAUSE) / server.WINDOW) + 1)  # (the caller quiet for HUSH s)
        await asyncio.sleep(0.3)
        sound = server.thinking(True)
        held = [x for x in sent if len(x) == len(sound)]
        self.assertEqual(len(held), 1, 'once the caller has been quiet for HUSH s')
        self.assertTrue(np.array_equal(held[0], sound))
        level = lambda x: 20 * np.log10(np.sqrt(np.mean(np.square(x))))
        self.assertAlmostEqual(level(sound) - level(server.thinking()), 12, delta=0.5)
        self.care.go.set()
        await self.settle()
        self.assertEqual(SPOKEN[-1], 'Natuurlijk.')

    async def test_words_said_over_the_openings_notice_wait_in_the_line_until_it_has_played_whole(self):
        await self.dial()
        await self.quiet(40)  # (1.3 s into the Dutch part of the opening)
        self.care.turns = [[{'lang': 'nl'}, {'text': 'Natuurlijk.'}, {'end': True}],
                           [{'lang': 'nl'}, {'text': 'Graag.'}, {'end': True}]]
        server.SAID.clear()  # (said again from the kept audio otherwise, which the stand-in doesn't list)
        await self.talk('Hallo, ik wil iets vragen', 30)
        await self.quiet(20)
        await asyncio.sleep(0.2)
        self.assertIn(json.dumps({'event': 'clear', 'streamSid': 'MZ1'}), self.ws.sent)  # (the opening stopped, as any reply)
        notice = [WORDS['nl']['ai'], WORDS['nl']['transcript']] + AFTER
        self.assertEqual(SPOKEN[-4:], notice, "what of the opening's notice they missed, in each of its languages")
        self.assertEqual(self.care.turned(), [], 'nothing goes to care before it has played')
        # talked over again: said again, and their words wait on
        await self.talk('over mijn bestelling.', 30)
        await self.quiet(20)
        await asyncio.sleep(0.2)
        self.assertEqual(self.care.turned(), [])
        await self.quiet(600)  # (it plays out)
        await self.settle()
        self.assertEqual([t['text'] for t in self.care.turned()], ['Hallo, ik wil iets vragen over mijn bestelling.'])
        self.assertEqual(SPOKEN[-1], 'Natuurlijk.')
        await self.talk('Dank je.', 30)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(SPOKEN[-2:], ['Natuurlijk.', 'Graag.'], 'heard: never again')

    async def test_a_notice_said_around_a_reply_counts_once_it_has_played_uncut(self):
        self.ticket.update(lang='en', langs=LANGS['en'])
        await self.dial()
        transcript = WORDS['nl']['transcript']
        self.care.turns = [[{'lang': 'nl'}, {'text': 'Natuurlijk.'}, {'end': True}],
                           [{'lang': 'nl'}, {'text': 'Graag.'}, {'end': True}],
                           [{'lang': 'nl'}, {'text': 'Tot ziens.'}, {'end': True}]]
        await self.say_first('Spreekt u Nederlands?', settle=False)
        await self.settle()
        self.assertEqual(SPOKEN[-3:], [WORDS['nl']['reply_ai'], 'Natuurlijk.', transcript],
                         "Dutch, which the opening didn't have: its short AI line first, its transcript line after")
        await self.quiet(10)  # (the transcript line is still playing)
        server.SAID.clear()
        await self.talk('Ja, en waar is mijn pakket?', 30)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(SPOKEN[-2:], ['Graag.', transcript],
                         'talked over before it had played: said again, the AI line heard whole')
        await self.quiet(600)  # (played whole this time)
        await self.talk('Dank je wel.', 30)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(SPOKEN[-2:], [transcript, 'Tot ziens.'], 'heard whole: not again')

    async def test_a_notice_still_playing_doesnt_settle_the_call_though_the_reply_repeats_its_tag(self):
        self.ticket.update(lang='en', langs=LANGS['en'])
        await self.dial()
        transcript = WORDS['nl']['transcript']
        de = [WORDS['de']['reply_ai'], 'Gern.', WORDS['de']['transcript']]
        self.care.turns = [[{'lang': 'nl'}, {'text': 'Natuurlijk.'}, {'end': True}],
                           [{'lang': 'nl'}, {'text': 'Graag.'}, {'lang': 'nl'}, {'text': 'Even kijken.'}, {'end': True}],
                           [{'lang': 'de'}, {'text': 'Gern.'}, {'end': True}]]
        await self.say_first('Spreekt u Nederlands?', settle=False)
        await self.settle()
        await self.quiet(10)  # (the Dutch transcript line is still playing: talked over)
        server.SAID.clear()
        await self.talk('Ja, en waar is mijn pakket?', 30)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(SPOKEN[-3:], ['Graag.', 'Even kijken.', transcript], 'said again after the reply, both rounds '
                                                                             'tagged')
        await self.quiet(10)  # (talked over again)
        server.SAID.clear()
        await self.talk('Auf Deutsch, bitte.', 30)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(SPOKEN[-3:], de, 'not settled: German says its notice around the reply')
        self.assertNotIn('nl', self.care.turned()[-1]['informed'], "care isn't told Dutch was heard")

    async def test_care_hears_a_language_once_its_ai_and_transcript_lines_have_played_whole(self):
        de = [WORDS['de']['reply_ai'], 'Gern.', WORDS['de']['transcript']]
        for hang_up in (False, True):
            with self.subTest(hang_up=hang_up):
                self.care.asked.clear()
                server.SAID.clear()
                await self.dial()  # (a +32 number: Dutch, then English's AI line)
                self.care.turns = [[{'lang': 'de'}, {'text': 'Gern.'}, {'end': True}],
                                   [{'lang': 'de'}, {'text': 'Bitte.'}, {'end': True}]]
                await self.say_first('Wo ist mein Paket?')
                self.assertEqual(SPOKEN[-3:], de,
                                 "German, which the opening didn't have: its AI line before, its transcript line after")
                self.assertEqual(self.care.turned()[-1]['informed'], ['nl'], 'only Dutch whole when they spoke')
                if hang_up:  # (while the German transcript line plays)
                    await self.ws.close()
                    await self.hung_up()
                    self.assertEqual(self.care.asked[-1], ('/phone/end', {'conversation': 41, 'ended': 'caller',
                                                                          'informed': ['nl']}))
                    continue
                await self.quiet(600)  # (they play out)
                await self.talk('Danke.', 30)
                await self.quiet(20)
                await self.settle()
                self.assertEqual(self.care.turned()[-1]['informed'], ['nl', 'de'])
                await self.ws.close()
                await self.hung_up()
                self.assertEqual(self.care.asked[-1][1]['informed'], ['nl', 'de'])

    async def test_a_one_language_opening_a_caller_in_another_hears_the_answer_first(self):
        self.ticket.update(langs=['nl'])
        await self.dial()
        self.assertEqual(SPOKEN, OPENING['nl'], "the number's language only")
        self.care.turns = [[{'lang': 'en'}, {'text': 'Your parcel left yesterday.'}, {'end': True}],
                           [{'lang': 'en'}, {'text': 'Bye!'}, {'end': True}]]
        await self.say_first('Hi, where is my parcel?')
        said = [WORDS['en']['reply_ai'], 'Your parcel left yesterday.', WORDS['en']['transcript']]
        self.assertEqual(SPOKEN[-3:], said, 'her AI line in their language, the answer, then the transcript line')
        self.assertEqual(self.care.turned()[-1]['informed'], ['nl'], 'their words wait in care until it has played')
        await self.quiet(600)
        await self.talk('Thanks, bye.', 30)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(SPOKEN[-2:], [WORDS['en']['transcript'], 'Bye!'], 'heard whole: not again')
        self.assertEqual(self.care.turned()[-1]['informed'], ['nl', 'en'])

    async def test_talking_over_a_reply_closes_the_turns_request(self):
        await self.dial()
        self.care.turns = [[{'text': 'Let me explain how ordering works. '}, 'hold', {'text': 'Never said.'}, {'end': True}]]
        await self.say_first('Hoe werkt bestellen?', settle=False)
        for _ in range(100):
            if self.care.turned():
                break
            await asyncio.sleep(0.02)
        await asyncio.sleep(0.1)
        self.assertFalse(self.call.turn.done(), 'the reply is still being written')
        await self.quiet(50)  # (1.6 s of the reply heard: stopped, not taken back)
        await self.talk('Wacht, ik bedoel iets anders.', 30)
        await self.quiet(20)
        await self.settle()
        for _ in range(100):
            if self.care.closed:
                break
            await asyncio.sleep(0.02)
        self.assertEqual(self.care.closed, ['Hoe werkt bestellen?'])
        self.assertNotIn('Never said.', SPOKEN)
        self.assertEqual(self.care.turned()[-1]['text'], 'Wacht, ik bedoel iets anders.')

    async def test_poppy_hanging_up_tells_hq_then_closes_the_stream(self):
        await self.dial()
        self.care.turns = [[{'text': 'Graag gedaan, fijne dag! '}, {'step': 'hang_up'}, {'used': 'hang_up'}, {'end': True}]]
        await self.say_first('Dat was het, dank je wel. Doei!')
        for _ in range(250):  # (the goodbye plays, then 1.5 s of quiet, then the tone)
            await self.quiet(5)
            await asyncio.sleep(0.01)
            if self.ws.closed:
                break
        await self.hung_up()
        self.assertEqual([(p, b, closed) for p, b, closed in self.hq if p == 'phone-done'], [('phone-done', {'call': SID}, False)])
        self.assertTrue(self.ws.closed)
        self.assertEqual(self.care.asked[-1], ('/phone/end', {'conversation': 41, 'ended': 'hung_up',
                                                              'informed': ['nl']}))

    async def test_no_transcript_makes_the_line_say_the_objection_words_in_the_callers_language(self):
        await self.dial()
        self.care.turns = [[{'step': 'no_transcript'}, {'used': 'no_transcript'}, {'text': 'Waarmee kan ik helpen?'}, {'end': True}]]
        await self.say_first('Hallo, ik wil liever geen verslag.')
        self.assertEqual(SPOKEN[-2:], [WORDS['nl']['objected'], 'Waarmee kan ik helpen?'])
        self.assertTrue(self.call.objected)

    async def test_no_transcript_in_a_reply_in_another_language_drops_its_transcript_line(self):
        self.ticket.update(langs=['nl'])
        await self.dial()
        en = WORDS['en']
        self.care.turns = [[{'lang': 'en'}, {'text': 'Of course.'}, {'step': 'no_transcript'}, {'used': 'no_transcript'},
                            {'end': True}],
                           [{'lang': 'en'}, {'text': 'Your parcel left yesterday.'}, {'end': True}]]
        await self.say_first("Hi, I'd rather you kept no transcript.")
        self.assertEqual(SPOKEN[-3:], [en['reply_ai'], 'Of course.', en['objected']], 'never "I keep a transcript" after it')
        await self.quiet(600)
        await self.talk('Where is my parcel?', 30)
        await self.quiet(20)
        await self.settle()
        self.assertEqual(SPOKEN[-2:], [en['objected'], 'Your parcel left yesterday.'], 'nor in a later reply')
        self.assertNotIn(en['transcript'], SPOKEN)
        self.assertEqual(self.care.turned()[-1]['informed'], ['nl', 'en'], 'its AI line is all English owes them now')

    async def test_a_reply_in_odd_chunks_is_said_line_by_line(self):
        await self.dial()
        # (a chunk extension, a line across two chunks, two lines in one, a trailer: as a proxy might pass them on)
        lines = [b'{"text": "Je pakket is onderweg. "}\n{"te', b'xt": "Morgen is het er."}\n{"end": true}\n']
        self.care.turns = [b''.join(b'%x;x=1\r\n%s\r\n' % (len(c), c) for c in lines) + b'0\r\nx-done: 1\r\n\r\n']
        await self.say_first('Waar is mijn pakket?')
        self.assertEqual(SPOKEN[-2:], ['Je pakket is onderweg.', 'Morgen is het er.'])

    async def test_a_third_care_call_at_once_is_closed_at_once(self):
        server.CARE_LIVE.update({'CA1', 'CA2'})
        await self.dial()
        await self.hung_up()
        self.assertTrue(self.ws.closed)
        self.assertEqual(self.care.asked, [], 'care is never asked')
        self.assertEqual([p for p, _, _ in self.hq], ['call-ticket'])
        self.assertEqual(server.CARE_LIVE, {'CA1', 'CA2'})

    async def test_care_refusing_the_start_closes_the_stream_without_phone_done(self):
        for refusal in ((503, {'why': 'cap'}), (500, {})):
            with self.subTest(refusal[0]):
                self.care.asked.clear()
                self.care.start = refusal
                await self.dial()
                await self.hung_up()
                self.assertTrue(self.ws.closed)
                self.assertEqual(self.care.paths(), ['/phone/start'])
                self.assertEqual(SPOKEN, [], 'nothing said: HQ plays its recorded message')
                self.assertNotIn('phone-done', [p for p, _, _ in self.hq])
                self.assertEqual(server.CARE_LIVE, set())

    async def test_a_care_call_ends_at_its_time_limit_without_phone_done(self):
        server.CARE_CALL_SECONDS = 0.5
        await self.dial(opening=False)
        await self.hung_up()
        self.assertTrue(self.ws.closed)
        self.assertNotIn('phone-done', [p for p, _, _ in self.hq])
        self.assertEqual(self.care.asked[-1], ('/phone/end', {'conversation': 41, 'ended': 'limit', 'informed': []}))

    async def test_a_turn_care_cant_answer_ends_the_call_without_phone_done(self):
        for answer in ([{'text': 'Een moment. '}, {'unanswered': 'cap'}], 503, [{'text': 'Een moment. '}, 'cut']):
            with self.subTest(answer):
                self.care.asked.clear()
                await self.dial()
                self.care.turns = [answer]
                await self.say_first('Waar is mijn pakket?')
                await self.hung_up()
                self.assertTrue(self.ws.closed)
                self.assertNotIn('phone-done', [p for p, _, _ in self.hq])
                self.assertEqual(self.care.asked[-1], ('/phone/end', {'conversation': 41, 'ended': 'error',
                                                                      'informed': ['nl']}))
                self.assertFalse([s for s in SPOKEN if "can't answer" in s or 'kan nu niet' in s], 'no seat notice: HQ plays the message')

    async def test_the_line_keeps_no_transcript_file(self):
        await self.dial()
        await self.say_first('Hallo, waar is mijn pakket?')
        await self.ws.close()
        await self.hung_up()
        self.assertEqual(list(Path(self.tmp.name).iterdir()), [], 'nothing on /data/calls or /data/live after it')
        self.assertNotIn('call-end', [p for p, _, _ in self.hq])


if __name__ == '__main__':
    unittest.main()

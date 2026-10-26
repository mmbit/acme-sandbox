"""What the line sends while the agent runs tool steps, through the real Call (answer, say) and the real Pocket TTS.

    VOICE_MODELS=/models python line_check.py [out]     (out: where the reply goes, as out.wav and out.frames.json)
    python line_check.py --limit [out]                  (the seat at its limit; needs the Claude CLI)

What each run checks: README, "What the board hears". out.frames.json feeds platform/hq/call-check.mjs. Outside the
image: a venv with requirements.txt's torch (CPU), pocket-tts, livekit, scipy and numpy; no other models needed.
"""
import asyncio, base64, json, os, sys, tempfile, time, types, wave
from pathlib import Path
from types import SimpleNamespace as NS

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault('HQ_URL', 'http://127.0.0.1:9')
os.environ.setdefault('ORIGIN', 'https://hq.test')
os.environ.setdefault('VOICE_TOKEN', 'line-check')
# (the board's side isn't heard here: no recogniser, no VAD, no Dutch voice)
sys.modules['sherpa_onnx'] = types.SimpleNamespace(OfflineRecognizer=NS(from_transducer=lambda **k: None),
                                                   VoiceActivityDetector=lambda *a, **k: None,
                                                   VadModelConfig=lambda: NS(silero_vad=NS(), sample_rate=0))
sys.modules['piper'] = types.SimpleNamespace(PiperVoice=NS(load=lambda path: None))
import server  # noqa: E402
import limit_model  # noqa: E402

RATE = server.RATE
REPLIES = [  # (words as the model streams them, a tool step and how long it runs)
    ["Sorry about that, let me check what's actually live. ", ('Grep', 1.5), ('Read', 2.0),
     "I'm sorry, my note was wrong to say it was there for you. ", ('mcp__hq__job', 8.0),
     "I've queued it for Sam as job 12 to find the cause. Until then, could you copy the text and send it yourself?"],
    [('mcp__hq__job', 7.0), "I've queued that for Sam as job 13. ", ('mcp__hq__promise', 3.0),
     "And I've noted it. Talk soon."],
]


class Agent:
    voice, respell, token, call, recap = 'alba', {}, '', 0, ''  # (respell)

    def __init__(self, t0):
        self.n, self.t0, self.steps = 0, t0, []  # steps: when each tool step started and ended

    def interrupt(self):
        pass

    async def ask(self, text, pictures=()):
        reply, self.n = REPLIES[self.n], self.n + 1
        for part in reply:
            if isinstance(part, tuple):
                yield server.Step(part[0])
                start = time.monotonic() - self.t0  # (the line has said what came before the step)
                await asyncio.sleep(part[1])
                self.steps.append((start, time.monotonic() - self.t0, part[1]))
                continue
            for w in part.split(' '):
                await asyncio.sleep(0.05)
                yield w + ' '


async def run():
    t0 = time.monotonic()
    frames, audio = recorder(t0)
    with tempfile.TemporaryDirectory() as tmp:
        # (each call is given what it's wired to: its files, coordinator and how its CLI starts)
        call = server.Call(audio, nothing, nothing, 'ada', 'en', wiring=server.Wiring(paths=server.Paths(calls=Path(tmp))))
        call.brain = Agent(t0)
        # (in VAD windows: the board, never heard here, has been quiet all along)
        call.quiet = 10 ** 9
        for i, ask in enumerate(['The button?', 'Can Sam look at it?']):
            await call.answer(ask, None)
            frames.append((time.monotonic() - t0, None, f'end of reply {i + 1}'))
            await asyncio.sleep(1.0)
    return frames, call.lines, call.brain.steps


def check(frames, lines, steps):
    tick = server.tick()
    is_tick = lambda x, w: w is None and len(x) == len(tick) and np.array_equal(x, tick)
    problems = [f'a frame outside any sentence at {t:.2f} s'
                for t, x, w in frames if x is not None and w is None and not is_tick(x, w)]
    sentences = sentences_said(frames)
    problems += [f'said twice: {s!r}' for s in set(sentences) if sentences.count(s) > 1]
    script = ' '.join(server.spoken(p) for r in REPLIES for p in r if isinstance(p, str))
    problems += [f'words of the line\'s own: {s!r}' for s in sentences if s not in script]
    seen = {}
    for t, x, w in frames:  # (nothing the line sends repeats: the same audio twice is a loop, wherever it comes from)
        if x is not None and not is_tick(x, w):
            if (k := x.tobytes()) in seen:
                problems.append(f'the audio of the frame at {seen[k]:.2f} s sent again at {t:.2f} s')
            seen.setdefault(k, t)
    # the tick, as the line's own clock has it: the audio sent so far ends at `until` (sent ahead of playback)
    until, ticks, quiet_from = 0.0, [], {}
    for t, x, w in frames:
        for a, _, _ in steps:
            if a <= t:
                quiet_from.setdefault(a, max(a, until))
        if x is None:
            continue
        if is_tick(x, w):
            ticks.append(t)
            if t < until + server.QUIET - 0.01:
                problems.append(f'a tick at {t:.2f} s, {t - until:.2f} s after the sound before it ended')
            # (the step ends with the next words, ~0.05 s on)
            if not any(a - 0.01 <= t <= b + 0.2 for a, b, _ in steps):
                problems.append(f'a tick at {t:.2f} s with no tool step running')
        until = max(until, t) + len(x) / RATE
    for a, b, d in steps:  # (a step that leaves more than QUIET s of quiet after the sound before it gets a tick)
        if b - quiet_from.get(a, a) > server.QUIET + 0.2 and not any(a <= t <= b for t in ticks):
            problems.append(f'no tick in the {d:.1f} s tool step at {a:.2f} s')
    out, stutters = played(frames)
    return problems + stutters, sentences, out, ticks


async def limited():
    """A call on a seat at its limit, through the real chain: the board asks twice, and every request is turned away."""
    t0 = time.monotonic()
    frames, audio = recorder(t0)
    events = []
    reset = int(time.time()) + 45 * 60

    async def event(e):
        events.append(e)

    d = limit_model.tmp()
    url, stop = limit_model.serve(reset)
    seat = Path(d, 'token')
    seat.write_text('sk-ant-oat01-line-check')
    coordinator = lambda m, p, b=None: ({'prompt': 'You are Juno.', 'token': 'line-check', 'seat': {'room': True},
                                         'timeZone': 'Europe/Amsterdam'} if p.startswith('call-context') else None)
    paths = server.Paths(seat=seat, repo=Path(d), calls=Path(d), live=Path(d), cli_config=Path(d),
                         work=Path(d))

    async def start_cli(*args, env, **kwargs):
        return await asyncio.create_subprocess_exec(*args, env=limit_model.cli_env(env, url), **kwargs)

    try:
        call = server.Call(audio, event, nothing, 'juno', 'en', wiring=server.Wiring(hq=coordinator, paths=paths, start_cli=start_cli))
        await call.start()
        for i, ask in enumerate(['I did my long rant. Are you there?', 'Hello?']):
            await call.answer(ask, None)
            frames.append((time.monotonic() - t0, None, f'end of reply {i + 1}'))
        call.end()
    finally:
        stop()
    when = server.clock(reset * 1000, 'Europe/Amsterdam')
    expected = [server.spoken(server.cant_answer('Juno', 'limit', reset * 1000, 'Europe/Amsterdam', again=again))
                for again in (False, True)]
    return frames, call.lines, events, expected, when


async def nothing(*a):
    pass


def recorder(t0):
    """Every frame the line sends, as (time, audio, the sentence being said or None).
    Returns the frames and the call's send_audio. Patches server.Call.say to tag each frame with its sentence."""
    frames, saying = [], [None]

    async def audio(x):
        frames.append((time.monotonic() - t0, np.asarray(x, np.float32).copy(), saying[0]))

    say = server.Call.say

    async def saying_it(self, sentence, stop, turn):
        saying[0] = server.spoken(sentence)
        try:
            await say(self, sentence, stop, turn)
        finally:
            saying[0] = None

    server.Call.say = saying_it
    return frames, audio


def check_limited(frames, lines, events, expected):
    problems = [f'a frame outside the line\'s words at {t:.2f} s' for t, x, w in frames if x is not None and w is None]
    sentences = sentences_said(frames)
    if sentences != expected:
        problems.append(f'the board heard {sentences!r}, not the line\'s words {expected!r}')
    for words in expected:  # (heard whole: as long as the words take to say, at least a second for every 25 characters)
        seconds = sum(len(x) for _, x, w in frames if x is not None and w == words) / RATE
        if seconds < len(words) / 25:
            problems.append(f'only {seconds:.1f} s of audio for {words!r}')
    out, stutters = played(frames)
    problems += stutters
    notices = [e['text'] for e in events if e.get('type') == 'notice']
    if [server.spoken(n) for n in notices] != expected:
        problems.append(f'the call screen showed {notices!r}')
    noticed = [f'(The line, not Juno: {n})' for n in notices]
    if [line for line in lines if line.startswith('(The line, not Juno: ')] != noticed:
        problems.append(f'the transcript: {lines!r}')
    return problems, sentences, out


def sentences_said(frames):
    """The sentences heard, in order."""
    said = [w for _, x, w in frames if x is not None and w]
    return [w for i, w in enumerate(said) if i == 0 or w != said[i - 1]]


def played(frames):
    """The frames as HQ's play() schedules them, each straight after the one before or 50 ms from now:
    ([(start, sentence, audio)], the stutters). A stutter is a frame of the same sentence that starts after a gap."""
    nxt, out, stutters = 0.0, [], []
    for t, x, w in frames:
        if x is None:
            continue
        start = max(nxt, t + 0.05)
        if w and out and out[-1][1] == w and start > nxt + 1e-6:
            stutters.append(f'a stutter at {t:.2f} s in {w!r}')
        nxt = start + len(x) / RATE
        out.append((start, w, x))
    return out, stutters


def save(frames, out, path):
    end = max(s + len(x) / RATE for s, _, x in out)
    pcm = np.zeros(int((end + 0.5) * RATE), np.float32)
    for s, _, x in out:
        i = int(round(s * RATE))
        pcm[i:i + len(x)] += x
    with wave.open(f'{path}.wav', 'wb') as f:
        f.setnchannels(1), f.setsampwidth(2), f.setframerate(RATE)
        f.writeframes((np.clip(pcm, -1, 1) * 32767).astype('<i2').tobytes())
    first = frames[:next(i for i, f in enumerate(frames) if f[1] is None)]  # reply 1, for HQ
    Path(f'{path}.frames.json').write_text(json.dumps(
        [[round(t, 4), base64.b64encode((np.clip(x, -1, 1) * 32767).astype('<i2').tobytes()).decode(), w]
         for t, x, w in first]))


if __name__ == '__main__' and sys.argv[1:2] == ['--limit']:
    if not limit_model.installed():
        sys.exit('--limit needs the Claude CLI')
    frames, lines, events, expected, when = asyncio.run(limited())
    problems, sentences, out = check_limited(frames, lines, events, expected)
    save(frames, out, sys.argv[2] if len(sys.argv) > 2 else 'line-check-limit')
    print(f'the seat resets at {when} (Europe/Amsterdam); the board heard:', *sentences, sep='\n  ')
    print('transcript:', *lines, sep='\n  ')
    print(f'{sum(1 for f in frames if f[1] is not None)} frames, '
          f'{sum(len(x) for _, x, _ in frames if x is not None) / RATE:.1f} s of the line\'s words')
    print('\n'.join(problems) or 'clean: the board hears the line say the agent can\'t answer, and until when, '
          'both times, without a stutter')
    sys.exit(1 if problems else 0)
elif __name__ == '__main__':
    frames, lines, steps = asyncio.run(run())
    problems, sentences, out, ticks = check(frames, lines, steps)
    save(frames, out, sys.argv[1] if len(sys.argv) > 1 else 'line-check')
    print('said:', *sentences, sep='\n  ')
    print('transcript:', *lines, sep='\n  ')
    print(f'{sum(1 for f in frames if f[1] is not None)} frames, {len(sentences)} sentences, {len(ticks)} ticks at',
          ', '.join(f'{t:.2f}' for t in ticks), 's; tool steps at',
          ', '.join(f'{a:.2f}-{b:.2f}' for a, b, _ in steps), 's')
    print('\n'.join(problems)
          or 'clean: the agent\'s sentences and the tick in its steps only, nothing said or sent twice, no stutter')
    sys.exit(1 if problems else 0)

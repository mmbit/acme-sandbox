"""A call out's room on the join link's page (/voice/join): up to six people and the agent on one call (the README's
"A room")."""
import asyncio, collections, json, re, secrets, time
from urllib.error import HTTPError

import numpy as np

from echo import Echo

RATE, FRAME = 16000, 320  # 20 ms, as HQ's microphone frames (platform/hq/shell/mic-worklet.js)
TICK_SECONDS = FRAME / RATE
# People in a room at once. The link is a stranger's to pass on: past this, anyone holding it could crowd the call, and
# every voice mixes into everyone's audio and the agent's ears. A call out is a few people.
MOST = 6
# The longest name a person may join under, in characters after clean(): a full name as the UK's Government Data
# Standards Catalogue sizes it (70, title to suffix), so a real full name fits. Its cost, worked out: the
# name heads a transcript line and the agent's turn once per recognised piece at most, and a piece is at least ONSET +
# PAUSE (server.py, 0.7 s) of the call. Even at that rate, an hour of 73-character labels ("\n<name>: ") is about
# 375,000 characters (about 94,000 tokens): within the 1,000,000 HQ takes in a finish report and under half the 200k
# tokens a call model's context holds at the least. An ordinary call labels a piece every few seconds, a fraction of
# that. joinpage.ts's NAME_LENGTH is this number, and the page says so before it sends a longer one.
NAME_LENGTH = 70
EMPTY_SECONDS = 120       # a room with nobody in it ends this long after the last person left
HANG_UP_WAIT_SECONDS = 5  # after `hangup`, the pages' time to leave before the line closes them
# A person's frames waiting for the mixer: past this many the oldest go, so a late burst never makes their voice lag
WAITING_FRAMES = 5
# What waits to be sent to a person: past this many frames (a slow connection) their audio frames go, never an event
UNSENT_FRAMES = 50
TALKING_LEVEL = 1e-4      # a frame's mean square (-40 dBFS) above which a person is talking
TALKING_HOLD_SECONDS = 0.4  # how long `talking` stays on someone after their last loud frame
HISTORY_FRAMES = 60 * RATE // FRAME  # each person's loudness, frame by frame, for the last minute: who said what
TIMED = ('state', 'said', 'tick')  # the line's events that go out with their audio

ROOMS = {}     # call out -> its Room
ENDED = set()  # call outs whose room has ended: a link is good for one call


async def join(ws, ticket_for, make_call):
    """One person on the join page, from their first message to their leaving. ticket_for(token): the coordinator's
    join-ticket, {agent, lang, callout, name}. make_call(send_audio, send_event, clear, ticket, hang_up, speakers): the
    room's Call."""
    try:
        first = json.loads(await asyncio.wait_for(ws.recv(), 10))
    except Exception:
        first = None
    if not isinstance(first, dict):
        return await ws.close(1008, 'join')
    token, name = first.get('token'), clean(first.get('name'))
    if first.get('type') != 'join' or not isinstance(token, str) or not 0 < len(token) <= 200:
        return await ws.close(4004, 'link')
    if not name or len(name) > NAME_LENGTH:
        return await ws.close(1008, 'name')
    try:
        ticket = await asyncio.to_thread(ticket_for, token)
    except HTTPError as err:
        return await ws.close(4004 if err.code in (403, 404, 409, 410) else 1011, 'link')
    except Exception as err:  # (the coordinator unreachable: the page tries again)
        print(f'room: no join ticket: {err!r}', flush=True)
        return await ws.close(1011, 'coordinator')
    callout = ticket.get('callout') if isinstance(ticket, dict) else None
    if type(callout) is not int or callout < 1 or not ticket.get('agent') or callout in ENDED:
        return await ws.close(4004, 'link')
    room = ROOMS.get(callout)
    if room is None:
        room = ROOMS[callout] = Room(callout, ticket, make_call)
        asyncio.create_task(room.start())
    person = room.admit(ws, name, first.get('rejoin'))
    if person is None:  # MOST are in: a passed-on link can't crowd the call (the page says it's full)
        return await ws.close(4009, 'full')
    await room.ready.wait()
    if room.ended:
        return await ws.close(4004 if room.failed else 4000, 'over')
    await room.welcome(person)
    bye = False
    try:
        async for message in ws:
            if isinstance(message, bytes):
                person.hear(message)
                continue
            event = json.loads(message)
            if event.get('type') == 'bye':
                bye = True
                break
            if event.get('type') == 'mute' and isinstance(event.get('on'), bool):
                person.muted = event['on']
                room.tell_people()
    except Exception as err:  # (a dropped connection, or a message that isn't JSON: they leave, and may rejoin)
        if not type(err).__name__.startswith('ConnectionClosed'):
            print(f'room: call out {callout}: {err!r}', flush=True)
    finally:
        room.leave(person, ws, bye)


def clean(name):
    """The name a person typed, as the others see it and the transcript names them: one line, no control characters or
    colons (a transcript line is "<name>: <words>")."""
    return ' '.join(re.sub(r'[\x00-\x1f\x7f:]', ' ', name).split()) if isinstance(name, str) else ''


class Person:
    """Someone in the room: their connection (None while they're away), their own echo canceller and the frames
    waiting for the mixer, and what waits to be sent to them."""
    def __init__(self, ws, name):
        self.id, self.ws, self.name = secrets.token_hex(4), ws, name
        # what gets them back in their place: theirs alone, never in the list everyone gets (the id is)
        self.key = secrets.token_urlsafe(16)
        self.echo, self.muted, self.away_since = Echo(), False, None
        self.welcomed = False  # (nothing reaches them before the room's own message)
        self.waiting = collections.deque(maxlen=WAITING_FRAMES)
        self.unsent, self.writer = collections.deque(), None
        # (the mixer's sample count, mean square), frame by frame
        self.loudness = collections.deque(maxlen=HISTORY_FRAMES)

    def hear(self, message):
        """A microphone frame from the page, with what it played over the same samples (none: nothing played), through
        their echo canceller."""
        if len(message) not in (2 * FRAME, 4 * FRAME):
            return
        pcm16 = np.frombuffer(message, '<i2').astype(np.float32) / 32768
        mic, played = np.split(pcm16, 2) if len(pcm16) == 2 * FRAME else (pcm16, None)
        cleaned = self.echo.cancel(mic, played)
        for start in range(0, len(cleaned) - FRAME + 1, FRAME):
            self.waiting.append(cleaned[start:start + FRAME])
        if rest := len(cleaned) % FRAME:  # (the canceller gives whole 10 ms blocks: half a frame waits for the next)
            self.waiting.append(cleaned[-rest:])

    def take(self):
        """Their next 20 ms for the mixer: silence while they're muted, away or late."""
        out = np.zeros(FRAME, np.float32)
        filled = 0
        while self.waiting and filled < FRAME:
            piece = self.waiting.popleft()
            used = min(len(piece), FRAME - filled)
            out[filled:filled + used] = piece[:used]
            if used < len(piece):
                self.waiting.appendleft(piece[used:])
            filled += used
        return out if not self.muted and self.ws else np.zeros(FRAME, np.float32)

    def send(self, message, frame=False):
        """Queued for their connection, in order; a slow connection loses audio frames, never an event."""
        if not self.ws or not self.welcomed:
            return
        if frame and sum(isinstance(m, bytes) for m in self.unsent) >= UNSENT_FRAMES:
            return
        self.unsent.append(message)
        if not self.writer or self.writer.done():
            self.writer = asyncio.create_task(self.write(self.ws))

    async def write(self, ws):
        while self.unsent and self.ws is ws:
            try:
                await ws.send(self.unsent.popleft())
            except Exception:  # (closed: its handler sees it and they leave)
                self.unsent.clear()


class Room:
    """One call out's room: its people, its Call, the agent's voice waiting to be mixed, and the mixer's clock."""
    def __init__(self, callout, ticket, make_call):
        self.callout, self.ticket, self.people = callout, ticket, {}
        self.voice = collections.deque()  # the agent's audio still to play (float32 arrays) and the events between them
        self.ear = asyncio.Queue()        # what the agent hears, frame by frame, on its way to Call.hear
        self.mixed = 0                    # samples the mixer has given the agent to hear
        self.talking, self.talking_at = None, 0.0
        self.ready, self.ended, self.failed, self.empty, self.tasks = asyncio.Event(), False, False, None, []
        self.call = make_call(self.play, self.event, self.clear, ticket, self.hang_up, self.speaker)

    async def start(self, clock=True):
        """The call's briefing and its agent, then the mixer's clock (clock=False: a test ticks it itself)."""
        try:
            await self.call.start()
        except Exception as err:
            print(f'room: call out {self.callout} could not start: {err!r}', flush=True)
            self.failed = True
            await self.end()
            return
        self.tasks.append(asyncio.create_task(self.listen()))
        if clock:
            self.tasks.append(asyncio.create_task(self.run()))
        await self.call.greet()  # (the opening, once the first person is in and it's quiet: Call.open)
        print(f'room: call out {self.callout} opened', flush=True)
        self.ready.set()

    def holder(self, key):
        """The person this key belongs to: None for any other key, or one that isn't ASCII text (compare_digest's limit)."""
        if not isinstance(key, str) or not key.isascii():
            return None
        return next((p for p in self.people.values() if secrets.compare_digest(p.key, key)), None)

    def admit(self, ws, name, rejoin=None):
        """A person in: back in their place if they had one and dropped (rejoin: their key), else new; None when it's full.
        A new person takes the place of whoever has been away longest once MOST places are held, so dropped joins can't
        pile up."""
        person = self.holder(rejoin)
        if person is not None:
            old, person.ws, person.name, person.away_since = person.ws, ws, name, None
            person.welcomed = False
            person.unsent.clear()  # (what the old connection never got)
            if old is not None and old is not ws:
                asyncio.create_task(old.close(4000, 'replaced'))
        elif sum(p.ws is not None for p in self.people.values()) >= MOST:
            return None
        else:
            if len(self.people) >= MOST:
                away = min((p for p in self.people.values() if p.ws is None), key=lambda p: p.away_since)
                del self.people[away.id]
            person = Person(ws, name)
            self.people[person.id] = person
        if self.empty:
            self.empty.cancel()
            self.empty = None
        return person

    async def welcome(self, person):
        """The room as it is now for the one who joined, and everyone's new list of people."""
        look = self.ticket['agent']
        agent = {'name': str(self.ticket.get('name') or look.capitalize()), 'look': look}
        person.welcomed = True
        person.send(json.dumps({'type': 'room', 'you': person.id, 'key': person.key, 'people': self.listing(), 'agent': agent}))
        self.tell_people()

    def leave(self, person, ws, bye):
        """A person's connection ended: said bye (gone), or dropped (away: their place waits for them). With nobody
        left, the room ends EMPTY_SECONDS later."""
        if person.ws is not ws or self.ended:
            return
        person.ws = None
        if bye:
            self.people.pop(person.id, None)
        else:
            person.away_since = time.monotonic()
        self.tell_people()
        if not any(p.ws for p in self.people.values()) and not self.empty:
            self.empty = asyncio.create_task(self.end_later())

    async def end_later(self):
        await asyncio.sleep(EMPTY_SECONDS)
        self.empty = None
        print(f'room: call out {self.callout} ended: nobody came back', flush=True)
        await self.end()

    async def hang_up(self):
        """The agent ended the call (Call.leave): everyone hears it, and the room ends once their pages have left."""
        self.broadcast({'type': 'hangup'})
        await asyncio.sleep(HANG_UP_WAIT_SECONDS)
        await self.end()

    async def end(self):
        if self.ended:
            return
        self.ended = True
        if not self.failed:  # (one that never started can be opened again: its link may still be good)
            ENDED.add(self.callout)
        ROOMS.pop(self.callout, None)
        for task in [*self.tasks, self.empty]:
            if task and task is not asyncio.current_task():
                task.cancel()
        self.ready.set()
        await asyncio.to_thread(self.call.end)
        for person in self.people.values():
            if person.ws:
                await person.ws.close(4004 if self.failed else 4000, 'over')

    def listing(self):
        return [{'id': p.id, 'name': p.name, 'muted': p.muted} for p in self.people.values() if p.ws is not None]

    def tell_people(self):
        self.broadcast({'type': 'people', 'people': self.listing()})

    def broadcast(self, event):
        message = json.dumps(event)
        for person in self.people.values():
            person.send(message)

    # ---- the Call's side: the agent's voice and events
    async def play(self, samples):
        self.voice.append(np.asarray(samples, np.float32))

    async def event(self, event):
        """The line's state, said and tick go out as the mixer reaches the audio after them; the rest is HQ's alone."""
        if event.get('type') in TIMED:
            self.voice.append(event)

    async def clear(self):
        """The agent was stopped: what's left of its voice goes, and the pages hear so."""
        self.voice = collections.deque(e for e in self.voice if isinstance(e, dict))
        self.broadcast({'type': 'clear'})

    def speaker(self, start, end):
        """Who was loudest over the agent's samples start to end: the name the transcript gives those words."""
        totals = {person.id: sum(level for at, level in person.loudness if start <= at < end)
                  for person in self.people.values()}
        loudest = max(totals, key=totals.get, default=None)
        return self.people[loudest].name if loudest else 'Someone'

    # ---- the mixer
    async def run(self):
        """The mixer's 20 ms clock: it catches up after a slow moment, and skips ahead after a long one."""
        loop = asyncio.get_running_loop()
        due = loop.time()
        while not self.ended:
            self.tick()
            due += TICK_SECONDS
            if loop.time() - due > 0.2:
                due = loop.time()
            await asyncio.sleep(max(0.0, due - loop.time()))

    def tick(self):
        """One 20 ms step: the agent hears everyone, each person the agent and the others, never themselves."""
        agent, voiced = self.agent_frame()
        frames = {person.id: person.take() for person in self.people.values()}
        everyone = sum(frames.values(), np.zeros(FRAME, np.float32))
        self.ear.put_nowait(np.clip(everyone, -1, 1))
        levels = {person_id: float(np.mean(frame ** 2)) for person_id, frame in frames.items()}
        for person_id, level in levels.items():
            self.people[person_id].loudness.append((self.mixed, level))
        self.mixed += FRAME
        for person in self.people.values():
            mix = pcm(agent + everyone - frames[person.id])
            person.send(mix + pcm(agent) if voiced else mix, frame=True)
        self.who_talks(levels)

    def agent_frame(self):
        """The agent's next 20 ms (and whether its voice is in it), sending the events met on the way."""
        out, filled, voiced = np.zeros(FRAME, np.float32), 0, False
        while self.voice and filled < FRAME:
            head = self.voice[0]
            if isinstance(head, dict):
                if head['type'] in ('said', 'tick') and len(self.voice) == 1:  # (its audio is still being made)
                    break
                self.broadcast(self.voice.popleft())
                continue
            used = min(len(head), FRAME - filled)
            out[filled:filled + used], voiced = head[:used], True
            filled += used
            if used < len(head):
                self.voice[0] = head[used:]
            else:
                self.voice.popleft()
        return out, voiced

    def who_talks(self, levels):
        """`talking`: the loudest person over TALKING_LEVEL, kept on them a moment after; null once nobody is."""
        now = time.monotonic()
        loudest = max(levels, key=levels.get, default=None)
        if loudest is not None and levels[loudest] > TALKING_LEVEL:
            self.talking_at = now
            if loudest != self.talking:
                self.talking = loudest
                self.broadcast({'type': 'talking', 'id': loudest})
        elif self.talking is not None and now - self.talking_at > TALKING_HOLD_SECONDS:
            self.talking = None
            self.broadcast({'type': 'talking', 'id': None})

    async def listen(self):
        """What the mixer gave the agent to hear, into the Call: beside the clock, so the recogniser never holds it."""
        while True:
            samples = await self.ear.get()
            try:
                await self.call.hear(samples)
            finally:
                self.ear.task_done()


def pcm(samples):
    return (np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes()

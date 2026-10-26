"""What the line asks HQ to do on the board's screen and waits for mid-reply (drawing.py's rings, driving.py's moves):
each ask by its id until HQ's answer settles it, runs out of time or the call ends."""
import asyncio


class Answers:
    """A call's asks of one kind still waiting for HQ's answer, each by its id: the future its answer settles. `words`
    holds what the agent hears when HQ doesn't answer in time ('late'), the call ends first ('ended') or HQ refuses
    without a why ('failed')."""
    def __init__(self, words):
        self.words = words
        self.waiting = {}

    async def ask(self, call, event, seconds):
        """Send HQ the ask (an event with its id) and wait up to `seconds` for its answer: {'said': HQ's word, or ''}
        when done, else {'error': why}."""
        answered = self.waiting[event['id']] = asyncio.get_running_loop().create_future()
        try:
            await call.send_event(event)
            return await asyncio.wait_for(answered, seconds)
        except TimeoutError:
            return {'error': self.words['late']}
        finally:
            self.waiting.pop(event['id'], None)

    def answer(self, ask_id, done, why):
        """HQ's answer to an ask: done (with a word on how, or ''), or why not in HQ's words. One for an ask that isn't
        waiting is let be."""
        answered = self.waiting.get(ask_id)
        if answered and not answered.done():
            answered.set_result({'said': why} if done else {'error': why or self.words['failed'] + '.'})

    def end(self):
        """The call ended: the asks still waiting get their answer now. (From any thread: Call.end runs in one.)"""
        for answered in list(self.waiting.values()):
            answered.get_loop().call_soon_threadsafe(lambda answered=answered: answered.done() or answered.set_result(
                {'error': self.words['ended']}))

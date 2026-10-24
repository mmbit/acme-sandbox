"""cd platform/voice && python3 care_check.py   (a care call end to end: the real care server against the line's
Care brain; a check to run by hand, not a unit test. Exit 0 when every check passes. Needs node 24; no models, no keys)

Each side has its own tests against the other's stand-in (platform/care's
phone.test.ts, test_care.py here); this runs the two real halves together. It starts platform/care's server
(node src/server.ts) with the scripted `fake` model, driven from here through CARE_FAKE_FILE (one list of steps a model
call), the phone port behind a token made here, and two stand-in stalls (kits/payments' `code` and `view`) that record
the code each was asked to email. Then server.Care, the brain the line runs a stranger's call on, takes a Dutch call
through every route: start, a first turn, send_code (the order's reference said in Dutch number words), the code read
out the same way, order_status, a barge-in, report_fault, ask_for_person, no_transcript, hang_up, the end, and a turn
after it. Checked at each boundary: what the brain yields (DELIVERED, the words, Step and Used under the line's names,
a space between one model call's words and the next's), what care asked the stalls, what it kept (the code read out
never in the transcript or its log, "(read out the code)" in its place, the call linked to the order), every model
call in the ledger as 'phone' (start's cache warm-up and the cut-short one as estimates), the fault note kept in care
and never sent to HQ,
and the objection carried out at the end (the words deleted, the fault note and the code check's result kept).

The speech models are never loaded: test_server's stand-ins go in before server is imported. Run it on its own: the
machine is shared and short of memory (no load_check.py at the same time).
"""
import asyncio, json, os, re, secrets, shutil, socket, sqlite3, subprocess, sys, tempfile, time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

HERE = Path(__file__).resolve().parent
CARE_DIR = HERE.parent / 'care'
sys.path.insert(0, str(HERE))
import test_server  # noqa: E402,F401  (stands in for the speech models, HQ's address and the line's token)
import server  # noqa: E402
from standins import JsonHandler, serve  # noqa: E402

ORDER, REF = 'bud-mgx2k1ab-3f9c0e12', '48291736'  # (kits/payments': its id, and the reference on its page and emails)
DUTCH = 'nul een twee drie vier vijf zes zeven acht negen'.split()
VIEW = {'id': ORDER, 'ref': REF, 'placed_at': '2026-09-24T10:00:00Z', 'title': 'Mug with a drawing', 'status': 'shipped',
        'shipped_at': '2026-09-28T09:00:00Z', 'delivered_at': None, 'carrier': 'UPS', 'tracking_url': 'https://ups.test/x',
        'country': 'NL', 'town': 'Utrecht', 'total_cents': 3995, 'address_masked': 'Teststraat 1, Utrecht'}

failed = []


def check(ok, what):
    print(f'  {"ok  " if ok else "FAIL"} {what}', flush=True)
    if not ok:
        failed.append(what)


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


# ---- stand-ins: the stalls (each records the codes it was asked to email and the views asked of it) and HQ
STALL_TOKEN = secrets.token_hex(16)
asked = []  # (stall, path, body)


def stall(name, orders):
    def found(order):  # (as kits/payments: its reference, or its id whatever the separators)
        key = ''.join(ch for ch in str(order or '').lower() if ch.isalnum())
        return any(key in (ref, oid.replace('-', '')) for oid, ref in orders)

    class Stall(JsonHandler):
        def do_POST(self):
            body = self.body()
            if self.headers.get('authorization') != f'Bearer {STALL_TOKEN}':
                return self.answer(401, {})
            asked.append((name, self.path, body))
            if self.path == '/api/care/code':
                return self.answer(200, {})
            if self.path == '/api/care/view':
                return self.answer(200, {'match': True, 'order': VIEW} if found(body.get('order')) else {'match': False})
            self.answer(404, {})
    return Stall


hq_paths = []


class Hq(JsonHandler):
    def do_GET(self):
        hq_paths.append(self.path)
        self.answer(200, {'busy': 'auto', 'queue': {'waiting': 0, 'oldest': None}})

    def do_POST(self):
        self.rfile.read(int(self.headers.get('content-length') or 0))
        hq_paths.append(self.path)
        self.answer(200, {'ok': True, 'id': str(len(hq_paths))})


# ---- the scripted model: the next model calls' answers (one list of steps each), used up in order
def model(fake, *calls):
    fake.write_text(json.dumps({'next': list(calls)}))


def unused(fake):
    return json.loads(fake.read_text()).get('next') or []


async def turn(brain, text, cut_at=None):
    """One turn as the line takes it: everything ask() yields, in order (Step/Used as ('step', name)/('used', name)).
    cut_at: the caller talks over the reply once its words so far hold this (the line's interrupt())."""
    got, words = [], ''
    try:
        async for x in brain.ask(text):
            if x is server.DELIVERED:
                got.append(('delivered',))
            elif isinstance(x, server.Language):
                got.append(('lang', str(x)))
            elif isinstance(x, str):
                got.append(x)
                words += x
                if cut_at and cut_at in words:
                    brain.interrupt()
            elif isinstance(x, server.Step):
                got.append(('step', x.name))
            elif isinstance(x, server.Used):
                got.append(('used', x.name))
            else:
                got.append(('?', repr(x)))
    except server.Unanswered as err:
        got.append(('unanswered', err.why))
    return got, words


def said(got):
    return ''.join(x for x in got if isinstance(x, str))


def marks(got):
    return [x for x in got if not isinstance(x, str) and x[0] != 'lang']


async def main(tmp):
    fake, data, log = tmp / 'fake.json', tmp / 'data', tmp / 'care.log'
    data.mkdir()
    model(fake)
    stalls = {'shop1': serve(stall('shop1', [(ORDER, REF)])), 'shop2': serve(stall('shop2', []))}
    hq = serve(Hq)
    url = lambda s: f'http://127.0.0.1:{s.server_address[1]}'
    port, phone_port, token = free_port(), free_port(), secrets.token_hex(24)
    env = {k: os.environ[k] for k in ('PATH', 'HOME', 'TMPDIR', 'LANG') if k in os.environ}
    env.update(DATA_DIR=str(data), PORT=str(port), CARE_HOST='127.0.0.1', CARE_LOCAL='1', CARE_PROVIDER='fake',
               CARE_FAKE_FILE=str(fake), CARE_APPS=json.dumps({a: url(s) for a, s in stalls.items()}),
               CARE_TOKENS=json.dumps({a: STALL_TOKEN for a in stalls}),
               CARE_SHOPS=json.dumps({'front': list(stalls)}), CARE_PHONE_PORT=str(phone_port),
               CARE_PHONE_TOKEN=token, CARE_HQ_URL=url(hq), CARE_HQ_TOKEN=secrets.token_hex(8))
    # our plug-in (products/care: phoneMonth 8, its phone texts); no CARE_PHONE_SHOP, as infra sets none
    with open(log, 'w') as out:
        care = subprocess.Popen(['node', 'src/server.ts'], cwd=CARE_DIR, env=env, stdout=out, stderr=subprocess.STDOUT)
    try:
        await run(fake, data, log, phone_port, token)
    finally:
        care.terminate()
        try:
            care.wait(10)
        except subprocess.TimeoutExpired:
            care.kill()
        for s in [*stalls.values(), hq]:
            s.shutdown()
        if failed:
            print('\n---- care\'s log\n' + log.read_text()[-4000:])


async def run(fake, data, log, phone_port, token):
    # (care, the one deployment)  #.
    deployment = server.CARE_ENGINES['care'] = {'url': f'http://127.0.0.1:{phone_port}', 'token': token, 'calls': 2}
    for _ in range(100):  # care up: its phone port answers (401 without the token)
        try:
            urlopen(Request(f"{deployment['url']}/phone/start", method='POST', data=b'{}'), timeout=1)
        except HTTPError:
            break
        except OSError:
            await asyncio.sleep(0.2)
    else:
        raise SystemExit('care did not start: ' + log.read_text()[-2000:])
    db = sqlite3.connect(f'file:{data / "care.db"}?mode=ro', uri=True)
    q = lambda sql, *a: db.execute(sql, a).fetchall()

    print('start')
    brain = server.Care('poppy', 'CAcheck0001', 'nl', ['nl', 'en'], 'bill_boerst', deployment=deployment)
    # (the Dutch opening played whole, so care keeps the words)
    brain.informed = lambda: ['nl']
    await brain.start()
    conv = brain.conversation
    check(isinstance(conv, int), f'/phone/start gave a conversation ({conv})')
    check(set(brain.words) == {'nl', 'de', 'en'} and all(w['ai'] and w['transcript'] and w['objected']
                                                          for w in brain.words.values()), 'the AI, transcript and objection words in nl, de, en')
    check(set(brain.langs) == {'nl', 'de', 'en'}, f'the plug-in\'s languages ({brain.langs})')
    brain.speak('nl')
    check(brain.objected == brain.words['nl']['objected'], 'speak(nl): the objection words in Dutch')
    check(q("select kind, shop from conversations where id = ?", conv) == [('phone', 'front')], "a conversation of kind 'phone' for the shop")
    for _ in range(50):  # (the warm-up runs on after /phone/start has answered)
        if q('select count(*) from ledger where conversation = ?', conv)[0][0]:
            break
        await asyncio.sleep(0.1)
    check(q('select purpose, estimate from ledger where conversation = ?', conv) == [('phone', 1)],
          'start warmed the cache: one model call in the ledger, as an estimate (it stops at its first event)')

    print('a first turn')
    model(fake, [{'text': '[nl] Hoi, met Poppy. Waarmee kan ik je helpen?'}])
    got, words = await turn(brain, 'Hallo, ik heb een vraag over mijn bestelling.')
    check(marks(got) == [('delivered',)], f'DELIVERED, then only words ({marks(got)})')
    check(got[1] == ('lang', 'nl'), f"the reply's language before its words, from the model's tag ({got[1]})")
    check(words == 'Hoi, met Poppy. Waarmee kan ik je helpen?', 'the reply streamed word by word, whole')
    check(len([x for x in got if isinstance(x, str)]) > 3, 'the words came in pieces, as the model wrote them')

    print('send_code')
    model(fake, [{'text': '[nl] Ik stuur een code.'}, {'tool': 'send_code', 'input': {'order': '4829 1736'}}],
          [{'text': 'Zeg het maar als je hem hebt.'}])
    got, words = await turn(brain, 'Het bestelnummer is vier acht twee negen, een zeven drie zes.')
    check(marks(got) == [('delivered',), ('step', 'send_code'), ('used', 'send_code')], f'Step then Used under care\'s name ({marks(got)})')
    check(words == 'Ik stuur een code. Zeg het maar als je hem hebt.', f'the two rounds\' words, a space between ({words!r})')
    for _ in range(50):
        codes = {a: b for a, p, b in asked if p == '/api/care/code'}
        if len(codes) == 2:
            break
        await asyncio.sleep(0.1)
    check(set(codes) == {'shop1', 'shop2'}, f'every stall of the shop was asked to email a code ({sorted(codes)})')
    check(all(b['order'] == REF and b['lang'] == 'nl' and len(b['code']) == 6 and b['code'].isdigit()
              for b in codes.values()), 'each with the order number as normalised, Dutch, six digits')
    check(codes['shop1']['code'] != codes['shop2']['code'], 'a code of its own per stall')
    code = codes['shop1']['code']

    print('the code read out in Dutch number words')
    spoken = ' '.join(DUTCH[int(d)] for d in code[:3]) + ', ' + ' '.join(DUTCH[int(d)] for d in code[3:])
    model(fake, [{'tool': 'order_status', 'input': {}}],
          [{'text': '[nl] Je bestelling is met UPS onderweg naar Utrecht.'}])
    got, words = await turn(brain, f'Ja, ik heb hem. De code is {spoken}.')
    check(marks(got) == [('delivered',), ('step', 'order_status'), ('used', 'order_status')], f'order_status ran ({marks(got)})')
    check(words == 'Je bestelling is met UPS onderweg naar Utrecht.', 'the reply after it')
    views = [(a, b) for a, p, b in asked if p == '/api/care/view']
    check(views == [('shop1', {'order': REF})], f'care asked the right stall (only) for the view: the code was right ({views})')
    linked = q('select linked from conversations where id = ?', conv)[0][0]
    check(linked is not None, 'the call is linked to the order (kept 12 months)')
    kept = q("select text from messages where conversation = ? and who = 'me' order by id", conv)
    check(any(t == 'Ja, ik heb hem. De code is (read out the code).' for t, in kept), f'kept as "(read out the code)": {kept[-1][0]!r}')
    every = ' '.join(t for t, in q('select text from messages where conversation = ?', conv))
    check(code not in every and spoken not in every and ' '.join(DUTCH[int(d)] for d in code[3:]) not in every,
          'the code is nowhere in the transcript, as digits or as words')
    check(not unused(fake), 'two model calls, as scripted')

    print('a barge-in')
    model(fake, [{'text': '[nl] Verzending duurt meestal twee tot vier werkdagen.'}, {'wait': 4000},
                 {'text': 'En dit hoort de beller nooit.'}])
    t0 = time.monotonic()
    got, words = await turn(brain, 'En hoe lang duurt verzending normaal?', cut_at='werkdagen.')
    check(time.monotonic() - t0 < 3, 'the turn stopped at the interrupt, not after the model\'s wait')
    check('nooit' not in words and marks(got) == [('delivered',)], 'nothing after the cut reached the line, and no Unanswered')
    for _ in range(50):
        ai = q("select text from messages where conversation = ? and who = 'ai' order by id desc limit 1", conv)[0][0]
        if 'werkdagen' in ai:
            break
        await asyncio.sleep(0.1)
    check(ai == 'Verzending duurt meestal twee tot vier werkdagen.', f'care kept what was said until the cut ({ai!r})')

    print('report_fault')
    model(fake, [{'tool': 'report_fault', 'input': {'order': REF, 'what': 'De naam op de mok is verkeerd gespeld.'}}],
          [{'text': '[nl] Sorry daarvoor.'}])
    got, words = await turn(brain, 'Er staat trouwens een fout in de naam op de mok.')
    check(marks(got) == [('delivered',), ('step', 'report_fault'), ('used', 'report_fault')], f'report_fault ran ({marks(got)})')
    check(words == 'Sorry daarvoor.', 'the model\'s words after it (it says the tool\'s answer in its own)')
    faults = q("select app, kind, words, sent_hq from cases where conversation = ?", conv)
    check(len(faults) == 1 and faults[0][1] == 'fault' and 'verkeerd gespeld' in faults[0][2], f'a fault note in care ({faults})')

    print('ask_for_person')
    model(fake, [{'tool': 'ask_for_person', 'input': {}}], [{'text': '[nl] Kan ik verder nog iets doen?'}])
    got, words = await turn(brain, 'Kan ik iemand spreken?')
    check(marks(got) == [('delivered',), ('step', 'ask_for_person'), ('used', 'ask_for_person')], f'ask_for_person ran ({marks(got)})')
    check(re.match(r'Mail naar \S+ apenstaartje .+ punt \S+: dan antwoordt een mens per e-mail', words) is not None
          and words.endswith('. Kan ik verder nog iets doen?') and '{' not in words,
          f'the server says the way to a person itself, in Dutch, the address said aloud ({words!r})')

    print('no_transcript')
    model(fake, [{'tool': 'no_transcript', 'input': {}}], [{'text': '[nl] Prima.'}])
    got, words = await turn(brain, 'Ik wil eigenlijk niet dat je dit gesprek bewaart.')
    check(marks(got) == [('delivered',), ('step', server.NO_TRANSCRIPT_TOOL), ('used', server.NO_TRANSCRIPT_TOOL)],
          f'no_transcript under the line\'s name, which it acts on ({marks(got)})')
    state = json.loads(q('select state from conversations where id = ?', conv)[0][0])
    check(state['phone'].get('objected') is True, 'the objection is on the call')
    check(q('select count(*) from messages where conversation = ?', conv)[0][0] > 0, 'its words stay until the call ends')

    print('hang_up')
    model(fake, [{'text': '[nl] Fijne dag nog!'}, {'tool': 'hang_up', 'input': {}}], [{'text': 'Dit volgt nooit.'}])
    got, words = await turn(brain, 'Dank je, dat was het.')
    check(marks(got) == [('delivered',), ('step', server.HANG_UP_TOOL), ('used', server.HANG_UP_TOOL)],
          f'hang_up under the line\'s name, then the end ({marks(got)})')
    check(words == 'Fijne dag nog!', 'its words before it, nothing after')
    check(len(unused(fake)) == 1, 'no model call after hang_up')

    print('the end')
    brain.ended = 'hung_up'
    await asyncio.to_thread(brain.close)
    state = json.loads(q('select state from conversations where id = ?', conv)[0][0])
    check(state['phone'].get('ended', {}).get('why') == 'hung_up', 'care has how the call ended')
    check(q('select count(*) from messages where conversation = ?', conv)[0][0] == 0, 'the objection: every word deleted at the end')
    check(q('select summary from conversations where id = ?', conv)[0][0] is None, '...and no summary')
    check(len(q("select 1 from cases where conversation = ? and kind = 'fault'", conv)) == 1, 'the fault note stays, objection or not')
    check([c['result'] for c in state['phone'].get('checks', [])] == ['right'] and state['phone'].get('granted', {}).get('order') == REF,
          'the code check\'s result stays')
    check(q('select count(*) from phone_codes where conversation = ? and used is null', conv)[0][0] == 0, 'every code spent')
    await asyncio.to_thread(brain.close)  # (once: a second close posts nothing)

    print('a turn after the end')
    model(fake, [{'text': 'Dit mag niet.'}])
    got, _ = await turn(brain, 'Hallo?')
    check(got[-1] == ('unanswered', 'error') and not said(got), f'refused, as Unanswered (care: 404) ({marks(got)})')

    print('the ledger, HQ and the log')
    rows = q('select purpose, estimate, app from ledger where conversation = ? order by id', conv)
    check(len(rows) == 14 and {p for p, _, _ in rows} == {'phone'},
          f'every model call of the call is in the ledger as phone: the warm-up and the turns\' 13 ({len(rows)})')
    check([e for _, e, _ in rows].count(1) == 2, 'the cut-short reply as an estimate, beside the warm-up\'s')
    check(q("select count(*) from ledger where purpose != 'phone'")[0][0] == 0, 'nothing on another purpose')
    await asyncio.sleep(1)
    check('/api/care/cards' not in hq_paths, f'no card went to HQ: the fault note stays in care ({sorted(set(hq_paths))})')
    text = log.read_text()
    check(code not in text and spoken not in text, 'the code is not in care\'s log')
    check(f'phone conversation {conv} ended (hung_up): its words deleted, as the caller asked' in text, 'care logged the end')
    db.close()


if __name__ == '__main__':
    tmp = Path(tempfile.mkdtemp(prefix='care-check-', dir=os.environ.get('TMPDIR')))
    try:
        asyncio.run(main(tmp))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f'\n{len(failed)} failed' + ''.join(f'\n  {f}' for f in failed) if failed else '\nall passed')
    sys.exit(1 if failed else 0)

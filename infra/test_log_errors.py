#!/usr/bin/env python3
"""python3 infra/test_log_errors.py: feeds log_errors.py made-up log lines (no Docker) and checks what it counts."""
import os, subprocess, sys

here = os.path.dirname(os.path.abspath(__file__))
run = lambda text: subprocess.run([sys.executable, os.path.join(here, 'log_errors.py')], input=text, text=True,
                                  capture_output=True, check=True).stdout
failed = 0

def check(name, ok):
    global failed
    print(('ok   ' if ok else 'FAIL ') + name)
    failed += not ok

caddy = ('{"level":"warn","ts":1790762750.52,"logger":"http.handlers.reverse_proxy","msg":"aborting with incomplete '
         'response","request":{"remote_ip":"%s","headers":{"Cookie":["REDACTED"]}},"error":"reading: context canceled"}\n')
out = run(caddy % '203.0.113.7' + caddy % '198.51.100.9' + '{"level":"info","msg":"served"}\n')
check('two Caddy warnings from different clients count as one kind', '2x warn: http.handlers.reverse_proxy aborting'
      in out and out.count('\n') == 1)
check("Caddy's client IPs and headers stay out", '203.0.113' not in out and 'Cookie' not in out)
check('info lines are left out', 'served' not in out)

out = run('2026-09-29T14:16:05.799Z job 2530 Worker error: TypeError: fetch failed\n'
          '2026-09-30T02:01:00.001Z job 2611 Worker error: TypeError: fetch failed\n'
          '2026-09-30T06:38:21.591Z claude-1: rechecked, now draining at 0%\n')
check('the same error on two jobs, at two times, counts once', '2x job N Worker error: TypeError: fetch failed' in out)
check('ordinary lines are left out', 'draining' not in out)

check('a quiet day says none', run('Coordinator listening on 8080\n').strip() == 'none')
out = run(''.join(f'error number {chr(97 + i)}\n' for i in range(15)))
check('only the top kinds are listed, the rest summed', 'and 3 more kinds (3 lines)' in out)

out = run("TypeError: Cannot read properties of undefined (reading 'status')\n    at handler (file:///app/src/server.ts:42:7)\n"
          'ReferenceError: x is not defined\n')
check('TypeError and ReferenceError lines are reported', 'TypeError: Cannot read' in out and 'ReferenceError: x is not' in out)
out = run('{"level":"error","logger":"http.stdlib","msg":"http: TLS handshake error from 203.0.113.7:51234: EOF"}\n'
          '{"level":"error","logger":"http.stdlib","msg":"http: TLS handshake error from 198.51.100.9:40000: EOF"}\n')
check('client IPs in a Caddy message collapse into one kind', '2x' in out and '203.0.113' not in out)
out = run('cancel unconfirmed, no answer from the printer\n')
check('warnings without a level word are caught by known phrases', 'unconfirmed' in out)
counts = lambda text: subprocess.run([sys.executable, os.path.join(here, 'log_errors.py'), '--counts'], input=text, text=True,
                                     capture_output=True, check=True).stdout
out = counts('Order failed for anna@example.com\nReferenceError: x is not defined\nall fine\n')
check('--counts withholds text and counts lines', 'example.com' not in out and 'ReferenceError' not in out and '2 warning/error' in out)
check('--counts on a quiet day says none', counts('hello\n').strip() == 'none')

# (--tail: report.sh's last lines of Caddy, in the report every agent reads with hq report)
tail = lambda text: subprocess.run([sys.executable, os.path.join(here, 'log_errors.py'), '--tail'], input=text, text=True,
                                   capture_output=True, check=True).stdout
bad_gateway = ('caddy-1  | {"level":"error","ts":1791076137.94,"logger":"http.log.error","msg":"dial tcp 172.18.0.5:8080: connect: '
               'connection refused","request":{"remote_ip":"203.0.113.7","client_ip":"203.0.113.7","host":"shop.example.com",'
               '"uri":"/api/orders/bud-abc-12345678/cancel","headers":{"X-Order-Token":["ordersecret123"],"X-Mail-From":'
               '["anna@example.com"],"Cookie":["REDACTED"]}},"status":502}\n')
out = tail(bad_gateway + 'caddy-1  | {"level":"info","ts":1791076138,"msg":"handshake from 2001:db8::7:1:2 ok"}\n'
           + 'worker-1  | 2026-10-04T00:40:33.770Z claude#8: token ghp_abcdefghijklmnop and a plain line\n')
check('--tail keeps every line, cut down', out.count('\n') == 3 and 'connection refused' in out and '502' in out
      and out.startswith('caddy-1  | 2026-10-04T'))
check("--tail: no request, header, order key, sender or client IP from Caddy",
      not any(s in out for s in ('ordersecret123', 'anna@example.com', '203.0.113', 'bud-abc', 'X-Order-Token', '"request":', '/api/orders', '2001:db8')))
check('--tail redacts keys in plain lines and keeps their times', 'ghp_' not in out and '[redacted]' in out
      and '2026-10-04T00:40:33.770Z claude#8' in out)
# a plain line's addresses go too, and a ts out of range costs only its time
out = tail('coordinator-1  | mail from 198.51.100.4 anna@example.com refused\n{"level":"error","ts":1759600000123,"msg":"ms ts"}\n'
           '{"level":"error","msg":"after"}\n')
check('--tail: IP and e-mail addresses in a plain line are scrubbed', 'mail from N.N.N.N [email] refused' in out
      and '198.51' not in out and 'anna@' not in out)
check('--tail: a ts out of range drops its time, not the line or the lines after', '"ms ts"' in out and '"after"' in out)

sys.exit(1 if failed else 0)

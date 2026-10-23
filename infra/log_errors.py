#!/usr/bin/env python3
"""A day of one service's log on stdin, its warnings and errors out: counted, deduplicated, most frequent first.

report.sh runs it per service with `docker compose logs --since 24h --no-log-prefix`, since the report's own log
tails are only 40 lines and a night's error scrolls out of them. Lines are cut down
to what repeats: Caddy's JSON keeps only level, logger, message and error (no request fields, headers or cookies, house rule
7), and in all lines timestamps, numbers and ids (so client IPs too) become N, so the same fault counts once.
It lists keyword matches (error, warn, fail, *Error names, ...), not every warning: Node's console adds no level.

With --counts (product apps) no log text is printed at all: their errors carry customer data (e-mail addresses, order
details) that cannot be scrubbed out of free text. Only one count of their warning and error lines is shown.

With --tail (report.sh's last-40-lines of each platform service) every line goes through, keys redacted, and a JSON
line (Caddy's) keeps only the fields in TAIL_FIELDS: never the request, whose headers carry a shop's X-Order-Token and
the inbound mail's sender, and whose remote_ip is a customer's (house rule 7). In every line, JSON or plain, IP addresses
become N.N.N.N and e-mail addresses [email].
"""
import datetime, json, re, sys

TOP = 12
BAD = re.compile(r'\b(\w*error|err|warn(ing)?|fail(ed|ure|s)?|fatal|panic|exception|refused|timed? ?out|unhandled|denied|unconfirmed|no answer)\b',
                 re.I)
JSON_BAD = {'warn', 'warning', 'error', 'fatal', 'panic', 'dpanic'}
SECRET = re.compile(r'(sk-|sk_|rk_|whsec_|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}|x-access-token:[^@ ]+@?|Bearer [A-Za-z0-9._~+/=-]{8,}')
STAMP = re.compile(r'^\s*(\d{4}-\d\d-\d\d[T ][\d:.]+Z?|time="[^"]*")\s*')
NOISE = re.compile(r'\b[0-9a-f]{8,}\b|\b[0-9a-f-]{36}\b|\d+(\.\d+)?', re.I)

# (the --tail mode)
TAIL_FIELDS = ('level', 'logger', 'msg', 'error', 'status', 'upstream', 'duration', 'identifiers', 'domains', 'file')
PREFIX = re.compile(r'^([\w.-]+\s+\| )?(.*)$', re.S)   # compose's "caddy-1  | " when logs run with a prefix
EMAIL = re.compile(r'[\w.+-]+@[\w-]+(\.[\w-]+)+')
IP = re.compile(r'\b\d{1,3}(\.\d{1,3}){3}\b|(?<![\w:])(?:[0-9a-f]{0,4}:){3,7}[0-9a-f]{0,4}(?![\w:])', re.I)   # v4, v6 (3+ colons)

def tail_line(line):
    prefix, rest = PREFIX.match(line.rstrip('\n')).groups()
    if rest.startswith('{'):
        try:
            j = json.loads(rest)
        except ValueError:
            j = None
        if isinstance(j, dict):
            ts, when = j.get('ts'), ''
            try:   # a ts out of range (milliseconds, say) leaves the time out, never the rest of the report
                when = datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).isoformat(timespec='seconds') if isinstance(ts, (int, float)) else ''
            except (ValueError, OverflowError, OSError):
                pass
            kept = {k: j[k] for k in TAIL_FIELDS if k in j}
            if isinstance(j.get('request'), dict):   # which site and method only (a host is ours, a product's)
                kept.update({f'request_{k}': j['request'][k] for k in ('host', 'method') if isinstance(j['request'].get(k), str)})
            rest = f"{when} {json.dumps(kept, ensure_ascii=False)}".strip()
    return (prefix or '') + EMAIL.sub('[email]', IP.sub('N.N.N.N', SECRET.sub('[redacted]', rest)))

def cut(text):
    return SECRET.sub('[redacted]', text)[:200]

def level_bad(level):
    if isinstance(level, (int, float)):
        return level >= 40
    return str(level).lower() in JSON_BAD

def key(line):
    line = line.rstrip('\n')
    if line.startswith('{'):
        try:
            j = json.loads(line)
        except ValueError:
            j = None
        if isinstance(j, dict):
            if not level_bad(j.get('level', '')):
                return None
            err = f" ({j['error']})" if j.get('error') else ''
            return cut(NOISE.sub('N', f"{j.get('level')}: {j.get('logger', '')} {j.get('msg', '')}{err}".replace('  ', ' ')))
    if not BAD.search(line):
        return None
    return cut(NOISE.sub('N', STAMP.sub('', line)).strip())

def main():
    if '--tail' in sys.argv[1:]:
        for line in sys.stdin:
            print(tail_line(line))
        return
    if '--counts' in sys.argv[1:]:
        n = sum(1 for line in sys.stdin if key(line))
        return print(f'  {n} warning/error lines (text withheld)' if n else '  none')
    counts = {}
    for line in sys.stdin:
        k = key(line)
        if k:
            counts[k] = counts.get(k, 0) + 1
    if not counts:
        return print('  none')
    ranked = sorted(counts.items(), key=lambda kv: -kv[1])
    for k, n in ranked[:TOP]:
        print(f'  {n:>5}x {k}')
    if len(ranked) > TOP:
        print(f'  ... and {len(ranked) - TOP} more kinds ({sum(n for _, n in ranked[TOP:])} lines)')

if __name__ == '__main__':
    main()

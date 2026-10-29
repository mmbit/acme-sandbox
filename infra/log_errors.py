#!/usr/bin/env python3
"""A day of one service's log on stdin, its warnings and errors out: counted, deduplicated, most frequent first."""
import datetime, json, re, sys

TOP = 12
BAD = re.compile(r'\b(\w*error|err|warn(ing)?|fail(ed|ure|s)?|fatal|panic|exception|refused|timed? ?out|unhandled'
                 r'|denied|unconfirmed|no answer)\b', re.I)
JSON_BAD = {'warn', 'warning', 'error', 'fatal', 'panic', 'dpanic'}
SECRET = re.compile(r'(sk-|sk_|rk_|whsec_|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}|x-access-token:[^@ ]+@?'
                    r'|Bearer [A-Za-z0-9._~+/=-]{8,}')
STAMP = re.compile(r'^\s*(\d{4}-\d\d-\d\d[T ][\d:.]+Z?|time="[^"]*")\s*')
NOISE = re.compile(r'\b[0-9a-f]{8,}\b|\b[0-9a-f-]{36}\b|\d+(\.\d+)?', re.I)

# A Caddy line in --tail keeps only these: never the request, whose headers carry a shop's X-Order-Token and the
# inbound mail's sender, and whose remote_ip is a customer's (house rule 7)
TAIL_FIELDS = ('level', 'logger', 'msg', 'error', 'status', 'upstream', 'duration', 'identifiers', 'domains', 'file')
PREFIX = re.compile(r'^([\w.-]+\s+\| )?(.*)$', re.S)   # compose's "caddy-1  | " when logs run with a prefix
EMAIL = re.compile(r'[\w.+-]+@[\w-]+(\.[\w-]+)+')
# v4, v6 (3+ colons)
IP = re.compile(r'\b\d{1,3}(\.\d{1,3}){3}\b|(?<![\w:])(?:[0-9a-f]{0,4}:){3,7}[0-9a-f]{0,4}(?![\w:])', re.I)

def tail_line(line):
    prefix, rest = PREFIX.match(line.rstrip('\n')).groups()
    j = json_line(rest)
    if j is not None:
        ts, when = j.get('ts'), ''
        try:   # a ts out of range (milliseconds, say) leaves the time out, never the rest of the report
            if isinstance(ts, (int, float)):
                when = datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).isoformat(timespec='seconds')
        except (ValueError, OverflowError, OSError):
            pass
        kept = {k: j[k] for k in TAIL_FIELDS if k in j}
        if isinstance(j.get('request'), dict):   # which site and method only (a host is ours, a product's)
            request = j['request']
            kept.update({f'request_{k}': request[k] for k in ('host', 'method') if isinstance(request.get(k), str)})
        rest = f"{when} {json.dumps(kept, ensure_ascii=False)}".strip()
    return (prefix or '') + EMAIL.sub('[email]', IP.sub('N.N.N.N', SECRET.sub('[redacted]', rest)))

def cut(text):
    return SECRET.sub('[redacted]', text)[:200]

def level_bad(level):
    if isinstance(level, (int, float)):
        return level >= 40
    return str(level).lower() in JSON_BAD

# What repeats in a line, so the same fault counts once: Caddy's JSON keeps only level, logger, message and error (no
# request fields, headers or cookies, house rule 7), and timestamps, numbers and ids (client IPs too) become N. Lines
# count by keyword (error, warn, fail, *Error names...): Node's console adds no level.
def key(line):
    line = line.rstrip('\n')
    j = json_line(line)
    if j is not None:
        if not level_bad(j.get('level', '')):
            return None
        err = f" ({j['error']})" if j.get('error') else ''
        said = f"{j.get('level')}: {j.get('logger', '')} {j.get('msg', '')}{err}".replace('  ', ' ')
        return cut(NOISE.sub('N', said))
    if not BAD.search(line):
        return None
    return cut(NOISE.sub('N', STAMP.sub('', line)).strip())

def json_line(text):
    """The line's JSON object (Caddy's), or None for any other line."""
    try:
        j = json.loads(text) if text.startswith('{') else None
    except ValueError:
        return None
    return j if isinstance(j, dict) else None

def main():
    if '--tail' in sys.argv[1:]:   # report.sh's 40-line tails: every line, keys, IP and e-mail addresses redacted
        for line in sys.stdin:
            print(tail_line(line))
        return
    if '--counts' in sys.argv[1:]:   # product apps: their errors carry customer data no scrub gets out of free text
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

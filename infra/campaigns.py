#!/usr/bin/env python3
"""A product's orders per ad label for the status report: `node src/campaigns.ts --json` on stdin, table rows out.
Or its page loads per ad label, when the JSON says `"counts": "page loads"` (the shop's own pages count nothing else),
with the visitors and visits they began where a row has them (`"visitors": 3, "visits": 4`; null or left out: not
counted, a dash).
With the product's name as its argument it prints the section's heading first.

Every agent reads the report, so a product's own words never reach it: only the numbers' fields are taken (each day,
label and count checked for its form) and printed as `| ... |` rows. Anything else the product prints (an error, a stray
line, a name in a label) is left out, and the report says how much. At most 100 rows, as the report gave it before.

Page loads per page and source: the JSON may also carry
`"today": "2026-10-18", "pages": [{"day": "2026-10-18", "page": "/nl/cadeaus/nieuw-huis/", "source": "person",
"loads": 12}, ...]`, one row per product day, page and source. today: the product's day as it prints them (the day its
rows are dated by: shared/metrics day()), so the week is cut on the product's own clock. page: the path (lowercase letters, digits, `-` and `/`, starting with `/`, no query).
source: where a person came from (shared/metrics loadSource: `none`, `stall` for the app's own pages, `shop`,
`ai-<assistant>`, `search-<engine>`, a social network by name such as `meta`, `other`; or `person`, one counted before
the app kept where they came from), `prefetch` (a load ahead of a tap that may never come) or `agent-<name>` (a crawler
or fetcher: shared/metrics fetchedBy): lowercase letters, digits and `-`. They print in a section of their own: the last
7 days to the product's today summed per page, one row per page and a column per source seen, sorted by page, then the
same days one row per day (newest first) and a column per source; days before are skipped. At most 100 pages. Without
`pages`, no section.
(prefetch)
"""
import collections, datetime, json, math, re, sys

ROWS = 100
DAY = re.compile(r'\d{4}-\d\d-\d\d')
LABEL = re.compile(r'[a-z0-9-]{1,40}|\(none\)')   # an ad label (the products' LABELS), or unlabelled
ORDERS = ('orders', 'paid', 'refunded', 'kept')
LOADS = ('loads',)
VISITS = ('visitors', 'visits')   # with LOADS, each a count or null (not counted).
NAME = re.compile(r'[a-z0-9-]{1,40}')
HEADING = {ORDERS: 'orders per ad label (live, last 30 days, no customer data; its README, "Ad labels")',
           LOADS: 'page loads per ad label, with visitors and visits (live, last 30 days, nothing else counted; its '
                  'README, "Ad labels"; a visitor: one internet address and browser in a day, and a person back on '
                  'another day counts again, a visit: its page loads with under 30 minutes between; -: not counted)'}

def cells(line, by_day, counted):
    """A row's cells, or None if any field isn't in its form. counted: ORDERS (with their euros) or LOADS."""
    if not isinstance(line, dict):
        return None
    day, label, eur = line.get('day'), line.get('label'), line.get('eur')
    if by_day and not (isinstance(day, str) and DAY.fullmatch(day)):
        return None
    if not (isinstance(label, str) and LABEL.fullmatch(label)):
        return None
    counts = [line.get(k) for k in counted]
    if not all(type(n) is int and 0 <= n < 10**9 for n in counts):
        return None
    if counted == LOADS:
        visits = [line.get(k) for k in VISITS]
        if not all(n is None or (type(n) is int and 0 <= n < 10**9) for n in visits):
            return None
        return ([day] if by_day else []) + [label] + [str(n) for n in counts] + ['-' if n is None else str(n) for n in visits]
    if type(eur) not in (int, float) or not math.isfinite(eur) or not 0 <= eur < 10**9:
        return None
    return ([day] if by_day else []) + [label] + [str(n) for n in counts] + [f'{eur:.2f}']

def table(lines, by_day, room, counted):
    """The rows that are in form (as many as there's room for), how many weren't, and how many found no room."""
    rows, bad, more = [], 0, 0
    for line in lines if isinstance(lines, list) else []:
        row = cells(line, by_day, counted)
        if row is None:
            bad += 1
        elif len(rows) < room:
            rows.append(row)
        else:
            more += 1
    return rows, bad + (0 if isinstance(lines, list) else 1), more

PAGE = re.compile(r'/[a-z0-9/-]{0,200}')
SOURCE = re.compile(r'[a-z0-9-]{1,40}')
WEEK = 7

def page_cells(line):
    """(day, page, source, loads) of a row in the table's form, else None."""
    if not isinstance(line, dict):
        return None
    day, page, source, n = (line.get(k) for k in ('day', 'page', 'source', 'loads'))
    if (isinstance(day, str) and DAY.fullmatch(day) and isinstance(page, str) and PAGE.fullmatch(page)
            and isinstance(source, str) and SOURCE.fullmatch(source) and type(n) is int and 0 <= n < 10**9):
        return day, page, source, n
    return None

def pages(lines, name, today):
    """The section of page loads per page and source over the WEEK days to today (the product's day, as the JSON gives
    it), from the JSON's `pages`."""
    out = [f'== {name}: page loads per page and source (live, last {WEEK} days; where a person came from, prefetch, '
           'agent-<crawler>)'] if name and NAME.fullmatch(name) else []
    try:
        today = datetime.date.fromisoformat(today) if isinstance(today, str) and DAY.fullmatch(today) else None
    except ValueError:
        today = None
    if today is None:
        return out + ["No numbers: its JSON gave no `today` (the product's day), so the week can't be cut."]
    first = (today - datetime.timedelta(days=WEEK - 1)).isoformat()
    out.append(f"{first} to {today.isoformat()} (the product's days)")
    loads, days = collections.defaultdict(collections.Counter), collections.defaultdict(collections.Counter)
    bad = 0 if isinstance(lines, list) else 1
    for line in lines if isinstance(lines, list) else []:
        cells = page_cells(line)
        if cells is None:
            bad += 1
        elif first <= cells[0] <= today.isoformat():
            loads[cells[1]][cells[2]] += cells[3]
            days[cells[0]][cells[2]] += cells[3]
    seen = {s for by in loads.values() for s in by}
    # where people came from first, then the prefetches, then the crawlers
    sources = sorted(seen, key=lambda s: (s.startswith('agent-'), s == 'prefetch', s))
    row = lambda first, by: f"| {first} | {' | '.join(str(by.get(s, 0)) for s in sources)} |"
    if not loads:
        out.append('No page loads in these days.')
    else:
        out += [f"| page | {' | '.join(sources)} |", f"|{'---|' * (len(sources) + 1)}"]
        out += [row(p, loads[p]) for p in sorted(loads)[:ROWS]]
    if len(loads) > ROWS:
        out.append(f'({len(loads) - ROWS} more pages, past the {ROWS} the report shows)')
    if loads:
        out += ['Per day', f"| day | {' | '.join(sources)} |", f"|{'---|' * (len(sources) + 1)}"]
        out += [row(d, days[d]) for d in sorted(days, reverse=True)]
        out.append('none: no referrer; stall: the app\'s own pages; shop: the host\'s other pages; a '
                   'social network by name (meta: Facebook or Instagram); other: any other site.'
                   + (' person: counted before it kept where people came from.' if 'person' in seen else ''))
    if bad:
        out.append(f"({bad} rows not in the table's form, left out)")
    return out

def render(text, name=None):
    try:
        j = json.loads(text)
    except ValueError:
        j = None
    counted = LOADS if isinstance(j, dict) and j.get('counts') == 'page loads' else ORDERS
    out = [f'== {name}: {HEADING[counted]}'] if name and NAME.fullmatch(name) else []
    if not isinstance(j, dict):
        return out + ["No numbers: its output wasn't the numbers' JSON (it may have failed), so it's left out."]
    mode, since, until = j.get('mode'), j.get('since'), j.get('until')
    if mode in ('live', 'test') and all(isinstance(d, str) and DAY.fullmatch(d) for d in (since, until)):
        made = 'made ' if counted == ORDERS else ''
        out.append(f"{mode}, {made}{since} to {'today' if until == '9999-12-31' else until} (the product's days)")
    days, bad_days, more_days = table(j.get('days'), True, ROWS, counted)
    labels, bad_labels, more_labels = table(j.get('labels'), False, ROWS - len(days), counted)
    if not days and not bad_days:
        out.append('No page loads in this period.' if counted == LOADS else 'No orders in this period.')
    columns = [*counted, *VISITS] if counted == LOADS else [*counted, 'eur']
    head = lambda cols: [f"| {' | '.join(cols)} |", f"|{'---|' * len(cols)}"]
    if days:
        out += head(['day', 'label', *columns]) + [f"| {' | '.join(r)} |" for r in days]
    if labels:
        out += ['The whole period'] + head(['label', *columns]) + [f"| {' | '.join(r)} |" for r in labels]
    if more_days + more_labels:
        out.append(f'({more_days + more_labels} more rows, past the {ROWS} the report shows)')
    if bad_days + bad_labels:
        out.append(f'({bad_days + bad_labels} rows not in the table\'s form, left out)')
    if 'pages' in j:
        out += [''] + pages(j['pages'], name, j.get('today'))
    return out

if __name__ == '__main__':
    print('\n'.join(render(sys.stdin.read(1 << 20), sys.argv[1] if len(sys.argv) > 1 else None)))

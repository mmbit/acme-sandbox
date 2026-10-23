"""Numbers written out as words before they are spoken, by the voice line (server.py) and On Air (shared/onair), and the
company's words respelt as they should sound (respelt)."""
import re

# How the line says a day that isn't today: a weekly window resets days away
DAYS = {
    'en': {'tomorrow': '{t} tomorrow', 'on': '{d} at {t}', 'date': '{n} {m} at {t}',
           'days': ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'),
           'months': ('January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
                      'November', 'December')},
    'nl': {'tomorrow': 'morgen om {t}', 'on': '{d} om {t}', 'date': '{n} {m} om {t}',
           'days': ('maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'),
           'months': ('januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september',
                      'oktober', 'november', 'december')},
    # (German: "bis zum 7. Oktober um 00:10" when a seat's limit ends)
    'de': {'tomorrow': 'morgen um {t}', 'on': '{d} um {t}', 'date': 'zum {n}. {m} um {t}',
           'days': ('Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'),
           'months': ('Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober',
                      'November', 'Dezember')},
}


# Numbers as the speech engines should say them: neither Pocket TTS nor Piper reads "€4" or "€29,95" as money, "06"
# was swallowed with the words after it and "310" came out "three ten", so the line writes every number out in the
# call's language before it's spoken. The words only: what HQ shows and the transcript keep the numbers as the agent
# wrote them.
NUMBERS = {
    'en': {'ones': 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen '
                   'sixteen seventeen eighteen nineteen'.split(),
           'tens': 'twenty thirty forty fifty sixty seventy eighty ninety'.split(), 'point': 'point', 'dot': 'point',
           'scale': ('thousand', 'million', 'billion'), 'one': 'one', 'a': 'one', 'oh': 'oh',
           'euro': ('euro', 'euros'), 'cent': ('cent', 'cents'), 'and': 'and', 'minus': 'minus', 'plus': 'plus',
           'percent': 'percent', 'number': 'number', 'to': 'to',
           'short': 'Jan Feb Mar Apr May Jun Jul Aug Sept? Oct Nov Dec',  # (the months' short names, as patterns)
           # (no pause between a code's parts: at one, alba stopped before the last)
           'pause': ' '},
    'nl': {'ones': 'nul een twee drie vier vijf zes zeven acht negen tien elf twaalf dertien veertien vijftien zestien '
                   'zeventien achttien negentien'.split(),
           'tens': 'twintig dertig veertig vijftig zestig zeventig tachtig negentig'.split(),
           'point': 'komma', 'dot': 'punt',
           'scale': ('duizend', 'miljoen', 'miljard'), 'one': 'één', 'a': 'één', 'oh': 'nul',
           'euro': ('euro', 'euro'), 'cent': ('cent', 'cent'), 'and': 'en', 'minus': 'min', 'plus': 'plus',
           'percent': 'procent', 'number': 'nummer', 'to': 'tot',
           'short': 'jan feb mrt apr mei jun jul aug sept? okt nov dec',
           # (a code's letters by their names, A to Z, as they sound and never a word of the language: "AB" was the word
           # "ab", "M" heard as "N" and "er" swallowed. English says a capital alone right, and "ay bee" wrong.
           'letters': 'aa bee cee dee ee eff gee haa ie jee kaa ell emm enn oo pee kuu err ess tee uu vee wee iks ij '
                      'zet'},
    # (one: the number, "eins"; a: one of something, "ein Euro"; German writes numbers under a million as one word)
    'de': {'ones': 'null eins zwei drei vier fünf sechs sieben acht neun zehn elf zwölf dreizehn vierzehn fünfzehn '
                   'sechzehn siebzehn achtzehn neunzehn'.split(),
           'tens': 'zwanzig dreißig vierzig fünfzig sechzig siebzig achtzig neunzig'.split(),
           'point': 'Komma', 'dot': 'Punkt',
           'scale': ('tausend', 'Millionen', 'Milliarden'), 'single': ('tausend', 'eine Million', 'eine Milliarde'),
           'one': 'eins', 'a': 'ein', 'oh': 'null',
           'euro': ('Euro', 'Euro'), 'cent': ('Cent', 'Cent'), 'and': 'und', 'minus': 'minus', 'plus': 'plus',
           'percent': 'Prozent', 'number': 'Nummer', 'to': 'bis',
           'short': 'Jan Feb Mär Apr Mai Jun Jul Aug Sept? Okt Nov Dez',
           'letters': 'Ah Beh Zeh Deh Eh Eff Geh Hah Ih Jott Kah Ell Emm Enn Oh Peh Kuh Err Ess Teh Uh Fau Weh Iks '
                      'Ypsilon Zett'},
}
SCALES = {'k': 0, 'thousand': 0, 'duizend': 0, 'tausend': 0, 'tsd': 0, 'm': 1, 'mn': 1, 'mln': 1, 'mio': 1,
          'million': 1, 'millionen': 1, 'miljoen': 1, 'bn': 2, 'billion': 2, 'mld': 2, 'mrd': 2, 'miljard': 2,
          'milliarde': 2, 'milliarden': 2}
# €4, € 4, €4,-, €29.95, €29,95, €1,250, €1.250 or €1 250 (thousands), €1.250,50, €0.125 (more digits than cents),
# €1.5m, €1,125 million (with a scale, a point or comma is a decimal one), €2 million, €-4 or -€4, and the same with the
# € after. (A lone 0 has no thousands: €0.125; and four thousands groups or fifteen digits at most, so a long run of
# digits stays quick and is never one amount.)
GAP = r'[ \t\u00a0\u202f]'  # (a space on the same line: an amount never runs on into the next line's number)
AMOUNT = (r'(?:(?P<number>[1-9]\d{0,2}(?:[ \u00a0\u202f]\d{3}(?!\d)){1,4}|\d{1,15}(?!\d))(?:[.,](?P<point>\d+))?'
          rf'{GAP}?(?P<scale>' + '|'.join(SCALES) + r')\b'
          r'|(?P<whole>[1-9]\d{0,2}(?:(?P<sep>[., \u00a0\u202f])\d{3}(?!\d))(?:(?P=sep)\d{3}(?!\d)){0,3}'
          r'|\d{1,15}(?!\d))'
          r'(?:[.,](?:(?P<cents>\d{1,2})|(?P<decimals>\d{3,}))(?!\d)|[.,][-–—])?)')
# (an amount before a € that starts another amount isn't one: "3 €4 mugs"; nor is a sign after a word, a digit or a
# €: "3-4 €", "4€-6€". The sign: -€4, €-4, +€4 or "a +4 000 € change")
EUROS = re.compile(rf'(?:(?:(?<![\w.,€])(?P<sign_before>[-−+]))?(?P<pre>€){GAP}?(?P<sign_after>[-−+])?'
                   rf'|(?<![\w.,€])(?P<sign>[-−+])?){AMOUNT}(?(pre)|{GAP}?€(?!{GAP}?\d))', re.I)
# A range of euros says the euros once, at the end, as the speech engine repeats a repeated unit: "€35–40", "€35-€40",
# "€35 – €40", "€35—40" (an em dash between spaces is a pause), "€35 to €40", "€35–40 euros" and "35€–40€" are all
# "thirty-five to forty euros", "€1m–€2m" "one million to two million euros" and "€1–2 million" "one to two million
# euros". The first amount and what joins them are said here, and the second (SECOND_EUROS) is left to EUROS, with a €
# if it has none.
EURO_RANGE = re.compile(rf'(?<![\w.,€+−-])(?:(?P<pre>€){GAP}?)?{AMOUNT}(?(pre)|{GAP}?€)'
                        rf'(?:{GAP}?[-–]{GAP}?|—|{GAP}(?:to|tot|bis){GAP})(?=€?{GAP}?\d)', re.I)
# (the second amount of a range of euros, read whole: not a time, a percentage, the middle of a longer run of amounts or
# an amount of something else, so a bare one is euros only when nothing it could count follows: the end, a comma or
# stop, or a word no count goes on into. "€35–40, or €45" and "€35–40 a month", but "€5–10 minutes" is five euros to ten
# minutes, and "€5 to 10 of the volunteers" or "€5 to 10 or more people" five euros to ten of them)
NOT_COUNTING = ('per', 'each', 'a', 'an', 'incl', 'excl', 'btw', 'elk', 'elke', 'een', 'pro', 'je', 'im', 'inkl',
                'zzgl')
SECOND_EUROS = re.compile(rf'(?P<euro>€{GAP}?)?{AMOUNT}(?![.,]\d|{GAP}?[:%]|[-–]€?\d)'
                          rf'(?:(?P<after>{GAP}?€(?!{GAP}?\d))|(?P<word>{GAP}euros?\b)'
                          rf'|(?(euro)|(?={GAP}*(?:$|[^\w \t\u00a0\u202f]|(?:{"|".join(NOT_COUNTING)})\b))))', re.I)
# What isn't an amount, in the order they're read (each leaves words, so a later one can't read its digits again):
# a code or a postcode (below), a date in figures (2026-10-07, 7-10-2026, 7/10/2026), a phone number or anything with a
# leading zero (06-12345678, 020; with a + only a country code and eight digits or more, +31 6 1234 5678: "+12" and
# "+5%" are signed numbers), a range of euros (above), any other range ("2-3", "9:00–17:00", "50%-60%"; not around
# spaces: "3 — 2 of them" is a pause), a time ("22:00", "9:30 am", "3pm"), the euro amounts, a date in words
# ("7 October", "8 Oct", "October 7th", "7 oktober") and what's left: "310", "1,250", "2.5", "42%", "1st", "#90", "-4",
# "+12", a year ("2026"), the 3 of "3D".
# A code is read a letter or a digit at a time, a letter by its name ("1234AB" run together tripped the voices, and
# "AB" was the Dutch and German word): a postcode, together in either case ("1234AB", "1234ab"; not a number's unit or
# ending: "1500km", "1990th") or apart in capitals ("1234 AB", unless words go on: "2026 AI will"), and a word with a
# capital before a digit ("7Q4K", "A4", "MP3") or of capitals and numbers joined by dashes ("ORD-7Q4K-M2", "BUD-2041"),
# with a pause between its parts. A word of five letters or more in it stays a word ("COVID-19", "iPhone15").
POSTCODE = re.compile(r'\b(?P<digits>[1-9]\d{3})(?:(?P<letters>[A-Za-z]{2})\b| (?P<apart>[A-Z]{2})\b(?!\s+[a-z]))')
UNITS = 'st nd rd th am pm km kg mg ml mm cm dm dl cl px pt kb mb gb hz kw er'.split()
CODE = re.compile(r'(?<![\w.,:-])(?:[A-Za-z0-9]++(?:-[A-Za-z0-9]++)++|(?=[A-Za-z0-9]*[A-Z]\d)[A-Za-z0-9]++)'
                  r'(?![\w-]|[.,]\d)')
FIGURE_DATE = re.compile(r'(?<![\w.,:/-])(?:(?P<year>\d{4})-(?P<month>\d{1,2})-(?P<day>\d{1,2})'
                         r'|(?P<day_>\d{1,2})(?P<sep>[-/.])(?P<month_>\d{1,2})(?P=sep)(?P<year_>\d{4}))'
                         r'(?![\w/-]|[.,]\d)')
PHONE = re.compile(rf'(?<![\w.,€:+])(?<!€{GAP})(?<!\d{GAP})(?:\+(?=\d(?:[ -]?\d){{7}})\d|0\d)\d*(?:[ -]\d+)*'
                   rf'(?![\d:%]|[.,]\d|{GAP}?€)')
RANGE = re.compile(r'(?<![\w.,+:–-])(?P<left>(?:€\s?)?(?:\d{1,2}:\d{2}|(?!0\d)\d+(?:[.,]\d+)*)(?:\s?[€%])?)'
                   r'[-–](?=€?\d)')
TIME = re.compile(r'(?<![\w.,:])(?P<hour>[01]?\d|2[0-3])(?::(?P<minute>[0-5]\d)(?![:\d]))?'
                  r'(?:\s?(?P<half>[ap])\.?m\b(?:\.(?!\s*$))?)?(?(minute)|(?(half)|(?!)))(?:\s?(?:uur|Uhr)\b)?', re.I)
WORD_DATE = {lang: re.compile(
    rf'(?<![\w.,])(?:(?P<the>[Tt]he\s)?(?P<day>\d{{1,2}})(?:st|nd|rd|th|e|ste|de)?{dot}\s(?:of\s)?(?P<month>{months})\b'
    rf'|(?P<month_>{months})\b\.?\s(?P<day_>\d{{1,2}})(?:st|nd|rd|th)?\b)(?:\.?,?\s(?P<year>\d{{4}})\b)?',
    re.I if lang != 'en' else 0)
    for lang, months in ((lang, '|'.join(DAYS[lang]['months']) + '|' + NUMBERS[lang]['short'].replace(' ', '|'))
                         for lang in NUMBERS)
    for dot in [r'\.?' if lang == 'de' else '']}  # ("7. Oktober")
FIGURE = re.compile(r'(?P<hash>#\s?)?(?P<sign>(?<![\w.,])[-+]|−)?'
                    r'(?P<number>[1-9]\d{0,2}(?:[ \u00a0\u202f]\d{3}(?!\d)){1,4}(?:[.,]\d+)?|\d+(?:[.,]\d+)*)'
                    r'(?:\s?(?P<percent>%)|(?P<ordinal>st|nd|rd|th|ste|de|e)\b)?')


def aloud(text, lang='en'):
    """Every number in the text in words, in the call's language: "€29.95" is "twenty-nine euros ninety-five", "310"
    "three hundred and ten" or "driehonderdtien", "06" "oh six" or "nul zes", "22:00" "ten PM" or "tweeëntwintig
    uur"."""
    lang = lang if lang in NUMBERS else 'en'
    words = NUMBERS[lang]

    def amount(match):
        sign = signed(match['sign_before'] or match['sign_after'] or match['sign'])
        if match['scale']:  # (then the scale, then euros)
            return f"{sign}{scaled(match)} {words['euro'][1]}"
        whole, cents = integer(match['whole']), match['cents']
        if match['decimals']:
            return f"{sign}{decimal(whole, match['decimals'], lang)} {words['euro'][1]}"
        cents = int(cents.ljust(2, '0')) if cents else 0  # (€1,5 is one euro fifty)
        if not whole:
            return sign + (f"{counted(cents, lang)} {words['cent'][cents != 1]}" if cents
                           else f"{number(0, lang)} {words['euro'][1]}")
        spoken_amount = f"{sign}{counted(whole, lang)} {words['euro'][whole != 1]}"
        if cents >= 10:
            return f'{spoken_amount} {number(cents, lang)}'
        return (f"{spoken_amount} {words['and']} {counted(cents, lang)} {words['cent'][cents != 1]}" if cents
                else spoken_amount)

    def euro_range(match):
        second = SECOND_EUROS.match(match.string, match.end())
        if not second or match['cents'] or match['decimals']:  # (cents said without their euros could be anything)
            return match[0]
        if second['whole'] and not integer(second['whole']):  # (cents alone: "from €1 to €0.50")
            return match[0]
        if match['scale'] and not second['scale']:  # (a scale isn't the second's: "€2 million to €500")
            return match[0]
        if second['scale'] and not match['scale'] and (second['euro'] or second['after']):  # ("€500 to €2 million")
            return match[0]
        first_amount = scaled(match) if match['scale'] else counted(integer(match['whole']), lang)
        unit = '' if second['euro'] or second['after'] or second['word'] else '€'  # (its own € or word says the euros)
        return f"{first_amount} {words['to']} {unit}"

    def scaled(match):  # ("one point two five million")
        value, scale = integer(match['number']), SCALES[match['scale'].lower()]
        if value == 1 and not match['point'] and 'single' in words:  # ("eine Million")
            return words['single'][scale]
        return f"{decimal(value, match['point'], lang)} {words['scale'][scale]}"

    def date(match):
        parts = match.groupdict()
        day, month, year_ = (parts.get(f'{part}_') or parts[part] for part in ('day', 'month', 'year'))
        named = not month.isdigit()
        if named:  # (its number)
            month = next(n for n, (full, short) in enumerate(zip(DAYS[lang]['months'], words['short'].split()), 1)
                         if re.fullmatch(f'{full}|{short}', month, re.I))
        day, month = int(day), int(month)
        if not (1 <= day <= 31 and 1 <= month <= 12):
            return match[0]
        name, year_ = DAYS[lang]['months'][month - 1], f' {year(int(year_), lang)}' if year_ else ''
        if lang == 'nl':
            return f'{cardinal(day, lang)} {name}{year_}'
        if lang == 'de':  # ("am siebten Oktober", "der siebte Oktober")
            before = match.string[:match.start()].split()[-1:]
            return f"{ordinal(day, lang)}{'' if before in (['der'], ['Der']) else 'n'} {name}{year_}"
        if named and match['month_']:  # ("October seventh")
            return f'{name} {ordinal(day, lang)}{year_}'
        return f"{parts.get('the') or 'the '}{ordinal(day, lang)} of {name}{year_}"

    def time(match):
        hour, minute, half = int(match['hour']), int(match['minute'] or 0), (match['half'] or '').lower()
        if lang in ('nl', 'de'):  # (the 24-hour clock: "veertien uur dertig", "vierzehn Uhr dreißig")
            hour = hour % 12 + 12 if half == 'p' else hour % 12 if half == 'a' else hour
            minutes = f' {cardinal(minute, lang)}' if minute else ''
            return f"{counted(hour, lang)} {'uur' if lang == 'nl' else 'Uhr'}{minutes}"
        if not half and not minute and not hour:
            return 'midnight'
        # (AM or PM only when the text says so or the hour does: "00:30", "09:00" or "14:05" on the 24-hour clock;
        # "3:30" could be either, so it's "three thirty", and "10:00" "ten o'clock")
        if not half and (hour > 12 or match['hour'][0] == '0'):
            half = 'p' if hour > 12 else 'a'
        minutes = (f' oh {number(minute)}' if minute < 10 else f' {number(minute)}') if minute \
            else '' if half else " o'clock"
        half = f' {half.upper()}M' if half else ''  # (Pocket TTS made "a.m." "aim", "AM" it says)
        return f'{number(hour % 12 or 12)}{minutes}{half}'

    def written(match):
        value = match['number']
        if match['ordinal'] and value.isdigit():
            said = ordinal(int(value), lang)
        elif (re.fullmatch(r'19\d\d|20\d\d', value) and not match['hash'] and not match['sign']
              and not match['percent']):
            said = year(int(value), lang)
        else:
            said = figure(value, lang)
        said = (f"{words['number']} " if match['hash'] else '') + signed(match['sign']) + said \
            + (f" {words['percent']}" if match['percent'] else '')
        before, after = match.string[max(match.start() - 1, 0):match.start()], match.string[match.end():match.end() + 1]
        return (' ' if before.isalpha() else '') + said + (' ' if after.isalpha() else '')  # ("3D", "A4")

    def phone(match):
        groups = [digits(group, lang) for group in re.findall(r'\d+', match[0])]
        return ' '.join([words['plus'], *groups] if match[0].startswith('+') else groups)

    def signed(sign):  # ("minus ", "plus " or nothing)
        return f"{words['plus' if sign == '+' else 'minus']} " if sign else ''

    def code(match):
        parts = match[0].split('-')
        spelt = [not re.search(r'[A-Za-z]{5}', part) for part in parts]  # (a word in it stays a word)
        letter_then_digit = any(spell and re.search(r'[A-Z]\d', part) for spell, part in zip(spelt, parts))
        capitals_with_digit = any(re.fullmatch(r'[A-Z]{1,4}', part) for part in parts) and re.search(r'\d', match[0])
        if not (letter_then_digit or capitals_with_digit):
            return match[0]  # (no code: "COVID-19", "COVID19", "A-team")
        said = one_by_one(parts[0], lang) if spelt[0] else parts[0]
        for before, part, spell in zip(spelt, parts[1:], spelt[1:]):
            pause = words.get('pause', ', ') if before and spell else ' '
            said += pause + (one_by_one(part, lang) if spell else part)
        return said

    def postcode(match):
        letters = match['letters'] or match['apart']
        if not letters.isupper() and letters.lower() in UNITS:  # ("1500km", "1000mL", "1500kW")
            return match[0]
        return f"{digits(match['digits'], lang)} {one_by_one(letters, lang)}"

    text = CODE.sub(code, text)
    text = POSTCODE.sub(postcode, text)
    text = FIGURE_DATE.sub(date, text)
    text = PHONE.sub(phone, text)
    text = EURO_RANGE.sub(euro_range, text)
    text = RANGE.sub(lambda match: f"{match['left']} {words['to']} ", text)
    text = TIME.sub(time, text)
    text = EUROS.sub(amount, text)
    text = WORD_DATE[lang].sub(date, text)
    return FIGURE.sub(written, text)


# Words the speech engines say wrong, written the way they should sound: the company's (brand.yaml speech.respell, per
# language: { en: { Acme: Ak-mee } }), sent with a call's context or read by On Air. Whole words, any case; one
# written with a dash before it is a word's end, the last part of any compound too ("-poster": "geboorteposter").
# What HQ shows and the transcript keep the word as written.
def respelt(text, words):
    """The text with each of words (written: spoken) as it's spoken: "Acme's" is "Ak-mee's"."""
    for written, spoken in words.items():
        start = '' if written.startswith('-') else r'(?<!\w)'
        text = re.sub(rf'{start}{re.escape(written.removeprefix("-"))}(?!\w)', lambda _, said=spoken: said, text,
                      flags=re.I)
    return text


def integer(written):
    """The whole number written with separators: "1.250" and "1 250" are 1250."""
    return int(re.sub(r'\D', '', written))


def number(value, lang='en'):
    """A whole number in words: 29 is "twenty-nine", "negenentwintig" or "neunundzwanzig"."""
    if lang == 'de':
        return german(value)
    words = NUMBERS[lang]
    if value < 20:
        return words['ones'][value]
    if value < 100:
        tens, ones = words['tens'][value // 10 - 2], value % 10
        if not ones:
            return tens
        if lang == 'nl':  # (the ones first: "vijfentwintig", and "tweeëntwintig" after a vowel)
            return words['ones'][ones] + ('ën' if words['ones'][ones].endswith('e') else 'en') + tens
        return f'{tens}-{words["ones"][ones]}'
    if value < 1000:
        hundreds, rest = divmod(value, 100)
        if lang == 'nl':
            return ('' if hundreds == 1 else words['ones'][hundreds]) + 'honderd' + (number(rest, lang) if rest else '')
        return f'{words["ones"][hundreds]} hundred' + (f' and {number(rest, lang)}' if rest else '')
    for scale, size in ((2, 10 ** 9), (1, 10 ** 6), (0, 1000)):
        if value >= size:
            top, rest = divmod(value, size)
            if lang == 'nl' and not scale:  # ("duizend", "tweeduizend")
                head = ('' if top == 1 else number(top, lang)) + 'duizend'
            else:
                head = f'{number(top, lang)} {words["scale"][scale]}'
            if not rest:
                return head
            return f'{head} and {number(rest, lang)}' if lang == 'en' and rest < 100 else f'{head} {number(rest, lang)}'


def german(value):
    """A whole number in German words, under a million as one word: 21 is "einundzwanzig", 101 "hunderteins", 2026
    "zweitausendsechsundzwanzig", 3000000 "drei Millionen"."""
    ones, tens = NUMBERS['de']['ones'], NUMBERS['de']['tens']
    if value < 20:
        return ones[value]
    if value < 100:
        ten, one = divmod(value, 10)
        return (('ein' if one == 1 else ones[one]) + 'und' if one else '') + tens[ten - 2]
    if value < 1000:
        hundreds, rest = divmod(value, 100)
        return ('' if hundreds == 1 else ones[hundreds]) + 'hundert' + (german(rest) if rest else '')
    if value < 10 ** 6:
        thousands, rest = divmod(value, 1000)
        return ('' if thousands == 1 else prefix(thousands)) + 'tausend' + (german(rest) if rest else '')
    for scale, size in ((2, 10 ** 9), (1, 10 ** 6)):
        if value >= size:
            top, rest = divmod(value, size)
            head = NUMBERS['de']['single'][scale] if top == 1 else f"{prefix(top)} {NUMBERS['de']['scale'][scale]}"
            return head + (f' {german(rest)}' if rest else '')


def prefix(value):
    """A German number before "tausend" or "Millionen": its "eins" is "ein" ("einundzwanzigtausend",
    "hunderteintausend")."""
    said = german(value)
    return said[:-1] if said.endswith('eins') else said


def cardinal(value, lang='en'):
    """A number on its own: 1 is "one", "één" (not the article "een") or "eins"."""
    return NUMBERS[lang]['one'] if value == 1 else number(value, lang)


def counted(value, lang='en'):
    """A number that counts something said after it: 1 is "one", "één" or "ein" ("ein Euro")."""
    return NUMBERS[lang]['a'] if value == 1 else number(value, lang)


def decimal(whole, places, lang='en'):
    """A number with its decimals as they're written: "two point five", "nul komma één twee vijf"."""
    return cardinal(whole, lang) + point(places, lang)


def point(places, lang='en'):
    """The decimals: " point one two five", " komma vijf"; nothing without any."""
    return f" {NUMBERS[lang]['point']} " + ' '.join(cardinal(int(digit), lang) for digit in places) if places else ''


def digits(written, lang='en'):
    """One digit at a time: "06" is "oh six" or "nul zes", "31" "three one" or "drie één"."""
    return ' '.join(NUMBERS[lang]['oh'] if digit == '0' else cardinal(int(digit), lang) for digit in written)


def one_by_one(written, lang='en'):
    """A code a letter or digit at a time, a letter by its name: "7Q4K" is "seven Q four K", "zeven kuu vier kaa" or
    "sieben Kuh vier Kah"."""
    names = dict(zip('ABCDEFGHIJKLMNOPQRSTUVWXYZ', NUMBERS[lang]['letters'].split())) if 'letters' in NUMBERS[lang] \
        else {}
    return ' '.join(digits(c, lang) if c.isdigit() else names.get(c.upper(), c.upper()) for c in written)


def ordinal(value, lang='en'):
    """1 is "first", "eerste" or "erste", 21 "twenty-first", "eenentwintigste" or "einundzwanzigste", 100 "one
    hundredth", "honderdste" or "hundertste"."""
    said = number(value, lang)
    if lang == 'de':  # (up to 19 "-te", with four of their own; from 20 "-ste")
        if not 0 < (last := value % 100) < 20:
            return said + 'ste'
        own = {1: 'erste', 3: 'dritte', 7: 'siebte', 8: 'achte'}
        return said[:len(said) - len(NUMBERS['de']['ones'][last])] + own.get(last, NUMBERS['de']['ones'][last] + 'te')
    if lang == 'nl':
        for end, then in (('een', 'eerste'), ('drie', 'derde'), ('acht', 'achtste')):
            if said.endswith(end):
                return said[:-len(end)] + then
        return said + ('ste' if said.endswith(('ig', 'erd', 'end', 'oen', 'ard')) else 'de')
    head, last = re.fullmatch(r'(.*?)(\w+)', said).groups()
    irregular = {'one': 'first', 'two': 'second', 'three': 'third', 'five': 'fifth', 'eight': 'eighth', 'nine': 'ninth',
                 'twelve': 'twelfth'}
    return head + irregular.get(last, last[:-1] + 'ieth' if last.endswith('y') else last + 'th')


def year(value, lang='en'):
    """A year as it's said: 2026 is "twenty twenty-six" or "tweeduizend zesentwintig", 1995 "nineteen ninety-five" or
    "negentienhonderdvijfennegentig", 2005 "two thousand and five"."""
    century, rest = divmod(value, 100)
    if lang in ('nl', 'de'):
        hundred = 'honderd' if lang == 'nl' else 'hundert'
        return f"{number(century, lang)}{hundred}{number(rest, lang) if rest else ''}" if 1100 <= value < 2000 \
            else number(value, lang)
    if not 1100 <= value < 10000 or 2000 <= value < 2010:
        return number(value, lang)
    return f'{number(century)} ' + ('hundred' if not rest else f'oh {number(rest)}' if rest < 10 else number(rest))


def figure(written, lang='en'):
    """A number as it's written: "310", "1,250" (Dutch "1.250"), "2.5" (Dutch "2,5"), a version's "1.2.3"; one with a
    leading zero or of six digits or more ("06", "020", an order reference or a code) a digit at a time."""
    words, thousands = NUMBERS[lang], ',' if lang == 'en' else '.'
    if re.search(r'\s', written):  # (thousands by spaces, "1 250 000", then maybe a decimal point or comma)
        whole, _, places = re.sub(r'\s', '', written).replace(',', '.').partition('.')
        return decimal(int(whole), places, lang)
    whole, *groups = re.split(r'[.,]', written)
    marks = re.findall(r'[.,]', written)
    run = 0  # (thousands: "1,250,000", or "1,250.5"; then at most a decimal one; four at most, as in an amount)
    while run < min(len(groups), 4) and marks[run] == thousands and len(groups[run]) == 3:
        run += 1
    if run and len(whole) <= 3 and whole[0] != '0' and (run == len(groups) or run == len(groups) - 1
                                                         and marks[run] != thousands):
        whole, groups = whole + ''.join(groups[:run]), groups[run:]
    else:  # (a code, however long, is never read as one number: a digit run of thousands would make int() fail)
        whole = digits(whole, lang) if len(whole) >= 6 or len(whole) > 1 and whole[0] == '0' else whole
    whole = cardinal(int(whole), lang) if whole.isdigit() else whole
    if len(groups) > 1:  # (not a number but numbers: "one point two point three")
        return f" {words['dot']} ".join([whole, *(figure(part, lang) for part in groups)])
    return whole + point(groups[0] if groups else '', lang)

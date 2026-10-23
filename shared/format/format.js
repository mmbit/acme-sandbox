// Money, days, counts and lists in a reader's language, on Intl: plain JS, so pages and servers import the same file.
// A company binds it once, in a file of its own, to its languages (each with its locale), its currency and its clock:
// `export const { money, day, ... } = formats({ locales: { en: 'en-GB' }, currency: 'EUR', timeZone: 'UTC' })`. Its
// code imports that file. languages lists the company's, and a language it doesn't list reads as its first.

export function formats({ locales, currency, timeZone }) {
  const fallback = Object.values(locales)[0];
  const localeOf = lang => (Object.hasOwn(locales, lang) ? locales[lang] : fallback);
  const numberFormat = (lang, options) => new Intl.NumberFormat(localeOf(lang), options);

  // An amount in cents, or unit: 'major' for euros/dollars: €26.95, € 26,95, 26,95 € (no-break spaces).
  // wholeWithoutCents: €5, not €5.00. options: Intl's fraction digits and currencyDisplay.
  const money = (amount, lang, { unit = 'cents', wholeWithoutCents = false, ...options } = {}) => {
    const value = unit === 'cents' ? amount / 100 : amount;
    const whole = wholeWithoutCents && value % 1 === 0;
    return numberFormat(lang, { style: 'currency', currency, minimumFractionDigits: whole ? 0 : 2, ...options }).format(
      value,
    );
  };

  // The words for a count in the language's plural form: plural(3, 'en', { one: '{n} clock', other: '{n} clocks' }) is
  // "3 clocks". A form the words leave out (Intl's zero, two, few, many) reads as other.
  const plural = (count, lang, forms) => {
    const form = forms[new Intl.PluralRules(localeOf(lang)).select(count)] ?? forms.other;
    return form.replaceAll('{n}', number(count, lang));
  };

  // A list in words: a, b and c (or: a, b or c)
  const list = (items, lang, { or = false } = {}) =>
    new Intl.ListFormat(localeOf(lang), { type: or ? 'disjunction' : 'conjunction' }).format(items);

  // A two-letter country code in words: the Netherlands, Nederland, Niederlande
  const country = (code, lang) => new Intl.DisplayNames([localeOf(lang)], { type: 'region' }).of(code) ?? code;

  // A number as the language writes it: 1,234.5, 1.234,5. options: Intl.NumberFormat's (maximumFractionDigits, say).
  const number = (value, lang, options = {}) => numberFormat(lang, options).format(value);

  const calendar = {
    ...calendarFormats(localeOf),
    ...clockFormats(localeOf, timeZone),
    ...momentFormats(localeOf, timeZone),
  };
  return { languages: Object.keys(locales), money, ...calendar, plural, list, country, number };
}

// The copies of a thing before its name, the same in every language: "2 × " for two, nothing for one (or no quantity)
/** @param {{ quantity?: number }} line */
export const copiesOf = ({ quantity }) => (quantity > 1 ? `${quantity} × ` : '');

// The days: a company's calendar formats, on its clock
function calendarFormats(localeOf) {
  // a YYYY-MM-DD day at noon UTC, so no reader's clock moves it to the day before or after
  const noon = isoDay => new Date(`${isoDay}T12:00:00Z`);
  const dateFormat = (lang, options) => new Intl.DateTimeFormat(localeOf(lang), { ...options, timeZone: 'UTC' });

  // A YYYY-MM-DD day: 16 October, 16 oktober, 16. Oktober. weekday: Friday 16 October. year: 16 October 2026. short:
  // the weekday and month shortened, Fri 16 Oct. numeric: 16/10/2026, 16-10-2026, 16.10.2026.
  const day = (isoDay, lang, { weekday = false, year = false, short = false, numeric = false } = {}) => {
    const name = short ? 'short' : 'long';
    const parts = numeric
      ? { day: '2-digit', month: '2-digit', year: 'numeric' }
      : { day: 'numeric', month: name, ...(weekday && { weekday: name }), ...(year && { year: 'numeric' }) };
    return dateFormat(lang, parts).format(noon(isoDay));
  };

  // A range of YYYY-MM-DD days, with its month and year shared where Intl can share them.
  const days = (fromIsoDay, toIsoDay, lang) =>
    dateFormat(lang, { day: 'numeric', month: 'short', year: 'numeric' }).formatRange(noon(fromIsoDay), noon(toIsoDay));

  // A YYYY-MM-DD day's weekday: Friday, vrijdag, Freitag. short: Fri, vr, Fr.
  const weekday = (isoDay, lang, { short = false } = {}) =>
    dateFormat(lang, { weekday: short ? 'short' : 'long' }).format(noon(isoDay));

  // A YYYY-MM month (or a day in it): October, oktober, Oktober. year: October 2026.
  const month = (isoMonth, lang, { year = false } = {}) =>
    dateFormat(lang, { month: 'long', ...(year && { year: 'numeric' }) }).format(noon(`${isoMonth.slice(0, 7)}-15`));

  return { day, days, weekday, month };
}

// The moments: the day, hour and time of day at one, on the company's clock
function clockFormats(localeOf, timeZone) {
  // en-CA writes a day as YYYY-MM-DD
  const isoDayFormat = new Intl.DateTimeFormat('en-CA', { timeZone });
  // the hour and minute, 0 to 23 and 0 to 59
  const timeFormat = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  });

  // The day it is at a moment on the company's clock, as YYYY-MM-DD
  const dayAt = ms => isoDayFormat.format(ms);
  const today = () => dayAt(Date.now());
  // The hour it is at a moment on the company's clock, from 0 up to 24, its minutes as a fraction: 14.5 at half past two
  const hourAt = ms => {
    const part = type => Number(timeFormat.formatToParts(ms).find(p => p.type === type).value);
    return part('hour') + part('minute') / 60;
  };

  return { dayAt, today, hourAt };
}

// The moments written out: the time of day, and the day and time, on the company's clock
function momentFormats(localeOf, timeZone) {
  // A moment's time of day on the binding's clock: 14:05, 02:05 PM. One formatter per locale and zone label, kept:
  // making one takes ~0.2 ms, and a transcript times every line.
  const timeFormats = new Map();
  // timeZoneName: Intl's zone label, when the reader needs to distinguish this clock from their device's.
  const time = (ms, lang, { timeZoneName } = {}) => {
    const locale = localeOf(lang),
      key = `${locale} ${timeZoneName ?? ''}`;
    if (!timeFormats.has(key))
      timeFormats.set(
        key,
        new Intl.DateTimeFormat(locale, {
          hour: '2-digit',
          minute: '2-digit',
          timeZone,
          ...(timeZoneName && { timeZoneName }),
        }),
      );
    return timeFormats.get(key).format(ms);
  };

  // A moment's day and time of day on the binding's clock: 23 October at 14:00, 23 oktober om 14:00. short: the month
  // shortened, 23 Oct, 14:00.
  const dayTimeFormats = new Map();
  const moment = (ms, lang, { short = false } = {}) => {
    const locale = localeOf(lang),
      key = `${locale} ${short}`;
    if (!dayTimeFormats.has(key)) {
      const parts = { day: 'numeric', month: short ? 'short' : 'long', hour: '2-digit', minute: '2-digit', timeZone };
      dayTimeFormats.set(key, new Intl.DateTimeFormat(locale, parts));
    }
    return dayTimeFormats.get(key).format(ms);
  };

  return { time, moment };
}

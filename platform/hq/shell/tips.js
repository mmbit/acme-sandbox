// The feature tips: one entry per hidden feature, read by the coordinator (tips.ts files its card when its event
// first happens) and by the desk phone (the card, and Show me's steps). A new feature adds its tip here. Its film is the
// company's, theme/hq/films/<key>-<look>.mp4 (tip-films.mjs records it from films/scenes.mjs): a tip without one shows
// as text only (tipcard.js filmOf).
//   key     the tip's name, kept in the coordinator's tips table (once per company)
//   when    the event that brings it, as HQ records it (the coordinator's hook names the same key)
//   name    what the Library's manual calls it, a few words (manual.js).
//   title   in the board's words
//   lines   what it does for the board now, two lines; given the event's details, or none (the Library's manual)
//   opens   where Show me opens HQ before its steps, when the control sits deeper than three presses: a computer app and
//           its options (desk.js openComputer)
//   steps   Show me: one to three controls, each a CSS selector (or a function finding it, given the event's details)
//           and what to say beside it. Pressing one goes on to the next, and pressing the last ends the tip
//   about   a tip about the desk phone's cards: which card has its steps' controls. Show me keeps the phone open on the
//           first such card, and a tip with none has no Show me
//   acts    the last control acts for real: its step says what it does, and Got it ends the tip without pressing it

const DESKTOP = { at: '#btn-computer', say: 'Open your desktop' },
  SETTINGS = { at: '#tool [data-app="settings"]', say: 'Then Settings' };
const section = (id, say) => ({ at: `#tool [data-section="${id}"]`, say });
// A control in the share the tip is about (Reviews › Shared)
// (from the Library's manual, with no event: the first share.)
const inShare =
  control =>
  ({ share }) =>
    document.querySelector(`#tool section.share${share ? `[data-share="${share}"]` : ''} ${control}`);
// HQ's own pin, inside review mode's closed layer (shared/review): the tool hands it over when asked
const pin = () => {
  const ask = new CustomEvent('review:pin', { detail: {} });
  dispatchEvent(ask);
  return ask.detail.pin ?? null;
};

export const TIPS = [
  {
    key: 'artifact',
    name: 'Share for notes',
    when: 'the first artifact comes in',
    title: 'Your first artifact is in: share it for notes',
    lines: () =>
      'Invite anyone to leave notes on it, each on a link of their own. When everyone has sent theirs, the notes come back to you as a deck.',
    opens: { app: 'artifacts' },
    steps: [
      { at: '#tool .applist a.open', say: 'Open your artifact' },
      { at: '#viewer .bar .share', say: 'Share it for notes' },
      { at: '#viewer .sharebox form.invite', say: 'Invite someone by their name and email' },
    ],
  },
  {
    key: 'endnow',
    name: 'End now',
    when: 'the first share with one person still to send',
    title: 'One person still has notes to send',
    lines: ({ waiting } = {}) =>
      `The notes come to you as a deck once everyone has sent theirs. ${waiting ? `${waiting} hasn’t yet. ` : ''}End now sends you the deck with what’s in.`,
    opens: { app: 'notes', shown: 'shared' },
    steps: [
      { at: inShare('summary'), say: 'Open the share' },
      {
        at: inShare('[data-end]'),
        say: 'End now sends you the deck with what’s in. It asks once more, and nobody can send notes after.',
      },
    ],
    acts: true,
  },
  {
    key: 'machines',
    name: 'Connect a computer',
    when: 'the first run that has waited half an hour for the server',
    title: 'A long run is waiting for the server',
    lines: ({ run, minutes } = {}) =>
      `${run && minutes ? `${run} has waited ${minutes} minutes. ` : ''}You can connect another computer to move work off the server. It needs Docker installed, and Settings › Machines shows you how.`,
    steps: [DESKTOP, SETTINGS, section('sys:machines', 'Machines: add a computer here')],
  },
  {
    key: 'deskphone',
    name: 'The desk phone',
    when: 'the first card that needs an answer',
    title: 'Cards wait here until you answer',
    lines: () =>
      'Nothing goes on without your answer, and only an urgent card rings. Later puts a card aside until a day you pick. Answered keeps all you’ve said.',
    about: () => true,
    steps: [
      { at: '#tool [data-later]', say: 'Later puts this card aside until a day you pick' },
      { at: '#tool [data-past]', say: 'Answered keeps every card you’ve answered' },
    ],
  },
  {
    key: 'look',
    name: 'Change the look',
    when: 'the first press of the logo, or the seventh day',
    title: 'HQ can look the way you like',
    lines: ({ pressed } = {}) =>
      `${pressed ? 'You pressed the logo. ' : ''}Settings › Look shows every look HQ has, each in its colours. Each switches at once, and switches back as easily.`,
    steps: [DESKTOP, SETTINGS, section('sys:look', 'Look: pick one, and it changes at once')],
  },
  {
    key: 'pin',
    name: 'Pin a note',
    when: 'the first picture the board pastes on the intercom',
    title: 'Pin a note right on HQ',
    lines: () =>
      'Instead of a screenshot, you can pin a note on the part of HQ it’s about, and it stays where you put it. The red pin in HQ’s corner does it.',
    steps: [{ at: pin, say: 'Press the pin, then tap where your note goes' }],
  },
  {
    key: 'notifications',
    name: 'Notifications',
    when: 'the first urgent card, on a device without notifications',
    title: 'Let urgent cards reach you',
    // (no event: the Library's manual.)
    lines: event =>
      `${event ? 'An urgent card just came in. With notifications on, this device rings when one does' : 'With notifications on, this device rings when an urgent card comes in'}, even with HQ closed. Settings › Notifications turns them on.`,
    steps: [DESKTOP, SETTINGS, section('sys:alerts', 'Notifications: turn them on for this device')],
  },
  {
    key: 'calls',
    name: 'Calls',
    when: 'the first day three cards wait at once',
    title: 'Three cards are waiting: talk them through',
    lines: () =>
      'You can call whoever sent a card and say your answer instead of typing it. The call is on each card that has someone to call.',
    about: card => !!card.agent && card.kind !== 'login', // (the card's Call, desk.js)
    steps: [{ at: '#tool #call-about', say: 'Call them and talk it through' }],
  },
  {
    key: 'pausing',
    name: 'Pausing work',
    when: 'the first thread to run past its window',
    title: 'Some work ran past its time',
    lines: ({ thread } = {}) =>
      `${thread ? `${thread} ran past the time it was due. ` : ''}You can have work paused to make room for what matters more, and started again when you like: ask on the intercom. Projects shows what’s running.`,
    steps: [
      { at: '#btn-projects', say: 'Projects shows all the work' },
      { at: '#btn-intercom', say: 'Ask here to pause it, or to start it again' },
    ],
  },
  {
    key: 'seats',
    name: 'Seats',
    when: 'the first seat past 80% of its week',
    title: 'A seat has used most of its week',
    lines: ({ seat } = {}) =>
      `${seat ? `${seat} has used 80% of its week. ` : ''}When a seat runs out, its work waits. Settings › Seats shows each one, and can warn you before one runs low.`,
    steps: [DESKTOP, SETTINGS, section('sys:seats', 'Seats: each one, and the warning before it runs low')],
  },
  {
    key: 'asking',
    name: 'Asking for anything',
    when: 'the first full day with nothing new asked on the intercom',
    title: 'You can ask for anything',
    lines: () =>
      'Ask on the intercom in your own words, a routine, a hire, a brand guide, an app or a website, and it gets set up.',
    steps: [{ at: '#btn-intercom', say: 'Ask here, in your own words' }],
  },
];

// What the board can ask for, as keys that start its sentence on the intercom: the Library's manual, and the intake's
// last question.
export const ASKS = [
  { key: 'Set up a routine…', starts: 'Set up a routine that ' },
  { key: 'Hire someone…', starts: 'Hire someone who ' },
  { key: 'A brand guide…', starts: 'Make us a brand guide for ' },
  { key: 'Build an app…', starts: 'Build an app that ' },
  { key: 'A website…', starts: 'Make a website for ' },
  { key: 'Product photos…', starts: 'Take product photos of ' },
];

export const tipOf = key => TIPS.find(t => t.key === key) ?? null;

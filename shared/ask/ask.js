// A button that asks once more before it acts, in the page's own spot and words, never in the browser's dialogs.
// The first tap arms it: its label becomes `again` ("Tap again to cancel") and `question` shows in `status`, a live
// region the page places near the button. The next tap acts. It also drops back by itself after LAPSE_MS. Import it by
// its path in the repo (from a product's app/public/, '../../../../shared/ask/ask.js'); HQ serves it at /ask.js.

// A tap this soon after arming is the same gesture's (a double tap, a double click), so the question always gets read.
const SETTLE_MS = 500;
const LAPSE_MS = 8_000;

// label, again, question: strings, or functions read each time they show, so they're in the page's current language.
// act: the action, once per confirmed tap. asks: whether a tap asks first now (some states act at once). status keeps
// whatever the page writes into it meanwhile. steady: the button keeps the width of the wider of its two labels, so
// asking moves nothing beside it (a row of buttons that would wrap): it draws its label at once.
// → { show, disarm, armed }: show() draws the words again (call it when the page repaints the button's own label),
// disarm() drops back, armed tells whether the next tap acts
export function askAgain(button, { status, label, again, question, act, asks = () => true, steady = false }) {
  let armedAt = null;
  let lapseTimer;
  let watching;
  let asked = null; // the question as status shows it, and whether status was hidden before
  if (!status.getAttribute('role')) status.setAttribute('role', 'status');
  const show = () => {
    if (steady) holdWidest(button, [label, again]);
    button.textContent = words(armedAt === null ? label : again);
    if (armedAt === null) return;
    asked ??= { hidden: status.hidden };
    asked.text = status.textContent = words(question);
    status.hidden = false;
  };
  const disarm = () => {
    if (armedAt === null) return;
    armedAt = null;
    clearTimeout(lapseTimer);
    watching.abort();
    if (status.textContent === asked.text) {
      status.textContent = '';
      status.hidden = asked.hidden;
    }
    asked = null;
    show();
  };
  const watch = dropBack(button, disarm);
  button.addEventListener('click', () => {
    if (armedAt === null && asks()) {
      armedAt = performance.now();
      lapseTimer = setTimeout(disarm, LAPSE_MS);
      watching = watch();
      show();
    } else if (armedAt === null || performance.now() - armedAt >= SETTLE_MS) {
      disarm();
      act();
    }
  });
  if (steady) show();
  return {
    show,
    disarm,
    get armed() {
      return armedAt !== null;
    },
  };
}

const words = w => (typeof w === 'function' ? w() : w);

// Measured where it stands, each label in turn, border and padding in.
function holdWidest(button, labels) {
  button.style.boxSizing = 'border-box';
  button.style.minWidth = '';
  const widths = labels.map(w => {
    button.textContent = words(w);
    return button.getBoundingClientRect().width;
  });
  button.style.minWidth = `${Math.ceil(Math.max(...widths))}px`;
}

// It drops back on Tab away, when the page hides or disables the button (the action is no longer possible, or another
// has started), and on a tap elsewhere while watched. That one waits for its click, once the browser has picked what
// was tapped: before (on the press, or the blur a press brings) the label and the question would move the page under
// the finger. The blur and hide listeners stay for good; the document ones are added at each arming.
// → watch(), which adds those and returns the AbortController that stops them
function dropBack(button, disarm) {
  let pressing = false;
  const elsewhere = event => {
    pressing = false;
    if (!button.contains(event.target)) disarm();
  };
  button.addEventListener('blur', () => pressing || disarm());
  new MutationObserver(() => (button.hidden || button.disabled) && disarm()).observe(button, {
    attributeFilter: ['hidden', 'disabled'],
  });
  return () => {
    const watching = new AbortController();
    const listening = { capture: true, signal: watching.signal };
    pressing = false;
    document.addEventListener('pointerdown', () => (pressing = true), listening);
    document.addEventListener('click', elsewhere, listening);
    return watching;
  };
}

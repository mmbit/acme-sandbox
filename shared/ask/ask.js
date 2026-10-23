// A button that asks once more before it acts, in the page's own spot and words, never in the browser's dialogs
// (CODE_STYLE.md). The first tap arms it: its label becomes `again` ("Tap again to cancel") and `question` shows in
// `status`, a live region (role="status") the page places near the button. The next tap acts. A tap within SETTLE_MS of
// arming is the same gesture's (a double tap, a double click), so the question always gets read. It drops back by
// itself after LAPSE_MS, on a tap anywhere else on the page (a language switch too), on Tab away, and when the page
// hides or disables the button: the action is no longer possible, or another one has started.
// Import it by its path in the repo (from a product's app/public/, '../../../../shared/ask/ask.js'); HQ serves it at
// /ask.js.

const SETTLE_MS = 500;
const LAPSE_MS = 8_000;

// label, again, question: strings, or functions read each time they show, so they're in the page's current language.
// act: the action, once per confirmed tap. asks: whether a tap asks first now (some states act at once). status keeps
// whatever the page writes into it meanwhile. steady: the button keeps the width of the wider of its two labels, so
// asking moves nothing beside it (a row of buttons that would wrap): it draws its label at once.
// → { show, disarm, armed }: show() draws the words again (call it when the page repaints the button's own label),
// disarm() drops back, armed tells whether the next tap acts
export function askAgain(button, { status, label, again, question, act, asks = () => true, steady = false }) {
  const words = w => (typeof w === 'function' ? w() : w);
  let armedAt = null;
  let lapseTimer;
  let asked = null; // the question as status shows it, and whether status was hidden before
  if (!status.getAttribute('role')) status.setAttribute('role', 'status');
  // (measured where it stands, each label in turn, border and padding in)
  const hold = () => {
    button.style.boxSizing = 'border-box';
    button.style.minWidth = '';
    const widths = [label, again].map(w => {
      button.textContent = words(w);
      return button.getBoundingClientRect().width;
    });
    button.style.minWidth = `${Math.ceil(Math.max(...widths))}px`;
  };
  const show = () => {
    if (steady) hold();
    button.textContent = words(armedAt === null ? label : again);
    if (armedAt === null) return;
    asked ??= { hidden: status.hidden };
    asked.text = status.textContent = words(question);
    status.hidden = false;
  };
  // A tap elsewhere drops it back on its click, once the browser has picked what was tapped: before (on the press, or
  // the blur a press brings) the label and the question would move the page under the finger. Tab away drops it back
  // at once.
  let pressing = false;
  const press = () => (pressing = true);
  const elsewhere = event => {
    pressing = false;
    if (!button.contains(event.target)) disarm();
  };
  const disarm = () => {
    if (armedAt === null) return;
    armedAt = null;
    clearTimeout(lapseTimer);
    document.removeEventListener('pointerdown', press, true);
    document.removeEventListener('click', elsewhere, true);
    if (status.textContent === asked.text) {
      status.textContent = '';
      status.hidden = asked.hidden;
    }
    asked = null;
    show();
  };
  button.addEventListener('click', () => {
    if (armedAt === null && asks()) {
      armedAt = performance.now();
      lapseTimer = setTimeout(disarm, LAPSE_MS);
      pressing = false;
      document.addEventListener('pointerdown', press, true);
      document.addEventListener('click', elsewhere, true);
      show();
    } else if (armedAt === null || performance.now() - armedAt >= SETTLE_MS) {
      disarm();
      act();
    }
  });
  button.addEventListener('blur', () => pressing || disarm());
  new MutationObserver(() => (button.hidden || button.disabled) && disarm()).observe(button, {
    attributeFilter: ['hidden', 'disabled'],
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

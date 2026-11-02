// The system's own Undo and Redo reaching a page's own undo (README.md, "The system's Undo").
export function systemUndo(page, { focused = false } = {}) {
  const el = document.createElement('div');
  Object.assign(el, { contentEditable: 'true', inputMode: 'none', tabIndex: -1, className: 'system-undo' });
  el.setAttribute('aria-hidden', 'true');
  // (laid out, as an element hidden from the layout takes no focus: one pixel, unseen, under nothing that's pressed)
  el.style.cssText =
    'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;white-space:pre';
  document.body.append(el);
  const state = { armed: false, applying: false };
  const stopping = new AbortController();
  el.addEventListener('input', e => heardOn(e, el, state, page, focused), { signal: stopping.signal });
  // another edit on the page has the top of the browser's history and drops its redo: arm again at the next touch
  addEventListener(
    'input',
    e => {
      if (e.target !== el) state.armed = false;
    },
    { capture: true, signal: stopping.signal },
  );
  const arm = () => {
    if (state.armed) {
      if (focused) el.focus({ preventScroll: true });
      return;
    }
    const focusedBefore = document.activeElement;
    const lengthBefore = el.textContent.length;
    el.focus({ preventScroll: true });
    step(el, state);
    step(el, state);
    run(state, 'undo');
    state.armed = el.textContent.length === lengthBefore + 1;
    if (!focused) giveBack(el, focusedBefore);
  };
  const stop = () => {
    stopping.abort();
    el.remove();
  };
  return { arm, armed: () => state.armed, stop };
}

// The browser undid (or redid) a hidden step: the page's own undo (or redo) instead, and the step put back
function heardOn(e, el, state, page, focused) {
  if (state.applying) return;
  const undo = e.inputType === 'historyUndo';
  if (!undo && e.inputType !== 'historyRedo') {
    // (keys typed into it: taken back)
    run(state, 'undo');
    return;
  }
  (undo ? page.undo : page.redo)();
  // (not inside the browser's own undo, which is still applying)
  setTimeout(() => {
    const focusedBefore = document.activeElement;
    run(state, undo ? 'redo' : 'undo');
    if (!focused) giveBack(el, focusedBefore);
  });
}

// One step of the browser's history: a character typed at the end, the caret moved first so it's a step of its own
function step(el, state) {
  getSelection().selectAllChildren(el);
  getSelection().collapseToEnd();
  run(state, 'insertText', '·');
}
// An edit of the hidden steps' own, never taken for the system's
function run(state, command, text) {
  state.applying = true;
  try {
    document.execCommand(command, false, text);
  } finally {
    state.applying = false;
  }
}
// The focus back where it was before a hidden step took it
function giveBack(el, focusedBefore) {
  el.blur();
  if (focusedBefore && focusedBefore !== el && focusedBefore !== document.body)
    focusedBefore.focus({ preventScroll: true });
}

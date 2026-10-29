// What review mode's parts ask of the parts above them: put the note away (reset), the pin pressed (toggle), the menu
// shut or painted again and the open note's lines. A part imports these from here, never from the part that does them;
// tool.js, which puts the parts together, hands each one in as it loads (hand). So the imports run one way, tool.js ->
// the parts -> this, which imports none of them, and form no circle.
const doers = {};
export const hand = acts => void Object.assign(doers, acts);

// (tool.js)
export const reset = r => doers.reset(r);
export const toggle = r => doers.toggle(r);
// (menu.js)
export const shut = r => doers.shut(r);
export const paint = r => doers.paint(r);
export const refresh = r => doers.refresh(r);
// (surface.js)
export const redrawInk = r => doers.redrawInk(r);
// (dictation.js: for hqmic.js, its part in HQ's viewer.)
export const stopMic = r => doers.stopMic(r);
export const words = (r, rec, heard) => doers.words(r, rec, heard);

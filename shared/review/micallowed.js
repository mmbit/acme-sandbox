// Whether the microphone is already allowed on this page, so a hold may start it without the browser asking: only a
// tap on a mic asks. One state for every recorder on the page (HQ's voice.js and review mode's dictation.js, which HQ
// loads from /__review/, both import it): the browser's own answer, followed as it changes, and allowed once any of
// them gets a stream.
let allowed = false;
navigator.permissions?.query({ name: 'microphone' }).then(
  p => {
    allowed ||= p.state === 'granted';
    p.onchange = () => (allowed = p.state === 'granted');
  },
  () => {}, // (a browser that doesn't know the 'microphone' permission rejects: then only a stream got here tells)
);
export const micAllowed = () => allowed;
export const gotStream = () => (allowed = true);

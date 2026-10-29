// Whether the microphone is already allowed on this page, so a hold may start it without the browser asking: only a
// tap on a mic asks. One state for every recorder on the page (HQ's voice.js and review mode's dictation.js, which HQ
// loads from /__review/, both import it): the browser's own answer, followed as it changes, and allowed once any of
// them gets a stream. And whether the board has blocked it, so a hold says so
// rather than asking for a tap that can't help.
let allowed = false,
  blocked = false;
navigator.permissions?.query({ name: 'microphone' }).then(
  p => {
    allowed ||= p.state === 'granted';
    blocked = p.state === 'denied';
    p.onchange = () => {
      allowed = p.state === 'granted';
      blocked = p.state === 'denied';
    };
  },
  () => {}, // (a browser that doesn't know the 'microphone' permission rejects: then only a stream got here tells)
);
export const micAllowed = () => allowed;
export const micBlocked = () => blocked;
export const gotStream = () => (allowed = true);

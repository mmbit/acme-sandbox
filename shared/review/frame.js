// A note's screenshot, framed on what the board marked: review mode's polaroid (review.js) and HQ's note thumbnails
// (desk.js) both show it this way. The coordinator serves this file at /__review/frame.js on every host.

const STROKE = 5; // the circle's ink and the pin's outline reach this far past the mark
const PIN_ABOVE = 32; // the pin's head stands up to 32 px above the pinned element...
const PIN_RIGHT = 22; // ...and 22 px right of it
const MOST_OVERFLOW = 1.5; // a frame beyond 1.5 times the screenshot would show it as a sliver

// The frame holds the circle, or the pinned element and the pin's head, with a margin, in the preview's shape (`aspect`,
// width / height), and stays inside the screenshot where it fits. A mark bigger than the preview is shown whole, scaled
// down. The screenshot is the viewport, so the mark's client coordinates are also its coordinates in the picture.
// Returns the img's width, height, left and top as percentages of the preview, or null when the mark can't be placed
// or a pin is on something about as big as the page (a section): the preview then keeps its stylesheet's crop.
export function frameMark(element, viewport, aspect) {
  const mark = element?.area ?? element?.rect;
  const viewportWidth = +viewport?.w;
  const viewportHeight = +viewport?.h;
  if (!mark || !(viewportWidth > 0 && viewportHeight > 0)) return null;
  const isPin = element.kind !== 'circle';
  const left = Math.max(0, mark.x - STROKE);
  const right = Math.min(viewportWidth, mark.x + mark.w + (isPin ? PIN_RIGHT : STROKE));
  const top = Math.max(0, mark.y - (isPin ? PIN_ABOVE : STROKE));
  const bottom = Math.min(viewportHeight, mark.y + mark.h + STROKE);
  if (!(right > left && bottom > top)) return null;
  const margin = Math.max(16, 0.15 * Math.max(right - left, bottom - top));
  let frameWidth = right - left + 2 * margin;
  let frameHeight = bottom - top + 2 * margin;
  if (frameWidth / frameHeight < aspect) frameWidth = frameHeight * aspect;
  else frameHeight = frameWidth / aspect;
  if (isPin && (frameWidth > MOST_OVERFLOW * viewportWidth || frameHeight > MOST_OVERFLOW * viewportHeight))
    return null;
  const frameStart = (center, frameSize, viewportSize) =>
    frameSize < viewportSize
      ? Math.min(Math.max(center - frameSize / 2, 0), viewportSize - frameSize)
      : (viewportSize - frameSize) / 2;
  const frameLeft = frameStart((left + right) / 2, frameWidth, viewportWidth);
  const frameTop = frameStart((top + bottom) / 2, frameHeight, viewportHeight);
  const percent = n => `${+n.toFixed(2)}%`;
  return {
    width: percent((100 * viewportWidth) / frameWidth),
    height: percent((100 * viewportHeight) / frameHeight),
    left: percent((-100 * frameLeft) / frameWidth),
    top: percent((-100 * frameTop) / frameHeight),
  };
}

// Review mode's menu lines that wrap, for the checks. Run in the page with an open
// shadow root, the menu open: page.evaluate(wrappedMenuLines). The caption and each shown item's title and sub-line are
// each meant to fit on one line in the menu's width, a phone's too.
export async function wrappedMenuLines() {
  const menu = document.querySelector('review-mode').shadowRoot.querySelector('.menu');
  // (once it has popped in: scaled down, two lines can round to one)
  await Promise.all(menu.getAnimations().map(a => a.finished));
  const items = [...menu.querySelectorAll('.items button:not([hidden])')];
  const lines = [menu.querySelector('.cap'), ...items.flatMap(b => [b.firstChild, b.querySelector('small')])];
  const lineCount = node => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return new Set([...range.getClientRects()].map(r => Math.round(r.bottom))).size;
  };
  return lines.filter(node => lineCount(node) > 1).map(node => node.textContent);
}

// One HTML escaper for a server that writes words into a page's markup (text or a quoted attribute value).

/** text as HTML: & < > and " escaped, safe in an element's text and in a double-quoted attribute */
export const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

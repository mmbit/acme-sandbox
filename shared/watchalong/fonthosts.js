// The two hosts of Google Fonts: its stylesheets of fonts and its font files. HQ's policy takes fonts from them
// (platform/coordinator/src/server.ts), the recorder keeps a link to one of its stylesheets whole (watchalong.js), and
// the mirror's owner fetches them for the replay (platform/coordinator/src/webfonts.ts).
export const STYLESHEETS = 'fonts.googleapis.com',
  FONT_FILES = 'fonts.gstatic.com';

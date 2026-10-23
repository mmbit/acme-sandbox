// The company's brand and HQ theme: the foundation's defaults, with what GET /api/brand loads laid over them before
// any module that imports this one runs (so a name in a module's own constants is the company's too).
// A name is written as it reads mid-sentence ("New in the newsletter", "the desk phone"): cap() starts a sentence
// or a heading with it. The short ones label a button or a shelf.
import { loadBrand } from './data.js';

export const names = {
  hq: 'HQ', os: 'Desktop', newsletter: 'the newsletter', newsletterShort: 'News', library: 'the library', libraryShort: 'Library',
  phone: 'desk phone', phoneShort: 'Phone', intercom: 'intercom', computer: 'computer',
};
export const brand = { name: 'Company', names };
export const theme = { renderer: 'wire' }; // (the plain look, without a theme)
// The platform's services the company runs, as the coordinator says (GET /api/brand's care: the care service; studio:
// the photo studio)
export const runs = { care: false, studio: false };

// Each name is plain text, escaped where it goes into HTML (an & is fine): one that looks like markup keeps its default.
const plain = v => typeof v === 'string' && /^[^<>"]+$/.test(v);
const loaded = await loadBrand(), { name, names: named = {}, ...rest } = loaded.brand;
for (const [k, v] of Object.entries({ name, ...named })) {
  if (plain(v)) (k === 'name' ? brand : names)[k] = v;
  else if (v !== undefined) console.warn(`[hq] brand.yaml: ${k} isn't plain text, so HQ uses its default`);
}
Object.assign(brand, rest);
brand.logo = { alt: brand.name, ...brand.logo };
brand.app = { title: `${brand.name} ${names.hq}`, description: `The ${brand.name} office building, live: see what every agent is up to.`, ...brand.app };
Object.assign(theme, loaded.theme);
// The company's own stylesheets over every look (theme/hq.yaml styles: a kit's files HQ serves, /kits/<kit>/<file>.css),
// after the shell's and before any skin: its depth scale, say
for (const href of theme.styles ?? [])
  document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href }));
runs.care = loaded.care === true;
runs.studio = loaded.studio === true;

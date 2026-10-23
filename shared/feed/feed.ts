// Product feeds for shopping search, from one list of items: Google Merchant Center's XML (RSS 2.0 with its g:
// attributes, which Merchant Center fetches from an address) and OpenAI's product feed for ChatGPT's shopping answers
// (JSON Lines, uploaded). An app builds the items from its own catalogue and serves both, so a price or a title can't
// differ between them (products/front/README.md, "The product feed", has the specs it follows).

// an amount in the currency's smallest unit (cents for EUR) and its ISO 4217 code
export type Money = { amount: number; currency: string };
export type Availability = 'in_stock' | 'out_of_stock' | 'preorder' | 'backorder';
// Delivery to one country. Days are working days: handling until the parcel leaves, then transit to the door.
export type Shipping = { country: string; price: Money; handlingDays: [number, number]; transitDays: [number, number] };
export type FeedItem = {
  id: string; // stable: the same thing keeps it in every language and every update
  title: string;
  description: string;
  // the title and description were written by generative AI: Google wants them labelled so (structured_title)
  aiWritten?: boolean;
  link: string; // the page that sells it
  image: string;
  moreImages?: string[];
  price: Money; // the regular price, or the one charged today when no earlier price may be shown
  // an offer under that price: today's price and its first and last moment (ISO 8601 with its UTC offset)
  sale?: { price: Money; from: string; until: string };
  availability: Availability;
  brand: string;
  gtin?: string; // without one, the item says it has no identifier (made to order)
  condition?: 'new' | 'refurbished' | 'used';
  googleCategory?: number; // an id from Google's product taxonomy
  productType?: string[]; // the shop's own path to it, broad to narrow
  // A thing sold in several versions: the group's id and what sets this one apart ({ pack: '32 cards' }). Google
  // groups only by its own variant attributes (GOOGLE_VARIANTS), so other options stay in the title for Google.
  group?: { id: string; options: Record<string, string> };
  shipping: Shipping[];
};
export type Seller = {
  name: string;
  url: string;
  privacyPolicy?: string;
  terms?: string;
  returnPolicy?: string;
  acceptsReturns?: boolean;
};

const TITLE_MAX = 150;
const DESCRIPTION_MAX = 5000;
const ID_MAX = 50;
const IMAGES_MAX = 10;
const GOOGLE_VARIANTS = ['color', 'size', 'pattern', 'material', 'age_group', 'gender'];

// ---- Google Merchant Center

export function googleXml(seller: Seller, items: FeedItem[]) {
  const channel = [tag('title', seller.name), tag('link', seller.url), tag('description', seller.name)];
  const body = items.map(item => `<item>\n${googleFields(checked(item)).join('\n')}\n</item>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
<channel>
${channel.join('\n')}
${body.join('\n')}
</channel>
</rss>
`;
}

function googleFields(item: FeedItem) {
  const fields = [
    g('id', item.id),
    ...(item.aiWritten
      ? [aiWritten('structured_title', item.title), aiWritten('structured_description', item.description)]
      : [g('title', item.title), g('description', item.description)]),
    g('link', item.link),
    g('image_link', item.image),
    ...(item.moreImages ?? []).slice(0, IMAGES_MAX).map(url => g('additional_image_link', url)),
    g('availability', item.availability),
    g('price', money(item.price)),
  ];
  if (item.sale) {
    fields.push(g('sale_price', money(item.sale.price)));
    fields.push(g('sale_price_effective_date', `${item.sale.from}/${item.sale.until}`));
  }
  fields.push(g('brand', item.brand));
  fields.push(item.gtin ? g('gtin', item.gtin) : g('identifier_exists', 'no'));
  fields.push(g('condition', item.condition ?? 'new'));
  if (item.googleCategory) fields.push(g('google_product_category', String(item.googleCategory)));
  if (item.productType) fields.push(g('product_type', item.productType.join(' > ')));
  const options = Object.entries(item.group?.options ?? {});
  if (item.group && options.every(([name]) => GOOGLE_VARIANTS.includes(name))) {
    fields.push(g('item_group_id', item.group.id));
    for (const [name, value] of options) fields.push(g(name, value));
  }
  for (const route of item.shipping) fields.push(googleShipping(route));
  return fields;
}

function googleShipping(route: Shipping) {
  const parts = [
    tag('g:country', route.country),
    tag('g:price', money(route.price)),
    tag('g:min_handling_time', String(route.handlingDays[0])),
    tag('g:max_handling_time', String(route.handlingDays[1])),
    tag('g:min_transit_time', String(route.transitDays[0])),
    tag('g:max_transit_time', String(route.transitDays[1])),
  ];
  return `<g:shipping>${parts.join('')}</g:shipping>`;
}

// text written by generative AI, in Google's structured form that says so
const aiWritten = (name: string, text: string) =>
  `<g:${name}>${g('digital_source_type', 'trained_algorithmic_media')}${g('content', text)}</g:${name}>`;
const g = (name: string, value: string) => tag(`g:${name}`, value);
const tag = (name: string, value: string) => `<${name}>${escapeXml(value)}</${name}>`;
const XML_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const escapeXml = (text: string) => text.replace(/[&<>"']/g, ch => XML_ENTITIES[ch]);

// ---- OpenAI (ChatGPT's shopping answers)

export function openaiJsonl(seller: Seller, items: FeedItem[]) {
  return items.map(item => JSON.stringify(openaiRecord(seller, checked(item))) + '\n').join('');
}

function openaiRecord(seller: Seller, item: FeedItem) {
  const record: Record<string, unknown> = {
    item_id: item.id,
    title: item.title,
    description: item.description,
    url: item.link,
    brand: item.brand,
    seller_name: seller.name,
    image_url: item.image,
    availability: item.availability === 'preorder' ? 'pre_order' : item.availability,
    price: money(item.price),
    condition: item.condition ?? 'new',
    seller_url: seller.url,
  };
  if (item.sale) record.sale_price = money(item.sale.price);
  if (item.moreImages?.length) record.additional_image_urls = item.moreImages.slice(0, IMAGES_MAX);
  if (item.gtin) record.gtin = item.gtin;
  if (item.productType) record.product_category = item.productType.join(' > ');
  if (item.group) {
    record.group_id = item.group.id;
    record.listing_has_variations = true;
    record.variant_dict = item.group.options;
  }
  // OpenAI takes one shipping price per item: only when every country pays the same
  const shippingPrices = new Set(item.shipping.map(route => money(route.price)));
  if (shippingPrices.size === 1) record.shipping_price = [...shippingPrices][0];
  if (seller.acceptsReturns !== undefined) record.accepts_returns = seller.acceptsReturns;
  if (seller.returnPolicy) record.return_policy = seller.returnPolicy;
  if (seller.privacyPolicy) record.seller_privacy_policy = seller.privacyPolicy;
  if (seller.terms) record.seller_tos = seller.terms;
  return record;
}

// ---- shared

// "39.95 EUR": the amount in major units with the currency's own decimals, no thousands separator (both specs)
function money({ amount, currency }: Money) {
  const decimals =
    new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return `${(amount / 10 ** decimals).toFixed(decimals)} ${currency}`;
}

// An item either spec would refuse is a bug in the app's catalogue or words: stop, rather than serve a feed that
// Merchant Center or OpenAI turns down in part
function checked(item: FeedItem) {
  const refuse = (why: string) => {
    throw new Error(`Feed item ${item.id}: ${why}`);
  };
  if (!item.id || item.id.length > ID_MAX) refuse(`an id of 1 to ${ID_MAX} characters`);
  if (!item.title || item.title.length > TITLE_MAX) refuse(`a title of 1 to ${TITLE_MAX} characters`);
  if (!item.description || item.description.length > DESCRIPTION_MAX)
    refuse(`a description of 1 to ${DESCRIPTION_MAX} characters`);
  for (const url of [item.link, item.image, ...(item.moreImages ?? [])])
    if (!/^https?:\/\//.test(url)) refuse(`an absolute URL, not ${url}`);
  if (!(item.price.amount > 0)) refuse('a price above zero');
  if (item.sale && !(item.sale.price.amount < item.price.amount && item.sale.price.currency === item.price.currency)) {
    refuse('a sale price below its price, in the same currency');
  }
  if (!item.shipping.length) refuse('shipping to at least one country');
  return item;
}

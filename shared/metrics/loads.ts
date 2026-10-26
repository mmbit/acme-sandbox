// Who loaded a product's page, and where from (README.md, "People, not machines"): a crawler or fetcher, a speculative
// load, or a person with the kind of page that sent them. metrics.ts's page() counts these itself; an app that counts
// per page calls them too, through metrics.ts. Only the returned name is kept, never the user agent or referrer.

export type Headers = Record<string, string | string[] | undefined>;

// The search engines by their hosts, besides Google's and Yahoo's country sites (searchCampaign)
const SEARCH_HOSTS = new Map([
  ['bing.com', 'bing'],
  ['duckduckgo.com', 'duckduckgo'],
  ['ecosia.org', 'ecosia'],
  ['search.yahoo.com', 'yahoo'],
  ['search.brave.com', 'brave'],
  ['startpage.com', 'startpage'],
  ['qwant.com', 'qwant'],
  ['baidu.com', 'baidu'],
  ['yandex.com', 'yandex'],
  ['yandex.ru', 'yandex'],
  ['search.aol.com', 'aol'],
  ['search.naver.com', 'naver'],
  ['search.seznam.cz', 'seznam'],
]);
// Every name searchCampaign gives
export const SEARCH_CAMPAIGNS = new Set([
  'search-google',
  ...[...SEARCH_HOSTS.values()].map(engine => `search-${engine}`),
]);

// The host of an http(s) referrer without credentials, minus a leading www; null for anything else.
function referrerHost(referrer: unknown): string | null {
  const url = typeof referrer === 'string' ? URL.parse(referrer) : null;
  return url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
    ? url.hostname.replace(/^www\./, '')
    : null;
}

// search-<engine> for a load a search engine sent, by the referrer's host; else null
export function searchCampaign(referrer: unknown): string | null {
  const host = referrerHost(referrer);
  if (!host) return null;
  if (/^google\.(?:com|[a-z]{2}|(?:co|com)\.[a-z]{2})$/.test(host)) return 'search-google';
  if (/^(?:[a-z]{2}\.)?search\.yahoo\.com$/.test(host)) return 'search-yahoo';
  const engine = SEARCH_HOSTS.get(host);
  return engine ? `search-${engine}` : null;
}

// The source of a load that isn't a person's, or null for a person's: agent-<name> for a crawler or fetcher
// (crawlerName), else prefetch for a load made ahead of a tap that may never come (speculative).
export function fetchedBy(headers: Headers): string | null {
  const agent = crawlerName(headers['user-agent']);
  if (agent) return `agent-${agent}`;
  return speculative(headers) ? 'prefetch' : null;
}

// The crawlers and fetchers that say who they are, by the robots token each company documents for its user agent
// (OpenAI's developers.openai.com/api/docs/bots, docs.perplexity.ai/guides/bots, Anthropic's support article 8896518,
// Bing's and Google's crawler pages, Meta's developers.facebook.com/docs/sharing/webmasters/web-crawlers). Matched as a
// whole word, case-insensitive: the full strings change with every version. A user agent is a claim anyone can make,
// so these count what visitors say they are. The AI ones are OpenAI's, Perplexity's and Anthropic's; bingbot,
// Googlebot and Applebot are search crawlers whose index the assistants also answer from (Copilot, Gemini, Siri), so
// they're named too, and a report tells them apart by name. Meta's fetch a shared link's preview
// (facebookexternalhit), review an ad's page (meta-externalads) and crawl for its AI and search.
const CRAWLERS = [
  'OAI-SearchBot',
  'ChatGPT-User',
  'GPTBot',
  'PerplexityBot',
  'Perplexity-User',
  'Claude-SearchBot',
  'Claude-User',
  'ClaudeBot',
  'bingbot',
  'Googlebot',
  'Applebot',
  'facebookexternalhit',
  'meta-externalads',
  'meta-externalagent',
  'meta-externalfetcher',
  'meta-webindexer',
];
const CRAWLER_TOKEN = new RegExp(`(?<![a-z0-9-])(${CRAWLERS.join('|')})(?![a-z0-9])`, 'i');
// Any other that says it's a bot: a name ending in bot, crawler or spider before its version or the end of its part
// ('AhrefsBot/7.0', 'Bytespider;', 'SEO Spider/21'; not a phone named Cubot, which a space follows), or the link to
// its own page that crawlers put in their user agent ('+https://…'), which no browser has
const DECLARED_BOT = /(?<![a-z0-9])[a-z0-9_-]*(?:bot|crawler|spider)(?=[/;),]|$)|\+https?:\/\//i;
// The HTTP libraries and headless browsers scripts fetch with, as the product token each puts in its user agent
// ('curl/8.5.0', 'python-requests/2.32', 'Go-http-client/2.0', Node's fetch 'node')
const LIBRARIES = [
  'curl',
  'Wget',
  'python-requests',
  'Python-urllib',
  'python-httpx',
  'aiohttp',
  'Go-http-client',
  'node',
  'node-fetch',
  'undici',
  'axios',
  'okhttp',
  'Java',
  'Apache-HttpClient',
  'libwww-perl',
  'Scrapy',
  'GuzzleHttp',
  'HeadlessChrome',
  'PhantomJS',
];
const LIBRARY_TOKEN = new RegExp(`(?<![a-z0-9-])(?:${LIBRARIES.join('|')})(?:/|$)`, 'i');

// The known crawler's or fetcher's name in lowercase ('gptbot', 'chatgpt-user'), other for any other bot or HTTP
// library and for a request without a user agent (every browser sends one), or null for a browser.
export function crawlerName(userAgent: unknown): string | null {
  if (typeof userAgent !== 'string' || !userAgent.trim()) return 'other';
  const agent = userAgent.slice(0, 1000),
    m = CRAWLER_TOKEN.exec(agent);
  if (m) return m[1].toLowerCase();
  return DECLARED_BOT.test(agent) || LIBRARY_TOKEN.test(agent) ? 'other' : null;
}

// A load made ahead of a tap that may never come: a browser's prefetch or prerender (Sec-Purpose, or Purpose in older
// ones), or Meta's apps loading an ad's page before it's tapped (X-Purpose: preview). A tap after one shows the page
// the load fetched, without a load of its own.
const PURPOSE_HEADERS = ['sec-purpose', 'purpose', 'x-purpose'];
const SPECULATIVE = /(?<![a-z0-9-])(?:prefetch|prerender|preview)(?![a-z0-9-])/i;
const speculative = (headers: Headers) => PURPOSE_HEADERS.some(name => SPECULATIVE.test(String(headers[name] ?? '')));

// Where a person's page load came from, by the referrer's host (and on a shelf its path) alone: stall for the app's own
// pages (a reload or a step inside it), shop for the shop's other pages on the same host, ai-<assistant> (aiReferral:
// its referrer or the page's utm_source), search-<engine>, a social network by name (SOCIAL_HOSTS), other for any
// other site, or none without a referrer. A shelf is the app at <shop host><X-Forwarded-Prefix> (infra/products.py).
// ownPage: which paths on the host are the app's own, for one whose host has other apps' shelves under it (the shop's
// front at the root); by default those under its prefix, or every path without one.
export function loadSource(headers: Headers, url: URL | string, ownPage?: (path: string) => boolean): string {
  const referrer = headers.referer,
    host = referrerHost(referrer),
    own = typeof headers.host === 'string' ? referrerHost(`http://${headers.host}`) : null;
  if (host && host === own) {
    const prefix = String(headers['x-forwarded-prefix'] ?? ''),
      path = URL.parse(String(referrer))!.pathname,
      ours = ownPage ?? ((p: string) => !prefix || p === prefix || p.startsWith(`${prefix}/`));
    return ours(path) ? 'stall' : 'shop';
  }
  const assistant = aiReferral(referrer, url);
  if (assistant) return assistant;
  if (!host) return referrer ? 'other' : 'none';
  return searchCampaign(referrer) ?? socialNetwork(host) ?? 'other';
}

// The social networks by their sites' domains, each with its subdomains (Facebook's link hosts l. and lm.)
const SOCIAL_HOSTS = new Map([
  ['facebook.com', 'meta'],
  ['instagram.com', 'meta'],
]);
const socialNetwork = (host: string) => {
  const labels = host.split('.');
  return labels.map((_, i) => SOCIAL_HOSTS.get(labels.slice(i).join('.'))).find(Boolean) ?? null;
};

// The assistants whose links send people here, by the referrer host, or utm_source on the page's URL (ChatGPT adds
// utm_source=chatgpt.com to the links it cites, and its app often sends no referrer).
const AI_HOSTS = new Map([
  ['chatgpt.com', 'chatgpt'],
  ['perplexity.ai', 'perplexity'],
  ['copilot.microsoft.com', 'copilot'],
  ['gemini.google.com', 'gemini'],
  ['claude.ai', 'claude'],
]);

// ai-<assistant> for a visit an AI assistant sent ('ai-chatgpt'), from the referrer or the page's URL; else null.
export function aiReferral(referrer: unknown, url: URL | string): string | null {
  const source = URL.parse(String(url), 'http://x')
    ?.searchParams.get('utm_source')
    ?.toLowerCase()
    .replace(/^www\./, '');
  const assistant = AI_HOSTS.get(referrerHost(referrer) ?? '') ?? AI_HOSTS.get(source ?? '');
  return assistant ? `ai-${assistant}` : null;
}

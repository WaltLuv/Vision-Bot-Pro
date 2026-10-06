// Reading the web. The minimum an employee needs to answer a question it does
// not already know, and to follow a link you give it.
//
// Two tools, deliberately: read a page, and search for one. Search needs a
// provider key (a search API's, or a Gemini key, which searches Google);
// reading does not, so the useful half works with no setup.
//
// The model choosing these URLs is influenced by whatever it has just read, so
// this is an outbound request an attacker can aim. It may only reach public
// internet hosts: loopback, private ranges and link-local are refused, which
// matters most here because the gateway runs on the same machine as Hermes and
// alongside whatever else is on that VM.
import {z} from 'zod';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {ToolGateway} from './tools.js';
import {geminiKey,groundedSearch} from './grounded.js';

const MAX_BYTES = 2_000_000;
const MAX_TEXT = 100_000;
const TIMEOUT_MS = 20_000;

/** Ranges that are not the public internet. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase();
    if (v6 === '::1' || v6 === '::') return true;
    if (/^f[cd]/.test(v6)) return true;              // unique local
    if (v6.startsWith('fe80')) return true;          // link local
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]!) : false;
  }
  const [a, b] = ip.split('.').map(Number) as [number, number];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;           // link local, cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT
  return a >= 224;                                   // multicast and reserved
}

/** Throws unless the URL is an ordinary public http(s) address. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {url = new URL(raw);} catch {throw Error('That is not a valid web address');}
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw Error('Only web addresses can be opened');
  if (url.username || url.password) throw Error('That web address carries credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{address: host}] : await lookup(host, {all: true}).catch(() => {throw Error('That site could not be found');});
  if (!addresses.length) throw Error('That site could not be found');
  // Every address it resolves to, so a name with one public and one private
  // record cannot be used to reach inside.
  for (const {address} of addresses) if (isPrivateAddress(address)) throw Error('That address is not on the public internet');
  return url;
}

/** Readable text from a page, with scripts, styles and markup removed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

async function readPage(raw: string, http: typeof fetch): Promise<{url: string; title: string; text: string; truncated: boolean}> {
  const url = await assertPublicUrl(raw);
  const response = await http(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {Accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5', 'User-Agent': 'VisionClaw/1.0'},
  });
  if (!response.ok) throw Error(`That page returned HTTP ${response.status}`);
  // A redirect can land somewhere private even when the first address was not.
  if (response.url && response.url !== url.toString()) await assertPublicUrl(response.url);

  const type = response.headers.get('content-type') ?? '';
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_BYTES) throw Error('That page is too large to read');
  const body = new TextDecoder('utf-8').decode(buffer);
  const raw_text = /json/.test(type) ? body : /html|xml/.test(type) || /^\s*</.test(body) ? htmlToText(body) : body;
  const title = (body.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)?.[1] ?? '').trim();
  return {url: response.url || url.toString(), title, text: raw_text.slice(0, MAX_TEXT), truncated: raw_text.length > MAX_TEXT};
}

export type SearchResult = {results: {title: string; url: string; snippet: string}[]; provider: string; answer?: string; searches?: string[]};

/** How the employee searches: a search API when its key is set, else Google through a Gemini key, else not at all. */
export function searchProvider(env: NodeJS.ProcessEnv = process.env): 'api' | 'gemini' | null {
  return env.SEARCH_API_KEY ? 'api' : geminiKey(env) ? 'gemini' : null;
}

/**
 * The search API a SEARCH_API_KEY belongs to. Each speaks its own request shape, so the key alone is not enough:
 * SEARCH_PROVIDER names it (brave, tavily, serper or exa), and without it the endpoint's host decides, then Brave.
 */
export type SearchApi = 'brave' | 'tavily' | 'serper' | 'exa';
export function searchApi(env: NodeJS.ProcessEnv = process.env): SearchApi {
  const named = String(env.SEARCH_PROVIDER ?? '').toLowerCase();
  if (named === 'tavily' || named === 'serper' || named === 'exa' || named === 'brave') return named;
  const host = env.SEARCH_ENDPOINT ? new URL(env.SEARCH_ENDPOINT).hostname : '';
  return host.includes('tavily') ? 'tavily' : host.includes('serper') ? 'serper' : host.includes('exa.ai') ? 'exa' : 'brave';
}
const SEARCH_ENDPOINTS: Record<SearchApi, string> = {
  brave: 'https://api.search.brave.com/res/v1/web/search',
  tavily: 'https://api.tavily.com/search',
  serper: 'https://google.serper.dev/search',
  exa: 'https://api.exa.ai/search',
};
/** The request each search API expects. The key travels in a header, never in the address, so it stays out of logs. */
function searchRequest(api: SearchApi, endpoint: string, key: string, query: string): [string, RequestInit] {
  const json = (headers: Record<string, string>, body: unknown): [string, RequestInit] => [endpoint, {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json', ...headers}, body: JSON.stringify(body)}];
  if (api === 'tavily') return json({Authorization: `Bearer ${key}`}, {query, max_results: 8, search_depth: 'basic', include_answer: true});
  if (api === 'serper') return json({'X-API-KEY': key}, {q: query, num: 8});
  if (api === 'exa') return json({'x-api-key': key}, {query, numResults: 8, type: 'auto', contents: {highlights: true}});
  return [`${endpoint}${endpoint.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`, {headers: {Accept: 'application/json', 'X-Subscription-Token': key}}];
}

/**
 * Search, when a provider is configured. Deliberately provider-neutral: the
 * endpoint and key are configuration, so nobody is locked to one search
 * company, and with none set the tool says so instead of inventing results.
 */
export async function search(query: string, http: typeof fetch = fetch, timeoutMs = TIMEOUT_MS): Promise<SearchResult> {
  const provider = searchProvider();
  if (provider === 'gemini') return googleSearch(query, http);
  if (!provider) throw Error('Web search is not connected. Set SEARCH_API_KEY, or a Gemini key to search through Google, or give the employee a web address to read.');
  const key = process.env.SEARCH_API_KEY!, api = searchApi(), endpoint = process.env.SEARCH_ENDPOINT ?? SEARCH_ENDPOINTS[api];
  const [url, init] = searchRequest(api, endpoint, key, query);
  const response = await http(url, {...init, signal: AbortSignal.timeout(timeoutMs)});
  if (!response.ok) throw Error(`Search returned HTTP ${response.status}`);
  const body = await response.json() as any;
  // Brave (web.results), Tavily and Exa (results), Serper (organic) and SerpAPI (organic_results) all surface a list.
  const rows = body?.web?.results ?? body?.results ?? body?.organic ?? body?.organic_results ?? [];
  return {
    provider: new URL(endpoint).hostname,
    ...(typeof body?.answer === 'string' && body.answer ? {answer: body.answer.slice(0, 4000)} : {}),
    results: (rows as any[]).slice(0, 8).map(r => ({
      title: String(r.title ?? r.name ?? '').slice(0, 200),
      url: String(r.url ?? r.link ?? ''),
      snippet: String(r.description ?? r.snippet ?? r.content ?? (Array.isArray(r.highlights) ? r.highlights.join(' … ') : r.text) ?? '').slice(0, 500),
    })).filter(r => r.url),
  };
}

/**
 * Google Search through Gemini. Gemini's summary comes back with the pages it
 * found, each with the parts of the summary it backs, so the employee can tell
 * a sourced fact from an unsourced one and open any page to read it whole.
 */
async function googleSearch(query: string, http: typeof fetch): Promise<SearchResult> {
  const found = await groundedSearch(`Search Google for: ${query}

Report what the pages you find say, briefly and specifically: names, model or part numbers, prices and where each was seen, dates. Do not add anything the pages do not say.`, http);
  const seen = new Set<string>();
  const results = found.sources.flatMap((source, i) => {
    if (!source.url || seen.has(source.url)) return [];
    seen.add(source.url);
    const snippet = found.supports.filter(s => s.sources.includes(i)).map(s => s.text.trim()).filter(Boolean).join(' … ');
    return [{title: (source.title || source.domain).slice(0, 200), url: source.url, snippet: snippet.slice(0, 500)}];
  });
  return {provider: 'Google Search, through Gemini', answer: found.text.slice(0, 4000), searches: found.queries, results: results.slice(0, 8)};
}

export function registerWeb(t: ToolGateway, http: typeof fetch = fetch) {
  t.register({
    id: 'web_read', description: 'Open a web address and read what it says', effect: 'read',
    schema: z.object({url: z.string().min(4).max(2000)}),
    run: async a => readPage(a.url, http),
  });
  t.register({
    id: 'web_search', description: 'Search the web for pages about something', effect: 'read',
    schema: z.object({query: z.string().min(2).max(300)}),
    run: async a => search(a.query, http),
  });
}

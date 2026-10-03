// Prices from the big stores' own pages, found through Google Search.
//
// The Home Depot, Lowe's, Amazon and Walmart give product data to apps only
// through partner programs (suppliers.ts). Without one, a comparison can still
// start from what each store's own pages show: Gemini searches Google for the
// item at that store, and a price it reports is kept only when Google ties it to
// a product page on that store's own site. That page becomes the offer's link.
//
// What this cannot know, it does not claim. The price is what the page showed
// when Google read it; stock, shipping and tax are unknown; the item is at best
// a possible match. Such an offer is labelled as found by web search, and it can
// never be bought through checkout: no supplier connection stands behind it to
// quote an exact total. The owner buys it on the store's site, where the price
// shown is the one that counts, or has the employee open it in the browser.
import {BUILTIN_SUPPLIERS, offerSchema, scoreMatch, type Offer, type SupplierAdapter} from './suppliers.js';
import {geminiKey, groundedSearch, type GroundedAnswer} from './grounded.js';

export const WEB_STORES: Record<string, {name: string; domain: string}> = {
  home_depot: {name: 'The Home Depot', domain: 'homedepot.com'},
  lowes: {name: "Lowe's", domain: 'lowes.com'},
  amazon: {name: 'Amazon', domain: 'amazon.com'},
  walmart: {name: 'Walmart', domain: 'walmart.com'},
};

/** A store's own item number, from a product page's address; null when the address is not a product page. */
export function itemNumber(store: string, url: string): string | null {
  let path: string;
  try {path = new URL(url).pathname;} catch {return null;}
  const pattern = {
    home_depot: /\/p\/(?:[^/]+\/)?(\d{6,12})\/?$/,
    lowes: /\/pd\/(?:[^/]+\/)?(\d{4,12})\/?$/,
    amazon: /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:\/|$)/,
    walmart: /\/ip\/(?:[^/]+\/)?(\d{5,14})\/?$/,
  }[store];
  return pattern?.exec(path)?.[1] ?? null;
}

const GOOGLE_REDIRECT = 'vertexaisearch.cloud.google.com';
const PRICE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?/;
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const hostOf = (url: string) => {try {return new URL(url).hostname;} catch {return '';}};

export const priceCheckPrompt = (query: string, name: string, domain: string) =>
  `Find "${query}" for sale at ${name} (${domain}) in the United States, using Google Search. Use only product pages on ${domain}.
For each matching product you find there, write one line in exactly this form, and nothing else:
OFFER | product name as the page shows it | price as the page shows it, like $12.98 | stock or delivery as the page shows it, or not shown
Write at most 3 such lines, closest match first. If ${domain} has no matching product page in the results, write only: NONE`;

/**
 * The offers Gemini reported for one store. Each is kept only when a part of the
 * answer stating it is backed by a product page on that store's own site, as
 * Google reports it; the rest are counted as unbacked and dropped.
 */
export function offersFromAnswer(found: GroundedAnswer, store: string, query: string, quantity: number, observedAt = new Date().toISOString()): {offers: Offer[]; unbacked: number} {
  const {name, domain} = WEB_STORES[store]!;
  const own = (d: string) => d === domain || d.endsWith('.' + domain);
  const offers: Offer[] = [], seen = new Set<string>();
  let unbacked = 0;
  for (const raw of found.text.split('\n')) {
    const line = squash(raw.replace(/\*\*/g, '').replace(/^[\s>*•-]+/, ''));
    const m = /^OFFER\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*(?:\|\s*([^|]*?)\s*)?$/i.exec(line);
    if (!m) continue;
    const product = m[1]!.slice(0, 300), price = PRICE.exec(m[2]!), note = (m[3] ?? '').slice(0, 120);
    if (!price) continue;
    const unitPrice = Number(price[1]!.replace(/,/g, '') + (price[2] ?? ''));
    if (!(unitPrice > 0 && unitPrice < 100_000)) continue;
    const token = price[0].replace(/\s/g, '');
    // The parts of the answer that state this line: the line itself, a piece of it, or one naming this product at this price.
    const backing = found.supports.filter(s => {
      const part = squash(s.text);
      return part.length >= 6 && (line.includes(part) || part.includes(line) || (part.replace(/\s/g, '').includes(token) && part.includes(product.slice(0, 12))));
    });
    // A product page on the store's own site. A link Google's redirect would not reveal is taken on the site Google named.
    const page = backing.flatMap(s => s.sources).map(i => found.sources[i]!).find(source =>
      own(source.domain) && (hostOf(source.url) === GOOGLE_REDIRECT || itemNumber(store, source.url) !== null));
    if (!page) {unbacked++; continue;}
    if (seen.has(`${page.url} ${unitPrice}`)) continue;
    seen.add(`${page.url} ${unitPrice}`);
    const match = scoreMatch(query, product);
    const parsed = offerSchema.safeParse({
      supplierId: `web_${store}`, supplier: name, method: 'web_search',
      sku: itemNumber(store, page.url) ?? 'not shown', product, url: page.url,
      quantity, unitPrice, currency: 'USD',
      availability: note && !/^(not shown|unknown|n\/?a|none)$/i.test(note) ? `${note} (as the page showed; not confirmed)` : 'unconfirmed',
      observedAt,
      // Nobody has looked at the item itself yet: at best a possible match.
      matchQuality: match.matchQuality === 'exact' ? 'candidate' : match.matchQuality,
      confidence: Math.min(match.confidence, 0.7),
    });
    if (parsed.success) offers.push(parsed.data);
  }
  return {offers, unbacked};
}

/** One store's prices, through Google Search. */
export class WebPriceCheck implements SupplierAdapter {
  readonly method = 'web_search' as const;
  readonly requires = ['GEMINI_API_KEY'];
  /** A Google search through Gemini takes longer than a catalog lookup. */
  readonly timeoutMs = 45_000;
  constructor(readonly store: string, readonly http: typeof fetch = fetch) {}
  get id() {return `web_${this.store}`;}
  get name() {return WEB_STORES[this.store]!.name;}
  configured() {return !!geminiKey();}

  async search(query: string, quantity: number, currency: string): Promise<Offer[]> {
    // These stores price in US dollars; another currency is not theirs to answer.
    if (currency !== 'USD') return [];
    const {name, domain} = WEB_STORES[this.store]!;
    const found = await groundedSearch(priceCheckPrompt(query, name, domain), this.http, this.timeoutMs - 2_000);
    return offersFromAnswer(found, this.store, query, quantity).offers;
  }
}

/**
 * On whenever a Gemini key is set, for each store that has no partner
 * connection of its own (which, when set, is what the store's prices come
 * from). WEB_PRICE_CHECK=off turns it off.
 */
export function webPriceChecks(http: typeof fetch = fetch): SupplierAdapter[] {
  if (!geminiKey() || /^(off|false|0|no)$/i.test(process.env.WEB_PRICE_CHECK?.trim() ?? '')) return [];
  return Object.keys(WEB_STORES).filter(id => !process.env[BUILTIN_SUPPLIERS[id]!.endpointEnv]).map(id => new WebPriceCheck(id, http));
}

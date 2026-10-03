// Provider-neutral supplier registry.
//
// Every supplier reaches the employee through the same adapter interface and
// normalizes into one Offer shape, so comparison never depends on which
// supplier answered. No supplier is privileged: the set that is searched is
// whatever the owner has connected.
//
// Access methods are tried in the order the handoff requires -- official API,
// official partner/catalog API, MCP connector, approved browser adapter, then a
// configured URL or manual connector, and last a price found on the store's own
// page by web search (webprices.ts). A supplier's method is part of its
// configuration, and it travels with every offer so a person can see how a
// price was obtained.
//
// Nothing here invents a price, a stock level, a fulfillment promise or an
// order. A field the supplier did not report stays null and is rendered as
// unknown rather than guessed.
import {z} from 'zod';
import {readFileSync} from 'node:fs';
import {providerJson} from './communications.js';

export const ACCESS_METHODS = ['official_api', 'partner_api', 'mcp', 'browser', 'manual', 'web_search'] as const;
export type AccessMethod = (typeof ACCESS_METHODS)[number];
/** Lower is preferred. A supplier reachable two ways is used by its best one. */
export const methodRank = (m: AccessMethod) => ACCESS_METHODS.indexOf(m);

/** Reported per fulfillment channel. `available: null` means the supplier did not say. */
export const fulfillmentSchema = z.object({
  available: z.boolean().nullable().default(null),
  eta: z.string().max(160).default(''),
  location: z.string().max(160).default(''),
});

export const offerSchema = z.object({
  supplierId: z.string().min(1),
  supplier: z.string().min(1),
  method: z.enum(ACCESS_METHODS),
  sku: z.string().min(1),
  product: z.string().min(1),
  url: z.string().url(),
  specification: z.string().max(2000).default(''),
  quantity: z.number().int().positive().max(1000),
  unitPrice: z.number().nonnegative(),
  currency: z.string().length(3),
  shipping: z.number().nonnegative().nullable().default(null),
  tax: z.number().nonnegative().nullable().default(null),
  fees: z.number().nonnegative().nullable().default(null),
  inventory: z.number().int().nonnegative().nullable().default(null),
  availability: z.string().max(200).default('unconfirmed'),
  pickup: fulfillmentSchema.default({available: null, eta: '', location: ''}),
  delivery: fulfillmentSchema.default({available: null, eta: '', location: ''}),
  observedAt: z.string().datetime(),
  matchQuality: z.enum(['unverified', 'candidate', 'exact']).default('candidate'),
  // How much the adapter trusts this row to be the requested item. Search text
  // matching only; it never asserts price or stock accuracy.
  confidence: z.number().min(0).max(1).default(0.5),
});
export type Offer = z.infer<typeof offerSchema>;

export type SupplierStatus = 'ok' | 'failed' | 'unconfigured' | 'timeout';

export interface SupplierReport {
  id: string;
  name: string;
  method: AccessMethod;
  status: SupplierStatus;
  offers: number;
  checkedAt: string;
  /** Present only when status is not ok. Phrased for the person, never a raw provider body. */
  detail?: string;
}

export interface SupplierAdapter {
  readonly id: string;
  readonly name: string;
  readonly method: AccessMethod;
  /** Environment variables the owner must supply. Named so the UI and docs agree. */
  readonly requires: readonly string[];
  configured(): boolean;
  search(query: string, quantity: number, currency: string): Promise<Offer[]>;
  /** How long this supplier may take to answer, when not the usual SUPPLIER_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

// --- normalisation --------------------------------------------------------

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Total is only stated when every component the supplier owes us is present.
 * A missing shipping or tax figure makes the total unknown rather than
 * optimistic, and an unknown total sorts after every known one.
 */
export function priceOffer(offer: Offer) {
  const subtotal = round(offer.unitPrice * offer.quantity);
  const parts = [offer.shipping, offer.tax, offer.fees];
  const known = parts.every(p => p !== null);
  const total = known ? round(subtotal + parts.reduce((n, p) => n + (p ?? 0), 0)) : null;
  return {...offer, subtotal, total, totalKnown: known};
}

export type PricedOffer = ReturnType<typeof priceOffer>;

/**
 * One comparison model across every supplier. Exact matches rank above
 * candidates before price is considered, because the cheapest row is worthless
 * if it is not the requested item.
 */
export function compareOffers(offers: Offer[], currency: string): PricedOffer[] {
  const rank = {exact: 0, candidate: 1, unverified: 2} as const;
  return offers
    .filter(o => o.currency === currency)
    .map(priceOffer)
    .sort((a, b) =>
      rank[a.matchQuality] - rank[b.matchQuality] ||
      (a.total ?? a.subtotal + Number.MAX_SAFE_INTEGER) - (b.total ?? b.subtotal + Number.MAX_SAFE_INTEGER) ||
      b.confidence - a.confidence);
}

// Sizes and plurals are written every which way -- "3 inch", "3 in.", "3\"" -- so
// they are compared in one form. A size is kept even when it is a single digit:
// a 2 in. screw is not a 3 in. one.
const UNIT: Record<string, string> = {inch: 'in', inches: 'in', foot: 'ft', feet: 'ft', pound: 'lb', pounds: 'lb', lbs: 'lb',
  millimeter: 'mm', millimeters: 'mm', millimetre: 'mm', millimetres: 'mm', gallon: 'gal', gallons: 'gal', ounce: 'oz', ounces: 'oz'};
const FILLER = new Set(['of', 'for', 'the', 'and', 'with', 'from', 'per']);
function term(word: string): string {
  const w = word.replace(/\.+$/, '');
  return UNIT[w] ?? (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
}

/** Search-text overlap only. Deliberately not a claim about the item being correct. */
export function scoreMatch(query: string, product: string): {matchQuality: Offer['matchQuality']; confidence: number} {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9.]+/i).map(term).filter(w => (w.length > 1 || /\d/.test(w)) && !FILLER.has(w)));
  const wanted = words(query), got = words(product);
  if (!wanted.size) return {matchQuality: 'unverified', confidence: 0};
  let hit = 0;
  for (const w of wanted) if (got.has(w)) hit++;
  const ratio = hit / wanted.size;
  // "exact" here means every search term appears in the title. A person still
  // confirms the item before the purchase approval.
  if (ratio === 1) return {matchQuality: 'exact', confidence: 0.9};
  if (ratio >= 0.5) return {matchQuality: 'candidate', confidence: round(ratio)};
  return {matchQuality: 'unverified', confidence: round(ratio)};
}

// --- configured catalog adapter -------------------------------------------

/** Dotted path into a provider payload, e.g. "Offers.Listings.0.Price.Amount". */
export function pick(source: unknown, path?: string): unknown {
  if (!path) return undefined;
  return path.split('.').reduce<any>((value, key) => (value === null || value === undefined ? undefined : value[key]), source);
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const bool = (v: unknown): boolean | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  if (['true', 'yes', 'available', 'in_stock', 'instock', 'in stock'].includes(s)) return true;
  if (['false', 'no', 'unavailable', 'out_of_stock', 'outofstock', 'out of stock'].includes(s)) return false;
  return null;
};
const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).slice(0, 200));

/** Where each normalized field lives in this supplier's payload. */
export const mappingSchema = z.object({
  items: z.string().min(1),
  sku: z.string().min(1),
  product: z.string().min(1),
  url: z.string().min(1),
  urlPrefix: z.string().default(''),
  unitPrice: z.string().min(1),
  currency: z.string().default(''),
  currencyFallback: z.string().length(3).default('USD'),
  specification: z.string().default(''),
  shipping: z.string().default(''),
  tax: z.string().default(''),
  fees: z.string().default(''),
  inventory: z.string().default(''),
  availability: z.string().default(''),
  pickupAvailable: z.string().default(''),
  pickupLocation: z.string().default(''),
  pickupEta: z.string().default(''),
  deliveryAvailable: z.string().default(''),
  deliveryEta: z.string().default(''),
});
export type CatalogMapping = z.infer<typeof mappingSchema>;

export const supplierConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/).max(40),
  name: z.string().min(1).max(80),
  method: z.enum(ACCESS_METHODS).default('partner_api'),
  endpoint: z.string().url(),
  /** {query} and {limit} are substituted into the endpoint. */
  auth: z.object({type: z.enum(['none', 'bearer', 'header', 'basic']).default('none'), env: z.string().regex(/^[A-Z0-9_]+$/).optional(), header: z.string().max(80).optional()}).default({type: 'none'}),
  headers: z.record(z.string(), z.string()).default({}),
  mapping: mappingSchema,
  owners: z.array(z.string()).default([]),
});
export type SupplierConfig = z.infer<typeof supplierConfigSchema>;

/**
 * Reads one supplier's catalog over HTTP and normalizes it. The endpoint, auth
 * and field mapping are configuration, so a supplier whose partner API the
 * owner is entitled to needs no new code -- and no endpoint shape is guessed
 * here on a supplier's behalf.
 */
export class CatalogAdapter implements SupplierAdapter {
  constructor(readonly config: SupplierConfig, readonly http: typeof fetch = fetch) {}
  get id() {return this.config.id;}
  get name() {return this.config.name;}
  get method() {return this.config.method;}
  get requires() {return this.config.auth.env ? [this.config.auth.env] : [];}
  configured() {return !this.config.auth.env || !!process.env[this.config.auth.env];}

  async search(query: string, quantity: number, currency: string): Promise<Offer[]> {
    const url = this.config.endpoint.replace('{query}', encodeURIComponent(query)).replace('{limit}', '12');
    const headers: Record<string, string> = {Accept: 'application/json', ...this.config.headers};
    const secret = this.config.auth.env ? process.env[this.config.auth.env] : undefined;
    if (this.config.auth.type === 'bearer' && secret) headers.Authorization = `Bearer ${secret}`;
    if (this.config.auth.type === 'header' && secret && this.config.auth.header) headers[this.config.auth.header] = secret;
    if (this.config.auth.type === 'basic' && secret) headers.Authorization = 'Basic ' + Buffer.from(secret).toString('base64');
    const payload = await providerJson(url, {headers}, this.http);
    return this.normalize(payload, query, quantity, currency);
  }

  normalize(payload: unknown, query: string, quantity: number, currency: string): Offer[] {
    const m = this.config.mapping;
    const rows = pick(payload, m.items);
    if (!Array.isArray(rows)) return [];
    const observedAt = new Date().toISOString();
    return rows.flatMap(row => {
      const unitPrice = num(pick(row, m.unitPrice));
      const product = text(pick(row, m.product));
      const rawUrl = text(pick(row, m.url));
      const sku = text(pick(row, m.sku));
      // A row without a price, a name, an identifier or a link is not an offer.
      if (unitPrice === null || !product || !rawUrl || !sku) return [];
      const parsed = offerSchema.safeParse({
        supplierId: this.config.id,
        supplier: this.config.name,
        method: this.config.method,
        sku, product,
        url: m.urlPrefix ? new URL(rawUrl, m.urlPrefix).toString() : rawUrl,
        specification: text(pick(row, m.specification)),
        quantity, unitPrice,
        currency: text(pick(row, m.currency)) || m.currencyFallback || currency,
        shipping: num(pick(row, m.shipping)),
        tax: num(pick(row, m.tax)),
        fees: num(pick(row, m.fees)),
        inventory: num(pick(row, m.inventory)) === null ? null : Math.trunc(num(pick(row, m.inventory))!),
        availability: text(pick(row, m.availability)) || 'unconfirmed',
        pickup: {available: bool(pick(row, m.pickupAvailable)), eta: text(pick(row, m.pickupEta)), location: text(pick(row, m.pickupLocation))},
        delivery: {available: bool(pick(row, m.deliveryAvailable)), eta: text(pick(row, m.deliveryEta)), location: ''},
        observedAt,
        ...scoreMatch(query, product),
      });
      // One malformed row must not lose the rest of a supplier's results.
      return parsed.success ? [parsed.data] : [];
    });
  }
}

// --- built-in suppliers ---------------------------------------------------
//
// Each major supplier ships with its own configuration, field mapping and
// fulfillment vocabulary. The transport is an endpoint the owner supplies,
// because these catalogs are reached through partner entitlements rather than
// an open URL, and several require request signing. The gateway does not ship a
// signer it cannot exercise against the real service: where one is needed the
// owner points the adapter at their entitled endpoint or their own signing
// proxy. Every mapping below is overridable per deployment through
// SUPPLIER_CONFIG_PATH.

const neutral = {
  items: 'items', sku: 'id', product: 'name', url: 'url', unitPrice: 'price',
  availability: 'availability', inventory: 'inventory',
  pickupAvailable: 'pickup.available', pickupLocation: 'pickup.store', pickupEta: 'pickup.eta',
  deliveryAvailable: 'delivery.available', deliveryEta: 'delivery.eta',
  shipping: 'shipping', specification: 'description',
};

export const BUILTIN_SUPPLIERS: Record<string, {name: string; method: AccessMethod; endpointEnv: string; authEnv: string; authType: 'bearer' | 'header'; authHeader?: string; mapping: Partial<CatalogMapping>; note: string}> = {
  home_depot: {
    name: 'The Home Depot', method: 'partner_api',
    endpointEnv: 'HOME_DEPOT_ENDPOINT', authEnv: 'HOME_DEPOT_API_KEY', authType: 'header', authHeader: 'x-api-key',
    mapping: {...neutral, items: 'products', sku: 'itemId', product: 'title', url: 'canonicalUrl', unitPrice: 'pricing.value', currency: 'pricing.currency', inventory: 'inventory.quantity', availability: 'availabilityType', pickupAvailable: 'fulfillment.pickup.available', pickupLocation: 'fulfillment.pickup.storeName', pickupEta: 'fulfillment.pickup.eta', deliveryAvailable: 'fulfillment.delivery.available', deliveryEta: 'fulfillment.delivery.estimate', shipping: 'fulfillment.delivery.charge'},
    note: 'Partner/catalog entitlement. Confirm the field mapping against the endpoint you are granted.',
  },
  lowes: {
    name: "Lowe's", method: 'partner_api',
    endpointEnv: 'LOWES_ENDPOINT', authEnv: 'LOWES_API_KEY', authType: 'header', authHeader: 'x-api-key',
    mapping: {...neutral, items: 'products', sku: 'itemNumber', product: 'productTitle', url: 'productUrl', unitPrice: 'price.current', currency: 'price.currency', inventory: 'availability.quantity', availability: 'availability.status', pickupAvailable: 'availability.pickup', pickupLocation: 'availability.storeName', pickupEta: 'availability.pickupEta', deliveryAvailable: 'availability.delivery', deliveryEta: 'availability.deliveryEta', shipping: 'price.shipping'},
    note: 'Partner/catalog entitlement. Confirm the field mapping against the endpoint you are granted.',
  },
  amazon: {
    name: 'Amazon', method: 'official_api',
    endpointEnv: 'AMAZON_ENDPOINT', authEnv: 'AMAZON_API_KEY', authType: 'header', authHeader: 'x-api-key',
    // Product Advertising API 5.0 SearchItems response shape.
    mapping: {...neutral, items: 'SearchResult.Items', sku: 'ASIN', product: 'ItemInfo.Title.DisplayValue', url: 'DetailPageURL', unitPrice: 'Offers.Listings.0.Price.Amount', currency: 'Offers.Listings.0.Price.Currency', availability: 'Offers.Listings.0.Availability.Message', deliveryAvailable: 'Offers.Listings.0.DeliveryInfo.IsAmazonFulfilled', specification: 'ItemInfo.Features.DisplayValues.0', pickupAvailable: '', pickupLocation: '', pickupEta: '', inventory: ''},
    note: 'Product Advertising API 5.0 requires SigV4 request signing. Point AMAZON_ENDPOINT at your signing proxy or entitled gateway.',
  },
  walmart: {
    name: 'Walmart', method: 'official_api',
    endpointEnv: 'WALMART_ENDPOINT', authEnv: 'WALMART_API_KEY', authType: 'header', authHeader: 'WM_SEC.ACCESS_TOKEN',
    // Walmart affiliate/product search v2 response shape.
    mapping: {...neutral, items: 'items', sku: 'itemId', product: 'name', url: 'productUrl', unitPrice: 'salePrice', shipping: 'standardShipRate', availability: 'stock', deliveryAvailable: 'availableOnline', specification: 'shortDescription', inventory: '', pickupAvailable: '', pickupLocation: '', pickupEta: ''},
    note: 'Walmart I/O requires signed requests. Point WALMART_ENDPOINT at your entitled gateway or signing proxy.',
  },
};

/** eBay stays a resale marketplace behind an explicit switch; it is never a default supplier. */
export const EBAY_FLAG = 'EBAY_ENABLED';

function builtinConfig(id: string): SupplierConfig | null {
  const spec = BUILTIN_SUPPLIERS[id];
  if (!spec) return null;
  const endpoint = process.env[spec.endpointEnv];
  if (!endpoint) return null;
  const parsed = supplierConfigSchema.safeParse({
    id, name: spec.name, method: spec.method, endpoint,
    auth: {type: spec.authType, env: spec.authEnv, header: spec.authHeader},
    mapping: {...neutral, ...spec.mapping},
  });
  return parsed.success ? parsed.data : null;
}

/** Suppliers an owner defined themselves: local yards, specialty vendors, anything else. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** https anywhere, or plain http only to this machine. */
export function isSecureEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  } catch {return false;}
}

export function configuredSuppliers(): {configs: SupplierConfig[]; error?: string} {
  const path = process.env.SUPPLIER_CONFIG_PATH;
  if (!path) return {configs: []};
  try {
    const parsed = z.array(supplierConfigSchema).parse(JSON.parse(readFileSync(path, 'utf8')));
    // A supplier endpoint carries the owner's credential and returns prices the
    // employee will act on; plaintext is not acceptable for either. Loopback is
    // the one exception, on the same reasoning browsers use to treat
    // http://127.0.0.1 as a secure context: the traffic never leaves the host.
    // It is what lets a sidecar signing proxy run alongside the gateway.
    if (parsed.some(c => !isSecureEndpoint(c.endpoint))) throw Error('insecure endpoint');
    if (new Set(parsed.map(c => c.id)).size !== parsed.length) throw Error('duplicate supplier id');
    return {configs: parsed};
  } catch {
    return {configs: [], error: 'Supplier configuration is invalid; connected suppliers remain available'};
  }
}

/**
 * Every supplier the owner has actually connected, best access method first.
 * eBay appears only when explicitly switched on, and never merely because its
 * credentials happen to be present.
 */
export function loadSuppliers(extra: SupplierAdapter[] = [], http: typeof fetch = fetch): {adapters: SupplierAdapter[]; error?: string} {
  const adapters: SupplierAdapter[] = [];
  for (const id of Object.keys(BUILTIN_SUPPLIERS)) {
    const config = builtinConfig(id);
    if (config) adapters.push(new CatalogAdapter(config, http));
  }
  const own = configuredSuppliers();
  for (const config of own.configs) adapters.push(new CatalogAdapter(config, http));
  adapters.push(...extra);
  const seen = new Map<string, SupplierAdapter>();
  for (const a of [...adapters].sort((x, y) => methodRank(x.method) - methodRank(y.method))) if (!seen.has(a.id)) seen.set(a.id, a);
  return {adapters: [...seen.values()], error: own.error};
}

// --- parallel search ------------------------------------------------------

// A slow supplier must not hold the whole comparison. Configurable so a
// deployment on a slower partner link can raise it.
const searchTimeoutMs = () => Number(process.env.SUPPLIER_TIMEOUT_MS ?? 20_000);

/**
 * Ask every connected supplier at once and report each one's outcome. One
 * supplier being down, slow or misconfigured must never erase the offers the
 * others returned, and the person is told which were searched and which were
 * not rather than being shown a short list that looks complete.
 */
export async function searchSuppliers(adapters: SupplierAdapter[], query: string, quantity: number, currency: string): Promise<{offers: Offer[]; suppliers: SupplierReport[]}> {
  const results = await Promise.all(adapters.map(async (adapter): Promise<{offers: Offer[]; report: SupplierReport}> => {
    const base = {id: adapter.id, name: adapter.name, method: adapter.method, offers: 0, checkedAt: new Date().toISOString()};
    if (!adapter.configured()) return {offers: [], report: {...base, status: 'unconfigured', detail: `Needs ${adapter.requires.join(', ')}`}};
    let timer: NodeJS.Timeout | undefined;
    try {
      const offers = await Promise.race([
        adapter.search(query, quantity, currency),
        new Promise<never>((_, reject) => {timer = setTimeout(() => reject(Object.assign(Error('timeout'), {timeout: true})), adapter.timeoutMs ?? searchTimeoutMs());}),
      ]);
      return {offers, report: {...base, status: 'ok', offers: offers.length, checkedAt: new Date().toISOString()}};
    } catch (error) {
      const timeout = !!(error as {timeout?: boolean})?.timeout;
      return {offers: [], report: {...base, status: timeout ? 'timeout' : 'failed', checkedAt: new Date().toISOString(), detail: timeout ? 'Did not answer in time' : 'Did not answer'}};
    } finally {
      clearTimeout(timer);
    }
  }));
  return {offers: results.flatMap(r => r.offers), suppliers: results.map(r => r.report)};
}

import type {Material, Offer} from '../api';
import {h} from '../dom';
import {ACCESS_METHOD_LABEL, fulfillmentLabel, MATCH_LABEL, money, offerTotal, relativeTime, SUPPLIER_STATUS_LABEL, supplierSummary} from '../store';

/**
 * A supplier comparison. The first thing shown is how complete it is: a list of
 * three prices means something different when five suppliers were asked and two
 * never answered, and a person cannot tell those apart from the offers alone.
 */
export function materialSection(material: Material, offers: Offer[], now = Date.now()): HTMLElement {
  const summary = supplierSummary(material.suppliers);
  // The right item first, then the cheapest: a known total before an unknown one, and among unknown
  // totals the lower price, then the closer match.
  const ranked = [...offers].sort((a, b) => {
    const rank = {exact: 0, candidate: 1, unverified: 2} as const;
    const at = offerTotal(a), bt = offerTotal(b);
    const price = at.total !== null && bt.total !== null ? at.total - bt.total
      : at.total !== null ? -1 : bt.total !== null ? 1 : at.subtotal - bt.subtotal;
    return rank[a.matchQuality] - rank[b.matchQuality] || price || b.confidence - a.confidence;
  });

  return h('section', {class: 'card'},
    h('p', {class: 'eyebrow', text: 'Materials'}),
    h('h3', {text: material.description}),
    material.specification ? h('p', {class: 'note', text: material.specification}) : null,

    summary.total
      ? h('p', {class: 'note', text: `${summary.answered} of ${summary.total} suppliers answered${summary.checkedAt ? ` · prices checked ${relativeTime(summary.checkedAt, now)}` : ''}`})
      : null,
    // Named explicitly: a person deciding on these prices needs to know which
    // supplier is missing, not just that something is.
    summary.missing.length
      ? h('p', {class: 'warn-line', text: `Not included: ${summary.missing.map(m => `${m.name} (${SUPPLIER_STATUS_LABEL[m.status].toLowerCase()})`).join(', ')}. There may be better prices than these.`})
      : null,
    summary.total ? h('div', {class: 'row wrap'}, ...(material.suppliers ?? []).map(s =>
      h('span', {class: `pill ${s.status === 'ok' ? 'ok' : 'warn'}`, title: s.detail ?? '', text: `${s.name} · ${SUPPLIER_STATUS_LABEL[s.status]}`}))) : null,

    ...ranked.map(offer => offerCard(offer, now)),
    ranked.length ? h('p', {class: 'note', text: 'Prices and availability are as reported at the time shown. Nothing is bought until you authorise an exact quote.'}) : null,
  );
}

// No supplier connection stands behind these, so nothing here can quote them: the store's own site decides.
const ON_SITE = (method: Offer['method']) => method === 'web_search' || method === 'browser';
const WEBSITE_NOTE: Partial<Record<Offer['method'], string>> = {
  web_search: "Found by web search on the store's own page. Confirm the price there, and buy it there: its checkout shows shipping and tax.",
  browser: "Read on the store's website. Buy it there: its checkout shows shipping and tax.",
};

export function offerCard(offer: Offer, now = Date.now()): HTMLElement {
  const {subtotal, total} = offerTotal(offer);
  const line = (label: string, value: number | null) =>
    h('div', {class: 'row-item'}, h('p', {class: 'task', text: label}), h('span', {text: value === null ? 'not quoted' : money(value, offer.currency)}));

  return h('article', {class: `offer ${offer.matchQuality}`},
    h('div', {class: 'row wrap'},
      h('span', {class: 'supplier', text: offer.supplier}),
      h('span', {class: 'pill', text: ACCESS_METHOD_LABEL[offer.method]}),
    ),
    h('p', {class: 'product', text: offer.product}),
    offer.specification ? h('p', {class: 'note', text: offer.specification}) : null,
    h('p', {class: `note ${offer.matchQuality === 'exact' ? '' : 'warn-line'}`, text: MATCH_LABEL[offer.matchQuality]}),
    WEBSITE_NOTE[offer.method] ? h('p', {class: 'warn-line', text: WEBSITE_NOTE[offer.method]!}) : null,

    // A price read on a store's site is just that price: the note above says where the rest is, so the
    // card does not list everything the site did not say.
    ON_SITE(offer.method)
      ? h('div', {class: 'terms-lines'},
          line(`${offer.quantity} × ${money(offer.unitPrice, offer.currency)}`, subtotal),
          ...(['shipping', 'tax', 'fees'] as const).filter(k => offer[k] !== null).map(k => line(k[0]!.toUpperCase() + k.slice(1), offer[k])))
      : h('div', {class: 'terms-lines'},
          line(`${offer.quantity} × ${money(offer.unitPrice, offer.currency)}`, subtotal),
          line('Shipping', offer.shipping),
          line('Tax', offer.tax),
          line('Fees', offer.fees),
        ),
    total === null
      // Showing a partial sum as "total" invites comparing a shipped price
      // against an unshipped one.
      ? ON_SITE(offer.method) ? null : h('p', {class: 'warn-line', text: `Total not known — ${[offer.shipping === null && 'shipping', offer.tax === null && 'tax', offer.fees === null && 'fees'].filter(Boolean).join(' and ')} not quoted. A supplier quote confirms it.`})
      : h('p', {class: 'big', text: money(total, offer.currency)}),

    ON_SITE(offer.method) && offer.pickup?.available == null ? null : h('p', {class: 'note', text: fulfillmentLabel(offer.pickup, 'Pickup')}),
    ON_SITE(offer.method) && offer.delivery?.available == null ? null : h('p', {class: 'note', text: fulfillmentLabel(offer.delivery, 'Delivery')}),
    h('p', {class: 'note', text: offer.inventory === null ? `Stock: ${offer.availability}` : `Stock: ${[offer.inventory, offer.availability].filter(Boolean).join(' · ')}`}),
    h('p', {class: 'note', text: `Checked ${relativeTime(offer.observedAt, now)} · SKU ${offer.sku}`}),
    h('a', {class: 'chip', href: offer.url, target: '_blank', rel: 'noopener noreferrer', text: `Open at ${offer.supplier}`}),
  );
}

// App state and the pure rules the UI reads. The rules live here rather than
// inline in views so they can be tested without a DOM, and so the same
// judgement (is this approval still actionable? is this run finished?) cannot
// drift between two screens.

import type {AccessMethod, Action, Approval, Artifact, Connections, Contact, Fulfillment, Offer, Run, RunStatus, State, SupplierReport, SupplierStatus} from './api';
import type {Card, TranscriptEntry} from './realtime';

export const TERMINAL: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'cancelled']);

export const emptyState = (): State => ({
  run: [], agent: [], skill: [], memory: [], conversation: [], message: [], approval: [],
  artifact: [], contact: [], communication: [], material: [], offer: [], cart: [], quote: [],
  order: [], workflow: [], computer: [], policy: [], action: [], evidence_link: [],
});

export const STATUS_LABEL: Record<RunStatus, string> = {
  queued: 'Queued',
  working: 'Working',
  verifying: 'Checking the result',
  completed: 'Done',
  failed: "Couldn't finish",
  cancelled: 'Stopped',
  needs_user: 'Needs you',
};

/** Side effects a person must authorise individually, in the gateway's own terms. */
export const EFFECT_LABEL: Record<string, string> = {
  read: 'Look something up',
  write: 'Save something',
  communication: 'Send a message or place a call',
  destructive: 'Delete something',
  financial: 'Spend money',
  sensitive: 'Handle something sensitive',
  computer: 'Use a browser or computer',
};

/**
 * Effects where "always allow" should not be offered. Standing authority to
 * spend or to delete is exactly what the handoff forbids inferring, so the UI
 * never presents it as a choice for those.
 */
export const NO_STANDING_APPROVAL: ReadonlySet<string> = new Set(['financial', 'destructive', 'communication']);

export const isTerminal = (run: Run) => TERMINAL.has(run.status);

/** Newest first, by creation time, falling back to insertion order from the gateway. */
export function sortRuns(runs: Run[]): Run[] {
  return [...runs].sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? '') || 0);
}

/** The run the Today screen should be showing: the newest one still in flight. */
export function activeRun(runs: Run[]): Run | undefined {
  return sortRuns(runs).find(r => !isTerminal(r));
}

/**
 * Approvals the person can still act on. An expired approval is dropped rather
 * than shown as actionable: the gateway refuses a decision on it, and offering
 * the button would imply an authority that no longer exists.
 */
export function liveApprovals(approvals: Approval[], now = Date.now()): Approval[] {
  return approvals.filter(a => a.status === 'pending' && Number(a.expiresAt ?? 0) > now);
}

/** Actions left mid-flight by a restart; these block resume until reconciled. */
export function unreconciledActions(actions: Action[], runId?: string): Action[] {
  return actions.filter(a => ['executing', 'uncertain'].includes(a.status) && (!runId || a.runId === runId));
}

export function canResume(run: Run, actions: Action[]): boolean {
  return !!run.recovered && !isTerminal(run) && unreconciledActions(actions, run.id).length === 0;
}

export const runArtifacts = (artifacts: Artifact[], runId: string) => artifacts.filter(a => a.runId === runId);

/**
 * Rows for an approval card. Financial approvals must show the exact terms
 * being authorised, so the details object is rendered field by field instead of
 * summarised -- a person approving a purchase sees supplier, items, quantities
 * and total, not a sentence about them.
 */
const ROW_LABEL: Record<string, string> = {body: 'Message', objective: 'What the call is for'};

/**
 * An exact supplier quote, as the terms a person authorises: each item with its
 * quantity and price, every charge, the total, how it arrives, and how long the
 * price holds. Money is shown as money; internal ids are left out.
 */
export function purchaseRows(d: Record<string, any>): {label: string; value: string}[] {
  const currency = String(d.currency ?? 'USD'), cash = (n: unknown) => money(Number(n), currency);
  const rows: {label: string; value: string}[] = [];
  if (d.supplier) rows.push({label: 'Supplier', value: String(d.supplier)});
  for (const item of d.items as {name?: string; sku?: string; quantity: number; unitPrice: number}[])
    rows.push({label: 'Item', value: `${item.quantity} × ${item.name ?? item.sku}, ${cash(item.unitPrice)} each`});
  for (const [key, label] of [['subtotal', 'Subtotal'], ['tax', 'Tax'], ['fees', 'Fees'], ['delivery', 'Delivery']] as const)
    if (typeof d[key] === 'number') rows.push({label, value: cash(d[key])});
  rows.push({label: 'Total', value: `${cash(d.total)} ${currency}`});
  if (d.fulfillment) rows.push({label: 'How you get it', value: String(d.fulfillment)});
  if (d.deliveryAddress) rows.push({label: 'Where', value: String(d.deliveryAddress)});
  const until = Date.parse(String(d.expiresAt ?? ''));
  if (Number.isFinite(until)) rows.push({label: 'Price held until', value: new Date(until).toLocaleString(undefined, {weekday: 'short', hour: 'numeric', minute: '2-digit'})});
  if (d.quoteId) rows.push({label: 'Quote', value: String(d.quoteId)});
  return rows;
}

export function approvalRows(approval: Approval, contacts: Contact[] = []): {label: string; value: string}[] {
  const details = approval.details ?? {};
  if (approval.effect === 'financial' && Array.isArray(details.items) && typeof details.total === 'number') return purchaseRows(details);
  return Object.entries(details)
    .filter(([k, v]) => v !== undefined && v !== null && v !== '' && !(k === 'contactId' && 'to' in details))
    .map(([k, v]) => {
      // A message or call names who it reaches, and the exact number it will use.
      if (k === 'to' && typeof details.contactId === 'string') {
        const who = contacts.find(c => c.id === details.contactId);
        return {label: 'To', value: who ? `${who.name} · ${String(v)}` : `${String(v)} · not in your contacts`};
      }
      return {label: ROW_LABEL[k] ?? humanise(k), value: typeof v === 'object' ? JSON.stringify(v, null, 1) : String(v)};
    });
}

/** What a task is called on screen: its own title when the server gave it one, else what was asked. */
export const runTitle = (run: Run) => run.title || run.task;

export function humanise(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Capability flags the UI uses to hide what the gateway genuinely cannot do. */
export function unavailableReason(c: Connections | null, feature: keyof Connections): string | null {
  if (!c) return 'Checking what this employee can do…';
  return c[feature] ? null : 'Not set up on this server yet.';
}

export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  if (ms < 60_000) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Speech arrives as segments that are re-sent as they are refined, so a segment
 * already on screen is replaced in place rather than appended. Appending is what
 * produces the stuttering duplicate-line transcript.
 */
export function applyTranscript(list: TranscriptEntry[], entry: TranscriptEntry): TranscriptEntry[] {
  const at = list.findIndex(t => t.id === entry.id);
  if (at < 0) return [...list, entry];
  // A final segment must not be overwritten by a late interim one for the same id.
  if (list[at]!.final && !entry.final) return list;
  const next = [...list];
  next[at] = entry;
  return next;
}

/** Cards are addressed by uuid: reusing one updates that card in place. */
export function applyCard(list: Card[], card: Card): Card[] {
  const at = list.findIndex(c => c.uuid === card.uuid);
  if (at < 0) return [...list, card];
  const next = [...list];
  next[at] = card;
  return next;
}

export const dismissCard = (list: Card[], uuid: string): Card[] => list.filter(c => c.uuid !== uuid);

// --- procurement ----------------------------------------------------------

/**
 * A total is only shown when every component the supplier owed us is present.
 * Adding up what we happen to know and calling it the total is how a person
 * ends up comparing a shipped price against an unshipped one.
 */
export function offerTotal(offer: Offer): {subtotal: number; total: number | null} {
  const subtotal = Math.round(offer.unitPrice * offer.quantity * 100) / 100;
  const {shipping, tax, fees} = offer;
  if (shipping === null || tax === null || fees === null) return {subtotal, total: null};
  return {subtotal, total: Math.round((subtotal + shipping + tax + fees) * 100) / 100};
}

export const money = (amount: number, currency: string) => {
  try {return new Intl.NumberFormat(undefined, {style: 'currency', currency}).format(amount);}
  catch {return `${amount.toFixed(2)} ${currency}`;}
};

/** "Not reported" and "not available" are different answers and must not read alike. */
export function fulfillmentLabel(f: Fulfillment | undefined, channel: 'Pickup' | 'Delivery'): string {
  if (!f || f.available === null) return `${channel}: not reported`;
  if (!f.available) return `${channel}: not available`;
  // Available with no place or date given still says so, rather than a bare "Delivery".
  return f.location || f.eta ? [channel, f.location, f.eta].filter(Boolean).join(' · ') : `${channel}: available`;
}

export const MATCH_LABEL: Record<Offer['matchQuality'], string> = {
  exact: 'Matches your description',
  candidate: 'Possible match — check before buying',
  unverified: 'Weak match — check before buying',
};

export const SUPPLIER_STATUS_LABEL: Record<SupplierStatus, string> = {
  ok: 'Searched',
  failed: "Didn't answer",
  timeout: 'Too slow to answer',
  unconfigured: 'Not connected',
};

/** What a person needs to know before trusting a comparison: how much of it is missing. */
export function supplierSummary(reports: SupplierReport[] | undefined) {
  const list = reports ?? [];
  const answered = list.filter(r => r.status === 'ok');
  const missing = list.filter(r => r.status !== 'ok');
  return {
    total: list.length,
    answered: answered.length,
    missing,
    complete: list.length > 0 && missing.length === 0,
    checkedAt: answered.map(r => r.checkedAt).sort().at(-1),
  };
}

export const ACCESS_METHOD_LABEL: Record<AccessMethod, string> = {
  official_api: 'Supplier API',
  partner_api: 'Partner catalog',
  mcp: 'Connected tool',
  browser: 'Browser',
  manual: 'Manual connection',
  web_search: 'Web search',
};

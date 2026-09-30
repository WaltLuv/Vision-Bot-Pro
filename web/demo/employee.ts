// The preview's employee. In a claude.ai viewer that allows it, Claude does the
// work: it reads what a runtime gets from the gateway (who the employee is, its
// skills, memory, contacts, recent results) and acts through the tools below,
// which raise the same approvals the gateway's tools raise and wait for the
// owner's decision. Anywhere else -- a local build, a test, a viewer who
// declines -- a scripted employee runs the same tools for the kinds of task it
// recognizes. Either way the services behind the tools are simulated: nothing
// is really sent, called, browsed or bought, and the page says so.
import type {Contact, Run} from '../src/api';
import {browse} from './browser';
import {addArtifact, ask, emit, newId, now, preview, runById, updateRun, type Decision} from './gateway';
import {compare, offerTotal, orderNumber, quoteFor, type Quote, type Search} from './suppliers';

// --- asking Claude ---------------------------------------------------------

interface SampleTool {name: string; description: string; inputSchema: object; execute(input: Record<string, unknown>, context: {signal: AbortSignal}): unknown}
type Sample = ((input: string, options?: {signal?: AbortSignal; tools?: SampleTool[]; images?: Blob[]; modelTier?: 'quick' | 'default' | 'complex'; cache?: boolean}) => Promise<{text: string; truncated: boolean}>)
  & {limits?(): Promise<{images?: {maxCount: number}; tools?: {maxCount: number}}>};

let sample: Sample | null = null;
const can = {images: 0, tools: 0};
/** Why Claude will not answer in this view, once it has said so. Every later task is scripted. */
let refused: string | null = null;

/** The page's way to ask Claude: only a claude.ai viewer offers one, and it can take a few seconds to say so. */
const ready: Promise<void> = (async () => {
  const host = (globalThis as {claude?: {use?(name: string): Promise<unknown>}}).claude;
  if (typeof host?.use !== 'function') return;
  const found = await host.use('sample').catch(() => null);
  if (typeof found !== 'function') return;
  sample = found as Sample;
  const limits = await sample.limits?.().catch(() => null);
  can.images = limits?.images?.maxCount ?? 0;
  can.tools = limits?.tools?.maxCount ?? 0;
  preview.claudeReady = true;
  emit('connections.updated');
})();

const DECLINED = 'You did not allow this preview to use Claude, so its scripted employee answered instead. Reload the page and allow it to get real answers.';
const UNAVAILABLE_NOTE = 'Claude is not available to this page for your account, so the preview\'s scripted employee answered instead.';
// Claude will not answer in this view at all.
const UNAVAILABLE = new Set(['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed']);
const FAILED_DEFAULT = 'Claude could not be reached. Try again in a moment.';
const FAILED: Record<string, string> = {
  rate_limited: 'Too many requests to Claude just now, or your usage limit was reached. Try again later.',
  session_expired: 'Your claude.ai sign-in expired. Sign in again, then send the task again.',
  refused: 'Claude declined this request. Try asking it differently.',
  empty_completion: 'Claude returned no answer. Try asking it differently.',
  prompt_too_large: 'That was too much to send at once. Try a shorter request.',
  image_rejected: 'The photo could not be used. Try sending another one.',
};

// --- the tools ---------------------------------------------------------------

/** A page tool is stopped after 150 s, so an approval it waits on gets a little less. */
const CLAUDE_WAIT = 140_000;
/** The gateway's own approval lifetime, for the scripted employee. */
const OWNER_WAIT = 30 * 60_000;

const money = (n: number) => new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format(n);
const whole = (v: unknown, fallback: number) => {const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 1 ? Math.min(n, 100_000) : fallback;};
const positive = (v: unknown) => {const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(n, 100_000) : null;};
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) {reject(new Error('Stopped.')); return;}
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => {clearTimeout(timer); reject(new Error('Stopped.'));}, {once: true});
});
const declined = (d: Decision, result: string) => ({status: d.kind === 'denied' ? 'declined by the owner' : d.kind === 'expired' ? 'not approved in time' : 'stopped', result});

const PRICES: [RegExp, number][] = [
  [/\b(bolt|screw|nut|washer|anchor|nail|rivet)s?\b/i, 0.85], [/cartridge/i, 42], [/\b(faucet|tap)s?\b/i, 129], [/water heater/i, 649],
  [/\btoilet/i, 189], [/\b(2\s?x\s?4|stud|lumber|board|plank)s?\b/i, 4.98], [/plywood|drywall|sheetrock/i, 16.5], [/\bpaint\b/i, 36],
  [/\b(bulb|lamp)s?\b/i, 5.5], [/filter/i, 14], [/caulk|sealant|silicone/i, 7.5], [/\b(pipe|fitting|elbow|coupling)s?\b/i, 3.2],
];
const guessPrice = (item: string) => PRICES.find(([pattern]) => pattern.test(item))?.[1] ?? 19.99;

function contact(name: unknown): Contact {
  const wanted = String(name ?? '').trim().toLowerCase();
  const all = preview.state.contact;
  const exact = all.find(c => String(c.name ?? '').toLowerCase() === wanted);
  if (exact) return exact;
  const close = wanted ? all.filter(c => {const n = String(c.name ?? '').toLowerCase(); return n.includes(wanted) || wanted.includes(n) || n.split(' ').includes(wanted);}) : [];
  if (close.length === 1) return close[0]!;
  throw new Error(close.length ? `More than one contact matches "${String(name)}": ${close.map(c => c.name).join(', ')}.`
    : `No contact matches "${String(name)}". The owner can add them under Employee, then ask again.`);
}

const REPLIES = ['Thanks, got it!', 'Sounds good, thank you.', 'OK, see you then.'];
/** A reply comes back as its own task, the way the gateway turns an incoming text into one. */
function replyLater(who: Contact) {
  const reply = REPLIES[Math.floor(Math.random() * REPLIES.length)]!;
  setTimeout(() => {
    if (!preview.signedIn || !preview.state.contact.some(c => c.id === who.id)) return;
    const run: Run = {id: newId('run'), title: `Text from ${who.name}: "${reply}"`, task: `${who.name} (${who.phone}) texted: "${reply}"`, status: 'working',
      createdAt: now(), conversationId: newId('conv'), context: {source: 'webhook', attachments: []}};
    preview.state.run.unshift(run);
    preview.state.communication.unshift({id: newId('comm'), channel: 'sms', direction: 'inbound', from: who.phone, contactId: who.id, body: reply, status: 'received', at: now()});
    emit('communication.updated');
    emit('run.updated', {runId: run.id, status: run.status});
    setTimeout(() => updateRun(run.id, {status: 'completed', result: `${String(who.name).split(' ')[0]} replied: "${reply}" Nothing else is needed from you.`}), 2500);
  }, 9000);
}

function placeOrder(runId: string, quote: Quote) {
  const order = {id: newId('order'), runId, supplier: quote.supplier, orderNumber: orderNumber(quote), total: quote.total, currency: quote.currency, status: 'confirmed', fulfillment: quote.fulfillment};
  preview.state.order.unshift(order);
  addArtifact(runId, 'Buy this', [['Supplier', quote.supplier], ...quote.items.map(i => ['Item', `${i.quantity} × ${i.name}, ${money(i.unitPrice)} each`] as [string, string]),
    ['Total', `${money(quote.total)} ${quote.currency}`], ['How you get it', quote.fulfillment], ['Order', order.orderNumber],
    ['Price', 'checked again with the supplier before ordering'], ['Preview', 'nothing was really bought']]);
  emit('tool.completed', {runId});
  return order;
}

type Result = Record<string, any>;
interface Tool {name: string; description: string; inputSchema: {type: 'object'; properties: Record<string, object>; required?: string[]}; run(runId: string, input: Record<string, unknown>, signal: AbortSignal, waitMs: number): Promise<Result>}

const TOOLS: Tool[] = [
  {name: 'send_text', description: 'Send a text message to one of the owner\'s contacts. The owner must approve the exact message on their phone first; this waits for their decision and returns whether it was sent.',
    inputSchema: {type: 'object', properties: {contact: {type: 'string', description: 'The contact\'s name, as in the contact list'}, message: {type: 'string', description: 'The exact text to send'}}, required: ['contact', 'message']},
    async run(runId, input, signal, waitMs) {
      const who = contact(input.contact), body = String(input.message ?? '').trim().slice(0, 1600);
      if (!body) throw new Error('The message is empty.');
      const d = await ask(runId, {tool: 'sms_send', label: 'Send this text', effect: 'communication', details: {contactId: who.id, to: who.phone, body}}, waitMs, signal);
      if (d.kind !== 'approved') return declined(d, 'nothing was sent');
      preview.state.communication.unshift({id: newId('comm'), channel: 'sms', direction: 'outbound', to: who.phone, contactId: who.id, body, status: 'delivered', at: now()});
      addArtifact(runId, 'Send this text', [['To', `${who.name} · ${who.phone}`], ['Message', body], ['Status', 'delivered'], ['Preview', 'nothing was really sent']]);
      emit('tool.completed', {runId});
      replyLater(who);
      return {status: 'sent', name: who.name, phone: who.phone, message: body, note: 'Preview: the text was not really sent. A reply will show up as its own task.'};
    }},
  {name: 'place_call', description: 'Phone one of the owner\'s contacts to achieve an objective. The owner approves the call first; this waits for their decision and returns how the call went.',
    inputSchema: {type: 'object', properties: {contact: {type: 'string', description: 'The contact\'s name, as in the contact list'}, objective: {type: 'string', description: 'What the call should achieve'}}, required: ['contact', 'objective']},
    async run(runId, input, signal, waitMs) {
      const who = contact(input.contact), objective = String(input.objective ?? '').trim().slice(0, 4000);
      if (!objective) throw new Error('Say what the call is for.');
      const d = await ask(runId, {tool: 'phone_call', label: 'Place this call', effect: 'communication', details: {contactId: who.id, to: who.phone, objective}}, waitMs, signal);
      if (d.kind !== 'approved') return declined(d, 'no call was placed');
      await sleep(5000, signal);
      addArtifact(runId, 'Place this call', [['To', `${who.name} · ${who.phone}`], ['What the call is for', objective], ['Preview', 'no real call was placed, so there is no transcript']]);
      emit('tool.completed', {runId});
      return {status: 'call simulated', name: who.name, phone: who.phone, note: 'Preview: no real call was placed, so there is no transcript or outcome. A real call returns both here.'};
    }},
  {name: 'compare_prices', description: 'Ask every connected supplier at once for one item. Returns comparable offers (unit price, total with tax and shipping, stock, pickup and delivery, how well each matches) and which suppliers did not answer. The owner sees the comparison under Tasks. Use before buying.',
    inputSchema: {type: 'object', properties: {
      item: {type: 'string', description: 'What to buy, with size, material and model where known'}, quantity: {type: 'integer', minimum: 1},
      specification: {type: 'string', description: 'Requirements a match must meet, such as grade or finish'},
      typical_unit_price_usd: {type: 'number', description: 'Your best estimate of a typical US retail price for one unit; the preview\'s sample catalogs price around it'}},
    required: ['item', 'quantity', 'typical_unit_price_usd']},
    async run(runId, input, signal) {
      const item = String(input.item ?? '').trim().slice(0, 120);
      if (!item) throw new Error('Say which item to price.');
      const search: Search = {item, quantity: whole(input.quantity, 1), specification: String(input.specification ?? '').trim().slice(0, 200), typicalUnitPrice: positive(input.typical_unit_price_usd) ?? guessPrice(item)};
      await sleep(1800, signal);
      const {material, offers} = compare(runId, search);
      preview.state.material.unshift(material);
      preview.state.offer.unshift(...offers);
      emit('tool.completed', {runId});
      const reports = material.suppliers ?? [];
      return {asked: reports.length, answered: reports.filter(r => r.status === 'ok').length, not_answering: reports.filter(r => r.status !== 'ok').map(r => r.name), quantity: search.quantity,
        offers: offers.map(o => ({offer_id: o.id, supplier: o.supplier, product: o.product, match: o.matchQuality, unit_price: o.unitPrice, total: offerTotal(o),
          pickup: o.pickup.available ? `${o.pickup.eta}, ${o.pickup.location}` : 'not available', delivery: o.delivery.eta, stock: o.availability, note: o.specification})),
        note: 'Preview: sample catalogs, not live prices. A total of null means a charge was not quoted.'};
    }},
  {name: 'buy', description: 'Buy one offer from compare_prices. Gets the supplier\'s exact quote, shows the owner every term (items, tax, delivery, total, how it arrives) to approve, and places the order only if they approve. Returns the order number, or why nothing was bought.',
    inputSchema: {type: 'object', properties: {offer_id: {type: 'string'}, quantity: {type: 'integer', minimum: 1}, fulfillment: {type: 'string', enum: ['pickup', 'delivery']}}, required: ['offer_id', 'quantity', 'fulfillment']},
    async run(runId, input, signal, waitMs) {
      const offer = preview.state.offer.find(o => o.id === String(input.offer_id ?? ''));
      if (!offer) throw new Error('No offer has that id. Use an offer_id from compare_prices.');
      const quote = quoteFor(offer, whole(input.quantity, offer.quantity), input.fulfillment === 'delivery' ? 'delivery' : 'pickup');
      const d = await ask(runId, {tool: 'purchase_order', label: 'Buy this', effect: 'financial', details: quote}, waitMs, signal);
      if (d.kind !== 'approved') return declined(d, 'nothing was bought');
      if (Date.now() > Date.parse(quote.expiresAt)) return {status: 'quote expired', result: 'nothing was bought'};
      const order = placeOrder(runId, quote);
      return {status: 'ordered', order_number: order.orderNumber, supplier: quote.supplier, total: quote.total, fulfillment: quote.fulfillment, note: 'Preview: nothing was really bought.'};
    }},
  {name: 'use_browser', description: 'Do a web task in a browser the owner can watch live and take over. The owner approves first. In this preview the browser only reaches a sample shop site, not the real web: use it to find a product with its price and stock. Returns what was found.',
    inputSchema: {type: 'object', properties: {task: {type: 'string', description: 'What to do on the web'}, search: {type: 'string', description: 'What to type into the site\'s search box'},
      typical_unit_price_usd: {type: 'number', description: 'Your best estimate of a typical US retail price, which the sample site prices around'}}, required: ['task', 'search']},
    async run(runId, input, signal, waitMs) {
      const task = String(input.task ?? '').trim().slice(0, 1000), search = String(input.search ?? '').trim().slice(0, 80) || task.slice(0, 80);
      if (!task) throw new Error('Say what to do in the browser.');
      const started = Date.now();
      // Leave time to browse after the approval, inside the tool's own limit.
      const d = await ask(runId, {tool: 'browser_work', label: 'Let a browser do this web task', effect: 'computer', details: {task}}, waitMs - 40_000, signal);
      if (d.kind !== 'approved') return declined(d, 'no browser was opened');
      return {...await browse(runId, task, search, positive(input.typical_unit_price_usd) ?? guessPrice(search), signal, waitMs - (Date.now() - started))};
    }},
  {name: 'ask_owner', description: 'Ask the owner a question when a detail you need is missing. Waits for their written answer and returns it.',
    inputSchema: {type: 'object', properties: {question: {type: 'string'}}, required: ['question']},
    async run(runId, input, signal, waitMs) {
      const question = String(input.question ?? '').trim().slice(0, 1000);
      if (!question) throw new Error('Ask a question.');
      const d = await ask(runId, {tool: 'ask_user', label: 'Your employee has a question', effect: 'sensitive', details: {question}}, waitMs, signal);
      if (d.kind === 'approved' && d.answer) return {answer: d.answer};
      return {answer: null, note: d.kind === 'approved' ? 'The owner sent no written answer.' : d.kind === 'denied' ? 'The owner chose not to answer.' : 'No answer came in time.'};
    }},
  {name: 'remember', description: 'Save something the owner wants remembered from now on. It appears under Employee, What it remembers.',
    inputSchema: {type: 'object', properties: {text: {type: 'string'}, kind: {type: 'string', enum: ['profile', 'work', 'note']}}, required: ['text']},
    async run(runId, input) {
      const text = String(input.text ?? '').trim().slice(0, 4000);
      if (!text) throw new Error('Say what to remember.');
      preview.state.memory.unshift({id: newId('memory'), kind: (['profile', 'work', 'note'] as const).find(k => k === input.kind) ?? 'note', text});
      emit('tool.completed', {runId});
      return {saved: true};
    }},
];
const tool = (name: string) => TOOLS.find(t => t.name === name)!;

// --- what Claude is told ------------------------------------------------------

const WITH_TOOLS = [
  'You are working inside a preview of the app. Your tools reach simulated services: a text or call reaches nobody, the browser only reaches a sample shop site, supplier prices come from sample catalogs, and an order buys nothing. The owner knows this. Use the tools exactly as you would for real, report what they return, and never say something happened unless a tool reported it. You cannot look anything up on the real web.',
  'Anything that texts, calls, uses the browser or spends money waits for the owner\'s approval on their phone: the tool asks and returns their decision. If they decline, accept it and do not try another way. Use ask_owner only for a detail you cannot do without. To buy something, compare prices first, then buy the best exact match that fits what you remember about the owner.',
].join('\n\n');
const WITHOUT_TOOLS = 'You are working inside a preview of the app and have no tools in this view, so reply in writing only. You cannot browse the web, text, call, save or buy anything, and must never say that you did. When a task needs one of those, answer what you can and say in one sentence what you would do once connected.';

function brief(run: Run, photo: 'attached' | 'not passed' | 'none', tools: boolean): string {
  const s = preview.state, agent = s.agent[0]!;
  const skills = s.skill.filter(k => agent.skills.includes(k.id));
  const recent = s.run.filter(r => r.id !== run.id && r.status === 'completed' && r.result).slice(0, 4);
  const material = s.material[0];
  const offers = material ? s.offer.filter(o => o.requestId === material.id) : [];
  return [
    `You are ${agent.name}, the owner's AI employee in the Vision-Bot-Pro phone app (${agent.title}). ${agent.instructions}`,
    skills.length ? `Your skills:\n${skills.map(k => `- ${k.name}: ${k.instructions}`).join('\n')}` : '',
    s.memory.length ? `What you remember about the owner:\n${s.memory.map(m => `- ${m.text}`).join('\n')}` : '',
    `The owner's contacts. Texts and calls can only go to these people:\n${s.contact.length ? s.contact.map(c => `- ${c.name}, ${c.phone}${c.organization ? `, ${c.organization}` : ''}`).join('\n') : '- none yet (the owner adds people under Employee)'}`,
    recent.length ? `Recent tasks, newest first:\n${recent.map(r => `- ${r.title || r.task}\n  Result: ${String(r.result).slice(0, 400)}`).join('\n')}` : '',
    material && offers.length ? `Latest price comparison, for ${material.description}:\n${offers.map(o => {const total = offerTotal(o); return `- offer_id ${o.id}: ${o.supplier}, ${o.product}, ${money(o.unitPrice)} each, total ${total === null ? 'not fully quoted' : money(total)}, ${o.matchQuality} match`;}).join('\n')}` : '',
    tools ? WITH_TOOLS : WITHOUT_TOOLS,
    photo === 'attached' ? 'The owner sent the attached photo from the phone camera with this task. In this preview the camera shows a drawn sample scene unless the owner picked a photo of their own; describe what is actually in the image.' : '',
    photo === 'not passed' ? 'The owner sent a photo with this task, but it could not be passed to you in this view. Say so in one sentence.' : '',
    run.context?.visualDescription ? `What the camera showed: ${run.context.visualDescription}` : '',
    'Write your final answer for a phone screen: a few short sentences or a short list, under 120 words. **Bold** and "- " bullet lines are fine; no headings, tables or links. Mention that the preview simulated something at most once.',
    `Task: ${run.task}`,
  ].filter(Boolean).join('\n\n');
}

// --- the scripted employee ---------------------------------------------------

type Plan =
  | {kind: 'text'; contact: Contact; message: string}
  | {kind: 'call'; contact: Contact; objective: string}
  | {kind: 'prices'; search: Search; buy: boolean}
  | {kind: 'browse'; task: string; search: Search}
  | {kind: 'remember'; text: string};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function searchFor(task: string): Search {
  let item = task.trim()
    .replace(/^(please\s+)?(can you\s+)?/i, '')
    .replace(/^(compare|check|find|get|look\s+up|search(\s+for)?|price|buy|order|purchase|how much (is|are))\s+(the\s+)?((prices?|pricing|cost)\s+(of|for|on)\s+)?/i, '')
    .replace(/\s+(online|on the web|on a website)\b.*$/i, '')
    .split(/\s+for\s+(?:the|my|our)\b/i)[0]!.trim();
  const count = item.match(/^(\d{1,5})\s+/);
  if (count) item = item.slice(count[0].length);
  item = item.replace(/^(a|an|the|some)\s+/i, '').trim() || 'Item';
  return {item: item.charAt(0).toUpperCase() + item.slice(1), quantity: count ? Number(count[1]) : 1, specification: '', typicalUnitPrice: guessPrice(item)};
}

function draft(task: string, who: Contact): string {
  const name = String(who.name), first = name.split(' ')[0]!;
  let rest = task.replace(new RegExp(`^.*?\\b(text|sms|message)\\b(\\s+to)?\\s+(${escape(name)}|${escape(first)})\\b[\\s,:]*`, 'i'), '').replace(/^(that|saying|to say)\s+/i, '').trim() || task.trim();
  if (!/^(I\b|I'|[A-Z]{2})/.test(rest)) rest = rest.charAt(0).toLowerCase() + rest.slice(1);
  return `Hi ${first}, ${rest}${/[.!?]$/.test(rest) ? '' : '.'}`;
}

/** The kinds of task the scripted employee knows, from the words used. */
function route(task: string): Plan | null {
  const t = task.trim();
  const who = preview.state.contact.find(c => {const name = String(c.name ?? ''); return !!name && [name, name.split(' ')[0]!].some(n => new RegExp(`\\b${escape(n)}\\b`, 'i').test(t));});
  if (/^(please\s+)?remember\b|\bremember that\b/i.test(t)) return {kind: 'remember', text: t.replace(/^(please\s+)?remember(\s+that)?[\s:,]*/i, '').trim() || t};
  if (who && /\b(text|sms|message)\b/i.test(t)) return {kind: 'text', contact: who, message: draft(t, who)};
  if (who && /\b(call|phone|ring)\b/i.test(t)) return {kind: 'call', contact: who, objective: t};
  if (/\b(buy|order|purchase)\b/i.test(t)) return {kind: 'prices', search: searchFor(t), buy: true};
  if (/\b(price|prices|pricing|compare|cost|quote|cheapest|how much)\b/i.test(t)) return {kind: 'prices', search: searchFor(t), buy: false};
  if (/\b(browse|browser|website|online|look\s+up|search)\b/i.test(t)) return {kind: 'browse', task: t, search: searchFor(t)};
  return null;
}

const HELP = [
  'This preview is running without Claude, so a scripted employee answered. It knows these kinds of task:',
  '- Text Maria that the plumber is running late',
  '- Call Joe Park to confirm Thursday at 10',
  '- Compare prices for 10 shower cartridges',
  '- Buy 40 M6 stainless bolts',
  '- Look up a Moen 1222 cartridge online',
  '- Remember that the gate code is 4412',
  'Open this page on claude.ai or in the Claude app and allow it to use Claude when asked, and your employee answers anything.',
].join('\n');
const PHOTO_HELP = 'The scripted employee cannot look at photos. With Claude allowed, your employee describes what the camera shows and answers your question about it.';

const notDone = (r: Result, what: string) => r.status === 'declined by the owner' ? `You chose not to allow the ${what}, so nothing happened.`
  : r.status === 'not approved in time' ? `The ${what} waited too long for your approval, so nothing happened.` : '';

async function carryOut(runId: string, plan: Plan, signal: AbortSignal): Promise<string> {
  const use = (name: string, input: Record<string, unknown>) => tool(name).run(runId, input, signal, OWNER_WAIT);
  if (plan.kind === 'remember') {
    await use('remember', {text: plan.text, kind: 'note'});
    return `I'll remember that: "${plan.text}". It is under Employee, What it remembers.`;
  }
  if (plan.kind === 'text') {
    const r = await use('send_text', {contact: plan.contact.name, message: plan.message});
    return r.status === 'sent' ? `Sent to **${r.name}** (${r.phone}) after you approved it: "${r.message}"\n\nIn this preview nothing really went out. A reply shows up here as its own task.` : notDone(r, `text to ${plan.contact.name}`);
  }
  if (plan.kind === 'call') {
    const r = await use('place_call', {contact: plan.contact.name, objective: plan.objective});
    return r.status === 'call simulated' ? `Called **${r.name}** (${r.phone}) after you approved it.\n\nIn this preview no real call was placed, so there is no transcript. A real call adds its transcript and outcome here.` : notDone(r, `call to ${plan.contact.name}`);
  }
  if (plan.kind === 'browse') {
    const r = await use('use_browser', {task: plan.task, search: plan.search.item, typical_unit_price_usd: plan.search.typicalUnitPrice});
    if (r.status !== 'done') return notDone(r, 'browser') || `The browser task ended early: ${r.status}.`;
    return `On the sample shop site I found **${r.found.name}** at ${money(r.found.price)}: ${r.found.stock}, ${r.found.pickup.toLowerCase()}. I stopped there; buying goes through an exact quote you approve.\n\nIn this preview the browser only reaches a sample site, not the real web.`;
  }
  const prices = await use('compare_prices', {item: plan.search.item, quantity: plan.search.quantity, typical_unit_price_usd: plan.search.typicalUnitPrice});
  const exact = (prices.offers as Result[]).filter(o => o.match === 'exact' && typeof o.total === 'number').sort((a, b) => a.total - b.total);
  const best = exact[0];
  const summary = [`${prices.answered} of ${prices.asked} suppliers answered.`,
    best ? `The cheapest exact match is **${best.supplier}**: ${money(best.total)} for ${prices.quantity}${best.pickup !== 'not available' ? `, pickup ${best.pickup.toLowerCase()}` : `, delivered ${best.delivery}`}.` : 'None of them had an exact match.',
    prices.not_answering.length ? `${prices.not_answering.join(' and ')} did not answer in time, so there may be a better price.` : '',
    'The comparison is under Tasks; its prices come from the preview\'s sample catalogs.'].filter(Boolean).join(' ');
  if (!plan.buy || !best) return summary;
  // Pickup when the yard offers it, as the owner's memory prefers.
  const r = await use('buy', {offer_id: best.offer_id, quantity: prices.quantity, fulfillment: best.pickup !== 'not available' ? 'pickup' : 'delivery'});
  // The outcome first: it is what the owner is waiting to hear, and Today shows the start of a result.
  if (r.status !== 'ordered') return `${notDone(r, 'purchase') || 'The quote expired before you decided, so nothing was bought.'}\n\n${summary}`;
  return `Ordered from **${r.supplier}** after you approved the exact quote: ${money(r.total)}, order ${r.order_number}. ${r.fulfillment}.\n\n${summary}\n\nIn this preview nothing was really bought.`;
}

// --- running a task ----------------------------------------------------------

const running = new Map<string, AbortController>();

export function startTask(run: Run) {
  const stop = new AbortController();
  running.set(run.id, stop);
  void work(run, stop.signal)
    .catch(err => {if (!stop.signal.aborted) updateRun(run.id, {status: 'failed', error: err instanceof Error ? err.message : 'That did not finish.'});})
    .finally(() => running.delete(run.id));
}

export function stopTask(runId: string) {running.get(runId)?.abort();}

const finish = (runId: string, result: string) => {if (result) updateRun(runId, {status: 'completed', result});};

async function work(run: Run, signal: AbortSignal): Promise<void> {
  await ready;
  const plan = route(run.task);
  const photos = (run.context?.attachments ?? []).flatMap(id => preview.uploads.get(id) ?? []);
  if (sample && !refused && (can.tools || !plan)) return withClaude(run, signal, photos, can.tools > 0);
  await sleep(1200, signal);
  const lead = refused ? `${refused}\n\n` : '';
  finish(run.id, lead + (plan ? await carryOut(run.id, plan, signal) : photos.length ? PHOTO_HELP : HELP));
}

async function withClaude(run: Run, signal: AbortSignal, photos: Blob[], tools: boolean): Promise<void> {
  const images = photos.slice(0, can.images);
  try {
    const {text, truncated} = await sample!(brief(run, images.length ? 'attached' : photos.length ? 'not passed' : 'none', tools), {
      signal, modelTier: 'default',
      // A call with tools is never cached; a plain one must not replay an old answer either.
      ...(tools ? {tools: TOOLS.slice(0, can.tools).map(t => ({name: t.name, description: t.description, inputSchema: t.inputSchema,
        execute: (input: Record<string, unknown>, context: {signal: AbortSignal}) => t.run(run.id, input, context.signal, CLAUDE_WAIT)}))} : {cache: false}),
      ...(images.length ? {images} : {}),
    });
    finish(run.id, truncated ? `${text}\n\n(The answer was cut short. Ask for less at a time.)` : text);
  } catch (err) {
    const code = String((err as {code?: unknown} | null)?.code ?? 'upstream_error');
    if (code === 'cancelled' || signal.aborted) return;
    if (code === 'tools_unavailable') {can.tools = 0; return work(run, signal);}
    if (code === 'images_unavailable') {can.images = 0; return work(run, signal);}
    if (UNAVAILABLE.has(code)) {
      refused = code === 'not_granted' ? DECLINED : UNAVAILABLE_NOTE;
      preview.claudeReady = false;
      emit('connections.updated');
      return work(run, signal);
    }
    updateRun(run.id, {status: 'failed', error: FAILED[code] ?? FAILED_DEFAULT});
  }
}

/** The sample purchase waiting for approval when the preview opens: deciding it places, or drops, the order. */
export function resumeSampleOrder() {
  const run = runById('run-order'), offer = preview.state.offer.find(o => o.id === 'offer-RS-118');
  if (run?.status !== 'needs_user' || !offer) return;
  const quote = quoteFor(offer, 40, 'pickup');
  void ask(run.id, {tool: 'purchase_order', label: 'Buy this', effect: 'financial', details: quote}, OWNER_WAIT).then(d => {
    if (d.kind === 'cancelled') return;
    if (d.kind !== 'approved') {finish(run.id, d.kind === 'denied' ? 'You declined the purchase, so nothing was bought.' : 'The quote expired before you decided, so nothing was bought.'); return;}
    const order = placeOrder(run.id, quote);
    finish(run.id, `Ordered from **Riverside Building Supply** after you approved the exact quote: 40 × M6 × 40mm A4 stainless hex bolts, **${money(quote.total)}**. Order ${order.orderNumber}, ready for pickup today at the Riverside yard.\n\nIn this preview nothing was really bought.`);
  });
}

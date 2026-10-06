// Connected apps in the preview: the viewer's own Gmail and Google Calendar,
// reached through their claude.ai connectors. The page never sees a token; a
// call goes out as the viewer, and claude.ai asks them first whether this page
// may use each one.
//
// These are real accounts. Reading is free. Saving a draft, sending an email
// or adding an event waits for the owner's approval in the app every time,
// with the exact message or event on the card -- the app's own rule for its
// connected apps -- and none of them can be "always allowed".
import type {AppConnection} from '../src/api';
import {addArtifact, ask, emit, HttpError, now, preview, step, type Decision} from './gateway';

interface McpError {code?: unknown; message?: unknown}
interface ServerInfo {server: string; authStatus?: string; tools?: {name: string}[]}
interface Mcp {
  callTool(server: string, tool: string, input?: unknown, options?: {cache?: false}): Promise<{payload?: unknown; content?: unknown}>;
  listTools(server?: string): Promise<{servers: ServerInfo[]}>;
}
interface Permissions {state(name: string): Promise<string>; request(names: string[]): Promise<Record<string, string>>}

interface App {id: string; server: string; name: string; category: string; description: string}
const GMAIL: App = {id: 'gmail', server: 'Gmail', name: 'Gmail', category: 'Email', description: 'Read and send email through your Gmail account.'};
const CALENDAR: App = {id: 'googlecalendar', server: 'Google Calendar', name: 'Google Calendar', category: 'Calendar', description: 'Check your schedule and add the events you approve.'};
const APPS = [GMAIL, CALENDAR];

let mcp: Mcp | null = null;
let permissions: Permissions | null = null;
/** Why an app cannot be used right now, from what claude.ai last said about it; shown on its row. */
const problem = new Map<string, string>();
const checkedAt = new Map<string, string>();

const ADD = (app: App) => `${app.name} is not connected to your Claude account yet. Add it in claude.ai under Settings, Connectors, then tap Try again.`;
const REAUTH = (app: App) => `${app.name} needs to be reconnected in claude.ai under Settings, Connectors. Then tap Try again.`;
const DECLINED = (app: App) => `You did not allow this page to use ${app.name}. Allow it in this page's permissions on claude.ai, then tap Try again.`;

const consent = async (app: App) => (permissions ? await permissions.state(`mcp:${app.server}`).catch(() => 'unavailable') : 'prompt');
const byId = (id: string) => {
  const app = APPS.find(a => a.id === id);
  if (!app) throw new HttpError(404, 'That app is not part of this preview. Gmail and Google Calendar are.');
  return app;
};

/** The viewer's connectors, once the viewer says this page can reach them. Nothing is asked at load. */
export const appsReady: Promise<void> = (async () => {
  const host = (globalThis as {claude?: {use?(name: string): Promise<unknown>}}).claude;
  if (typeof host?.use !== 'function') return;
  const [m, p] = await Promise.all([host.use('mcp').catch(() => null), host.use('permissions').catch(() => null)]);
  if (!m) return;
  mcp = m as Mcp;
  permissions = p as Permissions | null;
  // Listing never asks the viewer anything; it says which allowed connectors are missing or need signing in again.
  const listed = await mcp.listTools().catch(() => null);
  for (const app of APPS) if (listed && await consent(app) === 'granted') judge(app, listed.servers.find(s => s.server === app.server));
  emit('connections.updated');
})();

/** What a listing says about an app the viewer allowed: there and signed in, or why not. */
function judge(app: App, info: ServerInfo | undefined) {
  if (!info || !info.tools?.length) problem.set(app.id, ADD(app));
  else if (info.authStatus === 'needs_reauth') problem.set(app.id, REAUTH(app));
  else problem.delete(app.id);
}

async function row(app: App): Promise<AppConnection> {
  const base = {id: app.id, name: app.name, category: app.category, connectedLabel: null, connectedEmail: null, lastCheckedAt: checkedAt.get(app.id) ?? null};
  if (preview.appsOff.has(app.id)) return {...base, status: 'revoked', description: `${app.description} Disconnected here, so your employee will not use it.`};
  const why = problem.get(app.id);
  if (why) return {...base, status: 'failed', description: why};
  const c = await consent(app);
  if (c === 'denied') return {...base, status: 'failed', description: DECLINED(app)};
  return {...base, status: c === 'granted' ? 'connected' : 'not_connected', description: app.description};
}

/** What the gateway stand-in answers for Settings, Connected apps. */
export const apps = {
  available: () => !!mcp,
  list: () => Promise.all(APPS.map(row)),
  async connect(id: string): Promise<AppConnection> {
    const app = byId(id);
    if (!mcp) throw new HttpError(503, 'Connected apps work when this page is open on claude.ai.');
    preview.appsOff.delete(app.id);
    problem.delete(app.id);
    const name = `mcp:${app.server}`;
    if (!permissions) throw new HttpError(409, `claude.ai asks whether this page may use ${app.name} the first time your employee needs it.`);
    // claude.ai's own question: may this page use the connector? A "no" stands until the viewer changes it there.
    let c = await consent(app);
    if (c === 'prompt') c = (await permissions.request([name]).catch(() => ({} as Record<string, string>)))[name] ?? 'unavailable';
    if (c === 'denied') {problem.set(app.id, DECLINED(app)); throw new HttpError(403, DECLINED(app));}
    if (c === 'prompt') throw new HttpError(409, `${app.name} was not allowed yet. Tap Connect again and choose Allow when claude.ai asks.`);
    if (c !== 'granted') throw new HttpError(503, `${app.name} cannot be used in this view.`);
    const listed = await mcp.listTools(app.server).catch(() => null);
    if (listed) judge(app, listed.servers.find(s => s.server === app.server));
    checkedAt.set(app.id, now());
    emit('connections.updated');
    const why = problem.get(app.id);
    if (why) throw new HttpError(409, why);
    return row(app);
  },
  async check(id: string): Promise<AppConnection> {
    const app = byId(id);
    if (mcp && await consent(app) === 'granted') {
      const listed = await mcp.listTools(app.server).catch(() => null);
      if (listed) judge(app, listed.servers.find(s => s.server === app.server));
    }
    checkedAt.set(app.id, now());
    return row(app);
  },
  async disconnect(id: string): Promise<AppConnection> {
    const app = byId(id);
    preview.appsOff.add(app.id);
    emit('connections.updated');
    return row(app);
  },
};

// --- what the employee can do with them ---------------------------------------

type Result = Record<string, unknown>;
export interface AppTool {
  name: string; description: string;
  inputSchema: {type: 'object'; properties: Record<string, object>; required?: string[]};
  run(runId: string, input: Record<string, unknown>, signal: AbortSignal, waitMs: number): Promise<Result>;
}

/** Ask the owner to connect an app a task needed: the app shows a one-tap banner. */
const needed = (app: App) => emit('connector.needed', {connector: app.id});

/** An app the owner disconnected in the preview: never called, whatever Claude asks. */
class Disconnected extends Error {readonly code = 'disconnected';}

/** Why a connector call failed, said to Claude, with the owner asked to fix what only they can fix. */
function explain(app: App, err: unknown): string {
  if (err instanceof Disconnected) return err.message;
  const code = String((err as McpError | null)?.code ?? 'upstream_error');
  if (code === 'needs_reauth') {problem.set(app.id, REAUTH(app)); needed(app); return `${app.name} needs to be reconnected by the owner in claude.ai. They have been asked.`;}
  if (code === 'server_not_connected' || code === 'server_not_found') {problem.set(app.id, ADD(app)); needed(app); return `${app.name} is not connected to the owner's Claude account. They have been asked to connect it.`;}
  if (code === 'not_in_manifest') {problem.set(app.id, DECLINED(app)); needed(app); return `The owner has not allowed this page to use ${app.name}. They have been asked.`;}
  if (code === 'selection_required') return `The owner has more than one ${app.name} connected and has not chosen which one this page uses.`;
  if (code === 'blocked_by_policy' || code === 'approval_required') return `The owner's organization does not allow this ${app.name} action here.`;
  if (code === 'tool_error') return `${app.name} refused: ${String((err as McpError).message ?? 'no reason given').slice(0, 300)}`;
  if (code === 'cancelled') return 'Stopped.';
  if (['not_granted', 'capability_disabled', 'capability_removed'].includes(code)) return 'Connected apps are not available in this view.';
  return `${app.name} did not answer just now. Try again in a moment.`;
}

async function call(app: App, tool: string, input: Record<string, unknown>, write: boolean): Promise<unknown> {
  if (!mcp) throw new Error('Connected apps are not available in this view.');
  if (preview.appsOff.has(app.id)) {needed(app); throw new Disconnected(`The owner disconnected ${app.name} in the app. They have been asked whether to connect it again.`);}
  const result = await mcp.callTool(app.server, tool, input, write ? {cache: false} : undefined);
  problem.delete(app.id);
  return result.payload ?? result.content ?? null;
}

/** A write whose answer never came back may still have happened: say so rather than guess either way. */
const UNCONFIRMED = new Set(['server_unavailable', 'upstream_error', 'rate_limited']);

// Tool results go back to Claude, which takes at most 32 KB from each.
function clipStrings(v: unknown, n: number, depth = 0): unknown {
  if (typeof v === 'string') return v.length > n ? `${v.slice(0, n)}…` : v;
  if (Array.isArray(v)) return v.slice(0, 50).map(x => clipStrings(x, n, depth + 1));
  if (v && typeof v === 'object' && depth < 12) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipStrings(x, n, depth + 1)]));
  return v;
}
function fit(value: unknown, max = 24_000): unknown {
  for (const n of [4000, 1500, 600, 200]) {const v = clipStrings(value, n); if (JSON.stringify(v ?? null).length <= max) return v;}
  return {cut: true, text: JSON.stringify(value ?? null).slice(0, max)};
}

const text = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
function addresses(v: unknown, what: string): string[] {
  const list = (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split(/[,;]/) : []).map(x => String(x).trim()).filter(Boolean);
  const bad = list.find(a => !EMAIL.test(a));
  if (bad) throw new Error(`"${bad}" is not an email address. Use plain addresses in ${what}.`);
  if (list.length > 20) throw new Error(`Too many addresses in ${what}.`);
  return list;
}
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const pad = (n: number) => String(n).padStart(2, '0');
/** A time as this phone's wall clock, without an offset: the calendar reads it in the time zone sent with it. */
const wallClock = (t: number) => {const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;};
const shown = (t: number) => new Date(t).toLocaleString('en-US', {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
const declined = (d: Decision, result: string) => ({status: d.kind === 'denied' ? 'declined by the owner' : d.kind === 'expired' ? 'not approved in time' : 'stopped', result});

const emailInput = {type: 'object' as const, properties: {
  to: {type: 'array', items: {type: 'string'}, description: 'Plain email addresses'},
  cc: {type: 'array', items: {type: 'string'}},
  subject: {type: 'string'},
  body: {type: 'string', description: 'Plain text, no Markdown'}}, required: ['to', 'subject', 'body']};

async function writeEmail(runId: string, input: Record<string, unknown>, signal: AbortSignal, waitMs: number, send: boolean): Promise<Result> {
  const to = addresses(input.to, 'to'), cc = addresses(input.cc, 'cc'), subject = text(input.subject, 300), body = text(input.body, 20_000);
  if (send && !to.length) throw new Error('Say who the email is to.');
  if (!body) throw new Error('The email is empty.');
  const shownArgs = {to: to.join(', '), ...(cc.length ? {cc: cc.join(', ')} : {}), subject, body};
  const d = await ask(runId, {tool: send ? 'app_send' : 'app_update', label: send ? 'Send this email' : 'Save this email draft', effect: send ? 'communication' : 'write',
    details: {app: 'gmail', action: send ? 'GMAIL_SEND_EMAIL' : 'GMAIL_CREATE_EMAIL_DRAFT', arguments: shownArgs}}, waitMs, signal);
  if (d.kind !== 'approved') return declined(d, send ? 'nothing was sent' : 'no draft was saved');
  step(runId, send ? 'Sending the email from your Gmail' : 'Saving the draft in your Gmail');
  const lines: [string, string][] = [['To', shownArgs.to || '(no one yet)'], ...(cc.length ? [['Cc', cc.join(', ')] as [string, string]] : []), ['Subject', subject], ['Message', body]];
  try {
    const out = await call(GMAIL, send ? 'send_message' : 'create_draft', {to, ...(cc.length ? {cc} : {}), subject, body}, true) as Result | null;
    const link = typeof out?.viewUrl === 'string' && out.viewUrl.startsWith('https://') ? out.viewUrl : '';
    addArtifact(runId, send ? 'Send this email' : 'Save this email draft', [...lines, ['Status', send ? 'sent from your Gmail' : 'saved in your Gmail drafts'], ...(link ? [['Open', link] as [string, string]] : [])]);
    emit('tool.completed', {runId});
    return {status: send ? 'sent' : 'draft saved', id: out?.id ?? null, ...(link ? {view_url: link} : {})};
  } catch (err) {
    const code = String((err as McpError | null)?.code ?? '');
    if (!UNCONFIRMED.has(code)) throw new Error(explain(GMAIL, err));
    addArtifact(runId, send ? 'Send this email' : 'Save this email draft', [...lines, ['Status', 'not confirmed: check Gmail before trying again']]);
    emit('tool.completed', {runId});
    return {status: 'not confirmed', note: `Gmail did not confirm, so it may or may not have gone through. The owner should check ${send ? 'Sent mail' : 'Drafts'} before trying again; do not retry.`};
  }
}

const TOOLS: (AppTool & {app: App})[] = [
  {app: GMAIL, name: 'search_email', description: 'Search the owner\'s real Gmail with Gmail search syntax (from:, to:, subject:, is:unread, newer_than:2d, in:inbox). Returns matching threads as previews that show only the oldest messages of each thread: use read_email on a thread before answering about recent or unread email. Reading needs no approval.',
    inputSchema: {type: 'object', properties: {query: {type: 'string', description: 'For example "is:unread newer_than:1d" or "from:joe@example.com invoice"'}, max_results: {type: 'integer', minimum: 1, maximum: 20}}, required: ['query']},
    async run(runId, input) {
      const query = text(input.query, 500);
      step(runId, `Searching your Gmail${query ? `: ${query}` : ''}`);
      const pageSize = Math.min(20, Math.max(1, Math.floor(Number(input.max_results)) || 10));
      try {return {threads: fit(await call(GMAIL, 'search_threads', {query, pageSize}, false))};} catch (err) {throw new Error(explain(GMAIL, err));}
    }},
  {app: GMAIL, name: 'read_email', description: 'Read one Gmail thread in full, as plain text, by the thread id search_email returned. Needs no approval.',
    inputSchema: {type: 'object', properties: {thread_id: {type: 'string'}}, required: ['thread_id']},
    async run(runId, input) {
      const threadId = text(input.thread_id, 200);
      if (!threadId) throw new Error('Say which thread to read.');
      step(runId, 'Reading an email');
      try {return {thread: fit(await call(GMAIL, 'get_thread', {threadId, messageFormat: 'PLAIN_TEXT'}, false), 28_000)};} catch (err) {throw new Error(explain(GMAIL, err));}
    }},
  {app: GMAIL, name: 'draft_email', description: 'Save an email as a draft in the owner\'s real Gmail, for them to send themselves. The owner approves the exact draft in the app first; this waits for their decision.',
    inputSchema: {...emailInput, required: ['subject', 'body']},
    run: (runId, input, signal, waitMs) => writeEmail(runId, input, signal, waitMs, false)},
  {app: GMAIL, name: 'send_email', description: 'Send an email from the owner\'s real Gmail. The owner approves the exact email (recipients, subject, message) in the app first; this waits for their decision and returns whether it was sent.',
    inputSchema: emailInput,
    run: (runId, input, signal, waitMs) => writeEmail(runId, input, signal, waitMs, true)},
  {app: CALENDAR, name: 'calendar_events', description: 'List events on the owner\'s real Google Calendar between two times (ISO 8601, with an offset), optionally matching words. Needs no approval.',
    inputSchema: {type: 'object', properties: {start: {type: 'string', description: 'ISO 8601, for example 2026-10-06T00:00:00-07:00. Default: now'}, end: {type: 'string', description: 'ISO 8601. Default: a week after start'},
      search: {type: 'string', description: 'Words to match in titles, places or guests'}, max_results: {type: 'integer', minimum: 1, maximum: 50}}},
    async run(runId, input) {
      const from = Date.parse(text(input.start, 40)), to = Date.parse(text(input.end, 40)), search = text(input.search, 200);
      step(runId, 'Checking your calendar');
      const args = {timeZone: zone(), pageSize: Math.min(50, Math.max(1, Math.floor(Number(input.max_results)) || 20)),
        ...(Number.isFinite(from) ? {startTime: new Date(from).toISOString()} : {}), ...(Number.isFinite(to) ? {endTime: new Date(to).toISOString()} : {}), ...(search ? {fullText: search} : {})};
      try {return {events: fit(await call(CALENDAR, 'list_events', args, false)), time_zone: args.timeZone};} catch (err) {throw new Error(explain(CALENDAR, err));}
    }},
  {app: CALENDAR, name: 'add_calendar_event', description: 'Add an event to the owner\'s real Google Calendar. With guests, they are emailed an invitation. The owner approves the exact event in the app first; this waits for their decision.',
    inputSchema: {type: 'object', properties: {title: {type: 'string'}, start: {type: 'string', description: 'ISO 8601 with an offset'}, end: {type: 'string', description: 'ISO 8601 with an offset'},
      location: {type: 'string'}, description: {type: 'string'}, guests: {type: 'array', items: {type: 'string'}, description: 'Email addresses to invite'}}, required: ['title', 'start', 'end']},
    async run(runId, input, signal, waitMs) {
      const title = text(input.title, 200), start = Date.parse(text(input.start, 40)), end = Date.parse(text(input.end, 40));
      const location = text(input.location, 300), description = text(input.description, 4000), guests = addresses(input.guests, 'guests');
      if (!title) throw new Error('Give the event a title.');
      if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('Give the start and end as ISO 8601 times.');
      if (end <= start) throw new Error('The event has to end after it starts.');
      const invite = guests.length > 0;
      const d = await ask(runId, {tool: invite ? 'app_send' : 'app_update', label: invite ? 'Add this event and invite people' : 'Add this event', effect: invite ? 'communication' : 'write',
        details: {app: 'googlecalendar', action: 'GOOGLECALENDAR_CREATE_EVENT', arguments: {title, start: `${shown(start)} (${zone()})`, end: shown(end), ...(location ? {location} : {}),
          ...(description ? {description} : {}), ...(invite ? {invite: `${guests.join(', ')} (each gets an email invitation)`} : {})}}}, waitMs, signal);
      if (d.kind !== 'approved') return declined(d, 'nothing was added');
      step(runId, 'Adding the event to your calendar');
      const lines: [string, string][] = [['Event', title], ['When', `${shown(start)} to ${shown(end)} (${zone()})`], ...(location ? [['Where', location] as [string, string]] : []), ...(invite ? [['Invited', guests.join(', ')] as [string, string]] : [])];
      try {
        const out = await call(CALENDAR, 'create_event', {summary: title, startTime: wallClock(start), endTime: wallClock(end), timeZone: zone(),
          ...(location ? {location} : {}), ...(description ? {description} : {}), ...(invite ? {attendees: guests.map(email => ({email})), notificationLevel: 'ALL'} : {notificationLevel: 'NONE'})}, true) as Result | null;
        addArtifact(runId, invite ? 'Add this event and invite people' : 'Add this event', [...lines, ['Status', 'added to your Google Calendar']]);
        emit('tool.completed', {runId});
        return {status: 'added', id: out?.id ?? null};
      } catch (err) {
        if (!UNCONFIRMED.has(String((err as McpError | null)?.code ?? ''))) throw new Error(explain(CALENDAR, err));
        addArtifact(runId, 'Add this event', [...lines, ['Status', 'not confirmed: check your calendar before trying again']]);
        emit('tool.completed', {runId});
        return {status: 'not confirmed', note: 'Google Calendar did not confirm, so the event may or may not have been added. The owner should check the calendar; do not retry.'};
      }
    }},
];

/** The app tools to offer Claude for a task: every one, when this view can reach connectors at all. */
export function appTools(): AppTool[] {
  return mcp ? TOOLS.map(({app: _app, ...t}) => t) : [];
}

/** How the employee is told about the apps, for its brief. */
export async function appsBrief(): Promise<string> {
  if (!mcp) return '';
  const rows = await apps.list();
  const state = rows.map(r => `${r.name}: ${r.status === 'connected' ? 'connected' : r.status === 'revoked' ? 'disconnected by the owner' : 'not connected yet (the first use asks the owner)'}`).join('; ');
  return `The owner's real Gmail and Google Calendar, through their Claude connectors (${state}). search_email and read_email read mail, draft_email and send_email write it, calendar_events and add_calendar_event use the calendar. Reading needs no approval; saving a draft, sending and adding an event each wait for the owner's approval. Never invent what an email or event says: read it. If a tool says an app is not connected, tell the owner to connect it under Settings, Connected apps.`;
}

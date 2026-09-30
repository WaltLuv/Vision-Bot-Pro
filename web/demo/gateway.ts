// An in-page stand-in for the gateway, so the real app can be opened and used
// without a server. Every route the app calls is answered here with the shapes
// the gateway returns, changes are announced on the event stream the way the
// gateway announces them, and anything that texts, calls, browses or spends
// money waits on an approval the owner decides in the app -- the same rule the
// gateway enforces. The UI, its rules and its styles are the app's own.
import type {Approval, Effect, Run, State} from '../src/api';
import {CONNECTIONS, freshAccount, seed} from './seed';

/** What the rest of the preview does when the app asks for it. */
export interface Workers {
  startTask(run: Run): void;
  stopTask(runId: string): void;
  takeOver(computerId: string): boolean;
  handBack(computerId: string): boolean;
  stopBrowser(computerId: string): boolean;
  signedIn(yes: boolean): void;
}

export type Decision = {kind: 'approved' | 'denied' | 'expired' | 'cancelled'; answer?: string};

// Signing out and deleting everything reload the page, as they do in the app.
// What they did has to outlive that reload; the rest of the preview starts over.
const KEY = 'vision-bot-pro-preview';
type Saved = {signedOut?: boolean; wiped?: boolean};
function saved(): Saved {
  try {return JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as Saved;} catch {return {};}
}
function remember(value: Saved) {
  try {sessionStorage.setItem(KEY, JSON.stringify(value));} catch {/* refused: a reload starts over */}
}
export function resetPreview() {
  try {sessionStorage.removeItem(KEY);} catch {/* nothing was kept */}
  location.reload();
}

const start = saved();
export const preview = {
  state: (start.wiped ? freshAccount() : seed()) as State,
  signedIn: !start.signedOut,
  /** Files the app uploaded, by artifact id: what Claude is shown and what the evidence viewer opens. */
  uploads: new Map<string, Blob>(),
  /** Whether Claude can answer tasks in this view; reported as the engine being ready. */
  claudeReady: false,
};

let ids = 0;
export const newId = (kind: string) => `${kind}-${Date.now().toString(36)}${(ids++).toString(36)}`;
export const now = () => new Date().toISOString();

// --- event stream ---------------------------------------------------------

class EventStream {
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {streams.add(this); setTimeout(() => this.onopen?.(), 30);}
  close() {streams.delete(this);}
}
const streams = new Set<EventStream>();
let seq = 0;

/** Announce a change. The app refetches its state on any event, as it does with the gateway. */
export function emit(type: string, fields: Record<string, unknown> = {}) {
  seq += 1;
  const data = JSON.stringify({...fields, type, seq, at: now()});
  const id = String(seq);
  // Delivered after the current step, like an event arriving over the network.
  setTimeout(() => {for (const s of streams) s.onmessage?.(new MessageEvent('message', {data, lastEventId: id}));}, 0);
}

// --- runs and approvals ---------------------------------------------------

const TERMINAL = new Set<Run['status']>(['completed', 'failed', 'cancelled']);
export const runById = (id: string) => preview.state.run.find(r => r.id === id);
export const isOver = (id: string) => {const run = runById(id); return !run || TERMINAL.has(run.status);};

/** Change a run that is still going. A stopped or finished run stays as it is. */
export function updateRun(id: string, patch: Partial<Run>): boolean {
  const run = runById(id);
  if (!run || TERMINAL.has(run.status)) return false;
  Object.assign(run, patch);
  if (TERMINAL.has(run.status)) run.completedAt = now();
  emit('run.updated', {runId: id, status: run.status});
  return true;
}

export function addArtifact(runId: string, name: string, lines: [string, string][]) {
  preview.state.artifact.unshift({id: newId('artifact'), runId, kind: 'tool_receipt', name, text: [name, ...lines.map(([k, v]) => `${k}: ${v}`)].join('\n')});
}

const waiting = new Map<string, (d: Decision) => void>();
/** Tools the owner chose "Always allow this" for. Never offered for money, messages or deletion. */
const alwaysAllowed = new Set<string>();

export interface Request {tool: string; label: string; effect: Effect; details: Record<string, unknown>}

/**
 * Ask the owner, and wait for the decision. The run shows as needing them
 * until every question on it is answered. Nothing is assumed: an approval
 * that runs out of time, or whose task was stopped, is a no.
 */
export function ask(runId: string, request: Request, limitMs: number, signal?: AbortSignal): Promise<Decision> {
  if (signal?.aborted) return Promise.resolve({kind: 'cancelled'});
  if (alwaysAllowed.has(request.tool)) return Promise.resolve({kind: 'approved'});
  const approval: Approval = {id: newId('approval'), runId, ...request, status: 'pending', expiresAt: Date.now() + limitMs};
  preview.state.approval.unshift(approval);
  updateRun(runId, {status: 'needs_user'});
  emit('approval.requested', {runId, approvalId: approval.id});
  return new Promise(resolve => {
    const timer = setTimeout(() => settle(approval.id, {kind: 'expired'}), limitMs);
    const stop = () => settle(approval.id, {kind: isOver(runId) ? 'cancelled' : 'expired'});
    signal?.addEventListener('abort', stop, {once: true});
    waiting.set(approval.id, d => {clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve(d);});
  });
}

function settle(id: string, decision: Decision) {
  const approval = preview.state.approval.find(a => a.id === id);
  if (!approval || approval.status !== 'pending') return;
  approval.status = decision.kind === 'approved' ? 'approved' : 'denied';
  if (runById(approval.runId)?.status === 'needs_user' && !preview.state.approval.some(a => a.runId === approval.runId && a.status === 'pending'))
    updateRun(approval.runId, {status: 'working'});
  emit('approval.decided', {runId: approval.runId, approvalId: id, decision: decision.kind});
  const resolve = waiting.get(id);
  waiting.delete(id);
  resolve?.(decision);
}

// --- routes ---------------------------------------------------------------

class HttpError extends Error {constructor(readonly status: number, message: string) {super(message);}}
type Handler = (match: RegExpMatchArray, body: any, init: RequestInit) => unknown;

export function installGateway(workers: Workers) {
  const state = () => preview.state;
  const signedIn = () => {if (!preview.signedIn) throw new HttpError(401, 'Sign in to continue.');};
  const find = <K extends keyof State>(kind: K, id: string) => {
    const row = (state()[kind] as {id: string}[]).find(r => r.id === id);
    if (!row) throw new HttpError(404, 'That is no longer here.');
    return row as State[K][number];
  };
  const remove = <K extends keyof State>(kind: K, id: string) => {
    (state() as unknown as Record<string, {id: string}[]>)[kind] = (state()[kind] as {id: string}[]).filter(r => r.id !== id);
  };
  const computer = (id: string, ok: boolean) => {
    if (!ok) throw new HttpError(409, 'That browser is not running any more.');
    const c = find('computer', id);
    return {id: c.id, status: c.status, control: c.control};
  };
  const wipe = () => {
    for (const run of state().run) if (!TERMINAL.has(run.status)) workers.stopTask(run.id);
    for (const id of [...waiting.keys()]) settle(id, {kind: 'cancelled'});
    preview.uploads.clear();
    preview.state = freshAccount();
  };

  const routes: [string, RegExp, Handler][] = [
    ['GET', /^\/api\/session$/, () => {signedIn(); return {owner: 'owner', csrf: 'preview'};}],
    ['POST', /^\/api\/auth\/login$/, (_m, body) => {
      if (!String(body?.token ?? '').trim()) throw new HttpError(401, 'That code was not accepted.');
      preview.signedIn = true;
      remember({...saved(), signedOut: false});
      workers.signedIn(true);
      return {owner: 'owner', csrf: 'preview'};
    }],
    ['POST', /^\/api\/auth\/logout$/, () => {preview.signedIn = false; remember({...saved(), signedOut: true}); workers.signedIn(false);}],
    ['GET', /^\/api\/state$/, () => {signedIn(); return state();}],
    ['GET', /^\/api\/connections$/, () => ({...CONNECTIONS, anthropic: preview.claudeReady})],
    ['POST', /^\/livekit-token$/, () => {throw new HttpError(503, 'Voice conversation runs only in the installed app.');}],

    ['POST', /^\/api\/execute$/, (_m, body) => {
      signedIn();
      const task = String(body?.task ?? '').trim();
      if (!task) throw new HttpError(400, 'Say what you need done.');
      const context = body?.context ?? {};
      const attachments = (Array.isArray(context.attachments) ? context.attachments : []).map(String).filter((a: string) => preview.uploads.has(a));
      const run: Run = {id: newId('run'), task, status: 'working', createdAt: now(), conversationId: newId('conv'),
        context: {source: context.source === 'phone' ? 'phone' : 'text', attachments, ...(context.visualDescription ? {visualDescription: String(context.visualDescription)} : {})}};
      state().run.unshift(run);
      // A photo sent with a task is that task's evidence, as on the gateway.
      for (const a of state().artifact) if (attachments.includes(a.id)) a.runId = run.id;
      emit('run.updated', {runId: run.id, status: run.status});
      workers.startTask(run);
      return run;
    }],
    ['GET', /^\/api\/runs\/([^/]+)$/, m => find('run', m[1]!)],
    ['POST', /^\/api\/runs\/([^/]+)\/cancel$/, m => {
      const runId = m[1]!;
      find('run', runId);
      updateRun(runId, {status: 'cancelled'});
      for (const a of state().approval) if (a.runId === runId && a.status === 'pending') settle(a.id, {kind: 'cancelled'});
      workers.stopTask(runId);
    }],
    ['POST', /^\/api\/runs\/([^/]+)\/resume$/, () => undefined],
    ['POST', /^\/api\/approvals\/([^/]+)$/, (m, body) => {
      const approval = find('approval', m[1]!);
      if (approval.status !== 'pending' || approval.expiresAt <= Date.now()) throw new HttpError(409, 'That request was already decided or has expired.');
      const yes = body?.decision === 'once' || body?.decision === 'always';
      if (body?.decision === 'always' && !['financial', 'communication', 'destructive'].includes(approval.effect)) alwaysAllowed.add(approval.tool);
      settle(approval.id, {kind: yes ? 'approved' : 'denied', ...(body?.answer ? {answer: String(body.answer).slice(0, 4000)} : {})});
    }],
    ['POST', /^\/api\/actions\/([^/]+)\/reconcile$/, () => undefined],

    ['PUT', /^\/api\/agent$/, (_m, body) => {
      const agent = state().agent[0]!;
      for (const key of ['name', 'title', 'instructions'] as const) if (typeof body?.[key] === 'string') agent[key] = body[key].slice(0, 4000);
      if (Array.isArray(body?.skills)) agent.skills = body.skills.map(String).filter((id: string) => state().skill.some(s => s.id === id));
      emit('agent.updated');
      return agent;
    }],
    ['POST', /^\/api\/memory$/, (_m, body) => {
      const row = {id: newId('memory'), kind: ['profile', 'work', 'note', 'workspace'].includes(body?.kind) ? body.kind : 'note', text: String(body?.text ?? '').slice(0, 4000)};
      state().memory.unshift(row);
      return row;
    }],
    ['DELETE', /^\/api\/memory\/([^/]+)$/, m => remove('memory', m[1]!)],
    ['POST', /^\/api\/contacts$/, (_m, body) => {
      if (!/^\+[1-9]\d{6,14}$/.test(String(body?.phone ?? ''))) throw new HttpError(400, 'That phone number cannot be used.');
      const row = {id: newId('contact'), name: String(body?.name ?? '').slice(0, 200), phone: String(body.phone), organization: String(body?.organization ?? '').slice(0, 200)};
      state().contact.unshift(row);
      return row;
    }],
    ['DELETE', /^\/api\/contacts\/([^/]+)$/, m => remove('contact', m[1]!)],
    ['POST', /^\/api\/artifacts$/, (_m, body, init) => {
      const headers = new Headers(init.headers);
      const row = {id: newId('artifact'), kind: 'photo', name: headers.get('x-file-name') || 'Photo.jpg', mime: headers.get('x-file-type') || 'image/jpeg'};
      if (body instanceof Blob) preview.uploads.set(row.id, body);
      state().artifact.unshift(row);
      return row;
    }],
    ['DELETE', /^\/api\/artifacts\/([^/]+)$/, m => {remove('artifact', m[1]!); preview.uploads.delete(m[1]!);}],

    ['POST', /^\/api\/computers\/([^/]+)\/takeover$/, m => computer(m[1]!, workers.takeOver(m[1]!))],
    ['POST', /^\/api\/computers\/([^/]+)\/handback$/, m => computer(m[1]!, workers.handBack(m[1]!))],
    ['POST', /^\/api\/computers\/([^/]+)\/stop$/, m => {workers.stopBrowser(m[1]!);}],
    ['DELETE', /^\/api\/employee-data$/, () => {
      wipe();
      preview.signedIn = false;
      remember({wiped: true, signedOut: true});
      workers.signedIn(false);
    }],
  ];

  const json = (value: unknown, status: number) => new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});
  const answer = async (method: string, path: string, init: RequestInit): Promise<Response> => {
    let body: unknown = init.body;
    if (typeof body === 'string') {try {body = JSON.parse(body);} catch {body = undefined;}}
    for (const [verb, pattern, handler] of routes) {
      const match = path.match(pattern);
      if (!match || verb !== method) continue;
      try {
        const out = handler(match.map(s => (s === undefined ? s : decodeURIComponent(s))) as RegExpMatchArray, body, init);
        return out === undefined ? new Response(null, {status: 204}) : json(out, path === '/api/execute' ? 202 : 200);
      } catch (err) {
        return json({error: {message: err instanceof Error ? err.message : 'That did not go through.'}}, err instanceof HttpError ? err.status : 500);
      }
    }
    return json({error: {message: 'That is not part of this preview.'}}, 404);
  };

  // The app calls its gateway by path ("/api/state"). Those are answered here;
  // anything else goes out as usual.
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = raw.startsWith('/') ? raw.split(/[?#]/)[0]! : null;
    if (!path || !/^\/(api\/|livekit-token$)/.test(path)) return realFetch(input, init);
    return answer(String(init.method ?? 'GET').toUpperCase(), path, init);
  }) as typeof fetch;
  globalThis.EventSource = EventStream as unknown as typeof EventSource;
}

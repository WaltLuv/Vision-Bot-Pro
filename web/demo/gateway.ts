// An in-page stand-in for the gateway, so the real app can be opened and used
// without a server. Every route the app calls is answered here with the shapes
// the gateway returns, changes are announced on the event stream the way the
// gateway announces them, and anything that texts, calls, browses, sends email
// or spends money waits on an approval the owner decides in the app -- the same
// rule the gateway enforces. The UI, its rules and its styles are the app's own.
// In a claude.ai viewer the account is kept for the viewer's next visit (persist.ts).
import type {AppConnection, Approval, Effect, Inspection, Run, State, Workflow} from '../src/api';
import * as persist from './persist';
import {DELIVERIES, describeRepeat, inferDelivery, nextRun, routineTask, validRepeat} from './schedule';
import {CONNECTIONS, freshAccount, seed} from './seed';

/** The preview's connected apps: the viewer's own, through claude.ai (apps.ts). */
export interface Apps {
  /** Whether connected apps can work in this view at all. */
  available(): boolean;
  list(): Promise<AppConnection[]>;
  connect(id: string): Promise<AppConnection>;
  check(id: string): Promise<AppConnection>;
  disconnect(id: string): Promise<AppConnection>;
}

/** What the rest of the preview does when the app asks for it. */
export interface Workers {
  startTask(run: Run): void;
  stopTask(runId: string): void;
  takeOver(computerId: string): boolean;
  handBack(computerId: string): boolean;
  stopBrowser(computerId: string): boolean;
  signedIn(yes: boolean): void;
  apps: Apps;
  inspect(frame: Blob, focus: string): Promise<Inspection>;
}

export type Decision = {kind: 'approved' | 'denied' | 'expired' | 'cancelled'; answer?: string};

export class HttpError extends Error {constructor(readonly status: number, message: string) {super(message);}}

// Signing out and deleting everything reload the page, as they do in the app.
// Where the account cannot be saved, what they did still has to outlive that
// reload, so it is noted for this tab; the rest of the preview starts over.
const KEY = 'vision-bot-pro-preview';
type Flags = {signedOut?: boolean; wiped?: boolean};
function flags(): Flags {
  try {return JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as Flags;} catch {return {};}
}
function remember(value: Flags) {
  try {sessionStorage.setItem(KEY, JSON.stringify(value));} catch {/* refused: a reload starts over */}
}

const start = flags();
export const preview = {
  state: (start.wiped ? freshAccount() : seed()) as State,
  signedIn: !start.signedOut,
  /** Files the app uploaded, by artifact id: what Claude is shown and what the evidence viewer opens. */
  uploads: new Map<string, Blob>(),
  /** Whether Claude can answer tasks in this view; reported as the engine being ready. */
  claudeReady: false,
  /** Tools the owner chose "Always allow this" for. Never offered for money, messages or deletion. */
  allowed: new Set<string>(),
  /** Connected apps the owner disconnected here. */
  appsOff: new Set<string>(),
};

let ids = 0;
export const newId = (kind: string) => `${kind}-${Date.now().toString(36)}${(ids++).toString(36)}`;
export const now = () => new Date().toISOString();

// --- keeping the account between visits -------------------------------------

const snapshot = (): persist.Saved => ({state: preview.state, signedOut: !preview.signedIn, allowed: [...preview.allowed], appsOff: [...preview.appsOff]});
/** Something changed: keep it for the next visit once the burst of changes settles. */
const changed = () => persist.schedule(snapshot);

/** Start over on the sample data, forgetting what was saved. Resolves false when the saved copy could not be removed. */
export async function resetPreview(): Promise<boolean> {
  if (!await persist.clear()) return false;
  try {sessionStorage.removeItem(KEY);} catch {/* nothing was kept */}
  location.reload();
  return true;
}

/**
 * What was saved, made safe to open: a task that was running when the page closed cannot carry on in a new page,
 * so it shows as stopped and its questions are withdrawn. The sample purchase is asked again (employee.ts).
 */
function recover(state: State): State {
  const all = {...freshAccount(), ...state};
  const orderable = all.offer.some(o => o.id === 'offer-RS-118');
  for (const run of all.run) {
    if (TERMINAL.has(run.status) || (run.id === 'run-order' && run.status === 'needs_user' && orderable)) continue;
    Object.assign(run, {status: 'failed', completedAt: now(), error: 'This page was closed or reloaded while the task was running, so it stopped. Send it again to start over.'});
  }
  all.approval = all.approval.filter(a => a.status !== 'pending');
  all.computer = [];
  // A routine that came due while the page was closed waits for its next time instead of running as the page opens.
  for (const w of all.workflow) {
    if (!w.enabled) continue;
    if (w.repeat && w.nextRunAt && Date.parse(w.nextRunAt) <= Date.now()) w.nextRunAt = nextRun(w.repeat);
    if (!w.repeat && w.scheduledAt && Date.parse(w.scheduledAt) <= Date.now()) Object.assign(w, {enabled: false, lastRunSummary: 'Not run: this page was closed at that time.'});
  }
  return all;
}

/** The viewer's saved account, put back before the app's first request is answered. It wins over this tab's notes. */
export const whenRestored: Promise<void> = persist.load().then(saved => {
  if (!saved) return;
  preview.state = recover(saved.state);
  preview.signedIn = !saved.signedOut;
  for (const tool of saved.allowed) preview.allowed.add(tool);
  for (const app of saved.appsOff) preview.appsOff.add(app);
}).catch(() => {});

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
  changed();
}

// --- runs and approvals ---------------------------------------------------

const TERMINAL = new Set<Run['status']>(['completed', 'failed', 'cancelled']);
export const runById = (id: string) => preview.state.run.find(r => r.id === id);
export const isOver = (id: string) => {const run = runById(id); return !run || TERMINAL.has(run.status);};

/** The first line of a result, as a routine's card shows it. */
const summary = (text: unknown) => String(text ?? '').split('\n').find(l => l.trim())?.replace(/\*\*/g, '').trim().slice(0, 160) ?? '';

/** Change a run that is still going. A stopped or finished run stays as it is. */
export function updateRun(id: string, patch: Partial<Run>): boolean {
  const run = runById(id);
  if (!run || TERMINAL.has(run.status)) return false;
  Object.assign(run, patch);
  if (TERMINAL.has(run.status)) {
    run.completedAt = now();
    // A routine's card shows how its last run went.
    const routine = preview.state.workflow.find(w => w.id === run.workflowId);
    if (routine) Object.assign(routine, {lastRunStatus: run.status, lastRunSummary: summary(run.result ?? run.error)});
  }
  emit('run.updated', {runId: id, status: run.status});
  return true;
}

/** A step the employee took, shown on the task as it happens. */
export function step(runId: string, text: string) {
  const run = runById(runId);
  if (!run || TERMINAL.has(run.status)) return;
  run.progress = [...(run.progress ?? []), {at: now(), text}].slice(-12);
  emit('run.progress', {runId});
}

export function addArtifact(runId: string, name: string, lines: [string, string][]) {
  preview.state.artifact.unshift({id: newId('artifact'), runId, kind: 'tool_receipt', name, text: [name, ...lines.map(([k, v]) => `${k}: ${v}`)].join('\n')});
}

const waiting = new Map<string, (d: Decision) => void>();

export interface Request {tool: string; label: string; effect: Effect; details: Record<string, unknown>}

/**
 * Ask the owner, and wait for the decision. The run shows as needing them
 * until every question on it is answered. Nothing is assumed: an approval
 * that runs out of time, or whose task was stopped, is a no.
 */
export function ask(runId: string, request: Request, limitMs: number, signal?: AbortSignal): Promise<Decision> {
  if (signal?.aborted) return Promise.resolve({kind: 'cancelled'});
  if (preview.allowed.has(request.tool)) return Promise.resolve({kind: 'approved'});
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

type Handler = (match: RegExpMatchArray, body: any, init: RequestInit, query: URLSearchParams) => unknown;

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
    preview.allowed.clear();
    preview.appsOff.clear();
    preview.state = freshAccount();
  };

  /** A task, started the way the gateway starts one: recorded, announced, then handed to the employee. */
  const startRun = (fields: Pick<Run, 'task' | 'context'> & Partial<Run>): Run => {
    const run: Run = {id: newId('run'), status: 'working', createdAt: now(), conversationId: newId('conv'), ...fields};
    state().run.unshift(run);
    emit('run.updated', {runId: run.id, status: run.status});
    workers.startTask(run);
    return run;
  };
  const runRoutine = (w: Workflow): Run => {
    Object.assign(w, {lastRunAt: now(), runsCount: (w.runsCount ?? 0) + 1});
    const run = startRun({task: routineTask(w.task, w.delivery ?? 'chat'), title: w.name, context: {source: 'workflow', attachments: []}, workflowId: w.id});
    w.lastRunId = run.id;
    emit('workflow.updated');
    return run;
  };

  const routes: [string, RegExp, Handler][] = [
    ['GET', /^\/api\/session$/, () => {signedIn(); return {owner: 'owner', csrf: 'preview'};}],
    ['POST', /^\/api\/auth\/login$/, (_m, body) => {
      if (!String(body?.token ?? '').trim()) throw new HttpError(401, 'That code was not accepted.');
      preview.signedIn = true;
      remember({...flags(), signedOut: false});
      workers.signedIn(true);
      return {owner: 'owner', csrf: 'preview'};
    }],
    // The app reloads straight after; the sign-out has to be kept before it does.
    ['POST', /^\/api\/auth\/logout$/, async () => {
      preview.signedIn = false;
      remember({...flags(), signedOut: true});
      workers.signedIn(false);
      await persist.flush(snapshot);
    }],
    ['GET', /^\/api\/state$/, () => {signedIn(); return state();}],
    ['GET', /^\/api\/connections$/, () => ({...CONNECTIONS, anthropic: preview.claudeReady, apps: workers.apps.available()})],
    // The sign-in screen as the app shows it; its Google button says it is not part of the preview (chrome.ts).
    ['GET', /^\/api\/auth\/options$/, () => ({google: true, preview: false})],
    ['POST', /^\/livekit-token$/, () => {throw new HttpError(503, 'Voice conversation runs only in the installed app.');}],

    ['POST', /^\/api\/execute$/, (_m, body) => {
      signedIn();
      const task = String(body?.task ?? '').trim();
      if (!task) throw new HttpError(400, 'Say what you need done.');
      const context = body?.context ?? {};
      const attachments = (Array.isArray(context.attachments) ? context.attachments : []).map(String).filter((a: string) => preview.uploads.has(a));
      // A photo sent with a task is that task's evidence, as on the gateway.
      const run = startRun({task, context: {source: context.source === 'phone' ? 'phone' : 'text', attachments, ...(context.visualDescription ? {visualDescription: String(context.visualDescription)} : {})}});
      for (const a of state().artifact) if (attachments.includes(a.id)) a.runId = run.id;
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
      // Never for money, messages, deletion, or a change to a connected app: those stay one decision each.
      if (body?.decision === 'always' && !['financial', 'communication', 'destructive'].includes(approval.effect) && !approval.tool.startsWith('app_')) preview.allowed.add(approval.tool);
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
      const notes = String(body?.notes ?? '').trim().slice(0, 500);
      const row = {id: newId('contact'), name: String(body?.name ?? '').slice(0, 200), phone: String(body.phone), organization: String(body?.organization ?? '').slice(0, 200), ...(notes ? {notes} : {})};
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

    // Routines, with the gateway's own rules. Here they run while the page is open (see the scheduler below).
    ['POST', /^\/api\/workflows$/, (_m, body) => {
      signedIn();
      const name = String(body?.name ?? '').trim().slice(0, 100), task = String(body?.task ?? '').trim().slice(0, 12000);
      if (!name || !task) throw new HttpError(400, 'Give the routine a name and say what it should do.');
      const repeat = body?.repeat === undefined ? undefined : validRepeat(body.repeat);
      if (repeat === null) throw new HttpError(400, 'That schedule cannot be used. Choose how often and a time.');
      const at = typeof body?.scheduledAt === 'string' ? Date.parse(body.scheduledAt) : NaN;
      const w: Workflow = {id: newId('workflow'), name, task, enabled: true, runsCount: 0,
        delivery: DELIVERIES.includes(body?.delivery) ? body.delivery : inferDelivery(task),
        ...(typeof body?.template === 'string' ? {template: body.template.slice(0, 60)} : {}),
        ...(Number.isFinite(at) ? {scheduledAt: new Date(at).toISOString()} : {}),
        ...(repeat ? {repeat, nextRunAt: nextRun(repeat), schedule: describeRepeat(repeat)} : {})};
      state().workflow.unshift(w);
      emit('workflow.updated');
      return w;
    }],
    ['PATCH', /^\/api\/workflows\/([^/]+)$/, (m, body) => {
      const w = find('workflow', m[1]!);
      if (typeof body?.enabled !== 'boolean') throw new HttpError(400, 'Say whether the routine should run.');
      w.enabled = body.enabled;
      if (w.enabled && w.repeat) w.nextRunAt = nextRun(w.repeat);
      emit('workflow.updated');
      return w;
    }],
    ['DELETE', /^\/api\/workflows\/([^/]+)$/, m => {remove('workflow', m[1]!); emit('workflow.updated');}],
    ['POST', /^\/api\/workflows\/([^/]+)\/run$/, m => {signedIn(); return runRoutine(find('workflow', m[1]!));}],

    // Connected apps: the viewer's own Gmail and Google Calendar, through claude.ai. There is no sign-in page to
    // leave for: connecting asks claude.ai's own permission question, then comes straight back.
    ['GET', /^\/api\/composio\/tools$/, async () => ({enabled: workers.apps.available(), tools: workers.apps.available() ? await workers.apps.list() : []})],
    ['GET', /^\/api\/composio\/connections$/, async () => ({enabled: workers.apps.available(),
      connections: workers.apps.available() ? (await workers.apps.list()).filter(a => a.status === 'connected') : []})],
    ['POST', /^\/api\/composio\/tools\/([^/]+)\/connect$/, async m => ({...await workers.apps.connect(m[1]!), connectUrl: null})],
    ['GET', /^\/api\/composio\/tools\/([^/]+)\/status$/, m => workers.apps.check(m[1]!)],
    ['POST', /^\/api\/composio\/tools\/([^/]+)\/disconnect$/, m => workers.apps.disconnect(m[1]!)],

    ['POST', /^\/api\/inspect$/, (_m, body, _init, query) => {
      signedIn();
      if (!(body instanceof Blob) || !body.size) throw new HttpError(400, 'Send a photo to check.');
      return workers.inspect(body, String(query.get('focus') ?? '').slice(0, 300));
    }],
    // Store sign-ins need the server's encrypted vault and a real browser; the preview has neither.
    ['GET', /^\/api\/signins$/, () => ({enabled: false, domains: ['homedepot.com', 'lowes.com'], saved: [], savedAt: null})],
    ['DELETE', /^\/api\/signins$/, () => undefined],

    ['POST', /^\/api\/computers\/([^/]+)\/takeover$/, m => computer(m[1]!, workers.takeOver(m[1]!))],
    ['POST', /^\/api\/computers\/([^/]+)\/handback$/, m => computer(m[1]!, workers.handBack(m[1]!))],
    ['POST', /^\/api\/computers\/([^/]+)\/stop$/, m => {workers.stopBrowser(m[1]!);}],
    ['DELETE', /^\/api\/employee-data$/, async () => {
      wipe();
      preview.signedIn = false;
      remember({wiped: true, signedOut: true});
      workers.signedIn(false);
      // The app reloads straight after; a saved account that kept its old contents would come back with it. If the
      // empty one cannot be saved, the saved one is removed instead, and this tab's notes say what was done.
      if (!await persist.flush(snapshot) && !await persist.clear()) throw new HttpError(503, 'Your saved preview could not be cleared just now. Try again in a moment.');
    }],
  ];

  const json = (value: unknown, status: number) => new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});
  const answer = async (method: string, path: string, query: URLSearchParams, init: RequestInit): Promise<Response> => {
    // Nothing is answered from the sample data while the viewer's own account is still on its way.
    await whenRestored;
    let body: unknown = init.body;
    if (typeof body === 'string') {try {body = JSON.parse(body);} catch {body = undefined;}}
    for (const [verb, pattern, handler] of routes) {
      const match = path.match(pattern);
      if (!match || verb !== method) continue;
      try {
        const out = await handler(match.map(s => (s === undefined ? s : decodeURIComponent(s))) as RegExpMatchArray, body, init, query);
        if (method !== 'GET') changed();
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
    const [path = '', rest = ''] = raw.startsWith('/') ? raw.split('#')[0]!.split('?') : [];
    if (!path || !/^\/(api\/|livekit-token$)/.test(path)) return realFetch(input, init);
    return answer(String(init.method ?? 'GET').toUpperCase(), path, new URLSearchParams(rest), init);
  }) as typeof fetch;
  globalThis.EventSource = EventStream as unknown as typeof EventSource;

  // Routines run on time while this page is open: the app's own server runs them with the phone off.
  void whenRestored.then(() => setInterval(() => {
    if (!preview.signedIn) return;
    const t = Date.now();
    for (const w of state().workflow) {
      if (!w.enabled) continue;
      if (w.repeat && w.nextRunAt && Date.parse(w.nextRunAt) <= t) {w.nextRunAt = nextRun(w.repeat, t); runRoutine(w);}
      else if (!w.repeat && w.scheduledAt && Date.parse(w.scheduledAt) <= t) {w.enabled = false; runRoutine(w);}
    }
  }, 20_000));
}

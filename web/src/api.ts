// Typed client for the existing gateway. Every call is same-origin: the PWA is
// served from web/dist by the gateway itself, so there is no second backend and
// no cross-origin credential handling anywhere in this file.
//
// Auth is the gateway's HttpOnly vc_session cookie. The browser attaches it; we
// never read or store the access token, and nothing here writes a credential to
// localStorage. The CSRF token issued at login rides on every mutating request
// because the gateway rejects non-GET without a matching x-csrf-token.

export type Effect = 'read' | 'write' | 'communication' | 'destructive' | 'financial' | 'sensitive' | 'computer';
export type RunStatus = 'queued' | 'working' | 'verifying' | 'completed' | 'failed' | 'cancelled' | 'needs_user';
export type Source = 'phone' | 'glasses' | 'text' | 'workflow' | 'webhook';

export interface Row {id: string; [key: string]: any}
export interface Run extends Row {task: string; title?: string; status: RunStatus; result?: string; error?: string; recovered?: boolean; conversationId?: string; createdAt?: string; completedAt?: string; context?: {source?: Source; attachments?: string[]; visualDescription?: string}}
export interface Approval extends Row {runId: string; tool: string; label: string; effect: Effect; details: Record<string, unknown>; status: 'pending' | 'approved' | 'denied'; expiresAt: number}
export interface Artifact extends Row {runId?: string; kind: string; name: string; mime?: string; text?: string}
export interface Agent extends Row {name: string; title: string; instructions: string; runtime: 'hermes' | 'anthropic' | 'claude'; skills: string[]; avatar?: string; provider?: string; model?: string}
export interface Skill extends Row {key: string; name: string; instructions: string}
export interface Memory extends Row {kind: 'profile' | 'work' | 'note' | 'workspace'; text: string}
export interface Contact extends Row {name?: string}
export interface Workflow extends Row {name: string; task: string; scheduledAt?: string; enabled: boolean}
export interface Action extends Row {runId: string; name: string; status: string; effect: Effect}
/** A browser the employee is using. liveEmbed is the provider's live view, present only while it runs and only from an allowed host. */
export interface Computer extends Row {runId: string; task: string; status: 'queued' | 'starting' | 'working' | 'completed' | 'failed' | 'cancelled' | 'closed' | 'cleanup_pending'; control?: 'agent' | 'owner'; liveEmbed?: string | null; liveHost?: string}

export type AccessMethod = 'official_api' | 'partner_api' | 'mcp' | 'browser' | 'manual' | 'web_search';
export type SupplierStatus = 'ok' | 'failed' | 'unconfigured' | 'timeout';

/** How one supplier answered a search, so a short list is never mistaken for a complete one. */
export interface SupplierReport {id: string; name: string; method: AccessMethod; status: SupplierStatus; offers: number; checkedAt: string; detail?: string}
export interface SupplierConnection {id: string; name: string; method: AccessMethod; connected: boolean; requires: string[]}

export interface Fulfillment {available: boolean | null; eta: string; location: string}
export interface Offer extends Row {
  requestId?: string; supplierId: string; supplier: string; method: AccessMethod;
  sku: string; product: string; url: string; specification: string;
  quantity: number; unitPrice: number; currency: string;
  shipping: number | null; tax: number | null; fees: number | null;
  inventory: number | null; availability: string;
  pickup: Fulfillment; delivery: Fulfillment;
  observedAt: string; matchQuality: 'unverified' | 'candidate' | 'exact'; confidence: number;
}
export interface Material extends Row {description: string; specification: string; quantity: number; currency: string; runId?: string; suppliers?: SupplierReport[]; searchedAt?: string}

export interface State {
  run: Run[]; agent: Agent[]; skill: Skill[]; memory: Memory[]; conversation: Row[]; message: Row[];
  approval: Approval[]; artifact: Artifact[]; contact: Contact[]; communication: Row[];
  material: Material[]; offer: Offer[]; cart: Row[]; quote: Row[]; order: Row[];
  workflow: Workflow[]; computer: Computer[]; policy: Row[]; action: Action[]; evidence_link: Row[];
}

// What the gateway has credentials for. Used to disable surfaces honestly
// instead of showing controls that cannot work.
export interface Connections {
  /** The engine this owner's tasks will actually run on; the server decides. */
  runtime?: 'hermes' | 'anthropic' | 'claude';
  realtime: boolean; hermes: boolean; anthropic: boolean; claude?: boolean; sms: boolean; voice: boolean;
  products: boolean; browser: boolean; search?: boolean; suppliers: SupplierConnection[];
  mcp: {id: string; tools: string[]}[]; mcpError?: string;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {super(message);}
}

let csrf = '';
export const csrfToken = () => csrf;

/** The gateway issues this at login and echoes it from /api/session on reload. */
export function setCsrf(value: string) {csrf = value;}

async function call<T>(method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<T> {
  const headers: Record<string, string> = {...extra};
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  let payload: BodyInit | undefined;
  if (body instanceof Blob || body instanceof ArrayBuffer) payload = body as BodyInit;
  else if (body !== undefined) {headers['content-type'] = 'application/json'; payload = JSON.stringify(body);}
  const res = await fetch(path, {method, headers, body: payload, credentials: 'same-origin'});
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? safeJson(text) : undefined;
  // The gateway always phrases errors for a person; surface its message rather
  // than inventing one, but never leak a raw body that might carry internals.
  if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? 'That did not go through. Please try again.');
  return data as T;
}

function safeJson(text: string): any {
  try {return JSON.parse(text);} catch {return undefined;}
}

/** Distinct per submission so a retry after a dropped response never creates a second run. */
export const newIdempotencyKey = () => crypto.randomUUID();

export const api = {
  session: () => call<{owner: string; csrf: string}>('GET', '/api/session'),
  login: (token: string) => call<{owner: string; csrf: string}>('POST', '/api/auth/login', {token}),
  /** Which other ways in this server offers, before anyone is signed in. */
  signInOptions: () => call<{google: boolean; preview?: boolean}>('GET', '/api/auth/options'),
  logout: () => call<void>('POST', '/api/auth/logout'),
  state: () => call<State>('GET', '/api/state'),
  connections: () => call<Connections>('GET', '/api/connections'),

  execute: (task: string, context: Record<string, unknown>, key: string) =>
    call<Run>('POST', '/api/execute', {task, context}, {'idempotency-key': key}),
  run: (id: string) => call<Run>('GET', `/api/runs/${encodeURIComponent(id)}`),
  cancel: (id: string) => call<void>('POST', `/api/runs/${encodeURIComponent(id)}/cancel`, {}),
  resume: (id: string) => call<void>('POST', `/api/runs/${encodeURIComponent(id)}/resume`, {}),

  decide: (id: string, decision: 'once' | 'deny' | 'always' | 'never', answer?: string) =>
    call<void>('POST', `/api/approvals/${encodeURIComponent(id)}`, answer ? {decision, answer} : {decision}),
  reconcile: (actionId: string, evidence: string) =>
    call<void>('POST', `/api/actions/${encodeURIComponent(actionId)}/reconcile`, {evidence}),

  saveAgent: (agent: Pick<Agent, 'name' | 'title' | 'instructions' | 'runtime' | 'skills'> & Partial<Pick<Agent, 'provider' | 'model'>>) =>
    call<Agent>('PUT', '/api/agent', agent),

  addMemory: (kind: Memory['kind'], text: string) => call<Memory>('POST', '/api/memory', {kind, text}),
  removeMemory: (id: string) => call<void>('DELETE', `/api/memory/${encodeURIComponent(id)}`),
  addContact: (contact: Record<string, unknown>) => call<Contact>('POST', '/api/contacts', contact),
  removeContact: (id: string) => call<void>('DELETE', `/api/contacts/${encodeURIComponent(id)}`),

  // Raw bytes, not multipart: the gateway reads express.raw() with the name and
  // type in headers and caps the body at 20 MB.
  upload: (blob: Blob, name: string) =>
    call<Artifact>('POST', '/api/artifacts', blob, {'content-type': 'application/octet-stream', 'x-file-name': name, 'x-file-type': blob.type || 'application/octet-stream'}),
  removeArtifact: (id: string) => call<void>('DELETE', `/api/artifacts/${encodeURIComponent(id)}`),
  artifactUrl: (id: string) => `/api/artifacts/${encodeURIComponent(id)}/content`,

  addWorkflow: (name: string, task: string, scheduledAt?: string) =>
    call<Workflow>('POST', '/api/workflows', scheduledAt ? {name, task, scheduledAt} : {name, task}),
  removeWorkflow: (id: string) => call<void>('DELETE', `/api/workflows/${encodeURIComponent(id)}`),
  runWorkflow: (id: string, key: string) => call<Run>('POST', `/api/workflows/${encodeURIComponent(id)}/run`, {}, {'idempotency-key': key}),

  stopComputer: (id: string) => call<void>('POST', `/api/computers/${encodeURIComponent(id)}/stop`, {}),
  // The gateway pauses the employee at the browser provider before it answers;
  // a refusal comes back as an error, and control never changes on this side alone.
  takeOver: (id: string) => call<Pick<Computer, 'id' | 'status' | 'control'>>('POST', `/api/computers/${encodeURIComponent(id)}/takeover`, {}),
  handBack: (id: string) => call<Pick<Computer, 'id' | 'status' | 'control'>>('POST', `/api/computers/${encodeURIComponent(id)}/handback`, {}),
  deleteEverything: () => call<void>('DELETE', '/api/employee-data'),

  // The room JWT is minted server-side and lives 15 minutes. The realtime API
  // secret never reaches this client.
  realtimeTicket: (source: 'phone' | 'glasses') =>
    call<{url: string; room: string; token: string}>('POST', '/livekit-token', {source}),
};

export type GatewayEvent =
  | {seq: number; type: 'run.updated'; runId: string; status: RunStatus; at: string}
  | {seq: number; type: 'approval.requested'; runId: string; approvalId: string; at: string}
  | {seq: number; type: 'approval.decided'; runId: string; approvalId: string; decision: string; at: string}
  | {seq: number; type: 'tool.started' | 'tool.completed' | 'tool.failed' | 'tool.permission'; runId: string; at: string; [k: string]: any}
  | {seq: number; type: 'communication.updated'; at: string; [k: string]: any}
  | {seq: number; type: 'stream.ready'};

/**
 * Replayable owner-scoped event stream. EventSource cannot set headers, so the
 * cursor rides as ?after= -- the gateway accepts that or Last-Event-ID, and
 * resuming from the last seq is what stops a reconnect from replaying work the
 * UI already showed.
 */
export function subscribe(onEvent: (e: GatewayEvent) => void, onStatus: (online: boolean) => void) {
  let source: EventSource | null = null, cursor = 0, retry = 0, timer: number | undefined, stopped = false;
  const open = () => {
    if (stopped) return;
    // A first connection starts at now and is told where that is; a reconnect resumes from the last event seen.
    source = new EventSource(cursor ? `/api/events?after=${cursor}` : '/api/events', {withCredentials: true});
    source.onopen = () => {retry = 0; onStatus(true);};
    source.onmessage = ev => {
      const parsed = safeJson(ev.data) as GatewayEvent | undefined;
      if (!parsed) return;
      cursor = Number(ev.lastEventId || parsed.seq || cursor);
      onEvent(parsed);
    };
    source.onerror = () => {
      onStatus(false);
      source?.close();
      // Backoff caps at 15s so a phone that slept for an hour still reconnects
      // promptly on wake instead of sitting out an ever-growing delay.
      timer = self.setTimeout(open, Math.min(15000, 500 * 2 ** retry++));
    };
  };
  open();
  return () => {stopped = true; clearTimeout(timer); source?.close();};
}

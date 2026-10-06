// Keeps each viewer's preview between visits. In a claude.ai viewer the page
// saves its account to the viewer's own private corner of the artifact's
// database (data/users/<their id>/preview), which nobody else -- the artifact's
// owner included -- can read. Anywhere else (a local build, a test, a viewer
// who may not save) the preview lasts until the page closes, and says so.
//
// One document, written after a pause in changes and only when something
// changed; one write at a time. Photos are not kept: a document holds at most
// 256 KiB, so the oldest tasks are trimmed to stay well under it.
import type {State} from '../src/api';

/** What is kept between visits. */
export interface Saved {
  state: State;
  signedOut: boolean;
  /** Tools the owner chose "Always allow" for. */
  allowed: string[];
  /** Connected apps the owner disconnected in the preview. */
  appsOff: string[];
}

interface DocSnapshot {exists: boolean; data(): Record<string, unknown> | undefined}
interface DocRef {get(): Promise<DocSnapshot>; set(data: Record<string, unknown>): Promise<void>; delete(): Promise<void>}
interface Db {collection(path: string): {doc(id: string): DocRef}}
interface User {id(): Promise<string | null>}
type Host = {use?(name: string): Promise<unknown>};

const VERSION = 1;
/** Leave room under the 256 KiB document limit. */
const BUDGET = 200_000;
const PAUSE_MS = 2000;

let doc: DocRef | null = null;
/** Why saving stopped for this visit, once it has. */
let stopped: string | null = null;
let last = '';
let timer: ReturnType<typeof setTimeout> | undefined;
let queue: Promise<boolean> = Promise.resolve(true);
let onStop: ((why: string) => void) | null = null;

/** True while this visit's changes are being kept for the next one. */
export const saving = () => !!doc && !stopped;
/** Told once if saving stops partway through a visit. */
export function whenSavingStops(fn: (why: string) => void) {onStop = fn;}

const code = (err: unknown) => String((err as {code?: unknown} | null)?.code ?? 'unavailable');

/**
 * The viewer's saved preview, or null when there is none or nowhere to keep one. Gives up after `limitMs`, and
 * then saves nothing this visit: a late answer must never be overwritten with a fresh start.
 */
export async function load(limitMs = 8000): Promise<Saved | null> {
  const host = (globalThis as {claude?: Host}).claude;
  if (typeof host?.use !== 'function') return null;
  let gaveUp = false;
  const found = (async () => {
    const [db, user] = await Promise.all([host.use!('db').catch(() => null), host.use!('user').catch(() => null)]) as [Db | null, User | null];
    const id = db && typeof user?.id === 'function' ? await user.id().catch(() => null) : null;
    if (!db || !id) return null;
    const ref = db.collection(`data/users/${id}`).doc('preview');
    const snap = await ref.get();
    if (gaveUp) return null;
    doc = ref;
    return snap.exists ? revive(snap.data()) : null;
  })();
  const timeout = new Promise<null>(resolve => setTimeout(() => {gaveUp = true; resolve(null);}, limitMs));
  try {return await Promise.race([found, timeout]);} catch {doc = null; return null;}
}

function revive(data: Record<string, unknown> | undefined): Saved | null {
  if (!data || data.version !== VERSION || typeof data.state !== 'object' || !data.state) return null;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  last = JSON.stringify({state: data.state, signedOut: !!data.signedOut, allowed: list(data.allowed), appsOff: list(data.appsOff)});
  return {state: data.state as State, signedOut: !!data.signedOut, allowed: list(data.allowed), appsOff: list(data.appsOff)};
}

let latest: (() => Saved) | null = null;
/** Save after the current burst of changes settles. */
export function schedule(snapshot: () => Saved) {
  if (!saving()) return;
  latest = snapshot;
  clearTimeout(timer);
  timer = setTimeout(() => void flush(snapshot), PAUSE_MS);
}
// Leaving the page with a save still waiting: try to make it now.
addEventListener('pagehide', () => {if (latest && timer !== undefined) void flush(latest);});

/** Save now, after any write already under way. Resolves false when it could not be saved. */
export function flush(snapshot: () => Saved): Promise<boolean> {
  clearTimeout(timer);
  timer = undefined;
  if (!saving()) return Promise.resolve(!doc);
  queue = queue.then(() => write(snapshot()), () => write(snapshot()));
  return queue;
}

async function write(saved: Saved): Promise<boolean> {
  if (!doc || stopped) return false;
  const body = {...saved, state: fit(saved.state)};
  const text = JSON.stringify(body);
  if (text === last) return true;
  for (let attempt = 0; ; attempt++) {
    try {
      await doc.set({version: VERSION, ...body, savedAt: new Date().toISOString()});
      last = text;
      return true;
    } catch (err) {
      const c = code(err);
      // A brief hiccup gets one more try; anything else will not fix itself this visit.
      if (c === 'unavailable' && attempt === 0) {await new Promise(r => setTimeout(r, 400 + Math.random() * 800)); continue;}
      stop(c === 'quota_exceeded' ? 'The preview\'s storage is full, so changes are no longer saved.'
        : c === 'invalid_argument' ? 'This view cannot save, so changes last until you close the page.'
        : 'Saving stopped, so changes last until you close the page.');
      return false;
    }
  }
}

function stop(why: string) {
  if (stopped) return;
  stopped = why;
  onStop?.(why);
}

/** Forget what was saved, for Reset. Resolves false when it could not be forgotten. */
export async function clear(): Promise<boolean> {
  clearTimeout(timer);
  timer = undefined;
  if (!doc) return true;
  try {
    await queue.catch(() => false);
    await doc.delete();
    // Nothing more is saved from this page: it is about to reload, and leaving must not write the old account back.
    stopped = 'cleared';
    latest = null;
    return true;
  } catch {
    return false;
  }
}

/**
 * The account trimmed to fit one document: the newest tasks with what belongs to them, and everything the owner
 * set up (memory, people, routines, the employee). Browsers and the files' contents never outlive the page.
 */
export function fit(state: State): State {
  for (let keep = 60; ; keep = Math.floor(keep / 2)) {
    const out = trimmed(state, keep);
    if (JSON.stringify(out).length <= BUDGET || keep <= 2) return out;
  }
}

function trimmed(state: State, keep: number): State {
  const newest = <T extends {createdAt?: string; at?: string}>(rows: T[], n: number) =>
    [...rows].sort((a, b) => Date.parse(b.createdAt ?? b.at ?? '') - Date.parse(a.createdAt ?? a.at ?? '') || 0).slice(0, n);
  const runs = newest(state.run, keep);
  const kept = new Set(runs.map(r => r.id));
  const materials = state.material.filter(m => !m.runId || kept.has(m.runId)).slice(0, Math.max(2, Math.floor(keep / 6)));
  const asked = new Set(materials.map(m => m.id));
  const ofKept = <T extends {runId?: string}>(rows: T[]) => rows.filter(r => !r.runId || kept.has(r.runId));
  const clip = (s: unknown, n: number) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);
  return {
    ...state,
    run: runs.map(r => ({...r, result: clip(r.result, 4000) as string | undefined})),
    memory: state.memory.slice(0, 200),
    contact: state.contact.slice(0, 200),
    workflow: state.workflow.slice(0, 50),
    approval: ofKept(state.approval).slice(0, keep * 2),
    artifact: ofKept(state.artifact).filter(a => a.kind !== 'inspection_frame').slice(0, keep * 2).map(a => ({...a, text: clip(a.text, 2000) as string | undefined})),
    communication: state.communication.slice(0, keep * 2),
    material: materials,
    offer: state.offer.filter(o => !o.requestId || asked.has(o.requestId)),
    order: state.order.slice(0, keep),
    computer: [],
    action: ofKept(state.action as {runId?: string}[]).slice(0, keep) as State['action'],
  };
}

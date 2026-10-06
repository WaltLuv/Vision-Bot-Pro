import type {AppConnection, Connections, State} from '../api';
import type {Camera} from '../camera';
import type {Card, RealtimeSession, SessionState, TranscriptEntry} from '../realtime';

export type Tab = 'today' | 'tasks' | 'routines' | 'employee' | 'camera' | 'settings';

export interface Ctx {
  state: State;
  connections: Connections | null;
  /** Connected apps and their status, when the server has them set up. */
  apps: AppConnection[] | null;
  /** An app a task just asked for that is not connected. */
  appNeeded: string | null;
  /** Gateway event stream health, not network health in general. */
  streamOnline: boolean;
  session: RealtimeSession;
  sessionState: SessionState;
  sessionDetail?: string;
  camera: Camera;
  cameraMultiple: boolean;
  transcript: TranscriptEntry[];
  cards: Card[];
  tab: Tab;
  busy: boolean;
  owner: string;
  go(tab: Tab): void;
  /** Open the live view of one of the employee's browsers. */
  watch(computerId: string): void;
  refresh(): Promise<void>;
  rerender(): void;
  toast(message: string): void;
  signOut(): Promise<void>;
}

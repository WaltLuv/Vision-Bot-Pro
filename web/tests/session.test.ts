import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// A fake LiveKit room: joins at once, and lets a test decide whether the
// employee's voice worker is already there, joins later, or never comes.
const rooms: FakeRoom[] = [];
class FakeRoom {
  remoteParticipants = new Map<string, unknown>();
  localParticipant = {identity: 'owner', setMicrophoneEnabled: vi.fn(async () => {}), isMicrophoneEnabled: true,
    publishTrack: vi.fn(async () => {}), unpublishTrack: vi.fn(async (_t: unknown, _stop?: boolean) => {this.log.push('unpublish camera');})};
  disconnected: unknown[] = [];
  log: string[] = [];
  private handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  static employeeAlreadyThere = false;
  constructor() {rooms.push(this);}
  async connect() {if (FakeRoom.employeeAlreadyThere) this.remoteParticipants.set('agent', {});}
  on(event: string, fn: (...a: unknown[]) => void) {(this.handlers.get(event) ?? this.handlers.set(event, new Set()).get(event)!).add(fn); return this;}
  off(event: string, fn: (...a: unknown[]) => void) {this.handlers.get(event)?.delete(fn); return this;}
  emit(event: string, ...args: unknown[]) {for (const fn of [...(this.handlers.get(event) ?? [])]) fn(...args);}
  registerTextStreamHandler() {}
  async disconnect(...args: unknown[]) {this.disconnected.push(args); this.log.push('leave room'); this.emit('disconnected');}
  employeeJoins() {this.remoteParticipants.set('agent', {}); this.emit('participantConnected', {identity: 'agent'});}
}
class FakeLocalVideoTrack {constructor(readonly mediaStreamTrack: unknown) {}}
vi.mock('livekit-client', () => ({
  Room: FakeRoom,
  LocalVideoTrack: FakeLocalVideoTrack,
  Track: {Source: {Camera: 'camera'}},
  RoomEvent: {ConnectionStateChanged: 'connectionStateChanged', Disconnected: 'disconnected', ParticipantConnected: 'participantConnected'},
  ConnectionState: {Reconnecting: 'reconnecting', Connected: 'connected'},
}));
vi.mock('../src/api', async importOriginal => ({...(await importOriginal<typeof import('../src/api')>()), api: {realtimeTicket: async () => ({url: 'ws://127.0.0.1:7880', token: 't'})}}));
const {RealtimeSession, EMPLOYEE_JOIN_MS} = await import('../src/realtime');

function session() {
  const states: [string, string | undefined][] = [];
  const s = new RealtimeSession({onState: (state, detail) => states.push([state, detail]), onTranscript() {}, onCard() {}, onDismissCard() {}});
  return {s, states, last: () => states[states.length - 1]};
}

describe('a conversation waits for the employee to join', () => {
  beforeEach(() => {rooms.length = 0; FakeRoom.employeeAlreadyThere = false; vi.useFakeTimers();});
  afterEach(() => vi.useRealTimers());

  it('is live at once when the employee is already in the room', async () => {
    FakeRoom.employeeAlreadyThere = true;
    const {s, last} = session();
    await s.connect();
    expect(last()).toEqual(['live', undefined]);
  });

  it('says it is waiting, then is plainly live once the employee joins', async () => {
    const {s, last} = session();
    await s.connect();
    expect(last()).toEqual(['live', 'Waiting for your employee to join…']);
    rooms[0]!.employeeJoins();
    expect(last()).toEqual(['live', undefined]);
    vi.advanceTimersByTime(EMPLOYEE_JOIN_MS * 2);
    expect(last()).toEqual(['live', undefined]);
  });

  it('ends the call and says why when the employee never joins', async () => {
    const {s, last} = session();
    await s.connect();
    await vi.advanceTimersByTimeAsync(EMPLOYEE_JOIN_MS);
    expect(last()![0]).toBe('ended');
    expect(last()![1]).toMatch(/didn't join.*typing still works/);
    expect(s.live).toBe(false);
  });
});

// Leaving a room stops every track still published in it. The camera belongs to
// the preview, so ending a call must leave it running: stopped, the viewfinder
// froze on its last frame, photos came out black and the next call sent no video.
describe('ending a conversation', () => {
  beforeEach(() => {rooms.length = 0; FakeRoom.employeeAlreadyThere = true;});

  it('takes the camera out of the call without stopping it, then leaves', async () => {
    const {s} = session();
    await s.connect();
    await s.publishCamera({kind: 'video'} as MediaStreamTrack);
    await s.disconnect();
    const room = rooms[0]!;
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledTimes(1);
    expect(room.localParticipant.unpublishTrack.mock.calls[0]![1]).toBe(false);
    expect(room.log).toEqual(['unpublish camera', 'leave room']);
  });
});

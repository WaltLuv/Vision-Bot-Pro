// Realtime voice + vision session. The phone publishes microphone and camera
// into its own room; the existing worker joins that room, runs the realtime
// conversation and speaks back. Nothing here talks to a model provider: the
// room ticket is minted by the gateway and expires in 15 minutes.

import type {LocalVideoTrack, Room} from 'livekit-client';
import {api} from './api';

// The realtime SDK is ~400 kB of the bundle and is only needed once someone
// actually starts a conversation. Loading it on demand keeps the first paint on
// a phone to the app shell; everything else here works without it.
type LiveKit = typeof import('livekit-client');
let lk: LiveKit | null = null;
/** How long a started conversation waits for the employee's voice to join. */
export const EMPLOYEE_JOIN_MS = 20_000;
const loadLiveKit = async (): Promise<LiveKit> => (lk ??= await import('livekit-client'));

export type SessionState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'ended';

export interface TranscriptEntry {
  id: string;
  role: 'you' | 'employee';
  text: string;
  final: boolean;
  at: number;
}

/** The worker's own card payload on the vc.ui topic. */
export interface Card {
  uuid: string;
  version?: number;
  type?: 'info' | 'list' | 'image';
  title?: string;
  value?: string;
  body?: string;
  facts?: {label?: string; value?: string}[];
  items?: {title?: string; subtitle?: string; trailing?: string; glyph?: string}[];
  image_url?: string;
  fallback_text?: string;
  auto?: boolean;
  dismiss?: boolean;
}

export interface RealtimeHandlers {
  onState(state: SessionState, detail?: string): void;
  onTranscript(entry: TranscriptEntry): void;
  onCard(card: Card): void;
  onDismissCard(uuid: string): void;
}

// Naming the published video track "camera" is not cosmetic: the worker reads
// the track name to record whether a session ran on the phone or the glasses,
// and treats an unrecognised name as "unknown" rather than guessing.
const PHONE_TRACK_NAME = 'camera';

export class RealtimeSession {
  private room: Room | null = null;
  private cameraTrack: LocalVideoTrack | null = null;
  state: SessionState = 'idle';

  constructor(private readonly handlers: RealtimeHandlers) {}

  get live() {return this.state === 'live' || this.state === 'reconnecting';}
  get micEnabled() {return this.room?.localParticipant.isMicrophoneEnabled ?? false;}

  private set(state: SessionState, detail?: string) {
    this.state = state;
    this.handlers.onState(state, detail);
  }

  async connect(): Promise<void> {
    if (this.room) return;
    this.set('connecting');
    let ticket;
    try {
      ticket = await api.realtimeTicket('phone');
    } catch (err) {
      this.set('ended', err instanceof Error ? err.message : 'Could not start the conversation.');
      throw err;
    }
    const {Room} = await loadLiveKit();
    const room = new Room({adaptiveStream: true, dynacast: true});
    this.room = room;
    this.wire(room);
    try {
      await room.connect(ticket.url, ticket.token);
      await room.localParticipant.setMicrophoneEnabled(true);
      if (room.remoteParticipants.size) this.set('live');
      else this.awaitEmployee(room);
    } catch (err) {
      await this.disconnect();
      this.set('ended', 'The conversation could not connect. Check your network and try again.');
      throw err;
    }
  }

  /**
   * Being in the room is not talking to anyone: the employee's voice is a
   * separate worker that joins after. Until it does, say so; if it never does,
   * end the call and say why, instead of leaving the owner talking to no one.
   */
  private awaitEmployee(room: Room) {
    const {RoomEvent} = lk!;
    this.set('live', 'Waiting for your employee to join…');
    const joined = () => {
      clearTimeout(timer);
      room.off(RoomEvent.ParticipantConnected, joined);
      if (this.room === room) this.set('live');
    };
    const timer = setTimeout(async () => {
      room.off(RoomEvent.ParticipantConnected, joined);
      if (this.room !== room || room.remoteParticipants.size) return;
      await this.disconnect();
      this.set('ended', "Your employee didn't join the conversation. Voice isn't running on the server right now; typing still works.");
    }, EMPLOYEE_JOIN_MS);
    room.on(RoomEvent.ParticipantConnected, joined);
  }

  private wire(room: Room) {
    const {ConnectionState, RoomEvent} = lk!;
    room.on(RoomEvent.ConnectionStateChanged, s => {
      if (s === ConnectionState.Reconnecting) this.set('reconnecting');
      else if (s === ConnectionState.Connected && this.state === 'reconnecting') this.set('live');
    });
    room.on(RoomEvent.Disconnected, () => {this.room = null; this.cameraTrack = null; this.set('ended');});

    // Speech both ways arrives as lk.transcription text streams; the worker
    // enables input and output transcription on the realtime model.
    room.registerTextStreamHandler('lk.transcription', async (reader, info) => {
      const attrs = reader.info.attributes ?? {};
      const local = info.identity === room.localParticipant.identity;
      const text = await reader.readAll();
      if (!text.trim()) return;
      this.handlers.onTranscript({
        id: attrs['lk.segment_id'] || reader.info.id,
        role: local ? 'you' : 'employee',
        // The attribute arrives as a string over the wire even though it is
        // typed as boolean; treat anything but an explicit "false" as final so
        // a finished line is never left looking provisional.
        final: String(attrs['lk.transcription_final'] ?? 'true') !== 'false',
        text,
        at: Date.now(),
      });
    });

    // The worker's own visual cards. Untrusted content: rendered as text, never
    // as markup.
    room.registerTextStreamHandler('vc.ui', async reader => {
      let card: Card;
      try {card = JSON.parse(await reader.readAll());} catch {return;}
      if (!card?.uuid) return;
      if (card.dismiss) this.handlers.onDismissCard(card.uuid);
      else this.handlers.onCard(card);
    });
  }

  async setMicEnabled(on: boolean) {
    await this.room?.localParticipant.setMicrophoneEnabled(on);
  }

  /** Publish the already-running preview track, so preview and session share one camera. */
  async publishCamera(track: MediaStreamTrack) {
    if (!this.room || this.cameraTrack) return;
    const {LocalVideoTrack, Track} = await loadLiveKit();
    const local = new LocalVideoTrack(track, undefined, false);
    this.cameraTrack = local;
    await this.room.localParticipant.publishTrack(local, {name: PHONE_TRACK_NAME, source: Track.Source.Camera});
  }

  async unpublishCamera() {
    if (!this.room || !this.cameraTrack) return;
    // stopOnUnpublish=false: the preview owns this track's lifetime, and
    // stopping it here would blank the viewfinder that is still on screen.
    await this.room.localParticipant.unpublishTrack(this.cameraTrack, false);
    this.cameraTrack = null;
  }

  async disconnect() {
    const room = this.room, camera = this.cameraTrack;
    this.room = null;
    this.cameraTrack = null;
    if (room) {
      // Leaving a room stops every track still published in it. The camera is
      // the preview's, so it is taken out first and left running; the
      // microphone, which only this call opened, is stopped with the room.
      if (camera) await room.localParticipant.unpublishTrack(camera, false).catch(() => {});
      await room.disconnect();
    }
    this.set('ended');
  }
}

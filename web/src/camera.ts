// Camera capture for the phone. Owns exactly one MediaStream so switching
// lenses or stopping never leaks a camera that keeps the phone's indicator lit.

export type Facing = 'environment' | 'user';
export type CameraError = 'denied' | 'missing' | 'busy' | 'insecure' | 'unknown';

export interface CameraState {
  stream: MediaStream | null;
  facing: Facing;
  error: CameraError | null;
}

/** Distinguishes the cases worth telling a person apart, so the UI can give a real instruction. */
export function classifyError(err: unknown): CameraError {
  // getUserMedia is undefined outside a secure context, which is the one case a
  // person can fix by changing the URL rather than a permission setting.
  if (!globalThis.isSecureContext) return 'insecure';
  const name = (err as {name?: string})?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'missing';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  return 'unknown';
}

export class Camera {
  state: CameraState = {stream: null, facing: 'environment', error: null};
  /**
   * Called when the camera stops by itself -- another app took it, the OS
   * revoked it, a call library stopped it. A stopped track keeps showing its
   * last frame, so without this the viewfinder looked live while every photo
   * came out black.
   */
  onEnded?: () => void;

  get track(): MediaStreamTrack | undefined {return this.state.stream?.getVideoTracks()[0];}
  get running() {return !!this.state.stream;}

  /** True once a second lens is known to exist, so the flip control can stay hidden on a one-camera device. */
  async hasMultipleCameras(): Promise<boolean> {
    if (!navigator.mediaDevices?.enumerateDevices) return false;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter(d => d.kind === 'videoinput').length > 1;
    } catch {return false;}
  }

  async start(facing: Facing = this.state.facing): Promise<CameraState> {
    this.stop();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('unsupported'), {name: 'NotFoundError'});
      // 720p ideal rather than exact: an exact constraint fails outright on
      // phones whose front camera cannot hit it, and the worker downscales to
      // 1280 anyway.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {facingMode: {ideal: facing}, width: {ideal: 1280}, height: {ideal: 720}},
        audio: false,
      });
      this.state = {stream, facing, error: null};
      // stop() does not fire "ended"; only a stop from outside the app does.
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (this.state.stream !== stream) return;
        this.state = {...this.state, stream: null};
        this.onEnded?.();
      });
    } catch (err) {
      this.state = {stream: null, facing, error: classifyError(err)};
    }
    return this.state;
  }

  async flip(): Promise<CameraState> {
    return this.start(this.state.facing === 'environment' ? 'user' : 'environment');
  }

  stop() {
    this.state.stream?.getTracks().forEach(t => t.stop());
    this.state = {...this.state, stream: null};
  }

  /**
   * Freeze the view. Muting the video track is what the native clients do: the
   * worker keeps the last frame it received, so the pinned image is exactly
   * what any task started while pinned will carry as evidence.
   */
  setPinned(pinned: boolean) {
    const track = this.track;
    if (track) track.enabled = !pinned;
  }

  get pinned() {return this.track ? !this.track.enabled : false;}

  /** Still capture as JPEG bytes, sized from the live track rather than the CSS box. */
  async capture(video: HTMLVideoElement): Promise<Blob | null> {
    const width = video.videoWidth, height = video.videoHeight;
    if (!width || !height) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, width, height);
    return new Promise(resolve => canvas.toBlob(b => resolve(b), 'image/jpeg', 0.85));
  }
}

export const cameraMessage: Record<CameraError, string> = {
  denied: 'Camera access is off. Turn it on for this site in your browser settings, then try again.',
  missing: 'No camera was found on this device.',
  busy: 'Another app is using the camera. Close it and try again.',
  insecure: 'The camera needs a secure (https) connection.',
  unknown: 'The camera could not be started.',
};

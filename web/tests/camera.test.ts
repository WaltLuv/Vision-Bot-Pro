import {afterEach, describe, expect, it, vi} from 'vitest';
import {Camera, cameraMessage, classifyError} from '../src/camera';

// A fake device stack, so the Camera class's own logic is what is under test:
// which constraints it asks for, what it does with the previous stream, and how
// it reports a failure a person has to act on.
function fakeTrack() {
  // stop() ends the track without an "ended" event, as the spec has it; endFromOutside() is the OS or another app.
  const events = new EventTarget();
  return Object.assign(events, {kind: 'video', enabled: true, readyState: 'live', stop: vi.fn(function (this: any) {this.readyState = 'ended';}),
    endFromOutside(this: any) {this.readyState = 'ended'; this.dispatchEvent(new Event('ended'));}});
}
function fakeStream() {
  const track = fakeTrack();
  return {track, stream: {getVideoTracks: () => [track], getTracks: () => [track]} as unknown as MediaStream};
}
function install({cameras = 2, fail}: {cameras?: number; fail?: string} = {}) {
  const calls: MediaStreamConstraints[] = [];
  const made: ReturnType<typeof fakeStream>[] = [];
  const mediaDevices = {
    getUserMedia: vi.fn(async (c: MediaStreamConstraints) => {
      calls.push(c);
      if (fail) throw Object.assign(new Error(fail), {name: fail});
      const s = fakeStream();
      made.push(s);
      return s.stream;
    }),
    enumerateDevices: vi.fn(async () => Array.from({length: cameras}, (_, i) => ({kind: 'videoinput', deviceId: `cam${i}`}))),
  };
  vi.stubGlobal('navigator', {mediaDevices});
  vi.stubGlobal('isSecureContext', true);
  return {calls, made};
}
const facingOf = (c: MediaStreamConstraints) => ((c.video as MediaTrackConstraints).facingMode as {ideal: string}).ideal;

afterEach(() => vi.unstubAllGlobals());

describe('opening the camera', () => {
  it('starts on the rear lens, which is what a phone points at things with', async () => {
    const {calls} = install();
    const cam = new Camera();
    const state = await cam.start();
    expect(state.error).toBeNull();
    expect(state.facing).toBe('environment');
    expect(facingOf(calls[0]!)).toBe('environment');
  });

  // An exact constraint fails outright on phones whose front camera cannot
  // reach it; the worker downscales anyway.
  it('asks for 720p as a preference, not a requirement', async () => {
    const {calls} = install();
    await new Camera().start();
    const video = calls[0]!.video as MediaTrackConstraints;
    expect(video.width).toEqual({ideal: 1280});
    expect(video.height).toEqual({ideal: 720});
    expect(calls[0]!.audio).toBe(false);
  });

  it('does not ask for the microphone when opening the camera', async () => {
    const {calls} = install();
    await new Camera().start();
    expect(calls[0]!.audio).toBe(false);
  });
});

describe('switching lens', () => {
  // Only one synthetic camera exists in a browser test, so the swap itself is
  // covered here.
  it('flips between rear and front', async () => {
    const {calls} = install();
    const cam = new Camera();
    await cam.start();
    expect((await cam.flip()).facing).toBe('user');
    expect(facingOf(calls[1]!)).toBe('user');
    expect((await cam.flip()).facing).toBe('environment');
    expect(facingOf(calls[2]!)).toBe('environment');
  });

  // Leaving the old stream running keeps the phone's camera indicator lit and
  // holds a device the new stream may need.
  it('releases the previous camera before opening the next', async () => {
    const {made} = install();
    const cam = new Camera();
    await cam.start();
    await cam.flip();
    expect(made[0]!.track.stop).toHaveBeenCalled();
    expect(made[0]!.track.readyState).toBe('ended');
    expect(made[1]!.track.readyState).toBe('live');
  });

  it('offers the flip only when a second camera exists', async () => {
    install({cameras: 2});
    expect(await new Camera().hasMultipleCameras()).toBe(true);
    install({cameras: 1});
    expect(await new Camera().hasMultipleCameras()).toBe(false);
  });
});

describe('freezing and stopping', () => {
  it('freezes by disabling the outgoing track, so the worker keeps the last frame', async () => {
    install();
    const cam = new Camera();
    await cam.start();
    cam.setPinned(true);
    expect(cam.track!.enabled).toBe(false);
    expect(cam.pinned).toBe(true);
    cam.setPinned(false);
    expect(cam.track!.enabled).toBe(true);
    expect(cam.pinned).toBe(false);
  });

  it('stops every track and reports itself closed', async () => {
    const {made} = install();
    const cam = new Camera();
    await cam.start();
    cam.stop();
    expect(made[0]!.track.stop).toHaveBeenCalled();
    expect(cam.running).toBe(false);
    expect(cam.state.stream).toBeNull();
  });

  // A stopped track keeps showing its last frame: without noticing, the viewfinder
  // looked live while every photo came out black.
  it('reports itself off when the camera is stopped from outside the app', async () => {
    const {made} = install();
    const cam = new Camera();
    const ended = vi.fn();
    cam.onEnded = ended;
    await cam.start();
    made[0]!.track.endFromOutside();
    expect(cam.running).toBe(false);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('does not report a camera it has since replaced', async () => {
    const {made} = install();
    const cam = new Camera();
    const ended = vi.fn();
    cam.onEnded = ended;
    await cam.start();
    await cam.flip();
    made[0]!.track.endFromOutside();
    expect(cam.running).toBe(true);
    expect(ended).not.toHaveBeenCalled();
  });

  it('is safe to stop when it never started', () => {
    install();
    expect(() => new Camera().stop()).not.toThrow();
  });
});

describe('failures a person has to act on', () => {
  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'missing'],
    ['OverconstrainedError', 'missing'],
    ['NotReadableError', 'busy'],
    ['AbortError', 'busy'],
    ['WeirdUnknownError', 'unknown'],
  ])('reports %s as %s', async (name, expected) => {
    install({fail: name});
    const state = await new Camera().start();
    expect(state.error).toBe(expected);
    expect(state.stream).toBeNull();
    expect(cameraMessage[state.error!]).toBeTruthy();
  });

  // The one failure a person fixes by changing the URL rather than a setting.
  it('names an insecure page as the cause, since getUserMedia does not exist there', () => {
    vi.stubGlobal('isSecureContext', false);
    expect(classifyError(Object.assign(new Error('x'), {name: 'NotAllowedError'}))).toBe('insecure');
    expect(cameraMessage.insecure).toMatch(/secure \(https\) connection/);
  });

  it('does not claim a frame before the video has any', async () => {
    install();
    const cam = new Camera();
    await cam.start();
    expect(await cam.capture({videoWidth: 0, videoHeight: 0} as HTMLVideoElement)).toBeNull();
  });
});

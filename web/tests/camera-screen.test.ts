import {beforeEach, describe, expect, it, vi} from 'vitest';

const upload = vi.fn(async () => ({id: 'photo-1'}));
const execute = vi.fn(async () => ({id: 'run-1', status: 'queued'}));
vi.mock('../src/api', async importOriginal => ({...(await importOriginal<typeof import('../src/api')>()), api: {upload, execute}, newIdempotencyKey: () => 'key'}));
const {camera} = await import('../src/ui/camera');
const {mount} = await import('../src/dom');
import type {Ctx} from '../src/ui/ctx';

// "Point the camera at it and ask": the question has to arrive with the picture.
// Sent on its own, the employee was asked about a photo it never received.
function makeCtx(frame: Blob | null) {
  const toast = vi.fn();
  const ctx = {
    busy: false, cards: [], transcript: [], state: {run: [], approval: [], computer: [], artifact: [], action: []},
    camera: {running: !!frame, state: {stream: null, error: null}, capture: vi.fn(async () => frame)},
    session: {live: false}, sessionState: 'idle', rerender() {}, toast, refresh: vi.fn(async () => {}), go() {},
  } as unknown as Ctx;
  return {ctx, toast};
}
const ask = (ctx: Ctx, text: string) => {
  document.body.innerHTML = '<div id="app"></div>';
  mount(document.getElementById('app')!, camera(ctx));
  const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="What do you want to know about this?"]')!;
  box.value = text; box.dispatchEvent(new Event('input', {bubbles: true}));
  [...document.querySelectorAll('button')].find(b => b.textContent === 'Ask about this')!.click();
};

describe('camera: ask about this', () => {
  beforeEach(() => {upload.mockClear(); execute.mockClear();});

  it('sends the question with a photo of what the camera shows, as one task', async () => {
    const {ctx} = makeCtx(new Blob(['jpeg'], {type: 'image/jpeg'}));
    ask(ctx, 'Is this the right cartridge for a Moen shower?');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(upload).toHaveBeenCalledTimes(1);
    expect((execute.mock.calls[0] as unknown[])[0]).toBe('Is this the right cartridge for a Moen shower?');
    expect((execute.mock.calls[0] as unknown[])[1]).toMatchObject({attachments: ['photo-1']});
  });

  it('asks for the camera, and sends nothing, when there is no picture', async () => {
    const {ctx, toast} = makeCtx(null);
    ask(ctx, 'What is this?');
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0]?.[0]).toBe('Start the camera first, then ask.');
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('camera: the preview', () => {
  // The stream used to be attached by the Today screen only, so a camera
  // started on the Camera tab showed black and never produced a photo.
  it('shows a camera started from the Camera tab', () => {
    const stream = {id: 'camera-stream'} as unknown as MediaStream;
    const {ctx} = makeCtx(null);
    (ctx.camera as unknown as {state: {stream: MediaStream}}).state.stream = stream;
    document.body.innerHTML = '<div id="app"></div>';
    mount(document.getElementById('app')!, camera(ctx));
    expect(document.querySelector<HTMLVideoElement>('video.preview')!.srcObject).toBe(stream);
  });

  // Another tab takes the preview out of the page and the browser pauses it;
  // back on the camera it stayed frozen, and "Send photo" sent that old frame.
  it('plays again when it comes back on screen', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const {ctx} = makeCtx(null);
    (ctx.camera as unknown as {state: {stream: MediaStream}}).state.stream = {id: 'camera-stream'} as unknown as MediaStream;
    document.body.innerHTML = '<div id="app"></div>';
    mount(document.getElementById('app')!, camera(ctx));
    await Promise.resolve();
    expect(play).toHaveBeenCalled();
    play.mockRestore();
  });
});

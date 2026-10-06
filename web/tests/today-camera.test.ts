import {beforeEach, describe, expect, it, vi} from 'vitest';

const upload = vi.fn(async () => ({id: 'photo-1'}));
const execute = vi.fn(async () => ({id: 'run-1', status: 'queued'}));
vi.mock('../src/api', async importOriginal => ({...(await importOriginal<typeof import('../src/api')>()), api: {upload, execute}, newIdempotencyKey: () => 'key'}));
const {today} = await import('../src/ui/today');
const {mount} = await import('../src/dom');
import type {Ctx} from '../src/ui/ctx';

// Today carries everything the Camera tab did: the camera panel, and a question about
// what it shows sent WITH a photo of it. Sent on its own, the employee was asked about
// a photo it never received.
function makeCtx(frame: Blob | null, running = !!frame) {
  const toast = vi.fn();
  const ctx = {
    owner: 'owner', busy: false, streamOnline: true, cards: [], transcript: [], sessionDetail: '',
    state: {run: [], approval: [], computer: [], artifact: [], action: [], agent: [], memory: [], contact: [], material: [], offer: []},
    camera: {running, pinned: false, state: {stream: null, error: null}, capture: vi.fn(async () => frame)},
    session: {live: false}, sessionState: 'idle', rerender() {}, toast, refresh: vi.fn(async () => {}), go() {},
  } as unknown as Ctx;
  return {ctx, toast};
}
const show = (ctx: Ctx) => {document.body.innerHTML = '<div id="app"></div>'; mount(document.getElementById('app')!, today(ctx));};
const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent === text);
const ask = (ctx: Ctx, text: string) => {
  show(ctx);
  const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Ask or assign something"]')!;
  box.value = text; box.dispatchEvent(new Event('input', {bubbles: true}));
  button('📷 Ask about this photo')!.click();
};

describe('today: ask about what the camera shows', () => {
  beforeEach(() => {upload.mockClear(); execute.mockClear();});

  it('sends the question with a photo of what the camera shows, as one task', async () => {
    const {ctx} = makeCtx(new Blob(['jpeg'], {type: 'image/jpeg'}));
    ask(ctx, 'Is this the right cartridge for a Moen shower?');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(upload).toHaveBeenCalledTimes(1);
    expect((execute.mock.calls[0] as unknown[])[0]).toBe('Is this the right cartridge for a Moen shower?');
    expect((execute.mock.calls[0] as unknown[])[1]).toMatchObject({source: 'phone', attachments: ['photo-1']});
  });

  it('says so, and sends nothing, when the camera has no frame yet', async () => {
    const {ctx, toast} = makeCtx(null, true);
    ask(ctx, 'What is this?');
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0]?.[0]).toBe('The camera has not produced a frame yet.');
    expect(execute).not.toHaveBeenCalled();
  });

  it('asks for a question before sending a photo', async () => {
    const {ctx, toast} = makeCtx(new Blob(['jpeg']));
    ask(ctx, '   ');
    await vi.waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0]?.[0]).toBe('Type or say what you want to know first.');
    expect(upload).not.toHaveBeenCalled();
  });

  it('offers it only while the camera is on; plain Send still works without it', () => {
    show(makeCtx(null, false).ctx);
    expect(button('📷 Ask about this photo')).toBeUndefined();
    expect(button('Send')).toBeDefined();
    expect(button('Start camera')).toBeDefined();
  });
});

describe('today: the camera preview', () => {
  it('shows a started camera', () => {
    const stream = {id: 'camera-stream'} as unknown as MediaStream;
    const {ctx} = makeCtx(null);
    (ctx.camera as unknown as {state: {stream: MediaStream}}).state.stream = stream;
    show(ctx);
    expect(document.querySelector<HTMLVideoElement>('video.preview')!.srcObject).toBe(stream);
  });

  // Another tab takes the preview out of the page and the browser pauses it; back on
  // Today it stayed frozen, and "Send photo" sent that old frame.
  it('plays again when it comes back on screen', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const {ctx} = makeCtx(null);
    (ctx.camera as unknown as {state: {stream: MediaStream}}).state.stream = {id: 'camera-stream'} as unknown as MediaStream;
    show(ctx);
    await Promise.resolve();
    expect(play).toHaveBeenCalled();
    play.mockRestore();
  });

  it('keeps flip, freeze and send photo on Today', () => {
    const {ctx} = makeCtx(null);
    (ctx as unknown as {cameraMultiple: boolean}).cameraMultiple = true;
    (ctx.camera as unknown as {state: {stream: MediaStream; facing: string}}).state = {stream: {id: 's'} as unknown as MediaStream, facing: 'environment'};
    show(ctx);
    for (const label of ['Stop camera', 'Front camera', 'Freeze frame', 'Send photo']) expect(button(label), label).toBeDefined();
  });
});

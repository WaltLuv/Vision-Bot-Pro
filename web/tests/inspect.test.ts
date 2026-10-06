import {afterEach, describe, expect, it, vi} from 'vitest';

const inspect = vi.fn();
const forgetSignins = vi.fn(async () => {});
vi.mock('../src/api', async importOriginal => ({...(await importOriginal<typeof import('../src/api')>()), api: {inspect, forgetSignins, saveAgent: vi.fn(async () => ({}))}}));
const {inspectionPanel, inspectionOverlay, startInspecting, stopInspecting} = await import('../src/ui/inspect');
const {settings} = await import('../src/ui/settings');
import type {Ctx} from '../src/ui/ctx';

const CRACK = {type: 'crack', severity: 'high', confidence: 0.8, description: 'Possible diagonal crack', location: 'upper left', box: [100, 0, 500, 500], recommendation: 'Measure it'};
const ctxFor = (over: object = {}) => ({tab: 'today', camera: {running: true, state: {stream: {}}}, rerender: vi.fn(), toast: vi.fn(), ...over}) as unknown as Ctx;
afterEach(() => {stopInspecting(); inspect.mockReset();});

describe('inspection mode', () => {
  it('sends a frame, shows what was found worst first, and says when to call a professional', async () => {
    inspect.mockResolvedValue({inspectionId: 'i1', photoId: 'p1', findings: [CRACK], summary: 'Checked the wall.', needsProfessional: true});
    const ctx = ctxFor(), frame = new Blob(['jpeg'], {type: 'image/jpeg'});
    startInspecting(ctx, async () => frame);
    await vi.waitFor(() => expect(ctx.rerender).toHaveBeenCalled());
    expect(inspect).toHaveBeenCalledWith(frame, '');
    const panel = inspectionPanel(ctx, async () => frame)!;
    expect(panel.textContent).toContain('1 possible finding');
    expect(panel.textContent).toContain('Possible diagonal crack');
    expect(panel.textContent).toContain('qualified professional');
    expect(panel.textContent).toContain('not a diagnosis');
  });

  it('draws each box through the preview\'s crop of the frame', async () => {
    inspect.mockResolvedValue({inspectionId: 'i1', photoId: 'p1', findings: [CRACK], summary: '', needsProfessional: false});
    const ctx = ctxFor();
    startInspecting(ctx, async () => new Blob(['x']));
    await vi.waitFor(() => expect(ctx.rerender).toHaveBeenCalled());
    // A 4:3 landscape frame in the 3:4 preview: shown 16/9 as wide as the box, centred.
    const video = {videoWidth: 640, videoHeight: 480} as HTMLVideoElement;
    const box = inspectionOverlay(video)!.querySelector<HTMLElement>('.inspect-box')!;
    const w = (640 / 480) / (3 / 4), left = (1 - w) / 2;
    expect(parseFloat(box.style.left)).toBeCloseTo(left * 100, 3);
    expect(parseFloat(box.style.width)).toBeCloseTo(0.5 * w * 100, 3);
    expect(parseFloat(box.style.top)).toBeCloseTo(10, 3);
    expect(box.textContent).toBe('crack');
  });

  it('stops and says why when a frame cannot be checked, and sends nothing while one is still on its way', async () => {
    inspect.mockRejectedValue(new Error('Inspection needs a Gemini key (GEMINI_API_KEY or GOOGLE_API_KEY).'));
    const ctx = ctxFor();
    startInspecting(ctx, async () => new Blob(['x']));
    await vi.waitFor(() => expect(ctx.rerender).toHaveBeenCalled());
    const panel = inspectionPanel(ctx, async () => null)!;
    expect(panel.textContent).toContain('needs a Gemini key');
    expect([...panel.querySelectorAll('button')].map(b => b.textContent)).toEqual(['🔍 Inspect for damage']);
  });

  it('is offered only while the camera is on', () => {
    expect(inspectionPanel(ctxFor({camera: {running: false, state: {stream: null}}}), async () => null)).toBeNull();
  });
});

describe('store sign-ins in Settings', () => {
  const screen = (signins: object | null) => settings({owner: 'o', streamOnline: true, connections: {suppliers: [], mcp: []}, state: {agent: []}, signins, refresh: async () => {}, toast() {}} as unknown as Ctx);
  it('names the stores signed in to, never what is stored, and can forget them', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const el = screen({enabled: true, domains: ['homedepot.com', 'lowes.com'], saved: ['homedepot.com'], savedAt: '2026-10-01T00:00:00Z'});
    const card = [...el.querySelectorAll('section')].find(s => s.textContent?.includes('Store sign-ins'))!;
    expect(card.textContent).toContain('Signed in to The Home Depot');
    expect(card.textContent).toContain('never to pay');
    [...card.querySelectorAll('button')].find(b => b.textContent === 'Forget saved sign-ins')!.click();
    await vi.waitFor(() => expect(forgetSignins).toHaveBeenCalled());
  });
  it('explains how to sign in when none are saved, and says so when the server cannot keep them', () => {
    const none = [...screen({enabled: true, domains: ['homedepot.com', 'lowes.com'], saved: [], savedAt: null}).querySelectorAll('section')].find(s => s.textContent?.includes('Store sign-ins'))!;
    expect(none.textContent).toContain('tap Take over in the live browser and sign in yourself');
    const off = [...screen(null).querySelectorAll('section')].find(s => s.textContent?.includes('Store sign-ins'))!;
    expect(off.textContent).toContain('not set up on this server');
  });
});

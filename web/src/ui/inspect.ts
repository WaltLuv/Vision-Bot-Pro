import {api, type Inspection} from '../api';
import {h} from '../dom';
import type {Ctx} from './ctx';

/**
 * Inspection mode: while it is on, a frame of what the camera shows goes to the gateway every few seconds, Gemini
 * checks it for structural anomalies, and what it found is drawn over the preview and listed under it. One frame
 * at a time: a slow answer is never overtaken by a newer frame, and frames are not queued up behind it. It stops
 * when the camera stops or the screen changes.
 */
let on = false;
let every = 4000;
let focus = '';
let inFlight = false;
let timer: number | undefined;
let latest: (Inspection & {at: number}) | null = null;
let failure = '';

export const inspecting = () => on;
export const latestInspection = () => latest;

export function stopInspecting() {
  on = false;
  clearInterval(timer); timer = undefined;
}

export function startInspecting(ctx: Ctx, capture: () => Promise<Blob | null>) {
  on = true; failure = ''; latest = null;
  clearInterval(timer);
  const tick = async () => {
    if (!on) return;
    if (!ctx.camera.running || ctx.tab !== 'today') {stopInspecting(); ctx.rerender(); return;}
    if (inFlight) return;
    inFlight = true;
    try {
      const frame = await capture();
      if (!frame) return;
      latest = {...await api.inspect(frame, focus), at: Date.now()};
      failure = '';
    } catch (err) {
      failure = err instanceof Error ? err.message : 'That frame could not be checked.';
      // A refusal (no Gemini key, rate limit) will not fix itself on the next frame; stop and say so.
      stopInspecting();
    } finally {
      inFlight = false;
      ctx.rerender();
    }
  };
  void tick();
  timer = self.setInterval(() => void tick(), every);
}

const SEVERITY_CLASS: Record<string, string> = {low: 'sev-low', medium: 'sev-medium', high: 'sev-high', critical: 'sev-critical'};
const label = (type: string) => type.replace(/_/g, ' ');

/**
 * Boxes over the preview. Gemini's boxes are on the whole frame (0-1000); the preview shows that frame cropped to
 * fill a 3:4 box, so each box is mapped through the same crop.
 */
export function inspectionOverlay(video: HTMLVideoElement): HTMLElement | null {
  if (!on || !latest?.findings.length) return null;
  const vw = video.videoWidth || 3, vh = video.videoHeight || 4, frame = vw / vh, box = 3 / 4;
  const w = frame > box ? frame / box : 1, hgt = frame > box ? 1 : box / frame, ox = (1 - w) / 2, oy = (1 - hgt) / 2;
  return h('div', {class: 'inspect-overlay', 'aria-hidden': 'true'}, ...latest.findings.filter(f => f.box?.length === 4).map(f => {
    const [ymin, xmin, ymax, xmax] = f.box!.map(v => v / 1000) as [number, number, number, number];
    const el = h('div', {class: `inspect-box ${SEVERITY_CLASS[f.severity] ?? ''}`}, h('span', {text: label(f.type)}));
    el.style.left = `${(ox + xmin * w) * 100}%`; el.style.top = `${(oy + ymin * hgt) * 100}%`;
    el.style.width = `${(xmax - xmin) * w * 100}%`; el.style.height = `${(ymax - ymin) * hgt * 100}%`;
    return el;
  }));
}

/** The controls and what was found, under the camera. */
export function inspectionPanel(ctx: Ctx, capture: () => Promise<Blob | null>): HTMLElement | null {
  if (!ctx.camera.state.stream) return null;
  const what = h('input', {class: 'field', 'aria-label': 'What are you checking?', placeholder: 'What are you checking? (optional)', value: focus});
  what.addEventListener('input', () => {focus = what.value.slice(0, 300);});
  const pace = h('select', {class: 'field', 'aria-label': 'How often'}, h('option', {value: '3000', text: 'Every 3 seconds'}), h('option', {value: '4000', text: 'Every 4 seconds'}), h('option', {value: '8000', text: 'Every 8 seconds'}));
  pace.value = String(every);
  pace.addEventListener('change', () => {every = Number(pace.value); if (on) startInspecting(ctx, capture);});
  const findings = latest?.findings ?? [];
  return h('div', {class: 'inspect'},
    h('div', {class: 'row wrap'},
      h('button', {class: on ? 'ghost' : 'primary', onclick: () => {if (on) stopInspecting(); else startInspecting(ctx, capture); ctx.rerender();}}, on ? '■ Stop inspecting' : '🔍 Inspect for damage'),
      on ? pace : null),
    on ? what : null,
    on && !latest ? h('p', {class: 'note', text: 'Checking the first frame…'}) : null,
    failure ? h('p', {class: 'note', text: failure}) : null,
    latest ? h('div', {class: 'inspect-results', role: 'status', 'aria-live': 'polite'},
      h('p', {class: 'eyebrow', text: findings.length ? `${findings.length} possible finding${findings.length === 1 ? '' : 's'}` : 'Nothing wrong visible'}),
      ...findings.slice(0, 5).map(f => h('div', {class: 'row-item'},
        h('p', {class: 'task', text: f.description}),
        h('span', {class: `pill ${SEVERITY_CLASS[f.severity] ?? ''}`, text: f.severity}),
        h('p', {class: 'note', text: [f.location, f.recommendation].filter(Boolean).join(' · ')}))),
      findings.length ? null : h('p', {class: 'note', text: latest.summary}),
      latest.needsProfessional ? h('p', {class: 'note warn-text', text: 'Have a qualified professional look at this before relying on it.'}) : null,
      h('p', {class: 'note', text: 'Observations from the camera, not a diagnosis. Each checked frame is saved with your tasks.'})) : null,
  );
}

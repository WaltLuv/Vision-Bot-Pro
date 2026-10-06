// Damage inspection in the preview. While inspection is on, the app sends a
// camera frame every few seconds; the gateway has Gemini look at it, and here
// Claude does, with the gateway's own instructions, and the answer comes back
// in the gateway's shape: findings with boxes drawn over the camera, a
// summary, and whether a professional should look.
//
// Claude is asked only when the picture is new. The preview's camera shows the
// sample scene or a photo the owner picked; each is checked once, and further
// frames of the same picture get the same answer without spending the viewer's
// Claude usage again on a timer.
import type {Finding, Inspection} from '../src/api';
import {lookAt} from './employee';
import {HttpError, newId, preview} from './gateway';

const ANOMALIES = ['crack', 'water_damage', 'mold', 'rot', 'corrosion', 'sagging', 'displacement', 'spalling', 'efflorescence', 'pest_damage', 'missing_fastener', 'leak', 'electrical_hazard', 'fire_hazard', 'trip_hazard', 'other'];
const SEVERITIES: Finding['severity'][] = ['low', 'medium', 'high', 'critical'];
// Kept as a rule, not only asked of the model: a high structural, electrical or fire finding always says so.
const SERIOUS = ['crack', 'sagging', 'displacement', 'rot', 'electrical_hazard', 'fire_hazard', 'water_damage'];

const PROMPT = `You are assisting a property and field technician. Look at this camera frame for structural and building anomalies: cracks, water damage or staining, mold, rot, corrosion, sagging or deflection, displacement or settlement, spalling, efflorescence, pest damage, missing or failed fasteners, active leaks, electrical or fire hazards, trip hazards.
Report only what is visible. Use cautious wording ("possible hairline crack"), never a diagnosis. For each finding give its type, severity, your confidence from 0 to 1, a short description, where it is in the frame, a bounding box as [ymin, xmin, ymax, xmax] scaled 0-1000 over the whole image, and the next step. If nothing is wrong, return no findings and say what you checked. Set needsProfessional when a finding is high or critical and structural, electrical or a fire hazard.`;
const SHAPE = `Answer with JSON only, in exactly this shape, with at most 8 findings:
{"findings":[{"type":"${ANOMALIES.join('|')}","severity":"low|medium|high|critical","confidence":0.7,"description":"...","location":"...","box":[ymin,xmin,ymax,xmax],"recommendation":"..."}],"summary":"...","needsProfessional":false}`;

/** Which picture the camera shows: the sample scene (0), then each photo the owner picks. */
let picture = 0;
export const pictureChanged = () => {picture += 1;};
let last: {key: string; result: Inspection} | null = null;
const frames: string[] = [];

const WHY: Record<string, [number, string]> = {
  not_granted: [403, 'Damage inspection needs Claude, which you did not allow for this page. Reload the page and allow it when asked.'],
  images_unavailable: [503, 'Claude cannot look at pictures in this view, so damage inspection is not available here.'],
  image_rejected: [400, 'That picture could not be checked. Try another photo.'],
  rate_limited: [429, 'Too many requests to Claude just now, or your usage limit was reached. Try again later.'],
  invalid_json: [502, 'Claude\'s answer could not be read. Tap Inspect for damage to try again.'],
  cancelled: [409, 'Stopped.'],
};
const NO_CLAUDE: [number, string] = [503, 'Damage inspection needs Claude. Open this page on claude.ai or in the Claude app and allow it to use Claude when asked.'];

export async function inspect(frame: Blob, focus: string): Promise<Inspection> {
  const key = `${picture}|${focus.trim().toLowerCase()}`;
  if (last?.key === key) return last.result;
  let raw: unknown;
  try {
    raw = await lookAt(`${PROMPT}${focus ? `\nThe technician is checking: ${focus}` : ''}\n\n${SHAPE}`, frame);
  } catch (err) {
    const code = String((err as {code?: unknown} | null)?.code ?? 'upstream_error');
    const [status, message] = WHY[code] ?? (['sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(code) ? NO_CLAUDE
      : [502, 'Claude could not check the frame just now. Try again in a moment.']);
    throw new HttpError(status, message);
  }
  // The checked frame is kept with the account while the page is open, as the gateway keeps it.
  const photoId = newId('artifact');
  preview.uploads.set(photoId, frame);
  preview.state.artifact.unshift({id: photoId, kind: 'inspection_frame', name: `Inspection ${new Date().toLocaleString('en-US')}`, mime: frame.type || 'image/jpeg'});
  frames.push(photoId);
  while (frames.length > 10) {
    const old = frames.shift()!;
    preview.uploads.delete(old);
    preview.state.artifact = preview.state.artifact.filter(a => a.id !== old);
  }
  const result = {inspectionId: newId('inspection'), photoId, ...shape(raw)};
  last = {key, result};
  return result;
}

/** Claude's answer, held to the gateway's schema: known types and severities, boxes inside the frame, most serious first. */
function shape(raw: unknown): Omit<Inspection, 'inspectionId' | 'photoId'> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const findings: Finding[] = (Array.isArray(r.findings) ? r.findings : []).slice(0, 12).flatMap(f => {
    const x = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
    const description = String(x.description ?? '').trim().slice(0, 300);
    if (!description) return [];
    const box = Array.isArray(x.box) ? x.box.map(Number) : [];
    const boxed = box.length === 4 && box.every(v => Number.isFinite(v) && v >= 0 && v <= 1000) && box[0]! < box[2]! && box[1]! < box[3]!;
    return [{
      type: ANOMALIES.includes(String(x.type)) ? String(x.type) : 'other',
      severity: SEVERITIES.find(s => s === x.severity) ?? 'low',
      confidence: Math.min(1, Math.max(0, Number(x.confidence) || 0)),
      description,
      location: String(x.location ?? '').trim().slice(0, 200),
      ...(boxed ? {box} : {}),
      recommendation: String(x.recommendation ?? '').trim().slice(0, 300),
    }];
  });
  findings.sort((a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) || b.confidence - a.confidence);
  const serious = findings.some(f => (f.severity === 'high' || f.severity === 'critical') && SERIOUS.includes(f.type));
  return {findings, summary: String(r.summary ?? '').trim().slice(0, 600) || (findings.length ? '' : 'Nothing wrong was visible in this frame.'),
    needsProfessional: r.needsProfessional === true || serious};
}

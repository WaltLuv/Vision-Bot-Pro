import {z} from 'zod';
import {Store} from './db.js';import {Refused,ToolGateway} from './tools.js';import {artifactBytes} from './artifacts.js';import {geminiKey} from './grounded.js';import {visionModel} from './parts.js';import {redactText} from './redact.js';
/**
 * Structural anomaly detection: a camera frame goes to Gemini's vision model with a fixed schema, and comes back as
 * findings (a crack, water damage, rot, sagging, corrosion...) each with a severity, a confidence, where it is in
 * the frame and what to do next. The phone sends frames while inspection is on; the voice agent sends the frame
 * it is looking at; the employee can inspect an attached photo. Every inspection is kept as task evidence.
 *
 * What comes back is an observation, never a diagnosis: the wording says "possible", and anything structural or
 * electrical at high severity says to have a professional look.
 */
export const ANOMALIES=['crack','water_damage','mold','rot','corrosion','sagging','displacement','spalling','efflorescence','pest_damage','missing_fastener','leak','electrical_hazard','fire_hazard','trip_hazard','other'] as const;
export const SEVERITIES=['low','medium','high','critical'] as const;
const findingSchema=z.object({type:z.enum(ANOMALIES),severity:z.enum(SEVERITIES),confidence:z.number().min(0).max(1),description:z.string().min(1).max(300),location:z.string().max(200).default(''),
 // Gemini's own box convention: [ymin, xmin, ymax, xmax], 0-1000 across the frame.
 box:z.array(z.number().min(0).max(1000)).length(4).optional(),recommendation:z.string().max(300).default('')});
const resultSchema=z.object({findings:z.array(findingSchema).max(12),summary:z.string().max(600),needsProfessional:z.boolean().default(false)});
export type Inspection=z.infer<typeof resultSchema>;
const PROMPT=`You are assisting a property and field technician. Look at this camera frame for structural and building anomalies: cracks, water damage or staining, mold, rot, corrosion, sagging or deflection, displacement or settlement, spalling, efflorescence, pest damage, missing or failed fasteners, active leaks, electrical or fire hazards, trip hazards.
Report only what is visible. Use cautious wording ("possible hairline crack"), never a diagnosis. For each finding give its type, severity, your confidence from 0 to 1, a short description, where it is in the frame, a bounding box as [ymin, xmin, ymax, xmax] scaled 0-1000, and the next step. If nothing is wrong, return no findings and say what you checked. Set needsProfessional when a finding is high or critical and structural, electrical or a fire hazard.`;
const base=()=>(process.env.GEMINI_API_BASE?.trim()||'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/,'');
export const inspectModel=()=>process.env.INSPECT_MODEL?.trim()||visionModel();

export async function inspectFrame(image:Buffer,mime:string,focus='',http:typeof fetch=fetch):Promise<Inspection>{
 const key=geminiKey();if(!key)throw new Refused('Inspection needs a Gemini key (GEMINI_API_KEY or GOOGLE_API_KEY).');
 const finding={type:'OBJECT',properties:{type:{type:'STRING',enum:[...ANOMALIES]},severity:{type:'STRING',enum:[...SEVERITIES]},confidence:{type:'NUMBER'},description:{type:'STRING'},location:{type:'STRING'},box:{type:'ARRAY',items:{type:'NUMBER'}},recommendation:{type:'STRING'}},required:['type','severity','confidence','description']};
 const r=await http(`${base()}/models/${encodeURIComponent(inspectModel())}:generateContent`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30_000),headers:{'x-goog-api-key':key,'Content-Type':'application/json'},
  body:JSON.stringify({contents:[{role:'user',parts:[{text:PROMPT+(focus?`\nThe technician is checking: ${focus.slice(0,300)}`:'')},{inline_data:{mime_type:mime,data:image.toString('base64')}}]}],
   generationConfig:{responseMimeType:'application/json',temperature:0,responseSchema:{type:'OBJECT',properties:{findings:{type:'ARRAY',items:finding},summary:{type:'STRING'},needsProfessional:{type:'BOOLEAN'}},required:['findings','summary']}}})});
 const body=await r.json().catch(()=>({})) as any;
 if(!r.ok)throw Error(`Gemini could not inspect the frame (HTTP ${r.status}${typeof body?.error?.message==='string'?': '+redactText(body.error.message).slice(0,200):''})`);
 const text=body?.candidates?.[0]?.content?.parts?.map((p:any)=>p.text??'').join('')??'';
 let parsed:Inspection;try{parsed=resultSchema.parse(JSON.parse(text));}catch{throw Error('Gemini did not describe the frame in a usable form');}
 // The rule is kept here, not only asked of the model: a high structural or electrical finding always says so.
 const serious=parsed.findings.some(f=>['high','critical'].includes(f.severity)&&['crack','sagging','displacement','rot','electrical_hazard','fire_hazard','water_damage'].includes(f.type));
 return {...parsed,findings:[...parsed.findings].sort((a,b)=>SEVERITIES.indexOf(b.severity)-SEVERITIES.indexOf(a.severity)||b.confidence-a.confidence),needsProfessional:parsed.needsProfessional||serious};
}

/** Keep an inspection: the frame, and what was found in it, as evidence the owner can open later. */
export function recordInspection(db:Store,owner:string,image:Buffer,mime:string,result:Inspection,source:string,runId?:string){
 const photo=db.create(owner,'artifact',{runId,kind:'inspection_frame',name:`Inspection ${new Date().toLocaleString('en-US')}`,mime,base64:image.toString('base64')});
 const report=db.create(owner,'inspection',{runId,source,photoId:photo.id,...result});
 if(result.findings.length)db.event(owner,'inspection.finding',{inspectionId:report.id,count:result.findings.length,top:result.findings[0]!.severity});
 return report;
}
export function registerInspect(t:ToolGateway,db:Store,http:typeof fetch=fetch){
 t.register({id:'structure_inspect',effect:'read',schema:z.object({artifactId:z.string(),focus:z.string().max(300).default('')}),
  description:'Check a photo the owner took (an attachment id) for structural and building anomalies: cracks, water damage, mold, rot, corrosion, sagging, leaks, electrical and fire hazards. Returns each finding with severity, confidence, where it is and the next step. Observations, not diagnoses.',
  run:async(a,c)=>{const art=db.get(c.owner,'artifact',a.artifactId);if(!art)throw new Refused('Photo not found');if(!/^image\/(jpeg|png|webp)$/.test(String(art.mime)))throw new Refused('That attachment is not a photo');
   const bytes=artifactBytes(art),result=await inspectFrame(bytes,String(art.mime),a.focus,http);const report=db.create(c.owner,'inspection',{runId:c.runId,source:'task',photoId:art.id,...result});return {...result,inspectionId:report.id};}});
}

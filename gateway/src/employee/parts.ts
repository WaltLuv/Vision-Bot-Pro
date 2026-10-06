import {z} from 'zod';import type {Page} from 'playwright';
import {Store,type Row} from './db.js';import {Refused,ToolGateway} from './tools.js';import {artifactBytes} from './artifacts.js';import {geminiKey} from './grounded.js';import {redactText} from './redact.js';
/**
 * The parts run: point the camera at a broken part, find the right replacement, and walk straight to it.
 *
 *   1. part_identify     Gemini looks at the photo and reads off the part's parameters (type, sizes, thread,
 *                        material, finish, any brand or model printed on it), each with how sure it is.
 *   2. sku_match         Candidate products (supplier offers, or what the browser read) are compared with those
 *                        parameters one by one, units converted (1/2 in = 12.7 mm), and ranked: exact, candidate,
 *                        or a conflict that rules a product out. Deterministic: same inputs, same answer.
 *   3. store_location    The aisle and bay from a product page at the owner's store (Home Depot and Lowe's print
 *                        them), read from the open browser.
 *   4. store_route       Everything to pick, in walking order: aisle by aisle, up one and down the next.
 *
 * Gemini only describes what it sees; matching and routing are plain code, so a match can be explained attribute
 * by attribute and a route never depends on a model's mood.
 */

// ------------------------------------------------------------------ measures
type Dim='length'|'voltage'|'current'|'power'|'gauge'|'weight'|'count'|'pressure'|'thread';
export interface Measure{dim:Dim;value:number}
const UNITS:[RegExp,Dim,number][]=[
 [/^(mm|millimet(er|re)s?)$/i,'length',1],[/^(cm|centimet(er|re)s?)$/i,'length',10],[/^(m|met(er|re)s?)$/i,'length',1000],
 [/^(in|inch|inches|"|”|'')$/i,'length',25.4],[/^(ft|foot|feet|'|’)$/i,'length',304.8],
 [/^(v|volts?)$/i,'voltage',1],[/^(a|amps?|amperes?)$/i,'current',1],[/^(w|watts?)$/i,'power',1],
 [/^(awg|ga|gauge)$/i,'gauge',1],[/^(lbs?|pounds?)$/i,'weight',453.6],[/^(oz|ounces?)$/i,'weight',28.35],[/^(g|grams?)$/i,'weight',1],[/^(kg)$/i,'weight',1000],
 [/^(psi)$/i,'pressure',1],[/^(pk|pack|ct|count|pcs?|pieces?)$/i,'count',1],[/^(tpi)$/i,'thread',1],
];
/** "1-1/2", "1 1/2", "3/4", "0.5", "12" as a number. */
function amount(s:string):number|null{
 const t=s.trim();let m=t.match(/^(\d+)[ -](\d+)\/(\d+)$/);if(m)return +m[1]!+ +m[2]!/ +m[3]!;
 m=t.match(/^(\d+)\/(\d+)$/);if(m)return +m[1]!/ +m[2]!;
 return /^\d*\.?\d+$/.test(t)?Number(t):null;
}
/** Every measure in a piece of text: "1/2 in. x 4 ft. x 8 ft.", "12-Gauge", "M6 x 1.0", "120V 15A", "20-Pack". */
export function measures(text:string):Measure[]{
 const out:Measure[]=[];const t=text.replace(/(\d)\s*-\s*(gauge|pack|amp|volt|watt|inch|in\b|ft\b|foot)/gi,'$1 $2');
 // Metric bolts: M6 is 6 mm across, "x 1.0" its thread pitch.
 for(const m of t.matchAll(/\bM(\d+(?:\.\d+)?)(?:\s*x\s*(\d+(?:\.\d+)?)\b(?!\s*(?:mm|in|"|ft)))?/g)){out.push({dim:'length',value:+m[1]!});}
 for(const m of t.matchAll(/(\d+[ -]\d+\/\d+|\d+\/\d+|\d*\.?\d+)\s*(mm|cm|m|in\.?|inch(?:es)?|"|”|''|ft\.?|foot|feet|'|’|v|volts?|a|amps?|amperes?|w|watts?|awg|ga|gauge|lbs?|pounds?|oz|ounces?|g|grams?|kg|psi|pk|pack|ct|count|pcs?|pieces?|tpi)(?![a-z])/gi)){
  const n=amount(m[1]!),unit=m[2]!.replace(/\.$/,'');if(n==null)continue;
  const u=UNITS.find(([re])=>re.test(unit));if(u)out.push({dim:u[1],value:n*u[2]});
 }
 return out;
}
const close=(a:number,b:number)=>Math.abs(a-b)<=Math.max(0.02*Math.max(a,b),0.05);

// ------------------------------------------------------------------ matching
export interface Attribute{name:string;value:string;required?:boolean;confidence?:number}
export interface PartSpec{category:string;attributes:Attribute[];searchTerms?:string}
export interface Candidate{sku:string;product:string;specification?:string;supplier?:string;url?:string;offerId?:string}
export type MatchQuality='exact'|'candidate'|'unverified'|'mismatch';
export interface Match{sku:string;product:string;supplier?:string;url?:string;offerId?:string;quality:MatchQuality;score:number;matched:string[];conflicts:string[];unknown:string[]}
const norm=(s:string)=>s.toLowerCase().replace(/[^a-z0-9.\/ ]+/g,' ').replace(/\s+/g,' ').trim();
const compact=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,'');
// Words that name the same thing on a shelf tag and in a product title.
const SAME:[RegExp,string][]=[[/\bstainless( steel)?\b|\bss\b|\b18-8\b/g,'stainless'],[/\bzinc[- ]plated\b|\bzinc\b/g,'zinc'],[/\bgalvanized\b|\bgalv\b/g,'galvanized'],[/\bpolished chrome\b|\bchrome\b/g,'chrome'],[/\bbrushed nickel\b|\bsatin nickel\b/g,'brushed nickel'],[/\bpolyvinyl chloride\b/g,'pvc'],[/\bblack iron\b|\bblack steel\b/g,'black iron']];
const canon=(s:string)=>SAME.reduce((x,[re,to])=>x.replace(re,to),norm(s));
/** One attribute against one product: matched, conflicting, or not stated. */
function compare(a:Attribute,text:string):'match'|'conflict'|'unknown'{
 const want=measures(a.value);
 if(want.length){
  const have=measures(text);let decided:'match'|'conflict'|'unknown'='unknown';
  for(const w of want){const same=have.filter(h=>h.dim===w.dim);if(!same.length)continue;if(same.some(h=>close(h.value,w.value)))decided=decided==='conflict'?'conflict':'match';else return 'conflict';}
  return decided;
 }
 // A model or part number printed on the part: decisive either way when the product states one.
 if(/model|part|sku|number/i.test(a.name)&&/\d/.test(a.value))return compact(text).includes(compact(a.value))?'match':'unknown';
 return canon(text).includes(canon(a.value))?'match':'unknown';
}
export function matchSkus(spec:PartSpec,candidates:Candidate[]):Match[]{
 return candidates.map(c=>{
  const text=`${c.product} ${c.specification??''}`,matched:string[]=[],conflicts:string[]=[],unknown:string[]=[];let got=0,total=0;
  for(const a of spec.attributes){const w=(a.required?2:1)*(a.confidence??1);total+=w;const r=compare(a,text);
   if(r==='match'){matched.push(a.name);got+=w;}else if(r==='conflict')conflicts.push(a.name);else unknown.push(a.name);}
  const requiredBroken=spec.attributes.some(a=>a.required&&conflicts.includes(a.name)),requiredOk=spec.attributes.filter(a=>a.required).every(a=>matched.includes(a.name));
  const score=total?+(got/total).toFixed(2):0;
  const quality:MatchQuality=requiredBroken?'mismatch':requiredOk&&!conflicts.length&&score>=0.8?'exact':!conflicts.length&&score>=0.5?'candidate':conflicts.length&&score<0.5?'mismatch':'unverified';
  return {sku:c.sku,product:c.product,supplier:c.supplier,url:c.url,offerId:c.offerId,quality,score,matched,conflicts,unknown};
 }).sort((a,b)=>({exact:0,candidate:1,unverified:2,mismatch:3}[a.quality]-{exact:0,candidate:1,unverified:2,mismatch:3}[b.quality])||b.score-a.score);
}

// ------------------------------------------------------------------ aisle and bay
export interface Location{aisle:string;bay?:string}
/** "Aisle 23, Bay 004", "Aisle 45 | Bay 6", "Aisle G12 Bay 3", "Located in Aisle 12". The first one on the page. */
export function aisleBay(text:string):Location|null{
 const m=text.match(/\baisle\s*#?\s*([A-Z]{0,2}\d{1,3}[A-Z]?)\b(?:[\s,|·\-–:]*(?:bay|section|sec\.?)\s*#?\s*([A-Z]?\d{1,4}[A-Z]?)\b)?/i);
 if(!m)return null;const bay=m[2]?m[2].replace(/^0+(?=\d)/,''):undefined;
 return {aisle:m[1]!.toUpperCase(),...(bay?{bay:bay.toUpperCase()}:{})};
}
const num=(s:string)=>{const m=s.match(/\d+/);return m?+m[0]:Number.MAX_SAFE_INTEGER;};
export interface PickItem{sku?:string;name:string;quantity?:number;aisle?:string;bay?:string}
/**
 * Walking order: numbered aisles in order, then lettered areas (garden, lumber yard); within an aisle by bay, and
 * every other aisle walked the other way, so the route goes up one aisle and down the next instead of back to the
 * front each time. Anything without a location is listed last, to ask about at the service desk.
 */
export function pickRoute(items:PickItem[]){
 const located=items.filter(i=>i.aisle),unknown=items.filter(i=>!i.aisle);
 const aisles=[...new Set(located.map(i=>i.aisle!))].sort((a,b)=>(/^\d/.test(a)?0:1)-(/^\d/.test(b)?0:1)||num(a)-num(b)||a.localeCompare(b));
 const steps=aisles.flatMap((aisle,k)=>located.filter(i=>i.aisle===aisle).sort((x,y)=>(k%2?-1:1)*(num(x.bay??'0')-num(y.bay??'0'))).map(i=>({...i})));
 const text=[...steps.map((s,n)=>`${n+1}. Aisle ${s.aisle}${s.bay?`, Bay ${s.bay}`:''}: ${s.quantity&&s.quantity>1?`${s.quantity} x `:''}${s.name}${s.sku?` (${s.sku})`:''}`),
  ...unknown.map(u=>`Ask at the service desk: ${u.quantity&&u.quantity>1?`${u.quantity} x `:''}${u.name}${u.sku?` (${u.sku})`:''}`)].join('\n');
 return {steps,unlocated:unknown,text};
}

// ------------------------------------------------------------------ Gemini: what is this part?
const gemini=()=>(process.env.GEMINI_API_BASE?.trim()||'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/,'');
export const visionModel=()=>process.env.VISION_MODEL?.trim()||process.env.SEARCH_MODEL?.trim()||'gemini-3.5-flash';
const specSchema=z.object({category:z.string().min(1).max(120),attributes:z.array(z.object({name:z.string().min(1).max(60),value:z.string().min(1).max(120),required:z.boolean().optional(),confidence:z.number().min(0).max(1).optional()})).max(20),searchTerms:z.string().max(200).optional(),printedText:z.array(z.string().max(120)).max(10).optional(),notes:z.string().max(500).optional()});
const IDENTIFY=`You are identifying a hardware, plumbing, electrical or building part from a photo, so an exact replacement can be bought.
Report only what the photo shows or what is printed on the part. For each attribute give a value with units where it has them (e.g. "1/2 in", "M6", "120 V"), mark required=true for the attributes a replacement must match to fit or work, and give your confidence from 0 to 1. Include brand, model or part numbers only if they are legible. searchTerms is a short store search query. If something cannot be judged from the photo, leave it out rather than guessing.`;
export async function identifyPart(image:Buffer,mime:string,note:string,http:typeof fetch=fetch):Promise<z.infer<typeof specSchema>>{
 const key=geminiKey();if(!key)throw new Refused('Identifying a part from a photo needs a Gemini key (GEMINI_API_KEY or GOOGLE_API_KEY).');
 const schema={type:'OBJECT',properties:{category:{type:'STRING'},attributes:{type:'ARRAY',items:{type:'OBJECT',properties:{name:{type:'STRING'},value:{type:'STRING'},required:{type:'BOOLEAN'},confidence:{type:'NUMBER'}},required:['name','value']}},searchTerms:{type:'STRING'},printedText:{type:'ARRAY',items:{type:'STRING'}},notes:{type:'STRING'}},required:['category','attributes']};
 const r=await http(`${gemini()}/models/${encodeURIComponent(visionModel())}:generateContent`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(45_000),headers:{'x-goog-api-key':key,'Content-Type':'application/json'},
  body:JSON.stringify({contents:[{role:'user',parts:[{text:IDENTIFY+(note?`\nThe owner says: ${note.slice(0,500)}`:'')},{inline_data:{mime_type:mime,data:image.toString('base64')}}]}],generationConfig:{responseMimeType:'application/json',responseSchema:schema,temperature:0}})});
 const body=await r.json().catch(()=>({})) as any;
 if(!r.ok)throw Error(`Gemini could not look at the photo (HTTP ${r.status}${typeof body?.error?.message==='string'?': '+redactText(body.error.message).slice(0,200):''})`);
 const text=body?.candidates?.[0]?.content?.parts?.map((p:any)=>p.text??'').join('')??'';
 try{return specSchema.parse(JSON.parse(text));}catch{throw Error('Gemini did not describe the part in a usable form');}
}

const IMAGE=/^image\/(jpeg|png|webp)$/;
const specInput=z.object({category:z.string().max(120).default(''),attributes:z.array(z.object({name:z.string().min(1).max(60),value:z.string().min(1).max(120),required:z.boolean().optional(),confidence:z.number().min(0).max(1).optional()})).min(1).max(20)});
export function registerParts(t:ToolGateway,db:Store,pageFor:(owner:string,runId:string)=>Page|undefined,http:typeof fetch=fetch){
 t.register({id:'part_identify',effect:'read',schema:z.object({artifactId:z.string(),note:z.string().max(500).default('')}),
  description:'Identify a part from a photo the owner took (an attachment id): its type and the parameters a replacement must match (sizes, thread, material, finish, printed brand or model), each marked required or not, with a store search query. Use before searching for a replacement.',
  run:async(a,c)=>{const art=db.get(c.owner,'artifact',a.artifactId);if(!art)throw new Refused('Photo not found');if(!IMAGE.test(String(art.mime)))throw new Refused('That attachment is not a photo');
   const spec=await identifyPart(artifactBytes(art),String(art.mime),a.note,http);db.create(c.owner,'artifact',{runId:c.runId,kind:'part_spec',name:`Part: ${spec.category}`,data:spec});return spec;}});
 t.register({id:'sku_match',effect:'read',schema:z.object({spec:specInput,materialId:z.string().optional(),candidates:z.array(z.object({sku:z.string().max(80),product:z.string().max(300),specification:z.string().max(2000).optional(),supplier:z.string().max(100).optional(),url:z.string().max(2000).optional()})).max(50).default([])}),
  description:'Rank candidate products against the part\'s parameters (from part_identify), converting units: exact, candidate, unverified or mismatch, with which attributes matched, conflicted or were not stated. Give candidates you read, or materialId to rank the offers from a products_search (their match labels are updated).',
  run:async(a,c)=>{
   const offers=a.materialId?db.list(c.owner,'offer').filter(o=>o.requestId===a.materialId):[];
   if(a.materialId&&!db.get(c.owner,'material',a.materialId))throw new Refused('Material request not found');
   const ranked=matchSkus(a.spec,[...a.candidates,...offers.map(o=>({sku:String(o.sku),product:String(o.product),specification:String(o.specification??''),supplier:String(o.supplier),url:String(o.url??''),offerId:o.id}))]);
   // Offers carry the verdict, so the comparison on the phone says which ones fit.
   for(const m of ranked)if(m.offerId){const o=db.get(c.owner,'offer',m.offerId);if(o)db.put(c.owner,'offer',{...o,matchQuality:m.quality==='mismatch'?'unverified':m.quality,confidence:m.score,match:{matched:m.matched,conflicts:m.conflicts,unknown:m.unknown}});}
   return {matches:ranked.slice(0,15)};}});
 t.register({id:'store_location',effect:'read',schema:z.object({name:z.string().min(1).max(200),sku:z.string().max(80).optional(),quantity:z.number().int().min(1).max(1000).default(1),text:z.string().max(20000).optional()}),
  description:'Read the aisle and bay of a product at the owner\'s store from its product page open in the browser (or from given text), and add it to this task\'s pick list. Set the store first (browser_do "set my store to the one nearest ZIP …").',
  run:async(a,c)=>{
   let text=a.text,url:string|undefined;
   if(!text){const page=pageFor(c.owner,c.runId);if(!page)throw new Refused('No browser is open for this task. Open the product page first, or pass its text.');text=await page.locator('body').innerText({timeout:10_000});url=page.url();}
   const where=aisleBay(text);
   const item=db.create(c.owner,'pick_item',{runId:c.runId,name:a.name,sku:a.sku,quantity:a.quantity,url,...(where??{})});
   return where?{found:true,...where,itemId:item.id}:{found:false,itemId:item.id,note:'No aisle or bay on that page. Store pickup pages sometimes hide it until a store is set; it is listed as ask at the service desk.'};}});
 t.register({id:'store_route',effect:'read',schema:z.object({store:z.string().max(100).default('the store')}),
  description:'Put this task\'s pick list (from store_location) in walking order through the store, aisle by aisle, and save it as a document for the owner.',
  run:async(a,c)=>{const items=db.list(c.owner,'pick_item').filter(i=>i.runId===c.runId).reverse() as unknown as PickItem[];if(!items.length)throw new Refused('Nothing on the pick list yet. Use store_location for each item first.');
   const route=pickRoute(items);db.create(c.owner,'artifact',{runId:c.runId,kind:'document',name:`Pick route: ${a.store}`,text:route.text});return route;}});
}
